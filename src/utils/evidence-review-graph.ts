/**
 * Engine-facing Evidence Review graph helpers.
 *
 * Composes pure graph-core APIs (#107) with #106 sharding and the Skill Evolution
 * Evidence Bundle shape used by Runtime Learning.
 */

import type { EvidenceBundle, CapabilityReadSetEntry } from './skill-evolution';
import type { DistilledKnowledgeCandidate } from './capability-distiller';
import {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  EVIDENCE_REVIEW_POLICY_VERSION,
  EVIDENCE_REVIEW_PROMPT_VERSION,
  type EvidenceReviewJob,
  type ReviewBasis,
  type ReviewQuantumRecord,
  type ReviewWorkClass,
} from './evidence-review-types';
import {
  buildDualLaneCoverageQuanta,
  buildReviewBasis as buildGraphReviewBasis,
  createEvidenceReviewJob as createGraphJob,
  createReviewQuantum,
  makeQuantumId,
  quantumInputHash,
  reuseSucceededQuanta as reuseSucceededQuantaCore,
  sha256Hex,
  stableStringify,
} from './evidence-review-graph-core';
import {
  hashEvidenceBundle,
  shardEvidenceBundle,
  type ShardingOptions,
} from './evidence-review';

export {
  makeQuantumId,
  quantumInputHash,
  sha256Hex,
  stableStringify,
  createReviewQuantum,
  buildDualLaneCoverageQuanta,
  claimQuantum,
  completeQuantum,
  failQuantum,
  reclaimExpiredLeases,
  recoverJobAfterRestart,
  isQuantumRunnable,
  listRunnableQuanta,
  criticalPathRank,
  deriveJobDisposition,
  deriveJobProgress,
  computeJobNextDueAt,
  dependenciesSatisfied,
} from './evidence-review-graph-core';

export function fingerprintRegistryReadSet(
  entries: readonly CapabilityReadSetEntry[] = [],
): string[] {
  return [...entries]
    .map(entry => `${entry.handle}@${entry.revision}`)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export function buildReviewBasis(input: {
  bundle: EvidenceBundle;
  manifestHash: string;
  registryReadSet?: readonly CapabilityReadSetEntry[];
  reviewPolicyVersion?: string;
  promptVersion?: string;
}): ReviewBasis {
  const registryReadSet = [...(input.registryReadSet ?? [])]
    .map(entry => ({ handle: entry.handle, revision: entry.revision }))
    .sort((a, b) => a.handle.localeCompare(b.handle, 'en'));
  const registryReadSetFingerprints = fingerprintRegistryReadSet(registryReadSet);
  const referencedSkillHashes = (input.bundle.referencedSkills ?? [])
    .map(skill => sha256Hex(stableStringify(skill)))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const evidenceBundleHash = hashEvidenceBundle(input.bundle);
  const reviewPolicyVersion = input.reviewPolicyVersion ?? EVIDENCE_REVIEW_POLICY_VERSION;
  const promptVersion = input.promptVersion ?? EVIDENCE_REVIEW_PROMPT_VERSION;
  const target = input.bundle.relatedCurrentSkills?.[0] as
    | { handle?: string; revision?: number }
    | undefined;

  const graphBasis = buildGraphReviewBasis({
    manifestHash: input.manifestHash,
    evidenceBundleHash,
    registryReadSet: registryReadSetFingerprints,
    referencedSkillHashes,
    reviewPolicyVersion,
    promptVersion,
    ...(typeof target?.handle === 'string' ? { targetCapabilityHandle: target.handle } : {}),
    ...(typeof target?.revision === 'number' ? { targetCapabilityRevision: target.revision } : {}),
  });

  return {
    basisHash: graphBasis.basisHash,
    manifestHash: graphBasis.manifestHash,
    evidenceBundleHash: graphBasis.evidenceBundleHash,
    registryReadSet,
    registryReadSetFingerprints: graphBasis.registryReadSet,
    referencedSkillHashes: graphBasis.referencedSkillHashes,
    reviewPolicyVersion: graphBasis.reviewPolicyVersion,
    promptVersion: graphBasis.promptVersion,
    ...(graphBasis.targetCapabilityHandle
      ? { targetCapabilityHandle: graphBasis.targetCapabilityHandle }
      : {}),
    ...(typeof graphBasis.targetCapabilityRevision === 'number'
      ? { targetCapabilityRevision: graphBasis.targetCapabilityRevision }
      : {}),
  };
}

export interface CreateEvidenceReviewJobInput {
  bundle: EvidenceBundle;
  candidate: DistilledKnowledgeCandidate;
  workClass: ReviewWorkClass;
  registryReadSet?: readonly CapabilityReadSetEntry[];
  parentJobId?: string;
  now?: Date;
  sharding?: ShardingOptions;
  jobId?: string;
}

/**
 * Create a durable dual-lane job for a frozen Evidence Bundle.
 * Topology comes from pure graph-core; shards from the #106 package.
 */
export function createEvidenceReviewJob(input: CreateEvidenceReviewJobInput): EvidenceReviewJob {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const { manifest, shards } = shardEvidenceBundle(input.bundle, input.sharding);
  const basis = buildReviewBasis({
    bundle: input.bundle,
    manifestHash: manifest.manifestHash,
    registryReadSet: input.registryReadSet,
  });
  const jobId = input.jobId
    ?? `job:${basis.basisHash.slice(0, 20)}:${input.bundle.bundleId.slice(0, 24)}`;

  const quantaList = buildDualLaneCoverageQuanta({
    jobId,
    shards: shards.map(s => ({ shardId: s.shardId, contentHash: s.contentHash })),
    basisHash: basis.basisHash,
    now,
  });

  // Attach manifest-scoped input hashes for dossier/diff/obligation/author nodes
  // already produced by buildDualLaneCoverageQuanta; graph-core template is enough.
  const graphJob = createGraphJob({
    jobId,
    workClass: input.workClass,
    basis: {
      basisHash: basis.basisHash,
      manifestHash: basis.manifestHash,
      evidenceBundleHash: basis.evidenceBundleHash,
      registryReadSet: basis.registryReadSetFingerprints,
      referencedSkillHashes: basis.referencedSkillHashes,
      reviewPolicyVersion: basis.reviewPolicyVersion,
      promptVersion: basis.promptVersion,
      ...(basis.targetCapabilityHandle
        ? { targetCapabilityHandle: basis.targetCapabilityHandle }
        : {}),
      ...(typeof basis.targetCapabilityRevision === 'number'
        ? { targetCapabilityRevision: basis.targetCapabilityRevision }
        : {}),
    },
    quanta: quantaList,
    domain: {
      bundleId: input.bundle.bundleId,
      manifestId: manifest.manifestId,
    },
    parentJobId: input.parentJobId,
    now,
  });

  const shardMap: Record<string, (typeof shards)[number]> = {};
  for (const shard of shards) shardMap[shard.shardId] = shard;

  return {
    schemaVersion: EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
    jobId: graphJob.jobId,
    workClass: graphJob.workClass,
    disposition: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
    candidate: input.candidate,
    bundle: input.bundle,
    manifest: {
      ...manifest,
      createdAt: nowIso,
    },
    shards: shardMap,
    basis,
    quanta: graphJob.quanta,
    parentJobId: input.parentJobId,
    domain: graphJob.domain,
  };
}

export function reuseSucceededQuanta(
  successor: EvidenceReviewJob,
  prior: EvidenceReviewJob,
): EvidenceReviewJob {
  const graphSuccessor = {
    schemaVersion: successor.schemaVersion,
    jobId: successor.jobId,
    workClass: successor.workClass,
    disposition: successor.disposition,
    createdAt: successor.createdAt,
    updatedAt: successor.updatedAt,
    basis: {
      basisHash: successor.basis.basisHash,
      manifestHash: successor.basis.manifestHash,
      evidenceBundleHash: successor.basis.evidenceBundleHash,
      registryReadSet: successor.basis.registryReadSetFingerprints,
      referencedSkillHashes: successor.basis.referencedSkillHashes,
      reviewPolicyVersion: successor.basis.reviewPolicyVersion,
      promptVersion: successor.basis.promptVersion,
    },
    quanta: successor.quanta,
  };
  const graphPrior = {
    schemaVersion: prior.schemaVersion,
    jobId: prior.jobId,
    workClass: prior.workClass,
    disposition: prior.disposition,
    createdAt: prior.createdAt,
    updatedAt: prior.updatedAt,
    basis: {
      basisHash: prior.basis.basisHash,
      manifestHash: prior.basis.manifestHash,
      evidenceBundleHash: prior.basis.evidenceBundleHash,
      registryReadSet: prior.basis.registryReadSetFingerprints,
      referencedSkillHashes: prior.basis.referencedSkillHashes,
      reviewPolicyVersion: prior.basis.reviewPolicyVersion,
      promptVersion: prior.basis.promptVersion,
    },
    quanta: prior.quanta,
  };
  const merged = reuseSucceededQuantaCore(graphSuccessor as any, graphPrior as any);
  return {
    ...successor,
    quanta: merged.quanta as Record<string, ReviewQuantumRecord>,
    updatedAt: merged.updatedAt,
  };
}

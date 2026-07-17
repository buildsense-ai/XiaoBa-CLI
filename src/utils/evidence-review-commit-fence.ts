/**
 * Review Commit Fence (#109 / ADR 0045).
 *
 * Hardened version-vector comparison and Successor Review Job planning against
 * an immutable Review Basis. Owns fence decisions, fail-closed basis validation,
 * explicit race outcomes, and content-identified Quantum reuse.
 *
 * Skill Evolution call sites keep using:
 *   compareReviewBasis(basis, { bundle, registryReadSet?, ... })
 *   createSuccessorReviewJob({ staleJob, liveBundle, candidate, ... })
 *   markJobSuperseded(staleJob, successorJobId)
 *
 * Ordering outcomes (decideReviewCommitFence / resolveFenceRace):
 * - match — every declared dependency still equals the live world → commit may proceed
 * - stale_before_fence — relevant change ordered before the fence → Successor Job
 * - unrelated_change — Registry churn outside the declared read set → ignore
 * - post_commit_reassessment — relevant change ordered after a successful commit
 * - corrupted_basis — fail-closed; never treat malformed basis as match
 *
 * Does not write the Transition Journal, Runtime Learning wake loop, or shared
 * scheduler/queue. Does not own graph/store modules.
 */

import type { CapabilityReadSetEntry, EvidenceBundle } from './skill-evolution';
import type { EvidenceReviewJob, ReviewBasis } from './evidence-review-types';
import {
  EVIDENCE_REVIEW_POLICY_VERSION,
  EVIDENCE_REVIEW_PROMPT_VERSION,
  type ReviewQuantumKind,
  type ReviewQuantumRecord,
  type ReviewWorkClass,
} from './evidence-review-types';
import {
  buildReviewBasis,
  createEvidenceReviewJob,
  createReviewQuantum,
  fingerprintRegistryReadSet,
  makeQuantumId,
  quantumInputHash,
  reuseSucceededQuanta,
  sha256Hex,
  stableStringify,
} from './evidence-review-graph';
import { hashEvidenceBundle } from './evidence-review';
import type { DistilledKnowledgeCandidate } from './capability-distiller';
import {
  buildReviewBasis as buildGraphReviewBasis,
} from './evidence-review-graph-core';

// ---------------------------------------------------------------------------
// Version-vector field taxonomy
// ---------------------------------------------------------------------------

/**
 * Declared relevant dependency fields that participate in the Review Basis
 * version vector. Unrelated Registry handles never appear here.
 */
export type ReviewBasisField =
  | 'manifest'
  | 'evidence'
  | 'registry'
  | 'registry_read_set'
  | 'referenced_skills'
  | 'policy'
  | 'prompt'
  | 'target';

export type FenceDecisionKind =
  | 'match'
  | 'stale_before_fence'
  | 'unrelated_change'
  | 'post_commit_reassessment'
  | 'corrupted_basis';

/**
 * Live world snapshot used by pure fence decision APIs.
 * Only the declared Registry read set is compared — never the full Registry.
 */
export interface LiveReviewWorld {
  evidenceBundleHash: string;
  manifestHash: string;
  /** Live fingerprints for *only* the job's declared Registry read set. */
  registryReadSet: readonly string[];
  /**
   * Optional live fingerprints for Registry handles *outside* the declared
   * read set. Used only to prove that unrelated Registry churn is ignored.
   */
  unrelatedRegistryFingerprints?: readonly string[];
  referencedSkillHashes: readonly string[];
  reviewPolicyVersion: string;
  promptVersion: string;
  targetCapabilityHandle?: string;
  targetCapabilityRevision?: number;
}

/**
 * Skill Evolution live snapshot: recomputes hashes from the frozen bundle and
 * the declared Registry read-set entries (handle + revision).
 */
export interface SkillEvolutionLiveWorld {
  bundle: EvidenceBundle;
  registryReadSet?: readonly CapabilityReadSetEntry[];
  reviewPolicyVersion?: string;
  promptVersion?: string;
  /** Optional override; defaults to re-derived from the job basis / live recompute. */
  manifestHash?: string;
}

export type LiveReviewInput = LiveReviewWorld | SkillEvolutionLiveWorld;

export interface FenceComparisonMatch {
  status: 'match';
  basisHash?: string;
  liveBasisHash?: string;
}

export interface FenceComparisonStale {
  status: 'stale';
  reason: string;
  changed: readonly ReviewBasisField[];
  basisHash?: string;
  liveBasisHash?: string;
}

export interface FenceComparisonCorrupted {
  status: 'corrupted_basis';
  reason: string;
}

export type FenceComparison =
  | FenceComparisonMatch
  | FenceComparisonStale
  | FenceComparisonCorrupted;

export interface FenceDecision {
  kind: FenceDecisionKind;
  comparison: FenceComparison;
  /**
   * True when the decision forbids applying the Transition Journal for the
   * stale job. Match and post-commit reassessment leave a prior commit intact.
   */
  mayCommit: boolean;
  /** True when a Successor Review Job should be planned (stale before fence). */
  shouldCreateSuccessor: boolean;
  /**
   * True when ordinary semantic reassessment work should be scheduled after a
   * successful commit (change ordered after the fence).
   */
  shouldScheduleReassessment: boolean;
  reason: string;
}

export interface SuccessorReviewPlan {
  successor: EvidenceReviewJob;
  superseded: EvidenceReviewJob;
  reusedQuantumIds: readonly string[];
  skippedQuantumIds: readonly string[];
  auditLink: {
    parentJobId: string;
    successorJobId: string;
    supersededDisposition: 'superseded';
  };
}

// ---------------------------------------------------------------------------
// Review Basis validation (fail-closed)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isCapabilityReadSetEntryArray(value: unknown): value is CapabilityReadSetEntry[] {
  return (
    Array.isArray(value)
    && value.every(
      entry =>
        entry
        && typeof entry === 'object'
        && typeof (entry as CapabilityReadSetEntry).handle === 'string'
        && typeof (entry as CapabilityReadSetEntry).revision === 'number',
    )
  );
}

function isBundleLive(live: LiveReviewInput): live is SkillEvolutionLiveWorld {
  return (
    typeof live === 'object'
    && live !== null
    && 'bundle' in live
    && (live as SkillEvolutionLiveWorld).bundle != null
    && typeof (live as SkillEvolutionLiveWorld).bundle === 'object'
  );
}

/**
 * Validate a Review Basis version vector. Corrupted / partial data never
 * compares as a match — callers must treat this as fail-closed.
 *
 * Accepts both engine-facing bases (structured registryReadSet + fingerprints)
 * and pure graph bases (opaque fingerprint strings in registryReadSet).
 */
export function validateReviewBasis(value: unknown): {
  ok: true;
  basis: ReviewBasis;
} | {
  ok: false;
  reason: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'Review Basis is not an object' };
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.basisHash)) {
    return { ok: false, reason: 'Review Basis missing basisHash' };
  }
  if (!isNonEmptyString(record.manifestHash)) {
    return { ok: false, reason: 'Review Basis missing manifestHash' };
  }
  if (!isNonEmptyString(record.evidenceBundleHash)) {
    return { ok: false, reason: 'Review Basis missing evidenceBundleHash' };
  }
  if (!isNonEmptyString(record.reviewPolicyVersion)) {
    return { ok: false, reason: 'Review Basis missing reviewPolicyVersion' };
  }
  if (!isNonEmptyString(record.promptVersion)) {
    return { ok: false, reason: 'Review Basis missing promptVersion' };
  }
  if (
    record.targetCapabilityHandle !== undefined
    && typeof record.targetCapabilityHandle !== 'string'
  ) {
    return { ok: false, reason: 'Review Basis targetCapabilityHandle is not a string' };
  }
  if (
    record.targetCapabilityRevision !== undefined
    && typeof record.targetCapabilityRevision !== 'number'
  ) {
    return { ok: false, reason: 'Review Basis targetCapabilityRevision is not a number' };
  }
  if (!isStringArray(record.referencedSkillHashes)) {
    return { ok: false, reason: 'Review Basis referencedSkillHashes is not a string array' };
  }

  // Engine shape: structured entries + fingerprints. Graph shape: string fingerprints only.
  const hasFingerprints = isStringArray(record.registryReadSetFingerprints);
  const hasStructuredEntries = isCapabilityReadSetEntryArray(record.registryReadSet);
  const hasGraphFingerprints = isStringArray(record.registryReadSet);

  if (!hasFingerprints && !hasGraphFingerprints && !hasStructuredEntries) {
    return {
      ok: false,
      reason: 'Review Basis registryReadSet is not a string array or CapabilityReadSetEntry array',
    };
  }

  const fingerprints = hasFingerprints
    ? [...(record.registryReadSetFingerprints as string[])]
    : hasGraphFingerprints
      ? [...(record.registryReadSet as string[])]
      : fingerprintRegistryReadSet(record.registryReadSet as CapabilityReadSetEntry[]);

  const structuredEntries: CapabilityReadSetEntry[] = hasStructuredEntries
    ? [...(record.registryReadSet as CapabilityReadSetEntry[])]
      .map(entry => ({ handle: entry.handle, revision: entry.revision }))
      .sort((a, b) => a.handle.localeCompare(b.handle, 'en'))
    : fingerprints.map(fp => {
      const at = fp.lastIndexOf('@');
      if (at <= 0) return { handle: fp, revision: 0 };
      const revision = Number(fp.slice(at + 1));
      return {
        handle: fp.slice(0, at),
        revision: Number.isFinite(revision) ? revision : 0,
      };
    });

  // Recompute basisHash from the graph version-vector body; mismatch means the
  // vector was tampered with or partially rewritten and must not be authoritative.
  const graphBody = buildGraphReviewBasis({
    manifestHash: record.manifestHash as string,
    evidenceBundleHash: record.evidenceBundleHash as string,
    registryReadSet: fingerprints,
    referencedSkillHashes: record.referencedSkillHashes as string[],
    reviewPolicyVersion: record.reviewPolicyVersion as string,
    promptVersion: record.promptVersion as string,
    ...(typeof record.targetCapabilityHandle === 'string'
      ? { targetCapabilityHandle: record.targetCapabilityHandle }
      : {}),
    ...(typeof record.targetCapabilityRevision === 'number'
      ? { targetCapabilityRevision: record.targetCapabilityRevision }
      : {}),
  });

  if (graphBody.basisHash !== record.basisHash) {
    return {
      ok: false,
      reason: 'Review Basis basisHash does not match version-vector body',
    };
  }

  return {
    ok: true,
    basis: {
      basisHash: graphBody.basisHash,
      manifestHash: graphBody.manifestHash,
      evidenceBundleHash: graphBody.evidenceBundleHash,
      registryReadSet: structuredEntries,
      registryReadSetFingerprints: graphBody.registryReadSet,
      referencedSkillHashes: graphBody.referencedSkillHashes,
      reviewPolicyVersion: graphBody.reviewPolicyVersion,
      promptVersion: graphBody.promptVersion,
      ...(graphBody.targetCapabilityHandle
        ? { targetCapabilityHandle: graphBody.targetCapabilityHandle }
        : {}),
      ...(typeof graphBody.targetCapabilityRevision === 'number'
        ? { targetCapabilityRevision: graphBody.targetCapabilityRevision }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Version-vector comparison helpers
// ---------------------------------------------------------------------------

function sortedCopy(values: readonly string[]): string[] {
  return [...values].map(entry => String(entry)).sort((a, b) => a.localeCompare(b, 'en'));
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Build a live pure Review Basis from a fence world snapshot.
 * Only the declared registry read set is fingerprinted — never the full Registry.
 */
export function buildLiveReviewBasis(live: LiveReviewWorld): ReviewBasis {
  const graphBasis = buildGraphReviewBasis({
    manifestHash: live.manifestHash,
    evidenceBundleHash: live.evidenceBundleHash,
    registryReadSet: live.registryReadSet,
    referencedSkillHashes: live.referencedSkillHashes,
    reviewPolicyVersion: live.reviewPolicyVersion,
    promptVersion: live.promptVersion,
    targetCapabilityHandle: live.targetCapabilityHandle,
    targetCapabilityRevision: live.targetCapabilityRevision,
  });
  const structured = graphBasis.registryReadSet.map(fp => {
    const at = fp.lastIndexOf('@');
    if (at <= 0) return { handle: fp, revision: 0 };
    const revision = Number(fp.slice(at + 1));
    return {
      handle: fp.slice(0, at),
      revision: Number.isFinite(revision) ? revision : 0,
    };
  });
  return {
    basisHash: graphBasis.basisHash,
    manifestHash: graphBasis.manifestHash,
    evidenceBundleHash: graphBasis.evidenceBundleHash,
    registryReadSet: structured,
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

function resolveLiveWorld(
  basis: ReviewBasis,
  live: LiveReviewInput,
): LiveReviewWorld {
  if (isBundleLive(live)) {
    const registryReadSet = live.registryReadSet ?? basis.registryReadSet;
    const rebuilt = buildReviewBasis({
      bundle: live.bundle,
      // Prefer explicit manifest override; otherwise recompute from the live
      // bundle via buildReviewBasis (which hashes evidence and references).
      // When the caller did not pass a new manifest, use the frozen job
      // manifest hash only if evidence is unchanged — buildReviewBasis always
      // re-hashes evidence from the bundle, so pass basis.manifestHash as the
      // declared manifest the job would commit against unless overridden.
      manifestHash: live.manifestHash ?? basis.manifestHash,
      registryReadSet,
      reviewPolicyVersion: live.reviewPolicyVersion ?? basis.reviewPolicyVersion,
      promptVersion: live.promptVersion ?? basis.promptVersion,
    });
    return {
      evidenceBundleHash: rebuilt.evidenceBundleHash,
      manifestHash: rebuilt.manifestHash,
      registryReadSet: rebuilt.registryReadSetFingerprints,
      referencedSkillHashes: rebuilt.referencedSkillHashes,
      reviewPolicyVersion: rebuilt.reviewPolicyVersion,
      promptVersion: rebuilt.promptVersion,
      targetCapabilityHandle: rebuilt.targetCapabilityHandle,
      targetCapabilityRevision: rebuilt.targetCapabilityRevision,
    };
  }
  return live;
}

/**
 * Atomically compare an immutable Review Basis against the live declared world.
 *
 * Skill Evolution shape:
 *   compareReviewBasis(job.basis, { bundle, registryReadSet?, ... })
 *
 * Pure fence shape:
 *   compareReviewBasis(basis, liveReviewWorld)
 *
 * Unrelated Registry fingerprints (when supplied on LiveReviewWorld) are
 * intentionally ignored for staleness — only the declared read set participates.
 *
 * Fail-closed: corrupted / partial basis data never returns `match`.
 * For Skill Evolution call sites (which only branch on `stale`), corruption is
 * surfaced as `stale` so commit is blocked without requiring SE edits. Pure
 * decision APIs still expose `corrupted_basis` via decideReviewCommitFence.
 */
export function compareReviewBasis(
  basis: unknown,
  live: LiveReviewInput,
): FenceComparison {
  const validated = validateReviewBasis(basis);
  if (!validated.ok) {
    // Fail closed for Skill Evolution: only `stale` blocks commit today.
    // Pure callers should prefer decideReviewCommitFence / validateReviewBasis.
    if (isBundleLive(live)) {
      return {
        status: 'stale',
        reason: `Review Basis corrupted (fail-closed): ${validated.reason}`,
        changed: ['evidence', 'registry', 'referenced_skills', 'policy', 'target'],
      };
    }
    return { status: 'corrupted_basis', reason: validated.reason };
  }

  const frozen = validated.basis;
  const world = resolveLiveWorld(frozen, live);
  const liveBasis = buildLiveReviewBasis(world);
  const changed: ReviewBasisField[] = [];

  if (world.manifestHash !== frozen.manifestHash) changed.push('manifest');
  if (world.evidenceBundleHash !== frozen.evidenceBundleHash) {
    changed.push('evidence');
  }
  if (
    !arraysEqual(
      sortedCopy(world.registryReadSet),
      sortedCopy(frozen.registryReadSetFingerprints),
    )
  ) {
    changed.push('registry');
    changed.push('registry_read_set');
  }
  if (
    !arraysEqual(
      sortedCopy(world.referencedSkillHashes),
      sortedCopy(frozen.referencedSkillHashes),
    )
  ) {
    changed.push('referenced_skills');
  }
  if (
    (world.reviewPolicyVersion || EVIDENCE_REVIEW_POLICY_VERSION)
    !== frozen.reviewPolicyVersion
  ) {
    changed.push('policy');
  }
  if (
    (world.promptVersion || EVIDENCE_REVIEW_PROMPT_VERSION) !== frozen.promptVersion
  ) {
    changed.push('prompt');
  }
  if (
    (world.targetCapabilityHandle ?? undefined)
      !== (frozen.targetCapabilityHandle ?? undefined)
    || (world.targetCapabilityRevision ?? undefined)
      !== (frozen.targetCapabilityRevision ?? undefined)
  ) {
    changed.push('target');
  }

  // Unrelated Registry handles never contribute to `changed`.
  if (!isBundleLive(live)) {
    void live.unrelatedRegistryFingerprints;
  }

  if (changed.length === 0) {
    return {
      status: 'match',
      basisHash: frozen.basisHash,
      liveBasisHash: liveBasis.basisHash,
    };
  }

  return {
    status: 'stale',
    basisHash: frozen.basisHash,
    liveBasisHash: liveBasis.basisHash,
    changed,
    reason: `Review Basis stale: ${changed.join(',')}`,
  };
}

/**
 * Decide the Review Commit Fence outcome for a job.
 *
 * @param commitAlreadyApplied - when true, a prior atomic commit already
 *   applied the Transition Journal; a later relevant change becomes ordinary
 *   reassessment instead of superseding the committed job.
 */
export function decideReviewCommitFence(input: {
  basis: unknown;
  live: LiveReviewInput;
  /** True when the Capability Transition has already committed successfully. */
  commitAlreadyApplied?: boolean;
}): FenceDecision {
  // Pure validation path so corruption is a first-class decision kind.
  const validated = validateReviewBasis(input.basis);
  if (!validated.ok) {
    const comparison: FenceComparisonCorrupted = {
      status: 'corrupted_basis',
      reason: validated.reason,
    };
    return {
      kind: 'corrupted_basis',
      comparison,
      mayCommit: false,
      shouldCreateSuccessor: false,
      shouldScheduleReassessment: false,
      reason: validated.reason,
    };
  }

  const comparison = compareReviewBasis(validated.basis, input.live);
  // compareReviewBasis on a validated basis never returns corrupted_basis.
  if (comparison.status === 'corrupted_basis') {
    return {
      kind: 'corrupted_basis',
      comparison,
      mayCommit: false,
      shouldCreateSuccessor: false,
      shouldScheduleReassessment: false,
      reason: comparison.reason,
    };
  }

  if (comparison.status === 'match') {
    const unrelated = !isBundleLive(input.live)
      ? (input.live.unrelatedRegistryFingerprints ?? [])
      : [];
    if (unrelated.length > 0) {
      return {
        kind: 'unrelated_change',
        comparison,
        mayCommit: !input.commitAlreadyApplied,
        shouldCreateSuccessor: false,
        shouldScheduleReassessment: false,
        reason:
          'Unrelated Registry change outside declared read set does not invalidate Review Basis',
      };
    }

    return {
      kind: 'match',
      comparison,
      mayCommit: !input.commitAlreadyApplied,
      shouldCreateSuccessor: false,
      shouldScheduleReassessment: false,
      reason: 'Review Basis matches every declared relevant dependency',
    };
  }

  // stale
  if (input.commitAlreadyApplied) {
    return {
      kind: 'post_commit_reassessment',
      comparison,
      mayCommit: false,
      shouldCreateSuccessor: false,
      shouldScheduleReassessment: true,
      reason:
        `Relevant change after commit schedules reassessment (${comparison.changed.join(',')})`,
    };
  }

  return {
    kind: 'stale_before_fence',
    comparison,
    mayCommit: false,
    shouldCreateSuccessor: true,
    shouldScheduleReassessment: false,
    reason: comparison.reason,
  };
}

/**
 * Race-model helper: apply a fence decision for two competing orderings of
 * the same relevant change relative to the atomic commit point.
 *
 * Prevents blind last-writer-wins by requiring an explicit ordering flag.
 */
export function resolveFenceRace(input: {
  basis: unknown;
  live: LiveReviewInput;
  /**
   * Ordering of the relevant live change relative to the fence:
   * - 'before' → stale_before_fence (or match/unrelated if not relevant)
   * - 'after'  → post_commit_reassessment when the change is relevant
   */
  changeOrdering: 'before' | 'after';
}): FenceDecision {
  return decideReviewCommitFence({
    basis: input.basis,
    live: input.live,
    commitAlreadyApplied: input.changeOrdering === 'after',
  });
}

// ---------------------------------------------------------------------------
// Content-identified Quantum identity equality
// ---------------------------------------------------------------------------

/**
 * Complete identity equality required for Quantum reuse across Successor Jobs.
 * Requires kind, inputHash (inputs + prompt version + policy version), and the
 * optional domain payload identifiers that affect the authoritative result.
 */
export function quantumIdentityEquals(
  a: Pick<ReviewQuantumRecord, 'kind' | 'inputHash' | 'shardId' | 'lane'>,
  b: Pick<ReviewQuantumRecord, 'kind' | 'inputHash' | 'shardId' | 'lane'>,
): boolean {
  return (
    a.kind === b.kind
    && a.inputHash === b.inputHash
    && (a.shardId ?? undefined) === (b.shardId ?? undefined)
    && (a.lane ?? undefined) === (b.lane ?? undefined)
  );
}

/**
 * Recompute a Quantum input hash the same way `createReviewQuantum` does, so
 * callers can prove that prompt/policy version changes break identity.
 */
export function computeQuantumIdentity(input: {
  kind: ReviewQuantumKind;
  inputs: Record<string, unknown>;
  promptVersion?: string;
  policyVersion?: string;
}): { inputHash: string; quantumIdSuffix: string } {
  const promptVersion = input.promptVersion ?? EVIDENCE_REVIEW_PROMPT_VERSION;
  const policyVersion = input.policyVersion ?? EVIDENCE_REVIEW_POLICY_VERSION;
  const inputHash = quantumInputHash({
    kind: input.kind,
    promptVersion,
    policyVersion,
    ...input.inputs,
  });
  return {
    inputHash,
    quantumIdSuffix: inputHash.slice(0, 16),
  };
}

/**
 * Reuse only succeeded quanta whose complete content identity still matches.
 * Thin wrapper around the graph helper that also reports which nodes were
 * reused vs skipped — used by Successor Review Job planning.
 */
export function reuseValidSucceededQuanta(
  successor: EvidenceReviewJob,
  prior: EvidenceReviewJob,
): {
  job: EvidenceReviewJob;
  reusedQuantumIds: string[];
  skippedQuantumIds: string[];
} {
  const priorSucceeded = Object.values(prior.quanta).filter(q => q.state === 'succeeded');
  const priorByIdentity = new Map(
    priorSucceeded.map(q => [`${q.kind}:${q.inputHash}`, q] as const),
  );

  const reused = reuseSucceededQuanta(successor, prior);
  const reusedQuantumIds: string[] = [];
  const skippedQuantumIds: string[] = [];

  for (const quantum of Object.values(reused.quanta)) {
    const match = priorByIdentity.get(`${quantum.kind}:${quantum.inputHash}`);
    if (match && quantumIdentityEquals(quantum, match) && quantum.state === 'succeeded') {
      reusedQuantumIds.push(quantum.quantumId);
    } else if (quantum.state !== 'succeeded') {
      // Candidate for reuse only if prior had a success with same kind+shard
      // but different identity — record as skipped.
      const priorSameDomain = priorSucceeded.find(
        q =>
          q.kind === quantum.kind
          && (q.shardId ?? undefined) === (quantum.shardId ?? undefined)
          && (q.lane ?? undefined) === (quantum.lane ?? undefined),
      );
      if (priorSameDomain && !quantumIdentityEquals(quantum, priorSameDomain)) {
        skippedQuantumIds.push(quantum.quantumId);
      }
    }
  }

  return { job: reused, reusedQuantumIds, skippedQuantumIds };
}

// ---------------------------------------------------------------------------
// Successor Review Job planning
// ---------------------------------------------------------------------------

export function markJobSuperseded(
  staleJob: EvidenceReviewJob,
  successorJobId: string,
  now: Date = new Date(),
): EvidenceReviewJob {
  return {
    ...staleJob,
    disposition: 'superseded',
    successorJobId,
    updatedAt: now.toISOString(),
    terminalReason: `Superseded by successor job ${successorJobId}`,
  };
}

/**
 * Create a Successor Review Job after a stale fence, reusing still-valid quanta.
 *
 * Skill Evolution integration API — preserved signature and behavior.
 */
export function createSuccessorReviewJob(input: {
  staleJob: EvidenceReviewJob;
  liveBundle: EvidenceBundle;
  candidate: DistilledKnowledgeCandidate;
  registryReadSet?: readonly CapabilityReadSetEntry[];
  now?: Date;
}): EvidenceReviewJob {
  const successor = createEvidenceReviewJob({
    bundle: input.liveBundle,
    candidate: input.candidate,
    workClass: input.staleJob.workClass,
    registryReadSet: input.registryReadSet ?? input.staleJob.basis.registryReadSet,
    parentJobId: input.staleJob.jobId,
    now: input.now,
  });
  const { job: reused } = reuseValidSucceededQuanta(successor, input.staleJob);
  reused.parentJobId = input.staleJob.jobId;
  return reused;
}

/**
 * Plan a Successor Review Job after a stale-before-fence decision.
 *
 * Safe successor planning on the engine job shape:
 * - Prefer full engine create when liveBundle + candidate are supplied
 * - Otherwise rematerialize dual-lane coverage from domainShards / prior quanta
 * - Links successor.parentJobId ↔ superseded.successorJobId for audit
 * - Reuses only quanta with complete content identity equality
 */
export function planSuccessorReviewJob(input: {
  staleJob: EvidenceReviewJob;
  live?: LiveReviewWorld;
  liveBundle?: EvidenceBundle;
  candidate?: DistilledKnowledgeCandidate;
  registryReadSet?: readonly CapabilityReadSetEntry[];
  /**
   * Successor Quantum topology shards. When omitted with no liveBundle, the
   * successor rematerializes prior quanta (identity-preserving when only
   * non-quantum basis fields changed, e.g. target revision).
   */
  domainShards?: readonly { shardId: string; contentHash: string }[];
  workClass?: ReviewWorkClass;
  successorJobId?: string;
  domain?: Record<string, unknown>;
  now?: Date;
}): SuccessorReviewPlan {
  const now = input.now ?? new Date();
  const staleJob = input.staleJob;

  let successor: EvidenceReviewJob;

  if (input.liveBundle && input.candidate) {
    successor = createEvidenceReviewJob({
      bundle: input.liveBundle,
      candidate: input.candidate,
      workClass: input.workClass ?? staleJob.workClass,
      registryReadSet: input.registryReadSet ?? staleJob.basis.registryReadSet,
      parentJobId: staleJob.jobId,
      now,
      jobId: input.successorJobId,
    });
  } else {
    const liveWorld: LiveReviewWorld = input.live ?? {
      evidenceBundleHash: staleJob.basis.evidenceBundleHash,
      manifestHash: staleJob.basis.manifestHash,
      registryReadSet: staleJob.basis.registryReadSetFingerprints,
      referencedSkillHashes: staleJob.basis.referencedSkillHashes,
      reviewPolicyVersion: staleJob.basis.reviewPolicyVersion,
      promptVersion: staleJob.basis.promptVersion,
      targetCapabilityHandle: staleJob.basis.targetCapabilityHandle,
      targetCapabilityRevision: staleJob.basis.targetCapabilityRevision,
    };
    const liveBasis = buildLiveReviewBasis(liveWorld);
    const successorJobId =
      input.successorJobId
      ?? `job:successor:${staleJob.jobId}:${liveBasis.basisHash.slice(0, 12)}`;

    let quanta: ReviewQuantumRecord[];
    if (input.domainShards && input.domainShards.length > 0) {
      quanta = [];
      const authorIds: string[] = [];
      const verifierIds: string[] = [];
      for (const shard of input.domainShards) {
        const author = createReviewQuantum(successorJobId, {
          kind: 'author_reader',
          inputs: {
            lane: 'author',
            shardId: shard.shardId,
            contentHash: shard.contentHash,
          },
          shardId: shard.shardId,
          lane: 'author',
          promptVersion: liveWorld.promptVersion,
          policyVersion: liveWorld.reviewPolicyVersion,
        }, now);
        const verifier = createReviewQuantum(successorJobId, {
          kind: 'verifier_reader',
          inputs: {
            lane: 'verifier',
            shardId: shard.shardId,
            contentHash: shard.contentHash,
          },
          shardId: shard.shardId,
          lane: 'verifier',
          promptVersion: liveWorld.promptVersion,
          policyVersion: liveWorld.reviewPolicyVersion,
        }, now);
        quanta.push(author, verifier);
        authorIds.push(author.quantumId);
        verifierIds.push(verifier.quantumId);
      }
      const authorDossier = createReviewQuantum(successorJobId, {
        kind: 'author_dossier',
        inputs: {
          lane: 'author',
          readers: authorIds,
          basisHash: liveBasis.basisHash,
        },
        dependencyQuantumIds: authorIds,
        lane: 'author',
        promptVersion: liveWorld.promptVersion,
        policyVersion: liveWorld.reviewPolicyVersion,
      }, now);
      const verifierDossier = createReviewQuantum(successorJobId, {
        kind: 'verifier_dossier',
        inputs: {
          lane: 'verifier',
          readers: verifierIds,
          basisHash: liveBasis.basisHash,
        },
        dependencyQuantumIds: verifierIds,
        lane: 'verifier',
        promptVersion: liveWorld.promptVersion,
        policyVersion: liveWorld.reviewPolicyVersion,
      }, now);
      quanta.push(authorDossier, verifierDossier);
    } else {
      // Identity-preserving rematerialization when only non-quantum basis
      // fields changed (e.g. target revision with same evidence).
      const priorList = Object.values(staleJob.quanta);
      quanta = priorList.map(prior => {
        const rematerialized: ReviewQuantumRecord = {
          quantumId: makeQuantumId(successorJobId, prior.kind, prior.inputHash),
          kind: prior.kind,
          inputHash: prior.inputHash,
          dependencyQuantumIds: [],
          ...(prior.shardId !== undefined ? { shardId: prior.shardId } : {}),
          ...(prior.lane !== undefined ? { lane: prior.lane } : {}),
          state: 'pending',
          attempts: 0,
          currentDelayMs: 0,
          transcriptPaths: [],
          updatedAt: now.toISOString(),
        };
        return rematerialized;
      });
      const idMap = new Map<string, string>();
      for (let i = 0; i < priorList.length; i += 1) {
        idMap.set(priorList[i]!.quantumId, quanta[i]!.quantumId);
      }
      quanta = quanta.map((q, i) => ({
        ...q,
        dependencyQuantumIds: priorList[i]!.dependencyQuantumIds
          .map(dep => idMap.get(dep))
          .filter((id): id is string => typeof id === 'string'),
      }));
    }

    // Engine job shell: reuse prior domain payloads with the new live basis.
    // Quanta are engine-compatible ReviewQuantumRecord maps.
    const quantaMap: Record<string, ReviewQuantumRecord> = {};
    for (const q of quanta) quantaMap[q.quantumId] = q;

    successor = {
      ...staleJob,
      jobId: successorJobId,
      workClass: input.workClass ?? staleJob.workClass,
      disposition: 'active',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      basis: liveBasis,
      quanta: quantaMap,
      parentJobId: staleJob.jobId,
      successorJobId: undefined,
      supersededByJobId: undefined,
      terminalReason: undefined,
      transitionId: undefined,
      draft: undefined,
      verifierResult: undefined,
      authorDossier: undefined,
      verifierDossier: undefined,
      differenceIndex: undefined,
      obligations: undefined,
      obligationDispositions: undefined,
      domain: input.domain ?? staleJob.domain,
      nextDueAt: undefined,
    };
  }

  if (input.successorJobId && successor.jobId !== input.successorJobId) {
    // createEvidenceReviewJob may mint its own id when not provided; when the
    // caller forced one via the engine path it is already applied above.
  }

  const { job: reused, reusedQuantumIds, skippedQuantumIds } = reuseValidSucceededQuanta(
    successor,
    staleJob,
  );
  reused.parentJobId = staleJob.jobId;

  const superseded = markJobSuperseded(staleJob, reused.jobId, now);

  return {
    successor: reused,
    superseded,
    reusedQuantumIds,
    skippedQuantumIds,
    auditLink: {
      parentJobId: staleJob.jobId,
      successorJobId: reused.jobId,
      supersededDisposition: 'superseded',
    },
  };
}

export {
  buildReviewBasis,
  createReviewQuantum,
  quantumInputHash,
  makeQuantumId,
  reuseSucceededQuanta,
  hashEvidenceBundle,
  sha256Hex,
  stableStringify,
};

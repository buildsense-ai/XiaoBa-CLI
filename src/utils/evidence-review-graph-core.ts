/**
 * Evidence Review Dependency Graph — pure durable APIs (ADR 0045 / #107).
 *
 * Provides content-identified Quantum identity, declared dependency readiness,
 * expiring Quantum Leases, idempotent success persistence, local retry-wait
 * deadlines, and restart recovery helpers. Scheduling fairness, Runtime Learning
 * wake integration, and Review Commit Fence semantics are intentionally out of
 * scope (#108 / #109).
 */

import {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  EVIDENCE_REVIEW_POLICY_VERSION,
  EVIDENCE_REVIEW_PROMPT_VERSION,
  type EvidenceReviewJobDisposition,
  type GraphEvidenceReviewJob,
  type GraphReviewBasis,
  type QuantumLease,
  type ReviewQuantumKind,
  type ReviewQuantumRecord,
  type ReviewWorkClass,
} from './evidence-review-types';
import { sha256Hex, stableStringify } from './evidence-review/canonical';

export { sha256Hex, stableStringify };

/**
 * Minimal structural view of a job for graph-core read/mutate functions.
 * The engine EvidenceReviewJob structurally satisfies this interface,
 * eliminating `as any` bridges.
 */
export interface GraphJobView {
  disposition: EvidenceReviewJobDisposition;
  quanta: Record<string, ReviewQuantumRecord>;
  updatedAt: string;
  nextDueAt?: string;
  terminalReason?: string;
}

// ---------------------------------------------------------------------------
// Canonical hashing / identity
// ---------------------------------------------------------------------------

/**
 * Content hash over Quantum inputs. Callers must include every input that
 * affects the authoritative result so identity changes when those inputs change.
 */
export function quantumInputHash(parts: Record<string, unknown>): string {
  return sha256Hex(stableStringify(parts));
}

/** Content-derived Quantum identity: job + kind + truncated input hash. */
export function makeQuantumId(
  jobId: string,
  kind: ReviewQuantumKind,
  inputHash: string,
): string {
  return `q:${jobId}:${kind}:${inputHash.slice(0, 16)}`;
}

export interface QuantumSpec {
  kind: ReviewQuantumKind;
  /** Kind-specific inputs (shard hashes, dossier inputs, etc.). */
  inputs: Record<string, unknown>;
  dependencyQuantumIds?: readonly string[];
  shardId?: string;
  lane?: 'author' | 'verifier';
  promptVersion?: string;
  policyVersion?: string;
}

/**
 * Build a pending Review Quantum with content-derived identity.
 * Identity always stamps prompt and policy versions.
 */
export function createReviewQuantum(
  jobId: string,
  spec: QuantumSpec,
  now: Date = new Date(),
): ReviewQuantumRecord {
  const promptVersion = spec.promptVersion ?? EVIDENCE_REVIEW_PROMPT_VERSION;
  const policyVersion = spec.policyVersion ?? EVIDENCE_REVIEW_POLICY_VERSION;
  const inputHash = quantumInputHash({
    kind: spec.kind,
    promptVersion,
    policyVersion,
    ...spec.inputs,
  });
  const nowIso = now.toISOString();
  return {
    quantumId: makeQuantumId(jobId, spec.kind, inputHash),
    kind: spec.kind,
    inputHash,
    dependencyQuantumIds: [...(spec.dependencyQuantumIds ?? [])],
    ...(spec.shardId !== undefined ? { shardId: spec.shardId } : {}),
    ...(spec.lane !== undefined ? { lane: spec.lane } : {}),
    state: 'pending',
    attempts: 0,
    currentDelayMs: 0,
    transcriptPaths: [],
    updatedAt: nowIso,
  };
}

export interface ReviewBasisInput {
  manifestHash: string;
  evidenceBundleHash: string;
  registryReadSet?: readonly string[];
  referencedSkillHashes?: readonly string[];
  reviewPolicyVersion?: string;
  promptVersion?: string;
  targetCapabilityHandle?: string;
  targetCapabilityRevision?: number;
}

/**
 * Build an immutable Review Basis version vector.
 * Fence comparison is intentionally not implemented here (#109).
 */
export function buildReviewBasis(input: ReviewBasisInput): GraphReviewBasis {
  const registryReadSet = [...(input.registryReadSet ?? [])]
    .map(entry => String(entry))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const referencedSkillHashes = [...(input.referencedSkillHashes ?? [])]
    .map(entry => String(entry))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const reviewPolicyVersion = input.reviewPolicyVersion ?? EVIDENCE_REVIEW_POLICY_VERSION;
  const promptVersion = input.promptVersion ?? EVIDENCE_REVIEW_PROMPT_VERSION;
  const basisBody: Omit<GraphReviewBasis, 'basisHash'> = {
    manifestHash: input.manifestHash,
    evidenceBundleHash: input.evidenceBundleHash,
    registryReadSet,
    referencedSkillHashes,
    reviewPolicyVersion,
    promptVersion,
    ...(typeof input.targetCapabilityHandle === 'string'
      ? { targetCapabilityHandle: input.targetCapabilityHandle }
      : {}),
    ...(typeof input.targetCapabilityRevision === 'number'
      ? { targetCapabilityRevision: input.targetCapabilityRevision }
      : {}),
  };
  return {
    ...basisBody,
    basisHash: sha256Hex(stableStringify(basisBody)),
  };
}

// ---------------------------------------------------------------------------
// Job construction
// ---------------------------------------------------------------------------

export interface CreateEvidenceReviewJobInput {
  jobId: string;
  workClass: ReviewWorkClass;
  basis: GraphReviewBasis;
  quanta: readonly ReviewQuantumRecord[];
  domain?: Record<string, unknown>;
  parentJobId?: string;
  now?: Date;
}

/**
 * Create a durable job from an already-declared Quantum graph.
 * Callers own domain sharding and graph topology construction.
 */
export function createEvidenceReviewJob(input: CreateEvidenceReviewJobInput): GraphEvidenceReviewJob {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const quanta: Record<string, ReviewQuantumRecord> = {};
  for (const quantum of input.quanta) {
    if (quanta[quantum.quantumId]) {
      throw new Error(`Duplicate Review Quantum identity: ${quantum.quantumId}`);
    }
    quanta[quantum.quantumId] = { ...quantum, dependencyQuantumIds: [...quantum.dependencyQuantumIds] };
  }
  validateGraphOrThrow(quanta);
  return {
    schemaVersion: EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
    jobId: input.jobId,
    workClass: input.workClass,
    disposition: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
    basis: input.basis,
    quanta,
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
  };
}

/**
 * Build a minimal dual-lane coverage graph for N opaque shard descriptors.
 * Useful for foundation tests and as a topology template for higher layers.
 */
export function buildDualLaneCoverageQuanta(input: {
  jobId: string;
  shards: readonly { shardId: string; contentHash: string }[];
  basisHash: string;
  now?: Date;
}): ReviewQuantumRecord[] {
  const now = input.now ?? new Date();
  const quanta: ReviewQuantumRecord[] = [];
  const authorReaderIds: string[] = [];
  const verifierReaderIds: string[] = [];

  for (const shard of input.shards) {
    const author = createReviewQuantum(input.jobId, {
      kind: 'author_reader',
      inputs: { lane: 'author', shardId: shard.shardId, contentHash: shard.contentHash },
      shardId: shard.shardId,
      lane: 'author',
    }, now);
    const verifier = createReviewQuantum(input.jobId, {
      kind: 'verifier_reader',
      inputs: { lane: 'verifier', shardId: shard.shardId, contentHash: shard.contentHash },
      shardId: shard.shardId,
      lane: 'verifier',
    }, now);
    quanta.push(author, verifier);
    authorReaderIds.push(author.quantumId);
    verifierReaderIds.push(verifier.quantumId);
  }

  const authorDossier = createReviewQuantum(input.jobId, {
    kind: 'author_dossier',
    inputs: { lane: 'author', readers: authorReaderIds },
    dependencyQuantumIds: authorReaderIds,
    lane: 'author',
  }, now);
  const verifierDossier = createReviewQuantum(input.jobId, {
    kind: 'verifier_dossier',
    inputs: { lane: 'verifier', readers: verifierReaderIds },
    dependencyQuantumIds: verifierReaderIds,
    lane: 'verifier',
  }, now);
  quanta.push(authorDossier, verifierDossier);

  const difference = createReviewQuantum(input.jobId, {
    kind: 'difference_index',
    inputs: { dossiers: [authorDossier.quantumId, verifierDossier.quantumId] },
    dependencyQuantumIds: [authorDossier.quantumId, verifierDossier.quantumId],
  }, now);
  quanta.push(difference);

  const obligations = createReviewQuantum(input.jobId, {
    kind: 'obligations',
    inputs: { difference: difference.quantumId },
    dependencyQuantumIds: [difference.quantumId],
  }, now);
  quanta.push(obligations);

  const skillAuthor = createReviewQuantum(input.jobId, {
    kind: 'skill_author',
    inputs: { authorDossier: authorDossier.quantumId },
    dependencyQuantumIds: [authorDossier.quantumId, obligations.quantumId],
  }, now);
  quanta.push(skillAuthor);

  const skillVerifier = createReviewQuantum(input.jobId, {
    kind: 'skill_verifier',
    inputs: {
      author: skillAuthor.quantumId,
      dossiers: [authorDossier.quantumId, verifierDossier.quantumId],
      difference: difference.quantumId,
      obligations: obligations.quantumId,
    },
    dependencyQuantumIds: [
      skillAuthor.quantumId,
      verifierDossier.quantumId,
      difference.quantumId,
      obligations.quantumId,
    ],
  }, now);
  quanta.push(skillVerifier);

  const commit = createReviewQuantum(input.jobId, {
    kind: 'commit',
    inputs: { basisHash: input.basisHash, skillVerifier: skillVerifier.quantumId },
    dependencyQuantumIds: [skillVerifier.quantumId],
  }, now);
  quanta.push(commit);

  return quanta;
}

function validateGraphOrThrow(quanta: Record<string, ReviewQuantumRecord>): void {
  for (const quantum of Object.values(quanta)) {
    for (const depId of quantum.dependencyQuantumIds) {
      if (!quanta[depId]) {
        throw new Error(
          `Review Quantum ${quantum.quantumId} declares missing dependency ${depId}`,
        );
      }
    }
  }
  // Fail closed on cycles via DFS color marking.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of Object.keys(quanta)) color.set(id, WHITE);

  const visit = (id: string): void => {
    color.set(id, GRAY);
    const node = quanta[id]!;
    for (const depId of node.dependencyQuantumIds) {
      const c = color.get(depId) ?? WHITE;
      if (c === GRAY) {
        throw new Error(`Review Quantum graph contains a cycle at ${depId}`);
      }
      if (c === WHITE) visit(depId);
    }
    color.set(id, BLACK);
  };

  for (const id of Object.keys(quanta)) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  }
}

// ---------------------------------------------------------------------------
// Readiness / progress derivation
// ---------------------------------------------------------------------------

/** True when every declared dependency has succeeded. */
export function dependenciesSatisfied(
  job: GraphJobView,
  quantum: ReviewQuantumRecord,
): boolean {
  return quantum.dependencyQuantumIds.every(depId => {
    const dep = job.quanta[depId];
    return dep?.state === 'succeeded';
  });
}

/**
 * A Quantum is runnable when the job is active and the node is pending with
 * satisfied dependencies, has an expired lease, or has reached its retry deadline.
 * Successful results are never re-run.
 */
export function isQuantumRunnable(
  job: GraphJobView,
  quantum: ReviewQuantumRecord,
  now: Date,
): boolean {
  if (job.disposition !== 'active') return false;
  if (quantum.state === 'succeeded' || quantum.state === 'terminal_failed') return false;

  if (quantum.state === 'leased') {
    if (!quantum.lease) return true; // fail-open reclaim of malformed lease
    return new Date(quantum.lease.expiresAt).getTime() <= now.getTime();
  }

  if (quantum.state === 'retry_wait') {
    if (!quantum.nextRetryAt) return true;
    return new Date(quantum.nextRetryAt).getTime() <= now.getTime();
  }

  // pending
  return dependenciesSatisfied(job, quantum);
}

/** Lower rank = higher critical-path priority (fairness uses this in #108). */
export function criticalPathRank(quantum: ReviewQuantumRecord): number {
  switch (quantum.kind) {
    case 'commit': return 0;
    case 'skill_verifier': return 1;
    case 'skill_author': return 2;
    case 'obligations': return 3;
    case 'difference_index': return 4;
    case 'author_dossier':
    case 'verifier_dossier': return 5;
    case 'author_reader':
    case 'verifier_reader': return 6;
    default: return 100;
  }
}

export function listRunnableQuanta(
  job: GraphJobView,
  now: Date,
): ReviewQuantumRecord[] {
  return Object.values(job.quanta)
    .filter(quantum => isQuantumRunnable(job, quantum, now))
    .sort((a, b) => criticalPathRank(a) - criticalPathRank(b)
      || a.quantumId.localeCompare(b.quantumId, 'en'));
}

/**
 * Derive disposition from quanta unless an explicit terminal/deferred outcome
 * is already recorded. Linear phase flags are never consulted.
 */
export function deriveJobDisposition(job: GraphJobView): EvidenceReviewJobDisposition {
  if (
    job.disposition === 'completed'
    || job.disposition === 'superseded'
    || job.disposition === 'terminal_failed'
    || job.disposition === 'deferred'
  ) {
    return job.disposition;
  }
  const quanta = Object.values(job.quanta);
  if (quanta.some(q => q.state === 'terminal_failed')) {
    // Local quantum terminal failure does not auto-fail the job unless commit
    // itself is terminal, or every remaining path is blocked. Keep active so
    // independent nodes can still complete; higher layers may mark terminal.
    const commit = quanta.find(q => q.kind === 'commit');
    if (commit?.state === 'terminal_failed') return 'terminal_failed';
  }
  const commit = quanta.find(q => q.kind === 'commit');
  if (commit?.state === 'succeeded') return 'completed';
  return 'active';
}

// ---------------------------------------------------------------------------
// Lease claim / reclaim / completion / retry
// ---------------------------------------------------------------------------

export const DEFAULT_QUANTUM_LEASE_MS = 60_000;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_RETRY_MAX_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface ClaimQuantumOptions {
  ownerWakeId: string;
  leaseMs?: number;
  now?: Date;
}

export type ClaimQuantumResult =
  | { ok: true; quantum: ReviewQuantumRecord; lease: QuantumLease }
  | { ok: false; reason: 'not_runnable' | 'already_succeeded' | 'job_not_active' | 'missing' };

/**
 * Claim a runnable Quantum through an expiring lease.
 * Idempotent success: already-succeeded nodes are never re-leased.
 */
export function claimQuantum(
  job: GraphJobView,
  quantumId: string,
  options: ClaimQuantumOptions,
): ClaimQuantumResult {
  const quantum = job.quanta[quantumId];
  if (!quantum) return { ok: false, reason: 'missing' };
  if (job.disposition !== 'active') return { ok: false, reason: 'job_not_active' };
  if (quantum.state === 'succeeded') return { ok: false, reason: 'already_succeeded' };

  const now = options.now ?? new Date();
  if (!isQuantumRunnable(job, quantum, now)) {
    return { ok: false, reason: 'not_runnable' };
  }

  const leaseMs = options.leaseMs ?? DEFAULT_QUANTUM_LEASE_MS;
  const leasedAt = now.toISOString();
  const lease: QuantumLease = {
    leaseId: `lease:${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    ownerWakeId: options.ownerWakeId,
    leasedAt,
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  };
  const claimed: ReviewQuantumRecord = {
    ...quantum,
    state: 'leased',
    lease,
    nextRetryAt: undefined,
    updatedAt: leasedAt,
  };
  job.quanta[quantumId] = claimed;
  job.updatedAt = leasedAt;
  return { ok: true, quantum: claimed, lease };
}

export type CompleteQuantumResult =
  | { ok: true; quantum: ReviewQuantumRecord; alreadySucceeded: boolean }
  | { ok: false; reason: 'missing' | 'lease_mismatch' | 'not_leased' | 'job_not_active' };

export interface CompleteQuantumOptions {
  result: unknown;
  /** When set, only the matching lease owner may complete. */
  leaseId?: string;
  transcriptPath?: string;
  now?: Date;
}

/**
 * Persist a successful Quantum result idempotently.
 * A second completion for the same identity is a no-op success.
 */
export function completeQuantum(
  job: GraphJobView,
  quantumId: string,
  options: CompleteQuantumOptions,
): CompleteQuantumResult {
  const quantum = job.quanta[quantumId];
  if (!quantum) return { ok: false, reason: 'missing' };

  // Active jobs accept new completions. Completed jobs only accept the
  // idempotent re-completion of an already-succeeded identity below.
  if (job.disposition !== 'active' && job.disposition !== 'completed') {
    return { ok: false, reason: 'job_not_active' };
  }

  if (quantum.state === 'succeeded') {
    return { ok: true, quantum, alreadySucceeded: true };
  }

  // Non-active dispositions cannot accept first-time success.
  if (job.disposition !== 'active') {
    return { ok: false, reason: 'job_not_active' };
  }

  if (quantum.state === 'terminal_failed') {
    return { ok: false, reason: 'not_leased' };
  }

  if (options.leaseId !== undefined) {
    if (quantum.lease && quantum.lease.leaseId !== options.leaseId) {
      return { ok: false, reason: 'lease_mismatch' };
    }
  }

  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const resultHash = sha256Hex(stableStringify(options.result));
  const transcriptPaths = options.transcriptPath
    ? [...quantum.transcriptPaths, options.transcriptPath]
    : [...quantum.transcriptPaths];

  const succeeded: ReviewQuantumRecord = {
    ...quantum,
    state: 'succeeded',
    result: options.result,
    resultHash,
    lease: undefined,
    nextRetryAt: undefined,
    failureMessage: undefined,
    failureKind: undefined,
    transcriptPaths,
    updatedAt: nowIso,
  };
  job.quanta[quantumId] = succeeded;
  job.disposition = deriveJobDisposition(job);
  job.updatedAt = nowIso;
  job.nextDueAt = computeJobNextDueAt(job);
  return { ok: true, quantum: succeeded, alreadySucceeded: false };
}

export interface FailQuantumOptions {
  message: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  /** When true, mark terminal_failed immediately. */
  terminal?: boolean;
  leaseId?: string;
  now?: Date;
}

export type FailQuantumResult =
  | { ok: true; quantum: ReviewQuantumRecord }
  | { ok: false; reason: 'missing' | 'already_succeeded' | 'lease_mismatch' | 'job_not_active' };

/**
 * Record a local provider/schema failure. Retries only this Quantum with
 * bounded exponential backoff; other nodes are untouched.
 */
export function failQuantum(
  job: GraphJobView,
  quantumId: string,
  options: FailQuantumOptions,
): FailQuantumResult {
  const quantum = job.quanta[quantumId];
  if (!quantum) return { ok: false, reason: 'missing' };
  if (job.disposition !== 'active') return { ok: false, reason: 'job_not_active' };
  if (quantum.state === 'succeeded') return { ok: false, reason: 'already_succeeded' };

  if (options.leaseId !== undefined) {
    if (quantum.lease && quantum.lease.leaseId !== options.leaseId) {
      return { ok: false, reason: 'lease_mismatch' };
    }
  }

  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const attempts = quantum.attempts + 1;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;

  if (options.terminal || attempts >= maxAttempts) {
    const failed: ReviewQuantumRecord = {
      ...quantum,
      state: 'terminal_failed',
      attempts,
      failureMessage: options.message,
      lease: undefined,
      nextRetryAt: undefined,
      updatedAt: nowIso,
    };
    job.quanta[quantumId] = failed;
    job.disposition = deriveJobDisposition(job);
    job.updatedAt = nowIso;
    if (job.disposition === 'terminal_failed') {
      job.terminalReason = options.message;
    }
    job.nextDueAt = computeJobNextDueAt(job);
    return { ok: true, quantum: failed };
  }

  const previous = quantum.currentDelayMs > 0 ? quantum.currentDelayMs : retryBaseMs;
  const delay = Math.min(retryMaxMs, Math.max(retryBaseMs, previous * (attempts === 1 ? 1 : 2)));
  const nextRetryAt = new Date(now.getTime() + delay).toISOString();
  const waiting: ReviewQuantumRecord = {
    ...quantum,
    state: 'retry_wait',
    attempts,
    currentDelayMs: delay,
    nextRetryAt,
    failureMessage: options.message,
    lease: undefined,
    updatedAt: nowIso,
  };
  job.quanta[quantumId] = waiting;
  job.updatedAt = nowIso;
  job.nextDueAt = computeJobNextDueAt(job);
  return { ok: true, quantum: waiting };
}

/**
 * Reclaim expired leases on restart or mid-wake. Does not touch succeeded
 * results or unexpired ownership.
 */
export function reclaimExpiredLeases(
  job: GraphJobView,
  now: Date = new Date(),
): ReviewQuantumRecord[] {
  if (job.disposition !== 'active') return [];
  const reclaimed: ReviewQuantumRecord[] = [];
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  for (const [quantumId, quantum] of Object.entries(job.quanta)) {
    if (quantum.state !== 'leased') continue;
    const expired = !quantum.lease
      || new Date(quantum.lease.expiresAt).getTime() <= nowMs;
    if (!expired) continue;
    const pending: ReviewQuantumRecord = {
      ...quantum,
      state: 'pending',
      lease: undefined,
      updatedAt: nowIso,
    };
    job.quanta[quantumId] = pending;
    reclaimed.push(pending);
  }

  if (reclaimed.length > 0) {
    job.updatedAt = nowIso;
    job.nextDueAt = computeJobNextDueAt(job);
  }
  return reclaimed;
}

/**
 * Restart reconstruction helper: reclaim expired leases and recompute
 * disposition / nextDueAt from durable node state.
 */
export function recoverJobAfterRestart(
  job: GraphJobView,
  now: Date = new Date(),
): GraphJobView {
  reclaimExpiredLeases(job, now);
  job.disposition = deriveJobDisposition(job);
  job.nextDueAt = computeJobNextDueAt(job);
  job.updatedAt = now.toISOString();
  return job;
}

/** Earliest retry deadline among retry_wait / expired-lease nodes. */
export function computeJobNextDueAt(job: GraphJobView): string | undefined {
  if (job.disposition !== 'active') return undefined;
  let earliest: number | undefined;
  for (const quantum of Object.values(job.quanta)) {
    if (quantum.state === 'retry_wait' && quantum.nextRetryAt) {
      const t = new Date(quantum.nextRetryAt).getTime();
      if (earliest === undefined || t < earliest) earliest = t;
    }
    if (quantum.state === 'leased' && quantum.lease) {
      const t = new Date(quantum.lease.expiresAt).getTime();
      if (earliest === undefined || t < earliest) earliest = t;
    }
  }
  // If anything is currently runnable without a future deadline, due now is
  // represented as undefined so the scheduler may claim immediately.
  return earliest !== undefined ? new Date(earliest).toISOString() : undefined;
}

/**
 * Reuse succeeded quanta whose kind + inputHash still match.
 * Extension point for Successor Review Jobs (#109); no fence semantics here.
 */
export function reuseSucceededQuanta(
  successor: GraphJobView,
  prior: GraphJobView,
): GraphJobView {
  const nowIso = new Date().toISOString();
  const next: GraphJobView = {
    ...successor,
    quanta: { ...successor.quanta },
    updatedAt: nowIso,
  };

  const priorByInput = new Map(
    Object.values(prior.quanta)
      .filter(q => q.state === 'succeeded')
      .map(q => [`${q.kind}:${q.inputHash}`, q] as const),
  );

  for (const [quantumId, quantum] of Object.entries(next.quanta)) {
    if (quantum.state === 'succeeded') continue;
    const match = priorByInput.get(`${quantum.kind}:${quantum.inputHash}`);
    if (!match) continue;
    next.quanta[quantumId] = {
      ...quantum,
      state: 'succeeded',
      result: match.result,
      resultHash: match.resultHash,
      transcriptPaths: [...match.transcriptPaths],
      updatedAt: match.updatedAt,
      attempts: match.attempts,
      lease: undefined,
      nextRetryAt: undefined,
      failureMessage: undefined,
    };
  }

  next.disposition = deriveJobDisposition(next);
  next.nextDueAt = computeJobNextDueAt(next);
  return next;
}

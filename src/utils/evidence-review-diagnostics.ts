/**
 * Durable Evidence Review diagnostics (#110).
 *
 * Operator-facing projections distinguishing local retry, semantic defer,
 * supersession, incomplete coverage, clean completion, and terminal failure —
 * without reading raw queue JSON.
 *
 * Preserves the integrated `buildOperatorView` surface (flat diagnostics +
 * disposition + summary) while exposing richer facet projections for operators
 * and release canaries. Pure + dependency-light; no scheduler / RuntimeLearning
 * wiring.
 */

import type {
  EvidenceReviewDiagnostics,
  EvidenceReviewJob,
} from './evidence-review-types';
import { buildEvidenceReviewDiagnostics } from './evidence-review-job-store';

// ---------------------------------------------------------------------------
// Structural input types (duck-typed against pure graph + engine jobs)
// ---------------------------------------------------------------------------

export type EvidenceReviewJobDispositionInput =
  | 'active'
  | 'deferred'
  | 'completed'
  | 'superseded'
  | 'terminal_failed'
  | string;

export type ReviewQuantumStateInput =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'retry_wait'
  | 'terminal_failed'
  | string;

export interface ProjectionQuantumLease {
  readonly leaseId?: string;
  readonly ownerWakeId?: string;
  readonly leasedAt?: string;
  readonly expiresAt?: string;
}

export interface ProjectionQuantum {
  readonly quantumId: string;
  readonly kind?: string;
  readonly state: ReviewQuantumStateInput;
  readonly attempts?: number;
  readonly currentDelayMs?: number;
  readonly nextRetryAt?: string;
  readonly lease?: ProjectionQuantumLease;
  readonly shardId?: string;
  readonly lane?: 'author' | 'verifier' | string;
  readonly dependencyQuantumIds?: readonly string[];
  readonly failureMessage?: string;
  readonly transcriptPaths?: readonly string[];
  readonly updatedAt?: string;
}

export interface ProjectionObligation {
  readonly obligationId: string;
}

export interface ProjectionObligationDisposition {
  readonly obligationId: string;
}

/**
 * Minimal job surface required for operator projection.
 * Accepts pure-graph jobs, engine jobs, or fixture shapes.
 */
export interface EvidenceReviewProjectionInput {
  readonly jobId: string;
  readonly disposition: EvidenceReviewJobDispositionInput;
  readonly workClass?: string;
  readonly basisHash?: string;
  readonly manifestHash?: string;
  readonly shardCount?: number;
  readonly quanta?: Readonly<Record<string, ProjectionQuantum>> | readonly ProjectionQuantum[];
  readonly obligations?: readonly ProjectionObligation[];
  readonly obligationDispositions?: readonly ProjectionObligationDisposition[];
  readonly nextDueAt?: string;
  readonly successorJobId?: string;
  readonly supersededByJobId?: string;
  readonly parentJobId?: string;
  readonly transitionId?: string;
  readonly terminalReason?: string;
  /** Optional nested basis / manifest for engine jobs. */
  readonly basis?: { readonly basisHash?: string; readonly manifestHash?: string };
  readonly manifest?: { readonly manifestHash?: string; readonly shardIds?: readonly string[] };
  /** When true, state was recovered from a quarantined/corrupt store. */
  readonly stateCorrupt?: boolean;
}

// ---------------------------------------------------------------------------
// Operator-visible disposition + projection
// ---------------------------------------------------------------------------

/**
 * Operator-facing disposition. Distinct from durable job disposition:
 * intermediate progress (coverage, leases, retry) is derived from quanta.
 *
 * Naming preserves the integrated #110 surface:
 * - `local_retry` (not foundation `retry_wait`)
 * - `stale_basis_superseded` (not foundation `superseded`)
 */
export type EvidenceReviewOperatorDisposition =
  | 'active_coverage'
  | 'leased'
  | 'local_retry'
  | 'semantic_defer'
  | 'stale_basis_superseded'
  | 'incomplete_coverage'
  | 'completed'
  | 'terminal_integrity_failure'
  | 'drain_settling'
  | 'corrupt_state';

export interface ActiveCoverageProjection {
  readonly authorCoveredShards: number;
  readonly verifierCoveredShards: number;
  readonly shardCount: number;
  readonly authorComplete: boolean;
  readonly verifierComplete: boolean;
  readonly complete: boolean;
}

export interface LeaseProjectionItem {
  readonly quantumId: string;
  readonly kind?: string;
  readonly leaseId?: string;
  readonly ownerWakeId?: string;
  readonly expiresAt?: string;
}

export interface LeaseProjection {
  readonly count: number;
  readonly items: readonly LeaseProjectionItem[];
}

export interface RetryWaitProjection {
  readonly count: number;
  readonly totalAttempts: number;
  readonly earliestNextRetryAt?: string;
  readonly quantumIds: readonly string[];
}

export interface SemanticDeferProjection {
  readonly deferred: boolean;
  readonly unresolvedObligations: number;
}

export interface SupersessionProjection {
  readonly superseded: boolean;
  readonly successorJobId?: string;
  readonly supersededByJobId?: string;
  readonly parentJobId?: string;
}

export interface CompletionProjection {
  readonly completed: boolean;
  readonly transitionId?: string;
}

export interface TerminalIntegrityFailureProjection {
  readonly failed: boolean;
  readonly reason?: string;
  readonly failedQuanta: number;
  readonly failedQuantumIds: readonly string[];
}

export interface NextDueWorkProjection {
  readonly nextDueAt?: string;
  readonly runnableQuanta: number;
  readonly dueQuantumIds: readonly string[];
}

export interface ObligationProjection {
  readonly total: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly unresolvedIds: readonly string[];
}

export interface QuantumCountProjection {
  readonly total: number;
  readonly pending: number;
  readonly leased: number;
  readonly succeeded: number;
  readonly retryWait: number;
  readonly terminalFailed: number;
}

/**
 * Full operator-visible projection for one Evidence Review Job.
 * Every required diagnostic facet is present as a named field.
 */
export interface EvidenceReviewOperatorProjection {
  readonly jobId: string;
  readonly workClass?: string;
  readonly durableDisposition: EvidenceReviewJobDispositionInput;
  readonly operatorDisposition: EvidenceReviewOperatorDisposition;
  readonly summary: string;
  readonly basisHash?: string;
  readonly manifestHash?: string;
  readonly activeCoverage: ActiveCoverageProjection;
  readonly leases: LeaseProjection;
  readonly retryWait: RetryWaitProjection;
  readonly semanticDefer: SemanticDeferProjection;
  readonly supersession: SupersessionProjection;
  readonly completion: CompletionProjection;
  readonly terminalIntegrityFailure: TerminalIntegrityFailureProjection;
  readonly nextDueWork: NextDueWorkProjection;
  readonly obligations: ObligationProjection;
  /** Successor Review Job link when present. */
  readonly successorLink?: string;
  /** Capability Transition link when present. */
  readonly transitionLink?: string;
  readonly counts: QuantumCountProjection;
  readonly stateCorrupt: boolean;
  readonly projectedAt: string;
}

/**
 * Integrated compatibility view: flat store diagnostics + operator fields.
 * Existing call sites depend on EvidenceReviewDiagnostics field names.
 */
export interface EvidenceReviewOperatorView extends EvidenceReviewDiagnostics {
  operatorDisposition: EvidenceReviewOperatorDisposition;
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listQuanta(input: EvidenceReviewProjectionInput): ProjectionQuantum[] {
  if (!input.quanta) return [];
  if (Array.isArray(input.quanta)) return [...input.quanta];
  return Object.values(input.quanta as Record<string, ProjectionQuantum>);
}

function resolveShardCount(input: EvidenceReviewProjectionInput, quanta: readonly ProjectionQuantum[]): number {
  if (typeof input.shardCount === 'number' && input.shardCount >= 0) return input.shardCount;
  if (input.manifest?.shardIds) return input.manifest.shardIds.length;
  const shardIds = new Set(
    quanta
      .filter(q => q.kind === 'author_reader' || q.kind === 'verifier_reader' || q.shardId)
      .map(q => q.shardId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  if (shardIds.size > 0) return shardIds.size;
  const authorReaders = quanta.filter(q => q.kind === 'author_reader');
  if (authorReaders.length > 0) return authorReaders.length;
  return 0;
}

function resolveBasisHash(input: EvidenceReviewProjectionInput): string | undefined {
  return input.basisHash ?? input.basis?.basisHash;
}

function resolveManifestHash(input: EvidenceReviewProjectionInput): string | undefined {
  return input.manifestHash ?? input.manifest?.manifestHash ?? input.basis?.manifestHash;
}

function isQuantumRunnable(quantum: ProjectionQuantum, quantaById: Map<string, ProjectionQuantum>, nowMs: number): boolean {
  if (quantum.state === 'succeeded' || quantum.state === 'terminal_failed' || quantum.state === 'leased') {
    return false;
  }
  if (quantum.state === 'retry_wait') {
    if (!quantum.nextRetryAt) return false;
    const due = Date.parse(quantum.nextRetryAt);
    if (!Number.isFinite(due) || due > nowMs) return false;
  }
  if (quantum.state !== 'pending' && quantum.state !== 'retry_wait') return false;
  for (const depId of quantum.dependencyQuantumIds ?? []) {
    const dep = quantaById.get(depId);
    if (!dep || dep.state !== 'succeeded') return false;
  }
  return true;
}

function earliestIso(values: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Classification + projection
// ---------------------------------------------------------------------------

export function classifyOperatorDisposition(
  input: EvidenceReviewProjectionInput | EvidenceReviewJob,
  now: Date = new Date(),
): EvidenceReviewOperatorDisposition {
  void now;
  const job = input as EvidenceReviewProjectionInput;
  if (job.stateCorrupt) return 'corrupt_state';
  if (job.disposition === 'superseded') return 'stale_basis_superseded';
  if (job.disposition === 'deferred') return 'semantic_defer';
  if (job.disposition === 'completed') return 'completed';
  if (job.disposition === 'terminal_failed') return 'terminal_integrity_failure';

  const quanta = listQuanta(job);
  if (quanta.some(q => q.state === 'leased')) return 'leased';
  if (quanta.some(q => q.state === 'retry_wait')) return 'local_retry';

  const authorReaders = quanta.filter(q => q.kind === 'author_reader');
  const verifierReaders = quanta.filter(q => q.kind === 'verifier_reader');
  if (authorReaders.length > 0 || verifierReaders.length > 0) {
    const authorDone = authorReaders.length > 0 && authorReaders.every(q => q.state === 'succeeded');
    const verifierDone = verifierReaders.length > 0 && verifierReaders.every(q => q.state === 'succeeded');
    if (!authorDone || !verifierDone) return 'incomplete_coverage';
  }

  return 'active_coverage';
}

export function projectEvidenceReviewJob(
  input: EvidenceReviewProjectionInput,
  now: Date = new Date(),
): EvidenceReviewOperatorProjection {
  const quanta = listQuanta(input);
  const quantaById = new Map(quanta.map(q => [q.quantumId, q]));
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const authorReaders = quanta.filter(q => q.kind === 'author_reader');
  const verifierReaders = quanta.filter(q => q.kind === 'verifier_reader');
  const shardCount = resolveShardCount(input, quanta);
  const authorCoveredShards = authorReaders.filter(q => q.state === 'succeeded').length;
  const verifierCoveredShards = verifierReaders.filter(q => q.state === 'succeeded').length;
  const authorComplete = authorReaders.length > 0
    ? authorReaders.every(q => q.state === 'succeeded')
    : shardCount === 0;
  const verifierComplete = verifierReaders.length > 0
    ? verifierReaders.every(q => q.state === 'succeeded')
    : shardCount === 0;

  const leased = quanta.filter(q => q.state === 'leased');
  const retrying = quanta.filter(q => q.state === 'retry_wait');
  const failed = quanta.filter(q => q.state === 'terminal_failed');
  const succeeded = quanta.filter(q => q.state === 'succeeded');
  const pending = quanta.filter(q => q.state === 'pending');
  const runnable = quanta.filter(q => isQuantumRunnable(q, quantaById, nowMs));

  const obligationList = input.obligations ?? [];
  const dispositionList = input.obligationDispositions ?? [];
  const dispositionIds = new Set(dispositionList.map(d => d.obligationId));
  const unresolvedIds = obligationList
    .filter(o => !dispositionIds.has(o.obligationId))
    .map(o => o.obligationId);

  const operatorDisposition = classifyOperatorDisposition(input, now);
  const successorLink = input.successorJobId ?? input.supersededByJobId;
  const transitionLink = input.transitionId;

  const activeCoverage: ActiveCoverageProjection = {
    authorCoveredShards,
    verifierCoveredShards,
    shardCount,
    authorComplete,
    verifierComplete,
    complete: authorComplete && verifierComplete && shardCount > 0,
  };

  const leases: LeaseProjection = {
    count: leased.length,
    items: leased.map(q => ({
      quantumId: q.quantumId,
      kind: q.kind,
      leaseId: q.lease?.leaseId,
      ownerWakeId: q.lease?.ownerWakeId,
      expiresAt: q.lease?.expiresAt,
    })),
  };

  const retryWait: RetryWaitProjection = {
    count: retrying.length,
    totalAttempts: retrying.reduce((sum, q) => sum + (q.attempts ?? 0), 0),
    earliestNextRetryAt: earliestIso(retrying.map(q => q.nextRetryAt)),
    quantumIds: retrying.map(q => q.quantumId),
  };

  const semanticDefer: SemanticDeferProjection = {
    deferred: input.disposition === 'deferred' || operatorDisposition === 'semantic_defer',
    unresolvedObligations: unresolvedIds.length,
  };

  const supersession: SupersessionProjection = {
    superseded: input.disposition === 'superseded' || operatorDisposition === 'stale_basis_superseded',
    successorJobId: input.successorJobId,
    supersededByJobId: input.supersededByJobId,
    parentJobId: input.parentJobId,
  };

  const completion: CompletionProjection = {
    completed: input.disposition === 'completed' || operatorDisposition === 'completed',
    transitionId: input.transitionId,
  };

  const terminalIntegrityFailure: TerminalIntegrityFailureProjection = {
    failed: input.disposition === 'terminal_failed' || operatorDisposition === 'terminal_integrity_failure',
    reason: input.terminalReason,
    failedQuanta: failed.length,
    failedQuantumIds: failed.map(q => q.quantumId),
  };

  const nextDueWork: NextDueWorkProjection = {
    nextDueAt: earliestIso([
      input.nextDueAt,
      ...retrying.map(q => q.nextRetryAt),
      ...leased.map(q => q.lease?.expiresAt),
    ]),
    runnableQuanta: runnable.length,
    dueQuantumIds: runnable.map(q => q.quantumId),
  };

  const obligations: ObligationProjection = {
    total: obligationList.length,
    resolved: obligationList.length - unresolvedIds.length,
    unresolved: unresolvedIds.length,
    unresolvedIds,
  };

  const counts: QuantumCountProjection = {
    total: quanta.length,
    pending: pending.length,
    leased: leased.length,
    succeeded: succeeded.length,
    retryWait: retrying.length,
    terminalFailed: failed.length,
  };

  return {
    jobId: input.jobId,
    workClass: input.workClass,
    durableDisposition: input.disposition,
    operatorDisposition,
    summary: summarizeOperatorProjection(operatorDisposition, {
      jobId: input.jobId,
      activeCoverage,
      leases,
      retryWait,
      semanticDefer,
      supersession,
      completion,
      terminalIntegrityFailure,
      nextDueWork,
      obligations,
      successorLink,
      transitionLink,
    }),
    basisHash: resolveBasisHash(input),
    manifestHash: resolveManifestHash(input),
    activeCoverage,
    leases,
    retryWait,
    semanticDefer,
    supersession,
    completion,
    terminalIntegrityFailure,
    nextDueWork,
    obligations,
    successorLink,
    transitionLink,
    counts,
    stateCorrupt: input.stateCorrupt === true,
    projectedAt: nowIso,
  };
}

export function listOperatorProjections(
  jobs: readonly EvidenceReviewProjectionInput[],
  now: Date = new Date(),
): EvidenceReviewOperatorProjection[] {
  return [...jobs]
    .sort((a, b) => a.jobId.localeCompare(b.jobId, 'en'))
    .map(job => projectEvidenceReviewJob(job, now));
}

/**
 * Integrated call-site API: flat store diagnostics plus operator disposition.
 * Preserves EvidenceReviewDiagnostics field names used by existing consumers.
 */
export function buildOperatorView(job: EvidenceReviewJob, now = new Date()): EvidenceReviewOperatorView {
  const diagnostics = buildEvidenceReviewDiagnostics(job, now);
  const projection = projectEvidenceReviewJob(toProjectionInput(job), now);
  return {
    ...diagnostics,
    operatorDisposition: projection.operatorDisposition,
    summary: projection.summary,
  };
}

export function listOperatorViews(
  jobs: readonly EvidenceReviewJob[],
  now = new Date(),
): EvidenceReviewOperatorView[] {
  return [...jobs]
    .sort((a, b) => a.jobId.localeCompare(b.jobId, 'en'))
    .map(job => buildOperatorView(job, now));
}

function summarizeOperatorProjection(
  disposition: EvidenceReviewOperatorDisposition,
  ctx: {
    jobId: string;
    activeCoverage: ActiveCoverageProjection;
    leases: LeaseProjection;
    retryWait: RetryWaitProjection;
    semanticDefer: SemanticDeferProjection;
    supersession: SupersessionProjection;
    completion: CompletionProjection;
    terminalIntegrityFailure: TerminalIntegrityFailureProjection;
    nextDueWork: NextDueWorkProjection;
    obligations: ObligationProjection;
    successorLink?: string;
    transitionLink?: string;
  },
): string {
  const id = ctx.jobId;
  switch (disposition) {
    case 'completed':
      return `Job ${id} completed` + (ctx.transitionLink ? ` as ${ctx.transitionLink}` : '');
    case 'semantic_defer':
      return `Job ${id} deferred semantically` + (
        ctx.obligations.unresolved > 0
          ? ` with ${ctx.obligations.unresolved} unresolved obligation(s)`
          : ctx.semanticDefer.deferred
            ? '; obligations or verifier deferred'
            : ''
      );
    case 'stale_basis_superseded':
      return `Job ${id} superseded` + (ctx.successorLink ? ` by ${ctx.successorLink}` : '');
    case 'terminal_integrity_failure':
      return `Job ${id} terminal: ${ctx.terminalIntegrityFailure.reason ?? 'integrity failure'}`;
    case 'local_retry':
      return `Job ${id} has ${ctx.retryWait.count} quantum(s) in local provider retry`;
    case 'leased':
      return `Job ${id} has ${ctx.leases.count} leased quantum(s)`;
    case 'incomplete_coverage':
      return `Job ${id} coverage incomplete (author ${ctx.activeCoverage.authorCoveredShards}/${ctx.activeCoverage.shardCount}, verifier ${ctx.activeCoverage.verifierCoveredShards}/${ctx.activeCoverage.shardCount})`;
    case 'drain_settling':
      return `Job ${id} settling during graceful drain`;
    case 'corrupt_state':
      return `Job ${id} recovered from corrupt durable state`;
    default:
      return `Job ${id} active with ${ctx.nextDueWork.runnableQuanta} runnable quantum(s)`;
  }
}

// ---------------------------------------------------------------------------
// Release canaries (pure assertions for CI / release gates)
// ---------------------------------------------------------------------------

export interface DiagnosticsCanaryResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Assert that a projection exposes every operator-visible facet required by #110.
 */
export function assertProjectionFacets(
  projection: EvidenceReviewOperatorProjection,
): DiagnosticsCanaryResult[] {
  const requiredKeys: Array<keyof EvidenceReviewOperatorProjection> = [
    'activeCoverage',
    'leases',
    'retryWait',
    'semanticDefer',
    'supersession',
    'completion',
    'terminalIntegrityFailure',
    'nextDueWork',
    'obligations',
    'operatorDisposition',
    'summary',
  ];
  return requiredKeys.map(key => {
    const present = projection[key] !== undefined && projection[key] !== null;
    return {
      name: `facet:${String(key)}`,
      passed: present,
      detail: present ? 'present' : `missing operator facet ${String(key)}`,
    };
  });
}

/**
 * Canary: operator disposition must distinguish local retry from semantic defer
 * and supersession without consulting raw queue JSON.
 */
export function assertDispositionSeparation(
  projections: readonly EvidenceReviewOperatorProjection[],
): DiagnosticsCanaryResult[] {
  const byDisposition = new Map<string, number>();
  for (const p of projections) {
    byDisposition.set(p.operatorDisposition, (byDisposition.get(p.operatorDisposition) ?? 0) + 1);
  }
  const results: DiagnosticsCanaryResult[] = [];
  const retry = projections.find(p => p.operatorDisposition === 'local_retry');
  const defer = projections.find(p => p.operatorDisposition === 'semantic_defer');
  const superceded = projections.find(p => p.operatorDisposition === 'stale_basis_superseded');
  if (retry) {
    results.push({
      name: 'canary:retry_not_semantic',
      passed: retry.operatorDisposition !== 'semantic_defer' && retry.retryWait.count > 0,
      detail: `local_retry quanta=${retry.retryWait.count}`,
    });
  }
  if (defer) {
    results.push({
      name: 'canary:semantic_not_retry',
      passed: defer.semanticDefer.deferred === true && defer.operatorDisposition === 'semantic_defer',
      detail: `deferred unresolved=${defer.semanticDefer.unresolvedObligations}`,
    });
  }
  if (superceded) {
    results.push({
      name: 'canary:supersession_link',
      passed: Boolean(superceded.successorLink || superceded.supersession.successorJobId),
      detail: `successorLink=${superceded.successorLink ?? 'none'}`,
    });
  }
  results.push({
    name: 'canary:disposition_map_size',
    passed: byDisposition.size >= 1,
    detail: `dispositions=${[...byDisposition.keys()].join(',')}`,
  });
  return results;
}

/**
 * Normalize an engine or pure-graph job into projection input without copying
 * large opaque payloads (bundle/candidate stay out of the projection surface).
 */
export function toProjectionInput(job: {
  jobId: string;
  disposition: EvidenceReviewJobDispositionInput;
  workClass?: string;
  quanta?: Readonly<Record<string, ProjectionQuantum>> | readonly ProjectionQuantum[];
  obligations?: readonly ProjectionObligation[];
  obligationDispositions?: readonly ProjectionObligationDisposition[];
  nextDueAt?: string;
  successorJobId?: string;
  supersededByJobId?: string;
  parentJobId?: string;
  transitionId?: string;
  terminalReason?: string;
  basis?: { basisHash?: string; manifestHash?: string };
  manifest?: { manifestHash?: string; shardIds?: readonly string[] };
  stateCorrupt?: boolean;
}): EvidenceReviewProjectionInput {
  return {
    jobId: job.jobId,
    disposition: job.disposition,
    workClass: job.workClass,
    quanta: job.quanta,
    obligations: job.obligations,
    obligationDispositions: job.obligationDispositions,
    nextDueAt: job.nextDueAt,
    successorJobId: job.successorJobId,
    supersededByJobId: job.supersededByJobId,
    parentJobId: job.parentJobId,
    transitionId: job.transitionId,
    terminalReason: job.terminalReason,
    basis: job.basis,
    manifest: job.manifest,
    basisHash: job.basis?.basisHash,
    manifestHash: job.manifest?.manifestHash ?? job.basis?.manifestHash,
    shardCount: job.manifest?.shardIds?.length,
    stateCorrupt: job.stateCorrupt,
  };
}

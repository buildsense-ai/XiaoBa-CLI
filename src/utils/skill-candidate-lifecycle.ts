/**
 * Read-only lifecycle projection for Runtime Learning skill candidates.
 *
 * Evidence Review Jobs and Transition Audit entries remain the only durable
 * facts. This module intentionally owns no store and performs no mutation:
 * it gives heartbeat/reporting consumers a stable view without creating a
 * second retry, lease, or candidate-state authority.
 */

import type {
  EvidenceReviewJob,
  EvidenceReviewJobStoreState,
  ReviewQuantumRecord,
  ReviewWorkClass,
} from './evidence-review-types';
import type {
  CapabilityTransitionKind,
  TransitionAuditEntry,
} from './skill-evolution';

export const SKILL_CANDIDATE_LIFECYCLE_STAGES = [
  'admitted',
  'reviewing',
  'retry_wait',
  'deferred',
  'applied',
  'rejected',
  'superseded',
  'failed',
] as const;

export type SkillCandidateLifecycleStage =
  (typeof SKILL_CANDIDATE_LIFECYCLE_STAGES)[number];

export type SkillCandidateLifecycleStatus = 'healthy' | 'corrupt';

export type SkillCandidateLifecycleCorruptionReason =
  | 'evidence-review-job-store-corrupt'
  | 'evidence-review-job-store-missing'
  | 'transition-audit-unavailable'
  | 'heartbeat-projection-corrupt';

export interface SkillCandidateLifecycle {
  jobId: string;
  bundleId: string;
  workClass: ReviewWorkClass;
  stage: SkillCandidateLifecycleStage;
  createdAt: string;
  updatedAt: string;
  transitionId?: string;
  successorJobId?: string;
  nextRetryAt?: string;
}

/** A compact persisted heartbeat projection, deliberately without candidate content. */
export interface SkillCandidateLifecycleSummary {
  status: SkillCandidateLifecycleStatus;
  total: number;
  admitted: number;
  reviewing: number;
  retryWaiting: number;
  deferred: number;
  applied: number;
  rejected: number;
  superseded: number;
  failed: number;
  reason?: SkillCandidateLifecycleCorruptionReason;
}

export interface SkillCandidateLifecycleSnapshot {
  status: SkillCandidateLifecycleStatus;
  candidates: readonly SkillCandidateLifecycle[];
  summary: SkillCandidateLifecycleSummary;
}

interface TransitionAuditIndex {
  byTransitionId: ReadonlyMap<string, TransitionAuditEntry>;
  byCommitKey: ReadonlyMap<string, TransitionAuditEntry>;
}

const CAPABILITY_TRANSITIONS = new Set<CapabilityTransitionKind>([
  'create_current_skill',
  'append_evidence',
  'replace_current_skill',
  'migrate_skill_route',
  'merge_into_capability',
  'retire_capability',
  'restore_capability_revision',
  'defer',
  'reject_candidate',
]);

const MUTATING_TRANSITIONS = new Set<CapabilityTransitionKind>([
  'create_current_skill',
  'append_evidence',
  'replace_current_skill',
  'migrate_skill_route',
  'merge_into_capability',
  'retire_capability',
  'restore_capability_revision',
]);

export function emptySkillCandidateLifecycleSummary(): SkillCandidateLifecycleSummary {
  return {
    status: 'healthy',
    total: 0,
    admitted: 0,
    reviewing: 0,
    retryWaiting: 0,
    deferred: 0,
    applied: 0,
    rejected: 0,
    superseded: 0,
    failed: 0,
  };
}

export function corruptSkillCandidateLifecycleSnapshot(
  reason: SkillCandidateLifecycleCorruptionReason,
): SkillCandidateLifecycleSnapshot {
  const summary = emptySkillCandidateLifecycleSummary();
  summary.status = 'corrupt';
  summary.reason = reason;
  return {
    status: 'corrupt',
    candidates: [],
    summary,
  };
}

/**
 * Derive lifecycle state from the authoritative, durable job graph and audit.
 * It is pure by design so a reporting read can never advance, reclaim, or
 * otherwise alter a candidate.
 */
export function projectSkillCandidateLifecycle(
  store: EvidenceReviewJobStoreState,
  auditEntries: readonly TransitionAuditEntry[],
): SkillCandidateLifecycleSnapshot {
  if (store.stateCorrupt) {
    return corruptSkillCandidateLifecycleSnapshot('evidence-review-job-store-corrupt');
  }

  const auditIndex = indexTransitionAudit(auditEntries);

  const candidates = Object.values(store.jobs)
    .map(job => projectJobLifecycle(job, auditIndex))
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt, 'en')
      || left.jobId.localeCompare(right.jobId, 'en')
    ));

  return {
    status: 'healthy',
    candidates,
    summary: summarizeSkillCandidateLifecycle(candidates),
  };
}

export function isSkillCandidateLifecycleSummary(
  value: unknown,
): value is SkillCandidateLifecycleSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SkillCandidateLifecycleSummary>;
  const numericFields = [
    candidate.total,
    candidate.admitted,
    candidate.reviewing,
    candidate.retryWaiting,
    candidate.deferred,
    candidate.applied,
    candidate.rejected,
    candidate.superseded,
    candidate.failed,
  ];
  const validReason = candidate.reason === undefined
    || candidate.reason === 'evidence-review-job-store-corrupt'
    || candidate.reason === 'evidence-review-job-store-missing'
    || candidate.reason === 'transition-audit-unavailable'
    || candidate.reason === 'heartbeat-projection-corrupt';
  const validCounts = numericFields.every(
    value => typeof value === 'number' && Number.isInteger(value) && value >= 0,
  );
  if (!validCounts || !validReason) return false;
  const [total, ...stageCounts] = numericFields as number[];
  if (total !== stageCounts.reduce((sum, count) => sum + count, 0)) return false;
  if (candidate.status === 'healthy') return candidate.reason === undefined;
  if (candidate.status !== 'corrupt') return false;
  return candidate.reason !== undefined && numericFields.every(value => value === 0);
}

function summarizeSkillCandidateLifecycle(
  candidates: readonly SkillCandidateLifecycle[],
): SkillCandidateLifecycleSummary {
  const summary = emptySkillCandidateLifecycleSummary();
  summary.total = candidates.length;
  for (const candidate of candidates) {
    switch (candidate.stage) {
      case 'admitted': summary.admitted += 1; break;
      case 'reviewing': summary.reviewing += 1; break;
      case 'retry_wait': summary.retryWaiting += 1; break;
      case 'deferred': summary.deferred += 1; break;
      case 'applied': summary.applied += 1; break;
      case 'rejected': summary.rejected += 1; break;
      case 'superseded': summary.superseded += 1; break;
      case 'failed': summary.failed += 1; break;
    }
  }
  return summary;
}

function projectJobLifecycle(
  job: EvidenceReviewJob,
  auditIndex: TransitionAuditIndex,
): SkillCandidateLifecycle {
  const stage = lifecycleStageForJob(job, auditIndex);
  const retryAt = stage === 'retry_wait' ? nextRetryAt(job.quanta) : undefined;
  return {
    jobId: job.jobId,
    bundleId: job.bundle.bundleId,
    workClass: job.workClass,
    stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.transitionId ? { transitionId: job.transitionId } : {}),
    ...(job.successorJobId ? { successorJobId: job.successorJobId } : {}),
    ...(retryAt ? { nextRetryAt: retryAt } : {}),
  };
}

function lifecycleStageForJob(
  job: EvidenceReviewJob,
  auditIndex: TransitionAuditIndex,
): SkillCandidateLifecycleStage {
  switch (job.disposition) {
    case 'active':
      return lifecycleStageForActiveJob(job);
    case 'deferred':
      return 'deferred';
    case 'superseded':
      return 'superseded';
    case 'terminal_failed':
      return 'failed';
    case 'completed': {
      const completed = resolveCompletedTransition(job, auditIndex);
      if (completed.inconsistent || !completed.transition) return 'failed';
      if (completed.transition === 'defer') return 'deferred';
      if (completed.transition === 'reject_candidate') return 'rejected';
      return 'applied';
    }
  }
}

function lifecycleStageForActiveJob(job: EvidenceReviewJob): SkillCandidateLifecycleStage {
  const quanta = Object.values(job.quanta);
  if (quanta.some(quantum => quantum.state === 'retry_wait')) return 'retry_wait';
  // A local terminal failure does not make the graph terminal. This mirrors
  // deriveJobDisposition(): independent Reader/Author/Verifier paths may
  // still make the active Job reviewable, while a terminal commit closes it.
  const commit = quanta.find(quantum => quantum.kind === 'commit');
  if (commit?.state === 'terminal_failed') return 'failed';
  if (quanta.some(quantum => (
    quantum.state === 'leased'
    || quantum.state === 'succeeded'
    || quantum.attempts > 0
  ))) {
    return 'reviewing';
  }
  return 'admitted';
}

function nextRetryAt(quanta: Record<string, ReviewQuantumRecord>): string | undefined {
  return Object.values(quanta)
    .filter(quantum => quantum.state === 'retry_wait' && typeof quantum.nextRetryAt === 'string')
    .map(quantum => quantum.nextRetryAt!)
    .sort((left, right) => left.localeCompare(right, 'en'))[0];
}

function resolveCompletedTransition(
  job: EvidenceReviewJob,
  auditIndex: TransitionAuditIndex,
): { transition?: CapabilityTransitionKind; inconsistent: boolean } {
  const commit = Object.values(job.quanta).find(quantum => quantum.kind === 'commit');
  const result = asRecord(commit?.result);
  const resultAudit = asRecord(result?.audit);
  const resultTransition = asCapabilityTransition(result?.transition);
  const transitionIds = [
    job.transitionId,
    commit?.commitReceipt?.transitionId,
    asString(result?.transitionId),
    asString(resultAudit?.transitionId),
  ].filter((value): value is string => typeof value === 'string');
  const auditById = transitionIds
    .map(transitionId => auditIndex.byTransitionId.get(transitionId))
    .find((entry): entry is TransitionAuditEntry => entry !== undefined);
  const expectedCommitKey = commit?.commitIntent?.key
    ?? (commit ? `${job.jobId}:${commit.quantumId}` : undefined);
  const auditByCommitKey = expectedCommitKey
    ? auditIndex.byCommitKey.get(expectedCommitKey)
    : undefined;

  if (
    auditById
    && auditByCommitKey
    && auditById.transitionId !== auditByCommitKey.transitionId
  ) {
    return { inconsistent: true };
  }

  const audit = auditByCommitKey ?? auditById;
  if (
    audit
    && expectedCommitKey
    && audit.reviewCommitKey !== undefined
    && audit.reviewCommitKey !== expectedCommitKey
  ) {
    return { inconsistent: true };
  }
  if (resultTransition && audit && resultTransition !== audit.transition) {
    return { inconsistent: true };
  }

  const transition = resultTransition
    ?? audit?.transition
    ?? transitionFromVerifierDecision(job);
  if (!transition) return { inconsistent: false };
  if (MUTATING_TRANSITIONS.has(transition) && !audit) {
    // A completed mutation without its durable audit receipt is not proof that
    // the Skill was applied. Surface it as failed rather than guessing.
    return { inconsistent: true };
  }
  return { transition, inconsistent: false };
}

function transitionFromVerifierDecision(
  job: EvidenceReviewJob,
): CapabilityTransitionKind | undefined {
  if (job.verifierResult?.decision === 'defer') return 'defer';
  if (job.verifierResult?.decision === 'reject') return 'reject_candidate';
  return undefined;
}

function asCapabilityTransition(value: unknown): CapabilityTransitionKind | undefined {
  return typeof value === 'string' && CAPABILITY_TRANSITIONS.has(value as CapabilityTransitionKind)
    ? value as CapabilityTransitionKind
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function indexTransitionAudit(
  auditEntries: readonly TransitionAuditEntry[],
): TransitionAuditIndex {
  const byTransitionId = new Map<string, TransitionAuditEntry>();
  const byCommitKey = new Map<string, TransitionAuditEntry>();
  for (const entry of auditEntries) {
    byTransitionId.set(entry.transitionId, entry);
    if (entry.reviewCommitKey) byCommitKey.set(entry.reviewCommitKey, entry);
  }
  return { byTransitionId, byCommitKey };
}

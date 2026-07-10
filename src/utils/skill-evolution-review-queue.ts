import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CapabilityReadSetEntry, EvidenceBundle } from './skill-evolution';
import { DistilledKnowledgeCandidate } from './capability-distiller';

export const SKILL_EVOLUTION_REVIEW_QUEUE_SCHEMA_VERSION = 1 as const;

export type OperationalReviewFailureKind =
  | 'branch_timeout'
  | 'branch_failure'
  | 'invalid_completion_schema';

export interface SkillEvolutionOperationalReviewFailureEntry {
  /** Stable queue entry identity. */
  entryId: string;
  /** Candidate identity. */
  candidateCapabilityId: string;
  /** Evidence bundle identity. */
  bundleId: string;
  /** Retry snapshot for this candidate. */
  bundle: EvidenceBundle;
  /** Retry snapshot for this candidate. */
  candidate: DistilledKnowledgeCandidate;
  /** Why this entry is waiting on infrastructure retries. */
  failureKind: OperationalReviewFailureKind;
  /** Failure transcript for debugging. */
  failureMessage: string;
  /** Failure transcript paths preserved across restarts. */
  failureTranscripts: string[];
  /** Completed retry attempt count. */
  attempts: number;
  /** Active backoff value. */
  currentDelayMs: number;
  /** ISO timestamp when this entry should be retried. */
  nextRetryAt: string;
  /** Creation timestamp. */
  createdAt: string;
  /** Last update timestamp. */
  updatedAt: string;
}

export interface SkillEvolutionDeferredReviewEntry {
  /** Stable queue entry identity. */
  entryId: string;
  /** Candidate identity. */
  candidateCapabilityId: string;
  /** Evidence bundle identity. */
  bundleId: string;
  /** Latest deferred review snapshot. */
  bundle: EvidenceBundle;
  /** Latest deferred candidate snapshot. */
  candidate: DistilledKnowledgeCandidate;
  /** Declared relevant revisions captured at defer time. */
  relevantReadSet: CapabilityReadSetEntry[];
  /** Evidence fingerprint captured at defer time. */
  evidenceFingerprint: string;
  /** Runtime reviewer version for gating. */
  reviewerVersion: string;
  /** Whether an explicit retry command made this entry eligible. */
  explicitRetryRequested: boolean;
  /** Why this entry is still waiting for another cycle. */
  reason: string;
  /** Creation timestamp. */
  createdAt: string;
  /** Last update timestamp. */
  updatedAt: string;
}

export interface SkillEvolutionReviewQueueState {
  schemaVersion: typeof SKILL_EVOLUTION_REVIEW_QUEUE_SCHEMA_VERSION;
  /** Infrastructure failures with backoff, persisted across restarts. */
  operational: SkillEvolutionOperationalReviewFailureEntry[];
  /** Semantic defers gated by reviewer/revision/material evidence signals. */
  deferred: SkillEvolutionDeferredReviewEntry[];
  /** Set when the state file was corrupt and quarantined on load. */
  stateCorrupt?: boolean;
}

function emptyState(): SkillEvolutionReviewQueueState {
  return {
    schemaVersion: SKILL_EVOLUTION_REVIEW_QUEUE_SCHEMA_VERSION,
    operational: [],
    deferred: [],
  };
}

export function emptyReviewQueueState(): SkillEvolutionReviewQueueState {
  return emptyState();
}

export function loadReviewQueueState(filePath: string): SkillEvolutionReviewQueueState {
  if (!fs.existsSync(filePath)) {
    return emptyState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<SkillEvolutionReviewQueueState>;
    if (
      !parsed
      || parsed.schemaVersion !== SKILL_EVOLUTION_REVIEW_QUEUE_SCHEMA_VERSION
      || !Array.isArray(parsed.operational)
      || !Array.isArray(parsed.deferred)
    ) {
      throw new Error('invalid schema');
    }
    return {
      schemaVersion: SKILL_EVOLUTION_REVIEW_QUEUE_SCHEMA_VERSION,
      operational: sanitizeOperationalEntries(parsed.operational),
      deferred: sanitizeDeferredEntries(parsed.deferred),
    };
  } catch {
    quarantine(filePath, 'corrupt');
    return { ...emptyState(), stateCorrupt: true };
  }
}

export function saveReviewQueueState(filePath: string, state: SkillEvolutionReviewQueueState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        schemaVersion: SKILL_EVOLUTION_REVIEW_QUEUE_SCHEMA_VERSION,
        operational: state.operational,
        deferred: state.deferred,
      }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup only
    }
    throw error;
  }
}

export function computeReviewEvidenceFingerprint(bundle: EvidenceBundle): string {
  const refs = [...bundle.completionEvidence, ...bundle.settlementEvidence]
    .map(item => item.ref)
    .filter((ref): ref is string => typeof ref === 'string')
    .sort();
  const payload = JSON.stringify(refs);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function findOperationalByBundleId(
  state: SkillEvolutionReviewQueueState,
  bundleId: string,
): SkillEvolutionOperationalReviewFailureEntry | undefined {
  return state.operational.find(entry => entry.bundleId === bundleId);
}

export function findDeferByBundleId(
  state: SkillEvolutionReviewQueueState,
  bundleId: string,
): SkillEvolutionDeferredReviewEntry | undefined {
  return state.deferred.find(entry => entry.bundleId === bundleId);
}

export function addOrUpdateOperationalFailure(
  state: SkillEvolutionReviewQueueState,
  candidate: DistilledKnowledgeCandidate,
  bundle: EvidenceBundle,
  failureKind: OperationalReviewFailureKind,
  failureMessage: string,
  failureTranscriptPath: string | undefined,
  baseRetryMs: number,
  maxRetryMs: number,
  now: Date,
): SkillEvolutionOperationalReviewFailureEntry {
  const existing = findOperationalByBundleId(state, bundle.bundleId);
  const previousDelay = existing?.currentDelayMs ?? Math.max(1, baseRetryMs);
  const nextDelay = existing
    ? Math.min(maxRetryMs, Math.max(baseRetryMs, previousDelay * 2))
    : Math.max(1, baseRetryMs);
  const nextRetryAt = new Date(now.getTime() + nextDelay);
  const attempt = (existing?.attempts ?? 0) + 1;
  const entry: SkillEvolutionOperationalReviewFailureEntry = {
    entryId: existing?.entryId ?? `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    candidateCapabilityId: candidate.capabilityId,
    bundleId: bundle.bundleId,
    bundle,
    candidate,
    failureKind,
    failureMessage,
    failureTranscripts: [
      ...(existing?.failureTranscripts ?? []),
      ...(failureTranscriptPath ? [failureTranscriptPath] : []),
    ],
    attempts: attempt,
    currentDelayMs: nextDelay,
    nextRetryAt: nextRetryAt.toISOString(),
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (existing) {
    state.operational = state.operational.map(item => item.entryId === existing.entryId ? entry : item);
  } else {
    state.operational.push(entry);
  }
  return entry;
}

export function removeOperationalFailure(
  state: SkillEvolutionReviewQueueState,
  entryId: string,
): void {
  state.operational = state.operational.filter(entry => entry.entryId !== entryId);
}

export function removeOperationalFailureByBundleId(
  state: SkillEvolutionReviewQueueState,
  bundleId: string,
): void {
  state.operational = state.operational.filter(entry => entry.bundleId !== bundleId);
}

export function popDueOperationalEntries(
  state: SkillEvolutionReviewQueueState,
  now: Date,
  limit?: number,
): SkillEvolutionOperationalReviewFailureEntry[] {
  const nowMs = now.getTime();
  const due = state.operational
    .filter(entry => new Date(entry.nextRetryAt).getTime() <= nowMs)
    .sort((left, right) => left.nextRetryAt.localeCompare(right.nextRetryAt, 'en'));
  return typeof limit === 'number' && limit > 0 ? due.slice(0, limit) : due;
}

export function upsertDeferredEntry(
  state: SkillEvolutionReviewQueueState,
  candidate: DistilledKnowledgeCandidate,
  bundle: EvidenceBundle,
  reviewerVersion: string,
  relevantReadSet: CapabilityReadSetEntry[],
  reason: string,
  now: Date,
): SkillEvolutionDeferredReviewEntry {
  const existing = findDeferByBundleId(state, bundle.bundleId);
  const entry: SkillEvolutionDeferredReviewEntry = {
    entryId: existing?.entryId ?? `defer_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    candidateCapabilityId: candidate.capabilityId,
    bundleId: bundle.bundleId,
    bundle,
    candidate,
    relevantReadSet,
    evidenceFingerprint: computeReviewEvidenceFingerprint(bundle),
    reviewerVersion,
    explicitRetryRequested: false,
    reason,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (existing) {
    state.deferred = state.deferred.map(item => item.entryId === existing.entryId ? entry : item);
  } else {
    state.deferred.push(entry);
  }
  return entry;
}

export function removeDeferredEntry(
  state: SkillEvolutionReviewQueueState,
  entryId: string,
): void {
  state.deferred = state.deferred.filter(entry => entry.entryId !== entryId);
}

export function markDeferredEntryExplicitRetry(
  state: SkillEvolutionReviewQueueState,
  entryId: string,
): void {
  state.deferred = state.deferred.map(entry => {
    if (entry.entryId !== entryId) return entry;
    return {
      ...entry,
      explicitRetryRequested: true,
      reason: 'Explicit runtime retry request.',
      updatedAt: new Date().toISOString(),
    };
  });
}

export function removeDeferredByBundleId(
  state: SkillEvolutionReviewQueueState,
  bundleId: string,
): void {
  state.deferred = state.deferred.filter(entry => entry.bundleId !== bundleId);
}

export function removeDeferredEntryByBundleId(
  state: SkillEvolutionReviewQueueState,
  bundleId: string,
): void {
  state.deferred = state.deferred.filter(entry => entry.bundleId !== bundleId);
}

export function isDeferredEntryEligible(
  entry: SkillEvolutionDeferredReviewEntry,
  reviewerVersion: string,
  candidateBundle?: EvidenceBundle,
  currentReadSet: CapabilityReadSetEntry[] = [],
): boolean {
  if (entry.explicitRetryRequested) return true;
  if (entry.reviewerVersion !== reviewerVersion) return true;
  const registryChanged = entry.relevantReadSet.some(handle => {
    const current = currentReadSet.find(item => item.handle === handle.handle);
    return !current || current.revision !== handle.revision;
  });
  if (registryChanged) return true;
  if (!candidateBundle) return false;
  const currentFingerprint = computeReviewEvidenceFingerprint(candidateBundle);
  return currentFingerprint !== entry.evidenceFingerprint;
}

export function getDueDeferredEntries(
  state: SkillEvolutionReviewQueueState,
  reviewerVersion: string,
  currentReadSet: CapabilityReadSetEntry[] = [],
): SkillEvolutionDeferredReviewEntry[] {
  return state.deferred.filter(entry => isDeferredEntryEligible(
    entry,
    reviewerVersion,
    entry.bundle,
    currentReadSet,
  ));
}

export function upsertOperationalFailureTranscript(
  state: SkillEvolutionReviewQueueState,
  bundleId: string,
  failureTranscriptPath: string | undefined,
): void {
  const entry = state.operational.find(item => item.bundleId === bundleId);
  if (!entry || !failureTranscriptPath) return;
  entry.failureTranscripts = uniqueStrings([...entry.failureTranscripts, failureTranscriptPath]);
  entry.updatedAt = new Date().toISOString();
}

function sanitizeOperationalEntries(
  entries: unknown[],
): SkillEvolutionOperationalReviewFailureEntry[] {
  return entries.filter(isOperationalEntry).map(normalizeOperationalEntry);
}

function sanitizeDeferredEntries(
  entries: unknown[],
): SkillEvolutionDeferredReviewEntry[] {
  return entries.filter(isDeferredEntry).map(normalizeDeferredEntry);
}

function isOperationalEntry(value: unknown): value is SkillEvolutionOperationalReviewFailureEntry {
  return !!value && typeof value === 'object'
    && typeof (value as SkillEvolutionOperationalReviewFailureEntry).entryId === 'string'
    && typeof (value as SkillEvolutionOperationalReviewFailureEntry).candidateCapabilityId === 'string'
    && typeof (value as SkillEvolutionOperationalReviewFailureEntry).bundleId === 'string';
}

function isDeferredEntry(value: unknown): value is SkillEvolutionDeferredReviewEntry {
  return !!value && typeof value === 'object'
    && typeof (value as SkillEvolutionDeferredReviewEntry).entryId === 'string'
    && typeof (value as SkillEvolutionDeferredReviewEntry).candidateCapabilityId === 'string'
    && typeof (value as SkillEvolutionDeferredReviewEntry).bundleId === 'string';
}

function normalizeOperationalEntry(
  entry: SkillEvolutionOperationalReviewFailureEntry,
): SkillEvolutionOperationalReviewFailureEntry {
  return {
    ...entry,
    attempts: Number.isInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0,
    currentDelayMs: Number.isFinite(entry.currentDelayMs) && entry.currentDelayMs > 0 ? entry.currentDelayMs : 1,
    failureTranscripts: Array.isArray(entry.failureTranscripts) ? entry.failureTranscripts : [],
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function normalizeDeferredEntry(
  entry: SkillEvolutionDeferredReviewEntry,
): SkillEvolutionDeferredReviewEntry {
  return {
    ...entry,
    reason: typeof entry.reason === 'string' ? entry.reason : 'Awaiting material evidence or registry change.',
    explicitRetryRequested: Boolean(entry.explicitRetryRequested),
    relevantReadSet: Array.isArray(entry.relevantReadSet) ? entry.relevantReadSet : [],
  };
}

function quarantine(filePath: string, suffix: string): void {
  try {
    fs.renameSync(filePath, `${filePath}.${suffix}.${Date.now()}`);
  } catch {
    // best-effort
  }
}

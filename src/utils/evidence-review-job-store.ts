/**
 * Durable store for engine-facing Evidence Review Jobs.
 * Reuses pure graph-store patterns (#107) with engine job payloads.
 *
 * After the Round 9 consolidation this module is the single durable owner of
 * review retry/defer state. Legacy `review-queue.json` entries are imported via
 * {@link importLegacyReviewQueue} and the legacy module is deleted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { CapabilityReadSetEntry, EvidenceBundle } from './skill-evolution';
import type { DistilledKnowledgeCandidate } from './capability-distiller';
import {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  type EvidenceReviewJob,
  type EvidenceReviewJobStoreState,
  type ReviewWorkClass,
} from './evidence-review-types';
import { createEvidenceReviewJob } from './evidence-review-graph';

const WORK_CLASS_ORDER: readonly ReviewWorkClass[] = [
  'operational_recovery',
  'live_learning',
  'historical_learning',
  'semantic_reassessment',
];

function emptyState(): EvidenceReviewJobStoreState {
  return {
    schemaVersion: EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
    jobs: {},
    fairness: {
      nextWorkClass: 'operational_recovery',
      classCursors: {},
      jobCursors: {},
    },
  };
}

function corruptionMarkerPath(filePath: string): string {
  return `${filePath}.state-corrupt`;
}

function latchCorruption(filePath: string, reason: string): string {
  const markerPath = corruptionMarkerPath(filePath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(
      markerPath,
      `${new Date().toISOString()} ${reason}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  }
  return markerPath;
}

function quarantine(filePath: string, reason: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(filePath, `${filePath}.corrupt.${reason}.${stamp}`);
  } catch {
    // best effort
  }
}

function isJob(value: unknown): value is EvidenceReviewJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<EvidenceReviewJob>;
  return (
    job.schemaVersion === EVIDENCE_REVIEW_JOB_SCHEMA_VERSION
    && typeof job.jobId === 'string'
    && typeof job.disposition === 'string'
    && job.manifest !== undefined
    && job.basis !== undefined
    && job.quanta !== undefined
  );
}

export function loadEvidenceReviewJobStore(filePath: string): EvidenceReviewJobStoreState {
  if (fs.existsSync(corruptionMarkerPath(filePath))) {
    return { ...emptyState(), stateCorrupt: true };
  }
  if (!fs.existsSync(filePath)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<EvidenceReviewJobStoreState>;
    if (
      !parsed
      || parsed.schemaVersion !== EVIDENCE_REVIEW_JOB_SCHEMA_VERSION
      || !parsed.jobs
      || typeof parsed.jobs !== 'object'
    ) {
      throw new Error('invalid schema');
    }
    const jobs: Record<string, EvidenceReviewJob> = {};
    for (const [jobId, job] of Object.entries(parsed.jobs)) {
      if (!isJob(job) || job.jobId !== jobId) throw new Error('invalid job');
      jobs[jobId] = job;
    }
    const nextWorkClass = WORK_CLASS_ORDER.includes(parsed.fairness?.nextWorkClass as ReviewWorkClass)
      ? (parsed.fairness!.nextWorkClass as ReviewWorkClass)
      : 'operational_recovery';
    return {
      schemaVersion: EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
      jobs,
      fairness: {
        nextWorkClass,
        classCursors: { ...(parsed.fairness?.classCursors ?? {}) },
        jobCursors: { ...(parsed.fairness?.jobCursors ?? {}) },
      },
      ...(parsed.migrations ? { migrations: parsed.migrations } : {}),
    };
  } catch {
    latchCorruption(filePath, 'invalid Evidence Review Job store');
    quarantine(filePath, 'invalid');
    return { ...emptyState(), stateCorrupt: true };
  }
}

export function saveEvidenceReviewJobStore(
  filePath: string,
  state: EvidenceReviewJobStoreState,
): void {
  if (state.stateCorrupt || fs.existsSync(corruptionMarkerPath(filePath))) {
    throw new Error(
      `Cannot save Evidence Review Job store while corruption is latched: ${filePath}`,
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        schemaVersion: EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
        jobs: state.jobs,
        fairness: state.fairness,
        ...(state.migrations ? { migrations: state.migrations } : {}),
      }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

export function upsertEvidenceReviewJob(
  state: EvidenceReviewJobStoreState,
  job: EvidenceReviewJob,
): void {
  state.jobs[job.jobId] = job;
}

export function evidenceReviewJobStorePathForReviewQueue(reviewQueuePath: string): string {
  return path.join(path.dirname(reviewQueuePath), 'evidence-review-jobs.json');
}

/** Find a deferred job for the given bundle ID. */
export function findDeferredJobByBundleId(
  state: EvidenceReviewJobStoreState,
  bundleId: string,
): EvidenceReviewJob | undefined {
  return Object.values(state.jobs).find(
    job => job.bundle.bundleId === bundleId && job.disposition === 'deferred',
  );
}

/** Find an active operational-recovery job for the given bundle ID. */
export function findOperationalJobByBundleId(
  state: EvidenceReviewJobStoreState,
  bundleId: string,
): EvidenceReviewJob | undefined {
  return Object.values(state.jobs).find(
    job => job.bundle.bundleId === bundleId
      && job.disposition === 'active'
      && job.workClass === 'operational_recovery',
  );
}

// ---------------------------------------------------------------------------
// One-time legacy queue migration
// ---------------------------------------------------------------------------

/** Path for the migration receipt written after successful import. */
function legacyMigrationReceiptPath(reviewQueuePath: string): string {
  return `${reviewQueuePath}.migrated`;
}

/** Minimal legacy schema types for the one-time importer. */
interface LegacyOperationalEntry {
  entryId: string;
  candidateCapabilityId: string;
  bundleId: string;
  bundle: EvidenceBundle;
  candidate: DistilledKnowledgeCandidate;
  failureKind: string;
  failureMessage: string;
  failureTranscripts: string[];
  attempts: number;
  currentDelayMs: number;
  nextRetryAt: string;
  createdAt: string;
  updatedAt: string;
}

interface LegacyDeferredEntry {
  entryId: string;
  candidateCapabilityId: string;
  bundleId: string;
  bundle: EvidenceBundle;
  candidate: DistilledKnowledgeCandidate;
  relevantReadSet: CapabilityReadSetEntry[];
  evidenceFingerprint: string;
  reviewerVersion: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

interface LegacyReviewQueueState {
  schemaVersion: 1;
  operational: LegacyOperationalEntry[];
  deferred: LegacyDeferredEntry[];
}

export type LegacyReviewQueueImportResult =
  | { status: 'absent'; imported: 0; skipped: 0 }
  | { status: 'migrated'; imported: number; skipped: number; archivePath: string }
  | { status: 'quarantined'; imported: 0; skipped: 0; quarantinePath: string };

function isLegacyQueue(value: unknown): value is LegacyReviewQueueState {
  if (!value || typeof value !== 'object') return false;
  const queue = value as Partial<LegacyReviewQueueState>;
  return queue.schemaVersion === 1
    && Array.isArray(queue.operational)
    && Array.isArray(queue.deferred)
    && queue.operational.every(entry => !!entry && typeof entry === 'object'
      && typeof entry.bundleId === 'string' && !!entry.bundle && !!entry.candidate
      && typeof entry.nextRetryAt === 'string' && Number.isFinite(entry.attempts)
      && Number.isFinite(entry.currentDelayMs)
      && (entry.failureKind === 'branch_timeout'
        || entry.failureKind === 'branch_failure'
        || entry.failureKind === 'invalid_completion_schema'))
    && queue.deferred.every(entry => !!entry && typeof entry === 'object'
      && typeof entry.bundleId === 'string' && !!entry.bundle && !!entry.candidate
      && Array.isArray(entry.relevantReadSet) && typeof entry.reviewerVersion === 'string'
      && typeof entry.evidenceFingerprint === 'string');
}

function quarantineLegacyQueue(filePath: string): string {
  latchCorruption(filePath, 'invalid legacy review queue');
  const quarantinePath = `${filePath}.corrupt.${Date.now()}`;
  fs.renameSync(filePath, quarantinePath);
  return quarantinePath;
}

function archiveLegacyQueue(filePath: string, sourceHash: string): string {
  const receiptPath = legacyMigrationReceiptPath(filePath);
  const archivePath = fs.existsSync(receiptPath)
    ? `${receiptPath}.${sourceHash.slice(0, 12)}.${Date.now()}`
    : receiptPath;
  fs.renameSync(filePath, archivePath);
  return archivePath;
}

function firstRootQuantum(job: EvidenceReviewJob) {
  return Object.values(job.quanta)
    .filter(quantum => quantum.dependencyQuantumIds.length === 0)
    .sort((left, right) => left.quantumId.localeCompare(right.quantumId, 'en'))[0];
}

/**
 * One-time importer that translates legacy `review-queue.json` entries into
 * durable Evidence Review Jobs. After successful import the legacy file is
 * renamed to `review-queue.json.migrated` so re-running is a no-op.
 *
 * Crash safety:
 * - Jobs are persisted before the legacy file is renamed.
 * - Re-running after a crash before the rename sees the durable receipt and
 *   only archives the source; existing dual-written Jobs are hydrated in place.
 * - Re-running after the rename: the legacy file is gone, so it is a no-op.
 * - The legacy file is never deleted before translated jobs are durable.
 */
export function importLegacyReviewQueue(
  reviewQueuePath: string,
  jobStorePath: string,
): LegacyReviewQueueImportResult {
  const legacyCorruptionMarker = corruptionMarkerPath(reviewQueuePath);
  if (fs.existsSync(legacyCorruptionMarker)) {
    return {
      status: 'quarantined',
      imported: 0,
      skipped: 0,
      quarantinePath: legacyCorruptionMarker,
    };
  }
  if (!fs.existsSync(reviewQueuePath)) {
    return { status: 'absent', imported: 0, skipped: 0 };
  }

  const raw = fs.readFileSync(reviewQueuePath, 'utf-8');
  const sourceHash = crypto.createHash('sha256').update(raw).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const quarantinePath = quarantineLegacyQueue(reviewQueuePath);
    return { status: 'quarantined', imported: 0, skipped: 0, quarantinePath };
  }
  if (!isLegacyQueue(parsed)) {
    const quarantinePath = quarantineLegacyQueue(reviewQueuePath);
    return { status: 'quarantined', imported: 0, skipped: 0, quarantinePath };
  }
  const legacy = parsed;

  const state = loadEvidenceReviewJobStore(jobStorePath);
  if (state.stateCorrupt) {
    throw new Error(
      `Cannot migrate legacy review queue because the Evidence Review Job store was corrupt: ${jobStorePath}`,
    );
  }
  if (state.migrations?.legacyReviewQueueV1?.sourceHash === sourceHash) {
    const archivePath = archiveLegacyQueue(reviewQueuePath, sourceHash);
    return { status: 'migrated', imported: 0, skipped: 0, archivePath };
  }
  let imported = 0;
  let skipped = 0;
  // Released builds wrote both stores. When a non-terminal Job already owns a
  // bundle, merge the queue-only retry/defer metadata into that Job instead of
  // creating duplicate work or silently discarding the old eligibility basis.
  const findOwner = (bundleId: string): EvidenceReviewJob | undefined => Object.values(state.jobs)
    .find(job => job.bundle.bundleId === bundleId
      && (job.disposition === 'active' || job.disposition === 'deferred'));

  // Import operational failures as operational_recovery jobs.
  for (const entry of legacy.operational) {
    const owner = findOwner(entry.bundleId);
    if (owner) {
      const retryQuantum = owner.disposition === 'active'
        ? Object.values(owner.quanta).find(quantum => quantum.state === 'retry_wait')
        : undefined;
      if (!retryQuantum) {
        skipped++;
        continue;
      }
      const legacyAttempts = Math.max(0, Math.floor(entry.attempts));
      if (legacyAttempts >= retryQuantum.attempts) {
        retryQuantum.attempts = legacyAttempts;
        retryQuantum.currentDelayMs = Math.max(1, entry.currentDelayMs);
        retryQuantum.nextRetryAt = entry.nextRetryAt;
        retryQuantum.failureMessage = entry.failureMessage;
        retryQuantum.updatedAt = entry.updatedAt;
      }
      retryQuantum.failureKind = entry.failureKind as typeof retryQuantum.failureKind;
      retryQuantum.transcriptPaths = [...new Set([
        ...retryQuantum.transcriptPaths,
        ...(entry.failureTranscripts ?? []),
      ])];
      owner.workClass = 'operational_recovery';
      owner.nextDueAt = retryQuantum.nextRetryAt;
      upsertEvidenceReviewJob(state, owner);
      imported++;
      continue;
    }
    const job = createEvidenceReviewJob({
      bundle: entry.bundle,
      candidate: entry.candidate,
      workClass: 'operational_recovery',
      now: new Date(entry.createdAt),
      jobId: `legacy-review:${crypto.createHash('sha256').update(`operational:${entry.entryId}`).digest('hex').slice(0, 24)}`,
    });
    const retryQuantum = firstRootQuantum(job);
    if (!retryQuantum) throw new Error(`Legacy review entry ${entry.entryId} produced no runnable quantum.`);
    retryQuantum.state = 'retry_wait';
    retryQuantum.attempts = Math.max(0, Math.floor(entry.attempts));
    retryQuantum.currentDelayMs = Math.max(1, entry.currentDelayMs);
    retryQuantum.nextRetryAt = entry.nextRetryAt;
    retryQuantum.failureMessage = entry.failureMessage;
    retryQuantum.failureKind = entry.failureKind as typeof retryQuantum.failureKind;
    retryQuantum.transcriptPaths = [...new Set(entry.failureTranscripts ?? [])];
    retryQuantum.updatedAt = entry.updatedAt;
    job.nextDueAt = entry.nextRetryAt;
    job.updatedAt = entry.updatedAt;
    upsertEvidenceReviewJob(state, job);
    imported++;
  }

  // Import deferred entries as semantic_reassessment jobs with deferState.
  for (const entry of legacy.deferred) {
    const owner = findOwner(entry.bundleId);
    if (owner) {
      if (owner.disposition !== 'deferred') {
        skipped++;
        continue;
      }
      owner.workClass = 'semantic_reassessment';
      owner.deferState = {
        reviewerVersion: owner.deferState?.reviewerVersion ?? entry.reviewerVersion,
        reason: owner.deferState?.reason ?? entry.reason,
        deferredAt: owner.deferState?.deferredAt ?? entry.updatedAt,
        registryReadSet: owner.deferState?.registryReadSet ?? entry.relevantReadSet,
        evidenceFingerprint: owner.deferState?.evidenceFingerprint ?? entry.evidenceFingerprint,
      };
      upsertEvidenceReviewJob(state, owner);
      imported++;
      continue;
    }
    const job = createEvidenceReviewJob({
      bundle: entry.bundle,
      candidate: entry.candidate,
      workClass: 'semantic_reassessment',
      registryReadSet: entry.relevantReadSet,
      now: new Date(entry.createdAt),
      jobId: `legacy-review:${crypto.createHash('sha256').update(`deferred:${entry.entryId}`).digest('hex').slice(0, 24)}`,
    });
    const migratedJob: EvidenceReviewJob = {
      ...job,
      disposition: 'deferred',
      workClass: 'semantic_reassessment',
      deferState: {
        reviewerVersion: entry.reviewerVersion,
        reason: entry.reason,
        deferredAt: entry.updatedAt,
        registryReadSet: entry.relevantReadSet,
        evidenceFingerprint: entry.evidenceFingerprint,
      },
      updatedAt: entry.updatedAt,
    };
    upsertEvidenceReviewJob(state, migratedJob);
    imported++;
  }

  state.migrations = {
    ...state.migrations,
    legacyReviewQueueV1: { sourceHash, importedAt: new Date().toISOString() },
  };
  // Jobs and the receipt share one atomic store write. The source is archived
  // only after that write, so a crash can never erase the sole durable copy.
  saveEvidenceReviewJobStore(jobStorePath, state);
  const archivePath = archiveLegacyQueue(reviewQueuePath, sourceHash);
  return { status: 'migrated', imported, skipped, archivePath };
}

export { WORK_CLASS_ORDER };

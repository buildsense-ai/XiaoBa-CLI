/**
 * Durable store for Evidence Review Jobs (ADR 0045 / #107).
 *
 * Follows established atomic JSON patterns (temp file + rename, corrupt
 * quarantine + fail-closed empty state). Fairness cursors are persisted as
 * opaque slots for later scheduler work (#108).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  type EvidenceReviewJob,
  type EvidenceReviewJobStoreState,
  type ReviewWorkClass,
} from './evidence-review-graph-types';
import { recoverJobAfterRestart } from './evidence-review-graph';

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

export function emptyEvidenceReviewJobStoreState(): EvidenceReviewJobStoreState {
  return emptyState();
}

function quarantineCorruptState(filePath: string, reason: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = `${filePath}.corrupt.${reason}.${stamp}`;
    fs.renameSync(filePath, dest);
  } catch {
    // Best-effort quarantine only.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJob(value: unknown): value is EvidenceReviewJob {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === EVIDENCE_REVIEW_JOB_SCHEMA_VERSION
    && typeof value.jobId === 'string'
    && typeof value.disposition === 'string'
    && isRecord(value.basis)
    && typeof value.basis.basisHash === 'string'
    && isRecord(value.quanta)
  );
}

/**
 * Load durable job store. Missing file → empty. Corrupt / invalid schema →
 * quarantine original and return empty state with `stateCorrupt: true`
 * (fail-closed; never invent partial jobs).
 */
export function loadEvidenceReviewJobStore(filePath: string): EvidenceReviewJobStoreState {
  if (!fs.existsSync(filePath)) return emptyState();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EvidenceReviewJobStoreState>;
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== EVIDENCE_REVIEW_JOB_SCHEMA_VERSION
      || !isRecord(parsed.jobs)
    ) {
      throw new Error('Evidence Review Job store has an invalid structure.');
    }

    const jobs: Record<string, EvidenceReviewJob> = {};
    for (const [jobId, job] of Object.entries(parsed.jobs)) {
      if (isJob(job)) jobs[jobId] = job;
    }

    const nextWorkClass = WORK_CLASS_ORDER.includes(
      parsed.fairness?.nextWorkClass as ReviewWorkClass,
    )
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
    };
  } catch {
    quarantineCorruptState(filePath, 'invalid');
    return { ...emptyState(), stateCorrupt: true };
  }
}

/**
 * Atomically persist the job store (temp file + rename).
 * Does not write `stateCorrupt` into durable payload.
 */
export function saveEvidenceReviewJobStore(
  filePath: string,
  state: EvidenceReviewJobStoreState,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    schemaVersion: EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
    jobs: state.jobs,
    fairness: {
      nextWorkClass: state.fairness?.nextWorkClass ?? 'operational_recovery',
      classCursors: state.fairness?.classCursors ?? {},
      jobCursors: state.fairness?.jobCursors ?? {},
    },
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original error.
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

export function getEvidenceReviewJob(
  state: EvidenceReviewJobStoreState,
  jobId: string,
): EvidenceReviewJob | undefined {
  return state.jobs[jobId];
}

export function listActiveEvidenceReviewJobs(
  state: EvidenceReviewJobStoreState,
): EvidenceReviewJob[] {
  return Object.values(state.jobs)
    .filter(job => job.disposition === 'active' || job.disposition === 'deferred')
    .sort((a, b) => a.jobId.localeCompare(b.jobId, 'en'));
}

/**
 * Load store and reconstruct every active job after process restart:
 * reclaim expired leases and re-derive disposition from node state.
 */
export function loadAndRecoverEvidenceReviewJobStore(
  filePath: string,
  now: Date = new Date(),
): EvidenceReviewJobStoreState {
  const state = loadEvidenceReviewJobStore(filePath);
  if (state.stateCorrupt) return state;
  for (const job of Object.values(state.jobs)) {
    if (job.disposition === 'active') {
      recoverJobAfterRestart(job, now);
    }
  }
  return state;
}

/** Conventional path next to the existing review queue file. */
export function evidenceReviewJobStorePathForReviewQueue(reviewQueuePath: string): string {
  return path.join(path.dirname(reviewQueuePath), 'evidence-review-jobs.json');
}

export { WORK_CLASS_ORDER };

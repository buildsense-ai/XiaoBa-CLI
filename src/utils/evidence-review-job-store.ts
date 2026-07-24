/**
 * Durable store for engine-facing Evidence Review Jobs.
 * Reuses pure graph-store patterns (#107) with engine job payloads.
 *
 * After the Round 9 consolidation this module is the single durable owner of
 * review retry/defer state.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  type EvidenceReviewJob,
  type EvidenceReviewJobStoreState,
  type ReviewWorkClass,
} from './evidence-review-types';

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

export { WORK_CLASS_ORDER };

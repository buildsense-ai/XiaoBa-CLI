/**
 * Durable store for engine-facing Evidence Review Jobs.
 * Reuses pure graph-store patterns (#107) with engine job payloads.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  type EvidenceReviewDiagnostics,
  type EvidenceReviewJob,
  type EvidenceReviewJobDisposition,
  type EvidenceReviewJobStoreState,
  type ReviewQuantumRecord,
  type ReviewWorkClass,
} from './evidence-review-types';
import {
  criticalPathRank,
  deriveJobDisposition as deriveGraphDisposition,
  isQuantumRunnable as isGraphQuantumRunnable,
  listRunnableQuanta as listGraphRunnableQuanta,
} from './evidence-review-graph-core';
import { WORK_CLASS_ORDER } from './evidence-review-graph-store';

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
      if (isJob(job)) jobs[jobId] = job;
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
    quarantine(filePath, 'invalid');
    return { ...emptyState(), stateCorrupt: true };
  }
}

export function saveEvidenceReviewJobStore(
  filePath: string,
  state: EvidenceReviewJobStoreState,
): void {
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

export function listJobsByBundleId(
  state: EvidenceReviewJobStoreState,
  bundleId: string,
): EvidenceReviewJob[] {
  return Object.values(state.jobs)
    .filter(job => job.bundle.bundleId === bundleId)
    .sort((a, b) => a.jobId.localeCompare(b.jobId, 'en'));
}

export function quantumSucceeded(quantum: ReviewQuantumRecord): boolean {
  return quantum.state === 'succeeded';
}

export function isQuantumRunnable(
  job: EvidenceReviewJob,
  quantum: ReviewQuantumRecord,
  now: Date,
): boolean {
  return isGraphQuantumRunnable(job as any, quantum, now);
}

export function listRunnableQuanta(
  job: EvidenceReviewJob,
  now: Date,
): ReviewQuantumRecord[] {
  return listGraphRunnableQuanta(job as any, now);
}

export { criticalPathRank };

export function deriveJobDisposition(job: EvidenceReviewJob): EvidenceReviewJobDisposition {
  return deriveGraphDisposition(job as any);
}

export function buildEvidenceReviewDiagnostics(
  job: EvidenceReviewJob,
  now = new Date(),
): EvidenceReviewDiagnostics {
  const quanta = Object.values(job.quanta);
  const authorReaders = quanta.filter(q => q.kind === 'author_reader');
  const verifierReaders = quanta.filter(q => q.kind === 'verifier_reader');
  const runnable = listRunnableQuanta(job, now);
  const unresolved = (job.obligations ?? []).filter(obligation => (
    !(job.obligationDispositions ?? []).some(d => d.obligationId === obligation.obligationId)
  )).length;
  return {
    jobId: job.jobId,
    disposition: job.disposition,
    workClass: job.workClass,
    basisHash: job.basis.basisHash,
    manifestHash: job.manifest.manifestHash,
    shardCount: job.manifest.shardIds.length,
    authorCoveredShards: authorReaders.filter(q => q.state === 'succeeded').length,
    verifierCoveredShards: verifierReaders.filter(q => q.state === 'succeeded').length,
    runnableQuanta: runnable.length,
    leasedQuanta: quanta.filter(q => q.state === 'leased').length,
    retryingQuanta: quanta.filter(q => q.state === 'retry_wait').length,
    failedQuanta: quanta.filter(q => q.state === 'terminal_failed').length,
    succeededQuanta: quanta.filter(q => q.state === 'succeeded').length,
    obligationCount: job.obligations?.length ?? 0,
    unresolvedObligations: unresolved,
    nextDueAt: job.nextDueAt,
    successorJobId: job.successorJobId,
    transitionId: job.transitionId,
    terminalReason: job.terminalReason,
  };
}

export function evidenceReviewJobStorePathForReviewQueue(reviewQueuePath: string): string {
  return path.join(path.dirname(reviewQueuePath), 'evidence-review-jobs.json');
}

export { WORK_CLASS_ORDER };

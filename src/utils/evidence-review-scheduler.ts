/**
 * Fair Review Quantum Rotation (#108).
 *
 * Durable, work-conserving selection of Review Quanta:
 * 1. Rotate across work classes (operational recovery → live → historical → reassessment).
 * 2. Within a class, claim at most one Quantum per runnable job before cycling.
 * 3. Inside a job, prefer critical-path nodes and balance Author/Verifier lanes.
 * 4. A sole runnable job may consume spare global capacity.
 */

import type {
  EvidenceReviewJob,
  EvidenceReviewJobStoreState,
  ReviewQuantumRecord,
  ReviewWorkClass,
} from './evidence-review-types';
import { WORK_CLASS_ORDER } from './evidence-review-job-store';
import { criticalPathRank, isQuantumRunnable } from './evidence-review-graph-core';

/** Prefer critical-path nodes; among readers, balance Author/Verifier lanes. */
function selectNextQuantum(
  job: EvidenceReviewJob,
  runnable: readonly ReviewQuantumRecord[],
): ReviewQuantumRecord | undefined {
  if (runnable.length === 0) return undefined;
  const nonReaders = runnable.filter(q => q.kind !== 'author_reader' && q.kind !== 'verifier_reader');
  if (nonReaders.length > 0) return nonReaders[0];

  const authorDone = Object.values(job.quanta)
    .filter(q => q.kind === 'author_reader' && q.state === 'succeeded').length;
  const verifierDone = Object.values(job.quanta)
    .filter(q => q.kind === 'verifier_reader' && q.state === 'succeeded').length;
  const preferLane: 'author' | 'verifier' = authorDone <= verifierDone ? 'author' : 'verifier';
  const preferred = runnable.find(q => q.lane === preferLane);
  return preferred ?? runnable[0];
}

export interface FairSchedulePlan {
  /** Ordered claims for this wake (jobId + quantumId). */
  claims: Array<{ jobId: string; quantumId: string; workClass: ReviewWorkClass }>;
  /** Updated fairness cursors to persist. */
  fairness: EvidenceReviewJobStoreState['fairness'];
}

export interface FairScheduleOptions {
  /** Global max quanta to claim this pass. */
  maxClaims: number;
  /** Per-job concurrency when multiple jobs compete. */
  maxClaimsPerJob: number;
  now?: Date;
}

function nextWorkClass(current: ReviewWorkClass): ReviewWorkClass {
  const index = WORK_CLASS_ORDER.indexOf(current);
  return WORK_CLASS_ORDER[(index + 1) % WORK_CLASS_ORDER.length]!;
}

function runnableJobsByClass(
  jobs: readonly EvidenceReviewJob[],
  now: Date,
): Record<ReviewWorkClass, EvidenceReviewJob[]> {
  const out: Record<ReviewWorkClass, EvidenceReviewJob[]> = {
    operational_recovery: [],
    live_learning: [],
    historical_learning: [],
    semantic_reassessment: [],
  };
  for (const job of jobs) {
    if (job.disposition !== 'active') continue;
    const hasRunnable = Object.values(job.quanta).some(q => isQuantumRunnable(job as any, q, now));
    if (!hasRunnable) continue;
    out[job.workClass].push(job);
  }
  for (const workClass of WORK_CLASS_ORDER) {
    out[workClass].sort((a, b) => a.jobId.localeCompare(b.jobId, 'en'));
  }
  return out;
}

function pickJobQuantum(
  job: EvidenceReviewJob,
  now: Date,
  excludeQuantumIds: ReadonlySet<string> = new Set(),
): ReviewQuantumRecord | undefined {
  const runnable = Object.values(job.quanta)
    .filter(q => isQuantumRunnable(job as any, q, now) && !excludeQuantumIds.has(q.quantumId))
    .sort((a, b) => criticalPathRank(a) - criticalPathRank(b)
      || a.quantumId.localeCompare(b.quantumId, 'en'));
  return selectNextQuantum(job, runnable);
}

/**
 * Plan a fair set of Quantum claims for one wake.
 * Does not mutate job quanta; the engine claims leases afterward.
 */
export function planFairQuantumClaims(
  state: EvidenceReviewJobStoreState,
  options: FairScheduleOptions,
): FairSchedulePlan {
  const now = options.now ?? new Date();
  const maxClaims = Math.max(0, Math.floor(options.maxClaims));
  const maxClaimsPerJob = Math.max(1, Math.floor(options.maxClaimsPerJob));
  const fairness = {
    nextWorkClass: state.fairness.nextWorkClass,
    classCursors: { ...state.fairness.classCursors },
    jobCursors: { ...state.fairness.jobCursors },
  };
  const claims: FairSchedulePlan['claims'] = [];
  if (maxClaims === 0) return { claims, fairness };

  const activeJobs = Object.values(state.jobs);
  const byClass = runnableJobsByClass(activeJobs, now);
  const claimsPerJob = new Map<string, number>();

  // Work-conserving: if only one job is runnable globally, allow it to fill maxClaims.
  const allRunnableJobs = WORK_CLASS_ORDER.flatMap(wc => byClass[wc]);
  const soleJob = allRunnableJobs.length === 1 ? allRunnableJobs[0] : undefined;
  const effectivePerJobCap = soleJob ? maxClaims : maxClaimsPerJob;

  let guard = 0;
  while (claims.length < maxClaims && guard < maxClaims * WORK_CLASS_ORDER.length * 8) {
    guard += 1;
    const availableClasses = WORK_CLASS_ORDER.filter(wc => byClass[wc].length > 0);
    if (availableClasses.length === 0) break;

    // Find next class with work, starting from fairness cursor.
    const start = WORK_CLASS_ORDER.indexOf(fairness.nextWorkClass);
    let selectedClass: ReviewWorkClass | undefined;
    for (let offset = 0; offset < WORK_CLASS_ORDER.length; offset++) {
      const candidate = WORK_CLASS_ORDER[(start + offset) % WORK_CLASS_ORDER.length]!;
      if (byClass[candidate].length > 0) {
        selectedClass = candidate;
        break;
      }
    }
    if (!selectedClass) break;

    const jobs = byClass[selectedClass];
    const cursor = fairness.classCursors[selectedClass];
    let jobIndex = cursor
      ? jobs.findIndex(job => job.jobId.localeCompare(cursor, 'en') > 0)
      : 0;
    if (jobIndex < 0) jobIndex = 0;

    // Within class: at most one quantum per job per cycle pass (unless sole job).
    const plannedIds = new Set(claims.map(c => c.quantumId));
    let claimedThisCycle = false;
    for (let i = 0; i < jobs.length && claims.length < maxClaims; i++) {
      const job = jobs[(jobIndex + i) % jobs.length]!;
      const used = claimsPerJob.get(job.jobId) ?? 0;
      if (used >= effectivePerJobCap) continue;
      const quantum = pickJobQuantum(job, now, plannedIds);
      if (!quantum) continue;

      claims.push({ jobId: job.jobId, quantumId: quantum.quantumId, workClass: selectedClass });
      plannedIds.add(quantum.quantumId);
      claimsPerJob.set(job.jobId, used + 1);
      fairness.classCursors[selectedClass] = job.jobId;
      fairness.jobCursors[job.jobId] = quantum.quantumId;
      claimedThisCycle = true;
      // One quantum per job per class cycle when competing.
      if (!soleJob) break;
    }

    fairness.nextWorkClass = nextWorkClass(selectedClass);

    // Drop exhausted jobs from the class list for subsequent cycles.
    byClass[selectedClass] = byClass[selectedClass].filter(job => {
      const used = claimsPerJob.get(job.jobId) ?? 0;
      if (used >= effectivePerJobCap) return false;
      return pickJobQuantum(job, now, plannedIds) !== undefined;
    });

    if (!claimedThisCycle) {
      // Avoid infinite loop when class cursor points at exhausted work.
      if (byClass[selectedClass].length === 0) continue;
      // Force cursor wrap.
      delete fairness.classCursors[selectedClass];
    }
  }

  return { claims, fairness };
}

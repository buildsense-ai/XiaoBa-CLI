/**
 * Fair Review Quantum Rotation (#108).
 *
 * Durable, work-conserving selection of Review Quanta from the engine job store:
 * 1. Rotate durably across work classes (no permanent priority class).
 * 2. Within a selected class, claim at most one Quantum per runnable job
 *    before that job is visited again.
 * 3. Inside a job, prefer critical-path nodes and balance Author/Verifier
 *    reader lanes while either lane remains incomplete (including claims
 *    planned earlier in this pass).
 * 4. Per-job concurrency caps (counting already-leased / in-flight quanta)
 *    prevent one large job from monopolizing slots when other jobs are runnable.
 * 5. When only one job is runnable, it may consume spare global capacity.
 * 6. Job size, retry count, and bundle length never alter semantic eligibility
 *    or permanent priority.
 */

import type {
  EvidenceReviewJob,
  EvidenceReviewJobStoreState,
  ReviewQuantumRecord,
  ReviewWorkClass,
} from './evidence-review-types';
import { WORK_CLASS_ORDER } from './evidence-review-job-store';
import { criticalPathRank, isQuantumRunnable } from './evidence-review-graph-core';

export type FairnessState = EvidenceReviewJobStoreState['fairness'];

export interface FairSchedulePlan {
  /** Ordered claims for this wake (jobId + quantumId). */
  claims: Array<{ jobId: string; quantumId: string; workClass: ReviewWorkClass }>;
  /** Updated fairness cursors to persist. */
  fairness: FairnessState;
}

export interface FairScheduleOptions {
  /** Global max quanta to claim this pass. */
  maxClaims: number;
  /** Per-job concurrency when multiple jobs compete. */
  maxClaimsPerJob: number;
  now?: Date;
}

export function emptyFairnessState(): FairnessState {
  return {
    nextWorkClass: 'operational_recovery',
    classCursors: {},
    jobCursors: {},
  };
}

/**
 * Normalize an untrusted fairness blob into a valid rotation state.
 * Unknown work classes fall back to the ring start; non-string cursors drop.
 */
export function normalizeFairnessState(value: unknown): FairnessState {
  const empty = emptyFairnessState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const raw = value as Partial<FairnessState>;
  const nextWorkClass = WORK_CLASS_ORDER.includes(raw.nextWorkClass as ReviewWorkClass)
    ? (raw.nextWorkClass as ReviewWorkClass)
    : empty.nextWorkClass;

  const classCursors: FairnessState['classCursors'] = {};
  if (raw.classCursors && typeof raw.classCursors === 'object' && !Array.isArray(raw.classCursors)) {
    for (const workClass of WORK_CLASS_ORDER) {
      const cursor = (raw.classCursors as Partial<Record<ReviewWorkClass, unknown>>)[workClass];
      if (typeof cursor === 'string' && cursor) classCursors[workClass] = cursor;
    }
  }

  const jobCursors: FairnessState['jobCursors'] = {};
  if (raw.jobCursors && typeof raw.jobCursors === 'object' && !Array.isArray(raw.jobCursors)) {
    for (const [jobId, cursor] of Object.entries(raw.jobCursors)) {
      if (typeof cursor === 'string' && cursor) jobCursors[jobId] = cursor;
    }
  }

  return { nextWorkClass, classCursors, jobCursors };
}

function nextWorkClass(current: ReviewWorkClass): ReviewWorkClass {
  const index = WORK_CLASS_ORDER.indexOf(current);
  const safeIndex = index < 0 ? 0 : index;
  return WORK_CLASS_ORDER[(safeIndex + 1) % WORK_CLASS_ORDER.length]!;
}

function isReader(quantum: ReviewQuantumRecord): boolean {
  return quantum.kind === 'author_reader' || quantum.kind === 'verifier_reader'
    || quantum.lane === 'author' || quantum.lane === 'verifier';
}

function readerLane(quantum: ReviewQuantumRecord): 'author' | 'verifier' | undefined {
  if (quantum.lane === 'author' || quantum.lane === 'verifier') return quantum.lane;
  if (quantum.kind === 'author_reader') return 'author';
  if (quantum.kind === 'verifier_reader') return 'verifier';
  return undefined;
}

/** Count already-leased quanta so they consume the per-job concurrency cap. */
function inFlightCount(job: EvidenceReviewJob, now: Date): number {
  return Object.values(job.quanta).filter(q => {
    if (q.state !== 'leased' || !q.lease) return false;
    return new Date(q.lease.expiresAt).getTime() > now.getTime();
  }).length;
}

/**
 * Prefer critical-path non-readers first; among readers, balance Author and
 * Verifier lanes while either lane still has ready work. Planned claims from
 * this pass count toward lane progress so multi-claim plans stay balanced.
 */
function selectNextQuantum(
  job: EvidenceReviewJob,
  runnable: readonly ReviewQuantumRecord[],
  options: {
    plannedAuthor?: number;
    plannedVerifier?: number;
  } = {},
): ReviewQuantumRecord | undefined {
  if (runnable.length === 0) return undefined;
  const nonReaders = runnable.filter(q => !isReader(q));
  if (nonReaders.length > 0) return nonReaders[0];

  const authorDone = Object.values(job.quanta)
    .filter(q => q.kind === 'author_reader' && q.state === 'succeeded').length
    + (options.plannedAuthor ?? 0);
  const verifierDone = Object.values(job.quanta)
    .filter(q => q.kind === 'verifier_reader' && q.state === 'succeeded').length
    + (options.plannedVerifier ?? 0);
  const preferLane: 'author' | 'verifier' = authorDone <= verifierDone ? 'author' : 'verifier';
  const preferred = runnable.find(q => readerLane(q) === preferLane);
  return preferred ?? runnable[0];
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
    const notBefore = job.nextDueAt ? Date.parse(job.nextDueAt) : Number.NaN;
    if (Number.isFinite(notBefore) && notBefore > now.getTime()) continue;
    const hasRunnable = Object.values(job.quanta).some(q => isQuantumRunnable(job, q, now));
    if (!hasRunnable) continue;
    out[job.workClass].push(job);
  }
  for (const workClass of WORK_CLASS_ORDER) {
    // Stable order; size / retry never sort ahead.
    out[workClass].sort((a, b) => a.jobId.localeCompare(b.jobId, 'en'));
  }
  return out;
}

function listRunnableForJob(
  job: EvidenceReviewJob,
  now: Date,
  excludeQuantumIds: ReadonlySet<string>,
): ReviewQuantumRecord[] {
  return Object.values(job.quanta)
    .filter(q => isQuantumRunnable(job, q, now) && !excludeQuantumIds.has(q.quantumId))
    .sort((a, b) => criticalPathRank(a) - criticalPathRank(b)
      || a.quantumId.localeCompare(b.quantumId, 'en'));
}

function pickJobQuantum(
  job: EvidenceReviewJob,
  now: Date,
  excludeQuantumIds: ReadonlySet<string>,
  plannedAuthor: number,
  plannedVerifier: number,
): ReviewQuantumRecord | undefined {
  const runnable = listRunnableForJob(job, now, excludeQuantumIds);
  return selectNextQuantum(job, runnable, { plannedAuthor, plannedVerifier });
}

function startJobIndex(jobs: readonly EvidenceReviewJob[], cursor: string | undefined): number {
  if (!cursor) return 0;
  const index = jobs.findIndex(job => job.jobId.localeCompare(cursor, 'en') > 0);
  return index < 0 ? 0 : index;
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
  const normalized = normalizeFairnessState(state.fairness);
  const fairness: FairnessState = {
    nextWorkClass: normalized.nextWorkClass,
    classCursors: { ...normalized.classCursors },
    jobCursors: { ...normalized.jobCursors },
  };
  const claims: FairSchedulePlan['claims'] = [];
  if (maxClaims === 0) return { claims, fairness };

  const activeJobs = Object.values(state.jobs);
  const byClass = runnableJobsByClass(activeJobs, now);
  const allRunnableJobs = WORK_CLASS_ORDER.flatMap(wc => byClass[wc]);
  const soleJob = allRunnableJobs.length === 1 ? allRunnableJobs[0] : undefined;
  // Work-conserving: sole runnable job may fill spare global capacity.
  const effectivePerJobCap = soleJob ? maxClaims : maxClaimsPerJob;

  const claimsPerJob = new Map<string, number>();
  for (const job of allRunnableJobs) {
    const inFlight = inFlightCount(job, now);
    if (inFlight > 0) claimsPerJob.set(job.jobId, inFlight);
  }

  const plannedIds = new Set<string>();
  const plannedAuthorByJob = new Map<string, number>();
  const plannedVerifierByJob = new Map<string, number>();

  const tryClaimFromJob = (
    job: EvidenceReviewJob,
    selectedClass: ReviewWorkClass,
  ): boolean => {
    const used = claimsPerJob.get(job.jobId) ?? 0;
    if (used >= effectivePerJobCap) return false;
    if (claims.length >= maxClaims) return false;

    const quantum = pickJobQuantum(
      job,
      now,
      plannedIds,
      plannedAuthorByJob.get(job.jobId) ?? 0,
      plannedVerifierByJob.get(job.jobId) ?? 0,
    );
    if (!quantum) return false;

    claims.push({
      jobId: job.jobId,
      quantumId: quantum.quantumId,
      workClass: selectedClass,
    });
    plannedIds.add(quantum.quantumId);
    claimsPerJob.set(job.jobId, used + 1);
    fairness.classCursors[selectedClass] = job.jobId;
    fairness.jobCursors[job.jobId] = quantum.quantumId;

    const lane = readerLane(quantum);
    if (lane === 'author') {
      plannedAuthorByJob.set(job.jobId, (plannedAuthorByJob.get(job.jobId) ?? 0) + 1);
    } else if (lane === 'verifier') {
      plannedVerifierByJob.set(job.jobId, (plannedVerifierByJob.get(job.jobId) ?? 0) + 1);
    }
    return true;
  };

  let guard = 0;
  const guardLimit = Math.max(8, maxClaims * WORK_CLASS_ORDER.length * 8);
  while (claims.length < maxClaims && guard < guardLimit) {
    guard += 1;
    const availableClasses = WORK_CLASS_ORDER.filter(wc => byClass[wc].length > 0);
    if (availableClasses.length === 0) break;

    const start = WORK_CLASS_ORDER.indexOf(fairness.nextWorkClass);
    const startIndex = start < 0 ? 0 : start;
    let selectedClass: ReviewWorkClass | undefined;
    for (let offset = 0; offset < WORK_CLASS_ORDER.length; offset++) {
      const candidate = WORK_CLASS_ORDER[(startIndex + offset) % WORK_CLASS_ORDER.length]!;
      if (byClass[candidate].length > 0) {
        selectedClass = candidate;
        break;
      }
    }
    if (!selectedClass) break;

    const classJobs = byClass[selectedClass];
    const jobIndex = startJobIndex(classJobs, fairness.classCursors[selectedClass]);
    let claimedThisCycle = false;

    // Within class: at most one Quantum per runnable job before any job gets a
    // second claim in this class visit (one-per-job pass).
    for (let i = 0; i < classJobs.length && claims.length < maxClaims; i++) {
      const job = classJobs[(jobIndex + i) % classJobs.length]!;
      if (tryClaimFromJob(job, selectedClass)) claimedThisCycle = true;
    }

    // Work-conserving refill: the sole runnable job may consume spare global
    // capacity within the same pass without waiting for empty class rotations.
    if (soleJob && selectedClass === soleJob.workClass) {
      while (claims.length < maxClaims) {
        if (!tryClaimFromJob(soleJob, selectedClass)) break;
        claimedThisCycle = true;
      }
    }

    fairness.nextWorkClass = nextWorkClass(selectedClass);

    // Drop exhausted / capped jobs from the class list for subsequent cycles.
    byClass[selectedClass] = byClass[selectedClass].filter(job => {
      const used = claimsPerJob.get(job.jobId) ?? 0;
      if (used >= effectivePerJobCap) return false;
      return pickJobQuantum(
        job,
        now,
        plannedIds,
        plannedAuthorByJob.get(job.jobId) ?? 0,
        plannedVerifierByJob.get(job.jobId) ?? 0,
      ) !== undefined;
    });

    if (!claimedThisCycle) {
      // Avoid infinite loop when class cursor points at exhausted work.
      if (byClass[selectedClass].length === 0) continue;
      delete fairness.classCursors[selectedClass];
    }
  }

  return { claims, fairness };
}

/**
 * Due Work Planner (issue #52).
 *
 * A small planner that derives due work and the earliest next wake from
 * durable Runtime Learning state. It reads three durable sources — the
 * Learning Episode store, the Evidence Review Job store, and the
 * Skill Usage Curator state — and produces a synchronous snapshot of what
 * work is past its deadline and when the next future wake is needed.
 *
 * The planner is intentionally NOT a generic workflow/DAG framework. It is
 * a simple deadline comparator that tells the scheduler and coordinator
 * which stages to run and when to wake next. All sources are durable files
 * so deadlines are restored after restart without migration.
 *
 * Semantic defers remain evidence-gated by SkillEvolutionRuntime; the planner does not blindly
 * treat deferred entries as due.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LEARNING_EPISODE_SCHEMA_VERSION } from './learning-episode';
import { evidenceReviewJobStorePathForReviewQueue } from './evidence-review-job-store';

/**
 * Suggested minimum delay applied to a due-work wake so an overdue deadline
 * does not produce a zero-millisecond hot loop. The planner defaults to 0
 * (no floor) so the scheduler's ADR 0038 retry/backoff guard — which keys on a
 * zero-delta overdue wake and applies exponential backoff itself — remains the
 * default hot-loop protection. Operators who want a planner-level floor
 * independent of the scheduler guard may set `minDueWorkWakeDelayMs` to this
 * (or any non-negative) value; it is applied ONLY to overdue (past-deadline)
 * wake scheduling and never shifts a genuine future deadline.
 */
export const DEFAULT_MIN_DUE_WORK_WAKE_DELAY_MS = 0;
export const REVIEW_CONTINUATION_DELAY_MS = 30_000;

export function reviewContinuationPathForEpisodeStore(episodeStorePath: string): string {
  return path.join(path.dirname(episodeStorePath), 'review-continuation.json');
}

/**
 * Categories of due work the planner can report, ordered by priority (highest
 * first). Overdue operational retry and settlement outrank routine curator and
 * discovery-scheduled work so a coalesced or targeted wake never starves the
 * time-critical review path.
 */
export type DueWorkCategory =
  | 'operational-retry'
  | 'settlement-deadline'
  | 'semantic-reassessment'
  | 'curator';

/**
 * Deterministic priority order for due-work categories (highest first).
 * Operational retry (a failed review that must not be dropped) and
 * settlement deadlines (a candidate whose refutation window has closed)
 * outrank semantic reassessment and curator work.
 */
export const DUE_WORK_PRIORITY: readonly DueWorkCategory[] = [
  'operational-retry',
  'settlement-deadline',
  'semantic-reassessment',
  'curator',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * What work is past its deadline right now.
 */
export interface DueWork {
  /** One or more settling Learning Episodes have passed their deadline. */
  settlementDue: boolean;
  /** An operational Branch Promotion Review retry deadline has passed. */
  operationalRetryDue: boolean;
  /** The routine curator cadence interval has elapsed. */
  routineCuratorDue: boolean;
  /** An expedited curator wake has been requested. */
  expeditedCuratorDue: boolean;
  /** A semantic reassessment task is pending or its retry is due. */
  semanticReassessmentDue?: boolean;
}

/**
 * Snapshot of the planner's analysis at one point in time.
 */
export interface DueWorkPlan {
  /** The analysis timestamp. */
  now: Date;
  /** Work that is past its deadline and should be processed now. */
  due: DueWork;
  /**
   * Milliseconds from epoch of the earliest future deadline across all
   * durable sources, or `null` if no future deadline exists and the
   * scheduler should fall back to its discovery interval.
   */
  nextWakeTime: number | null;
  /**
   * Human-readable label describing the earliest future deadline.
   * Not set when `nextWakeTime` is null.
   */
  nextWakeReason: string;
  /**
   * Due-work categories that are past their deadline, ordered by priority
   * (highest first). A coalesced or targeted wake runs these before routine
   * discovery so overdue review/settlement cannot be starved. Empty when no
   * work is due. See {@link DUE_WORK_PRIORITY}.
   */
  duePriority: DueWorkCategory[];
}

/**
 * Durable source paths and policy values the planner reads.
 */
export interface PlannerSources {
  /** Path to the Learning Episode store JSON file. */
  learningEpisodeStorePath: string;
  /** Former queue path; its directory locates the authoritative Evidence Review Job store. */
  reviewQueuePath: string;
  /** Path to the Curator state JSON file, or null when no curator is configured. */
  curatorStatePath: string | null;
  /** Curator routine interval in milliseconds (e.g. 24h). */
  curatorIntervalMs: number;
  /** Optional semantic reassessment manifest. */
  semanticReassessmentManifestPath?: string;
  /**
   * Minimum delay (ms) applied to a due-work wake to prevent a zero-ms
   * hot loop. Defaults to {@link DEFAULT_MIN_DUE_WORK_WAKE_DELAY_MS}; the
   * scheduler's retry/backoff guard remains the primary protection by default.
   */
  minDueWorkWakeDelayMs?: number;
}

// ---------------------------------------------------------------------------
// DueWorkPlanner
// ---------------------------------------------------------------------------

/**
 * Reads durable Runtime Learning state files and produces a
 * deadline-derived plan of what work is due now and when to wake next.
 *
 * Every source is a durable file, so restart recovery is automatic:
 * missing/corrupt files return a null deadline for that source, never
 * a crash.
 */
export class DueWorkPlanner {
  constructor(private readonly sources: PlannerSources) {}

  /**
   * Compute the due work and earliest next wake from durable state.
   *
   * @param now - Optional reference timestamp (default: `new Date()`).
   *   Tests inject a fixed `now` to avoid timing sensitivity.
   * @returns A synchronous snapshot of deadlines and due flags.
   */
  plan(now: Date = new Date()): DueWorkPlan {
    const nowMs = now.getTime();
    const configuredMinDelayMs = this.sources.minDueWorkWakeDelayMs;
    const minDelayMs = configuredMinDelayMs === undefined || !Number.isFinite(configuredMinDelayMs)
      ? DEFAULT_MIN_DUE_WORK_WAKE_DELAY_MS
      : Math.max(0, Math.floor(configuredMinDelayMs));
    const dueWakeMs = nowMs + minDelayMs;

    // Read each durable source independently. A corrupt or missing source
    // returns null (no deadline), never throws, so a single corrupt file
    // cannot prevent the scheduler from running other work.
    const episodeSettlementDeadlineMs = this.readEarliestSettlementDeadline();
    const reviewContinuationDeadlineMs = this.readReviewContinuationDeadline();
    const settlementDeadlineMs = earliestDeadline(
      episodeSettlementDeadlineMs,
      reviewContinuationDeadlineMs,
    );
    const operationalRetryDeadlineMs = this.readEarliestOperationalRetryDeadline();
    const routineCuratorDeadlineMs = this.readNextRoutineCuratorDeadline();
    const expeditedCount = this.readExpeditedCuratorCount();
    const semanticReassessmentDeadlineMs = this.readSemanticReassessmentDeadline();

    // Due flags: deadline is in the past (or expedited wakes exist).
    const due: DueWork = {
      settlementDue: settlementDeadlineMs !== null && settlementDeadlineMs <= nowMs,
      operationalRetryDue: operationalRetryDeadlineMs !== null && operationalRetryDeadlineMs <= nowMs,
      routineCuratorDue: routineCuratorDeadlineMs !== null && routineCuratorDeadlineMs <= nowMs,
      expeditedCuratorDue: expeditedCount > 0,
      semanticReassessmentDue: semanticReassessmentDeadlineMs !== null && semanticReassessmentDeadlineMs <= nowMs,
    };

    // Priority-ordered due categories (highest first). Overdue operational
    // retry and settlement outrank semantic reassessment and curator work.
    const duePriority: DueWorkCategory[] = [];
    if (due.operationalRetryDue) duePriority.push('operational-retry');
    if (due.settlementDue) duePriority.push('settlement-deadline');
    if (due.semanticReassessmentDue) duePriority.push('semantic-reassessment');
    if (due.expeditedCuratorDue || due.routineCuratorDue) duePriority.push('curator');

    // Collect future deadlines (strictly > now) for the next wake.
    const candidates: Array<{ time: number; reason: string }> = [];

    if (settlementDeadlineMs !== null && settlementDeadlineMs > nowMs) {
      candidates.push({ time: settlementDeadlineMs, reason: 'settlement-deadline' });
    }
    if (operationalRetryDeadlineMs !== null && operationalRetryDeadlineMs > nowMs) {
      candidates.push({ time: operationalRetryDeadlineMs, reason: 'operational-retry' });
    }
    if (routineCuratorDeadlineMs !== null && routineCuratorDeadlineMs > nowMs) {
      candidates.push({ time: routineCuratorDeadlineMs, reason: 'curator' });
    }
    if (semanticReassessmentDeadlineMs !== null && semanticReassessmentDeadlineMs > nowMs) {
      candidates.push({ time: semanticReassessmentDeadlineMs, reason: 'semantic-reassessment' });
    }

    // For work that is past its deadline and has no future deadline entry,
    // add a prompt wake entry floored at `now + minDelayMs` so the scheduler
    // fires a targeted wake without entering a zero-millisecond hot loop.
    // Priority: operational-retry first, then settlement-deadline, then
    // curator (deterministic ordering).
    if (due.operationalRetryDue && !candidates.some(c => c.reason === 'operational-retry')) {
      candidates.push({ time: dueWakeMs, reason: 'operational-retry' });
    }
    if (due.settlementDue && !candidates.some(c => c.reason === 'settlement-deadline')) {
      candidates.push({ time: dueWakeMs, reason: 'settlement-deadline' });
    }
    if (due.routineCuratorDue && !candidates.some(c => c.reason === 'curator')) {
      candidates.push({ time: dueWakeMs, reason: 'curator' });
    }
    if (due.expeditedCuratorDue && !candidates.some(c => c.reason === 'curator' && c.time <= dueWakeMs)) {
      candidates.push({ time: dueWakeMs, reason: 'curator' });
    }
    if (due.semanticReassessmentDue && !candidates.some(c => c.reason === 'semantic-reassessment')) {
      candidates.push({ time: dueWakeMs, reason: 'semantic-reassessment' });
    }

    let nextWakeTime: number | null = null;
    let nextWakeReason = '';

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.time - b.time);
      nextWakeTime = candidates[0]!.time;
      nextWakeReason = candidates[0]!.reason;
    }

    return { now, due, nextWakeTime, nextWakeReason, duePriority };
  }

  // -----------------------------------------------------------------------
  // Durable-source readers
  //
  // Each reader returns the earliest deadline in milliseconds from epoch,
  // or null when the source has no relevant deadline. Missing/corrupt files
  // return null without throwing.
  // -----------------------------------------------------------------------

  private readEarliestSettlementDeadline(): number | null {
    // LearningEpisodeStoreState:
    //   { schemaVersion: 2, episodes: Record<string, LearningEpisode> }
    // LearningEpisode fields relevant to planning:
    //   status: 'settling' | 'contradicted' | 'eligible'
    //   settlementDeadline: string (ISO timestamp)
    try {
      if (!fs.existsSync(this.sources.learningEpisodeStorePath)) return null;
      const raw = fs.readFileSync(this.sources.learningEpisodeStorePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        episodes?: Record<string, { status?: string; settlementDeadline?: string }>;
      };
      const settlementSchemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (settlementSchemaVersion !== undefined
        && settlementSchemaVersion !== 2
        && settlementSchemaVersion !== LEARNING_EPISODE_SCHEMA_VERSION) return null;
      if (!parsed.episodes || typeof parsed.episodes !== 'object') return null;

      let earliest: number | null = null;
      for (const episode of Object.values(parsed.episodes)) {
        if (episode.status !== 'settling') continue;
        if (typeof episode.settlementDeadline !== 'string') continue;
        const ms = Date.parse(episode.settlementDeadline);
        if (!Number.isFinite(ms)) continue;
        if (earliest === null || ms < earliest) {
          earliest = ms;
        }
      }
      return earliest;
    } catch {
      return null;
    }
  }

  /** Budget-exhausted episodes and runnable review jobs persist a short continuation. */
  private readReviewContinuationDeadline(): number | null {
    try {
      const continuationPath = reviewContinuationPathForEpisodeStore(
        this.sources.learningEpisodeStorePath,
      );
      if (!fs.existsSync(continuationPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(continuationPath, 'utf8')) as {
        schemaVersion?: number;
        episodeIds?: unknown;
        reviewJobIds?: unknown;
        nextAttemptAt?: unknown;
      };
      if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2)
        || !Array.isArray(parsed.episodeIds)
        || typeof parsed.nextAttemptAt !== 'string') return null;
      const hasEpisodeWork = parsed.episodeIds.length > 0;
      const hasReviewJobWork = Array.isArray(parsed.reviewJobIds)
        && parsed.reviewJobIds.length > 0;
      if (!hasEpisodeWork && !hasReviewJobWork) return null;
      const deadline = Date.parse(parsed.nextAttemptAt);
      return Number.isFinite(deadline) ? deadline : null;
    } catch {
      return null;
    }
  }

  private readEarliestOperationalRetryDeadline(): number | null {
    // After Round 9 consolidation, the Evidence Review Job store is the single
    // durable owner of operational retry state; legacy review-queue.json files
    // are not imported.
    let earliest: number | null = null;
    try {
      const jobStorePath = evidenceReviewJobStorePathForReviewQueue(this.sources.reviewQueuePath);
      if (fs.existsSync(jobStorePath)) {
        const raw = fs.readFileSync(jobStorePath, 'utf8');
        const parsed = JSON.parse(raw) as {
          jobs?: Record<string, {
            disposition?: string;
            workClass?: string;
            nextDueAt?: string;
          }>;
        };
        if (parsed.jobs && typeof parsed.jobs === 'object') {
          for (const job of Object.values(parsed.jobs)) {
            if (job.disposition !== 'active') continue;
            if (job.workClass !== 'operational_recovery') continue;
            // Due immediately when nextDueAt is absent (ready coverage).
            if (typeof job.nextDueAt !== 'string' || !job.nextDueAt) {
              earliest = earliest === null ? 0 : Math.min(earliest, 0);
              continue;
            }
            const ms = Date.parse(job.nextDueAt);
            if (!Number.isFinite(ms)) continue;
            if (earliest === null || ms < earliest) earliest = ms;
          }
        }
      }
    } catch {
      // Job store optional / corrupt — ignore.
    }

    return earliest;
  }

  private readNextRoutineCuratorDeadline(): number | null {
    // CuratorState:
    //   { schemaVersion: 1, lastRoutineRunAt: string | null, ... }
    if (!this.sources.curatorStatePath) return null;
    try {
      if (!fs.existsSync(this.sources.curatorStatePath)) return null;
      const raw = fs.readFileSync(this.sources.curatorStatePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        lastRoutineRunAt?: string | null;
      };
      const curatorSchemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (curatorSchemaVersion !== undefined && curatorSchemaVersion !== 1) return null;
      const lastRun = parsed.lastRoutineRunAt;
      if (!lastRun) {
        // Never run: the first routine run is due immediately.
        return 0;
      }
      const lastRunMs = Date.parse(lastRun);
      if (!Number.isFinite(lastRunMs)) return null;
      const nextMs = lastRunMs + this.sources.curatorIntervalMs;
      return nextMs;
    } catch {
      return null;
    }
  }

  private readExpeditedCuratorCount(): number {
    // CuratorState:
    //   { ..., expedited: Record<string, CuratorWake> }
    if (!this.sources.curatorStatePath) return 0;
    try {
      if (!fs.existsSync(this.sources.curatorStatePath)) return 0;
      const raw = fs.readFileSync(this.sources.curatorStatePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        expedited?: Record<string, unknown>;
      };
      const expeditedSchemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (expeditedSchemaVersion !== undefined && expeditedSchemaVersion !== 1) return 0;
      if (!parsed.expedited || typeof parsed.expedited !== 'object') return 0;
      return Object.keys(parsed.expedited).length;
    } catch {
      return 0;
    }
  }

  private readSemanticReassessmentDeadline(): number | null {
    const filePath = this.sources.semanticReassessmentManifestPath;
    if (!filePath) return null;
    try {
      if (!fs.existsSync(filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        schemaVersion?: unknown;
        entries?: Record<string, { status?: string; nextRetryAt?: string }>;
      };
      if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) return null;
      if (!parsed.entries || typeof parsed.entries !== 'object') return null;
      let earliest: number | null = null;
      for (const entry of Object.values(parsed.entries)) {
        if (entry.status !== 'pending' && entry.status !== 'failed' && entry.status !== 'deferred') continue;
        // A pending task without a retry deadline is new work and should be
        // picked up immediately. A deferred task without a retry deadline is
        // intentionally waiting for new evidence (for example, semantic
        // observations that were not persisted); treating it as epoch zero
        // makes the heartbeat schedule an immediate wake forever. Failed
        // tasks likewise need an explicit retry deadline before they become
        // due again.
        if (!entry.nextRetryAt && entry.status !== 'pending') continue;
        const ms = entry.nextRetryAt ? Date.parse(entry.nextRetryAt) : 0;
        if (!Number.isFinite(ms)) continue;
        if (earliest === null || ms < earliest) earliest = ms;
      }
      return earliest;
    } catch {
      return null;
    }
  }
}

function earliestDeadline(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

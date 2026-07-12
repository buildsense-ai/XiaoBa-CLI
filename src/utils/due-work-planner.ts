/**
 * Due Work Planner (issue #52).
 *
 * A small planner that derives due work and the earliest next wake from
 * durable Runtime Learning state. It reads three durable sources — the
 * Learning Episode store, the Skill Evolution Review Queue, and the
 * Skill Usage Curator state — and produces a synchronous snapshot of what
 * work is past its deadline and when the next future wake is needed.
 *
 * The planner is intentionally NOT a generic workflow/DAG framework. It is
 * a simple deadline comparator that tells the scheduler and coordinator
 * which stages to run and when to wake next. All sources are durable files
 * so deadlines are restored after restart without migration.
 *
 * Semantic defers remain evidence-gated by the SkillEvolutionRuntime's
 * existing `isDeferredEntryEligible` check; the planner does not blindly
 * treat deferred entries as due.
 */

import * as fs from 'fs';
import * as path from 'path';

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
}

/**
 * Durable source paths and policy values the planner reads.
 */
export interface PlannerSources {
  /** Path to the Learning Episode store JSON file. */
  learningEpisodeStorePath: string;
  /** Path to the V3 Skill Evolution Review Queue JSON file. */
  reviewQueuePath: string;
  /** Path to the Curator state JSON file, or null when no curator is configured. */
  curatorStatePath: string | null;
  /** Curator routine interval in milliseconds (e.g. 24h). */
  curatorIntervalMs: number;
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

    // Read each durable source independently. A corrupt or missing source
    // returns null (no deadline), never throws, so a single corrupt file
    // cannot prevent the scheduler from running other work.
    const settlementDeadlineMs = this.readEarliestSettlementDeadline();
    const operationalRetryDeadlineMs = this.readEarliestOperationalRetryDeadline();
    const routineCuratorDeadlineMs = this.readNextRoutineCuratorDeadline();
    const expeditedCount = this.readExpeditedCuratorCount();

    // Due flags: deadline is in the past (or expedited wakes exist).
    const due: DueWork = {
      settlementDue: settlementDeadlineMs !== null && settlementDeadlineMs <= nowMs,
      operationalRetryDue: operationalRetryDeadlineMs !== null && operationalRetryDeadlineMs <= nowMs,
      routineCuratorDue: routineCuratorDeadlineMs !== null && routineCuratorDeadlineMs <= nowMs,
      expeditedCuratorDue: expeditedCount > 0,
    };

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

    // For work that is past its deadline and has no future deadline entry,
    // add an immediate wake entry so the scheduler does not fall back to
    // the discovery interval delay. Priority: operational-retry first,
    // then settlement-deadline, then curator (deterministic ordering).
    if (due.operationalRetryDue && !candidates.some(c => c.reason === 'operational-retry')) {
      candidates.push({ time: nowMs, reason: 'operational-retry' });
    }
    if (due.settlementDue && !candidates.some(c => c.reason === 'settlement-deadline')) {
      candidates.push({ time: nowMs, reason: 'settlement-deadline' });
    }
    if (due.routineCuratorDue && !candidates.some(c => c.reason === 'curator')) {
      candidates.push({ time: nowMs, reason: 'curator' });
    }
    if (due.expeditedCuratorDue && !candidates.some(c => c.reason === 'curator' && c.time <= nowMs)) {
      candidates.push({ time: nowMs, reason: 'curator' });
    }

    let nextWakeTime: number | null = null;
    let nextWakeReason = '';

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.time - b.time);
      nextWakeTime = candidates[0]!.time;
      nextWakeReason = candidates[0]!.reason;
    }

    return { now, due, nextWakeTime, nextWakeReason };
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
      if (settlementSchemaVersion !== undefined && settlementSchemaVersion !== 2) return null;
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

  private readEarliestOperationalRetryDeadline(): number | null {
    // SkillEvolutionReviewQueueState:
    //   { schemaVersion: 1, operational: SkillEvolutionOperationalReviewFailureEntry[], ... }
    // Entry fields relevant to planning:
    //   nextRetryAt: string (ISO timestamp)
    try {
      if (!fs.existsSync(this.sources.reviewQueuePath)) return null;
      const raw = fs.readFileSync(this.sources.reviewQueuePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        operational?: Array<{ nextRetryAt?: string }>;
      };
      const retrySchemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (retrySchemaVersion !== undefined && retrySchemaVersion !== 1) return null;
      if (!Array.isArray(parsed.operational)) return null;

      let earliest: number | null = null;
      for (const entry of parsed.operational) {
        if (typeof entry.nextRetryAt !== 'string') continue;
        const ms = Date.parse(entry.nextRetryAt);
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
}

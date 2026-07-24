/**
 * Distillation Heartbeat Scheduler — thin wake-loop adapter (issue #53).
 *
 * Production path: the scheduler is a thin timer that calls
 * `RuntimeLearning.wake()` on each tick. All intelligence (session log
 * scanning, evidence ingestion, settlement, review, curation, wake
 * coordination) lives in the deep `RuntimeLearning` module.
 *
 * The heartbeat owns:
 *   - The setTimeout-based timer
 *   - Runtime guard (`shouldStartForCurrentRuntime`)
 *   - Due-work-based next-wake planning
 * RuntimeLearning owns heartbeat persistence.
 *
 * See CONTEXT.md → "Distillation Heartbeat".
 * See ADR 0001 → "Runtime Heartbeat Log Distillation".
 */

import { getDistillationHeartbeatConfig } from './distillation-heartbeat-config';
import type { DueWorkPlanner } from './due-work-planner';
import { Logger } from './logger';
import type { HeartbeatSchedulerOwnerLock } from './heartbeat-scheduler-owner-lock';
import type { RuntimeLearning } from './runtime-learning';
import type {
  RuntimeLearningReason,
  RuntimeLearningHeartbeatResult,
} from './runtime-learning';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const MIN_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
/**
 * Minimum delay before a deadline-driven reschedule when the planner
 * returns a due item already in the past. Without this floor, a
 * persistent failure (e.g. a review that always times out and re-queues
 * with `nextRetryAt` in the past) makes `scheduleNextRun` compute
 * `deadlineDelta = 0` and `setTimeout(…, 0)`, producing a 0ms busy loop.
 * See ADR 0038 (coalesced wakes) and the scheduler retry/backoff guard.
 */
const MIN_NEXT_WAKE_BACKOFF_MS = 30 * 1000;
const MAX_NEXT_WAKE_BACKOFF_MS = 10 * 60 * 1000;

function emptyWakeResult(ran = false): RuntimeLearningHeartbeatResult {
  return {
    unitsProcessed: 0,
    advancedFiles: 0,
    ran,
    discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0, sources: [] },
    ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
    maturation: { status: 'skipped', maturedEpisodes: 0, becameEligible: 0, becameContradicted: 0 },
    review: {
      status: 'skipped',
      reviewedEpisodes: 0,
      reviewedQueueEntries: 0,
      deferredQueueReviews: 0,
      operationalQueueReviews: 0,
      deferredRetries: 0,
      operationalRetries: 0,
      transitionsByKind: {},
      reviewTimeoutCount: 0,
      reviewFailureCount: 0,
    },
    curation: { status: 'skipped', ran: false, expedited: false, transitionsByKind: {} },
    reassessment: { status: 'skipped', discovered: 0, completed: 0, deferred: 0, failed: 0, transitionsByKind: {} },
  };
}

// ---------------------------------------------------------------------------
// DistillationHeartbeatScheduler
// ---------------------------------------------------------------------------

/**
 * Thin wake-loop adapter for Runtime Learning.
 *
 * Production path: constructed with a `RuntimeLearning` instance; the
 * `runHeartbeat()` method delegates directly to `RuntimeLearning.wake()`.
 */
export class DistillationHeartbeatScheduler {
  private readonly workingDirectory: string;
  private readonly runtimeLearning: RuntimeLearning;
  private readonly ownerLock: HeartbeatSchedulerOwnerLock | null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private readonly pendingWakeReasons = new Set<RuntimeLearningReason>();
  private activeWake: Promise<RuntimeLearningHeartbeatResult> | null = null;
  private scheduledWake: Promise<void> | null = null;
  /**
   * Consecutive count of reschedules where the planner returned a due
   * deadline in the past (deadlineDelta === 0). Each consecutive immediate
   * reschedule doubles the backoff floor, capped at MAX_NEXT_WAKE_BACKOFF_MS.
   * A normal scheduled interval resets the counter to zero.
   */
  private consecutiveImmediateReschedules = 0;

  /**
   * Production constructor: delegates all wake logic to RuntimeLearning.
   *
   * @param workingDirectory - Working directory for config resolution.
   * @param runtimeLearning - The RuntimeLearning production module.
   */
  constructor(
    workingDirectory: string,
    runtimeLearning: RuntimeLearning,
    ownerLock?: HeartbeatSchedulerOwnerLock | null,
  ) {
    this.workingDirectory = workingDirectory;
    this.runtimeLearning = runtimeLearning;
    this.ownerLock = ownerLock ?? null;
  }

  // -----------------------------------------------------------------------
  // Runtime guard
  // -----------------------------------------------------------------------

  /**
   * Runtime guard: the heartbeat is disabled for inspector role runtimes and
   * when the config master switch is off.
   */
  static shouldStartForCurrentRuntime(
    workingDirectory: string = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
  ): boolean {
    const normalizedRole = String(env.XIAOBA_ROLE || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    if (normalizedRole === 'inspector-cat') {
      return false;
    }
    const config = getDistillationHeartbeatConfig(workingDirectory, env);
    return config.enabled;
  }

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (
      this.started
      || !DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(this.workingDirectory)
    ) {
      return;
    }

    this.started = true;
    this.stopped = false;
    for (const reason of this.runtimeLearning?.getPendingHeartbeatReasons?.() ?? []) {
      this.pendingWakeReasons.add(reason);
    }
    Logger.info('[DistillationHeartbeat] scheduler started');

    const startupWake = (async () => {
      await this.runHeartbeat('startup');
      if (!this.stopped) {
        this.scheduleNextRun();
      }
    })();
    this.trackScheduledWake(startupWake);

  }

  async stop(): Promise<boolean> {
    this.stopped = true;
    this.started = false;
    this.consecutiveImmediateReschedules = 0;
    const stopStartedAtMs = Date.now();
    const sharedReviewDeadlineMs = this.getSharedReviewDeadlineMs();
    let cleanShutdown = true;
    // Explicit backfills are cooperative RuntimeLearning operations. Request
    // their bounded drain here so shutdown observes them instead of allowing a
    // historical scan to continue outside scheduler ownership.
    const runtimeDrain = this.runtimeLearning?.drain?.(sharedReviewDeadlineMs) ?? null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeWake) {
      let activeWakeCompleted = false;
      const awaitableWake = this.activeWake;
      let activeWakeTimer: NodeJS.Timeout | null = null;
      await Promise.race([
        awaitableWake
          .then(() => {
            activeWakeCompleted = true;
          })
          .finally(() => {
            if (activeWakeTimer) {
              clearTimeout(activeWakeTimer);
              activeWakeTimer = null;
            }
          }),
        new Promise<void>(resolve => {
          activeWakeTimer = setTimeout(() => {
            activeWakeTimer = null;
            resolve();
          }, sharedReviewDeadlineMs);
        }),
      ]);
      if (!activeWakeCompleted) {
        cleanShutdown = false;
        // Fail closed: an uncooperative old wake may still be inside a writer.
        // Keep renewing ownership until that wake actually finishes (or the
        // supervisor kills this process). Releasing at the deadline would let
        // a new connector take over while the old writer is still alive.
        void awaitableWake.then(
          () => this.ownerLock?.release(),
          () => this.ownerLock?.release(),
        );
      }
      if (activeWakeCompleted) {
        const drainedReason = Array.from(this.pendingWakeReasons).sort();
        const markHeartbeatStatus = this.runtimeLearning?.markHeartbeatStatus;
        if (typeof markHeartbeatStatus === 'function') {
          markHeartbeatStatus.call(this.runtimeLearning, 'drained', {
            reason: 'manual',
            durationMs: Math.max(0, Date.now() - stopStartedAtMs),
            pendingWakeReasons: drainedReason,
            reviewTimeoutCount: 0,
            reviewFailureCount: 0,
          });
        }
      }
      this.activeWake = null;
    }

    if (this.scheduledWake) {
      let scheduledWakeTimer: NodeJS.Timeout | null = null;
      let scheduledWakeCompleted = false;
      const remainingMs = sharedReviewDeadlineMs - (Date.now() - stopStartedAtMs);
      if (remainingMs > 0) {
        await Promise.race([
          this.scheduledWake.then(() => {
            scheduledWakeCompleted = true;
          }).finally(() => {
            if (scheduledWakeTimer) {
              clearTimeout(scheduledWakeTimer);
              scheduledWakeTimer = null;
            }
          }),
          new Promise<void>(resolve => {
            scheduledWakeTimer = setTimeout(() => {
              scheduledWakeTimer = null;
              resolve();
            }, remainingMs);
          }),
        ]);
      }
      if (!scheduledWakeCompleted) cleanShutdown = false;
      this.scheduledWake = null;
    }

    if (runtimeDrain) {
      const remainingMs = Math.max(1, sharedReviewDeadlineMs - (Date.now() - stopStartedAtMs));
      let runtimeDrainTimer: NodeJS.Timeout | null = null;
      let runtimeDrainCompleted = false;
      await Promise.race([
        runtimeDrain.then(() => {
          runtimeDrainCompleted = true;
        }).finally(() => {
          if (runtimeDrainTimer) {
            clearTimeout(runtimeDrainTimer);
            runtimeDrainTimer = null;
          }
        }),
        new Promise<void>(resolve => {
          runtimeDrainTimer = setTimeout(resolve, remainingMs);
        }),
      ]);
      if (!runtimeDrainCompleted) cleanShutdown = false;
    }

    Logger.info('[DistillationHeartbeat] scheduler stopped');
    return cleanShutdown;
  }

  // -----------------------------------------------------------------------
  // Run one heartbeat cycle
  // -----------------------------------------------------------------------

  /**
   * Run one heartbeat cycle.
   *
   * Delegates all work to `RuntimeLearning.wake()`.
   */
  async runHeartbeat(reason: RuntimeLearningReason = 'manual'): Promise<RuntimeLearningHeartbeatResult> {
    if (
      this.stopped
      || !DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(this.workingDirectory)
    ) {
      return emptyWakeResult();
    }

    if (this.ownerLock) {
      try {
        this.ownerLock.assertOwnership();
      } catch (error: any) {
        this.stopped = true;
        Logger.warning(`[DistillationHeartbeat] scheduler fenced: ${error?.message ?? error}`);
        return emptyWakeResult(false);
      }
    }

    if (this.activeWake) {
      this.pendingWakeReasons.add(reason);
      this.persistPendingWakeReasons();
      return this.activeWake;
    }

    this.pendingWakeReasons.add(reason);
    this.persistPendingWakeReasons();
    const wakeCycle = async (): Promise<RuntimeLearningHeartbeatResult> => {
      let lastResult = emptyWakeResult(true);
      let isCoalescedWake = false;
      while (!this.stopped && this.pendingWakeReasons.size > 0) {
          const nextReasons = [...this.pendingWakeReasons];
          this.pendingWakeReasons.clear();
          this.persistPendingWakeReasons();
          try {
            this.runtimeLearning.markHeartbeatInProgress?.(
              nextReasons,
              this.ownerLock ? {
                pid: this.ownerLock.record.pid,
                generation: this.ownerLock.generation,
                startedAt: this.ownerLock.record.startedAt,
                lastHeartbeatAt: this.ownerLock.record.lastHeartbeatAt,
              } : undefined,
            );
            lastResult = await this.runtimeLearning.wake(nextReasons, { coalesced: isCoalescedWake });
            isCoalescedWake = true;
            for (const pending of this.runtimeLearning.getPendingHeartbeatReasons?.() ?? []) {
              if (pending === 'external-continuation') {
                this.pendingWakeReasons.add(pending);
              }
            }
          } catch (error: any) {
            Logger.warning(`[DistillationHeartbeat] runtime wake failed: ${error.message}`);
            return emptyWakeResult(false);
          }
      }
      return lastResult;
    };

    this.activeWake = wakeCycle();
    try {
      const result = await this.activeWake;
      return result;
    } finally {
      if (this.activeWake) {
        this.activeWake = null;
      }
    }
  }

  private persistPendingWakeReasons(): void {
    this.runtimeLearning?.markHeartbeatPending?.(
      Array.from(this.pendingWakeReasons).sort(),
    );
  }

  // -----------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------

  private scheduleNextRun(): void {
    if (this.stopped) return;

    const config = getDistillationHeartbeatConfig(this.workingDirectory);
    const intervalDelay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, config.intervalHours * 60 * 60 * 1000),
    );

    let nextDelay: number;
    let wakeReason: RuntimeLearningReason;
    let isImmediateReschedule = false;
    try {
      const plan = this.getActivePlanner().plan();
      if (plan.nextWakeTime !== null) {
        const deadlineDelta = Math.max(0, plan.nextWakeTime - plan.now.getTime());
        if (deadlineDelta < intervalDelay) {
          nextDelay = deadlineDelta;
          wakeReason = plan.nextWakeReason as RuntimeLearningReason;
          if (deadlineDelta === 0) {
            isImmediateReschedule = true;
          }
        } else {
          nextDelay = intervalDelay;
          wakeReason = 'scheduled';
        }
      } else {
        nextDelay = intervalDelay;
        wakeReason = 'scheduled';
      }
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] planner failed: ${error?.message ?? error}; falling back to discovery interval`,
      );
      nextDelay = intervalDelay;
      wakeReason = 'scheduled';
    }

    // Retry/backoff guard: when the planner returns a due item already in
    // the past, the first immediate wake is allowed at 0ms (overdue work
    // SHOULD be processed immediately). Only repeated consecutive
    // immediate reschedules — indicating a persistent failure that keeps
    // re-queuing due work in the past — trigger an exponential backoff
    // floor so the scheduler cannot settle into a 0ms busy loop. The floor
    // grows from MIN_NEXT_WAKE_BACKOFF_MS up to MAX_NEXT_WAKE_BACKOFF_MS and
    // resets on the next normally-scheduled (non-immediate) wake.
    if (isImmediateReschedule) {
      this.consecutiveImmediateReschedules += 1;
      if (this.consecutiveImmediateReschedules > 1) {
        const backoffMs = Math.min(
          MAX_NEXT_WAKE_BACKOFF_MS,
          MIN_NEXT_WAKE_BACKOFF_MS * 2 ** (this.consecutiveImmediateReschedules - 2),
        );
        if (nextDelay < backoffMs) {
          Logger.info(
            `[DistillationHeartbeat] due work still in the past after ${this.consecutiveImmediateReschedules} consecutive immediate wakes; applying ${Math.round(backoffMs / 1000)}s backoff floor to avoid a busy loop`,
          );
          nextDelay = backoffMs;
        }
      }
    } else {
      this.consecutiveImmediateReschedules = 0;
    }

    this.runtimeLearning?.markHeartbeatScheduled?.(
      new Date(Date.now() + nextDelay),
      wakeReason,
      this.ownerLock ? {
        pid: this.ownerLock.record.pid,
        generation: this.ownerLock.generation,
        startedAt: this.ownerLock.record.startedAt,
        lastHeartbeatAt: this.ownerLock.record.lastHeartbeatAt,
      } : undefined,
    );

    this.timer = setTimeout(() => {
      const scheduledTask = (async () => {
        await this.runHeartbeat(wakeReason);
        if (!this.stopped) {
          this.scheduleNextRun();
        }
      })();

      this.trackScheduledWake(scheduledTask);
    }, nextDelay);
  }

  private trackScheduledWake(task: Promise<void>): void {
    const tracked = task.finally(() => {
      if (this.scheduledWake === tracked) this.scheduledWake = null;
    });
    this.scheduledWake = tracked;
  }

  private getActivePlanner(): DueWorkPlanner {
    return this.runtimeLearning.getPlanner();
  }

  private getSharedReviewDeadlineMs(): number {
    const config = this.runtimeLearning.getConfig();
    return Math.max(1, config.skillEvolutionReviewAttemptDeadlineMinutes * 60_000);
  }

}

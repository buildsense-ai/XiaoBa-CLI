import type { CloudBotModelSelection } from './cloud-client';

/**
 * A pending revision that keeps being deferred is a stuck switch, not a
 * transient one. This snapshot is what the caller reports upward when that
 * happens; ``idle`` is included because a runtime that never becomes idle is
 * the one case a retry can never resolve on its own.
 */
export interface DeferredStallInfo {
  pendingRevision: number;
  deferredMs: number;
  attempts: number;
  idle: boolean;
}

export interface CloudBotModelRuntimeReloadControllerOptions {
  initialRevision?: number;
  initialPendingRevision?: number;
  isActive?(): boolean;
  now?(): number;
  random?(): number;
  pullSelection(): Promise<CloudBotModelSelection | undefined>;
  isIdle(): boolean;
  applySelection(
    selection: CloudBotModelSelection,
    options?: { force?: boolean },
  ): Promise<'applied' | 'deferred'>;
  onError?(error: unknown, selection?: CloudBotModelSelection): void;
  /**
   * How long a pending revision may stay deferred before it is escalated through
   * onDeferredStalled. Escalation happens once per revision.
   */
  deferredStallMs?: number;
  /**
   * How long a pending revision may stay deferred before the controller stops
   * waiting for an idle runtime and applies it anyway.
   *
   * The idle fence exists so a reload never interrupts a live turn, so forcing
   * is only ever correct for a bot that is already broken: a model that answers
   * with errors holds sessions busy, and a busy runtime blocks the very switch
   * that would replace it. Without an escape hatch that loop cannot be broken
   * from inside the process. ``undefined`` disables forcing.
   */
  forceApplyAfterMs?: number;
  onDeferredStalled?(selection: CloudBotModelSelection, info: DeferredStallInfo): void;
  /**
   * Called right before a revision is applied past the idle fence, so the caller
   * can explain why a running turn is about to be interrupted.
   */
  onForcedApply?(selection: CloudBotModelSelection, info: DeferredStallInfo): void;
}

export interface CloudBotModelRuntimeReloadHealth {
  polling: boolean;
  createdAt: number;
  lastPollStartedAt?: number;
  lastPollCompletedAt?: number;
  handledRevision: number;
  pendingRevision?: number;
  pendingSince?: number;
  pendingAgeMs?: number;
  deferredMs?: number;
  deferredAttempts?: number;
  pollAgeMs: number;
}

const DEFAULT_DEFERRED_STALL_MS = 5 * 60_000;

/** Serializes cloud model polling and applies only the newest unhandled revision. */
export class CloudBotModelRuntimeReloadController {
  private readonly createdAt: number;
  private handledRevision: number;
  private pendingSelection?: CloudBotModelSelection;
  private pendingSince?: number;
  private lastPollStartedAt?: number;
  private lastPollCompletedAt?: number;
  private polling = false;
  private retryAt = 0;
  private retryAttempt = 0;
  /** When the current pending revision first had to wait, and how often. */
  private deferredRevision?: number;
  private deferredSince?: number;
  private deferredAttempts = 0;
  private stallReportedRevision?: number;
  private forcedRevision?: number;

  constructor(private readonly options: CloudBotModelRuntimeReloadControllerOptions) {
    this.createdAt = this.now();
    this.handledRevision = options.initialRevision
      ?? (options.initialPendingRevision !== undefined ? options.initialPendingRevision - 1 : -1);
  }

  /**
   * Returns a read-only snapshot for the connector watchdog. This deliberately
   * exposes state only; it never mutates or interrupts a running turn.
   */
  getHealth(now = this.now()): CloudBotModelRuntimeReloadHealth {
    const pendingRevision = this.pendingSelection?.revision;
    return {
      polling: this.polling,
      createdAt: this.createdAt,
      ...(this.lastPollStartedAt !== undefined ? { lastPollStartedAt: this.lastPollStartedAt } : {}),
      ...(this.lastPollCompletedAt !== undefined ? { lastPollCompletedAt: this.lastPollCompletedAt } : {}),
      handledRevision: this.handledRevision,
      ...(pendingRevision !== undefined ? { pendingRevision } : {}),
      ...(this.pendingSince !== undefined ? { pendingSince: this.pendingSince, pendingAgeMs: Math.max(0, now - this.pendingSince) } : {}),
      ...(this.deferredSince !== undefined
        ? { deferredMs: Math.max(0, now - this.deferredSince), deferredAttempts: this.deferredAttempts }
        : {}),
      pollAgeMs: Math.max(0, now - (this.lastPollCompletedAt ?? this.createdAt)),
    };
  }

  async pollOnce(): Promise<void> {
    if (this.polling || this.options.isActive?.() === false) return;
    this.polling = true;
    this.lastPollStartedAt = this.now();
    let selection: CloudBotModelSelection | undefined;
    try {
      selection = await this.options.pullSelection();
      if (this.options.isActive?.() === false) return;
      if (!selection) {
        this.pendingSelection = undefined;
        this.pendingSince = undefined;
        this.retryAt = this.retryAttempt = 0;
        return;
      }
      if (selection.revision > this.handledRevision) {
        if (!this.pendingSelection || selection.revision >= this.pendingSelection.revision) {
          if (selection.revision !== this.pendingSelection?.revision) {
            this.retryAt = this.retryAttempt = 0;
            this.pendingSince = this.now();
          }
          this.pendingSelection = selection;
        }
      }
      const pending = this.pendingSelection;
      if (!pending) return;
      const now = this.now();
      const idle = this.options.isIdle();
      if (!idle) this.noteDeferred(pending, now, idle);
      // A revision that has been waiting too long may cross the idle fence. The
      // fence protects a live turn, but a bot whose model answers with errors
      // stays busy because of those errors, so waiting can never converge.
      const force = !idle && this.mayForce(pending, now);
      if (!force && (!idle || now < this.retryAt)) return;
      if (force) this.noteForcedApply(pending);

      try {
        const outcome = await this.options.applySelection(
          pending,
          force ? { force: true } : undefined,
        );
        if (this.options.isActive?.() === false) return;
        if (outcome === 'deferred') {
          this.noteDeferred(pending, this.now(), this.options.isIdle());
          const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.retryAttempt++, 4));
          this.retryAt = (this.options.now?.() ?? Date.now())
            + Math.min(60_000, delay * (1 + (this.options.random?.() ?? Math.random()) * 0.2));
          return;
        }
        this.retryAt = this.retryAttempt = 0;
        this.handledRevision = Math.max(this.handledRevision, pending.revision);
        this.clearDeferred();
        if (this.pendingSelection?.revision === pending.revision) {
          this.pendingSelection = undefined;
          this.pendingSince = undefined;
        }
      } catch (error) {
        if (this.options.isActive?.() === false) return;
        // Keep the revision pending. An unexpected throw is not proof that the
        // revision can never be applied, and the previous code retired it here:
        // one throw pinned the bot to the old model for the life of the process
        // because handledRevision had already moved past it.
        // The backoff below is what keeps a repeatedly failing apply from
        // spinning, not dropping the revision.
        this.retryAttempt += 1;
        this.retryAt = this.now() + Math.min(60_000, 5_000 * 2 ** Math.min(this.retryAttempt - 1, 4));
        this.clearDeferred();
        this.options.onError?.(error, pending);
      }
    } catch (error) {
      this.options.onError?.(error, selection);
    } finally {
      this.lastPollCompletedAt = this.now();
      this.polling = false;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Records one wait on the current pending revision and escalates it once the
   * wait crosses the stall threshold, so a switch that never lands stops being
   * invisible.
   */
  private noteDeferred(
    selection: CloudBotModelSelection,
    now: number,
    idle: boolean,
  ): void {
    if (this.deferredRevision !== selection.revision || this.deferredSince === undefined) {
      this.deferredRevision = selection.revision;
      this.deferredSince = now;
      this.deferredAttempts = 0;
      this.stallReportedRevision = undefined;
    }
    this.deferredAttempts += 1;
    const stallMs = this.options.deferredStallMs ?? DEFAULT_DEFERRED_STALL_MS;
    if (this.stallReportedRevision === selection.revision) return;
    if (now - this.deferredSince < stallMs) return;
    this.stallReportedRevision = selection.revision;
    this.options.onDeferredStalled?.(selection, {
      pendingRevision: selection.revision,
      deferredMs: now - this.deferredSince,
      attempts: this.deferredAttempts,
      idle,
    });
  }

  /**
   * Whether the pending revision has waited long enough to be applied past the
   * idle fence. Each revision is forced at most once, so a runtime that still
   * defers after being forced falls back to plain waiting instead of repeatedly
   * tearing down conversations.
   */
  private mayForce(selection: CloudBotModelSelection, now: number): boolean {
    const forceAfterMs = this.options.forceApplyAfterMs;
    if (forceAfterMs === undefined) return false;
    if (this.forcedRevision === selection.revision) return false;
    if (this.deferredSince === undefined || this.deferredRevision !== selection.revision) return false;
    return now - this.deferredSince >= forceAfterMs;
  }

  private noteForcedApply(selection: CloudBotModelSelection): void {
    this.forcedRevision = selection.revision;
    if (this.deferredSince === undefined) return;
    this.options.onForcedApply?.(selection, {
      pendingRevision: selection.revision,
      deferredMs: this.now() - this.deferredSince,
      attempts: this.deferredAttempts,
      idle: false,
    });
  }

  private clearDeferred(): void {
    this.deferredRevision = undefined;
    this.deferredSince = undefined;
    this.deferredAttempts = 0;
    this.stallReportedRevision = undefined;
    this.forcedRevision = undefined;
  }
}

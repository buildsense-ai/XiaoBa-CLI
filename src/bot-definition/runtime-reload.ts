import type { CloudBotModelSelection } from './cloud-client';

export interface CloudBotModelRuntimeReloadControllerOptions {
  initialRevision?: number;
  initialPendingRevision?: number;
  isActive?(): boolean;
  now?(): number;
  random?(): number;
  pullSelection(): Promise<CloudBotModelSelection | undefined>;
  isIdle(): boolean;
  applySelection(selection: CloudBotModelSelection): Promise<'applied' | 'deferred'>;
  onError?(error: unknown, selection?: CloudBotModelSelection): void;
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
  pollAgeMs: number;
}

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
      if (!pending || !this.options.isIdle() || (this.options.now?.() ?? Date.now()) < this.retryAt) return;

      try {
        const outcome = await this.options.applySelection(pending);
        if (this.options.isActive?.() === false) return;
        if (outcome === 'deferred') {
          const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.retryAttempt++, 4));
          this.retryAt = (this.options.now?.() ?? Date.now())
            + Math.min(60_000, delay * (1 + (this.options.random?.() ?? Math.random()) * 0.2));
          return;
        }
        this.retryAt = this.retryAttempt = 0;
        this.handledRevision = Math.max(this.handledRevision, pending.revision);
        if (this.pendingSelection?.revision === pending.revision) {
          this.pendingSelection = undefined;
          this.pendingSince = undefined;
        }
      } catch (error) {
        if (this.options.isActive?.() === false) return;
        this.handledRevision = Math.max(this.handledRevision, pending.revision);
        if (this.pendingSelection?.revision === pending.revision) {
          this.pendingSelection = undefined;
          this.pendingSince = undefined;
        }
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
}

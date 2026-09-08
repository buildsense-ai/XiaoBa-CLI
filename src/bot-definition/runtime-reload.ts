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

/** Serializes cloud model polling and applies only the newest unhandled revision. */
export class CloudBotModelRuntimeReloadController {
  private handledRevision: number;
  private pendingSelection?: CloudBotModelSelection;
  private polling = false;
  private retryAt = 0;
  private retryAttempt = 0;

  constructor(private readonly options: CloudBotModelRuntimeReloadControllerOptions) {
    this.handledRevision = options.initialRevision
      ?? (options.initialPendingRevision !== undefined ? options.initialPendingRevision - 1 : -1);
  }

  async pollOnce(): Promise<void> {
    if (this.polling || this.options.isActive?.() === false) return;
    this.polling = true;
    let selection: CloudBotModelSelection | undefined;
    try {
      selection = await this.options.pullSelection();
      if (this.options.isActive?.() === false) return;
      if (!selection) {
        this.pendingSelection = undefined;
        this.retryAt = this.retryAttempt = 0;
        return;
      }
      if (selection.revision > this.handledRevision) {
        if (!this.pendingSelection || selection.revision >= this.pendingSelection.revision) {
          if (selection.revision !== this.pendingSelection?.revision) this.retryAt = this.retryAttempt = 0;
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
        }
      } catch (error) {
        if (this.options.isActive?.() === false) return;
        this.handledRevision = Math.max(this.handledRevision, pending.revision);
        if (this.pendingSelection?.revision === pending.revision) {
          this.pendingSelection = undefined;
        }
        this.options.onError?.(error, pending);
      }
    } catch (error) {
      this.options.onError?.(error, selection);
    } finally {
      this.polling = false;
    }
  }
}

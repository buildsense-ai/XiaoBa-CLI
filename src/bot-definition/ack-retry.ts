import type { CloudBotModelSelection } from './cloud-client';

export class CloudBotModelAckRetry {
  private pending?: { selection: CloudBotModelSelection; error: string; attempts: number };
  constructor(private readonly options: {
    isActive(): boolean;
    send(selection: CloudBotModelSelection, error: string): Promise<void>;
    onError?(error: unknown, selection: CloudBotModelSelection): void;
  }) {}

  schedule(selection: CloudBotModelSelection, error: string): void {
    if (!this.options.isActive() || (this.pending && this.pending.selection.revision > selection.revision)) return;
    this.pending = { selection, error, attempts: 0 };
  }

  clear(selection: CloudBotModelSelection): void {
    if (this.pending?.selection.revision === selection.revision) this.pending = undefined;
  }

  observe(selection: CloudBotModelSelection | undefined): void {
    if (!selection || (this.pending && selection.revision > this.pending.selection.revision)) this.pending = undefined;
  }

  async retry(): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.options.isActive()) return;
    try {
      await this.options.send(pending.selection, pending.error);
      if (this.options.isActive() && this.pending === pending) this.pending = undefined;
    } catch (error) {
      if (!this.options.isActive() || this.pending !== pending) return;
      if (++pending.attempts % 12 === 0) this.options.onError?.(error, pending.selection);
    }
  }
}

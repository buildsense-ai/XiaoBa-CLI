import {
  fingerprintRuntimeFeedback,
  formatRuntimeFeedback,
  RuntimeFeedbackFormatOptions,
} from './runtime-feedback';

const DEFAULT_DEDUPE_MS = 5 * 60 * 1000;

export interface RuntimeFeedbackOptions extends RuntimeFeedbackFormatOptions {
  dedupeMs?: number;
}

export interface RuntimeFeedbackInput extends RuntimeFeedbackOptions {
  source: string;
  message: string;
}

/**
 * Turn-scoped inbox for runtime observation that should be visible to the agent.
 *
 * The public type names still use "Feedback" for compatibility with existing
 * adapters/tests, but the boundary is: runtime/platform facts in, transient
 * model-visible observation out. It is not a user feedback feature.
 *
 * It owns buffering and dedupe only. Callers still decide when feedback is
 * consumed and where it is inserted into the provider input.
 */
export class RuntimeFeedbackInbox {
  private seen = new Map<string, number>();
  private pending: string[] = [];

  enqueue(
    source: string,
    message: string,
    options: RuntimeFeedbackOptions = {},
  ): boolean {
    const feedback = formatRuntimeFeedback(source, message, options);
    if (!feedback) return false;

    const now = Date.now();
    const dedupeMs = options.dedupeMs ?? DEFAULT_DEDUPE_MS;
    const fingerprint = fingerprintRuntimeFeedback(source, message);
    this.pruneDedupe(now, dedupeMs);

    const lastSeenAt = this.seen.get(fingerprint);
    if (lastSeenAt && now - lastSeenAt < dedupeMs) {
      return false;
    }

    this.pending.push(feedback);
    this.seen.set(fingerprint, now);
    return true;
  }

  consume(inputs: RuntimeFeedbackInput[] = []): string[] {
    for (const feedback of inputs) {
      this.enqueue(feedback.source, feedback.message, feedback);
    }

    const feedback = this.pending;
    this.pending = [];
    return feedback;
  }

  reset(): void {
    this.pending = [];
    this.seen.clear();
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  getPendingSnapshot(): string[] {
    return [...this.pending];
  }

  private pruneDedupe(now: number, dedupeMs: number): void {
    for (const [fingerprint, seenAt] of this.seen) {
      if (now - seenAt >= dedupeMs) {
        this.seen.delete(fingerprint);
      }
    }
  }
}

import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import type { ToolSurface } from '../types/tool';
import {
  VisibleProgressEvent,
  VisibleProgressRecentContextItem,
  VisibleProgressSnapshot,
  VisibleProgressTurnState,
} from './visible-progress-types';
import {
  startVisibleProgressSidecarBranch,
  VisibleProgressSidecarBranchHandle,
} from './sidecar-visible-progress-branch';
import { VisibleProgressFinishPayload } from '../tools/visible-progress-tools';

export interface VisibleProgressRuntimeOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  surface?: ToolSurface;
  signal?: AbortSignal;
  logEnabled?: boolean;
  maxSidecarRuns?: number;
  onProgress: (text: string) => void | Promise<void>;
}

export class VisibleProgressRuntime {
  private readonly events: VisibleProgressEvent[] = [];
  private readonly emittedProgress: string[] = [];
  private readonly maxSidecarRuns: number;
  private active: VisibleProgressSidecarBranchHandle | null = null;
  private dirty = false;
  private closed = false;
  private runCount = 0;

  constructor(private readonly options: VisibleProgressRuntimeOptions) {
    this.maxSidecarRuns = Math.max(1, options.maxSidecarRuns ?? 3);
  }

  recordEvent(event: VisibleProgressEvent): void {
    if (this.closed) return;
    this.events.push({
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    });
    while (this.events.length > 20) this.events.shift();

    if (this.active) {
      this.dirty = true;
      return;
    }
    this.startSidecar();
  }

  close(reason = 'turn_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.active?.cancel();
    this.active = null;
    Logger.info(`[${this.options.sessionKey}] visible progress runtime closed: ${reason}`);
  }

  async waitForIdle(timeoutMs = 2000): Promise<void> {
    const started = Date.now();
    while (this.active || this.dirty) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('visible progress runtime did not become idle before timeout');
      }
      const active = this.active;
      if (active) {
        await active.done.catch(() => null);
      } else {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  private startSidecar(): void {
    if (this.closed || this.active || this.runCount >= this.maxSidecarRuns) return;
    this.runCount++;
    this.dirty = false;

    const handle = startVisibleProgressSidecarBranch({
      sessionKey: this.options.sessionKey,
      snapshot: this.buildSnapshot(),
      workingDirectory: this.options.workingDirectory,
      aiService: this.options.aiService,
      signal: this.options.signal,
      logEnabled: this.options.logEnabled,
    });
    this.active = handle;

    handle.done
      .then(payload => this.handlePayload(payload))
      .catch(error => {
        if (!this.closed) {
          Logger.warning(`[${this.options.sessionKey}] visible progress branch failed: ${error.message}`);
        }
      })
      .finally(() => {
        if (this.active === handle) {
          this.active = null;
        }
        if (!this.closed && this.dirty && this.runCount < this.maxSidecarRuns) {
          this.startSidecar();
        } else if (this.runCount >= this.maxSidecarRuns) {
          this.dirty = false;
        }
      });
  }

  private async handlePayload(payload: VisibleProgressFinishPayload | null): Promise<void> {
    if (this.closed || !payload || payload.action !== 'emit') return;
    const text = sanitizeProgressText(payload.text);
    if (!text || this.emittedProgress.includes(text)) return;

    this.emittedProgress.push(text);
    while (this.emittedProgress.length > 5) this.emittedProgress.shift();

    try {
      await this.options.onProgress(text);
      Logger.info(`[${this.options.sessionKey}] visible progress emitted: ${text}`);
    } catch (error: any) {
      Logger.warning(`[${this.options.sessionKey}] visible progress send failed: ${error.message}`);
    }
  }

  private buildSnapshot(): VisibleProgressSnapshot {
    return {
      currentUserInput: contentToText(this.options.input),
      surface: this.options.surface,
      recentContext: extractRecentContext(this.options.recentMessages),
      emittedProgress: [...this.emittedProgress],
      turnState: buildTurnState(this.emittedProgress.length),
      events: this.events.slice(-8),
    };
  }
}

function buildTurnState(emittedCount: number): VisibleProgressTurnState {
  if (emittedCount === 0) {
    return {
      emittedCount,
      shouldBeConservative: false,
      emitAgainPolicy: [
        'No progress update has been shown yet this turn.',
        'Turn start alone is not enough reason to emit.',
        'Skip for quick direct answers or short chat that likely needs no local work and no long wait.',
        'Emit only when a short update helps the user understand that visible work is starting.',
      ].join(' '),
    };
  }

  return {
    emittedCount,
    shouldBeConservative: true,
    emitAgainPolicy: [
      'A progress update has already been shown this turn.',
      'Default to skip routine tool start/end events, repeated planning, or restating the same intent.',
      'Emit again only for a clear new phase such as moving to verification, retrying after failure, or a meaningfully long wait.',
    ].join(' '),
  };
}

function sanitizeProgressText(value: unknown): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= 160 ? text : `${text.slice(0, 160)}...`;
}

function extractRecentContext(messages: Message[]): VisibleProgressRecentContextItem[] {
  return messages
    .filter(message => (
      (message.role === 'user' || message.role === 'assistant')
      && !message.__injected
      && !message.__runtimeFeedback
      && !message.__syntheticObservation
      && !message.__runtimeObservation
    ))
    .slice(-4)
    .map(message => ({
      role: message.role,
      content: truncate(contentToText(message.content), 300),
    }))
    .filter(item => item.content.length > 0);
}

function contentToText(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '[image]').join('\n');
}

function truncate(value: string, maxLength: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

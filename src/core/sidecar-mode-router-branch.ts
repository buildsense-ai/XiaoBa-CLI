import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { SyntheticObservationQueue } from './synthetic-observation';
import { ModeRouterBranchSession } from './mode-router-branch-session';
import { PromptModeRuntimeState } from './prompt-mode-runtime';

export interface ModeRouterSidecarBranchOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  queue: SyntheticObservationQueue;
  activeMode?: PromptModeRuntimeState | null;
  signal?: AbortSignal;
  logEnabled?: boolean;
  modelTimeoutMs?: number;
}

export interface ModeRouterSidecarBranchHandle {
  cancel(): void;
  done: Promise<void>;
}

export function startModeRouterSidecarBranch(
  options: ModeRouterSidecarBranchOptions,
): ModeRouterSidecarBranchHandle {
  const controller = new AbortController();
  const signal = linkAbortSignals(controller.signal, options.signal);
  const session = new ModeRouterBranchSession({
    ...options,
    signal,
  });
  const done = session.run().catch(error => {
    if (isAbortError(error) || signal.aborted) return;
    Logger.warning(`[${options.sessionKey}] prompt mode router branch failed: ${error.message}`);
  });

  return {
    cancel: () => {
      controller.abort();
      session.stop();
    },
    done,
  };
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError' || /aborted|aborterror|canceled|cancelled/i.test(String(error?.message || ''));
}

import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { SyntheticObservationQueue } from './synthetic-observation';
import { MemorySearchBranchSession } from './memory-search-branch-session';

export interface MemorySidecarBranchOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  queue: SyntheticObservationQueue;
  signal?: AbortSignal;
  logEnabled?: boolean;
  modelTimeoutMs?: number;
}

export interface MemorySidecarBranchHandle {
  cancel(): void;
  done: Promise<void>;
}

export function startMemorySidecarBranch(options: MemorySidecarBranchOptions): MemorySidecarBranchHandle {
  const controller = new AbortController();
  const signal = linkAbortSignals(controller.signal, options.signal);
  const session = new MemorySearchBranchSession({
    ...options,
    signal,
  });
  const done = session.run().catch(error => {
    if (isAbortError(error) || signal.aborted) return;
    Logger.warning(`[${options.sessionKey}] memory branch failed: ${error.message}`);
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

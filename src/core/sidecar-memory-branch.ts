import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { SyntheticObservationQueue } from './synthetic-observation';
import { MemorySearchBranchSession } from './memory-search-branch-session';
import type { ObservationBranchCompletion } from './observation-branch-session';
import type { MemoryLogStore } from './memory-log-store';

export interface MemorySidecarBranchOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  queue: SyntheticObservationQueue;
  signal?: AbortSignal;
  logEnabled?: boolean;
  cachePartitionKey?: string;
  trustedSystemPrefix?: string;
  memoryLogStore?: MemoryLogStore;
}

export interface MemorySidecarBranchHandle {
  branchId: string;
  cancel(): void;
  done: Promise<ObservationBranchCompletion>;
}

export function startMemorySidecarBranch(options: MemorySidecarBranchOptions): MemorySidecarBranchHandle {
  const controller = new AbortController();
  const signal = linkAbortSignals(controller.signal, options.signal);
  const session = new MemorySearchBranchSession({
    ...options,
    signal,
  });
  const done = session.run().catch(error => {
    if (!isAbortError(error) && !signal.aborted) {
      Logger.warning(`[${options.sessionKey}] memory branch failed: ${error.message}`);
    }
    return {
      branchId: session.branchId,
      branchType: session.branchType,
      status: signal.aborted || isAbortError(error) ? 'cancelled' as const : 'failed' as const,
      toolNames: [],
      ...(!signal.aborted && !isAbortError(error) ? {
        errorCode: 'branch_execution_failed' as const,
      } : {}),
    };
  });

  return {
    branchId: session.branchId,
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

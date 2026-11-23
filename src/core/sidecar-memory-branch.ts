import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { SyntheticObservationQueue } from './synthetic-observation';
import { MemorySearchBranchSession } from './memory-search-branch-session';
import { WikiSearchBranchSession } from './wiki-search-branch-session';
import { CreditTaskRuntime, currentCreditTask, isCatsCoCreditProvider } from './credit-task-runtime';
import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import type { MondayWikiMemory } from '../utils/monday-wiki-memory';

export interface MemoryBranchPreviousInjection {
  summary: string;
  refs: string[];
}

export interface MemoryBranchActivationContext {
  taskAnchor: string;
  deltaSinceLastRun: Array<Record<string, unknown>>;
  previousInjections: MemoryBranchPreviousInjection[];
}

export interface MemorySidecarContext {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  queue: SyntheticObservationQueue;
  signal?: AbortSignal;
  logEnabled?: boolean;
  activationContext?: MemoryBranchActivationContext;
}

export type MemorySidecarBranchOptions = MemorySidecarContext & (
  | { kind?: 'memory'; catslogMemory?: CatsLogMemoryBackend }
  | { kind: 'wiki'; wikiMemory: MondayWikiMemory }
);

export interface MemorySidecarBranchHandle {
  cancel(): void;
  done: Promise<void>;
}

export function startMemorySidecarBranch(options: MemorySidecarBranchOptions): MemorySidecarBranchHandle {
  const controller = new AbortController();
  const signal = linkAbortSignals(controller.signal, options.signal);
  const session = options.kind === 'wiki'
    ? new WikiSearchBranchSession({ ...options, signal })
    : new MemorySearchBranchSession({ ...options, signal });
  const run = () => session.run();
  const done = (options.kind === 'wiki' ? runWikiSession(run, options.aiService) : run()).catch(error => {
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

async function runWikiSession(run: () => Promise<void>, aiService: AIService): Promise<void> {
  const config = aiService.getConfig?.();
  if (!config || !isCatsCoCreditProvider(config)) return run();
  const parent = currentCreditTask();
  if (parent) return parent.child(run);
  const task = new CreditTaskRuntime(config);
  try {
    await task.run(run);
  } finally {
    if (task.snapshot.startSent) await task.complete();
  }
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

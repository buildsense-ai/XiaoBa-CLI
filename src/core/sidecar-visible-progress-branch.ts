import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { VisibleProgressSnapshot } from './visible-progress-types';
import { VisibleProgressBranchSession } from './visible-progress-branch-session';
import { VisibleProgressFinishPayload } from '../tools/visible-progress-tools';

export interface VisibleProgressSidecarBranchOptions {
  sessionKey: string;
  snapshot: VisibleProgressSnapshot;
  workingDirectory: string;
  aiService: AIService;
  signal?: AbortSignal;
  logEnabled?: boolean;
}

export interface VisibleProgressSidecarBranchHandle {
  cancel(): void;
  done: Promise<VisibleProgressFinishPayload | null>;
}

export function startVisibleProgressSidecarBranch(
  options: VisibleProgressSidecarBranchOptions,
): VisibleProgressSidecarBranchHandle {
  const controller = new AbortController();
  const signal = linkAbortSignals(controller.signal, options.signal);
  const session = new VisibleProgressBranchSession({
    ...options,
    signal,
  });
  const done = session.run().catch(error => {
    if (isAbortError(error) || signal.aborted) return null;
    Logger.warning(`[${options.sessionKey}] visible progress branch failed: ${error.message}`);
    return null;
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

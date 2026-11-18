import { randomUUID } from 'node:crypto';
import type { MemoryBranchEvent } from './memory-branch-presentation';
import { ContentBlock, Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { SyntheticObservation, SyntheticObservationQueue } from './synthetic-observation';
import { MemorySearchBranchSession } from './memory-search-branch-session';
import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';
import type { MemoryBranchBudget } from './branch-budget';
import type {
  MemoryBranchFinding,
  MemoryBranchPublishResult,
  MemoryBranchScope,
  MemoryBranchSessionEvent,
} from './session-memory-branch';
import type { BranchTermination } from './observation-branch-session';

export interface MemoryBranchPreviousInjection {
  summary: string;
  refs: string[];
}

export interface MemoryBranchActivationContext {
  taskAnchor: string;
  deltaSinceLastRun: Array<Record<string, unknown>>;
  previousInjections: MemoryBranchPreviousInjection[];
}

/**
 * Session-scoped hooks. The Branch publishes claims on its own, reconfirms or
 * withdraws held observations after consuming a new input, and reports the
 * input sequence it actually verified against.
 */
export interface MemoryBranchSessionContext {
  inputSequence: number;
  originTurn: number;
  originTurnId: string;
  scope: MemoryBranchScope;
  takeEvents: () => MemoryBranchSessionEvent[];
  heldObservations: () => Array<{
    observationId: string;
    claimKey: string;
    subject: string;
    claim: string;
    qualification?: string;
    refs: string[];
    verifiedThroughInput: number;
    originTurn: number;
    reason?: string;
  }>;
  currentInputSequence: () => number;
  publish: (finding: MemoryBranchFinding, branchId: string, verifiedThroughInput: number, observation?: SyntheticObservation) => MemoryBranchPublishResult;
  reconfirm: (observationId: string, sequence: number) => MemoryBranchPublishResult;
  withdraw: (observationId: string, reason: string) => MemoryBranchPublishResult;
}

export interface MemorySidecarBranchOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  aiService: AIService;
  queue: SyntheticObservationQueue;
  signal?: AbortSignal;
  logEnabled?: boolean;
  activationContext?: MemoryBranchActivationContext;
  catslogMemory?: CatsLogMemoryBackend;
  onPresentation?: (event: MemoryBranchEvent) => void;
  /** Per-investigation ceiling; the Branch exits through the normal path. */
  budget?: MemoryBranchBudget;
  session?: MemoryBranchSessionContext;
  metrics?: import('../utils/metrics').MetricsCollector;
}

export interface MemorySidecarBranchHandle {
  branchId: string;
  cancel(): void;
  done: Promise<void>;
  outcome(): BranchTermination;
}

export function startMemorySidecarBranch(options: MemorySidecarBranchOptions): MemorySidecarBranchHandle {
  const controller = new AbortController();
  const signal = linkAbortSignals(controller.signal, options.signal);
  const branchId = `memory-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const session = new MemorySearchBranchSession({
    ...options,
    branchId,
    signal,
    budget: options.budget,
    session: options.session,
    metrics: options.metrics,
  });
  let outcome: BranchTermination = 'running';
  const done = session.run().then(() => {
    outcome = session.branchTermination;
  }).catch(error => {
    outcome = isAbortError(error) || signal.aborted ? 'cancelled' : 'failed';
    if (outcome !== 'cancelled') Logger.warning(`[${options.sessionKey}] memory branch failed: ${error.message}`);
  }).finally(() => {
    if (outcome === 'running') outcome = session.branchTermination;
  });

  return {
    branchId,
    cancel: () => {
      controller.abort();
      session.stop();
    },
    done,
    outcome: () => outcome === 'running' ? session.branchTermination : outcome,
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

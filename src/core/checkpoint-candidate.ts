import { createHash } from 'node:crypto';
import type { Message, TokenUsage } from '../types';
import type { ProviderRequestBudget } from '../providers/provider';
import type {
  CheckpointCompactionCoordinator,
  CheckpointCompactionRequest,
} from './checkpoint-compaction';
import { estimateMessagesTokens } from './token-estimator';

export const CHECKPOINT_SUMMARY_START_RATIO = 0.75;
export const CHECKPOINT_SUMMARY_STOP_RATIO = 0.85;
export const CHECKPOINT_CANDIDATE_DEADLINE_MS = 15 * 60 * 1000;
const CHECKPOINT_CANDIDATE_MAX_ATTEMPTS = 3;

export type CheckpointCandidateFailureReason = 'authentication' | 'transient' | 'invalid' | 'deadline';

export type CheckpointCandidateStatus =
  | 'running'
  | 'ready'
  | 'cancelled'
  | 'stale'
  | 'committed'
  | 'failed';

export interface CheckpointSnapshot {
  readonly revision: number;
  readonly episodeId?: string;
  readonly messages: readonly Message[];
  readonly durableHash: string;
  readonly boundaryMessageCount: number;
  readonly usedTokens: number;
  readonly startedAt: number;
}

export interface CheckpointCandidateResult {
  readonly status: CheckpointCandidateStatus;
  readonly candidateId: string;
  readonly reason?: 'revision_mismatch' | 'episode_mismatch' | 'boundary_mismatch' | 'cancelled';
  readonly messages?: Message[];
}

/**
 * Pure lifecycle and compare-and-swap guard for an asynchronous checkpoint.
 * It deliberately does not call a model, mutate the parent transcript, or persist data.
 */
export class CheckpointCandidate {
  private _status: CheckpointCandidateStatus = 'running';
  private _result: Message[] | undefined;
  private _attempts = 0;
  private _readyAt: number | undefined;
  private _settledAt: number | undefined;
  private _summaryUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private _summaryAttempts = 0;
  private _stopReachedAt: number | undefined;
  private _failureReason: CheckpointCandidateFailureReason | undefined;
  private _providerRequestBudget: ProviderRequestBudget | undefined;

  constructor(
    readonly id: string,
    readonly snapshot: CheckpointSnapshot,
  ) {}

  get status(): CheckpointCandidateStatus {
    return this._status;
  }

  get result(): readonly Message[] | undefined {
    return this._result;
  }

  get attempts(): number {
    return this._attempts;
  }

  get readyAt(): number | undefined {
    return this._readyAt;
  }

  get settledAt(): number | undefined {
    return this._settledAt;
  }

  get summaryUsage(): Readonly<TokenUsage> {
    return this._summaryUsage;
  }

  get summaryAttempts(): number {
    return this._summaryAttempts;
  }

  get stopReachedAt(): number | undefined {
    return this._stopReachedAt;
  }

  markStopReached(at = Date.now()): void {
    this._stopReachedAt ??= at;
  }

  get failureReason(): CheckpointCandidateFailureReason | undefined {
    return this._failureReason;
  }

  get providerRequestBudget(): Readonly<ProviderRequestBudget> | undefined {
    return this._providerRequestBudget;
  }

  complete(messages: Message[]): boolean {
    if (this._status !== 'running') return false;
    this._result = cloneMessages(messages);
    this._status = 'ready';
    this._readyAt = Date.now();
    return true;
  }

  fail(reason: CheckpointCandidateFailureReason = 'invalid'): boolean {
    if (this._status !== 'running') return false;
    this._status = 'failed';
    this._failureReason = reason;
    this._settledAt = Date.now();
    return true;
  }

  /** Generate a candidate without touching the parent transcript. */
  async generate(
    coordinator: Pick<CheckpointCompactionCoordinator, 'compactIfNeeded'>,
    request: Omit<CheckpointCompactionRequest, 'signal'> & { signal?: AbortSignal },
  ): Promise<boolean> {
    if (this._status !== 'running') return false;
    const deadlineAt = this.snapshot.startedAt + CHECKPOINT_CANDIDATE_DEADLINE_MS;
    this._providerRequestBudget = request.providerRequestBudget;
    let failureReason: CheckpointCandidateFailureReason = 'invalid';
    for (let attempt = 1; attempt <= CHECKPOINT_CANDIDATE_MAX_ATTEMPTS; attempt++) {
      if (Date.now() >= deadlineAt || request.signal?.aborted || this._status !== 'running') {
        failureReason = 'deadline';
        break;
      }
      this._attempts = attempt;
      try {
        const result = await coordinator.compactIfNeeded([...this.snapshot.messages], {
          ...request,
          signal: request.signal,
          metricsContext: {
            ...(request.metricsContext || {}),
            attempt,
            providerRequest: request.providerRequestBudget?.usedRequests,
          },
        });
        if (this._status !== 'running') return false;
        this.accumulateSummaryUsage(result.summaryUsage, result.summaryAttempts);
        if (result.compacted) return this.complete(result.messages);
        if (result.error && isAuthenticationError(result.error)) {
          failureReason = 'authentication';
          break;
        }
        if (result.error && !isRetryableCandidateError(result.error)) break;
        if (result.error) failureReason = 'transient';
        if (attempt === CHECKPOINT_CANDIDATE_MAX_ATTEMPTS) break;
      } catch (error) {
        if (isAuthenticationError(error)) {
          failureReason = 'authentication';
          break;
        }
        if (!isRetryableCandidateError(error)) break;
        failureReason = 'transient';
      }
    }
    this.fail(failureReason);
    return false;
  }

  private accumulateSummaryUsage(usage?: TokenUsage, attempts?: number): void {
    this._summaryAttempts += Math.max(0, Math.floor(attempts || 0));
    if (!usage) return;
    this._summaryUsage = {
      promptTokens: this._summaryUsage.promptTokens + usage.promptTokens,
      completionTokens: this._summaryUsage.completionTokens + usage.completionTokens,
      totalTokens: this._summaryUsage.totalTokens + usage.totalTokens,
      cachedReadTokens: (this._summaryUsage.cachedReadTokens || 0) + (usage.cachedReadTokens || 0),
      cachedWriteTokens: (this._summaryUsage.cachedWriteTokens || 0) + (usage.cachedWriteTokens || 0),
    };
  }

  cancel(): boolean {
    if (this._status === 'committed' || this._status === 'stale' || this._status === 'failed') return false;
    this._status = 'cancelled';
    this._settledAt = Date.now();
    return true;
  }

  /** Prepare a CAS result without marking it committed before persistence succeeds. */
  prepareCommit(
    currentMessages: readonly Message[],
    currentRevision: number,
    currentEpisodeId?: string,
  ): CheckpointCandidateResult {
    if (this._status === 'cancelled') {
      return this.outcome('cancelled');
    }
    if (this._status !== 'ready' || !this._result) {
      return this.outcome();
    }
    const reason = compareSnapshotBoundary(this.snapshot, currentMessages, currentRevision, currentEpisodeId);
    if (reason) {
      this._status = 'stale';
      this._settledAt = Date.now();
      return this.outcome(reason);
    }
    const suffix = currentMessages.slice(this.snapshot.boundaryMessageCount);
    return this.outcome(undefined, cloneMessages([...this._result, ...suffix]));
  }

  confirmCommit(): boolean {
    if (this._status !== 'ready') return false;
    this._status = 'committed';
    this._settledAt = Date.now();
    return true;
  }

  /** Convenience helper for callers that do not have a persistence phase. */
  tryCommit(
    currentMessages: readonly Message[],
    currentRevision: number,
    currentEpisodeId?: string,
  ): CheckpointCandidateResult {
    const prepared = this.prepareCommit(currentMessages, currentRevision, currentEpisodeId);
    if (!prepared.messages || !this.confirmCommit()) return prepared;
    return { ...prepared, status: this._status };
  }

  private outcome(
    reason?: CheckpointCandidateResult['reason'],
    messages?: Message[],
  ): CheckpointCandidateResult {
    return { status: this._status, candidateId: this.id, ...(reason ? { reason } : {}), ...(messages ? { messages } : {}) };
  }
}

function isAuthenticationError(error: unknown): boolean {
  const status = readErrorStatus(error);
  return status === 401 || status === 403;
}

function isRetryableCandidateError(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (status && [408, 429, 500, 502, 503, 504, 520, 524, 529].includes(status)) return true;
  const text = String((error as any)?.message || error || '');
  return /timeout|timed out|temporar|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|stream ended without a terminal response|missing terminal response|empty summary|empty response|returned an empty summary|checkpoint compaction returned an empty summary/i.test(text);
}

function readErrorStatus(error: unknown): number | undefined {
  const value = Number(
    (error as any)?.status
    ?? (error as any)?.statusCode
    ?? (error as any)?.response?.status,
  );
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createCheckpointSnapshot(
  messages: readonly Message[],
  options: { revision: number; episodeId?: string; startedAt?: number },
): CheckpointSnapshot {
  const copy = cloneMessages(messages);
  const frozenMessages = freezeMessages(copy);
  return Object.freeze({
    revision: options.revision,
    ...(options.episodeId ? { episodeId: options.episodeId } : {}),
    messages: frozenMessages,
    durableHash: hashMessages(frozenMessages),
    boundaryMessageCount: frozenMessages.length,
    usedTokens: estimateMessagesTokens([...frozenMessages]),
    startedAt: options.startedAt ?? Date.now(),
  });
}

export function compareSnapshotBoundary(
  snapshot: CheckpointSnapshot,
  currentMessages: readonly Message[],
  currentRevision: number,
  currentEpisodeId?: string,
): CheckpointCandidateResult['reason'] | undefined {
  if (currentRevision !== snapshot.revision) return 'revision_mismatch';
  // A candidate may start before the current root turn is stamped. In that
  // case the snapshot has no episode identity; revision and prefix hash still
  // provide the CAS guard, while a stamped snapshot must match exactly.
  if (snapshot.episodeId !== undefined && currentEpisodeId !== snapshot.episodeId) return 'episode_mismatch';
  if (currentMessages.length < snapshot.boundaryMessageCount) return 'boundary_mismatch';
  const prefix = currentMessages.slice(0, snapshot.boundaryMessageCount);
  if (hashMessages(prefix) !== snapshot.durableHash) return 'boundary_mismatch';
  return undefined;
}

export function hashMessages(messages: readonly Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

export function hasCompleteToolExchanges(messages: readonly Message[]): boolean {
  const expected = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) {
        if (!call.id || expected.has(call.id)) return false;
        expected.add(call.id);
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    if (!message.tool_call_id || !expected.delete(message.tool_call_id)) return false;
  }
  return expected.size === 0;
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map(message => ({
    ...message,
    ...(Array.isArray(message.content) ? {
      content: message.content.map(block => ({
        ...block,
        ...(block.type === 'image' ? { source: { ...block.source } } : {}),
      })),
    } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })),
    } : {}),
    ...(message.providerContent ? {
      providerContent: message.providerContent.map(block => structuredClone(block)),
    } : {}),
    ...(message.providerState ? { providerState: { ...message.providerState } } : {}),
    ...(message.__remoteContextWatermarks ? {
      __remoteContextWatermarks: { ...message.__remoteContextWatermarks },
    } : {}),
  }));
}

function freezeMessages(messages: Message[]): readonly Message[] {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'image') Object.freeze(block.source);
        Object.freeze(block);
      }
      Object.freeze(message.content);
    }
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        Object.freeze(call.function);
        Object.freeze(call);
      }
      Object.freeze(message.tool_calls);
    }
    if (message.providerContent) {
      for (const block of message.providerContent) deepFreeze(block);
      Object.freeze(message.providerContent);
    }
    if (message.providerState) Object.freeze(message.providerState);
    if (message.__remoteContextWatermarks) Object.freeze(message.__remoteContextWatermarks);
    Object.freeze(message);
  }
  return Object.freeze(messages);
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

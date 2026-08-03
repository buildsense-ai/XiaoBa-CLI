import { createHash } from 'node:crypto';
import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { readRequiredBundledPromptFile } from '../utils/prompt-template';
import { collectRemoteContextWatermarks } from './remote-context-watermarks';
import { estimateMessagesTokens } from './token-estimator';

export const CHECKPOINT_COMPACTION_BOUNDARY_PREFIX = '[checkpoint_compaction_boundary]';
export const CHECKPOINT_SUMMARY_PREFIX = [
  'Another language model started to solve this problem and produced a continuation summary.',
  'You also have access to the state of the tools that were used by that language model.',
  'Use this summary to continue the same task without repeating completed work:',
].join(' ');

const DEFAULT_COMPACTION_THRESHOLD = 0.8;
const MIN_RETAINED_USER_TOKEN_BUDGET = 8_000;
const MAX_RETAINED_USER_TOKEN_BUDGET = 32_000;
const RETAINED_USER_CONTEXT_RATIO = 0.15;
const DEFAULT_RETAINED_CONTEXT_MESSAGE_LIMIT = 8;
const MAX_CONTEXT_RETRY_ATTEMPTS = 6;
const MAX_SUMMARY_TOOL_RESULT_CHARS = 24_000;
const SUMMARY_TOOL_RESULT_HEAD_CHARS = 16_000;
const SUMMARY_TOOL_RESULT_TAIL_CHARS = 4_000;
const CHECKPOINT_TOOL_EVIDENCE_PREFIX = '[checkpoint_tool_evidence]';
const CHECKPOINT_USER_INPUT_EVIDENCE_PREFIX = '[checkpoint_user_input_evidence]';

export type CheckpointCompactionPhase = 'pre_turn' | 'mid_turn' | 'restore';

export interface CheckpointCompactionCoordinatorOptions {
  maxContextTokens: number;
  compactionThreshold?: number;
  retainedUserTokenBudget?: number;
}

export interface CheckpointCompactionRequest {
  sessionKey: string;
  phase: CheckpointCompactionPhase;
  toolTokens?: number;
  signal?: AbortSignal;
  onStatus?: (event: CheckpointCompactionStatusEvent) => void | Promise<void>;
}

export interface CheckpointCompactionStatusEvent {
  status: 'start' | 'complete' | 'error';
  sessionKey: string;
  phase: CheckpointCompactionPhase;
  usedTokens: number;
  toolTokens: number;
  maxTokens: number;
  usagePercent: number;
  messageCount?: number;
  error?: unknown;
}

export interface CheckpointCompactionResult {
  messages: Message[];
  compacted: boolean;
  usedTokens: number;
  toolTokens: number;
  maxTokens: number;
  usagePercent: number;
}

export function isCheckpointCompactionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED !== 'false';
}

/**
 * Codex-style continuation compaction for the main Agent.
 *
 * The coordinator summarizes durable transcript only, retains the user inputs
 * needed to continue the active task, and leaves transient runtime facts out of
 * the durable checkpoint. Legacy compaction remains available behind the
 * XIAOBA_CHECKPOINT_COMPACTION_ENABLED=false rollback switch.
 */
export class CheckpointCompactionCoordinator {
  private readonly maxContextTokens: number;
  private readonly compactionThreshold: number;
  private readonly retainedUserTokenBudget: number;

  constructor(
    private readonly aiService: AIService,
    options: CheckpointCompactionCoordinatorOptions,
  ) {
    this.maxContextTokens = Math.max(1, Math.floor(options.maxContextTokens));
    this.compactionThreshold = readRatio(
      options.compactionThreshold,
      DEFAULT_COMPACTION_THRESHOLD,
    );
    this.retainedUserTokenBudget = Math.max(
      1_000,
      Math.floor(
        options.retainedUserTokenBudget
        ?? defaultRetainedUserTokenBudget(this.maxContextTokens),
      ),
    );
  }

  getUsageInfo(messages: Message[], toolTokens = 0): {
    usedTokens: number;
    toolTokens: number;
    maxTokens: number;
    usagePercent: number;
  } {
    const usedTokens = estimateMessagesTokens(splitDurableAndTransient(messages).durable);
    const safeToolTokens = Math.max(0, Math.floor(toolTokens));
    return {
      usedTokens,
      toolTokens: safeToolTokens,
      maxTokens: this.maxContextTokens,
      usagePercent: Math.round(((usedTokens + safeToolTokens) / this.maxContextTokens) * 100),
    };
  }

  needsCompaction(messages: Message[], toolTokens = 0): boolean {
    const usage = this.getUsageInfo(messages, toolTokens);
    return usage.usedTokens + usage.toolTokens
      > this.maxContextTokens * this.compactionThreshold;
  }

  async compactIfNeeded(
    messages: Message[],
    request: CheckpointCompactionRequest,
  ): Promise<CheckpointCompactionResult> {
    const usage = this.getUsageInfo(messages, request.toolTokens);
    if (!this.needsCompaction(messages, request.toolTokens)) {
      return { messages, compacted: false, ...usage };
    }

    await this.emitStatus(request, {
      status: 'start',
      sessionKey: request.sessionKey,
      phase: request.phase,
      ...usage,
    });
    Logger.info(
      `[${request.sessionKey}] checkpoint compaction start `
      + `phase=${request.phase}, prompt=${usage.usedTokens}+${usage.toolTokens}`
      + `/${usage.maxTokens} (${usage.usagePercent}%)`,
    );

    try {
      const result = await this.compact(messages, request, usage);
      await this.emitStatus(request, {
        status: 'complete',
        sessionKey: request.sessionKey,
        phase: request.phase,
        messageCount: result.length,
        ...usage,
      });
      Logger.info(
        `[${request.sessionKey}] checkpoint compaction complete `
        + `phase=${request.phase}, messages=${messages.length}->${result.length}, `
        + `tokens=${usage.usedTokens}->${estimateMessagesTokens(result)}`,
      );
      const audit = buildCompactionAudit(result);
      Logger.runtimeEvent(
        'INFO',
        `[${request.sessionKey}] checkpoint_compaction phase=${request.phase} `
        + `summary_sha256=${audit.summarySha256} retained_root=${audit.retainedRootCount} `
        + `retained_pending=${audit.retainedPendingCount}`,
        {
          type: 'checkpoint_compaction',
          payload: {
            phase: request.phase,
            tokens_before: usage.usedTokens,
            tokens_after: estimateMessagesTokens(result),
            messages_before: messages.length,
            messages_after: result.length,
            summary_chars: audit.summaryChars,
            summary_sha256: audit.summarySha256,
            retained_root_count: audit.retainedRootCount,
            retained_pending_count: audit.retainedPendingCount,
            retained_user_evidence_count: audit.retainedUserEvidenceCount,
          },
        },
      );
      return { messages: result, compacted: true, ...usage };
    } catch (error) {
      await this.emitStatus(request, {
        status: 'error',
        sessionKey: request.sessionKey,
        phase: request.phase,
        error,
        ...usage,
      });
      Logger.error(
        `[${request.sessionKey}] checkpoint compaction failed `
        + `phase=${request.phase}: ${describeError(error)}`,
      );
      return { messages, compacted: false, ...usage };
    }
  }

  private async compact(
    messages: Message[],
    request: CheckpointCompactionRequest,
    usage: ReturnType<CheckpointCompactionCoordinator['getUsageInfo']>,
  ): Promise<Message[]> {
    request.signal?.throwIfAborted();
    const { durable, transient } = splitDurableAndTransient(messages);
    const stableSystemMessages = durable.filter(message => (
      message.role === 'system' && !isCompactionBoundary(message)
    ));
    // A prior checkpoint is durable evidence for the next checkpoint. It must be
    // summarized again, but is not retained verbatim in the compacted output.
    const sessionMessages = durable.filter(message => message.role !== 'system');
    if (sessionMessages.length === 0) {
      return messages;
    }

    const summary = await this.generateContinuationSummary(
      sessionMessages,
      request.phase,
      request.signal,
    );
    const retainedContext = selectRetainedContextMessages(
      sessionMessages,
      request.phase,
      this.retainedUserTokenBudget,
    );
    const remoteContextWatermarks = collectRemoteContextWatermarks(durable);
    const activeEpisodeId = findLatestEpisodeId(sessionMessages);
    const stableBoundary = findLastStableBoundary(sessionMessages);

    const boundary: Message = {
      role: 'system',
      content: [
        CHECKPOINT_COMPACTION_BOUNDARY_PREFIX,
        `phase=${request.phase}`,
        activeEpisodeId ? `episode=${activeEpisodeId}` : '',
        stableBoundary ? `last_stable=${stableBoundary}` : '',
        `tokens_before=${usage.usedTokens}`,
      ].filter(Boolean).join(' '),
      __checkpointBoundary: true,
      __checkpointPhase: request.phase,
    };
    const summaryMessage: Message = {
      role: 'user',
      content: `${CHECKPOINT_SUMMARY_PREFIX}\n\n${summary}`,
      __checkpointSummary: true,
      __checkpointPhase: request.phase,
      ...(activeEpisodeId ? { __episodeId: activeEpisodeId } : {}),
      ...(Object.keys(remoteContextWatermarks).length > 0
        ? { __remoteContextWatermarks: remoteContextWatermarks }
        : {}),
    };

    return [
      ...stableSystemMessages,
      boundary,
      summaryMessage,
      ...retainedContext,
      ...transient,
    ];
  }

  private async generateContinuationSummary(
    sourceMessages: Message[],
    phase: CheckpointCompactionPhase,
    signal?: AbortSignal,
  ): Promise<string> {
    let attemptMessages = prepareSummarySourceMessages(sourceMessages);
    let omittedMessageCount = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_CONTEXT_RETRY_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      const promptMessages: Message[] = [
        {
          role: 'system',
          content: buildCheckpointCompactionPrompt(phase, omittedMessageCount),
        },
        ...attemptMessages,
      ];
      let streamed = '';
      try {
        const response = await this.aiService.chatStream(
          promptMessages,
          undefined,
          { onText: text => { streamed += text; } },
          { signal },
        );
        if (response.usage) {
          Metrics.recordAICall('stream', response.usage);
        }
        const summary = (streamed || response.content || '').trim();
        if (!summary) {
          throw new Error('checkpoint compaction returned an empty summary');
        }
        return summary;
      } catch (error) {
        lastError = error;
        if (!isContextLengthError(error) || attemptMessages.length <= 1) {
          throw error;
        }
        const reduced = dropOldestEpisode(attemptMessages);
        omittedMessageCount += attemptMessages.length - reduced.length;
        attemptMessages = reduced;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('checkpoint compaction exhausted context retries');
  }

  private async emitStatus(
    request: CheckpointCompactionRequest,
    event: CheckpointCompactionStatusEvent,
  ): Promise<void> {
    if (!request.onStatus) return;
    try {
      await request.onStatus(event);
    } catch (error) {
      Logger.warning(
        `[${request.sessionKey}] checkpoint compaction status callback failed: `
        + describeError(error),
      );
    }
  }
}

/**
 * Bounds pathological tool output only for the summary model request.
 *
 * The durable transcript remains untouched until a checkpoint succeeds. The
 * evidence proxy keeps exact identity, size, hash, and head/tail material so
 * the summary can preserve stable facts while directing the resumed Agent to
 * re-run the tool before relying on omitted details.
 */
function prepareSummarySourceMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'tool' || typeof message.content !== 'string') {
      return message;
    }
    const raw = message.content;
    if (raw.length <= MAX_SUMMARY_TOOL_RESULT_CHARS) {
      return message;
    }

    const hash = createHash('sha256').update(raw).digest('hex');
    const head = raw.slice(0, SUMMARY_TOOL_RESULT_HEAD_CHARS);
    const tail = raw.slice(-SUMMARY_TOOL_RESULT_TAIL_CHARS);
    return {
      ...message,
      content: [
        CHECKPOINT_TOOL_EVIDENCE_PREFIX,
        message.name ? `tool_name: ${message.name}` : '',
        message.tool_call_id ? `tool_call_id: ${message.tool_call_id}` : '',
        `original_chars: ${raw.length}`,
        `sha256: ${hash}`,
        'omission: middle of this tool result was omitted from checkpoint-generation input only.',
        'recovery: re-run the tool or re-read its source before exact quoting or edits that depend on omitted details.',
        '',
        'head:',
        head,
        '',
        'tail:',
        tail,
      ].filter(part => part !== '').join('\n'),
    };
  });
}

export function buildCheckpointCompactionPrompt(
  phase: CheckpointCompactionPhase,
  omittedMessageCount = 0,
): string {
  const base = readRequiredBundledPromptFile('checkpoint-compact-system.md').trim();
  const phaseInstruction = phase === 'mid_turn'
    ? [
      'This is a MID-TURN checkpoint for the same active episode.',
      'Preserve the episode root request, every later user correction or prohibition, the latest complete tool boundary, the exact current step, and the next executable action.',
      'A short follow-up such as "continue" is not the root objective and must not replace it.',
      'Do not report an incomplete tool call as successful.',
    ].join(' ')
    : phase === 'pre_turn'
      ? [
        'This is a PRE-TURN checkpoint between external user turns.',
        'Compress completed history, durable decisions, open commitments, unresolved work, and exact facts that a future turn may need.',
        'Do not describe a completed prior episode as if it were still actively executing.',
        'The next external user message will become the new root instruction.',
      ].join(' ')
      : [
      'This checkpoint is being generated from restored user-visible history.',
      'Treat processes, ports, files, devices, credentials, network state, and unfinished tool execution as unknown until reverified.',
      'Preserve durable objectives and decisions, but do not pretend that an interrupted runtime or tool call is still alive.',
    ].join(' ');
  const omissionInstruction = omittedMessageCount > 0
    ? `${omittedMessageCount} oldest source message(s) were omitted after a provider context-length error. Explicitly mark missing evidence as unknown and recommend retrieval instead of guessing.`
    : '';
  return [base, phaseInstruction, omissionInstruction].filter(Boolean).join('\n\n');
}

export function splitDurableAndTransient(messages: Message[]): {
  durable: Message[];
  transient: Message[];
} {
  const durable: Message[] = [];
  const transient: Message[] = [];
  for (const message of messages) {
    if (isTransientMessage(message)) {
      transient.push(message);
    } else {
      durable.push(message);
    }
  }
  return { durable, transient };
}

function selectRetainedContextMessages(
  messages: Message[],
  phase: CheckpointCompactionPhase,
  tokenBudget: number,
): Message[] {
  const latestEpisodeId = findLatestEpisodeId(messages);
  if (phase === 'mid_turn' && latestEpisodeId) {
    return selectMidTurnUserMessages(messages, latestEpisodeId, tokenBudget);
  }
  const candidates = messages.filter(message => {
    if (isCheckpointSummary(message)) return false;
    if (message.role === 'user') return true;
    return message.role === 'assistant'
      && !message.tool_calls?.length
      && typeof message.content === 'string'
      && message.content.trim().length > 0;
  });

  const selected: Message[] = [];
  let usedTokens = 0;
  for (let index = candidates.length - 1; index >= 0; index--) {
    if (selected.length >= DEFAULT_RETAINED_CONTEXT_MESSAGE_LIMIT) break;
    const candidate = candidates[index];
    const candidateTokens = estimateMessagesTokens([candidate]);
    const remainingTokens = tokenBudget - usedTokens;
    if (candidateTokens > remainingTokens) {
      if (selected.length === 0 && candidate.role === 'user') {
        const evidence = buildUserInputEvidence(candidate, remainingTokens);
        if (evidence) {
          selected.unshift(evidence);
          usedTokens += estimateMessagesTokens([evidence]);
        }
      }
      continue;
    }
    selected.unshift(candidate);
    usedTokens += candidateTokens;
  }
  return selected;
}

function selectMidTurnUserMessages(
  messages: Message[],
  episodeId: string,
  tokenBudget: number,
): Message[] {
  const episodeInputs = messages.filter(message => (
    !isCheckpointSummary(message)
    && message.role === 'user'
    && message.__episodeId === episodeId
  ));
  if (episodeInputs.length === 0) return [];

  const root = episodeInputs.find(message => message.__episodeInputKind === 'root')
    ?? episodeInputs[0];
  const laterInputs = episodeInputs.filter(message => message !== root);
  const retainedBySource = new Map<Message, Message>();
  let usedTokens = 0;

  const add = (message: Message): void => {
    const remainingTokens = tokenBudget - usedTokens;
    if (remainingTokens < 128) return;
    const messageTokens = estimateMessagesTokens([message]);
    if (messageTokens <= remainingTokens) {
      retainedBySource.set(message, message);
      usedTokens += messageTokens;
      return;
    }
    const evidence = buildUserInputEvidence(message, remainingTokens);
    if (!evidence) return;
    retainedBySource.set(message, evidence);
    usedTokens += estimateMessagesTokens([evidence]);
  };

  // The root objective always wins. Repeated short follow-ups must never evict it.
  add(root);
  // Prefer the latest corrections when the episode's user input itself exceeds
  // the retained budget. The returned messages are restored to chronological order.
  for (let index = laterInputs.length - 1; index >= 0; index--) {
    add(laterInputs[index]);
  }

  return episodeInputs.flatMap(message => {
    const retained = retainedBySource.get(message);
    return retained ? [retained] : [];
  });
}

function buildUserInputEvidence(message: Message, maxTokens: number): Message | undefined {
  if (maxTokens < 128) return undefined;
  const raw = serializeUserInputForEvidence(message);
  if (!raw.trim()) return undefined;
  const hash = createHash('sha256').update(raw).digest('hex');
  let materialChars = Math.min(raw.length, Math.max(128, Math.floor(maxTokens * 1.1)));

  while (materialChars >= 128) {
    const headChars = Math.max(96, Math.floor(materialChars * 0.75));
    const tailChars = Math.max(32, materialChars - headChars);
    const content = [
      CHECKPOINT_USER_INPUT_EVIDENCE_PREFIX,
      `input_kind: ${message.__episodeInputKind || 'user'}`,
      `original_chars: ${raw.length}`,
      `sha256: ${hash}`,
      'omission: this single user input exceeded the verbatim retention budget.',
      'recovery: use the continuation checkpoint first; reread the persisted session before exact work that depends on omitted text.',
      '',
      'head:',
      raw.slice(0, headChars),
      '',
      'tail:',
      raw.slice(-tailChars),
    ].join('\n');
    const evidence: Message = {
      ...message,
      content,
    };
    if (estimateMessagesTokens([evidence]) <= maxTokens) return evidence;
    materialChars = Math.floor(materialChars * 0.7);
  }
  return undefined;
}

function serializeUserInputForEvidence(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map(block => {
    if (block.type === 'text') return block.text;
    const data = block.source?.data || '';
    const digest = data ? createHash('sha256').update(data).digest('hex') : 'unavailable';
    return `[image media_type=${block.source?.media_type || 'unknown'} sha256=${digest}]`;
  }).join('\n');
}

function defaultRetainedUserTokenBudget(maxContextTokens: number): number {
  return Math.min(
    MAX_RETAINED_USER_TOKEN_BUDGET,
    Math.max(
      MIN_RETAINED_USER_TOKEN_BUDGET,
      Math.floor(maxContextTokens * RETAINED_USER_CONTEXT_RATIO),
    ),
  );
}

function buildCompactionAudit(
  messages: Message[],
): {
  summaryChars: number;
  summarySha256: string;
  retainedRootCount: number;
  retainedPendingCount: number;
  retainedUserEvidenceCount: number;
} {
  const summary = messages.find(message => message.__checkpointSummary);
  const summaryText = typeof summary?.content === 'string' ? summary.content : '';
  return {
    summaryChars: summaryText.length,
    summarySha256: createHash('sha256').update(summaryText).digest('hex'),
    retainedRootCount: messages.filter(message => message.__episodeInputKind === 'root').length,
    retainedPendingCount: messages.filter(message => message.__episodeInputKind === 'pending').length,
    retainedUserEvidenceCount: messages.filter(message => (
      typeof message.content === 'string'
      && message.content.startsWith(CHECKPOINT_USER_INPUT_EVIDENCE_PREFIX)
    )).length,
  };
}

function findLatestEpisodeId(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].__episodeId) return messages[index].__episodeId;
  }
  return undefined;
}

function findLastStableBoundary(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'tool') continue;
    return [
      message.name ? `tool:${message.name}` : 'tool',
      message.tool_call_id ? `call:${message.tool_call_id}` : '',
    ].filter(Boolean).join(',');
  }
  return undefined;
}

function dropOldestEpisode(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;
  const oldestEpisodeId = messages[0].__episodeId;
  if (!oldestEpisodeId) {
    return messages.slice(1);
  }
  const reduced = messages.filter(message => message.__episodeId !== oldestEpisodeId);
  return reduced.length > 0 ? reduced : messages.slice(1);
}

function isCheckpointSummary(message: Message): boolean {
  return message.__checkpointSummary === true
    || (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.startsWith(CHECKPOINT_SUMMARY_PREFIX)
    );
}

function isCompactionBoundary(message: Message): boolean {
  if (message.__checkpointBoundary) return true;
  if (message.role !== 'system' || typeof message.content !== 'string') return false;
  return message.content.startsWith(CHECKPOINT_COMPACTION_BOUNDARY_PREFIX)
    || message.content.startsWith('[compact_boundary]');
}

function isTransientMessage(message: Message): boolean {
  if (
    message.__injected
    || message.__runtimeFeedback
    || message.__syntheticObservation
  ) {
    return true;
  }
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith('[transient_');
}

function isContextLengthError(error: unknown): boolean {
  const text = describeError(error).toLowerCase();
  return /context|token|maximum|too (?:large|long)|length|input.*limit/.test(text);
}

function readRatio(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 && value! < 1 ? value! : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  episodeId?: string;
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
      256,
      Math.min(
        Math.floor(this.maxContextTokens * 0.5),
        Math.floor(
          options.retainedUserTokenBudget
          ?? defaultRetainedUserTokenBudget(this.maxContextTokens),
        ),
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
      if (result === messages) {
        return { messages, compacted: false, ...usage };
      }
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
        + `retained_pending=${audit.retainedPendingCount} exact_tail_groups=${audit.exactTailGroupCount}`,
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
            exact_tail_group_count: audit.exactTailGroupCount,
            exact_tail_tokens: audit.exactTailTokens,
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

    const activeEpisodeId = request.episodeId || findLatestEpisodeId(sessionMessages);
    const exactTail = selectExactTail(
      sessionMessages,
      activeEpisodeId,
      this.retainedUserTokenBudget,
    );
    if (exactTail.summarySource.length === 0) {
      return messages;
    }

    const summary = await this.generateContinuationSummary(
      exactTail.summarySource,
      request.phase,
      request.sessionKey,
      request.signal,
    );
    const remoteContextWatermarks = collectRemoteContextWatermarks(durable);
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
      summaryMessage,
      ...exactTail.retained,
      ...transient,
    ];
  }

  private async generateContinuationSummary(
    sourceMessages: Message[],
    phase: CheckpointCompactionPhase,
    sessionKey: string,
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
          {
            signal,
            promptCacheContext: {
              sessionKey,
              phase,
              explicitCaching: false,
            },
          },
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

interface ExactTailGroup {
  start: number;
  end: number;
  messages: Message[];
  hasToolExchange: boolean;
  hasUserInput: boolean;
  belongsToActiveEpisode: boolean;
}

interface ExactTailSelection {
  retained: Message[];
  summarySource: Message[];
}

interface SelectedExactTailGroup {
  messages: Message[];
  sourceIndexes: number[];
}

function selectExactTail(
  messages: Message[],
  activeEpisodeId: string | undefined,
  tokenBudget: number,
): ExactTailSelection {
  const groups = buildExactTailGroups(messages, activeEpisodeId)
    .filter(group => !group.messages.some(isCheckpointSummary));
  const candidates = [...groups].sort((left, right) => {
    const leftPriority = exactTailPriority(left);
    const rightPriority = exactTailPriority(right);
    return leftPriority - rightPriority || right.end - left.end;
  });
  const selected = new Map<ExactTailGroup, SelectedExactTailGroup>();
  let usedTokens = 0;

  for (const group of candidates) {
    const remaining = tokenBudget - usedTokens;
    if (remaining < 128) break;
    let retainedGroup = group.messages;
    let groupTokens = estimateMessagesTokens(retainedGroup);
    let sourceIndexes = indexesForGroup(group);
    if (groupTokens > remaining) {
      const recentAssistant = recentAssistantFromOversizedOrdinaryExchange(group);
      if (recentAssistant && estimateMessagesTokens([recentAssistant]) <= remaining) {
        retainedGroup = [recentAssistant];
        groupTokens = estimateMessagesTokens(retainedGroup);
        sourceIndexes = [group.end];
      } else {
        retainedGroup = buildBoundedExactGroup(group.messages, remaining);
        groupTokens = estimateMessagesTokens(retainedGroup);
      }
    }
    if (retainedGroup.length === 0 || groupTokens > remaining) continue;
    selected.set(group, { messages: retainedGroup, sourceIndexes });
    usedTokens += groupTokens;
  }

  // A checkpoint must summarize at least one older source group. If the exact
  // tail swallowed the entire transcript, move the oldest retained group back
  // into the summary source instead of reporting a no-op compaction.
  const selectedSourceCount = [...selected.values()]
    .reduce((total, value) => total + value.sourceIndexes.length, 0);
  if (selectedSourceCount === messages.length && groups.length > 0) {
    const oldestSelected = [...selected.keys()].sort((left, right) => left.start - right.start)[0];
    selected.delete(oldestSelected);
  }

  const selectedIndexes = new Set<number>();
  const retained: Message[] = [];
  for (const group of [...selected.keys()].sort((left, right) => left.start - right.start)) {
    const selection = selected.get(group)!;
    for (const index of selection.sourceIndexes) selectedIndexes.add(index);
    retained.push(...selection.messages);
  }
  return {
    retained,
    summarySource: messages.filter((_, index) => !selectedIndexes.has(index)),
  };
}

function indexesForGroup(group: ExactTailGroup): number[] {
  return Array.from({ length: group.end - group.start + 1 }, (_, offset) => group.start + offset);
}

function recentAssistantFromOversizedOrdinaryExchange(group: ExactTailGroup): Message | undefined {
  if (group.messages.length !== 2) return undefined;
  const [user, assistant] = group.messages;
  if (user.role !== 'user' || assistant.role !== 'assistant' || assistant.tool_calls?.length) {
    return undefined;
  }
  return assistant;
}

function buildExactTailGroups(
  messages: Message[],
  activeEpisodeId?: string,
): ExactTailGroup[] {
  const groups: ExactTailGroup[] = [];
  for (let index = 0; index < messages.length;) {
    const start = index;
    const first = messages[index];
    if (first.role === 'user') {
      index++;
      if (index < messages.length
        && messages[index].role === 'assistant'
        && !messages[index].tool_calls?.length) {
        index++;
      }
    } else if (first.role === 'assistant' && first.tool_calls?.length) {
      const expected = new Set(first.tool_calls.map(call => call.id));
      index++;
      while (index < messages.length && messages[index].role === 'tool') {
        if (messages[index].tool_call_id) expected.delete(messages[index].tool_call_id!);
        index++;
        if (expected.size === 0) break;
      }
    } else {
      index++;
    }
    const groupMessages = messages.slice(start, index);
    groups.push({
      start,
      end: index - 1,
      messages: groupMessages,
      hasToolExchange: groupMessages.some(message => message.role === 'tool'),
      hasUserInput: groupMessages.some(message => message.role === 'user'),
      belongsToActiveEpisode: Boolean(
        activeEpisodeId
        && groupMessages.some(message => message.__episodeId === activeEpisodeId),
      ),
    });
  }
  return groups;
}

function exactTailPriority(group: ExactTailGroup): number {
  if (group.belongsToActiveEpisode && group.hasToolExchange) return 0;
  if (group.belongsToActiveEpisode && group.hasUserInput) return 1;
  return 2;
}

function buildBoundedExactGroup(messages: Message[], maxTokens: number): Message[] {
  if (maxTokens < 128) return [];
  const perMessageBudget = Math.max(96, Math.floor(maxTokens / Math.max(1, messages.length)));
  const bounded = messages.map(message => {
    if (message.role === 'tool' && typeof message.content === 'string') {
      return estimateMessagesTokens([message]) <= perMessageBudget
        ? message
        : buildToolResultEvidence(message, perMessageBudget);
    }
    if (message.role !== 'user') return message;
    const messageTokens = estimateMessagesTokens([message]);
    if (messageTokens <= perMessageBudget) {
      return message;
    }
    return buildUserInputEvidence(
      message,
      perMessageBudget,
    ) || message;
  });
  return estimateMessagesTokens(bounded) <= maxTokens ? bounded : [];
}

function buildToolResultEvidence(message: Message, maxTokens: number): Message {
  const raw = typeof message.content === 'string' ? message.content : '';
  const hash = createHash('sha256').update(raw).digest('hex');
  let materialChars = Math.min(raw.length, Math.max(64, Math.floor(maxTokens * 1.2)));

  while (materialChars >= 32) {
    const headChars = Math.max(24, Math.floor(materialChars * 0.75));
    const tailChars = Math.max(8, materialChars - headChars);
    const evidence: Message = {
      ...message,
      content: [
        CHECKPOINT_TOOL_EVIDENCE_PREFIX,
        message.name ? `tool_name: ${message.name}` : '',
        message.tool_call_id ? `tool_call_id: ${message.tool_call_id}` : '',
        `original_chars: ${raw.length}`,
        `sha256: ${hash}`,
        'omission: bounded exact-tail evidence; re-run the tool before relying on omitted details.',
        '',
        'head:',
        raw.slice(0, headChars),
        '',
        'tail:',
        raw.slice(-tailChars),
      ].filter(part => part !== '').join('\n'),
    };
    if (estimateMessagesTokens([evidence]) <= maxTokens) return evidence;
    materialChars = Math.floor(materialChars * 0.65);
  }

  return {
    ...message,
    content: [
      CHECKPOINT_TOOL_EVIDENCE_PREFIX,
      message.name ? `tool_name: ${message.name}` : '',
      message.tool_call_id ? `tool_call_id: ${message.tool_call_id}` : '',
      `original_chars: ${raw.length}`,
      `sha256: ${hash}`,
      'omission: tool output exceeded the exact-tail evidence budget; re-run before use.',
    ].filter(part => part !== '').join('\n'),
  };
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
  exactTailGroupCount: number;
  exactTailTokens: number;
} {
  const summary = messages.find(message => message.__checkpointSummary);
  const summaryIndex = messages.findIndex(message => message.__checkpointSummary);
  const exactTail = summaryIndex < 0
    ? []
    : messages.slice(summaryIndex + 1).filter(message => !isTransientMessage(message));
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
    exactTailGroupCount: buildExactTailGroups(exactTail).length,
    exactTailTokens: estimateMessagesTokens(exactTail),
  };
}

function findLatestEpisodeId(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].__episodeId) return messages[index].__episodeId;
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

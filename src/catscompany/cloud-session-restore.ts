import type { Message } from '../types';
import type { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';
import { SessionStore } from '../utils/session-store';
import { stripAssistantTranscriptArtifacts } from '../utils/transcript-artifacts';
import { ContextCompressor } from '../core/context-compressor';
import { estimateMessagesTokens } from '../core/token-estimator';
import type {
  CatsAgentContextMessage,
  CatsAgentContextPage,
} from './client';

const CLOUD_RESTORE_PAGE_SIZE = 200;
const CLOUD_RESTORE_MAX_PAGES = 10;
const CLOUD_RESTORE_DIRECT_TOKEN_BUDGET = 60_000;
const CLOUD_RESTORE_FETCH_TOKEN_BUDGET = 160_000;
const CLOUD_RESTORE_FINAL_TOKEN_CEILING = 90_000;
const CLOUD_RESTORE_SUMMARY_INPUT_BUDGET = 70_000;
const CLOUD_RESTORE_RECENT_EPISODES = 12;
const CLOUD_RESTORE_RECENT_TOKEN_BUDGET = 30_000;

interface AgentContextHistoryClient {
  getAgentContextHistory(
    topic: string,
    options?: { beforeId?: number; limit?: number; signal?: AbortSignal },
  ): Promise<CatsAgentContextPage>;
}

interface SessionContextStore {
  hasSession(sessionKey: string): boolean;
  saveContext(sessionKey: string, messages: Message[]): void;
}

export interface CloudSessionRestoreRequest {
  sessionKey: string;
  topicId: string;
  topicType: 'p2p' | 'group';
  agentId: string;
  currentSeq: number;
  signal?: AbortSignal;
}

export interface CloudSessionRestoreResult {
  status: 'local_present' | 'restored' | 'empty' | 'skipped' | 'failed';
  restoredMessages: number;
  fetchedMessages: number;
  compressed: boolean;
  error?: unknown;
}

export class CatsCompanyCloudSessionRestorer {
  constructor(
    private readonly client: AgentContextHistoryClient,
    private readonly aiService: AIService,
    private readonly sessionStore: SessionContextStore = SessionStore.getInstance(),
  ) {}

  async restoreIfMissing(request: CloudSessionRestoreRequest): Promise<CloudSessionRestoreResult> {
    if (this.hasLocalSession(request.sessionKey)) {
      return this.result('local_present');
    }
    if (!Number.isFinite(request.currentSeq) || request.currentSeq <= 0) {
      return this.result('skipped');
    }

    try {
      const fetched = await this.fetchHistory(request);
      request.signal?.throwIfAborted();
      if (fetched.messages.length === 0) {
        return this.result('empty', { fetchedMessages: fetched.fetchedMessages });
      }

      const prepared = await this.prepareForPersistence(fetched.messages, request.signal);
      if (
        request.signal?.aborted
        && !(prepared.summaryFallback && isTimeoutAbortReason(request.signal.reason))
      ) {
        request.signal.throwIfAborted();
      }
      if (this.hasLocalSession(request.sessionKey)) {
        return this.result('local_present', { fetchedMessages: fetched.fetchedMessages });
      }

      this.sessionStore.saveContext(request.sessionKey, prepared.messages);
      Logger.info(
        `[${request.sessionKey}] 云端主会话恢复完成: fetched=${fetched.fetchedMessages}, `
        + `restored=${prepared.messages.length}, compressed=${prepared.compressed}`,
      );
      return this.result('restored', {
        restoredMessages: prepared.messages.length,
        fetchedMessages: fetched.fetchedMessages,
        compressed: prepared.compressed,
      });
    } catch (error) {
      Logger.warning(`[${request.sessionKey}] 云端主会话恢复失败，未创建本地空白会话，等待后续重试: ${describeError(error)}`);
      return this.result('failed', { error });
    }
  }

  markLocalSessionCleared(sessionKey: string): void {
    this.sessionStore.saveContext(sessionKey, []);
  }

  private hasLocalSession(sessionKey: string): boolean {
    return this.sessionStore.hasSession(sessionKey);
  }

  private async fetchHistory(request: CloudSessionRestoreRequest): Promise<{
    messages: Message[];
    fetchedMessages: number;
  }> {
    let beforeId = request.currentSeq;
    let fetchedMessages = 0;
    let rawMessages: CatsAgentContextMessage[] = [];
    const seenMessageIds = new Set<number>();

    for (let pageIndex = 0; pageIndex < CLOUD_RESTORE_MAX_PAGES; pageIndex++) {
      const page = await this.client.getAgentContextHistory(request.topicId, {
        beforeId,
        limit: CLOUD_RESTORE_PAGE_SIZE,
        signal: request.signal,
      });
      this.assertPageScope(page, request);
      fetchedMessages += page.messages.length;

      const orderedPage = [...page.messages]
        .sort((left, right) => agentContextMessageSeq(left) - agentContextMessageSeq(right))
        .filter(message => {
          const id = Number(message.id || message.seq_id || 0);
          if (id <= 0 || seenMessageIds.has(id)) return false;
          seenMessageIds.add(id);
          return true;
        });
      const clearBoundaryIndex = findLastClearBoundaryIndex(orderedPage, request);
      const pageMessages = clearBoundaryIndex >= 0
        ? orderedPage.slice(clearBoundaryIndex + 1)
        : orderedPage;
      rawMessages = [...pageMessages, ...rawMessages];
      const normalizedMessages = coalesceAssistantSegments(normalizeAgentContextMessages(
        [...rawMessages].sort((left, right) => agentContextMessageSeq(left) - agentContextMessageSeq(right)),
        request,
      ));

      if (
        clearBoundaryIndex >= 0
        || !page.has_more
        || page.next_before_id <= 0
        || page.next_before_id >= beforeId
        || estimateMessagesTokens(normalizedMessages) >= CLOUD_RESTORE_FETCH_TOKEN_BUDGET
      ) {
        break;
      }
      beforeId = page.next_before_id;
    }

    const messages = coalesceAssistantSegments(normalizeAgentContextMessages(
      [...rawMessages].sort((left, right) => agentContextMessageSeq(left) - agentContextMessageSeq(right)),
      request,
    ));
    return { messages, fetchedMessages };
  }

  private assertPageScope(page: CatsAgentContextPage, request: CloudSessionRestoreRequest): void {
    if (page.topic_id !== request.topicId) {
      throw new Error(`agent context topic mismatch: ${page.topic_id}`);
    }
    if (normalizeUID(page.agent_uid) !== normalizeUID(request.agentId)) {
      throw new Error(`agent context identity mismatch: ${page.agent_uid}`);
    }
  }

  private async prepareForPersistence(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<{ messages: Message[]; compressed: boolean; summaryFallback: boolean }> {
    const usedTokens = estimateMessagesTokens(messages);
    if (usedTokens <= CLOUD_RESTORE_DIRECT_TOKEN_BUDGET) {
      return { messages, compressed: false, summaryFallback: false };
    }

    try {
      const compressor = new ContextCompressor(this.aiService, {
        maxContextTokens: CLOUD_RESTORE_FINAL_TOKEN_CEILING,
        summaryContentBudget: CLOUD_RESTORE_SUMMARY_INPUT_BUDGET,
        preserveRecentEpisodes: CLOUD_RESTORE_RECENT_EPISODES,
        preserveRecentEpisodeTokenBudget: CLOUD_RESTORE_RECENT_TOKEN_BUDGET,
        preserveRecentEpisodeMaxShare: 0.4,
      });
      const compacted = await compressor.compact(messages, {
        signal,
        customInstructions: [
          '这些内容来自 CatsCompany 云端可见聊天历史，用于在新设备上恢复主会话。',
          '保留用户目标、关键决定、已交付结果、文件名、未完成事项和重要约束。',
          '不要声称恢复了工具调用、本地文件状态、设备授权或未出现在历史里的信息。',
        ].join('\n'),
      });
      return {
        messages: trimToTokenBudget(compacted, CLOUD_RESTORE_FINAL_TOKEN_CEILING),
        compressed: true,
        summaryFallback: false,
      };
    } catch (error) {
      Logger.warning(`云端历史摘要失败，降级保留最近上下文: ${describeError(error)}`);
      return {
        messages: trimToTokenBudget(messages, CLOUD_RESTORE_DIRECT_TOKEN_BUDGET),
        compressed: true,
        summaryFallback: true,
      };
    }
  }

  private result(
    status: CloudSessionRestoreResult['status'],
    overrides: Partial<CloudSessionRestoreResult> = {},
  ): CloudSessionRestoreResult {
    return {
      status,
      restoredMessages: 0,
      fetchedMessages: 0,
      compressed: false,
      ...overrides,
    };
  }
}

export function normalizeAgentContextMessages(
  messages: CatsAgentContextMessage[],
  request: Pick<CloudSessionRestoreRequest, 'topicType' | 'agentId'>,
): Message[] {
  const normalized: Message[] = [];
  let episodeId = 'cloud:initial';

  for (const message of messages) {
    if (
      message.context_eligible !== true
      || normalizeUID(message.agent_id || message.agent_uid) !== normalizeUID(request.agentId)
      || (message.context_role !== 'user' && message.context_role !== 'assistant')
    ) {
      continue;
    }

    let text = cloudMessageText(message);
    if (message.context_role === 'assistant') {
      text = stripAssistantTranscriptArtifacts(text);
    }
    if (!text || isNonAnswerPlaceholder(text)) continue;
    if (request.topicType === 'group' && message.context_role === 'user') {
      const speaker = cloudSpeakerLabel(message);
      if (speaker) text = `[群聊成员 ${speaker}]\n${text}`;
    }

    if (message.context_role === 'user') {
      episodeId = `cloud:${message.seq_id || message.id}`;
    }
    normalized.push({
      role: message.context_role,
      content: text,
      __episodeId: episodeId,
      ...(message.context_role === 'user' ? { __episodeInputKind: 'root' as const } : {}),
    });
  }

  return normalized;
}

function findLastClearBoundaryIndex(
  messages: CatsAgentContextMessage[],
  request: Pick<CloudSessionRestoreRequest, 'agentId' | 'topicType'>,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const clearReasonMatches = request.topicType === 'group'
      ? message.context_reason === 'group_message_targets_agent'
      : message.context_reason === undefined || message.context_reason === 'participant_message';
    if (
      message.context_eligible === true
      && message.context_role === 'user'
      && normalizeUID(message.agent_id || message.agent_uid) === normalizeUID(request.agentId)
      && clearReasonMatches
      && /^\/clear(?:\s|$)/i.test(cloudMessageText(message))
    ) {
      return index;
    }
  }
  return -1;
}

function agentContextMessageSeq(message: CatsAgentContextMessage): number {
  return Number(message.seq_id || message.id || 0);
}

function cloudMessageText(message: CatsAgentContextMessage): string {
  if (typeof message.content === 'string' && message.content.trim()) {
    const text = message.content.trim();
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'string' ? parsed.trim() : text;
    } catch {
      return text;
    }
  }
  if (!message.content || typeof message.content !== 'object') {
    return cloudContentBlocksText(message.content_blocks);
  }

  const rich = message.content as Record<string, unknown>;
  const type = String(rich.type || message.type || message.msg_type || '').trim();
  const payload = rich.payload && typeof rich.payload === 'object'
    ? rich.payload as Record<string, unknown>
    : rich;
  const name = String(payload.name || payload.file_name || '').trim();
  const description = String(payload.text || payload.description || '').trim();
  if (type === 'file') return `[历史文件${name ? `：${name}` : ''}]${description ? ` ${description}` : ''}`;
  if (type === 'image') return `[历史图片${name ? `：${name}` : ''}]${description ? ` ${description}` : ''}`;
  if (type === 'voice') return `[历史语音]${description ? ` ${description}` : ''}`;
  return description || cloudContentBlocksText(message.content_blocks);
}

function cloudContentBlocksText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const values = block as Record<string, unknown>;
    const type = String(values.type || '').trim();
    if (type === 'text' && typeof values.text === 'string' && values.text.trim()) {
      parts.push(values.text.trim());
    } else if (type === 'image') {
      parts.push('[历史图片]');
    } else if (type === 'file') {
      const name = String(values.name || values.file_name || '').trim();
      parts.push(`[历史文件${name ? `：${name}` : ''}]`);
    }
  }
  return parts.join('\n');
}

function cloudSpeakerLabel(message: CatsAgentContextMessage): string {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object') return normalizeUID(message.from_uid);
  const identity = metadata.catsco_identity;
  if (!identity || typeof identity !== 'object') return normalizeUID(message.from_uid);
  const actor = (identity as Record<string, unknown>).actor;
  if (!actor || typeof actor !== 'object') return normalizeUID(message.from_uid);
  const values = actor as Record<string, unknown>;
  return String(values.display_name || values.username || values.user_id || normalizeUID(message.from_uid)).trim();
}

function coalesceAssistantSegments(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const previous = result[result.length - 1];
    if (
      message.role === 'assistant'
      && previous?.role === 'assistant'
      && previous.__episodeId === message.__episodeId
      && typeof previous.content === 'string'
      && typeof message.content === 'string'
    ) {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }
    result.push({ ...message });
  }
  return result;
}

function trimToTokenBudget(messages: Message[], budget: number): Message[] {
  if (estimateMessagesTokens(messages) <= budget) return messages;
  const boundary: Message = {
    role: 'user',
    content: '[设备恢复提示] 更早的 CatsCompany 云端历史已截断，以避免恢复后的上下文过大。',
  };
  const contentBudget = Math.max(1, budget - estimateMessagesTokens([boundary]));
  const selected: Message[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const tokens = estimateMessagesTokens([message]);
    if (tokens > contentBudget && selected.length === 0) {
      selected.unshift(truncateMessageToTokenBudget(message, contentBudget));
      break;
    }
    if (used + tokens > contentBudget) break;
    selected.unshift(message);
    used += tokens;
  }
  return [boundary, ...selected];
}

function truncateMessageToTokenBudget(message: Message, budget: number): Message {
  const text = typeof message.content === 'string' ? message.content : String(message.content ?? '');
  const suffix = '\n\n[该条历史消息在设备恢复时已截断]';
  let low = 0;
  let high = text.length;
  let best = suffix;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, middle)}${suffix}`;
    if (estimateMessagesTokens([{ ...message, content: candidate }]) <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { ...message, content: best };
}

function isNonAnswerPlaceholder(text: string): boolean {
  const normalized = text.trim();
  return normalized === '[无回复]'
    || normalized === '[No response]'
    || normalized.startsWith('[处理失败:');
}

function normalizeUID(value: unknown): string {
  const raw = String(value ?? '').trim();
  const numeric = raw.match(/^(?:usr)?(\d+)$/i);
  return numeric ? `usr${numeric[1]}` : raw;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutAbortReason(reason: unknown): boolean {
  return !!reason
    && typeof reason === 'object'
    && (reason as { name?: unknown }).name === 'TimeoutError';
}

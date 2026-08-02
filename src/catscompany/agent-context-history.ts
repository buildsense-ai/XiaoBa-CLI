import type { ParsedCatsMessage } from './types';
import type { CatsAgentContextMessage } from './client';
import {
  prefixCatsCoParticipantContent,
  resolveTrustedCatsCoSpeakerIdentity,
  sameCatsCoUserId,
} from './speaker-label';

type UnknownRecord = Record<string, unknown>;

export interface NativeFeishuGroupContextEntry {
  source: 'catscompany.agent_context';
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

export function isNativeFeishuGroupTrigger(
  msg: Pick<ParsedCatsMessage, 'chatType' | 'metadata' | 'seq'>,
): boolean {
  if (msg.chatType !== 'group' || msg.seq <= 0) return false;
  const metadata = asRecord(msg.metadata);
  return stringField(metadata, 'source_channel').toLowerCase() === 'feishu'
    && numberField(metadata, 'channel_native_group_binding_id') > 0
    && booleanField(metadata, 'channel_native_group_triggered');
}

/**
 * Returns durable group participant messages since the previous model turn.
 * Mentions control activation only; every eligible human or other-Agent message
 * remains replayable context. The exact current trigger is excluded by sequence
 * so earlier messages that also targeted this Agent are not accidentally lost.
 */
export function selectNativeFeishuGroupContext(
  history: CatsAgentContextMessage[],
  afterSeq = 0,
  currentTriggerSeq = 0,
  expectedTopicId = '',
  expectedAgentId = '',
): string[] {
  return selectNativeFeishuGroupContextEntries(
    history,
    afterSeq,
    currentTriggerSeq,
    expectedTopicId,
    expectedAgentId,
  )
    .map(entry => entry.content);
}

export function selectNativeFeishuGroupContextEntries(
  history: CatsAgentContextMessage[],
  afterSeq = 0,
  currentTriggerSeq = 0,
  expectedTopicId = '',
  expectedAgentId = '',
): NativeFeishuGroupContextEntry[] {
  if (!expectedTopicId.trim() || !expectedAgentId.trim()) return [];
  const ordered = [...history].sort((a, b) => agentContextMessageSeq(a) - agentContextMessageSeq(b));
  const clearBoundarySeq = ordered.reduce((latest, message) => (
    isNativeFeishuClearBoundary(message, expectedTopicId, expectedAgentId)
      ? Math.max(latest, agentContextMessageSeq(message))
      : latest
  ), 0);
  const effectiveAfterSeq = Math.max(afterSeq, clearBoundarySeq);
  return ordered
    .filter(message => {
      const seq = agentContextMessageSeq(message);
      return seq > effectiveAfterSeq
        && (currentTriggerSeq <= 0 || seq !== currentTriggerSeq)
        && isCatsCoAgentContextRecordInScope(message, expectedTopicId, expectedAgentId);
    })
    .map(message => {
      const contextRole = normalizedContextRole(message, expectedAgentId);
      const role = contextRole === 'other_agent' ? 'user' as const : contextRole;
      return {
        source: 'catscompany.agent_context' as const,
        id: agentContextMessageSeq(message),
        role,
        content: role === 'assistant'
          ? extractMessageText(message)
          : formatParticipantMessage(message, expectedTopicId, contextRole === 'other_agent'),
      };
    })
    .filter((entry): entry is NativeFeishuGroupContextEntry => (
      entry.role === 'user' || entry.role === 'assistant'
    ))
    .filter(entry => entry.id > 0 && Boolean(entry.content));
}

function normalizedContextRole(
  message: CatsAgentContextMessage,
  expectedAgentId: string,
): 'user' | 'assistant' | 'other_agent' | undefined {
  if (
    message.context_role === 'other_agent'
    && message.context_reason === 'other_agent_message'
    && isUsableParticipantId(message.from_uid)
    && !sameCatsCoUserId(message.from_uid, expectedAgentId)
  ) {
    return 'other_agent';
  }
  if (
    message.context_eligible === true
    && message.context_role === 'assistant'
    && message.context_reason === 'current_agent_message'
    && sameCatsCoUserId(message.from_uid, expectedAgentId)
  ) {
    return 'assistant';
  }
  if (
    message.context_eligible === true
    && message.context_role === 'user'
    && !sameCatsCoUserId(message.from_uid, expectedAgentId)
    && isUsableParticipantId(message.from_uid)
  ) {
    return 'user';
  }
  return undefined;
}

export function isNativeFeishuClearBoundary(
  message: CatsAgentContextMessage,
  expectedTopicId = '',
  expectedAgentId = '',
): boolean {
  return Boolean(expectedTopicId && expectedAgentId)
    && isCatsCoAgentContextRecordInScope(message, expectedTopicId, expectedAgentId)
    && normalizedContextRole(message, expectedAgentId) === 'user'
    && message.context_reason === 'group_message_targets_agent'
    && /^\/clear(?:\s|$)/i.test(extractMessageText(message));
}

function formatParticipantMessage(
  message: CatsAgentContextMessage,
  expectedTopicId: string,
  otherAgent: boolean,
): string {
  const text = extractMessageText(message);
  if (!text) return '';
  const speaker = resolveTrustedCatsCoSpeakerIdentity({
    trustSource: 'server_agent_context',
    metadata: message.metadata,
    fallbackUserId: message.from_uid,
    expectedTopicId,
    messageTopicId: message.topic_id,
    kind: otherAgent ? 'other_agent' : 'human',
  });
  return prefixCatsCoParticipantContent(speaker, text) as string;
}

export function isCatsCoAgentContextRecordInScope(
  message: CatsAgentContextMessage,
  expectedTopicId: string,
  expectedAgentId: string,
): boolean {
  const messageTopicId = String(message.topic_id ?? '').trim();
  if (messageTopicId !== expectedTopicId) return false;
  const messageAgentId = String(message.agent_id ?? '').trim();
  const messageAgentUid = String(message.agent_uid ?? '').trim();
  return Boolean(messageAgentId && messageAgentUid)
    && sameCatsCoUserId(messageAgentId, expectedAgentId)
    && sameCatsCoUserId(messageAgentUid, expectedAgentId);
}

function isUsableParticipantId(value: unknown): boolean {
  const normalized = String(value ?? '').trim();
  return Boolean(normalized && !/^(?:usr)?0$/i.test(normalized));
}

function extractMessageText(message: CatsAgentContextMessage): string {
  if (Array.isArray(message.content_blocks)) {
    const blockText = message.content_blocks
      .map(block => asRecord(block))
      .filter(block => stringField(block, 'type') === 'text')
      .map(block => stringField(block, 'text'))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (blockText) return blockText;
  }
  if (typeof message.content === 'string') {
    const text = message.content.trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'string' ? parsed.trim() : text;
    } catch {
      return text;
    }
  }
  return '';
}

export function agentContextMessageSeq(message: CatsAgentContextMessage): number {
  return Number(message.seq_id || message.id || 0);
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stringField(record: UnknownRecord, key: string): string {
  return typeof record[key] === 'string' ? String(record[key]).trim() : '';
}

function numberField(record: UnknownRecord, key: string): number {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : 0;
}

function booleanField(record: UnknownRecord, key: string): boolean {
  return record[key] === true || record[key] === 1 || record[key] === '1' || record[key] === 'true';
}

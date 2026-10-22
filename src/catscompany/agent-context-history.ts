import type { ParsedCatsMessage } from './types';
import type { CatsAgentContextMessage } from './client';
import { formatSpeakerLabel } from './speaker-label';

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
): string[] {
  return selectNativeFeishuGroupContextEntries(history, afterSeq, currentTriggerSeq)
    .map(entry => entry.content);
}

export function selectNativeFeishuGroupContextEntries(
  history: CatsAgentContextMessage[],
  afterSeq = 0,
  currentTriggerSeq = 0,
): NativeFeishuGroupContextEntry[] {
  const ordered = [...history].sort((a, b) => agentContextMessageSeq(a) - agentContextMessageSeq(b));
  const clearBoundarySeq = ordered.reduce((latest, message) => (
    isNativeFeishuClearBoundary(message) ? Math.max(latest, agentContextMessageSeq(message)) : latest
  ), 0);
  const effectiveAfterSeq = Math.max(afterSeq, clearBoundarySeq);
  return ordered
    .filter(message => {
      const seq = agentContextMessageSeq(message);
      return seq > effectiveAfterSeq && (currentTriggerSeq <= 0 || seq !== currentTriggerSeq);
    })
    .map(message => {
      const role = normalizedContextRole(message);
      return {
        source: 'catscompany.agent_context' as const,
        id: agentContextMessageSeq(message),
        role,
        content: role === 'assistant'
          ? extractMessageText(message)
          : formatParticipantMessage(message),
      };
    })
    .filter((entry): entry is NativeFeishuGroupContextEntry => Boolean(entry.role))
    .filter(entry => entry.id > 0 && Boolean(entry.content));
}

function normalizedContextRole(
  message: CatsAgentContextMessage,
): 'user' | 'assistant' | undefined {
  if (
    message.context_role === 'other_agent'
    && message.context_reason === 'other_agent_message'
  ) {
    return 'user';
  }
  // 人类 @别人 的消息：服务端标 context_eligible=false 是为了表达"这不该激活
  // 你的回合"，客户端却把它当成了"你不该看见"。可见性与回复资格是两件事——
  // 这条消息仍应进入长期上下文，让下一次真实激活时看到完整对话；是否回复由
  // 激活门控单独决定，与这里无关。
  if (message.context_reason === 'group_message_targets_another_member') {
    return 'user';
  }
  if (
    message.context_eligible === true
    && (message.context_role === 'user' || message.context_role === 'assistant')
  ) {
    return message.context_role;
  }
  return undefined;
}

export function isNativeFeishuClearBoundary(message: CatsAgentContextMessage): boolean {
  return message.context_eligible === true
    && message.context_role === 'user'
    && message.context_reason === 'group_message_targets_agent'
    && /^\/clear(?:\s|$)/i.test(extractMessageText(message));
}

function formatParticipantMessage(message: CatsAgentContextMessage): string {
  const text = extractMessageText(message);
  if (!text) return '';
  const metadata = asRecord(message.metadata);
  const identity = asRecord(metadata.catsco_identity);
  // 带上（人）/（bot）标记：判定判据要求区分人在提问还是同伴在汇报，而只靠
  // 名字区分不出来。服务端已下发 actor.is_bot，这里只是渲染它。
  const speaker = formatSpeakerLabel({ actor: identity.actor, fallbackUid: message.from_uid });
  return `[发言人: ${speaker}]\n${text}`;
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
  // 附件消息（file/image/voice）的正文是富对象。以前这里只认 text block 和字符串，
  // 附件一律返回空 → 整条被上游过滤掉，群历史回填时同伴发过的文件就凭空消失。
  // 服务端已在 agent 副本的 description 里带了绝对地址，这里渲染出来，模型才能
  // 在下次激活时用 read_file 直接读。
  if (message.content && typeof message.content === 'object') {
    const rich = message.content as UnknownRecord;
    const type = stringField(rich, 'type') || String(message.type || message.msg_type || '').trim();
    const payload = rich.payload && typeof rich.payload === 'object'
      ? rich.payload as UnknownRecord
      : rich;
    const name = stringField(payload, 'name') || stringField(payload, 'file_name');
    const description = stringField(payload, 'text') || stringField(payload, 'description');
    if (type === 'file') return `[历史文件${name ? `：${name}` : ''}]${description ? ` ${description}` : ''}`;
    if (type === 'image') return `[历史图片${name ? `：${name}` : ''}]${description ? ` ${description}` : ''}`;
    if (type === 'voice') return `[历史语音]${description ? ` ${description}` : ''}`;
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

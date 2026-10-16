import type { Message } from '../types';

/**
 * 本 Agent 自己发出的、还没有远端 id 的 assistant 文本。
 *
 * 回填（appendDurableContext）按 `source:id` 去重，但本机生成的回复没有
 * __remoteContextId，认不出回填回来的就是自己那条——于是同一句回复在同一段
 * 历史里出现两遍（实测相邻重复）。这里按内容比对补上这一层。
 *
 * 只收 assistant：同伴的消息渲染时带 `[发言人: …（bot）]` 前缀，不会和本机的
 * 裸回复撞上。真正"错过"的回复（本地没有，例如发出后进程就挂了）不在这个集合
 * 里，仍会被回填收下，恢复语义不变。
 */
export function collectLocalAssistantTexts(messages: Message[]): Set<string> {
  const texts = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.__remoteContextSource) continue;
    if (typeof message.content !== 'string') continue;
    const text = message.content.trim();
    if (text) texts.add(text);
  }
  return texts;
}

export interface DurableContextEntryLike {
  content: string;
  role?: 'user' | 'assistant';
  source?: string;
  id?: number;
}

export interface DurableContextDedupState {
  /** 已经在 transcript 里出现过的远端条目键（`source:id`）。 */
  knownRemoteIds: Set<string>;
  /** 压缩后仍被 transcript 表示的远端消息高水位。 */
  watermarks: Record<string, number>;
  /** 本机已发出的 assistant 文本。 */
  localAssistantTexts: Set<string>;
}

/**
 * 判断一条待回填的远端条目是否已经被本地 transcript 表示过。
 *
 * 命中时会顺带把它的键记进 knownRemoteIds，使同一批里重复出现的条目也只保留
 * 一条——与原先就地维护该集合的行为一致。
 */
export function isDuplicateDurableContextEntry(
  entry: DurableContextEntryLike,
  state: DurableContextDedupState,
): boolean {
  if (entry.role === 'assistant' && state.localAssistantTexts.has(entry.content.trim())) {
    return true;
  }
  const source = typeof entry.source === 'string' ? entry.source.trim() : '';
  const id = Number(entry.id);
  if (!source || !Number.isFinite(id) || id <= 0) return false;
  const key = `${source}:${id}`;
  if (state.knownRemoteIds.has(key) || id <= (state.watermarks[source] || 0)) {
    return true;
  }
  state.knownRemoteIds.add(key);
  return false;
}

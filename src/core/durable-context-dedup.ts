import type { Message } from '../types';

/**
 * 回填去重：认出「远端这条就是我发的」。
 * 主键是 `source:id`。但本机发出的消息落盘时还没有 id —— `saveContext` 在
 * `reply` 之前就执行完了（conversation-runner 先 push 最终消息，index.ts 之后才
 * 发送）。所以发送成功后把服务端返回的 seq 记进运行态（`sentRemoteIds`），回填
 * 时按 id 认领。
 *
 * 这里刻意**不做正文比对**。正文在三种真实形态下都对不上：长回复按 4000 字拆段
 * 发送（回填的是单段、本地存的是全文）、发送前会剥掉 `[已发送信息]` 前缀（本地
 * 存的是未剥的）、服务端还会在 agent 副本上改写（`@usr<id>` 换名字、附件追加
 * 地址）。反过来，正文比对还会误伤：同一句短确认（「收到」）发两次时，后一条的
 * 远端副本会被前一条的本地文本挡掉。
 */

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
  /** 本运行体发出的消息键（`source:id`），由发送成功后记录。 */
  sentRemoteIds: Set<string>;
}

/** 把记录的 `source:id` 列表转成集合。 */
export function collectSentRemoteIds(
  source: string,
  ids: number[] | undefined,
): Set<string> {
  const keys = new Set<string>();
  const normalizedSource = typeof source === 'string' ? source.trim() : '';
  if (!normalizedSource || !Array.isArray(ids)) return keys;
  for (const id of ids) {
    const value = Number(id);
    if (Number.isFinite(value) && value > 0) keys.add(`${normalizedSource}:${value}`);
  }
  return keys;
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
  const source = typeof entry.source === 'string' ? entry.source.trim() : '';
  const id = Number(entry.id);
  if (!source || !Number.isFinite(id) || id <= 0) return false;
  const key = `${source}:${id}`;
  if (
    state.sentRemoteIds.has(key)
    || state.knownRemoteIds.has(key)
    || id <= (state.watermarks[source] || 0)
  ) {
    state.knownRemoteIds.add(key);
    return true;
  }
  state.knownRemoteIds.add(key);
  return false;
}

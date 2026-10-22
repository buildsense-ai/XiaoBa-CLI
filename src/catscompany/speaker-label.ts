/**
 * 发言人标签：把一条消息的发送者渲染成模型能读懂的名字。
 *
 * 为什么要带身份：判定判据要求区分"人在问我"和"同伴在汇报"。只标 bot 的话，
 * "没有标记"就有两种含义（是人 / 标记丢了），判定器无法可靠判断——所以人和
 * bot 都显式标注，不依赖"没标记 = 人"这种隐式约定。
 *
 * 服务端已经在下发 `actor.is_bot`，这里只是把它渲染出来。
 */

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stringField(record: UnknownRecord, key: string): string {
  return typeof record[key] === 'string' ? String(record[key]).trim() : '';
}

export interface SpeakerLabelInput {
  /** `catsco_identity.actor` 对象；缺失时退回到 uid。 */
  actor?: unknown;
  /** 兜底 uid，例如 `usr42`。 */
  fallbackUid?: string | number | null;
}

/**
 * 返回形如 `林（人）` / `阿码（bot）` 的标签。
 *
 * `is_bot` 缺失时不加后缀：旧服务端不下发它，此时硬猜一个身份比不标更糟。
 */
export function formatSpeakerLabel(input: SpeakerLabelInput): string {
  const actor = asRecord(input.actor);
  const name = stringField(actor, 'display_name')
    || stringField(actor, 'username')
    || stringField(actor, 'user_id')
    || String(input.fallbackUid ?? '').trim()
    || 'User';

  const isBot = actor.is_bot;
  if (isBot === true) return `${name}（bot）`;
  if (isBot === false) return `${name}（人）`;
  return name;
}

/**
 * 平台派活的回复归属：这条回复指回哪条 prompt（reply_to）、属于哪个 bot 会话（turnDone）。
 *
 * **为什么不能只按 sessionKey 存一个槽**：
 *  - 私聊里 sessionKey 已经含 bot 会话 id（`catsco_bot_session_id`），一单一个键，没问题；
 *  - 群聊里 message-envelope 把 sessionKey 折叠成「群 + 发言账号」（群历史必须连续，
 *    不能一单一段），于是同一个群里同一个账号的多单共用一个键。
 *
 * 单槽的结果是「后到的覆盖先到的」：先跑完的那单会带着**别人**的 turnDone 回话，
 * 平台按 reply_to / 会话 id 认领不到它，只能一路等到超时（`bot_timeout`）。
 *
 * 所以按 `(sessionKey, botSessionId)` 存，并按**到达顺序**认领：
 * 同一 sessionKey 上的回合是串行排队的，先到先跑；最终回复（不带 `progress`）认领并消费队首，
 * 中间叙述只读不消费。真的拿不准（没有登记）就干脆不带标记 —— **认错比不带更贵**：
 * 不带只是让平台按超时兜底，认错会把 A 的结果交付给 B。
 */
export interface BotCallReplyOptions {
  replyTo: number;
  turnDone?: string;
  turnProgress?: boolean;
}

/** 登记的有效期：一单平台派活的回合是分钟级的，10 分钟足够，过期的是崩溃/丢消息的残留。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** 单个 sessionKey 上最多同时记多少单（防异常数据把表撑大）。 */
const MAX_PER_SESSION_KEY = 32;

interface BotCallReplyEntry {
  botSessionId: string;
  replyTo: number;
  at: number;
}

export class BotCallReplyTracker {
  private readonly entries = new Map<string, BotCallReplyEntry[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** 收到一条平台派活消息：登记「这个 bot 会话的回复要指回这条 prompt」。 */
  note(sessionKey: string, botSessionId: string, replyTo: number): void {
    if (!sessionKey || !botSessionId) return;
    if (!Number.isSafeInteger(replyTo) || replyTo <= 0) return;
    const at = this.now();
    const list = (this.entries.get(sessionKey) ?? [])
      .filter(entry => at - entry.at < this.ttlMs && entry.botSessionId !== botSessionId);
    list.push({ botSessionId, replyTo, at });
    while (list.length > MAX_PER_SESSION_KEY) list.shift();
    this.entries.set(sessionKey, list);
  }

  /**
   * 真人消息到来：这批平台派活的「当前回合」结束了，登记全部作废。
   *
   * 与旧行为保持一致：真人对话不认领任何平台派活标记 —— 否则群里的普通回复
   * 会被回填成对某条 prompt 的引用，观感完全不同。
   */
  clear(sessionKey: string): void {
    this.entries.delete(sessionKey);
  }

  /** 生成一次回复要带的标记；没有可信登记就返回 undefined（宁可不带，也不猜）。 */
  forReply(sessionKey: string, opts?: { progress?: boolean }): BotCallReplyOptions | undefined {
    const stored = this.entries.get(sessionKey);
    if (!stored || stored.length === 0) return undefined;
    const at = this.now();
    const live = stored.filter(entry => at - entry.at < this.ttlMs);
    if (live.length === 0) {
      this.entries.delete(sessionKey);
      return undefined;
    }
    const head = live[0];
    if (opts?.progress) {
      // 中间叙述：只读队首，绝不消费、绝不签「说完了」。
      if (live.length !== stored.length) this.entries.set(sessionKey, live);
      return { replyTo: head.replyTo, turnProgress: true };
    }
    live.shift();
    if (live.length === 0) this.entries.delete(sessionKey);
    else this.entries.set(sessionKey, live);
    return { replyTo: head.replyTo, turnDone: head.botSessionId };
  }

  /** 当前登记的条数（诊断/测试用）。 */
  size(sessionKey: string): number {
    return this.entries.get(sessionKey)?.length ?? 0;
  }
}

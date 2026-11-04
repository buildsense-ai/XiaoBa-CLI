/**
 * BotCallWindow —— 「我们正在把这个 bot 当工具调用」的时间窗。
 *
 * 为什么需要它：把另一个 bot 当工具调用时，平台会在**同一个会话**里写 prompt、
 * 目标 bot 也在**同一个会话**里回进度。调用方自己的运行时看到这些消息，会把它们
 * 当成新的用户指令再跑一轮 —— 于是两个 bot 互刷：A 回 B 的进度、B 再回 A 的回应。
 *
 * 实测（2026-11-04，topic p2p_982_1619）：一次 `sleep 120` 的调用里，两个 bot
 * 在 70 秒内互刷了 18 条消息，目标 bot 的会话上下文被自己刷乱，平台最终交出去的
 * 「答案」是一句「回环信息，没有新任务」。
 *
 * 正确的语义是：**调用进行中，那个会话里的消息是执行过程，不是新任务。**
 * 这个类只负责记「哪些会话正处于调用窗口、以及窗口刚关闭的一小段余韵」，
 * 判定与处置留给调用方（消息入口直接丢弃，不启动新回合）。
 *
 * 余韵（grace）是必要的：目标 bot 的最后一句往往和工具返回几乎同时落库，
 * 关掉窗口立刻放行会把「答案回声」当成新指令，又起一轮。
 */


/**
 * 由平台 prompt 标记出来的「bot 调用通道」维持多久。
 *
 * 取 15 分钟：默认单次调用上限是 5 分钟，留出重试与慢答复的余量；再长就会把
 * 「一段时间后用户真的又来这个会话说话」也吃掉。
 */
export const DEFAULT_BOT_CALL_WINDOW_MARK_TTL_MS = 15 * 60 * 1000;
/** 窗口关闭后的余韵：这段时间内到达的消息同样算「工具调用的余波」。 */
export const DEFAULT_BOT_CALL_WINDOW_GRACE_MS = 10_000;

export class BotCallWindow {
  /** topic -> 正在进行的调用数（同一个会话可能被并发调用）。 */
  private readonly open = new Map<string, number>();
  /** topic -> 最近一次窗口关闭的时刻。 */
  private readonly closedAt = new Map<string, number>();
  /** topic -> 标记到期时刻（由平台 prompt 的 catsco_bot_call 标记得出）。 */
  private readonly markedUntil = new Map<string, number>();

  constructor(
    private readonly graceMs = DEFAULT_BOT_CALL_WINDOW_GRACE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 进入窗口，返回**幂等**的退出函数：重复调用只生效一次，
   * 免得异常路径里 finally 与手动释放叠加把计数减成负数。
   */
  enter(topic: string): () => void {
    const key = topic.trim();
    if (!key) return () => {};
    this.open.set(key, (this.open.get(key) ?? 0) + 1);
    this.closedAt.delete(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.open.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.open.set(key, remaining);
        return;
      }
      this.open.delete(key);
      this.closedAt.set(key, this.now());
    };
  }

  /**
   * 把会话标记成「平台 bot 调用通道」，维持 ttl。
   *
   * 和 enter/leave 的区别：那对是「本进程正在调工具」的实时状态；这个是**从消息本身
   * 得知**的长期事实 —— 调用方 bot 会收到平台代它写进 p2p 会话的那条 prompt
   * （`metadata.catsco_bot_call` + `catsco_caller_uid` 等于自己），那就是「这个会话
   * 是平台在用它当工具通道」的确凿信号，之后那个会话里的消息都不该再起新回合。
   */
  mark(topic: string, ttlMs = DEFAULT_BOT_CALL_WINDOW_MARK_TTL_MS): void {
    const key = topic.trim();
    if (!key) return;
    this.markedUntil.set(key, this.now() + ttlMs);
  }

  /** 这个会话此刻是否处在调用窗口（含关闭后的余韵）里。 */
  isInCall(topic: string): boolean {
    const key = topic.trim();
    if (!key) return false;
    if ((this.open.get(key) ?? 0) > 0) return true;
    const until = this.markedUntil.get(key);
    if (until !== undefined) {
      if (this.now() < until) return true;
      this.markedUntil.delete(key);
    }
    const closed = this.closedAt.get(key);
    if (closed === undefined) return false;
    if (this.now() - closed < this.graceMs) return true;
    // 余韵过期就顺手清掉，避免长跑进程里无限累积。
    this.closedAt.delete(key);
    return false;
  }
  /** 当前正在进行的窗口（诊断/测试用）。 */
  activeTopics(): string[] {
    return [...this.open.keys()];
  }
  clear(): void {
    this.open.clear();
    this.closedAt.clear();
    this.markedUntil.clear();
  }
}

/** 进程内默认实例：工具桥进入/退出，消息入口查询。 */
export const defaultBotCallWindow = new BotCallWindow();

/**
 * 这条消息是不是「平台代我写进来的调用 prompt」。
 *
 * 判据：`metadata.catsco_bot_call` 为真，且 `metadata.catsco_caller_uid` 就是我。
 * （平台写 prompt 时 from_uid 就是调用方，所以调用方 bot 会收到自己发出的这条。）
 *
 * uid 可能带 `usr` 前缀，比较时只留数字；任一侧拿不到数字就退回原样比较 ——
 * 宁可漏判（退化成旧行为）也不要误判把正常会话封掉。
 */
export function isSelfAuthoredBotCallPrompt(
  metadata: Record<string, unknown> | undefined,
  botUid: string | number | undefined,
): boolean {
  if (!metadata) return false;
  if (botUid === undefined || botUid === null || botUid === '') return false;
  const flagged = metadata.catsco_bot_call === true || metadata.catsco_bot_call === 'true';
  if (!flagged) return false;
  const callerUid = metadata.catsco_caller_uid;
  if (callerUid === undefined || callerUid === null || callerUid === '') return false;
  const digits = (value: unknown) => String(value).replace(/[^0-9]/g, '');
  const left = digits(callerUid);
  const right = digits(botUid);
  if (left && right) return left === right;
  return String(callerUid).trim() === String(botUid).trim();
}

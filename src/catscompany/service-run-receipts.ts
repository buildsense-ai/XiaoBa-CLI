/**
 * 服务 run 回执路由（设计 §19 / 平台 catsco.service-run-receipt.v1）。
 *
 * 背景：MCP 工具调用可能超过同步等待窗口（平台返回 running 句柄），宿主在
 * `CatsCoMcpToolBridge.onRunPending` 里把 run 登记到本路由；平台在 run 终态时
 * 通过 WS 推送回执（至少一次投递 + receipt_id 幂等），本路由据此找出它属于哪个
 * 会话（sessionKey / topic / 调用它的工具），让宿主唤醒下一回合。
 *
 * 关键约束：
 * - **进程级单例**：桥接在 runtime-factory 创建，WS 客户端在 CatsCompany 服务里，
 *   两者不在同一对象树上 —— 共享本模块导出的单例。
 * - **幂等**：receipt_id 24h 内只消费一次（平台可能重投）；run_id 一次只被登记一次。
 * - **有界**：条目与去重表都有 TTL + 上限，不会无限增长。
 */
export interface PendingServiceRun {
  runId: string;
  serviceSessionId: string;
  toolName: string;
  /** 本机会话 key（= executionScope.sessionKey，消息队列的键）。 */
  conversationSessionKey?: string;
  /** 平台 topic（p2p_xxx / grp_xxx）。 */
  conversationTopic?: string;
  /** 触发本次调用的真人 uid（唤醒回合时的 senderId）。 */
  actorUserId?: string;
  trackedAt: number;
}

export interface ServiceRunReceipt {
  contract_version?: string;
  receipt_id?: string;
  run_id?: string;
  session_id?: string;
  status?: string;
  question?: string;
  error?: string;
  created_at?: string;
}

export interface ConsumedServiceRunReceipt {
  receipt: ServiceRunReceipt;
  run: PendingServiceRun;
}

const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

export class ServiceRunReceiptRouter {
  private readonly pending = new Map<string, PendingServiceRun>();
  private readonly seenReceipts = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_RECEIPT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /** 登记一个「已放弃轮询、等平台回执」的 run（同 run 重复登记只保留最新一条）。 */
  track(info: {
    runId: string;
    serviceSessionId?: string;
    toolName?: string;
    conversationSessionKey?: string;
    conversationTopic?: string;
    actorUserId?: string;
  }): void {
    const runId = String(info.runId || '').trim();
    if (!runId) return;
    this.prune();
    this.pending.set(runId, {
      runId,
      serviceSessionId: info.serviceSessionId ?? '',
      toolName: info.toolName ?? '',
      ...(info.conversationSessionKey ? { conversationSessionKey: info.conversationSessionKey } : {}),
      ...(info.conversationTopic ? { conversationTopic: info.conversationTopic } : {}),
      ...(info.actorUserId ? { actorUserId: info.actorUserId } : {}),
      trackedAt: this.now(),
    });
    while (this.pending.size > this.maxEntries) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  /**
   * 消费一条回执：命中未过期的登记项则返回并移除（一个 run 只唤醒一次）。
   * 重复 receipt_id / 未登记的 run / 过期 run → null。
   */
  consume(receipt: ServiceRunReceipt | null | undefined): ConsumedServiceRunReceipt | null {
    if (!receipt) return null;
    const receiptId = String(receipt.receipt_id || '').trim();
    const runId = String(receipt.run_id || '').trim();
    if (!runId) return null;
    const now = this.now();
    this.prune(now);

    if (receiptId) {
      const seenAt = this.seenReceipts.get(receiptId);
      if (seenAt !== undefined && now - seenAt < this.ttlMs) return null;
      this.seenReceipts.set(receiptId, now);
    }

    const run = this.pending.get(runId);
    if (!run) return null;
    this.pending.delete(runId);
    return { receipt, run };
  }

  /** 待唤醒 run 数（诊断）。 */
  get pendingCount(): number {
    this.prune();
    return this.pending.size;
  }

  /** 测试用：清空状态。 */
  reset(): void {
    this.pending.clear();
    this.seenReceipts.clear();
  }

  private prune(now = this.now()): void {
    for (const [runId, entry] of this.pending) {
      if (now - entry.trackedAt >= this.ttlMs) this.pending.delete(runId);
    }
    for (const [receiptId, seenAt] of this.seenReceipts) {
      if (now - seenAt >= this.ttlMs) this.seenReceipts.delete(receiptId);
    }
    while (this.seenReceipts.size > this.maxEntries) {
      const oldest = this.seenReceipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenReceipts.delete(oldest);
    }
  }
}

/** 进程级单例（桥接与 CatsCompany 服务共用）。 */
export const serviceRunReceiptRouter = new ServiceRunReceiptRouter();

/**
 * 把回执渲染成「唤醒回合」的提示文本。
 * 明确标注这是后台任务结果，避免模型把它当成新的用户诉求。
 */
export function buildServiceRunReceiptPrompt(consumed: ConsumedServiceRunReceipt): string {
  const { receipt, run } = consumed;
  const status = String(receipt.status || 'unknown');
  const tool = run.toolName || 'catsco_agent';
  const head = `（后台任务回执：工具 ${tool}，run ${run.runId}，状态 ${status}）`;
  if (status === 'completed') {
    return `${head}\n后台任务已经完成，结果如下（可能包含用户还没看到的产出）：\n` +
      `${receipt.error ? '' : ''}请基于该结果继续推进当前任务，并简要说明结论。`;
  }
  if (status === 'awaiting_input') {
    const question = String(receipt.question || '').trim();
    return `${head}\n后台任务需要用户补充信息：${question || '（对方未给出具体问题）'}\n请把这个问题转述给用户。`;
  }
  if (status === 'failed') {
    return `${head}\n后台任务失败：${String(receipt.error || '未知原因')}\n请告知用户失败原因，并给出是否重试的建议。`;
  }
  return `${head}\n请结合该状态向用户说明当前进展。`;
}

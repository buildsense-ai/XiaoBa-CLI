/**
 * Cats HPC 后台任务回执路由。
 *
 * 算力报价不是 service_run，因此单独按 quote_id 关联原对话。平台在资源释放、
 * 实际计量和积分结算完成后投递一次终态回执，客户端据此唤醒原 Agent。
 */
export interface PendingComputeTask {
  quoteId: string;
  toolName: string;
  conversationSessionKey?: string;
  conversationTopic?: string;
  actorUserId?: string;
  trackedAt: number;
}

export interface ComputeTaskReceipt {
  contract_version?: string;
  receipt_id?: string;
  quote_id?: string;
  status?: string;
  state?: string;
  charged_units?: number;
  progress?: unknown;
  error?: string;
  created_at?: string;
}

export interface ConsumedComputeTaskReceipt {
  receipt: ComputeTaskReceipt;
  task: PendingComputeTask;
}

const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

export class ComputeTaskReceiptRouter {
  private readonly pending = new Map<string, PendingComputeTask>();
  private readonly seenReceipts = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_RECEIPT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  track(info: {
    quoteId: string;
    toolName?: string;
    conversationSessionKey?: string;
    conversationTopic?: string;
    actorUserId?: string;
  }): void {
    const quoteId = String(info.quoteId || '').trim();
    if (!quoteId) return;
    this.prune();
    this.pending.set(quoteId, {
      quoteId,
		toolName: info.toolName ?? 'catsco_compute',
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

  consume(receipt: ComputeTaskReceipt | null | undefined): ConsumedComputeTaskReceipt | null {
    if (!receipt) return null;
    const receiptId = String(receipt.receipt_id || '').trim();
    const quoteId = String(receipt.quote_id || '').trim();
    if (!quoteId) return null;
    const now = this.now();
    this.prune(now);
    if (receiptId) {
      const seenAt = this.seenReceipts.get(receiptId);
      if (seenAt !== undefined && now - seenAt < this.ttlMs) return null;
      this.seenReceipts.set(receiptId, now);
    }
    const task = this.pending.get(quoteId);
    if (!task) return null;
    this.pending.delete(quoteId);
    return { receipt, task };
  }

  get pendingCount(): number {
    this.prune();
    return this.pending.size;
  }

  reset(): void {
    this.pending.clear();
    this.seenReceipts.clear();
  }

  private prune(now = this.now()): void {
    for (const [quoteId, entry] of this.pending) {
      if (now - entry.trackedAt >= this.ttlMs) this.pending.delete(quoteId);
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

export const computeTaskReceiptRouter = new ComputeTaskReceiptRouter();

export function buildComputeTaskReceiptPrompt(consumed: ConsumedComputeTaskReceipt): string {
  const { receipt, task } = consumed;
  const status = String(receipt.status || receipt.state || 'unknown');
  const evidence = JSON.stringify({
    quote_id: receipt.quote_id || task.quoteId,
    status,
    charged_units: receipt.charged_units,
    progress: receipt.progress,
    error: receipt.error,
  });
  return `（算力后台任务回执：工具 ${task.toolName}，quote_id ${task.quoteId}，状态 ${status}）\n` +
    `平台已经根据 Slurm 终态、资源释放证据和实际占用完成结算。完整回执：${evidence}\n` +
    (status === 'completed'
      ? '请把最终结果和实际扣费简要告知用户，然后结束当前回合。不要重复提交同一算力任务。'
      : '请把失败原因、资源回收状态和实际扣费简要告知用户，然后结束当前回合。不要重复提交同一算力任务。');
}

/**
 * MCP progressToken → CatsCo task_status 节流桥接。
 *
 * 背景：MCP server 执行长任务时通过 `notifications/progress` 上报进度，
 * 客户端在 `tools/call` 请求里用 `_meta.progressToken` 关联。进度信息对
 * 用户侧「任务状态」展示有价值，但有两个硬约束：
 * 1. **高频**：长任务可能秒级多次推送 —— 必须节流（默认每个 call 500ms 最多一次，
 *    尾部 trailing 发射保证最终进度不丢）；
 * 2. **绝不唤醒模型回合**：progress 是状态展示信号，不是新输入。
 *    桥接只走 MessageSender 风格的 sink 回调，与 ExternalEventRouter 完全隔离。
 *
 * 与 CatsCo 的耦合收敛为一个窄 sink 接口；测试注入内存 sink 即可。
 */

/** 与 message-sender 的 ConversationTaskStatusInput 对齐的窄结构（结构化类型，避免反向依赖）。 */
export interface ProgressTaskStatusUpdate {
  topic: string;
  status: {
    run_id: string;
    artifact_task_ref?: string;
    state: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
    summary: string;
    error?: string;
  };
}

/** 进度更新投递目标（生产 = CatsCo MessageSender 适配器）。 */
export type McpProgressSink = (update: ProgressTaskStatusUpdate) => void | Promise<void>;

/** 发起 tools/call 时的会话上下文。 */
export interface ProgressCallContext {
  topic?: string;
  runId?: string;
  artifactTaskRef?: string;
  toolName?: string;
}

export interface McpProgressBridgeOptions {
  sink?: McpProgressSink;
  /** 每个 call 两次前进之间的最小间隔（默认 500ms）。 */
  throttleMs?: number;
  now?: () => number;
  /** 可注入的定时器（测试用假时钟）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  onSinkError?: (error: unknown) => void;
}

interface TrackedCall {
  context: ProgressCallContext;
  serverId: string;
  lastEmitAt: number;
  trailingTimer: unknown | null;
  pending: { progress: number; total?: number; message?: string } | null;
  lastProgressKey: string | null;
  finished: boolean;
}

export class McpProgressBridge {
  private sink?: McpProgressSink;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly onSinkError?: (error: unknown) => void;
  private readonly calls = new Map<string, TrackedCall>();
  private tokenCounter = 0;

  constructor(options: McpProgressBridgeOptions = {}) {
    this.sink = options.sink;
    this.throttleMs = options.throttleMs ?? 500;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn
      ?? ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // 进度尾发不该阻止进程退出。
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
    this.onSinkError = options.onSinkError;
  }

  setSink(sink: McpProgressSink | undefined): void {
    this.sink = sink;
  }

  /** 为一次 tools/call 生成唯一 progressToken 并登记会话上下文。 */
  beginCall(serverId: string, context: ProgressCallContext): string {
    this.tokenCounter += 1;
    const token = `xb-${serverId}-${this.now().toString(36)}-${this.tokenCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.calls.set(token, {
      context,
      serverId,
      lastEmitAt: 0,
      trailingTimer: null,
      pending: null,
      lastProgressKey: null,
      finished: false,
    });
    return token;
  }

  /** tools/call 结算（无论成败）：刷新尾部进度后停止追踪。 */
  endCall(token: string): void {
    const tracked = this.calls.get(token);
    if (!tracked) return;
    tracked.finished = true;
    if (tracked.trailingTimer !== null) {
      this.clearTimeoutFn(tracked.trailingTimer);
      tracked.trailingTimer = null;
    }
    if (tracked.pending) {
      const pending = tracked.pending;
      tracked.pending = null;
      this.emitNow(token, tracked, pending);
    }
    this.calls.delete(token);
  }

  /** 处理一条 notifications/progress。未知 token 静默忽略（可能是其它客户端的调用）。 */
  handleProgress(params: unknown): boolean {
    if (typeof params !== 'object' || params === null) return false;
    const record = params as Record<string, unknown>;
    const token = typeof record.progressToken === 'string' || typeof record.progressToken === 'number'
      ? String(record.progressToken)
      : undefined;
    if (!token) return false;
    const tracked = this.calls.get(token);
    if (!tracked) return false;
    if (typeof record.progress !== 'number' || !Number.isFinite(record.progress)) return true;

    const update = {
      progress: record.progress,
      ...(typeof record.total === 'number' && Number.isFinite(record.total) ? { total: record.total } : {}),
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
    };

    // 完全相同的进度值/文本不重复上报（服务端常按固定间隔重发）。
    const progressKey = `${update.progress}/${update.total ?? ''}/${update.message ?? ''}`;
    if (progressKey === tracked.lastProgressKey) return true;

    const now = this.now();
    const elapsed = now - tracked.lastEmitAt;
    if (tracked.lastEmitAt === 0 || elapsed >= this.throttleMs) {
      this.emitNow(token, tracked, update);
    } else {
      // 节流窗口内：缓存为 trailing，保证窗口结束时把最新进度发出去。
      tracked.pending = update;
      if (tracked.trailingTimer === null) {
        const wait = Math.max(1, this.throttleMs - elapsed);
        tracked.trailingTimer = this.setTimeoutFn(() => {
          tracked.trailingTimer = null;
          if (tracked.finished) return;
          const pending = tracked.pending;
          tracked.pending = null;
          if (pending) this.emitNow(token, tracked, pending);
        }, wait);
      }
    }
    return true;
  }

  /** 追踪中的 call 数（诊断/测试用）。 */
  get trackedCallCount(): number {
    return this.calls.size;
  }

  /** 进程级清理：取消全部 trailing 定时器。 */
  dispose(): void {
    for (const tracked of this.calls.values()) {
      if (tracked.trailingTimer !== null) {
        this.clearTimeoutFn(tracked.trailingTimer);
        tracked.trailingTimer = null;
      }
    }
    this.calls.clear();
  }

  private emitNow(token: string, tracked: TrackedCall, update: { progress: number; total?: number; message?: string }): void {
    tracked.lastEmitAt = this.now();
    tracked.lastProgressKey = `${update.progress}/${update.total ?? ''}/${update.message ?? ''}`;
    const sink = this.sink;
    const { topic, runId, artifactTaskRef, toolName } = tracked.context;
    if (!sink || !topic || !runId) return; // 没有会话上下文时进度无处投递，静默丢弃。
    const percent = update.total && update.total > 0
      ? Math.round((update.progress / update.total) * 100)
      : null;
    const summaryParts = [
      toolName ? `MCP 工具 ${toolName} 执行中` : `MCP server ${tracked.serverId} 任务执行中`,
    ];
    if (percent !== null) summaryParts.push(`${percent}%`);
    else summaryParts.push(`progress ${update.progress}`);
    if (update.message) summaryParts.push(update.message.slice(0, 120));
    const status: ProgressTaskStatusUpdate = {
      topic,
      status: {
        run_id: runId,
        ...(artifactTaskRef ? { artifact_task_ref: artifactTaskRef } : {}),
        state: 'running',
        summary: summaryParts.join(' · '),
      },
    };
    try {
      const result = sink(status);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(error => this.onSinkError?.(error));
      }
    } catch (error) {
      this.onSinkError?.(error);
    }
  }
}

/** 判断一条通知是否 progress（桥接专用，绝不进唤醒路由）。 */
export function isProgressNotificationMethod(method: string): boolean {
  return method === 'notifications/progress';
}

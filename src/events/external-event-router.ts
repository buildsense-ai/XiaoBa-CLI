/**
 * 统一外部事件唤醒总线（设计「MCP Event Bus」的一部分）。
 *
 * 背景：今天只有 CatsCo 平台回执（service_run_receipt）能唤醒休眠会话，且路由逻辑
 * 耦合在 service-run-receipts.ts + CatsCompanyService 里。接下来 Artifacts 的 A2UI
 * 交互、Artifacts 批注、以及通用第三方 MCP Server 的事件推送，都需要走同一条
 * 「事件 → 找到会话 → 唤起一轮」的链路。
 *
 * 本模块只做三件事：
 * 1. 标准化事件信封（ExternalEventEnvelope）：所有外部来源共用同一形状。
 * 2. 路由决策：artifactId → sessionKey/topic 绑定表、eventId 幂等去重（24h）、
 *    按类型的聚合/防抖策略（A2UI 立即、批注窗口合并）。
 * 3. 统一 emit 入口：进程内单例供 MCP 通知适配层、CatsCompany WS、
 *    Dashboard / 本地 IPC 等任一入口投递。
 *
 * 本模块**不**负责把事件变成模型回合 —— 那是宿主（CatsCompanyService / CLI 适配层）
 * 订阅 dispatch 后做的事。路由只保证「同一事件只派发一次、派给正确的会话」。
 *
 * 关键约束（与 ServiceRunReceiptRouter 相同）：
 * - **进程级单例**：事件生产者在 WS/MCP/IPC 侧，消费者在会话调度侧，两者不在同一
 *   对象树上 —— 共享本模块导出的单例。
 * - **幂等**：eventId 在 TTL（默认 24h）内只消费一次；没有 eventId 的事件不去重
 *   （来源自己保证至少一次语义时应该带上 eventId）。
 * - **有界**：去重表、绑定表、防抖缓冲都有 TTL + 上限，不会无限增长。
 */

/** 已知的标准化事件来源。自定义来源允许任意 `xxx:yyy` 形态字符串。 */
export type ExternalEventSource =
  | `mcp:${string}`
  | 'artifact:a2ui'
  | 'artifact:annotation'
  | 'catsco:receipt'
  | (string & {});

/** 路由目标：三者至少给一个；artifactId 会先查绑定表补全 sessionKey/topic。 */
export interface ExternalEventTarget {
  /** 本机会话 key（= executionScope.sessionKey，消息队列的键）。 */
  sessionKey?: string;
  /** 平台 topic（p2p_xxx / grp_xxx），唤醒回合时需要。 */
  topic?: string;
  /** 关联的 artifact id；可用于查找绑定，也随事件透传给宿主。 */
  artifactId?: string;
}

export type ExternalEventPriority = 'immediate' | 'normal';

/** 统一外部事件信封。 */
export interface ExternalEventEnvelope {
  /** 幂等键：TTL（默认 24h）内相同 eventId 只派发一次。缺省 = 不去重。 */
  eventId?: string;
  /** 事件来源，如 mcp:<serverId> / artifact:a2ui / artifact:annotation / catsco:receipt。 */
  source: ExternalEventSource;
  /** 事件类型（来源内命名空间），如 a2ui.action / annotation.created / mcp.event。 */
  type: string;
  target?: ExternalEventTarget;
  /** 触发者 uid（唤醒回合时的 senderId）；缺省时宿主可用系统身份兜底。 */
  actorUserId?: string;
  /** 事件负载（原样透传给宿主渲染，本路由不解释）。 */
  payload?: unknown;
  /** immediate = 立即派发；normal = 参与聚合策略判定（默认 normal）。 */
  priority?: ExternalEventPriority;
  /** 事件产生时刻（ms）；缺省取当前时间。 */
  createdAt?: number;
  /**
   * 自定义提示文本渲染：来源方（如 catsco 回执、artifact 事件）把语义文本
   * 预渲染好，路由直接透传；缺省用路由的通用渲染。
   */
  buildText?: (event: ExternalEventEnvelope) => string;
  /** 防抖合并后记录被合并的原始 eventId（诊断/审计用，只读）。 */
  mergedEventIds?: string[];
}

/** 聚合防抖策略：命中防抖键的事件在窗口内合并为一次派发。 */
export interface ExternalEventAggregationPolicy {
  /** 合并窗口（ms）。0/缺省 = 该类型不聚合，逐条派发。 */
  windowMs: number;
  /** 防抖分组键；缺省 = `${sessionKey}\0${type}`（同一会话同类型合并）。 */
  debounceKey?: (event: ExternalEventEnvelope) => string;
  /**
   * 把新事件并入既有缓冲；缺省 = 负载合并为 `{ items: [...] }`。
   * 返回新的缓冲事件（不修改入参亦可）。
   */
  merge?: (pending: ExternalEventEnvelope, next: ExternalEventEnvelope) => ExternalEventEnvelope;
}

/** 宿主渲染提示文本（注入模型回合的 userMessage）。 */
export type ExternalEventPromptBuilder = (event: ExternalEventEnvelope) => string;

export interface ExternalEventDispatch {
  event: ExternalEventEnvelope;
  /** 解析后的会话键（可能来自 artifact 绑定表）。 */
  sessionKey: string;
  topic?: string;
  artifactId?: string;
  actorUserId?: string;
  /** 宿主可直接使用的提示文本；注入过 buildPrompt 则为自定义文本。 */
  text: string;
}

export type ExternalEventHandler = (dispatch: ExternalEventDispatch) => void | Promise<void>;

export interface ExternalEventRouterOptions {
  /** eventId 幂等窗口（默认 24h）。 */
  dedupeTtlMs?: number;
  /** artifact 绑定的有效期（默认 24h）。 */
  bindingTtlMs?: number;
  /** 各类缓存上限（默认 4096）。 */
  maxEntries?: number;
  /** 自定义聚合策略；缺省 = artifact:annotation 2s 合并，其余即时。 */
  aggregationPolicies?: Record<string, ExternalEventAggregationPolicy>;
  /** 自定义提示文本渲染；缺省 = 通用「外部事件」头 + 负载摘要。 */
  buildPrompt?: ExternalEventPromptBuilder;
  now?: () => number;
}

export const DEFAULT_EXTERNAL_EVENT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EXTERNAL_EVENT_BINDING_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EXTERNAL_EVENT_MAX_ENTRIES = 4096;
/** 批注类事件的默认合并窗口：连续批注在 2s 内合并为一次唤醒。 */
export const DEFAULT_ANNOTATION_DEBOUNCE_MS = 2_000;

interface ArtifactBinding {
  sessionKey: string;
  topic?: string;
  boundAt: number;
}

interface DebounceBuffer {
  pending: ExternalEventEnvelope;
  timer: ReturnType<typeof setTimeout>;
  firstAt: number;
}

export class ExternalEventRouter {
  private readonly dedupeTtlMs: number;
  private readonly bindingTtlMs: number;
  private readonly maxEntries: number;
  private readonly policies: Map<string, ExternalEventAggregationPolicy>;
  private readonly buildPrompt: ExternalEventPromptBuilder;
  private readonly now: () => number;

  private readonly seenEvents = new Map<string, number>();
  private readonly artifactBindings = new Map<string, ArtifactBinding>();
  private readonly debounced = new Map<string, DebounceBuffer>();
  private readonly handlers = new Set<ExternalEventHandler>();
  /** 串行派发链：保证同一进程内事件按序交付，防抖 flush 不会插队。 */
  private dispatchChain: Promise<void> = Promise.resolve();
  /** 派发失败计数（诊断用；失败绝不回抛给生产者）。 */
  private droppedDispatchCount = 0;

  constructor(options: ExternalEventRouterOptions = {}) {
    this.dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_EXTERNAL_EVENT_DEDUPE_TTL_MS;
    this.bindingTtlMs = options.bindingTtlMs ?? DEFAULT_EXTERNAL_EVENT_BINDING_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_EXTERNAL_EVENT_MAX_ENTRIES;
    this.buildPrompt = options.buildPrompt ?? defaultExternalEventPrompt;
    this.now = options.now ?? Date.now;
    this.policies = new Map(Object.entries(options.aggregationPolicies ?? {
      // 默认策略：批注合并、其余即时。A2UI 交互默认 immediate（用户点了就响应）。
      'artifact:annotation': { windowMs: DEFAULT_ANNOTATION_DEBOUNCE_MS },
    }));
  }

  /** 订阅派发（宿主入口）。返回退订函数。 */
  subscribe(handler: ExternalEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * 绑定 artifactId → 会话路由。
   *
   * Artifact 创建/关联到会话时由宿主调用一次；之后 A2UI/批注事件只需带 artifactId
   * 即可精准唤回原会话，不需要事件方知道本地 sessionKey。
   * 重复绑定同 artifactId 以最新为准（会话被 clear 后宿主应重新绑定）。
   */
  bindArtifact(artifactId: string, target: { sessionKey: string; topic?: string }): void {
    const id = artifactId.trim();
    const sessionKey = target.sessionKey.trim();
    if (!id || !sessionKey) return;
    this.prune();
    this.artifactBindings.set(id, {
      sessionKey,
      ...(target.topic ? { topic: target.topic } : {}),
      boundAt: this.now(),
    });
    this.evictOldest(this.artifactBindings);
  }

  /** 解除 artifact 绑定（artifact 销毁/会话解绑时调用）。 */
  unbindArtifact(artifactId: string): void {
    this.artifactBindings.delete(artifactId.trim());
  }

  /** 查询 artifact 当前绑定（未命中/过期 → undefined）。 */
  resolveArtifact(artifactId: string): { sessionKey: string; topic?: string } | undefined {
    const binding = this.artifactBindings.get(artifactId.trim());
    if (!binding) return undefined;
    if (this.now() - binding.boundAt >= this.bindingTtlMs) {
      this.artifactBindings.delete(artifactId.trim());
      return undefined;
    }
    return { sessionKey: binding.sessionKey, ...(binding.topic ? { topic: binding.topic } : {}) };
  }

  /** 覆盖/新增某来源的聚合策略（如测试或运维调窗口）。 */
  setAggregationPolicy(source: string, policy: ExternalEventAggregationPolicy): void {
    this.policies.set(source, policy);
  }

  /**
   * 统一投递入口（Dashboard / 本地 IPC / MCP 通知适配层 / CatsCompany WS 共用）。
   *
   * 返回 true = 已接受（立即派发或进入防抖缓冲）；false = 丢弃（重复 eventId
   * 或 envelope 非法）。事件没有可解析的 sessionKey 时也会返回 false ——
   * 唤不回任何会话的事件派发没有意义，但**会**先完成幂等登记，避免重投刷屏。
   */
  emit(envelope: ExternalEventEnvelope): boolean {
    if (!envelope || typeof envelope !== 'object') return false;
    const source = typeof envelope.source === 'string' ? envelope.source.trim() : '';
    const type = typeof envelope.type === 'string' ? envelope.type.trim() : '';
    if (!source || !type) return false;
    const event: ExternalEventEnvelope = {
      ...envelope,
      source: source as ExternalEventSource,
      type,
      priority: envelope.priority ?? 'normal',
      createdAt: envelope.createdAt ?? this.now(),
      ...(envelope.target ? { target: { ...envelope.target } } : {}),
    };

    this.prune();
    if (!this.claimEventId(event.eventId)) return false;

    const resolved = this.resolveTarget(event);
    if (!resolved) {
      // 已做幂等登记但没会话可派：记诊断后丢弃（绑定可能稍后建立，来源重投会被幂等拦截；
      // 需要「先缓存等绑定」的来源应在 emit 前自行等待绑定）。
      this.droppedDispatchCount += 1;
      return false;
    }
    event.target = {
      ...(event.target ?? {}),
      sessionKey: resolved.sessionKey,
      ...(resolved.topic ? { topic: resolved.topic } : {}),
      ...(resolved.artifactId ? { artifactId: resolved.artifactId } : {}),
    };

    // A2UI 动作等 immediate 事件绕过聚合直接派发。
    const policy = event.priority === 'immediate' ? undefined : this.policies.get(source);
    if (policy && policy.windowMs > 0) {
      this.buffer(event, policy);
      return true;
    }
    this.scheduleDispatch(event);
    return true;
  }

  /** 带缓冲等待：防抖事件 flush 完成后 resolve（测试/顺序敏感场景用）。 */
  async emitAndWait(envelope: ExternalEventEnvelope): Promise<boolean> {
    const accepted = this.emit(envelope);
    await this.dispatchChain;
    return accepted;
  }

  /** 待派发诊断（测试用）。 */
  get stats(): { pendingDebounced: number; bindings: number; dropped: number } {
    return {
      pendingDebounced: this.debounced.size,
      bindings: this.artifactBindings.size,
      dropped: this.droppedDispatchCount,
    };
  }

  /** 测试/进程收尾：清掉全部状态（含防抖定时器）。 */
  reset(): void {
    this.seenEvents.clear();
    this.artifactBindings.clear();
    for (const buffer of this.debounced.values()) clearTimeout(buffer.timer);
    this.debounced.clear();
    this.droppedDispatchCount = 0;
  }

  /** 登记幂等键；已见过（未过期）→ false。无 eventId → true（不去重）。 */
  private claimEventId(eventId: string | undefined): boolean {
    const id = typeof eventId === 'string' ? eventId.trim() : '';
    if (!id) return true;
    const seenAt = this.seenEvents.get(id);
    if (seenAt !== undefined && this.now() - seenAt < this.dedupeTtlMs) return false;
    this.seenEvents.set(id, this.now());
    this.evictOldest(this.seenEvents);
    return true;
  }

  /** 补全路由目标：优先显式 sessionKey；artifactId 查绑定表。 */
  private resolveTarget(
    event: ExternalEventEnvelope,
  ): { sessionKey: string; topic?: string; artifactId?: string } | null {
    const target = event.target ?? {};
    const explicitKey = typeof target.sessionKey === 'string' ? target.sessionKey.trim() : '';
    if (explicitKey) {
      return {
        sessionKey: explicitKey,
        ...(target.topic ? { topic: target.topic } : {}),
        ...(target.artifactId ? { artifactId: target.artifactId } : {}),
      };
    }
    const artifactId = typeof target.artifactId === 'string' ? target.artifactId.trim() : '';
    if (artifactId) {
      const binding = this.resolveArtifact(artifactId);
      if (binding) {
        return { sessionKey: binding.sessionKey, ...(binding.topic ? { topic: binding.topic } : {}), artifactId };
      }
    }
    // 只有 topic 没有 sessionKey：宿主可按 topic 找回会话的场景留待后续；
    // 当前路由层不做「topic → sessionKey」猜测，避免唤错会话。
    return null;
  }

  /** 进入防抖缓冲：同键事件合并，窗口结束一次性派发。 */
  private buffer(event: ExternalEventEnvelope, policy: ExternalEventAggregationPolicy): void {
    const key = policy.debounceKey?.(event)
      ?? `${event.target?.sessionKey ?? ''}\0${event.type}`;
    const existing = this.debounced.get(key);
    if (existing) {
      const merge = policy.merge ?? mergeEventPayloads;
      existing.pending = merge(existing.pending, event);
      clearTimeout(existing.timer);
      existing.timer = this.scheduleFlush(key, policy.windowMs);
      return;
    }
    this.debounced.set(key, {
      pending: event,
      timer: this.scheduleFlush(key, policy.windowMs),
      firstAt: this.now(),
    });
    this.evictOldestDebounce();
  }

  private scheduleFlush(key: string, windowMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const buffer = this.debounced.get(key);
      this.debounced.delete(key);
      if (buffer) this.scheduleDispatch(buffer.pending);
    }, Math.max(1, windowMs));
    // 防抖定时器不该阻止进程退出。
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  /** 串行派发：订阅者异常只计数，不影响后续事件与其它订阅者。 */
  private scheduleDispatch(event: ExternalEventEnvelope): void {
    this.dispatchChain = this.dispatchChain.then(() => this.dispatchNow(event)).catch(() => {});
  }

  private async dispatchNow(event: ExternalEventEnvelope): Promise<void> {
    const target = event.target ?? {};
    const sessionKey = typeof target.sessionKey === 'string' ? target.sessionKey : '';
    if (!sessionKey || this.handlers.size === 0) return;
    const dispatch: ExternalEventDispatch = {
      event,
      sessionKey,
      ...(target.topic ? { topic: target.topic } : {}),
      ...(target.artifactId ? { artifactId: target.artifactId } : {}),
      ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
      text: (event.buildText ?? this.buildPrompt)(event),
    };
    for (const handler of this.handlers) {
      try {
        await handler(dispatch);
      } catch {
        // 订阅者失败不阻断其它订阅者与后续事件；宿主自己负责记日志。
        this.droppedDispatchCount += 1;
      }
    }
  }

  private evictOldest(map: Map<string, { boundAt?: number } | number>): void {
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private evictOldestDebounce(): void {
    while (this.debounced.size > this.maxEntries) {
      const oldest = this.debounced.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const buffer = this.debounced.get(oldest);
      if (buffer) {
        clearTimeout(buffer.timer);
        this.scheduleDispatch(buffer.pending);
      }
      this.debounced.delete(oldest);
    }
  }

  private prune(now = this.now()): void {
    for (const [id, seenAt] of this.seenEvents) {
      if (now - seenAt >= this.dedupeTtlMs) this.seenEvents.delete(id);
    }
    for (const [id, binding] of this.artifactBindings) {
      if (now - binding.boundAt >= this.bindingTtlMs) this.artifactBindings.delete(id);
    }
    while (this.seenEvents.size > this.maxEntries) {
      const oldest = this.seenEvents.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenEvents.delete(oldest);
    }
  }
}

/** 默认负载合并：把连续事件收成 `{ items: [...] }`，便于宿主一次渲染多条批注。 */
export function mergeEventPayloads(
  pending: ExternalEventEnvelope,
  next: ExternalEventEnvelope,
): ExternalEventEnvelope {
  const pendingItems = Array.isArray((pending.payload as { items?: unknown[] })?.items)
    ? (pending.payload as { items: unknown[] }).items
    : pending.payload !== undefined
      ? [pending.payload]
      : [];
  const items = next.payload !== undefined ? [...pendingItems, next.payload] : pendingItems;
  const mergedIds = [
    ...(Array.isArray((pending as { mergedEventIds?: string[] }).mergedEventIds)
      ? (pending as { mergedEventIds: string[] }).mergedEventIds
      : pending.eventId ? [pending.eventId] : []),
    ...(next.eventId ? [next.eventId] : []),
  ];
  return {
    ...pending,
    // 合并后丢掉幂等键：聚合事件是一次新派发，不该复用任一原始 eventId。
    eventId: undefined,
    createdAt: pending.createdAt ?? next.createdAt,
    mergedEventIds: mergedIds,
    payload: { items },
  };
}

/** 默认提示文本：标注来源与类型，负载截断为 JSON 摘要，避免模型误读成新用户诉求。 */
export function defaultExternalEventPrompt(event: ExternalEventEnvelope): string {
  const head = `（外部事件唤醒：来源 ${event.source}，类型 ${event.type}）`;
  const payload = summarizeEventPayload(event.payload);
  const base = payload ? `${head}\n事件内容：\n${payload}` : head;
  return `${base}\n请结合该事件继续推进当前任务；如果事件需要向用户转述，请简要说明。`;
}

function summarizeEventPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload.slice(0, 4000);
  try {
    const text = JSON.stringify(payload, null, 2);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return String(payload).slice(0, 4000);
  }
}

/** 进程级单例（MCP 通知适配层、CatsCompany WS、Dashboard/IPC 共用）。 */
export const externalEventRouter = new ExternalEventRouter();

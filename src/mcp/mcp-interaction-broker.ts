/**
 * Elicitation + MRTR 统一交互代理（Track 3）。
 *
 * 统一两条「server 向用户要输入」的链路：
 * 1. **MRTR（2026-07-28）**：`tools/call` 返回 `resultType: 'input_required'`，
 *    携带 `inputRequests` + 不透明 `requestState`；收集到用户输入后，用
 *    `requestState`/`inputResponses` 重试原调用。可循环多轮（表单向导）。
 * 2. **legacy elicitation/create（2025-11-25）**：server 反向请求，form 模式
 *    （message + requestedSchema）与 url 模式（elicitationId + url）。client
 *    必须在请求超时内同步返回 `{ action, content? }`。
 *
 * 投递分两档：
 * - **CatsCo 交互卡片**：结构化 `mcp_elicitation` payload（含 URL origin/域名校验），
 *   由宿主（CatsCompany）渲染成可交互卡片；
 * - **文本降级**：卡片通道不可用时自动降级为清晰的文本提示，
 *   并把用户在该会话里的下一条消息解析为表单回答。
 *
 * 会话键控：`interactionId + sessionKey` 双键 —— 同一用户同一会话只挂起最新一条，
 * 超时/取消/会话清理都会回收 pending 状态。
 *
 * 本模块不做任何平台 I/O：卡片发送、文本发送、唤醒全部依赖注入，宿主按能力接线。
 */
import crypto from 'node:crypto';
import { Logger } from '../utils/logger';

// ---------------- 协议类型 ----------------

/** MRTR inputRequests 单项（server 提出的一个输入诉求）。 */
export interface MrtrInputRequest {
  /** server 侧的请求 id；inputResponses 按它对齐。 */
  requestId: string;
  /** 给用户的提示文本。 */
  message?: string;
  /** 输入种类：自由文本 / 表单 / 确认 / URL 跳转。缺省按 text 处理。 */
  kind?: 'text' | 'form' | 'confirm' | 'url';
  /** form 模式的 JSON Schema（对齐 elicitation requestedSchema 的子集）。 */
  schema?: {
    type: 'object';
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  /** url 模式的目标地址。 */
  url?: string;
}

/** MRTR tools/call 的 input_required 结果形状（宽松解析，容忍 server 扩展字段）。 */
export interface MrtrInputRequiredResult {
  resultType: 'input_required';
  /** 不透明会话状态：重试时必须原样回传。 */
  requestState: string;
  inputRequests: MrtrInputRequest[];
  message?: string;
}

/** MRTR 重试时回传的输入响应（与 inputRequests 按 requestId 对齐）。 */
export interface MrtrInputResponse {
  requestId: string;
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/** elicitation/create（form / url）参数形状（与 SDK schema 对齐的窄接口）。 */
export interface ElicitFormParams {
  mode?: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export interface ElicitUrlParams {
  mode: 'url';
  message: string;
  elicitationId: string;
  url: string;
}

export type ElicitRequestParams = ElicitFormParams | ElicitUrlParams;

/** elicitation/create 的应答形状。 */
export interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/** 渲染给用户的单个表单字段（卡片与文本降级共用）。 */
export interface InteractionField {
  name: string;
  title?: string;
  description?: string;
  type: string;
  required: boolean;
  enumValues?: string[];
  default?: unknown;
}

/** CatsCo 交互卡片的结构化 payload（type=mcp_elicitation）。 */
export interface McpElicitationCardPayload {
  type: 'mcp_elicitation';
  version: 1;
  interactionId: string;
  serverId: string;
  mode: 'form' | 'url' | 'mrtr';
  message: string;
  fields: InteractionField[];
  /** url 模式的目标地址与校验结果。 */
  url?: string;
  urlOrigin?: string;
  urlTrusted?: boolean;
  urlRejectionReason?: string;
  /** URL 模式 server 侧的 elicitationId（完成回执用）。 */
  elicitationId?: string;
  state: 'pending' | 'resolved' | 'cancelled' | 'expired';
  timeoutAt: number;
  round: number;
}

export interface InteractionDelivery {
  sessionKey: string;
  topic?: string;
  payload: McpElicitationCardPayload;
  /** 文本降级渲染（卡片不可用时发送的就是它）。 */
  text: string;
}

/** 卡片投递回调：返回 true = 卡片已送达；false/抛错 = 走文本降级。 */
export type SendInteractiveCard = (delivery: InteractionDelivery) => Promise<boolean>;
/** 文本投递回调（降级通道，也是超时/取消通知通道）。 */
export type SendInteractionText = (sessionKey: string, text: string, topic?: string) => Promise<void> | void;
/** 路由解析：server 发起的 elicitation 不带会话信息时，由宿主推断目标会话。 */
export type ResolveInteractionRouting = (serverId: string) => { sessionKey: string; topic?: string } | undefined;
/** MRTR 重试回调：带上 requestState/inputResponses 重放原 tools/call。 */
export type MrtrRetryCall = (
  inputResponses: MrtrInputResponse[],
  requestState: string,
) => Promise<unknown>;

export interface McpInteractionBrokerOptions {
  /** 单次挂起等待用户输入的超时（默认 10 分钟）。 */
  timeoutMs?: number;
  /** MRTR 表单向导最大轮数（默认 5，防死循环）。 */
  maxRounds?: number;
  sendCard?: SendInteractiveCard;
  sendText?: SendInteractionText;
  resolveRouting?: ResolveInteractionRouting;
  now?: () => number;
  /** URL 模式额外允许的域名后缀（空 = 只做协议/origin 校验，不做域名白名单）。 */
  allowedUrlDomains?: string[];
}

export type MrtrLoopOutcome =
  | { kind: 'result'; result: unknown }
  | { kind: 'cancelled'; reason: 'user_cancel' | 'timeout' | 'max_rounds' | 'user_decline' };

interface PendingInteraction {
  interactionId: string;
  serverId: string;
  sessionKey: string;
  topic?: string;
  mode: 'form' | 'url' | 'mrtr';
  message: string;
  fields: InteractionField[];
  url?: string;
  elicitationId?: string;
  requestState?: string;
  inputRequests?: MrtrInputRequest[];
  round: number;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'resolved' | 'cancelled' | 'expired';
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: UserInputOutcome) => void;
}

export type UserInputOutcome =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' }
  | { action: 'timeout' };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ROUNDS = 5;
const CANCEL_WORDS = new Set(['取消', 'cancel', '/cancel', '算了', '不用了']);

/** 宽松识别 MRTR input_required 结果（server 可能夹带扩展字段）。 */
export function isMrtrInputRequiredResult(result: unknown): result is MrtrInputRequiredResult {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  return (
    record.resultType === 'input_required'
    && typeof record.requestState === 'string'
    && (record.requestState as string).length > 0
    && Array.isArray(record.inputRequests)
    && record.inputRequests.length > 0
  );
}

/** URL 模式域名/协议安全校验。 */
export function validateElicitationUrl(
  rawUrl: string,
  allowedDomains: string[] = [],
): { ok: boolean; origin?: string; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL 无法解析' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URL 不允许携带用户名/密码（防钓鱼）' };
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  if (parsed.protocol === 'http:' && !isLoopback) {
    return { ok: false, reason: '非 localhost 的 http:// 链接不安全，已拒绝' };
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    return { ok: false, reason: `不允许的协议 ${parsed.protocol}（仅支持 https）` };
  }
  if (allowedDomains.length > 0) {
    const matched = allowedDomains.some((domain) => {
      const normalized = domain.trim().toLowerCase();
      return normalized.length > 0 && (hostname === normalized || hostname.endsWith(`.${normalized}`));
    });
    if (!matched && !isLoopback) {
      return { ok: false, origin: parsed.origin, reason: `域名 ${hostname} 不在允许列表内` };
    }
  }
  return { ok: true, origin: parsed.origin };
}

/** 把 elicitation requestedSchema / MRTR schema 拍平成字段清单。 */
export function flattenSchemaFields(
  schema: { properties?: Record<string, Record<string, unknown>>; required?: string[] } | undefined,
): InteractionField[] {
  if (!schema?.properties) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: InteractionField[] = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (!raw || typeof raw !== 'object') continue;
    const field: InteractionField = {
      name,
      type: typeof raw.type === 'string' ? raw.type : 'string',
      required: required.has(name),
    };
    if (typeof raw.title === 'string' && raw.title) field.title = raw.title;
    if (typeof raw.description === 'string' && raw.description) field.description = raw.description;
    if (Array.isArray(raw.enum)) {
      field.enumValues = raw.enum.filter((item): item is string => typeof item === 'string');
    }
    if (raw.default !== undefined) field.default = raw.default;
    fields.push(field);
  }
  return fields;
}

export class McpInteractionBroker {
  private readonly timeoutMs: number;
  private readonly maxRounds: number;
  private readonly sendCard?: SendInteractiveCard;
  private readonly sendText?: SendInteractionText;
  private readonly resolveRouting?: ResolveInteractionRouting;
  private readonly allowedUrlDomains: string[];
  private readonly now: () => number;

  private readonly byInteractionId = new Map<string, PendingInteraction>();
  /** sessionKey → 该会话当前 pending 的 interactionId 队列（按创建顺序）。 */
  private readonly bySession = new Map<string, string[]>();

  constructor(options: McpInteractionBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.sendCard = options.sendCard;
    this.sendText = options.sendText;
    this.resolveRouting = options.resolveRouting;
    this.allowedUrlDomains = options.allowedUrlDomains ?? [];
    this.now = options.now ?? Date.now;
  }

  /** 当前 pending 数（诊断/测试用）。 */
  get pendingCount(): number {
    return this.byInteractionId.size;
  }

  /** 会话是否有等待输入的挂起交互。 */
  hasPendingForSession(sessionKey: string): boolean {
    return (this.bySession.get(sessionKey) ?? []).length > 0;
  }

  // ---------------- MRTR ----------------

  /**
   * MRTR 交互循环：首个 input_required 结果进来后，逐轮收集输入并重试，
   * 直到拿到终态结果 / 用户取消 / 超时 / 超轮数。
   *
   * `retry` 闭包由调用方（McpClientManager）提供 —— 它知道怎么重放原 tools/call。
   */
  async runMrtrLoop(args: {
    serverId: string;
    sessionKey: string;
    topic?: string;
    initialResult: MrtrInputRequiredResult;
    retry: MrtrRetryCall;
  }): Promise<MrtrLoopOutcome> {
    let current: MrtrInputRequiredResult = args.initialResult;
    for (let round = 1; round <= this.maxRounds; round += 1) {
      const inputOutcome = await this.suspendAndWait({
        serverId: args.serverId,
        sessionKey: args.sessionKey,
        topic: args.topic,
        mode: 'mrtr',
        message: current.message ?? mergeRequestMessages(current.inputRequests),
        fields: mergeRequestFields(current.inputRequests),
        requestState: current.requestState,
        inputRequests: current.inputRequests,
        round,
      });

      if (inputOutcome.action === 'timeout') {
        return { kind: 'cancelled', reason: 'timeout' };
      }
      if (inputOutcome.action === 'cancel') {
        return { kind: 'cancelled', reason: 'user_cancel' };
      }
      if (inputOutcome.action === 'decline') {
        return { kind: 'cancelled', reason: 'user_decline' };
      }

      const responses: MrtrInputResponse[] = current.inputRequests.map((request) => ({
        requestId: request.requestId,
        action: 'accept',
        content: inputOutcome.content,
      }));

      let next: unknown;
      try {
        next = await args.retry(responses, current.requestState);
      } catch (error: any) {
        Logger.warning(`MRTR 重试调用失败 (${args.serverId}): ${error?.message ?? error}`);
        return { kind: 'cancelled', reason: 'user_cancel' };
      }

      if (isMrtrInputRequiredResult(next)) {
        current = next;
        continue; // 表单向导下一页
      }
      return { kind: 'result', result: next };
    }
    return { kind: 'cancelled', reason: 'max_rounds' };
  }

  // ---------------- elicitation/create ----------------

  /**
   * 处理 server 反向 elicitation/create 请求。阻塞等待用户输入（在 timeoutMs 内），
   * 返回协议要求形状的 ElicitResult。
   */
  async handleElicitRequest(
    serverId: string,
    params: ElicitRequestParams,
    routing?: { sessionKey: string; topic?: string },
  ): Promise<ElicitResult> {
    const target = routing ?? this.resolveRouting?.(serverId);
    if (!target?.sessionKey) {
      // 无法定位会话：不能挂起等一个永远到不了的回答，直接拒绝。
      return { action: 'decline' };
    }

    if ((params as ElicitUrlParams).mode === 'url') {
      return this.handleUrlModeElicitation(serverId, params as ElicitUrlParams, target);
    }

    const form = params as ElicitFormParams;
    const outcome = await this.suspendAndWait({
      serverId,
      sessionKey: target.sessionKey,
      topic: target.topic,
      mode: 'form',
      message: form.message,
      fields: flattenSchemaFields(form.requestedSchema),
      round: 1,
    });

    switch (outcome.action) {
      case 'accept':
        return { action: 'accept', content: outcome.content };
      case 'timeout':
      case 'cancel':
        return { action: 'cancel' };
      default:
        return { action: 'decline' };
    }
  }

  /**
   * URL 模式：校验 URL → 投递卡片/文本 → 立即按 spec 返回（用户在浏览器里完成，
   * 后续 server 自行推进；client 侧的完成回执由 notifyElicitationComplete 承载）。
   * URL 不安全 → decline，不把用户往钓鱼链接上送。
   */
  private async handleUrlModeElicitation(
    serverId: string,
    params: ElicitUrlParams,
    target: { sessionKey: string; topic?: string },
  ): Promise<ElicitResult> {
    const validation = validateElicitationUrl(params.url, this.allowedUrlDomains);
    if (!validation.ok) {
      // 仍然告知用户「server 试图引导到一个被拒绝的 URL」，但绝不给出可点链接。
      const notice =
        `⚠️ MCP server "${serverId}" 请求打开一个未通过安全校验的链接（${validation.reason ?? '未知原因'}），已自动拒绝。`;
      await this.deliverText(target.sessionKey, notice, target.topic);
      return { action: 'decline' };
    }

    const payload: McpElicitationCardPayload = {
      type: 'mcp_elicitation',
      version: 1,
      interactionId: newInteractionId(),
      serverId,
      mode: 'url',
      message: params.message,
      fields: [],
      url: params.url,
      urlOrigin: validation.origin,
      urlTrusted: true,
      elicitationId: params.elicitationId,
      state: 'pending',
      timeoutAt: this.now() + this.timeoutMs,
      round: 1,
    };
    const text = renderUrlModeText(serverId, params.message, params.url, validation.origin);
    await this.deliver({ sessionKey: target.sessionKey, topic: target.topic, payload, text });
    // URL 模式不阻塞等表单内容：用户在浏览器完成后 server 侧自行继续。
    return { action: 'accept' };
  }

  // ---------------- 用户消息解析（文本降级通道） ----------------

  /**
   * 宿主在会话消息入口调用：该会话若有 pending 交互，把这条消息解析为表单回答。
   * 返回 true = 消息已被交互代理消费（宿主不应再走正常回合）。
   */
  handleUserMessage(sessionKey: string, text: string): boolean {
    const pending = this.latestPendingForSession(sessionKey);
    if (!pending || pending.state !== 'pending') return false;

    const trimmed = text.trim();
    if (CANCEL_WORDS.has(trimmed.toLowerCase())) {
      this.settle(pending, { action: 'cancel' });
      return true;
    }

    const content = parseUserInputContent(trimmed, pending.fields);
    this.settle(pending, { action: 'accept', content });
    return true;
  }

  /** 主动取消某会话全部挂起交互（会话清理/reset 时调用）。 */
  cancelSessionInteractions(sessionKey: string, notify = false): number {
    const ids = [...(this.bySession.get(sessionKey) ?? [])];
    let count = 0;
    for (const id of ids) {
      const pending = this.byInteractionId.get(id);
      if (!pending || pending.state !== 'pending') continue;
      this.settle(pending, { action: 'cancel' });
      count += 1;
      if (notify) {
        void this.deliverText(sessionKey, '（之前的输入请求已取消）', pending.topic);
      }
    }
    return count;
  }

  /** 进程收尾：取消全部挂起交互并清定时器。 */
  dispose(): void {
    for (const pending of [...this.byInteractionId.values()]) {
      if (pending.state === 'pending') this.settle(pending, { action: 'cancel' });
    }
    this.byInteractionId.clear();
    this.bySession.clear();
  }

  // ---------------- 内部：挂起/投递/结算 ----------------

  private async suspendAndWait(args: {
    serverId: string;
    sessionKey: string;
    topic?: string;
    mode: 'form' | 'mrtr';
    message: string;
    fields: InteractionField[];
    url?: string;
    requestState?: string;
    inputRequests?: MrtrInputRequest[];
    round: number;
  }): Promise<UserInputOutcome> {
    const interactionId = newInteractionId();
    const expiresAt = this.now() + this.timeoutMs;

    return new Promise<UserInputOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.byInteractionId.get(interactionId);
        if (pending && pending.state === 'pending') {
          this.settle(pending, { action: 'timeout' });
        }
      }, Math.max(1, this.timeoutMs));
      (timer as { unref?: () => void }).unref?.();

      const pending: PendingInteraction = {
        interactionId,
        serverId: args.serverId,
        sessionKey: args.sessionKey,
        topic: args.topic,
        mode: args.mode,
        message: args.message,
        fields: args.fields,
        url: args.url,
        requestState: args.requestState,
        inputRequests: args.inputRequests,
        round: args.round,
        createdAt: this.now(),
        expiresAt,
        state: 'pending',
        timer,
        resolve,
      };
      this.track(pending);

      const payload: McpElicitationCardPayload = {
        type: 'mcp_elicitation',
        version: 1,
        interactionId,
        serverId: args.serverId,
        mode: args.mode,
        message: args.message,
        fields: args.fields,
        state: 'pending',
        timeoutAt: expiresAt,
        round: args.round,
      };
      const text = args.mode === 'mrtr'
        ? renderMrtrText(args.serverId, args.message, args.fields, args.round)
        : renderFormText(args.serverId, args.message, args.fields);

      void this.deliver({ sessionKey: args.sessionKey, topic: args.topic, payload, text })
        .catch((error: any) => {
          Logger.warning(`交互投递失败 (${args.serverId}/${interactionId}): ${error?.message ?? error}`);
        });
    });
  }

  /** 先尝试卡片通道，不可用/失败自动降级文本。 */
  private async deliver(delivery: InteractionDelivery): Promise<void> {
    let cardDelivered = false;
    if (this.sendCard) {
      try {
        cardDelivered = await this.sendCard(delivery);
      } catch (error: any) {
        Logger.warning(`交互卡片投递失败，降级文本: ${error?.message ?? error}`);
        cardDelivered = false;
      }
    }
    if (!cardDelivered) {
      await this.deliverText(delivery.sessionKey, delivery.text, delivery.topic);
    }
  }

  private async deliverText(sessionKey: string, text: string, topic?: string): Promise<void> {
    if (!this.sendText) return;
    try {
      await this.sendText(sessionKey, text, topic);
    } catch (error: any) {
      Logger.warning(`交互文本投递失败: ${error?.message ?? error}`);
    }
  }

  private track(pending: PendingInteraction): void {
    this.byInteractionId.set(pending.interactionId, pending);
    const queue = this.bySession.get(pending.sessionKey) ?? [];
    queue.push(pending.interactionId);
    this.bySession.set(pending.sessionKey, queue);
  }

  private untrack(pending: PendingInteraction): void {
    this.byInteractionId.delete(pending.interactionId);
    const queue = this.bySession.get(pending.sessionKey);
    if (queue) {
      const next = queue.filter((id) => id !== pending.interactionId);
      if (next.length > 0) this.bySession.set(pending.sessionKey, next);
      else this.bySession.delete(pending.sessionKey);
    }
  }

  private settle(pending: PendingInteraction, outcome: UserInputOutcome): void {
    if (pending.state !== 'pending') return;
    pending.state = outcome.action === 'timeout' ? 'expired'
      : outcome.action === 'cancel' ? 'cancelled'
      : 'resolved';
    clearTimeout(pending.timer);
    this.untrack(pending);
    pending.resolve(outcome);
  }

  private latestPendingForSession(sessionKey: string): PendingInteraction | undefined {
    const queue = this.bySession.get(sessionKey) ?? [];
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const pending = this.byInteractionId.get(queue[i]);
      if (pending && pending.state === 'pending') return pending;
    }
    return undefined;
  }
}

// ---------------- 渲染与解析 ----------------

function newInteractionId(): string {
  return `ix-${crypto.randomUUID()}`;
}

function mergeRequestMessages(requests: MrtrInputRequest[]): string {
  const messages = requests.map((request) => request.message?.trim()).filter((m): m is string => Boolean(m));
  return messages.join('\n');
}

function mergeRequestFields(requests: MrtrInputRequest[]): InteractionField[] {
  const fields: InteractionField[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (request.kind === 'confirm') {
      if (!seen.has('confirm')) {
        fields.push({ name: 'confirm', type: 'boolean', required: true, title: '确认' });
        seen.add('confirm');
      }
      continue;
    }
    for (const field of flattenSchemaFields(request.schema)) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      fields.push(field);
    }
    // text 类请求没有 schema：给它一个同 requestId 的自由文本字段。
    const hasSchema = Boolean(request.schema?.properties && Object.keys(request.schema.properties).length > 0);
    if (!hasSchema && request.kind !== 'url' && !seen.has(request.requestId)) {
      seen.add(request.requestId);
      fields.push({
        name: request.requestId,
        type: 'string',
        required: true,
        title: request.message?.slice(0, 40) || request.requestId,
      });
    }
  }
  return fields;
}

function renderFieldLine(field: InteractionField, index: number): string {
  const label = field.title || field.name;
  const req = field.required ? '（必填）' : '（可选）';
  const enumHint = field.enumValues?.length ? ` 可选值：${field.enumValues.join(' / ')}` : '';
  const defaultHint = field.default !== undefined ? ` 默认：${JSON.stringify(field.default)}` : '';
  const typeHint = field.type !== 'string' ? ` <${field.type}>` : '';
  const desc = field.description ? ` — ${field.description}` : '';
  return `${index + 1}. ${label}${req}${typeHint}${enumHint}${defaultHint}${desc}`;
}

function renderFormText(serverId: string, message: string, fields: InteractionField[]): string {
  const lines = [
    `📋 MCP server "${serverId}" 需要补充信息：`,
    message,
  ];
  if (fields.length > 0) {
    lines.push('', ...fields.map(renderFieldLine), '', renderInputHint());
  } else {
    lines.push('', '直接回复任意内容视为确认；回复「取消」终止。');
  }
  return lines.join('\n');
}

function renderMrtrText(serverId: string, message: string, fields: InteractionField[], round: number): string {
  const roundHint = round > 1 ? `（第 ${round} 步）` : '';
  const lines = [
    `📋 MCP server "${serverId}" 暂停等待输入${roundHint}：`,
    message || '该操作需要补充信息才能继续。',
  ];
  if (fields.length > 0) {
    lines.push('', ...fields.map(renderFieldLine), '', renderInputHint());
  } else {
    lines.push('', '直接回复任意内容视为确认；回复「取消」终止。');
  }
  return lines.join('\n');
}

function renderUrlModeText(serverId: string, message: string, url: string, origin?: string): string {
  return [
    `🔗 MCP server "${serverId}" 请求你在浏览器中完成操作：`,
    message,
    '',
    `链接（origin: ${origin ?? '未知'}）：${url}`,
    '请确认该链接来源可信后再打开；完成后这里的任务会自动继续。',
  ].join('\n');
}

function renderInputHint(): string {
  return '回复格式：JSON（{"字段": "值"}）或逐行「字段=值」；单字段可直接回复值。回复「取消」终止。';
}

/**
 * 解析用户的文本回答：
 * 1. JSON 对象 → 直接用；
 * 2. 逐行 key=value → 聚合；
 * 3. 只有一个必填字段 → 整段文本作为该字段的值；
 * 4. 无字段（纯确认）→ { confirmed: true }；
 * 5. 多字段且无法解析 → 尽力把整段文本塞进第一个必填字段。
 */
export function parseUserInputContent(text: string, fields: InteractionField[]): Record<string, unknown> {
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return coerceValues(parsed as Record<string, unknown>, fields);
      }
    } catch {
      // fall through
    }
  }

  const kvPairs: Record<string, string> = {};
  let kvCount = 0;
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=：\s][^=：]*)\s*[=：]\s*(.+)$/);
    if (match) {
      kvPairs[match[1].trim()] = match[2].trim();
      kvCount += 1;
    }
  }
  if (kvCount > 0) {
    return coerceValues(kvPairs, fields);
  }

  const requiredFields = fields.filter((field) => field.required);
  if (requiredFields.length === 1) {
    return coerceValues({ [requiredFields[0].name]: trimmed }, fields);
  }
  if (fields.length === 0) {
    return { confirmed: true, text: trimmed };
  }
  if (requiredFields.length > 1) {
    return coerceValues({ [requiredFields[0].name]: trimmed }, fields);
  }
  if (fields.length === 1) {
    return coerceValues({ [fields[0].name]: trimmed }, fields);
  }
  return { text: trimmed };
}

/** 按字段声明类型做宽松类型转换（boolean/number/integer）。 */
function coerceValues(input: Record<string, unknown>, fields: InteractionField[]): Record<string, unknown> {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = byName.get(key);
    if (!field || typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    if (field.type === 'boolean') {
      out[key] = /^(true|是|yes|y|1|确认|好|同意)$/i.test(value.trim());
    } else if (field.type === 'number' || field.type === 'integer') {
      const parsed = Number(value.trim());
      out[key] = Number.isFinite(parsed) ? parsed : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

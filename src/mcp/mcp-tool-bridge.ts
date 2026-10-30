/**
 * CatsCo MCP 工具桥：把平台 MCP 端点（`<httpBaseUrl>/api/mcp`）上的远端工具
 * （`catsco_<slug>` 定制 Agent 与 `catsco_run_status`）注册为本地一等工具，
 * 让本地对话模型像调用内置工具一样调用定制 Agent。
 *
 * 与平台契约对齐（catsco.service-run-result.v1）：
 * - completed：`output.text` 为答复正文；
 * - awaiting_input：`output.question` 为返问，携带同一 `session_id` 再次调用即续跑；
 * - running：句柄交付；本桥接会自动轮询 `catsco_run_status` 至终态或超时，再决定返回内容。
 *
 * 刷新策略：fire-and-forget 后台同步（绝不阻塞对话轮次），按 diff 注册/注销远端工具。
 */
import { Logger } from '../utils/logger';
import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolParameter } from '../types/tool';

export interface McpBridgeToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpBridgeCallResult {
  isError: boolean;
  /** 远端文本摘要（run=.. session=.. status=..）。 */
  contentText: string;
  /** structuredContent（平台 envelope），若有。 */
  structured?: unknown;
}

export interface McpBridgeClient {
  listTools(): Promise<McpBridgeToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpBridgeCallResult>;
  close(): Promise<void>;
}

export interface McpBridgeEndpoint {
  url: string;
  token: string;
}

export type McpBridgeClientFactory = (endpoint: McpBridgeEndpoint) => McpBridgeClient;

export interface BridgeRefreshResult {
  registered: string[];
  unregistered: string[];
}

/** 平台 run 结果 envelope 的可读视图（仅取桥接需要的字段）。 */
export interface ServiceRunEnvelopeView {
  contract_version?: string;
  status?: string;
  run_id?: string;
  session_id?: string;
  output?: { text?: string; question?: string } | null;
  files?: string[];
  error?: string;
}

export interface McpToolBridgeOptions {
  toolManager: {
    registerTool(tool: Tool): void;
    unregisterTool(name: string): void;
  };
  createClient: McpBridgeClientFactory;
  /** 懒解析端点：未登录/未配置时返回 null。 */
  resolveEndpoint: () => McpBridgeEndpoint | null;
  /** 仅桥接此前缀的远端工具（默认 catsco_）。 */
  toolNamePrefix?: string;
  /**
   * 当前 Agent 的工具清单（service agent slug 列表）。
   * undefined = 不过滤（账号可见全部，兼容旧行为）；[] = 仅保留 catsco_run_status。
   */
  resolveAgentSlugs?: () => string[] | undefined;
  /**
   * 当前 Agent 的平台 bot_uid（调用时随参数上报，平台据此做归属/清单校验并落会话）。
   * 返回 undefined / 0 = 不带 bot_uid（账号级调用，兼容旧服务端）。
   */
  resolveBotUid?: () => number | undefined;
  /** 最小刷新间隔（默认 30s），避免密集轮次反复打端点。 */
  refreshIntervalMs?: number;
  runStatusToolName?: string;
  /** run 句柄轮询总时长（默认 90s）；<=0 关闭自动轮询。 */
  runPollTimeoutMs?: number;
  runPollIntervalMs?: number;
  /**
   * 「放弃轮询后」的待补登记回调（设计 §19）：任务仍 running 时调用，
   * 宿主把 run 记入回执路由器；平台推达终态回执时可唤醒下一回合。
   */
  onRunPending?: (info: {
    runId: string;
    serviceSessionId: string;
    toolName: string;
    conversationSessionKey?: string;
    conversationTopic?: string;
    /** 触发本次调用的真人 uid（回执唤醒回合时作为消息发送者）。 */
    actorUserId?: string;
  }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TOOL_PREFIX = 'catsco_';
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_RUN_STATUS_TOOL = 'catsco_run_status';
export const DEFAULT_RUN_POLL_TIMEOUT_MS = 90_000;

/**
 * 连续轮询失败多少次才判定「状态查询通道坏了」。
 *
 * 取 3：单次抖动（TLS 重连、服务端一瞬间 502）不该影响结论，但连续三次都失败就说明
 * 拿不到真相了 —— 这时候还装作「仍在运行」是骗模型。
 */
const MAX_RUN_POLL_FAILURES = 3;
const DEFAULT_RUN_POLL_INTERVAL_MS = 5_000;

const TOOL_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'CatsCo 登录态无效或已过期，请在 CatsCo 面板重新登录后重试。',
  subscription_required: '当前账号尚未添加该 Agent 工具，请先在「Agent 工具」面板添加后重试。',
  agent_not_subscribed: '该 Agent 已从当前账号清单中移除，请先在「Agent 工具」面板重新添加后再调用。',
  agent_not_enabled_for_bot: '这个 Agent 没启用给当前 bot：请先在「Agent 工具」面板勾选启用后重试。',
  bot_not_owned: '当前登录账号不是这个 bot 的拥有者，无法代其调用。',
  bot_not_found: '上报的 bot 不存在或已删除。',
  bot_identity_unavailable: '服务端尚未开启 bot 身份校验，本次调用未上报 bot 身份。',
  session_busy: '该会话已有进行中的运行：请等待其完成，或先用「catsco_run_status」查询进度；若是新任务，请不带 session_id 重新调用。',
  run_id_required: '缺少 run_id 参数。',
  run_not_found: '未找到该 run（可能已过期，或不属于当前账号）。',
};

export class CatsCoMcpToolBridge {
  private readonly toolManager: McpToolBridgeOptions['toolManager'];
  private readonly createClient: McpBridgeClientFactory;
  private readonly resolveEndpoint: () => McpBridgeEndpoint | null;
  private readonly resolveAgentSlugs?: () => string[] | undefined;
  private readonly resolveBotUid?: () => number | undefined;
  private readonly toolNamePrefix: string;
  private readonly refreshIntervalMs: number;
  private readonly runStatusToolName: string;
  private readonly runPollTimeoutMs: number;
  private readonly runPollIntervalMs: number;
  private readonly onRunPending?: McpToolBridgeOptions['onRunPending'];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly bridged = new Map<string, { definition: ToolDefinition }>();
  private refreshInFlight: Promise<BridgeRefreshResult | null> | null = null;
  private lastRefreshAt = 0;
  private bootstrapSettled = false;
  private failureStreak = 0;
  private disabledReason: string | null = null;
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: McpToolBridgeOptions) {
    this.toolManager = options.toolManager;
    this.createClient = options.createClient;
    this.resolveEndpoint = options.resolveEndpoint;
    this.resolveAgentSlugs = options.resolveAgentSlugs;
    this.resolveBotUid = options.resolveBotUid;
    this.toolNamePrefix = options.toolNamePrefix ?? DEFAULT_TOOL_PREFIX;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.runStatusToolName = options.runStatusToolName ?? DEFAULT_RUN_STATUS_TOOL;
    this.runPollTimeoutMs = options.runPollTimeoutMs ?? DEFAULT_RUN_POLL_TIMEOUT_MS;
    this.runPollIntervalMs = options.runPollIntervalMs ?? DEFAULT_RUN_POLL_INTERVAL_MS;
    this.onRunPending = options.onRunPending;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  }

  /** 当前已桥接的远端工具名（诊断/测试用）。 */
  getBridgedToolNames(): string[] {
    return [...this.bridged.keys()];
  }

  /** 后台刷新（fire-and-forget）：任何失败只记录日志，绝不抛给调用方。 */
  refreshInBackground(): void {
    void this.refresh().catch(() => {});
  }

  /**
   * 开启定时后台刷新：远端新增/下架的工具无需重启客户端就能同步到本地工具面。
   *
   * 为什么必须有：刷新原先只在「本地 Agent 回合开始」与「调用 unknown tool」时触发。
   * 但设备连接器模式（云端 Bot + 本机设备）里根本没有本地回合，于是发布新应用后
   * 工具面永远停在启动那一刻的快照——用户只能重启客户端才能看到新工具。
   *
   * 定时器 unref()：不因为它让进程无法退出。
   */
  startAutoRefresh(intervalMs = this.refreshIntervalMs): void {
    if (this.autoRefreshTimer) return;
    // 定时器是「时间到了就该刷」的确定性节拍，所以要绕过 refresh() 里的回合节流
    // （否则两个 30s 撞在一起时会被吞掉一次，实际间隔变成 60s）。
    const tick = Math.max(1, Math.floor(intervalMs));
    this.autoRefreshTimer = setInterval(() => {
      void this.refresh(true).catch(() => {});
    }, tick);
    this.autoRefreshTimer.unref?.();
  }

  /** 停止定时刷新（进程收尾/测试用）。 */
  stopAutoRefresh(): void {
    if (!this.autoRefreshTimer) return;
    clearInterval(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
  }

  /**
   * 首轮有界就绪：工具清单在每次对话 run 开始时只快照一次，而首次同步是异步的
   * （prewarm 在途）——首发消息若不等待，整轮对话都会看不到远端工具。
   * 仅在「从未结算过一次同步尝试」时等待在途/新发起的刷新（上限 timeoutMs，
   * 典型 ~1s）；已同步完成或已尝试过（含失败）则立即返回，绝不阻塞后续轮次。
   */
  async ensureReady(timeoutMs = 3000): Promise<void> {
    if (this.bootstrapSettled) return;
    const refresh = this.refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        refresh.then(() => undefined, () => undefined),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, Math.max(1, timeoutMs));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.bootstrapSettled = true;
    }
  }

  /**
   * 同步远端工具清单：新增注册、下线注销、定义变化时替换。
   * 端点为 null（未登录）时直接跳过；force=false 时还受最小刷新间隔节流。
   */
  async refresh(force = false): Promise<BridgeRefreshResult | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const nowMs = this.now();
    if (!force && this.lastRefreshAt !== 0 && nowMs - this.lastRefreshAt < this.refreshIntervalMs) {
      return null;
    }
    const endpoint = this.resolveEndpointSafely();
    if (!endpoint) {
      // 未登录不算一次同步尝试：**不能消耗最小刷新间隔**——否则「启动 → 登录 →
      // 立即对话」会因节流在首轮看不到远端工具（lazy 端点变可用后要能立即同步）。
      this.noteDisabled('未配置 CatsCo 登录态');
      return null;
    }
    const run = this.doRefresh(endpoint).finally(() => {
      this.lastRefreshAt = this.now();
      this.refreshInFlight = null;
    });
    this.refreshInFlight = run;
    return run;
  }

  private async doRefresh(endpoint: McpBridgeEndpoint): Promise<BridgeRefreshResult | null> {
    const client = this.createClient(endpoint);
    try {
      const infos = await client.listTools();
      const seen = new Set<string>();
      const registered: string[] = [];
      const unregistered: string[] = [];
      const scopedSlugs = this.resolveAgentSlugs?.();
      const allowedNames = Array.isArray(scopedSlugs)
        ? new Set(scopedSlugs.map((slug) => `${this.toolNamePrefix}${slug}`))
        : null;

      for (const info of infos) {
        if (!info?.name || !info.name.startsWith(this.toolNamePrefix)) continue;
        // 当前 Agent 的工具清单：清单内 + run_status（轮询/查询依赖）；清单外直接跳过（既不注册也不进 diff）。
        if (allowedNames && info.name !== this.runStatusToolName && !allowedNames.has(info.name)) continue;
        seen.add(info.name);
        const definition = this.buildDefinition(info);
        const existing = this.bridged.get(info.name);
        if (existing && sameDefinition(existing.definition, definition)) continue;
        const adapter = this.createRemoteTool(definition);
        this.bridged.set(info.name, { definition });
        this.toolManager.registerTool(adapter);
        registered.push(info.name);
      }

      for (const name of [...this.bridged.keys()]) {
        if (seen.has(name)) continue;
        this.toolManager.unregisterTool(name);
        this.bridged.delete(name);
        unregistered.push(name);
      }

      this.failureStreak = 0;
      this.disabledReason = null;
      if (registered.length > 0 || unregistered.length > 0) {
        Logger.info(`CatsCo Agent 工具桥已同步: +[${registered.join(',')}] -[${unregistered.join(',')}]`);
      }
      return { registered, unregistered };
    } catch (error: any) {
      this.failureStreak += 1;
      // 首次与每 10 次失败留痕，避免离线场景刷屏。
      if (this.failureStreak === 1 || this.failureStreak % 10 === 0) {
        Logger.warning(`CatsCo Agent 工具桥刷新失败（第 ${this.failureStreak} 次）: ${error?.message ?? error}`);
      }
      return null;
    } finally {
      await client.close().catch(() => {});
    }
  }

  private noteDisabled(reason: string): void {
    if (this.disabledReason !== reason) {
      this.disabledReason = reason;
      Logger.info(`CatsCo Agent 工具桥未启用: ${reason}`);
    }
  }

  /** 解析端点；本地登录配置损坏时返回 null（不得阻断对话/工具执行）。 */
  private resolveEndpointSafely(): McpBridgeEndpoint | null {
    try {
      return this.resolveEndpoint();
    } catch (error: any) {
      this.noteDisabled(`登录态读取失败: ${error?.message ?? error}`);
      return null;
    }
  }

  private buildDefinition(info: McpBridgeToolInfo): ToolDefinition {
    return {
      name: info.name,
      description: buildBridgeDescription(info.name, info.description, this.runStatusToolName),
      parameters: toToolParameters(info.inputSchema),
    };
  }

  private createRemoteTool(definition: ToolDefinition): Tool {
    return {
      definition,
      // 把本机对话路由（本地会话 key / 平台 topic）透传到执行链，供「放弃轮询后的
      // 待补登记」使用——回执到达时才能把唤醒注记放回正确的会话。
      execute: (args: any, context?: ToolExecutionContext) =>
        this.executeRemoteTool(definition.name, toArgsRecord(args), {
          ...(context?.sessionId ? { conversationSessionKey: context.sessionId } : {}),
          ...(context?.channel?.chatId ? { conversationTopic: context.channel.chatId } : {}),
          ...(context?.executionScope?.actorUserId
            ? { actorUserId: String(context.executionScope.actorUserId) }
            : {}),
        }),
    };
  }

  /**
   * 给远端 Agent 工具补上 bot_uid（设计 P1b）：
   * 只对本桥接前缀的「调用类」工具注入（run_status 查询不需要，也不该多传字段）；
   * 调用方显式带了 bot_uid 则不覆盖；拿不到 bot 身份则保持账号级调用（兼容旧服务端）。
   */
  private withBotIdentity(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    if (!this.resolveBotUid) return args;
    if (toolName === this.runStatusToolName) return args;
    if (!toolName.startsWith(this.toolNamePrefix)) return args;
    if (args.bot_uid !== undefined) return args;
    let botUid: number | undefined;
    try {
      botUid = this.resolveBotUid();
    } catch {
      return args;
    }
    if (typeof botUid !== 'number' || !Number.isFinite(botUid) || botUid <= 0) return args;
    return { ...args, bot_uid: botUid };
  }

  /** 执行远端工具的完整链路：连接 → call →（running 时轮询）→ 映射结果。 */
  async executeRemoteTool(    toolName: string,
    args: Record<string, unknown>,
    route?: {
      conversationSessionKey?: string;
      conversationTopic?: string;
      actorUserId?: string;
    },
  ): Promise<ToolExecutionResult> {
    const endpoint = this.resolveEndpointSafely();
    if (!endpoint) {
      return {
        ok: false,
        errorCode: 'catsco_mcp_not_configured',
        message: '未配置 CatsCo 登录态（缺少 token 或服务地址），无法调用远端 Agent 工具。',
      };
    }
    const client = this.createClient(endpoint);
    try {
      const first = await client.callTool(toolName, this.withBotIdentity(toolName, args));
      if (first.isError) {
        // 服务端 isError 文本有两种形态：裸码（如 unauthorized）或「码: 说明」
        // （如 session_busy: …）。拆出裸码做程序化匹配，说明文本兜底展示。
        const { code, detail } = splitToolErrorText(first.contentText);
        return { ok: false, errorCode: code, message: mapToolErrorMessage(code, detail) };
      }
      let envelope = parseServiceRunEnvelope(first.structured);
      // degraded：轮询通道坏了导致「仍在运行」这个结论不可信时，把原因带给结果文本。
      let pollDegraded: string | null = null;
      if (toolName !== this.runStatusToolName && this.runPollTimeoutMs > 0) {
        const polled = await this.pollRunUntilTerminal(client, envelope);
        envelope = polled.envelope;
        pollDegraded = polled.degraded;
      }
      // 仍处于 running（含轮询超时）：登记待补 run——平台在 run 终态时推回执，
      // 届时可唤醒宿主注入下一回合（设计 §19）。拉取永远是真相通道。
      if (toolName !== this.runStatusToolName && envelope?.status === 'running' && envelope.run_id) {
        try {
          this.onRunPending?.({
            runId: envelope.run_id,
            serviceSessionId: envelope.session_id ?? '',
            toolName,
            ...(route?.conversationSessionKey ? { conversationSessionKey: route.conversationSessionKey } : {}),
            ...(route?.conversationTopic ? { conversationTopic: route.conversationTopic } : {}),
            ...(route?.actorUserId ? { actorUserId: route.actorUserId } : {}),
          });
        } catch (error: any) {
          // 登记失败不影响本轮交付。
          Logger.warning(`CatsCo 工具桥待补登记失败: ${error?.message ?? error}`);
        }
      }
      return formatEnvelopeResult(envelope, first.contentText, toolName, pollDegraded);
    } catch (error: any) {
      // 协议级 unknown tool（-32602）：平台在会话期间被撤订阅/工具下线的典型表现
      // （服务端每请求重建工具面，旧工具面里的工具名会直接被拒）。这不是网络问题，
      // 映射为可操作的「重新添加」指引，并触发后台刷新尽快同步本地工具面。
      if (isUnknownToolError(error)) {
        Logger.warning(`CatsCo MCP 调用失败：工具 ${toolName} 不在订阅清单（本地工具面将在下次同步移除）`);
        this.refreshInBackground();
        return {
          ok: false,
          errorCode: 'catsco_mcp_tool_unlisted',
          message: '该 Agent 工具当前不在你的订阅清单中（可能在会话期间被取消订阅、更名或下线）。请到「Agent 工具」面板确认或重新添加后重试；本地工具面也会在后续同步中更新。',
        };
      }
      return {
        ok: false,
        errorCode: 'catsco_mcp_unreachable',
        message: `无法连接 CatsCo MCP 端点: ${error?.message ?? error}`,
        retryable: true,
      };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * running 句柄交付后的自动轮询：终态或超时即返回当前 envelope。
   *
   * 轮询出错不再**静默**当成「还在跑」返回：网络抖断和「bot 真的还在干」在调用方看来
   * 长得一模一样，而前者会让模型以为任务仍在推进、一路干等到用户来问。现在连续失败到
   * 上限就带 degraded 原因返回，由结果文本提示模型去 catsco_run_status 复核。
   */
  private async pollRunUntilTerminal(
    client: McpBridgeClient,
    envelope: ServiceRunEnvelopeView | null,
  ): Promise<{ envelope: ServiceRunEnvelopeView | null; degraded: string | null }> {
    if (!envelope || envelope.status !== 'running' || !envelope.run_id) {
      return { envelope, degraded: null };
    }
    const deadline = this.now() + this.runPollTimeoutMs;
    let current = envelope;
    let failures = 0;
    const broke = (reason: string) => ({
      envelope: current,
      degraded: `连续 ${failures} 次查询失败：${reason}`,
    });
    while (current.status === 'running' && current.run_id && this.now() < deadline) {
      await this.sleep(this.runPollIntervalMs);
      if (this.now() >= deadline) break;
      let poll: McpBridgeCallResult;
      try {
        poll = await client.callTool(this.runStatusToolName, { run_id: current.run_id });
      } catch (error: any) {
        failures += 1;
        if (failures >= MAX_RUN_POLL_FAILURES) {
          return broke(String(error?.message ?? error ?? '调用失败'));
        }
        continue;
      }
      if (poll.isError) {
        failures += 1;
        if (failures >= MAX_RUN_POLL_FAILURES) {
          return broke(poll.contentText?.trim() || 'run 状态查询返回错误');
        }
        continue;
      }
      const next = parseServiceRunEnvelope(poll.structured);
      if (!next || !next.status) {
        failures += 1;
        if (failures >= MAX_RUN_POLL_FAILURES) {
          return broke('run 状态响应缺少结构化结果');
        }
        continue;
      }
      failures = 0;
      current = next;
    }
    return { envelope: current, degraded: null };
  }
}

/**
 * 远端工具描述：作者的描述原样保留，再补一段「当子 Agent 用」的用法指引。
 *
 * 不要写"公司服务端托管"之类的部署承诺——同一个工具可能跑在作者自己的电脑上，
 * 对方离线时就是不可用的。调用方只需要知道它是**另一个 Agent**，以及该怎么传参。
 */
export function buildBridgeDescription(name: string, raw: string | undefined, runStatusToolName: string): string {
  const base = (raw ?? '').trim() || `CatsCo 远端 Agent 工具（${name}）`;
  if (name === runStatusToolName) {
    return `${base}。用法：run_id 传 catsco_<slug> 返回的 run_id，返回该 run 的状态与结果。`;
  }
  return `${base}。这是另一个 Agent（可能运行在公司服务端，也可能运行在作者自己的电脑上，离线时不可用）：当用户的请求属于它描述的任务类型时，应优先调用本工具完成并以返回结果为准——不要用本地通用能力另做一份同类成品。日常问答、闲聊或简单计算不要调用。用法：input 传发给该 Agent 的输入（对象，形状见 input 的参数说明）；结果文本中的 status 表示本次结果状态（completed=完成，awaiting_input=返问待补充，running=仍在运行）。同一任务的后续追问（含 awaiting_input 的补充、completed 之后的追问），请携带上次结果中的 session_id 再次调用；新任务不要携带 session_id。`;
}

/** 把远端 inputSchema 收敛为本地 ToolParameter 形状（provider 会把该结构原样发给模型）。 */
export function toToolParameters(schema: unknown): ToolDefinition['parameters'] {
  const root = isRecord(schema) ? schema : {};
  const rawProps = isRecord(root.properties) ? root.properties : {};
  const properties: Record<string, ToolParameter> = {};
  for (const [key, value] of Object.entries(rawProps)) {
    const mapped = sanitizeParameter(value);
    if (mapped) properties[key] = mapped;
  }
  const required = Array.isArray(root.required)
    ? root.required.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  };
}

function sanitizeParameter(raw: unknown): ToolParameter | null {
  if (!isRecord(raw)) return null;
  const out: ToolParameter = { type: typeof raw.type === 'string' ? raw.type : 'object' };
  if (typeof raw.description === 'string' && raw.description.length > 0) out.description = raw.description;
  if (Array.isArray(raw.enum)) {
    const values = raw.enum.filter((item): item is string => typeof item === 'string');
    if (values.length > 0) out.enum = values;
  }
  if (raw.default !== undefined) out.default = raw.default;
  if (isRecord(raw.properties)) {
    const nested: Record<string, ToolParameter> = {};
    for (const [key, value] of Object.entries(raw.properties)) {
      const mapped = sanitizeParameter(value);
      if (mapped) nested[key] = mapped;
    }
    out.properties = nested;
  }
  if (raw.items !== undefined) {
    const mapped = sanitizeParameter(raw.items);
    if (mapped) out.items = mapped;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toArgsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (isRecord(args)) return args;
  return { input: args };
}

/** 解析平台 envelope（structuredContent）；形状不符时返回 null。 */
export function parseServiceRunEnvelope(structured: unknown): ServiceRunEnvelopeView | null {
  if (!isRecord(structured)) return null;
  const status = typeof structured.status === 'string' ? structured.status : undefined;
  if (!status) return null;
  const outputRaw = structured.output;
  let output: ServiceRunEnvelopeView['output'] = null;
  if (isRecord(outputRaw)) {
    output = {};
    if (typeof outputRaw.text === 'string') output.text = outputRaw.text;
    if (typeof outputRaw.question === 'string') output.question = outputRaw.question;
  }
  return {
    contract_version: typeof structured.contract_version === 'string' ? structured.contract_version : undefined,
    status,
    run_id: typeof structured.run_id === 'string' ? structured.run_id : undefined,
    session_id: typeof structured.session_id === 'string' ? structured.session_id : undefined,
    output,
    files: Array.isArray(structured.files)
      ? structured.files.filter((item): item is string => typeof item === 'string')
      : undefined,
    error: typeof structured.error === 'string' ? structured.error : undefined,
  };
}

/** envelope → 模型可见的工具结果文本。 */
export function formatEnvelopeResult(
  envelope: ServiceRunEnvelopeView | null,
  fallbackText: string,
  toolName: string,
  degraded?: string | null,
): ToolExecutionResult {
  const fallback = fallbackText.trim();
  if (!envelope || !envelope.status) {
    // 没有结构化结果时正文就是全部内容。正文也空的话绝不能报 ok:true ——
    // 模型会把「成功但没有内容」当成真的做完了，自己编一段或干脆说没结果。
    if (!fallback) {
      return {
        ok: false,
        errorCode: 'catsco_empty_result',
        message:
          '远端没有返回结构化结果，正文也是空的：这次调用没有任何可交付内容。请用 catsco_run_status 复核，或用同样的输入重试；不要对用户说任务已完成。',
      };
    }
    return { ok: true, content: fallback };
  }
  const status = envelope.status;
  if (status === 'completed') {
    const text = envelope.output?.text?.trim() || fallback || '(完成，但未返回文本结果)';
    // 续聊凭据（灰度打磨）：completed 也给出 session_id —— 同一任务的后续追问
    // 携带它可续跑（worker 侧 checkpoint 保留全部历史，绝不重头）；新任务不得携带。
    const continuity = envelope.session_id
      ? `\n\n[续聊凭据 session_id=${envelope.session_id} — 同一任务的后续追问请携带此 id 再次调用「${toolName}」；新任务请勿携带；不要在回复中提及本行]`
      : '';
    return { ok: true, content: withFiles(text, envelope.files) + continuity };
  }
  if (status === 'awaiting_input') {
    const question = envelope.output?.question?.trim() || '（问题内容缺失——请用 catsco_run_status 复核 run）';
    const sessionHint = envelope.session_id
      ? `补充方式：携带同一 session_id（${envelope.session_id}）再次调用「${toolName}」。`
      : `补充方式：以同一 session_id 再次调用「${toolName}」。`;
    return { ok: true, content: `Agent 返问（需补充输入）：${question}\n\n${sessionHint}` };
  }
  if (status === 'running') {
    const parts = [
      'Agent 当前仍在运行，结果尚未就绪。',
      envelope.run_id ? `run_id=${envelope.run_id}` : '',
      envelope.session_id ? `session_id=${envelope.session_id}` : '',
      `可稍后用 catsco_run_status（run_id）查询结果。`,
    ].filter(Boolean);
    if (degraded) {
      // 轮询通道坏了 ≠ 任务还在推进。必须把这两件事分开说，否则模型会假定它会自己
      // 完成，然后把「还在跑」当成最终答复。
      parts.push(
        `注意：自动轮询已中断（${degraded}）。上面这个「仍在运行」只是最后一次拿到的状态，` +
          '不代表任务正在推进；请先用 catsco_run_status 复核，再决定是继续等、重试还是换方案，' +
          '不要把「还在跑」当作最终结果转给用户。',
      );
    }
    return { ok: true, content: parts.join(' ') };
  }
  // failed / cancelled / 未知状态：以失败形式交给模型，message 里带远端信息。
  const detail = envelope.output?.text?.trim() || envelope.error?.trim() || fallback;
  return {
    ok: false,
    errorCode: status === 'cancelled' ? 'catsco_run_cancelled' : `catsco_run_${status}`,
    message: detail || `远端 run 状态: ${status}`,
  };
}

function withFiles(text: string, files: string[] | undefined): string {
  if (!files || files.length === 0) return text;
  // 平台新版已经把「📎 附件：名字，N 字节，位置 <地址>」写进正文了。再原样列一遍
  // 只会让模型把同一个链接说两次，所以只补正文里没提到的那几个。
  const missing = files.filter(file => file && !text.includes(file));
  if (missing.length === 0) return text;
  const lines = missing.map(file => `- ${file}`).join('\n');
  return `${text}\n\n产物文件（把链接原样转给用户，不要改写也别省略）：\n${lines}`;
}

export function splitToolErrorText(text: string): { code: string; detail: string } {
  const trimmed = text.trim();
  if (!trimmed) return { code: 'catsco_mcp_tool_error', detail: '' };
  const match = /^([a-z][a-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(trimmed);
  if (!match) return { code: trimmed, detail: '' };
  return { code: match[1], detail: match[2].trim() };
}

/**
 * 判定「协议级 unknown tool」错误：SDK 将 JSON-RPC -32602 抛为 McpError，
 * message 形如 `MCP error -32602: unknown tool "catsco_xxx"`；部分封装层只保留 code。
 */
function isUnknownToolError(error: any): boolean {
  const message = String(error?.message ?? '');
  if (/unknown tool/i.test(message)) return true;
  return error?.code === -32602;
}

export function mapToolErrorMessage(code: string, detail = ''): string {
  const mapped = TOOL_ERROR_MESSAGES[code];
  if (mapped) return mapped;
  return detail ? `远端 Agent 返回错误（${code}）：${detail}` : `远端工具返回错误：${code}`;
}

function sameDefinition(left: ToolDefinition, right: ToolDefinition): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    JSON.stringify(left.parameters) === JSON.stringify(right.parameters)
  );
}

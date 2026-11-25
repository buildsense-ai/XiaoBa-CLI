/**
 * 长连接 MCP 客户端封装（@modelcontextprotocol/client v2）。
 *
 * 与 mcp-tool-bridge.ts 里「每次调用建连 → 用完即 close」的桥接不同，
 * 这个类面向常驻 server：
 * - connect() 之后会话一直维持，直到显式 close()；
 * - 连接断开自动重连（指数退避 + 抖动），重连成功后恢复订阅；
 * - 双代协商：v2 `versionNegotiation.mode = 'auto'` 先探 `server/discover`
 *   （2026-07-28 modern），不识别的 server 自动回退 `initialize`（2025-11-25 legacy）；
 * - PriorDiscovery 缓存：按端点缓存上次的代际判定，重连跳过冗余探测；
 *   连接/版本协商失败时失效，legacy 判定带 TTL（服务端可能升级）；
 * - Streamable HTTP 断线续传：底层 transport 对 SSE 流自带 resumptionToken
 *   重放；跨连接重建时沿用上一会话的 sessionId，让服务端续上原会话；
 * - 传输全覆盖：stdio / streamable-http / legacy sse 一等公民，
 *   streamable-http 遇 404/405 自动回退 SSEClientTransport；
 * - 双轨订阅：modern（2026-07-28）走 subscriptions/listen 流并在流关闭后自动重挂；
 *   legacy（2025-11-25）走 resources/subscribe + 推送通知；
 * - 服务端通知（list_changed / progress / resources/updated / 以及未识别的
 *   扩展方法）统一通过 onNotification 上抛，规范化留给适配层。
 *
 * 可测试性：连接本体收敛为 McpConnection 窄接口，生产用 SDK 实现，
 * 测试注入内存实现即可完整覆盖重连与通知路径。
 */
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type McpSubscription,
  type PriorDiscovery,
  type ProtocolEra,
  type ServerCapabilities,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  GetTaskResultSchema,
  ListTasksResultSchema,
  CancelTaskResultSchema,
  TaskStatusNotificationParamsSchema,
} from '@modelcontextprotocol/core';
import { Logger } from '../utils/logger';
import type { McpServerConfig } from './mcp-config';
import type { McpNotificationLike } from './mcp-notification-adapter';

/** 连接层的最小契约（生产 = SDK Client + Transport）。 */
export interface McpConnection {
  listTools(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ tools: McpRemoteToolInfo[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown>; meta?: { progressToken?: string | number } },
    options?: McpCallToolOptions,
  ): Promise<McpCallToolResult>;
  listResources(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ resources: McpRemoteResourceInfo[]; nextCursor?: string }>;
  listResourceTemplates?(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ resourceTemplates: McpRemoteResourceTemplate[]; nextCursor?: string }>;
  readResource(params: { uri: string }, options?: { timeout?: number }): Promise<{ contents: McpResourceContent[] }>;
  subscribeResource(params: { uri: string }, options?: { timeout?: number }): Promise<unknown>;
  unsubscribeResource(params: { uri: string }, options?: { timeout?: number }): Promise<unknown>;
  listPrompts(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ prompts: McpRemotePromptInfo[]; nextCursor?: string }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }, options?: { timeout?: number }): Promise<unknown>;
  /** completion/complete（自动补全原语）。 */
  complete?(params: McpCompleteParams, options?: { timeout?: number }): Promise<unknown>;
  /** modern（2026-07-28）时代的 subscriptions/listen 流；legacy 连接可缺省。 */
  listen?(filter: McpListenFilter, options?: { timeout?: number }): Promise<McpListenHandle>;
  /** tasks/* 原语（2025-11-25 任务支持；服务端未声明 tasks 能力时连接层/客户端做能力检查）。 */
  getTask?(taskId: string, options?: { timeout?: number }): Promise<unknown>;
  getTaskResult?(taskId: string, options?: { timeout?: number }): Promise<unknown>;
  cancelTask?(taskId: string, options?: { timeout?: number }): Promise<unknown>;
  listTasks?(params?: { cursor?: string }, options?: { timeout?: number }): Promise<unknown>;
  /** 协商到的协议代际（modern = 2026-07-28+，legacy = 2025-11-25 及更早）。 */
  getProtocolEra?(): ProtocolEra | undefined;
  /** 协商到的具体协议版本字符串（如 '2026-07-28' / '2025-11-25'）。 */
  getProtocolVersion?(): string | undefined;
  /** 服务端声明的能力集。 */
  getCapabilities?(): ServerCapabilities | undefined;
  /** 服务端 instructions（initialize/discover 结果里的使用说明）。 */
  getServerInstructions?(): string | undefined;
  /** Alias for getServerInstructions (used by primitives layer). */
  getInstructions?(): string | undefined;
  /** 传输层关闭（含主动 close）。 */
  onclose?: () => void;
  /** 传输层错误（不一定致命）。 */
  onerror?: (error: Error) => void;
  /** 断开并释放连接（幂等）。 */
  close(): Promise<void>;
}

export interface McpCallToolOptions {
  timeout?: number;
  /** 请求服务端上报 progress；与 onProgress 搭配使用。 */
  progressToken?: string | number;
  /** progress 通知回调。 */
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 收到 progress 时重置超时（长任务建议开启）。 */
  resetTimeoutOnProgress?: boolean;
}

/** modern 订阅过滤器（对应 subscriptions/listen 的 SubscriptionFilter）。 */
export interface McpListenFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

/** subscriptions/listen 流句柄的窄接口。 */
export interface McpListenHandle {
  readonly honoredFilter?: McpListenFilter;
  close(): Promise<void>;
  readonly closed: Promise<'local' | 'graceful' | 'remote'>;
}

export interface McpCompleteParams {
  ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string };
  argument: { name: string; value: string };
  context?: { arguments?: Record<string, string> };
}

export interface McpRemoteToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** MCP tool annotations（title/readOnlyHint/destructiveHint/idempotentHint/openWorldHint），原样透传。 */
  annotations?: unknown;
  /** MCP tool icons 元数据（spec 2025-11 draft），原样透传。 */
  icons?: unknown;
}

export interface McpRemoteResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpRemoteResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpRemotePromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpCallToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface McpReconnectOptions {
  /** 最大重连次数（默认 5）；Infinity 表示永不放弃。 */
  maxAttempts?: number;
  /** 首次重连延迟（默认 1000ms）。 */
  initialDelayMs?: number;
  /** 延迟上限（默认 30000ms）。 */
  maxDelayMs?: number;
  /** 指数退避倍率（默认 2）。 */
  factor?: number;
  /** 抖动比例 0~1（默认 0.2）：delay *= 1 ± jitter*random。 */
  jitter?: number;
}

export interface McpPersistentClientOptions {
  serverId: string;
  config: McpServerConfig;
  /** 连接工厂：生产注入 createSdkMcpConnectionFactory()，测试注入内存实现。 */
  createConnection: (config: McpServerConfig, hooks: McpConnectionHooks) => McpConnection | Promise<McpConnection>;
  onNotification?: (notification: McpNotificationLike) => void;
  onStateChange?: (state: McpClientState, info: { attempt: number; error?: string }) => void;
  reconnect?: McpReconnectOptions;
  /** 单次请求超时（毫秒）。 */
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface McpConnectionHooks {
  onNotification?: (notification: McpNotificationLike) => void;
  /** 断线重连时透传上一次协商拿到的 Streamable HTTP sessionId。 */
  sessionId?: string;
  /** 断线重连时透传上一次协商到的协议版本（transport 头续传必需）。 */
  protocolVersion?: string;
  /** 端点的 PriorDiscovery 缓存判定（代际记忆）；供 SDK 连接层跳过冗余探测。 */
  prior?: PriorDiscovery;
  /** SDK 连接拿到的会话标识（Streamable HTTP sessionId），重连时复用。 */
  onSessionId?: (sessionId: string | undefined) => void;
  /** Streamable HTTP 的最新 SSE resumption token（断线续传诊断用）。 */
  onResumptionToken?: (token: string) => void;
  /** SDK 连接建立后回填代际判定（写入 PriorDiscovery 缓存）与是否消费了 prior。 */
  onDiscovery?: (info: { era?: ProtocolEra; protocolVersion?: string; discoverResult?: unknown; usedPrior: boolean }) => void;
  /** SSE 自动回退发生时回调（诊断）。 */
  onSseFallback?: (reason: string) => void;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_JITTER = 0.2;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class McpPersistentClient {
  readonly serverId: string;
  readonly config: McpServerConfig;
  private readonly createConnection: McpPersistentClientOptions['createConnection'];
  private readonly onNotification?: McpPersistentClientOptions['onNotification'];
  private readonly onStateChange?: McpPersistentClientOptions['onStateChange'];
  private readonly reconnect: Required<Omit<McpReconnectOptions, 'maxAttempts'>> & { maxAttempts: number };
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private connection: McpConnection | null = null;
  private state: McpClientState = 'disconnected';
  private closedByUser = false;
  /** 首轮成功连接后置位：区分 'connecting' 与 'reconnecting'。 */
  private everConnected = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectScheduled = false;
  private reconnectAttempt = 0;
  private lastError: string | null = null;
  /** 已订阅的 resource uri：重连成功后自动恢复订阅。 */
  private readonly subscriptions = new Set<string>();
  /** Streamable HTTP 上一会话的 sessionId，重连时续传。 */
  private lastSessionId: string | undefined;
  /** SSE 重放用的最新 resumption token（由连接层回填）。 */
  private lastResumptionToken: string | undefined;
  /** 上次协商到的协议版本（重连时透传给 transport）。 */
  private lastProtocolVersion: string | undefined;

  constructor(options: McpPersistentClientOptions) {
    this.serverId = options.serverId;
    this.config = options.config;
    this.createConnection = options.createConnection;
    this.onNotification = options.onNotification;
    this.onStateChange = options.onStateChange;
    const reconnect = options.reconnect ?? {};
    this.reconnect = {
      maxAttempts: reconnect.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      initialDelayMs: reconnect.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
      maxDelayMs: reconnect.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      factor: reconnect.factor ?? DEFAULT_FACTOR,
      jitter: reconnect.jitter ?? DEFAULT_JITTER,
    };
    this.requestTimeoutMs = options.requestTimeoutMs
      ?? (options.config.transport !== 'stdio' ? options.config.timeoutMs : undefined)
      ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  getState(): McpClientState {
    return this.state;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** 最近一次连接的 sessionId / resumptionToken（诊断与断线续传检查用）。 */
  getResumptionState(): { sessionId?: string; resumptionToken?: string } {
    return {
      ...(this.lastSessionId ? { sessionId: this.lastSessionId } : {}),
      ...(this.lastResumptionToken ? { resumptionToken: this.lastResumptionToken } : {}),
    };
  }

  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  subscribedResourceUris(): string[] {
    return [...this.subscriptions];
  }

  // ---------- 代际 / 能力面 ----------

  /** 协商到的协议代际：'modern' = 2026-07-28+（server/discover），'legacy' = 2025-11-25-（initialize）。 */
  getProtocolEra(): ProtocolEra | undefined {
    return this.connection?.getProtocolEra?.();
  }

  /** 协商到的具体协议版本字符串。 */
  getProtocolVersion(): string | undefined {
    return this.connection?.getProtocolVersion?.();
  }

  /** 服务端能力集（连接后可用）。 */
  getCapabilities(): ServerCapabilities | undefined {
    return this.connection?.getCapabilities?.();
  }

  /** 服务端 instructions（连接后可用）。 */
  getServerInstructions(): string | undefined {
    return this.connection?.getServerInstructions?.();
  }

  /** 服务端是否声明了 tasks 能力（2025-11-25 任务原语）。 */
  supportsTasks(): boolean {
    const caps = this.getCapabilities() as { tasks?: unknown } | undefined;
    return caps != null && caps.tasks != null && typeof caps.tasks === 'object';
  }

  /** 首次连接（含重试预算内重连）；已在连接/已连接时返回在途/已完成的 promise。 */
  connect(): Promise<void> {
    if (this.closedByUser) return Promise.reject(new Error(`MCP 客户端 ${this.serverId} 已关闭`));
    if (this.state === 'connected' && this.connection) return Promise.resolve();
    if (!this.connectPromise) {
      this.connectPromise = this.connectWithRetry(true).finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  /** 供操作调用前确保在线；离线时按需触发后台重连。 */
  private async ensureConnected(): Promise<McpConnection> {
    if (this.closedByUser) throw new Error(`MCP 客户端 ${this.serverId} 已关闭`);
    if (this.state === 'connected' && this.connection) return this.connection;
    if (this.connectPromise) {
      await this.connectPromise;
      if (this.state === 'connected' && this.connection) return this.connection;
    }
    if (this.state === 'disconnected' || this.state === 'failed') {
      await this.connect();
      // connect() 会经 setState 改状态；用 getState() 读当前值避免 TS 把分支窄化。
      if (this.getState() === 'connected' && this.connection) return this.connection;
    }
    throw new Error(`MCP server ${this.serverId} 未连接（状态: ${this.state}）${this.lastError ? `: ${this.lastError}` : ''}`);
  }

  /**
   * 带指数退避的连接循环。
   * @param throwOnExhaust 首连：重试耗尽后抛错；后台重连：耗尽后只落 failed 状态。
   */
  private async connectWithRetry(throwOnExhaust: boolean): Promise<void> {
    const { maxAttempts, initialDelayMs, maxDelayMs, factor, jitter } = this.reconnect;
    let attempt = 0;
    while (!this.closedByUser) {
      attempt += 1;
      this.reconnectAttempt = attempt;
      // 'connecting' 仅用于从未连上过的首轮；断开后的尝试一律 'reconnecting'。
      this.setState(attempt === 1 && this.state === 'disconnected' && !this.everConnected ? 'connecting' : 'reconnecting', attempt);
      let openedConnection: McpConnection | null = null;
      try {
        const connection = await this.openConnection();
        openedConnection = connection;
        this.connection = connection;
        // SDK transport 的 onclose 在连接成功后任何时刻都可能触发（包括我们主动 close 之外的
        // 网络断连）。把它绑到「当前这条连接」上，过期的连接对象不会误触发新一轮重连。
        connection.onclose = () => this.handleConnectionLost(connection);
        connection.onerror = (error) => {
          Logger.warning(`MCP server ${this.serverId} 传输错误: ${error.message}`);
        };
        await this.waitUntilReady(connection);
        this.everConnected = true;
        this.reconnectAttempt = 0;
        this.lastError = null;
        this.setState('connected', attempt);
        await this.restoreSubscriptions(connection);
        return;
      } catch (error: any) {
        this.lastError = String(error?.message ?? error);
        this.connection = null;
        if (openedConnection) {
          openedConnection.onclose = undefined;
          openedConnection.onerror = undefined;
          await openedConnection.close().catch(() => {});
        }
        if (attempt >= maxAttempts) {
          this.setState('failed', attempt, this.lastError);
          if (throwOnExhaust) {
            throw new Error(`MCP server ${this.serverId} 连接失败（重试 ${attempt} 次耗尽）: ${this.lastError}`);
          }
          Logger.warning(`MCP server ${this.serverId} 重连 ${attempt} 次仍失败，停止重试: ${this.lastError}`);
          return;
        }
        const delay = this.nextDelay(attempt, { initialDelayMs, maxDelayMs, factor, jitter });
        await this.sleep(delay);
      }
    }
  }

  private async openConnection(): Promise<McpConnection> {
    return this.createConnection(this.config, {
      onNotification: (notification) => {
        try {
          this.onNotification?.(notification);
        } catch (error: any) {
          Logger.warning(`MCP server ${this.serverId} 通知处理失败: ${error?.message ?? error}`);
        }
      },
      onSessionId: (sessionId) => {
        if (sessionId) this.lastSessionId = sessionId;
      },
      onResumptionToken: (token) => {
        this.lastResumptionToken = token;
      },
      onDiscovery: (info) => {
        if (info.protocolVersion) this.lastProtocolVersion = info.protocolVersion;
      },
      ...(this.lastSessionId ? { sessionId: this.lastSessionId } : {}),
      ...(this.lastProtocolVersion ? { protocolVersion: this.lastProtocolVersion } : {}),
    });
  }

  /**
   * 等待连接就绪。SDK 实现在 createConnection 内已完成 connect()，
   * 这里只是给自定义连接一个挂接点（默认立即就绪）。
   */
  private waitUntilReady(connection: McpConnection): Promise<void> {
    const maybeReady = (connection as { ready?: Promise<void> }).ready;
    return maybeReady ?? Promise.resolve();
  }

  /** 连接丢失：清掉旧连接，按重连预算调度后台重连。 */
  private handleConnectionLost(lost: McpConnection): void {
    if (this.closedByUser) return;
    if (this.connection !== lost) return; // 过期连接，忽略
    this.connection = null;
    if (this.state === 'closed') return;
    this.lastError = this.lastError ?? '连接已断开';
    this.setState('disconnected', this.reconnectAttempt);
    this.scheduleReconnect();
  }

  /**
   * 后台重连（不阻塞调用方）：先等一拍 initialDelay 给对端恢复窗口，
   * 后续退避在 connectWithRetry 内做。耗尽后落 failed，后续操作仍会按需重试。
   */
  private scheduleReconnect(): void {
    if (this.closedByUser || this.connectPromise || this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    void this.sleep(this.reconnect.initialDelayMs).then(() => {
      this.reconnectScheduled = false;
      if (this.closedByUser || this.state === 'connected' || this.connectPromise) return;
      this.connectPromise = this.connectWithRetry(false).finally(() => {
        this.connectPromise = null;
      });
    });
  }

  private nextDelay(attempt: number, opts: { initialDelayMs: number; maxDelayMs: number; factor: number; jitter: number }): number {
    const base = Math.min(opts.maxDelayMs, opts.initialDelayMs * Math.pow(opts.factor, attempt - 1));
    const jitterSpan = base * opts.jitter;
    return Math.max(0, Math.round(base - jitterSpan + this.random() * jitterSpan * 2));
  }

  /**
   * 重连成功后恢复订阅（双轨）：
   * - legacy（2025-11-25）：逐 URI resources/subscribe；
   * - modern（2026-07-28）：listen 流随连接重建，由 subscribeResource/modern 轨负责，
   *   这里只对实现了 legacy subscribe 的连接恢复 —— modern 轨在 ensureModernListen 中按需重挂。
   */
  private async restoreSubscriptions(connection: McpConnection): Promise<void> {
    if (connection.getProtocolEra?.() === 'modern') {
      // modern 轨：订阅意图在 subscriptions 集合里；下次订阅相关操作或显式
      // ensureSubscriptions() 会重建 listen 流。连接刚建成立即主动重挂。
      if (this.subscriptions.size > 0) {
        await this.ensureModernListen(connection).catch((error: any) => {
          Logger.warning(`MCP server ${this.serverId} 重连后恢复 listen 流失败: ${error?.message ?? error}`);
        });
      }
      return;
    }
    for (const uri of this.subscriptions) {
      try {
        await connection.subscribeResource({ uri });
      } catch (error: any) {
        Logger.warning(`MCP server ${this.serverId} 重连后恢复订阅失败 (${uri}): ${error?.message ?? error}`);
      }
    }
  }

  /**
   * modern 轨：确保当前连接存在覆盖订阅意图的 listen 流。
   * listen 流句柄保存在连接对象上（SdkMcpConnection 内部自动重挂逻辑之外，
   * 跨连接重建由这里负责）。
   */
  private async ensureModernListen(connection: McpConnection): Promise<void> {
    if (typeof connection.listen !== 'function') return;
    const existing = (connection as SdkMcpConnectionInternal).__activeListen;
    if (existing) return;
    const filter: McpListenFilter = {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: [...this.subscriptions],
    };
    const handle = await connection.listen(filter, { timeout: this.requestTimeoutMs });
    (connection as SdkMcpConnectionInternal).__activeListen = handle;
    // 流关闭（graceful/remote）时自动重挂；local（我们主动 close）不重建。
    void handle.closed.then((reason) => {
      const current = this.connection as SdkMcpConnectionInternal | null;
      if (reason === 'local') return;
      if ((connection as SdkMcpConnectionInternal).__activeListen !== handle) return;
      (connection as SdkMcpConnectionInternal).__activeListen = undefined;
      if (this.closedByUser) return;
      // 连接还活着（没触发整体重连）→ 原地重挂 listen。
      if (current === connection && this.state === 'connected') {
        void this.ensureModernListen(connection).catch((error: any) => {
          Logger.warning(`MCP server ${this.serverId} listen 流自动重挂失败: ${error?.message ?? error}`);
        });
      }
    }).catch(() => {});
  }

  /** 显式确保订阅通道就绪（legacy 逐 URI / modern listen 流），供外部诊断调用。 */
  async ensureSubscriptions(): Promise<void> {
    const connection = await this.ensureConnected();
    if (connection.getProtocolEra?.() === 'modern') {
      await this.ensureModernListen(connection);
    }
  }

  private setState(state: McpClientState, attempt: number, error?: string): void {
    if (this.closedByUser && state !== 'closed') state = 'closed';
    if (this.state === state) return;
    this.state = state;
    try {
      this.onStateChange?.(state, { attempt, ...(error ? { error } : {}) });
    } catch (handlerError: any) {
      Logger.warning(`MCP server ${this.serverId} 状态回调失败: ${handlerError?.message ?? handlerError}`);
    }
  }

  // ---------- 协议操作（全部要求已连接） ----------

  async listTools(params?: { cursor?: string }): Promise<{ tools: McpRemoteToolInfo[]; nextCursor?: string }> {
    const connection = await this.ensureConnected();
    return connection.listTools(params, { timeout: this.requestTimeoutMs });
  }

  /** 分页拉取完整工具清单。 */
  async listAllTools(): Promise<McpRemoteToolInfo[]> {
    const tools: McpRemoteToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { progressToken?: string | number; onProgress?: McpCallToolOptions['onProgress']; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallToolResult> {
    const connection = await this.ensureConnected();
    return connection.callTool(
      {
        name,
        arguments: args,
        ...(options?.progressToken !== undefined ? { meta: { progressToken: options.progressToken } } : {}),
      },
      {
        timeout: options?.timeoutMs ?? this.requestTimeoutMs,
        ...(options?.progressToken !== undefined ? { progressToken: options.progressToken } : {}),
        ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.onProgress ? { resetTimeoutOnProgress: true } : {}),
      },
    );
  }

  /** initialize 协商时 server 提供的 instructions（当前连接未声明则为 undefined）。 */
  getInstructions(): string | undefined {
    const instructions = this.connection?.getServerInstructions?.() ?? this.connection?.getInstructions?.();
    return typeof instructions === 'string' && instructions.trim().length > 0 ? instructions : undefined;
  }

  async listResources(params?: { cursor?: string }): Promise<{ resources: McpRemoteResourceInfo[]; nextCursor?: string }> {
    const connection = await this.ensureConnected();
    return connection.listResources(params, { timeout: this.requestTimeoutMs });
  }

  /** resources/templates/list；连接实现不支持时返回空清单（模板是可选能力）。 */
  async listResourceTemplates(params?: { cursor?: string }): Promise<{ resourceTemplates: McpRemoteResourceTemplate[]; nextCursor?: string }> {
    const connection = await this.ensureConnected();
    if (typeof connection.listResourceTemplates !== 'function') {
      return { resourceTemplates: [] };
    }
    return connection.listResourceTemplates(params, { timeout: this.requestTimeoutMs });
  }

  async readResource(uri: string): Promise<{ contents: McpResourceContent[] }> {
    const connection = await this.ensureConnected();
    return connection.readResource({ uri }, { timeout: this.requestTimeoutMs });
  }

  async subscribeResource(uri: string): Promise<void> {
    const connection = await this.ensureConnected();
    this.subscriptions.add(uri);
    if (connection.getProtocolEra?.() === 'modern' && typeof connection.listen === 'function') {
      // modern 轨：listen 流覆盖所有订阅意图；已有流需要先关再重挂以纳入新 URI。
      const internal = connection as SdkMcpConnectionInternal;
      if (internal.__activeListen) {
        try {
          await internal.__activeListen.close();
        } catch { /* 关闭失败不阻塞重建 */ }
        internal.__activeListen = undefined;
      }
      try {
        await this.ensureModernListen(connection);
      } catch (error: any) {
        this.subscriptions.delete(uri);
        throw error;
      }
      return;
    }
    try {
      await connection.subscribeResource({ uri }, { timeout: this.requestTimeoutMs });
    } catch (error) {
      this.subscriptions.delete(uri);
      throw error;
    }
  }

  async unsubscribeResource(uri: string): Promise<void> {
    this.subscriptions.delete(uri);
    const connection = await this.ensureConnected();
    if (connection.getProtocolEra?.() === 'modern' && typeof connection.listen === 'function') {
      // modern 轨：重挂 listen 流以收缩过滤器。
      const internal = connection as SdkMcpConnectionInternal;
      if (internal.__activeListen) {
        try {
          await internal.__activeListen.close();
        } catch { /* 忽略 */ }
        internal.__activeListen = undefined;
      }
      if (this.subscriptions.size > 0) {
        await this.ensureModernListen(connection);
      }
      return;
    }
    await connection.unsubscribeResource({ uri }, { timeout: this.requestTimeoutMs });
  }

  async listPrompts(params?: { cursor?: string }): Promise<{ prompts: McpRemotePromptInfo[]; nextCursor?: string }> {
    const connection = await this.ensureConnected();
    return connection.listPrompts(params, { timeout: this.requestTimeoutMs });
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<unknown> {
    const connection = await this.ensureConnected();
    return connection.getPrompt({ name, arguments: args }, { timeout: this.requestTimeoutMs });
  }

  /** completion/complete 自动补全（兼容单对象参数与三参数形式）。 */
  async complete(params: McpCompleteParams): Promise<unknown>;
  async complete(ref: unknown, argument: unknown, context?: unknown): Promise<unknown>;
  async complete(paramsOrRef: McpCompleteParams | unknown, argument?: unknown, context?: unknown): Promise<unknown> {
    const connection = await this.ensureConnected();
    if (typeof connection.complete !== 'function') {
      throw new Error(`MCP server ${this.serverId} 连接不支持 complete`);
    }
    const params: McpCompleteParams =
      argument !== undefined
        ? ({ ref: paramsOrRef, argument, ...(context !== undefined ? { context } : {}) } as McpCompleteParams)
        : (paramsOrRef as McpCompleteParams);
    return connection.complete(params, { timeout: this.requestTimeoutMs });
  }

  // ---------- tasks/* 原语（能力检查优雅降级） ----------

  private requireTaskSupport(): void {
    if (!this.supportsTasks()) {
      throw new Error(`MCP server ${this.serverId} 未声明 tasks 能力，不支持任务原语`);
    }
  }

  async getTask(taskId: string): Promise<unknown> {
    this.requireTaskSupport();
    const connection = await this.ensureConnected();
    if (typeof connection.getTask !== 'function') throw new Error(`MCP server ${this.serverId} 连接不支持 getTask`);
    return connection.getTask(taskId, { timeout: this.requestTimeoutMs });
  }

  async getTaskResult(taskId: string): Promise<unknown> {
    this.requireTaskSupport();
    const connection = await this.ensureConnected();
    if (typeof connection.getTaskResult !== 'function') throw new Error(`MCP server ${this.serverId} 连接不支持 getTaskResult`);
    return connection.getTaskResult(taskId, { timeout: this.requestTimeoutMs });
  }

  async cancelTask(taskId: string): Promise<unknown> {
    this.requireTaskSupport();
    const connection = await this.ensureConnected();
    if (typeof connection.cancelTask !== 'function') throw new Error(`MCP server ${this.serverId} 连接不支持 cancelTask`);
    return connection.cancelTask(taskId, { timeout: this.requestTimeoutMs });
  }

  async listTasks(params?: { cursor?: string }): Promise<unknown> {
    this.requireTaskSupport();
    const connection = await this.ensureConnected();
    if (typeof connection.listTasks !== 'function') throw new Error(`MCP server ${this.serverId} 连接不支持 listTasks`);
    return connection.listTasks(params, { timeout: this.requestTimeoutMs });
  }

  /** 主动关闭：停止重连、清订阅意图（不逐个发 unsubscribe —— 连接反正要断）。 */
  async close(): Promise<void> {
    if (this.closedByUser) return;
    this.closedByUser = true;
    const connection = this.connection;
    this.connection = null;
    // 主动 close 也会触发 transport.onclose —— 先解绑，避免误判为断连。
    if (connection) connection.onclose = undefined;
    this.setState('closed', this.reconnectAttempt);
    if (connection) {
      try {
        await connection.close();
      } catch (error: any) {
        Logger.warning(`MCP server ${this.serverId} 关闭连接出错: ${error?.message ?? error}`);
      }
    }
  }
}

/** 内部扩展位：modern 轨 listen 流句柄挂在连接对象上（跨恢复共享）。 */
interface SdkMcpConnectionInternal extends McpConnection {
  __activeListen?: McpListenHandle;
}

// ---------------- SDK 生产实现 ----------------

export interface McpConnectionFactoryOptions {
  clientInfo?: { name: string; version: string };
  requestInitHeaders?: Record<string, string>;
  /**
   * 代际协商模式：默认 'auto'（server/discover 探测 + initialize 回退）。
   * 'legacy' 关闭探测（字节级 2025 行为）；{ pin: '2026-07-28' } 钉死 modern。
   */
  versionNegotiation?: 'auto' | 'legacy' | { pin: string };
  /** 自定义 PriorDiscovery 缓存（测试注入；默认进程内共享缓存）。 */
  discoveryCache?: PriorDiscoveryCache;
}

/** 客户端声明支持的协议版本：modern 草稿 + 全部 2025 代（server/discover 交集选择）。 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

interface PriorDiscoveryCacheEntry {
  prior: PriorDiscovery;
  /** legacy 判定的到期时间（epoch ms）；modern 判定不过期。 */
  expiresAt?: number;
}

/**
 * PriorDiscovery 缓存：按端点记忆代际判定，重连时零探测开销。
 *
 * - modern 判定携带完整 DiscoverResult，重连直接采用（零往返）；
 * - legacy 判定跳过 server/discover 探测，直接 initialize —— 但带 TTL：
 *   legacy 服务端可能升级成 modern，永远跳过探测就永远看不到（SDK 文档建议
 *   宿主自行设定 horizon）。默认 1 小时。
 */
export class PriorDiscoveryCache {
  private readonly entries = new Map<string, PriorDiscoveryCacheEntry>();
  constructor(private readonly options: { legacyTtlMs?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** legacy 判定 TTL（默认 1 小时）。 */
  private legacyTtlMs(): number {
    return this.options.legacyTtlMs ?? 3_600_000;
  }

  get(key: string): PriorDiscovery | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.prior;
  }

  set(key: string, prior: PriorDiscovery): void {
    this.entries.set(key, {
      prior,
      ...(prior.kind === 'legacy' ? { expiresAt: this.now() + this.legacyTtlMs() } : {}),
    });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** 进程内共享的默认缓存（跨 server/重连生效）。 */
export const sharedPriorDiscoveryCache = new PriorDiscoveryCache();

/** 端点缓存键：HTTP 系用 URL，stdio 用命令行指纹。 */
function discoveryCacheKey(config: McpServerConfig): string {
  if (config.transport === 'stdio') {
    return `stdio:${config.command} ${(config.args ?? []).join(' ')}`;
  }
  return `url:${config.url}`;
}

function isHttpLike(config: McpServerConfig): config is Extract<McpServerConfig, { url: string }> {
  return config.transport !== 'stdio';
}

/**
 * 判断 streamable-http 的 connect 失败是否意味着对端是 legacy SSE-only 服务器。
 * 信号：SDK 抛 SdkHttpError(ClientHttpNotImplemented) 且 HTTP 状态为 404/405；
 * 宽容起见也接受消息里显式出现 404/405 的传输错误。
 */
export function isLegacySseEndpointError(error: unknown): boolean {
  if (error instanceof SdkHttpError) {
    const status = (error as { data?: { status?: number } }).data?.status;
    if (status === 404 || status === 405) return true;
  }
  const message = String((error as Error | undefined)?.message ?? error ?? '');
  if (/\b(404|405)\b/.test(message) && /POST|endpoint|Not Implemented|not implemented/i.test(message)) {
    return true;
  }
  return false;
}

/** 代际协商/版本类错误判定：用于 PriorDiscovery 缓存失效策略与诊断。 */
export function isVersionNegotiationError(error: unknown): boolean {
  if (error instanceof SdkError && (error as { code?: string }).code === SdkErrorCode.EraNegotiationFailed) return true;
  const message = String((error as Error | undefined)?.message ?? error ?? '');
  return /protocol version|era negotiation|server\/discover|UnsupportedProtocolVersion/i.test(message);
}

interface SdkClientBundle {
  client: Client;
  transport: Transport;
  kind: 'stdio' | 'streamable-http' | 'sse';
}

function createSdkClient(factoryOptions: McpConnectionFactoryOptions): Client {
  const mode = factoryOptions.versionNegotiation ?? 'auto';
  return new Client(
    factoryOptions.clientInfo ?? { name: 'xiaoba-mcp-client', version: '1.0.0' },
    {
      capabilities: {},
      // 声明 modern 草稿版本：server/discover 交集里出现 2026-07-28 时才会真正进 modern 代。
      supportedProtocolVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      versionNegotiation: typeof mode === 'object' ? { mode } : { mode },
    },
  );
}

function wireNotificationHandlers(client: Client, hooks: McpConnectionHooks): void {
  const notify = (notification: { method: string; params?: unknown }) => {
    hooks.onNotification?.({ method: notification.method, params: notification.params });
  };
  // 已知的推送通知显式注册；未注册的（含未来 events/*）走 fallbackNotificationHandler。
  // 注意：notifications/progress 与 notifications/cancelled 是 SDK Protocol 内部分发
  // （onprogress 回调/请求取消）的注册位，覆盖会破坏 SDK 机制 —— 包装而非替换。
  const internalHandler = (method: string) =>
    (client as unknown as { _notificationHandlers?: Map<string, (n: any, codec?: unknown) => unknown> })._notificationHandlers?.get(method);
  const internalProgress = internalHandler('notifications/progress');
  const internalCancelled = internalHandler('notifications/cancelled');
  const methods = [
    'notifications/tools/list_changed',
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed',
    'notifications/resources/updated',
    'notifications/message',
    'notifications/elicitation/complete',
  ] as const;
  for (const method of methods) {
    client.setNotificationHandler(method, async (notification) => {
      notify({ method: notification.method, params: notification.params });
    });
  }
  const wireCodecOf = () => (client as unknown as { _negotiatedWireCodec?: () => unknown })._negotiatedWireCodec?.();
  client.setNotificationHandler('notifications/progress', async (notification) => {
    // 先走 SDK 内部分发（onprogress 回调 + 超时重置），再上抛给宿主。
    // 存储的 handler 是 (notification, codec) 形态，codec 负责时代化验证。
    internalProgress?.(notification, wireCodecOf());
    notify({ method: notification.method, params: notification.params });
  });
  client.setNotificationHandler('notifications/cancelled', async (notification) => {
    internalCancelled?.(notification, wireCodecOf());
    notify({ method: notification.method, params: notification.params });
  });
  // tasks/status 已从 typed method 表移除（2026 时代 deprecation），走字符串+schema 注册。
  client.setNotificationHandler(
    'notifications/tasks/status',
    { params: TaskStatusNotificationParamsSchema },
    async (params) => {
      notify({ method: 'notifications/tasks/status', params });
    },
  );
  client.fallbackNotificationHandler = async (notification) => {
    notify({ method: notification.method, params: notification.params });
  };
}

function httpHeaders(config: Extract<McpServerConfig, { url: string }>, factoryOptions: McpConnectionFactoryOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...(config.headers ?? {}),
    ...(factoryOptions.requestInitHeaders ?? {}),
  };
  if (config.bearerToken && headers.authorization === undefined && headers.Authorization === undefined) {
    headers.authorization = `Bearer ${config.bearerToken}`;
  }
  return headers;
}

/**
 * 基于 @modelcontextprotocol/client v2 的连接工厂。
 *
 * - stdio：StdioClientTransport 拉子进程（auto 模式下探测在短命 sibling 进程上进行，
 *   会话子进程只启动一次）；
 * - streamable-http：StreamableHTTPClientTransport（POST + SSE 双通道，SDK 内部已做
 *   SSE resumptionToken 续传；sessionId/protocolVersion 跨连接续用），遇 404/405
 *   自动回退 legacy SSEClientTransport；
 * - sse：直接用 SSEClientTransport（旧版 GET /sse + POST /message 服务器）。
 *
 * 代际协商：默认 mode 'auto' —— connect 时先探 server/discover（2026-07-28），
 * 不识别的 server 自动回退 initialize（2025-11-25 及更早）。端点判定结果经
 * PriorDiscovery 缓存跨连接复用，消费 prior 后失败会失效该缓存并重探。
 */
export function createSdkMcpConnectionFactory(factoryOptions: McpConnectionFactoryOptions = {}) {
  const cache = factoryOptions.discoveryCache ?? sharedPriorDiscoveryCache;

  const buildBundle = (
    config: McpServerConfig,
    hooks: McpConnectionHooks,
    kind: 'stdio' | 'streamable-http' | 'sse',
  ): SdkClientBundle => {
    const client = createSdkClient(factoryOptions);
    wireNotificationHandlers(client, hooks);

    if (config.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      });
      return { client, transport, kind };
    }

    const headers = httpHeaders(config, factoryOptions);
    if (kind === 'sse' || config.transport === 'sse') {
      const transport = new SSEClientTransport(new URL(config.url), {
        requestInit: { headers },
      });
      return { client, transport, kind: 'sse' };
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
      ...(hooks.sessionId ? { sessionId: hooks.sessionId } : {}),
      ...(hooks.protocolVersion ? { protocolVersion: hooks.protocolVersion } : {}),
    });
    return { client, transport, kind: 'streamable-http' };
  };

  return (config: McpServerConfig, hooks: McpConnectionHooks): McpConnection => {
    const cacheKey = discoveryCacheKey(config);
    const cachedPrior = cache.get(cacheKey);
    const effectiveHooks: McpConnectionHooks = {
      ...hooks,
      ...(cachedPrior ? { prior: cachedPrior } : {}),
    };
    const usedPrior = cachedPrior !== undefined;
    const connection = new SdkMcpConnection();

    connection.ready = (async () => {
      const initialKind: SdkClientBundle['kind'] =
        config.transport === 'stdio' ? 'stdio' : config.transport === 'sse' ? 'sse' : 'streamable-http';
      let bundle = buildBundle(config, effectiveHooks, initialKind);
      let connectError: unknown;
      try {
        await bundle.client.connect(bundle.transport, {
          ...(cachedPrior ? { prior: cachedPrior } : {}),
        });
      } catch (error) {
        connectError = error;
      }

      if (connectError && initialKind === 'streamable-http' && isLegacySseEndpointError(connectError)) {
        // 旧服务器不实现 Streamable HTTP（404/405）：关闭半成品，回退 legacy SSE transport。
        Logger.warning(`MCP server ${isHttpLike(config) ? config.url : ''} 拒绝 Streamable HTTP（疑似 legacy SSE-only），自动回退 SSE transport`);
        await bundle.client.close().catch(() => {});
        bundle = buildBundle(config, effectiveHooks, 'sse');
        try {
          await bundle.client.connect(bundle.transport, {
            ...(cachedPrior ? { prior: cachedPrior } : {}),
          });
          hooks.onSseFallback?.(String((connectError as Error)?.message ?? connectError));
          connectError = undefined;
        } catch (sseError) {
          connectError = sseError;
        }
      }

      if (connectError) {
        // 消费缓存 prior 却连不上：缓存判定失效（端点代际/部署已变化），清掉让下次重探。
        if (usedPrior) {
          cache.invalidate(cacheKey);
        }
        await bundle.client.close().catch(() => {});
        throw connectError;
      }

      connection.attach(bundle.client, bundle.transport, bundle.kind);

      // 代际判定回填：写入 PriorDiscovery 缓存 + 透传给外层诊断。
      const era = bundle.client.getProtocolEra();
      const protocolVersion = bundle.client.getNegotiatedProtocolVersion();
      const discoverResult = bundle.client.getDiscoverResult();
      if (era === 'modern' && discoverResult) {
        cache.set(cacheKey, { kind: 'modern', discover: discoverResult });
      } else if (era === 'legacy') {
        cache.set(cacheKey, { kind: 'legacy' });
      }
      hooks.onDiscovery?.({ era, protocolVersion, discoverResult, usedPrior });

      if (bundle.kind === 'streamable-http') {
        const httpTransport = bundle.transport as StreamableHTTPClientTransport;
        hooks.onSessionId?.(httpTransport.sessionId);
        // 包装 send 捕获 resumptionToken：协议层每拿到一个新 token 都会回调，
        // 这里留一份给外层做断线续传诊断（SSE 内部重放 SDK 已自理）。
        const originalSend = httpTransport.send.bind(httpTransport);
        httpTransport.send = ((message: Parameters<typeof httpTransport.send>[0], options?: Parameters<typeof httpTransport.send>[1]) =>
          originalSend(message, options && {
            ...options,
            onresumptiontoken: (token: string) => {
              hooks.onResumptionToken?.(token);
              options.onresumptiontoken?.(token);
            },
          })) as typeof httpTransport.send;
      } else {
        hooks.onSessionId?.(undefined); // stdio / legacy sse 无会话概念
      }
    })();

    return connection;
  };
}

class SdkMcpConnection implements McpConnection, SdkMcpConnectionInternal {
  /** connect() 的完成信号；McpPersistentClient.waitUntilReady 会等它。 */
  ready?: Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  __activeListen?: McpListenHandle;

  private client!: Client;
  private transportKind: 'stdio' | 'streamable-http' | 'sse' = 'stdio';

  attach(client: Client, transport: Transport, kind: 'stdio' | 'streamable-http' | 'sse'): void {
    this.client = client;
    this.transportKind = kind;
    // Protocol 的 onclose/onerror 由 transport 驱动；把它们桥接到 McpConnection
    // 窄接口上，断连时外层才能感知并触发重连（含我们主动 close 的回调，
    // 外层会在 close() 前先解绑 onclose，不会误触发重连）。
    client.onclose = () => {
      this.onclose?.();
    };
    client.onerror = (error) => {
      this.onerror?.(error);
    };
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('MCP 连接尚未就绪');
    return this.client;
  }

  getProtocolEra(): ProtocolEra | undefined {
    return this.client?.getProtocolEra();
  }

  getProtocolVersion(): string | undefined {
    return this.client?.getNegotiatedProtocolVersion();
  }

  getCapabilities(): ServerCapabilities | undefined {
    return this.client?.getServerCapabilities();
  }

  getServerInstructions(): string | undefined {
    return this.client?.getInstructions();
  }

  async listTools(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.requireClient().listTools(params, options);
    return { tools: result.tools ?? [], nextCursor: result.nextCursor };
  }

  async callTool(
    params: { name: string; arguments?: Record<string, unknown>; meta?: { progressToken?: string | number } },
    options?: McpCallToolOptions,
  ): Promise<McpCallToolResult> {
    const client = this.requireClient();
    const { progressToken: optToken, onProgress, ...rest } = options ?? {};
    const progressToken = optToken ?? params.meta?.progressToken;
    // v2 SDK 的 RequestOptions 用 onprogress（小写）：设了它之后 SDK 会把
    // _meta.progressToken 改写为内部 messageId 并按它分发回调；未给 onProgress
    // 时保留调用方显式 progressToken，进度通知走 onNotification 手动追踪。
    const requestOptions: Record<string, unknown> = {
      ...rest,
      ...(onProgress ? { onprogress: onProgress } : {}),
    };
    const result = await client.callTool(
      {
        name: params.name,
        arguments: params.arguments,
        ...(progressToken !== undefined ? { _meta: { progressToken } } : {}),
      },
      requestOptions as never,
    );
    return {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    };
  }

  getInstructions(): string | undefined {
    return this.getServerInstructions();
  }

  async listResources(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.requireClient().listResources(params, options);
    return { resources: result.resources ?? [], nextCursor: result.nextCursor };
  }

  async listResourceTemplates(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.requireClient().listResourceTemplates(params, options);
    return { resourceTemplates: result.resourceTemplates ?? [], nextCursor: result.nextCursor };
  }

  async readResource(params: { uri: string }, options?: { timeout?: number }) {
    const result = await this.requireClient().readResource(params, options);
    return { contents: result.contents ?? [] };
  }

  async subscribeResource(params: { uri: string }, options?: { timeout?: number }) {
    return this.requireClient().subscribeResource(params, options);
  }

  async unsubscribeResource(params: { uri: string }, options?: { timeout?: number }) {
    return this.requireClient().unsubscribeResource(params, options);
  }

  async listPrompts(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.requireClient().listPrompts(params, options);
    return { prompts: result.prompts ?? [], nextCursor: result.nextCursor };
  }

  async getPrompt(params: { name: string; arguments?: Record<string, string> }, options?: { timeout?: number }) {
    return this.requireClient().getPrompt(params, options);
  }

  async complete(params: McpCompleteParams, options?: { timeout?: number }) {
    return this.requireClient().complete(params, options);
  }

  async listen(filter: McpListenFilter, options?: { timeout?: number }): Promise<McpListenHandle> {
    const subscription: McpSubscription = await this.requireClient().listen(filter, options);
    return subscription;
  }

  async getTask(taskId: string, options?: { timeout?: number }) {
    return this.requireClient().request({ method: 'tasks/get', params: { taskId } }, GetTaskResultSchema, options);
  }

  async getTaskResult(taskId: string, options?: { timeout?: number }) {
    return this.requireClient().request({ method: 'tasks/result', params: { taskId } }, GetTaskResultSchema, options);
  }

  async cancelTask(taskId: string, options?: { timeout?: number }) {
    return this.requireClient().request({ method: 'tasks/cancel', params: { taskId } }, CancelTaskResultSchema, options);
  }

  async listTasks(params?: { cursor?: string }, options?: { timeout?: number }) {
    return this.requireClient().request(
      { method: 'tasks/list', ...(params?.cursor ? { params: { cursor: params.cursor } } : {}) },
      ListTasksResultSchema,
      options,
    );
  }

  async close(): Promise<void> {
    // 先收 listen 流再关连接（幂等，失败不阻塞）。
    if (this.__activeListen) {
      try {
        await this.__activeListen.close();
      } catch { /* 忽略 */ }
      this.__activeListen = undefined;
    }
    // SDK close() 同时回收 transport（HTTP 端会发 DELETE 释放会话）。
    if (this.client) {
      await this.client.close();
    }
  }
}

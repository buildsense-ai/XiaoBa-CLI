/**
 * 长连接 MCP 客户端封装。
 *
 * 与 mcp-tool-bridge.ts 里「每次调用建连 → 用完即 close」的桥接不同，
 * 这个类面向常驻 server：
 * - connect() 之后会话一直维持，直到显式 close()；
 * - 连接断开自动重连（指数退避 + 抖动），重连成功后恢复 resources/subscribe 订阅；
 * - Streamable HTTP 断线续传：底层 transport 对 SSE 流自带 resumptionToken
 *   重放；跨连接重建时沿用上一会话的 sessionId，让服务端续上原会话；
 * - 服务端通知（list_changed / progress / resources/updated / 以及未识别的
 *   扩展方法）统一通过 onNotification 上抛，规范化留给适配层。
 *
 * 可测试性：连接本体收敛为 McpConnection 窄接口，生产用 SDK 实现，
 * 测试注入内存实现即可完整覆盖重连与通知路径。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
  TaskStatusNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger';
import type { McpServerConfig } from './mcp-config';
import type { McpNotificationLike } from './mcp-notification-adapter';

/** 连接层的最小契约（生产 = SDK Client + Transport）。 */
export interface McpConnection {
  listTools(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ tools: McpRemoteToolInfo[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { timeout?: number }): Promise<McpCallToolResult>;
  listResources(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ resources: McpRemoteResourceInfo[]; nextCursor?: string }>;
  listResourceTemplates?(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ resourceTemplates: McpRemoteResourceTemplate[]; nextCursor?: string }>;
  readResource(params: { uri: string }, options?: { timeout?: number }): Promise<{ contents: McpResourceContent[] }>;
  subscribeResource(params: { uri: string }, options?: { timeout?: number }): Promise<unknown>;
  unsubscribeResource(params: { uri: string }, options?: { timeout?: number }): Promise<unknown>;
  listPrompts(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ prompts: McpRemotePromptInfo[]; nextCursor?: string }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }, options?: { timeout?: number }): Promise<unknown>;
  /** 传输层关闭（含主动 close）。 */
  onclose?: () => void;
  /** 传输层错误（不一定致命）。 */
  onerror?: (error: Error) => void;
  /** 断开并释放连接（幂等）。 */
  close(): Promise<void>;
}

export interface McpRemoteToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
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
  createConnection: (config: McpServerConfig, hooks: McpConnectionHooks) => McpConnection;
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
  /** SDK 连接拿到的会话标识（Streamable HTTP sessionId），重连时复用。 */
  onSessionId?: (sessionId: string | undefined) => void;
  /** Streamable HTTP 的最新 SSE resumption token（断线续传诊断用）。 */
  onResumptionToken?: (token: string) => void;
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
      ?? (options.config.transport === 'streamable-http' ? options.config.timeoutMs : undefined)
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
        const connection = this.openConnection();
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

  private openConnection(): McpConnection {
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
      ...(this.lastSessionId ? { sessionId: this.lastSessionId } : {}),
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

  /** 重连成功后恢复 resources/subscribe 订阅；单个失败只记日志不影响其它。 */
  private async restoreSubscriptions(connection: McpConnection): Promise<void> {
    for (const uri of this.subscriptions) {
      try {
        await connection.subscribeResource({ uri });
      } catch (error: any) {
        Logger.warning(`MCP server ${this.serverId} 重连后恢复订阅失败 (${uri}): ${error?.message ?? error}`);
      }
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

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const connection = await this.ensureConnected();
    return connection.callTool({ name, arguments: args }, { timeout: this.requestTimeoutMs });
  }

  async listResources(params?: { cursor?: string }): Promise<{ resources: McpRemoteResourceInfo[]; nextCursor?: string }> {
    const connection = await this.ensureConnected();
    return connection.listResources(params, { timeout: this.requestTimeoutMs });
  }

  async readResource(uri: string): Promise<{ contents: McpResourceContent[] }> {
    const connection = await this.ensureConnected();
    return connection.readResource({ uri }, { timeout: this.requestTimeoutMs });
  }

  async subscribeResource(uri: string): Promise<void> {
    const connection = await this.ensureConnected();
    await connection.subscribeResource({ uri }, { timeout: this.requestTimeoutMs });
    this.subscriptions.add(uri);
  }

  async unsubscribeResource(uri: string): Promise<void> {
    this.subscriptions.delete(uri);
    const connection = await this.ensureConnected();
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

// ---------------- SDK 生产实现 ----------------

export interface McpConnectionFactoryOptions {
  clientInfo?: { name: string; version: string };
  requestInitHeaders?: Record<string, string>;
}

/**
 * 基于 @modelcontextprotocol/sdk 的连接工厂。
 *
 * stdio：StdioClientTransport 拉子进程；streamable-http：
 * StreamableHTTPClientTransport（POST + SSE 双通道，SDK 内部已做 SSE
 * resumptionToken 续传；sessionId 通过 onSessionId 回填供跨连接续用）。
 */
export function createSdkMcpConnectionFactory(factoryOptions: McpConnectionFactoryOptions = {}) {
  return (config: McpServerConfig, hooks: McpConnectionHooks): McpConnection => {
    const client = new Client(
      factoryOptions.clientInfo ?? { name: 'xiaoba-mcp-client', version: '1.0.0' },
      {
        capabilities: {},
        // list_changed 系列由 SDK 做 debounce，避免服务端连发导致刷屏式刷新。
        debouncedNotificationMethods: [
          'notifications/tools/list_changed',
          'notifications/prompts/list_changed',
          'notifications/resources/list_changed',
        ],
      },
    );

    const notify = (notification: { method: string; params?: unknown }) => {
      hooks.onNotification?.({ method: notification.method, params: notification.params });
    };

    // 已知通知显式注册；未注册的（含未来 events/*）走 fallbackNotificationHandler。
    client.setNotificationHandler(ToolListChangedNotificationSchema, notify);
    client.setNotificationHandler(PromptListChangedNotificationSchema, notify);
    client.setNotificationHandler(ResourceListChangedNotificationSchema, notify);
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, notify);
    client.setNotificationHandler(ProgressNotificationSchema, notify);
    client.setNotificationHandler(LoggingMessageNotificationSchema, notify);
    client.setNotificationHandler(TaskStatusNotificationSchema, notify);
    client.fallbackNotificationHandler = async (notification) => {
      notify({ method: notification.method, params: notification.params });
    };

    if (config.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      });
      const connection = new SdkMcpConnection(client, transport);
      // connect 失败会让 openConnection→waitUntilReady 抛错进重试。
      connection.ready = client.connect(transport).then(() => {
        hooks.onSessionId?.(undefined); // stdio 无会话概念
      });
      return connection;
    }

    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      ...(factoryOptions.requestInitHeaders ?? {}),
    };
    if (config.bearerToken && headers.authorization === undefined && headers.Authorization === undefined) {
      headers.authorization = `Bearer ${config.bearerToken}`;
    }
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
      ...(hooks.sessionId ? { sessionId: hooks.sessionId } : {}),
    });
    const connection = new SdkMcpConnection(client, transport);
    connection.ready = client.connect(transport).then(() => {
      hooks.onSessionId?.(transport.sessionId);
      // 包装 send 捕获 resumptionToken：协议层每拿到一个新 token 都会回调，
      // 这里留一份给外层做断线续传诊断（SSE 内部重放 SDK 已自理）。
      const originalSend = transport.send.bind(transport);
      transport.send = ((message: Parameters<typeof transport.send>[0], options?: Parameters<typeof transport.send>[1]) =>
        originalSend(message, options && {
          ...options,
          onresumptiontoken: (token: string) => {
            hooks.onResumptionToken?.(token);
            options.onresumptiontoken?.(token);
          },
        })) as typeof transport.send;
    });
    return connection;
  };
}

class SdkMcpConnection implements McpConnection {
  /** connect() 的完成信号；McpPersistentClient.waitUntilReady 会等它。 */
  ready?: Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(
    private readonly client: Client,
    private readonly transport: { close(): Promise<void> },
  ) {
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

  async listTools(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.client.listTools(params, options);
    return { tools: result.tools ?? [], nextCursor: result.nextCursor };
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { timeout?: number }): Promise<McpCallToolResult> {
    const result = await this.client.callTool(params, undefined, options);
    return {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    };
  }

  async listResources(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.client.listResources(params, options);
    return { resources: result.resources ?? [], nextCursor: result.nextCursor };
  }

  async listResourceTemplates(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.client.listResourceTemplates(params, options);
    return { resourceTemplates: result.resourceTemplates ?? [], nextCursor: result.nextCursor };
  }

  async readResource(params: { uri: string }, options?: { timeout?: number }) {
    const result = await this.client.readResource(params, options);
    return { contents: result.contents ?? [] };
  }

  async subscribeResource(params: { uri: string }, options?: { timeout?: number }) {
    return this.client.subscribeResource(params, options);
  }

  async unsubscribeResource(params: { uri: string }, options?: { timeout?: number }) {
    return this.client.unsubscribeResource(params, options);
  }

  async listPrompts(params?: { cursor?: string }, options?: { timeout?: number }) {
    const result = await this.client.listPrompts(params, options);
    return { prompts: result.prompts ?? [], nextCursor: result.nextCursor };
  }

  async getPrompt(params: { name: string; arguments?: Record<string, string> }, options?: { timeout?: number }) {
    return this.client.getPrompt(params, options);
  }

  async close(): Promise<void> {
    // SDK close() 同时回收 transport（HTTP 端会发 DELETE 释放会话）。
    await this.client.close();
  }
}

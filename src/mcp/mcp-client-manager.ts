/**
 * 通用 MCP Client Manager：管理多个 MCP Server 的长连接生命周期，
 * 把远端工具以 `mcp_<serverId>_<toolName>` 注册进 ToolManager（按 diff 增量维护），
 * 并把服务端通知规范化为 McpForwardedEvent 转发给注入的 onEvent 回调。
 *
 * 与 CatsCoMcpToolBridge 的分工：
 * - CatsCoMcpToolBridge 管平台 `/api/mcp` 的 catsco_* 工具（用完即关、轮询回执）；
 * - 本类管**用户配置的任意 MCP server**（长连接、重连、事件转发），两者互不干扰。
 */
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../utils/logger';
import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import type { ContentBlock } from '../types/index';
import {
  isSameMcpServerConfig,
  loadMcpConfig,
  resolveMcpConfigPaths,
  type LoadMcpConfigOptions,
  type McpServerConfig,
} from './mcp-config';
import {
  McpPersistentClient,
  createSdkMcpConnectionFactory,
  type McpClientState,
  type McpConnection,
  type McpConnectionHooks,
  type McpReconnectOptions,
} from './mcp-persistent-client';
import {
  adaptMcpNotification,
  type McpForwardedEvent,
  type McpNotificationLike,
} from './mcp-notification-adapter';
import {
  isMrtrInputRequiredResult,
  type McpInteractionBroker,
  type MrtrInputRequiredResult,
} from './mcp-interaction-broker';
import type { McpTasksBridge, McpTaskStatusParams, McpTaskStatus } from './mcp-tasks-bridge';
import type { McpSamplingController } from './mcp-sampling-roots';
import {
  McpSecurityPolicy,
  NotificationRateLimiter,
  evaluateServerAccess,
  type McpServerRiskProfile,
} from './mcp-security-policy';

export const MCP_TOOL_NAME_PREFIX = 'mcp';

/** 注册到 ToolManager 的最小契约（与 mcp-tool-bridge 的注入点一致）。 */
export interface McpToolRegistry {
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
}

export interface McpClientManagerOptions {
  toolManager: McpToolRegistry;
  servers?: Record<string, McpServerConfig>;
  /** 连接工厂：生产默认 SDK 实现，测试注入内存实现。 */
  createConnection?: (config: McpServerConfig, hooks: McpConnectionHooks) => McpConnection;
  /** 外部事件总线回调：所有 server 的 MCP 通知都经适配层规范化后送达。 */
  onEvent?: (event: McpForwardedEvent) => void;
  /** Track 3：统一交互代理（elicitation + MRTR）。 */
  interactionBroker?: McpInteractionBroker;
  /** Track 3：tasks 桥（终态唤醒 + input_required 交接 + 轮询）。 */
  tasksBridge?: McpTasksBridge;
  /** Track 3：受控采样控制器（未提供 = 不声明 sampling 能力）。 */
  samplingController?: McpSamplingController;
  /** Track 3：roots/list 动态解析（按 serverId）。 */
  resolveRoots?: (serverId: string) => Promise<{ roots: Array<{ uri: string; name?: string }> }> | { roots: Array<{ uri: string; name?: string }> };
  /** Track 3：共享安全策略注册表（缺省 = 管理器内部自建）。 */
  securityPolicy?: McpSecurityPolicy;
  /** Track 3：通知限流参数；false = 关闭限流。 */
  notificationRateLimit?: { capacity?: number; refillPerSecond?: number } | false;
  /** Track 3：elicitation 路由解析（无上下文时由宿主推断会话）。 */
  resolveInteractionRouting?: (serverId: string) => { sessionKey: string; topic?: string } | undefined;
  reconnect?: McpReconnectOptions;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface RegisteredRemoteTool {
  serverId: string;
  remoteName: string;
  definition: ToolDefinition;
}

interface ManagedServer {
  serverId: string;
  config: McpServerConfig;
  client: McpPersistentClient;
  /** localName -> 注册信息。 */
  tools: Map<string, RegisteredRemoteTool>;
  /** listTools 刷新去重：通知风暴只触发一次在途刷新。 */
  refreshInFlight: Promise<{ registered: string[]; unregistered: string[] }> | null;
}

export interface McpServerStatus {
  serverId: string;
  transport: McpServerConfig['transport'];
  state: McpClientState;
  lastError: string | null;
  toolNames: string[];
  subscribedResourceUris: string[];
  resumption: { sessionId?: string; resumptionToken?: string };
}

export interface McpConfigWatchDiff {
  added: string[];
  updated: string[];
  removed: string[];
}

export interface McpConfigWatchOptions {
  loadOptions?: LoadMcpConfigOptions;
  /** 防抖窗口（毫秒，默认 200ms），吸收编辑器原子保存/多次 write 事件。 */
  debounceMs?: number;
  onReload?: (diff: McpConfigWatchDiff) => void;
  onError?: (error: Error) => void;
}

export class McpClientManager {
  private readonly toolManager: McpToolRegistry;
  private readonly createConnection: NonNullable<McpClientManagerOptions['createConnection']>;
  private readonly onEvent?: McpClientManagerOptions['onEvent'];
  private readonly reconnect?: McpReconnectOptions;
  private readonly requestTimeoutMs?: number;
  private readonly now?: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly random?: () => number;
  private readonly interactionBroker?: McpInteractionBroker;
  private readonly tasksBridge?: McpTasksBridge;
  private readonly samplingController?: McpSamplingController;
  private readonly resolveRoots?: McpClientManagerOptions['resolveRoots'];
  private readonly resolveInteractionRouting?: McpClientManagerOptions['resolveInteractionRouting'];
  readonly securityPolicy: McpSecurityPolicy;
  readonly rateLimiter?: NotificationRateLimiter;

  private readonly servers = new Map<string, ManagedServer>();
  /** 仅追踪由静态配置文件托管的 serverId，热重载 diff 不会误删动态挂载的 Artifact Bridge 等 server。 */
  private readonly staticServerIds = new Set<string>();
  /** 跨 server 全局工具名归属表，防止 ('a_b','c') 与 ('a','b_c') 或 foo.bar 与 foo_bar 静默覆盖。 */
  private readonly ownedToolNames = new Map<string, { serverId: string; remoteName: string }>();
  private readonly configWatchDisposers = new Set<() => void>();
  private staticSyncChain: Promise<unknown> = Promise.resolve();
  private started = false;

  constructor(options: McpClientManagerOptions) {
    this.toolManager = options.toolManager;
    this.createConnection = options.createConnection ?? createSdkMcpConnectionFactory();
    this.onEvent = options.onEvent;
    this.reconnect = options.reconnect;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.now = options.now;
    this.sleep = options.sleep;
    this.random = options.random;
    this.interactionBroker = options.interactionBroker;
    this.tasksBridge = options.tasksBridge;
    this.samplingController = options.samplingController;
    this.resolveRoots = options.resolveRoots;
    this.resolveInteractionRouting = options.resolveInteractionRouting;
    this.securityPolicy = options.securityPolicy ?? new McpSecurityPolicy();
    if (options.notificationRateLimit !== false) {
      const rl = options.notificationRateLimit ?? {};
      this.rateLimiter = new NotificationRateLimiter({
        ...(rl.capacity !== undefined ? { capacity: rl.capacity } : {}),
        ...(rl.refillPerSecond !== undefined ? { refillPerSecond: rl.refillPerSecond } : {}),
        ...(this.now ? { now: this.now } : {}),
      });
    }
    for (const [serverId, config] of Object.entries(options.servers ?? {})) {
      this.staticServerIds.add(serverId);
      this.addServer(serverId, config);
    }
  }

  /** server 配置 → 风险标记（oauth/localRoots/ownerOnly 显式声明优先）。 */
  private static riskProfileOf(config: McpServerConfig): McpServerRiskProfile {
    return {
      ...(config.oauth !== undefined ? { oauthBacked: config.oauth } : {}),
      ...(config.localRoots !== undefined ? { localRoots: config.localRoots } : {}),
      ...(config.ownerOnly !== undefined ? { ownerOnly: config.ownerOnly } : {}),
    };
  }

  /** 动态增挂一个 server（幂等：已存在则更新配置重建连接）。 */
  addServer(serverId: string, config: McpServerConfig): McpPersistentClient {
    if (this.servers.has(serverId)) {
      // 配置变化 → 重建连接（旧工具面在 removeServer 里已经注销）。
      void this.removeServer(serverId);
    }
    const managed: ManagedServer = {
      serverId,
      config,
      tools: new Map(),
      refreshInFlight: null,
      client: undefined as unknown as McpPersistentClient,
    };
    this.securityPolicy.setServerProfile(serverId, McpClientManager.riskProfileOf(config));
    managed.client = new McpPersistentClient({
      serverId,
      config,
      createConnection: this.createConnection,
      onNotification: (notification) => this.handleNotification(managed, notification),
      onStateChange: (state, info) => this.handleStateChange(managed, state, info),
      reconnect: this.reconnect,
      requestTimeoutMs: this.requestTimeoutMs,
      now: this.now,
      sleep: this.sleep,
      random: this.random,
      ...(this.interactionBroker ? {
        onElicit: async (params) => this.interactionBroker!.handleElicitRequest(
          serverId,
          params as Parameters<McpInteractionBroker['handleElicitRequest']>[1],
          this.resolveInteractionRouting?.(serverId),
        ),
      } : {}),
      ...(this.samplingController?.capable && config.allowSampling ? {
        onSamplingCreateMessage: async (params) => this.samplingController!.handleCreateMessage(
          serverId,
          params as Parameters<McpSamplingController['handleCreateMessage']>[1],
        ),
      } : {}),
      ...(this.resolveRoots ? {
        onListRoots: async () => this.resolveRoots!(serverId),
      } : {}),
    });
    this.servers.set(serverId, managed);
    if (this.started) {
      managed.client.connect().catch(() => {});
    }
    return managed.client;
  }

  /** 摘除 server：注销其全部远端工具并关闭长连接。 */
  async removeServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) return;
    // addServer 重建连接时可能先 set 了新条目再触发本次删除 —— 只在
    // 当前 map 里的仍是本实例时才删，避免误删新连接。
    if (this.servers.get(serverId) === managed) {
      this.servers.delete(serverId);
    }
    for (const localName of managed.tools.keys()) {
      const owner = this.ownedToolNames.get(localName);
      if (!owner || owner.serverId === managed.serverId) {
        this.ownedToolNames.delete(localName);
        this.toolManager.unregisterTool(localName);
      }
    }
    managed.tools.clear();
    this.securityPolicy.removeServer(managed.serverId);
    this.rateLimiter?.remove(managed.serverId);
    await managed.client.close();
  }

  /** 启动全部 server 的长连接（后台连接，失败走自动重连，不阻塞调用方）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const managed of this.servers.values()) {
      managed.client.connect().catch(() => {});
    }
  }

  /** 同步等待所有 server 首连结算（连接成功或重试耗尽）；测试/启动闸门用。 */
  async waitForInitialConnect(): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map(managed => managed.client.connect()));
  }

  getClient(serverId: string): McpPersistentClient | undefined {
    return this.servers.get(serverId)?.client;
  }

  /** server 当前生效配置（只读拷贝；Track 3 策略/事件转发层查询用）。 */
  getServerConfig(serverId: string): McpServerConfig | undefined {
    const config = this.servers.get(serverId)?.config;
    return config ? { ...config } : undefined;
  }

  /** Track 3：server 交互处理器（tasks/get 等）的窄适配。 */
  getTasksClient(serverId: string): { getTask(taskId: string): Promise<never>; getTaskResult(taskId: string): Promise<never>; cancelTask(taskId: string): Promise<never> } | undefined {
    const client = this.servers.get(serverId)?.client;
    if (!client) return undefined;
    return {
      getTask: (taskId) => client.getTask(taskId) as Promise<never>,
      getTaskResult: (taskId) => client.getTaskResult(taskId) as Promise<never>,
      cancelTask: (taskId) => client.cancelTask(taskId) as Promise<never>,
    };
  }

  serverIds(): string[] {
    return [...this.servers.keys()];
  }

  /** 本地注册名 ↔ 远端工具的反查（诊断/测试用）。 */
  getRegisteredTools(serverId?: string): RegisteredRemoteTool[] {
    const out: RegisteredRemoteTool[] = [];
    for (const managed of this.servers.values()) {
      if (serverId && managed.serverId !== serverId) continue;
      out.push(...managed.tools.values());
    }
    return out;
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map(managed => ({
      serverId: managed.serverId,
      transport: managed.config.transport,
      state: managed.client.getState(),
      lastError: managed.client.getLastError(),
      toolNames: [...managed.tools.keys()],
      subscribedResourceUris: managed.client.subscribedResourceUris(),
      resumption: managed.client.getResumptionState(),
    }));
  }

  /**
   * 按配置表增量同步静态 MCP server：
   * - 新增 server：立即建连并注册工具；
   * - 配置变更的 server：重建连接并刷新工具；
   * - 移除的静态 server：关闭连接并注销工具；
   * - 未变化的 server：保持现有长连接不断开；
   * - 动态挂载的 server（如 Per-Artifact Bridge）：完全不受影响。
   */
  syncStaticServers(nextServers: Record<string, McpServerConfig>): Promise<McpConfigWatchDiff> {
    const run = this.staticSyncChain.then(async (): Promise<McpConfigWatchDiff> => {
      const added: string[] = [];
      const updated: string[] = [];
      const removed: string[] = [];

      for (const serverId of [...this.staticServerIds]) {
        if (!Object.prototype.hasOwnProperty.call(nextServers, serverId)) {
          this.staticServerIds.delete(serverId);
          if (this.servers.has(serverId)) {
            await this.removeServer(serverId);
            removed.push(serverId);
          }
        }
      }

      for (const [serverId, config] of Object.entries(nextServers)) {
        const existing = this.servers.get(serverId);
        if (existing) {
          this.staticServerIds.add(serverId);
          if (!isSameMcpServerConfig(existing.config, config)) {
            this.addServer(serverId, config);
            updated.push(serverId);
          }
        } else {
          this.staticServerIds.add(serverId);
          this.addServer(serverId, config);
          added.push(serverId);
        }
      }

      return { added, updated, removed };
    });
    this.staticSyncChain = run.catch(() => {});
    return run;
  }

  /**
   * 监听 mcp-servers.json（所在目录）变更并自动热重载静态 server 配置。
   * - 监听父目录而非单个文件，兼容编辑器原子写入（rename）以及进程启动后新建配置文件；
   * - 文件正在写入或 JSON 损坏时保留现有连接，不误清空工具面；
   * - 返回停止监听的清理函数，且 closeAll() 时会自动清理。
   */
  watchConfig(options: McpConfigWatchOptions = {}): () => void {
    const loadOptions = options.loadOptions ?? {};
    const debounceMs = Math.max(20, options.debounceMs ?? 200);
    const { watchPaths } = resolveMcpConfigPaths(loadOptions);

    const dirToTargets = new Map<string, Set<string>>();
    for (const filePath of watchPaths) {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const set = dirToTargets.get(dir) ?? new Set<string>();
      set.add(base);
      dirToTargets.set(dir, set);
    }

    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const watchers: fs.FSWatcher[] = [];

    const triggerReload = () => {
      if (disposed) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (disposed) return;
        let nextServers: Record<string, McpServerConfig>;
        try {
          const loaded = loadMcpConfig({
            tolerateInvalidServers: true,
            ...loadOptions,
          });
          nextServers = loaded.servers;
        } catch (error: any) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        void this.syncStaticServers(nextServers)
          .then((diff) => {
            if (disposed) return;
            if (diff.added.length > 0 || diff.updated.length > 0 || diff.removed.length > 0) {
              options.onReload?.(diff);
            }
          })
          .catch((error: any) => {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          });
      }, debounceMs);
      debounceTimer.unref?.();
    };

    for (const [dir, targetNames] of dirToTargets.entries()) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
          if (disposed) return;
          if (!filename || targetNames.has(String(filename))) {
            triggerReload();
          }
        });
        watcher.on('error', (error) => {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
        watcher.unref?.();
        watchers.push(watcher);
      } catch (error: any) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // ignore close errors
        }
      }
      watchers.length = 0;
      this.configWatchDisposers.delete(dispose);
    };

    this.configWatchDisposers.add(dispose);
    return dispose;
  }

  async closeAll(): Promise<void> {
    this.started = false;
    for (const dispose of [...this.configWatchDisposers]) {
      dispose();
    }
    this.staticServerIds.clear();
    await Promise.allSettled([...this.servers.keys()].map(serverId => this.removeServer(serverId)));
  }

  // ---------------- 通知与状态 ----------------

  /** 每条通知都规范化转发给 onEvent；list_changed 额外触发增量刷新。 */
  private handleNotification(managed: ManagedServer, notification: McpNotificationLike): void {
    // Track 3：tasks/status 先走专用桥（终态唤醒 / input_required 交接），
    // 已登记的 task 不再走泛化转发，避免双重唤醒。
    if (notification.method === 'notifications/tasks/status' && this.tasksBridge) {
      const params = (notification.params ?? {}) as McpTaskStatusParams;
      if (typeof params.taskId === 'string' && typeof params.status === 'string') {
        const outcome = this.tasksBridge.handleStatusNotification(managed.serverId, params);
        if (outcome !== 'untracked') return;
      }
    }

    // Track 3：通知限流 —— 令牌桶耗尽的通知直接丢弃（高频风暴不该打爆唤醒链路）。
    if (this.rateLimiter && !this.rateLimiter.consume(managed.serverId)) {
      Logger.warning(`MCP server ${managed.serverId} 通知超限，已丢弃 (${notification.method})`);
      return;
    }

    let event: McpForwardedEvent;
    try {
      event = adaptMcpNotification(managed.serverId, notification);
    } catch (error: any) {
      Logger.warning(`MCP server ${managed.serverId} 通知适配失败: ${error?.message ?? error}`);
      return;
    }
    try {
      this.onEvent?.(event);
    } catch (error: any) {
      Logger.warning(`MCP server ${managed.serverId} 事件转发失败 (${event.method}): ${error?.message ?? error}`);
    }
    if (notification.method === 'notifications/tools/list_changed') {
      void this.refreshServerTools(managed.serverId).catch(() => {});
    }
  }

  /** 连接进入 connected（含重连成功）→ 增量刷新该 server 的工具面。 */
  private handleStateChange(managed: ManagedServer, state: McpClientState, info: { attempt: number; error?: string }): void {
    if (state === 'connected') {
      void this.refreshServerTools(managed.serverId).catch(() => {});
      return;
    }
    if (state === 'failed') {
      Logger.warning(`MCP server ${managed.serverId} 连接失败（第 ${info.attempt} 次尝试后放弃）: ${info.error ?? '未知错误'}`);
    }
  }

  /**
   * 同步远端工具清单：新增注册、下线注销、定义变化时替换。
   * 按 server 去重 —— tools/list_changed 通知风暴只触发一次在途刷新。
   */
  async refreshServerTools(serverId: string): Promise<{ registered: string[]; unregistered: string[] }> {
    const managed = this.servers.get(serverId);
    if (!managed) return { registered: [], unregistered: [] };
    if (managed.refreshInFlight) return managed.refreshInFlight;
    const run = this.doRefreshServerTools(managed).finally(() => {
      managed.refreshInFlight = null;
    });
    managed.refreshInFlight = run;
    return run;
  }

  private async doRefreshServerTools(managed: ManagedServer): Promise<{ registered: string[]; unregistered: string[] }> {
    const infos = await managed.client.listAllTools();
    // 若刷新在途期间该 server 已被 remove 或被新实例替换，放弃写入，避免把已关闭客户端的工具重新注册进去。
    if (this.servers.get(managed.serverId) !== managed) {
      return { registered: [], unregistered: [] };
    }
    const seen = new Set<string>();
    const registered: string[] = [];
    const unregistered: string[] = [];

    // 先统计同批次内的基础名碰撞（例如同一 server 同时暴露 foo.bar 与 foo_bar）：
    // 若多条远端工具折叠到同一基础名，只有无需字符折叠的原名可保留基础名，其余追加确定性哈希后缀。
    const baseNameCounts = new Map<string, number>();
    for (const info of infos) {
      if (!info?.name) continue;
      const base = mcpToolName(managed.serverId, info.name);
      baseNameCounts.set(base, (baseNameCounts.get(base) ?? 0) + 1);
    }

    const batchClaimed = new Set<string>();
    for (const info of infos) {
      if (!info?.name) continue;
      const baseName = mcpToolName(managed.serverId, info.name);
      const owner = this.ownedToolNames.get(baseName);
      const crossServerConflict = Boolean(
        owner && (owner.serverId !== managed.serverId || owner.remoteName !== info.name),
      );
      const intraBatchConflict = (baseNameCounts.get(baseName) ?? 0) > 1
        && (batchClaimed.has(baseName) || /[^A-Za-z0-9_-]/.test(info.name));
      const localName = (crossServerConflict || intraBatchConflict)
        ? disambiguatedMcpToolName(managed.serverId, info.name)
        : baseName;
      batchClaimed.add(localName);
      seen.add(localName);
      const definition: ToolDefinition = {
        name: localName,
        description: info.description?.trim() || `MCP 远端工具 ${managed.serverId}/${info.name}`,
        parameters: toToolParameters(info.inputSchema),
      };
      const existing = managed.tools.get(localName);
      if (existing && existing.remoteName === info.name && sameDefinition(existing.definition, definition)) {
        this.ownedToolNames.set(localName, { serverId: managed.serverId, remoteName: info.name });
        continue;
      }
      managed.tools.set(localName, { serverId: managed.serverId, remoteName: info.name, definition });
      this.ownedToolNames.set(localName, { serverId: managed.serverId, remoteName: info.name });
      this.toolManager.registerTool(this.createRemoteTool(managed, localName, info.name, definition));
      registered.push(localName);
    }

    for (const localName of [...managed.tools.keys()]) {
      if (seen.has(localName)) continue;
      const owner = this.ownedToolNames.get(localName);
      if (!owner || owner.serverId === managed.serverId) {
        this.ownedToolNames.delete(localName);
        this.toolManager.unregisterTool(localName);
      }
      managed.tools.delete(localName);
      unregistered.push(localName);
    }

    if (registered.length > 0 || unregistered.length > 0) {
      Logger.info(`MCP server ${managed.serverId} 工具面已同步: +[${registered.join(',')}] -[${unregistered.join(',')}]`);
    }
    return { registered, unregistered };
  }

  private createRemoteTool(managed: ManagedServer, _localName: string, remoteName: string, definition: ToolDefinition): Tool {
    return {
      definition,
      execute: (args: unknown, context?: ToolExecutionContext) =>
        this.executeRemoteTool(managed, remoteName, args, context),
    };
  }

  /** 调用远端工具并把多模态结果映射回 ToolExecutionResult。 */
  async executeRemoteTool(
    managed: ManagedServer,
    remoteName: string,
    args: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    // Track 3：群聊/私聊隔离 —— ownerOnly server（OAuth/本地 roots）在群聊中非主人触发即拒。
    const scope = context?.executionScope;
    if (scope) {
      const decision = evaluateServerAccess(this.securityPolicy.getServerProfile(managed.serverId), {
        topicType: scope.topicType,
        actorUserId: scope.actorUserId,
        ownerUserId: scope.deviceOwnerUserId ?? scope.actorUserId,
        sessionKey: scope.sessionKey,
      });
      if (!decision.allowed) {
        return {
          ok: false,
          errorCode: decision.code,
          message: decision.reason,
        };
      }
    }

    const callArgs = args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : { input: args };
    try {
      const result = await managed.client.callTool(remoteName, callArgs);

      // Track 3：MRTR —— input_required 结果挂起，走统一交互代理收集输入后重试。
      const inputRequired = extractInputRequiredResult(result);
      if (inputRequired && this.interactionBroker) {
        const sessionKey = scope?.sessionKey ?? this.resolveInteractionRouting?.(managed.serverId)?.sessionKey;
        if (!sessionKey) {
          return {
            ok: false,
            errorCode: 'mcp_input_unroutable',
            message: `MCP 工具 ${remoteName} 需要用户输入，但无法定位会话（缺少 ExecutionScope）`,
          };
        }
        const outcome = await this.interactionBroker.runMrtrLoop({
          serverId: managed.serverId,
          sessionKey,
          ...(scope?.topicId ? { topic: scope.topicId } : {}),
          initialResult: inputRequired,
          retry: async (inputResponses, requestState) => {
            const retryResult = await managed.client.callTool(remoteName, {
              ...callArgs,
              requestState,
              inputResponses,
            });
            return extractInputRequiredResult(retryResult) ?? retryResult;
          },
        });
        if (outcome.kind === 'result') {
          const finalResult = outcome.result as McpCallToolResultShape;
          const content = mapCallResultContent(finalResult?.content, finalResult?.structuredContent);
          return { ok: true, content };
        }
        const cancelReason = outcome.reason === 'timeout' ? '等待输入超时'
          : outcome.reason === 'max_rounds' ? '交互轮数超限'
          : '用户取消或拒绝';
        return {
          ok: false,
          errorCode: 'mcp_input_cancelled',
          message: `MCP 工具 ${remoteName} 的输入交互未完成（${cancelReason}），操作未执行。`,
        };
      }

      const content = mapCallResultContent(result.content, result.structuredContent);
      if (result.isError) {
        return {
          ok: false,
          errorCode: 'mcp_tool_error',
          message: typeof content === 'string' ? content || `MCP 工具 ${remoteName} 返回错误` : contentToText(content),
        };
      }
      return { ok: true, content };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'mcp_unreachable',
        message: `调用 MCP server ${managed.serverId} 失败: ${error?.message ?? error}`,
        retryable: true,
      };
    }
  }

  /** Track 3：登记 task 路由（宿主发起任务型调用后调用）。 */
  trackTask(args: {
    serverId: string;
    taskId: string;
    sessionKey: string;
    topic?: string;
    actorUserId?: string;
  }): (() => void) | undefined {
    return this.tasksBridge?.trackTask(args);
  }

  /** Track 3：干净取消 task。 */
  async cancelTask(serverId: string, taskId: string): Promise<boolean> {
    return this.tasksBridge?.cancelTask(serverId, taskId) ?? false;
  }
}

// ---------------- 命名与结果映射 ----------------

/** tools/call 结果的宽松形状（含 MRTR 扩展字段位）。 */
interface McpCallToolResultShape {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: unknown;
  requestState?: unknown;
  inputRequests?: unknown;
}

/**
 * MRTR input_required 提取：server 可能把结果放在顶层，也可能放在
 * structuredContent 里（SDK schema 宽松透传）。两处都查。
 */
export function extractInputRequiredResult(result: unknown): MrtrInputRequiredResult | undefined {
  if (isMrtrInputRequiredResult(result)) return result;
  const structured = (result as McpCallToolResultShape | undefined)?.structuredContent;
  if (isMrtrInputRequiredResult(structured)) return structured;
  return undefined;
}

const MAX_MCP_TOOL_NAME_LENGTH = 64;

/**
 * `mcp_<serverId>_<toolName>`：远端名里的非法字符折叠为下划线。
 * - 超过 64 字符（OpenAI / Anthropic 等 provider 的工具名上限）时截断并追加 8 位 sha256 哈希后缀，
 *   同时保证不同 `(serverId, remoteName)` 不会在折叠或截断后碰撞。
 */
export function mcpToolName(serverId: string, remoteName: string): string {
  const normalized = remoteName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{2,}/g, '_');
  const full = `${MCP_TOOL_NAME_PREFIX}_${serverId}_${normalized}`;
  if (full.length <= MAX_MCP_TOOL_NAME_LENGTH) {
    return full;
  }
  return disambiguatedMcpToolName(serverId, remoteName);
}

/**
 * 碰撞消歧或超长截断时使用：始终附带基于原始 `(serverId, remoteName)` 的 8 位 sha256 哈希，
 * 保证长度 <= 64 且不同 `(serverId, remoteName)` 不会静默互相覆盖。
 */
export function disambiguatedMcpToolName(serverId: string, remoteName: string): string {
  const normalized = remoteName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{2,}/g, '_');
  const full = `${MCP_TOOL_NAME_PREFIX}_${serverId}_${normalized}`;
  const hash = crypto.createHash('sha256').update(`${serverId}\0${remoteName}`).digest('hex').slice(0, 8);
  const maxPrefixLen = MAX_MCP_TOOL_NAME_LENGTH - 1 - hash.length;
  const truncated = full.slice(0, maxPrefixLen).replace(/_+$/, '');
  return `${truncated}_${hash}`;
}

/**
 * MCP tools/call 的 content blocks → ToolExecutionResult.content。
 *
 * 本地 ContentBlock 只有 text/image 两种；text 全保留，image 在受支持的
 * mimeType 下转本地图片块，audio / resource / resource_link / 未知块全部
 * 序列化成 JSON 文本块 —— 多模态与结构化结果不丢信息。
 */
export function mapCallResultContent(content: unknown, structuredContent?: unknown): string | ContentBlock[] {
  const blocks = Array.isArray(content) ? content : [];
  const textParts: string[] = [];
  const out: ContentBlock[] = [];
  let hasRichBlock = false;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      const text = (block as { text: string }).text;
      textParts.push(text);
      out.push({ type: 'text', text });
      continue;
    }
    if (type === 'image' && typeof (block as { data?: unknown }).data === 'string') {
      const mimeType = typeof (block as { mimeType?: unknown }).mimeType === 'string'
        ? (block as { mimeType: string }).mimeType
        : 'image/png';
      const mediaType = toLocalMediaType(mimeType);
      if (mediaType) {
        hasRichBlock = true;
        out.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: (block as { data: string }).data } });
        continue;
      }
    }
    // audio / resource / resource_link / 未知块：完整 JSON 保真。
    hasRichBlock = true;
    out.push({ type: 'text', text: `[mcp ${String(type ?? 'unknown')} block] ${safeJson(block)}` });
  }

  if (structuredContent !== undefined && structuredContent !== null) {
    hasRichBlock = true;
    out.push({ type: 'text', text: `[mcp structuredContent] ${safeJson(structuredContent)}` });
  }

  // 纯文本（没有图片/结构化块）时退化为字符串，与既有工具结果习惯一致。
  if (!hasRichBlock) return textParts.join('\n');
  return out;
}

function contentToText(blocks: ContentBlock[]): string {
  return blocks
    .map(block => (block.type === 'text' ? block.text : `[image ${block.source.media_type}]`))
    .join('\n');
}

const LOCAL_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function toLocalMediaType(mimeType: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  return LOCAL_IMAGE_MEDIA_TYPES.has(mimeType)
    ? (mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
    : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 远端 inputSchema → 本地 ToolParameter（与 mcp-tool-bridge 相同的收敛策略）。 */
export function toToolParameters(schema: unknown): ToolDefinition['parameters'] {
  const root = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : {};
  const rawProps = root.properties && typeof root.properties === 'object' && !Array.isArray(root.properties)
    ? (root.properties as Record<string, unknown>)
    : {};
  const properties: ToolDefinition['parameters']['properties'] = {};
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

function sanitizeParameter(raw: unknown): import('../types/tool').ToolParameter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: import('../types/tool').ToolParameter = { type: typeof src.type === 'string' ? src.type : 'object' };
  if (typeof src.description === 'string' && src.description.length > 0) out.description = src.description;
  if (Array.isArray(src.enum)) {
    const values = src.enum.filter((item): item is string => typeof item === 'string');
    if (values.length > 0) out.enum = values;
  }
  if (src.default !== undefined) out.default = src.default;
  if (src.properties && typeof src.properties === 'object' && !Array.isArray(src.properties)) {
    const nested: Record<string, import('../types/tool').ToolParameter> = {};
    for (const [key, value] of Object.entries(src.properties as Record<string, unknown>)) {
      const mapped = sanitizeParameter(value);
      if (mapped) nested[key] = mapped;
    }
    out.properties = nested;
  }
  if (src.items !== undefined) {
    const mapped = sanitizeParameter(src.items);
    if (mapped) out.items = mapped;
  }
  return out;
}

function sameDefinition(left: ToolDefinition, right: ToolDefinition): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    JSON.stringify(left.parameters) === JSON.stringify(right.parameters)
  );
}

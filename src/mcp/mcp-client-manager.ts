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
import { Logger } from '../utils/logger';
import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import type { ContentBlock } from '../types/index';
import type { McpServerConfig } from './mcp-config';
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

export class McpClientManager {
  private readonly toolManager: McpToolRegistry;
  private readonly createConnection: NonNullable<McpClientManagerOptions['createConnection']>;
  private readonly onEvent?: McpClientManagerOptions['onEvent'];
  private readonly reconnect?: McpReconnectOptions;
  private readonly requestTimeoutMs?: number;
  private readonly now?: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly random?: () => number;

  private readonly servers = new Map<string, ManagedServer>();
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
    for (const [serverId, config] of Object.entries(options.servers ?? {})) {
      this.addServer(serverId, config);
    }
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
      this.toolManager.unregisterTool(localName);
    }
    managed.tools.clear();
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

  async closeAll(): Promise<void> {
    this.started = false;
    await Promise.allSettled([...this.servers.keys()].map(serverId => this.removeServer(serverId)));
  }

  // ---------------- 通知与状态 ----------------

  /** 每条通知都规范化转发给 onEvent；list_changed 额外触发增量刷新。 */
  private handleNotification(managed: ManagedServer, notification: McpNotificationLike): void {
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

    for (const info of infos) {
      if (!info?.name) continue;
      const localName = mcpToolName(managed.serverId, info.name);
      seen.add(localName);
      const definition: ToolDefinition = {
        name: localName,
        description: info.description?.trim() || `MCP 远端工具 ${managed.serverId}/${info.name}`,
        parameters: toToolParameters(info.inputSchema),
      };
      const existing = managed.tools.get(localName);
      if (existing && existing.remoteName === info.name && sameDefinition(existing.definition, definition)) {
        continue;
      }
      managed.tools.set(localName, { serverId: managed.serverId, remoteName: info.name, definition });
      this.toolManager.registerTool(this.createRemoteTool(managed, localName, info.name, definition));
      registered.push(localName);
    }

    for (const localName of [...managed.tools.keys()]) {
      if (seen.has(localName)) continue;
      this.toolManager.unregisterTool(localName);
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
      execute: (args: unknown, _context?: ToolExecutionContext) =>
        this.executeRemoteTool(managed, remoteName, args),
    };
  }

  /** 调用远端工具并把多模态结果映射回 ToolExecutionResult。 */
  async executeRemoteTool(managed: ManagedServer, remoteName: string, args: unknown): Promise<ToolExecutionResult> {
    const callArgs = args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : { input: args };
    try {
      const result = await managed.client.callTool(remoteName, callArgs);
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
}

// ---------------- 命名与结果映射 ----------------

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

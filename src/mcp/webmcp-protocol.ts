/**
 * WebMCP Artifact 代理协议（Browser Shim ↔ Server Relay）。
 *
 * 将浏览器内标准 `navigator.modelContext`（WebMCP）工具注册与调用，
 * 通过轻量级 JSON 消息协议桥接到服务端 `WebMcpRelay`，再由 Relay
 * 暴露为标准 Streamable HTTP MCP 端点挂入 `ArtifactMcpRegistry`。
 */

export const WEBMCP_RELAY_PROTOCOL_VERSION = '2026-03-webmcp-relay-v1';
export const MAX_WEBMCP_TOOLS_PER_ARTIFACT = 64;
export const MAX_WEBMCP_PAYLOAD_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_WEBMCP_TOOL_CALL_TIMEOUT_MS = 15_000;
export const DEFAULT_WEBMCP_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2h

const TOOL_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * 浏览器侧通过 `navigator.modelContext.registerTool` / `provideContext` 注册的工具元数据。
 * 不包含 `execute` 函数体，仅保留可序列化的 schema 与注解。
 */
export interface WebMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
}

/** 浏览器侧工具定义（含本地执行回调）。 */
export interface WebMcpToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute: (input: Record<string, unknown>, client?: unknown) => unknown | Promise<unknown>;
}

/** W3C WebMCP `navigator.modelContext` 兼容接口。 */
export interface WebMcpModelContext {
  registerTool(tool: WebMcpToolDefinition): void;
  unregisterTool(name: string): void;
  provideContext(context?: { tools?: WebMcpToolDefinition[] }): void;
  clearContext(): void;
}

// ---------------- Wire Messages: Browser → Relay ----------------

export interface WebMcpHelloMessage {
  type: 'hello';
  protocolVersion?: string;
  artifactId?: string;
  pageUrl?: string;
  title?: string;
  clientId?: string;
}

export interface WebMcpToolsSyncMessage {
  type: 'tools_sync';
  tools: WebMcpToolDescriptor[];
}

export interface WebMcpToolResultMessage {
  type: 'tool_result';
  callId: string;
  result?: unknown;
  isError?: boolean;
  error?: {
    code?: string;
    message: string;
  };
}

export interface WebMcpPongMessage {
  type: 'pong';
  ts?: number;
}

export type WebMcpClientMessage =
  | WebMcpHelloMessage
  | WebMcpToolsSyncMessage
  | WebMcpToolResultMessage
  | WebMcpPongMessage;

// ---------------- Wire Messages: Relay → Browser ----------------

export interface WebMcpWelcomeMessage {
  type: 'welcome';
  protocolVersion: string;
  artifactId: string;
  serverId: string;
  sessionBound: boolean;
}

export interface WebMcpToolCallMessage {
  type: 'tool_call';
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}

export interface WebMcpPingMessage {
  type: 'ping';
  ts: number;
}

export interface WebMcpErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type WebMcpServerMessage =
  | WebMcpWelcomeMessage
  | WebMcpToolCallMessage
  | WebMcpPingMessage
  | WebMcpErrorMessage;

// ---------------- Normalization & Formatting ----------------

export interface McpContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpCallToolWireResult {
  content: McpContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * 校验并规范化单条 WebMCP 工具描述；非法工具返回 null（调用方决定跳过或报错）。
 */
export function normalizeWebMcpToolDescriptor(raw: unknown): WebMcpToolDescriptor | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name || !TOOL_NAME_RE.test(name)) return null;

  const description = typeof record.description === 'string'
    ? record.description.trim().slice(0, 2000)
    : '';

  let inputSchema: Record<string, unknown>;
  if (record.inputSchema && typeof record.inputSchema === 'object' && !Array.isArray(record.inputSchema)) {
    inputSchema = { ...(record.inputSchema as Record<string, unknown>) };
    if (typeof inputSchema.type !== 'string') {
      inputSchema.type = 'object';
    }
  } else {
    inputSchema = { type: 'object', properties: {} };
  }

  let annotations: WebMcpToolAnnotations | undefined;
  if (record.annotations && typeof record.annotations === 'object' && !Array.isArray(record.annotations)) {
    const a = record.annotations as Record<string, unknown>;
    const cleaned: WebMcpToolAnnotations = {};
    if (typeof a.readOnlyHint === 'boolean') cleaned.readOnlyHint = a.readOnlyHint;
    if (typeof a.destructiveHint === 'boolean') cleaned.destructiveHint = a.destructiveHint;
    if (typeof a.idempotentHint === 'boolean') cleaned.idempotentHint = a.idempotentHint;
    if (typeof a.openWorldHint === 'boolean') cleaned.openWorldHint = a.openWorldHint;
    if (Object.keys(cleaned).length > 0) annotations = cleaned;
  }

  return {
    name,
    description: description || `WebMCP tool ${name}`,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  };
}

/**
 * 规范化整批工具清单：去重（后者覆盖前者）、过滤非法项、限制最大数量。
 */
export function normalizeWebMcpToolList(rawTools: unknown): WebMcpToolDescriptor[] {
  if (!Array.isArray(rawTools)) return [];
  const byName = new Map<string, WebMcpToolDescriptor>();
  for (const item of rawTools) {
    const normalized = normalizeWebMcpToolDescriptor(item);
    if (!normalized) continue;
    byName.set(normalized.name, normalized);
    if (byName.size >= MAX_WEBMCP_TOOLS_PER_ARTIFACT) break;
  }
  return [...byName.values()];
}

/**
 * 将浏览器 `execute(args)` 的任意返回值转换为合法的 MCP `CallToolResult`。
 */
export function formatWebMcpToolResult(
  result: unknown,
  isError?: boolean,
  error?: { code?: string; message?: string },
): McpCallToolWireResult {
  if (isError || error) {
    const code = error?.code ? `[${error.code}] ` : '';
    const message = error?.message || (typeof result === 'string' ? result : 'WebMCP tool execution failed');
    return {
      isError: true,
      content: [{ type: 'text', text: `${code}${message}` }],
    };
  }

  // 如果页面工具直接返回了标准 MCP content 结构，则原样透传（仅做基本校验）。
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content) && record.content.every(isMcpContentBlock)) {
      return {
        content: record.content as McpContentBlock[],
        ...(record.isError === true ? { isError: true } : {}),
        ...(record.structuredContent && typeof record.structuredContent === 'object' && !Array.isArray(record.structuredContent)
          ? { structuredContent: record.structuredContent as Record<string, unknown> }
          : {}),
      };
    }
    try {
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: record,
      };
    } catch {
      return { content: [{ type: 'text', text: String(result) }] };
    }
  }

  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }
  if (result === undefined || result === null) {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  try {
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch {
    return { content: [{ type: 'text', text: String(result) }] };
  }
}

function isMcpContentBlock(value: unknown): value is McpContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  return type === 'text' || type === 'image' || type === 'resource';
}

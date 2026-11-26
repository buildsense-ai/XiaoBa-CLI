/**
 * WebMCP Artifact Relay Server（生产 CatsCo `artifact_webmcp` 双向传输模式）。
 *
 * 架构职责：
 * - 按 `bridge_id`（每个在线 Artifact 页面连接独立建槽，绝不按 `artifactId` 合并），
 *   为每个活跃页面暴露独立的本机 loopback Streamable HTTP + SSE MCP 端点：
 *     POST/GET/DELETE http://127.0.0.1:<port>/mcp/<bridgeId>
 *   并挂载到 `ArtifactMcpRegistry` → `McpClientManager`。
 * - 携带会话作用域（`sessionKey` + `topic`）完成注册，防止多用户打开同一 Artifact 时工具串台；
 *   单个用户页面 `detach` 仅卸载其对应的 `bridge_id`，不影响其他用户的在线页面。
 * - 工具描述与执行结果统一由 `webmcp-protocol.ts` 标注 untrusted content 边界。
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  artifactServerId,
  type ArtifactMcpBridgeSink,
} from './artifact-mcp-registry';
import {
  DEFAULT_WEBMCP_TOOL_CALL_TIMEOUT_MS,
  MAX_WEBMCP_PAYLOAD_BYTES,
  formatWebMcpToolResult,
  labelUntrustedWebMcpDescription,
  normalizeWebMcpToolList,
  type McpCallToolWireResult,
  type WebMcpToolDescriptor,
} from './webmcp-protocol';

const MCP_PROTOCOL_VERSION = '2025-11-25';

export interface WebMcpRemoteToolCallRequest {
  bridgeId: string;
  artifactId: string;
  topic?: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface WebMcpRelayOptions {
  /** 本机监听地址，默认 127.0.0.1。 */
  host?: string;
  /** 本机监听端口，0 表示系统分配随机空闲端口。 */
  port?: number;
  /** 动态挂入 McpClientManager 的注册器（默认不自动挂载，测试/生产传入 artifactMcpRegistry）。 */
  bridgeSink?: ArtifactMcpBridgeSink;
  /** 浏览器侧工具调用超时（毫秒），默认 15s。 */
  toolCallTimeoutMs?: number;
  /**
   * 通过 CatsCo WebSocket (`artifact_webmcp` `tool_call`) 将工具调用转发给远端 Gateway iframe。
   * 返回 false 表示当前 WS 不可用，立即返回 `page_not_open`。
   */
  onRemoteToolCall?: (request: WebMcpRemoteToolCallRequest) => boolean | Promise<boolean>;
}

export interface WebMcpSessionSummary {
  bridgeId: string;
  artifactId: string;
  registrationId: string;
  serverId: string;
  connected: boolean;
  attached: boolean;
  toolCount: number;
  toolNames: string[];
  sessionKey?: string;
  topic?: string;
  actorUserId?: string;
  connectedAt?: string;
  lastSeenAt?: string;
}

interface PendingToolCall {
  callId: string;
  toolName: string;
  resolve: (result: McpCallToolWireResult) => void;
  timer: NodeJS.Timeout;
}

interface BridgeRelayState {
  bridgeId: string;
  artifactId: string;
  /** 注册到 ArtifactMcpRegistry 的唯一 key（每个 bridge_id 独立，杜绝跨用户碰撞）。 */
  registrationId: string;
  serverId: string;
  mcpBearerToken: string;
  sessionKey?: string;
  topic?: string;
  actorUserId?: string;
  tools: WebMcpToolDescriptor[];
  attached: boolean;
  connectedAt: string;
  lastSeenAt: string;
  pendingCalls: Map<string, PendingToolCall>;
  sseStreams: Set<ServerResponse>;
}

function areToolListsEqual(a: WebMcpToolDescriptor[], b: WebMcpToolDescriptor[]): boolean {
  if (a.length !== b.length) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function timingSafeBearerMatch(headerValue: string | undefined, expectedToken: string): boolean {
  if (!headerValue) return false;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const actual = Buffer.from(match[1].trim(), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function readJsonBody(req: IncomingMessage, maxBytes = MAX_WEBMCP_PAYLOAD_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

function makeRegistrationId(artifactId: string, bridgeId: string): string {
  const safeArtifact = artifactId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 24) || 'app';
  const safeBridge = bridgeId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 32) || 'bridge';
  return `${safeArtifact}_${safeBridge}`;
}

export class WebMcpRelay {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly bridgeSink?: ArtifactMcpBridgeSink;
  private readonly toolCallTimeoutMs: number;
  private readonly onRemoteToolCall?: (request: WebMcpRemoteToolCallRequest) => boolean | Promise<boolean>;

  private httpServer: http.Server | null = null;
  private boundPort = 0;
  private stopped = false;

  /** Keyed strictly by bridgeId so concurrent users opening the same artifact never collide. */
  private readonly bridges = new Map<string, BridgeRelayState>();

  constructor(options: WebMcpRelayOptions = {}) {
    this.host = options.host || '127.0.0.1';
    this.requestedPort = typeof options.port === 'number' && options.port >= 0 ? Math.floor(options.port) : 0;
    this.bridgeSink = options.bridgeSink;
    this.toolCallTimeoutMs = Math.max(
      100,
      options.toolCallTimeoutMs ?? DEFAULT_WEBMCP_TOOL_CALL_TIMEOUT_MS,
    );
    this.onRemoteToolCall = options.onRemoteToolCall;
  }

  get port(): number {
    return this.boundPort;
  }

  get baseHttpUrl(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    this.stopped = false;

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res).catch(() => {
        if (!res.headersSent) {
          writeJson(res, 500, { error: 'internal_error' });
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.httpServer = server;
    this.boundPort = (server.address() as AddressInfo).port;
  }

  listSessions(): WebMcpSessionSummary[] {
    return [...this.bridges.values()].map((state) => ({
      bridgeId: state.bridgeId,
      artifactId: state.artifactId,
      registrationId: state.registrationId,
      serverId: state.serverId,
      connected: true,
      attached: state.attached,
      toolCount: state.tools.length,
      toolNames: state.tools.map((t) => t.name),
      ...(state.sessionKey ? { sessionKey: state.sessionKey } : {}),
      ...(state.topic ? { topic: state.topic } : {}),
      ...(state.actorUserId ? { actorUserId: state.actorUserId } : {}),
      connectedAt: state.connectedAt,
      lastSeenAt: state.lastSeenAt,
    }));
  }

  /**
   * 接收经 CatsCo WebSocket 转发的 `tools_sync`：
   * 按 `bridgeId` 独立建槽并挂载到 `ArtifactMcpRegistry`，携带 `sessionKey`/`topic`/`actorUserId` 作用域。
   */
  async handleRemoteToolsSync(input: {
    bridgeId: string;
    artifactId: string;
    topic?: string;
    sessionKey?: string;
    actorUserId?: string;
    tools: unknown[];
  }): Promise<void> {
    if (this.stopped) return;
    const bridgeId = String(input.bridgeId ?? '').trim();
    const artifactId = String(input.artifactId ?? '').trim();
    if (!bridgeId || !artifactId) return;

    const sessionKey = typeof input.sessionKey === 'string' && input.sessionKey.trim()
      ? input.sessionKey.trim()
      : undefined;
    const topic = typeof input.topic === 'string' && input.topic.trim()
      ? input.topic.trim()
      : undefined;
    const actorUserId = typeof input.actorUserId === 'string' && input.actorUserId.trim()
      ? input.actorUserId.trim()
      : undefined;

    const now = new Date().toISOString();
    let state = this.bridges.get(bridgeId);
    if (!state) {
      const registrationId = makeRegistrationId(artifactId, bridgeId);
      state = {
        bridgeId,
        artifactId,
        registrationId,
        serverId: artifactServerId(registrationId),
        mcpBearerToken: crypto.randomBytes(24).toString('hex'),
        sessionKey,
        topic,
        actorUserId,
        tools: [],
        attached: false,
        connectedAt: now,
        lastSeenAt: now,
        pendingCalls: new Map(),
        sseStreams: new Set(),
      };
      this.bridges.set(bridgeId, state);
    } else {
      state.lastSeenAt = now;
      if (sessionKey && !state.sessionKey) state.sessionKey = sessionKey;
      if (topic && !state.topic) state.topic = topic;
      if (actorUserId && !state.actorUserId) state.actorUserId = actorUserId;
    }

    const nextTools = normalizeWebMcpToolList(input.tools);
    const changed = !areToolListsEqual(state.tools, nextTools);
    state.tools = nextTools;

    if (!state.attached && nextTools.length > 0 && this.bridgeSink) {
      try {
        await Promise.resolve(this.bridgeSink.registerArtifactBridge({
          artifactId: state.registrationId,
          url: `${this.baseHttpUrl}/mcp/${encodeURIComponent(state.bridgeId)}`,
          bearerToken: state.mcpBearerToken,
          ...(state.sessionKey
            ? {
                sessionKey: state.sessionKey,
                ...(state.topic ? { topic: state.topic } : {}),
              }
            : {}),
          ...(state.actorUserId ? { actorUserId: state.actorUserId } : {}),
        }));
        state.attached = true;
      } catch {
        // 挂载失败时不崩溃，后续 tools_sync 可继续重试。
      }
    } else if (changed && state.attached) {
      this.broadcastToolsListChanged(state);
    }
  }

  /** 接收经 CatsCo WebSocket 转发的 `tool_result`。 */
  handleRemoteToolResult(input: {
    bridgeId: string;
    callId: string;
    isError?: boolean;
    content?: unknown;
    structuredContent?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  }): void {
    const bridgeId = String(input.bridgeId ?? '').trim();
    const callId = String(input.callId ?? '').trim();
    if (!bridgeId || !callId) return;
    const state = this.bridges.get(bridgeId);
    if (!state) return;

    state.lastSeenAt = new Date().toISOString();
    const pending = state.pendingCalls.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingCalls.delete(callId);

    const rawResult = input.content !== undefined
      ? {
          content: input.content,
          isError: input.isError === true,
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }
      : undefined;
    pending.resolve(
      formatWebMcpToolResult(rawResult, input.isError === true, input.error, {
        artifactId: state.artifactId,
        toolName: pending.toolName,
      }),
    );
  }

  /** 接收经 CatsCo WebSocket 转发的 `detach`：仅卸载对应 `bridgeId`，不影响其他用户的连接。 */
  async handleRemoteDetach(input: { bridgeId: string; reason?: string }): Promise<void> {
    const bridgeId = String(input.bridgeId ?? '').trim();
    if (!bridgeId) return;
    const state = this.bridges.get(bridgeId);
    if (!state) return;

    this.bridges.delete(bridgeId);
    this.rejectPendingCalls(state, 'page_not_open', input.reason || 'Artifact page detached');
    for (const stream of state.sseStreams) {
      try { stream.end(); } catch { /* ignore */ }
    }
    state.sseStreams.clear();
    if (state.attached && this.bridgeSink) {
      await Promise.resolve(
        this.bridgeSink.unregisterArtifactBridge(state.registrationId, { unbindSession: true }),
      ).catch(() => {});
      state.attached = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const bridgeIds = [...this.bridges.keys()];
    await Promise.allSettled(
      bridgeIds.map((bridgeId) => this.handleRemoteDetach({ bridgeId, reason: 'relay_stopped' })),
    );

    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // ---------------- Loopback Streamable HTTP MCP Endpoint ----------------

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', this.baseHttpUrl);
    const pathname = url.pathname;

    if (pathname === '/health' && method === 'GET') {
      writeJson(res, 200, { ok: true, sessions: this.bridges.size });
      return;
    }

    const mcpMatch = pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcpMatch) {
      const bridgeId = decodeURIComponent(mcpMatch[1]);
      const state = this.bridges.get(bridgeId);
      if (!state) {
        writeJson(res, 404, { error: 'unknown_bridge' });
        return;
      }
      if (!timingSafeBearerMatch(req.headers.authorization, state.mcpBearerToken)) {
        writeJson(res, 401, { error: 'unauthorized' });
        return;
      }
      await this.handleMcpEndpoint(req, res, state);
      return;
    }

    writeJson(res, 404, { error: 'not_found' });
  }

  private async handleMcpEndpoint(
    req: IncomingMessage,
    res: ServerResponse,
    state: BridgeRelayState,
  ): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(': webmcp-relay-sse-open\n\n');
      state.sseStreams.add(res);
      req.on('close', () => {
        state.sseStreams.delete(res);
      });
      return;
    }

    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err: any) {
      writeJson(res, err?.message === 'payload_too_large' ? 413 : 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }

    const rpc = body as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    const hasId = Object.prototype.hasOwnProperty.call(rpc, 'id') && rpc.id !== undefined;
    const rpcMethod = typeof rpc.method === 'string' ? rpc.method : '';

    if (!hasId) {
      res.writeHead(202);
      res.end();
      return;
    }

    if (rpcMethod === 'initialize') {
      writeJson(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: true },
          },
          serverInfo: {
            name: `xiaoba-webmcp-${state.artifactId}`,
            version: '1.0.0',
          },
        },
      });
      return;
    }

    if (rpcMethod === 'ping') {
      writeJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: {} });
      return;
    }

    if (rpcMethod === 'tools/list') {
      const tools = state.tools.map((t) => ({
        name: t.name,
        description: labelUntrustedWebMcpDescription(t.description, state.artifactId),
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      writeJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools } });
      return;
    }

    if (rpcMethod === 'tools/call') {
      const params = rpc.params && typeof rpc.params === 'object' ? rpc.params : {};
      const toolName = typeof params.name === 'string' ? params.name.trim() : '';
      const toolArgs = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      if (!toolName) {
        writeJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32602, message: 'Missing tool name' },
        });
        return;
      }
      const result = await this.invokeRemoteTool(state, toolName, toolArgs);
      writeJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
      return;
    }

    writeJson(res, 200, {
      jsonrpc: '2.0',
      id: rpc.id,
      error: { code: -32601, message: `Method not found: ${rpcMethod}` },
    });
  }

  private async invokeRemoteTool(
    state: BridgeRelayState,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolWireResult> {
    const ctx = { artifactId: state.artifactId, toolName: name };
    if (!this.bridges.has(state.bridgeId) || !this.onRemoteToolCall) {
      return formatWebMcpToolResult(undefined, true, {
        code: 'page_not_open',
        message: 'Artifact page is not connected',
      }, ctx);
    }
    if (!state.tools.some((t) => t.name === name)) {
      return formatWebMcpToolResult(undefined, true, {
        code: 'tool_not_found',
        message: `WebMCP tool "${name}" is not registered on artifact "${state.artifactId}"`,
      }, ctx);
    }

    const callId = `wmcp_${crypto.randomBytes(8).toString('hex')}`;
    return new Promise<McpCallToolWireResult>((resolve) => {
      const timer = setTimeout(() => {
        state.pendingCalls.delete(callId);
        resolve(formatWebMcpToolResult(undefined, true, {
          code: 'tool_call_timeout',
          message: `WebMCP tool "${name}" timed out after ${this.toolCallTimeoutMs}ms`,
        }, ctx));
      }, this.toolCallTimeoutMs);
      timer.unref?.();

      state.pendingCalls.set(callId, { callId, toolName: name, resolve, timer });

      Promise.resolve(this.onRemoteToolCall!({
        bridgeId: state.bridgeId,
        artifactId: state.artifactId,
        topic: state.topic,
        callId,
        name,
        arguments: args,
      })).then((sent) => {
        if (!sent) {
          const pending = state.pendingCalls.get(callId);
          if (pending) {
            clearTimeout(pending.timer);
            state.pendingCalls.delete(callId);
            pending.resolve(formatWebMcpToolResult(undefined, true, {
              code: 'page_not_open',
              message: 'CatsCo WebSocket is not connected',
            }, ctx));
          }
        }
      }).catch((err: any) => {
        const pending = state.pendingCalls.get(callId);
        if (pending) {
          clearTimeout(pending.timer);
          state.pendingCalls.delete(callId);
          pending.resolve(formatWebMcpToolResult(undefined, true, {
            code: 'remote_send_failed',
            message: err?.message || 'Failed to dispatch WebMCP tool call',
          }, ctx));
        }
      });
    });
  }

  private broadcastToolsListChanged(state: BridgeRelayState): void {
    const frame = `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: {},
    })}\n\n`;
    for (const stream of [...state.sseStreams]) {
      if (stream.writableEnded) {
        state.sseStreams.delete(stream);
        continue;
      }
      try {
        stream.write(frame);
      } catch {
        state.sseStreams.delete(stream);
      }
    }
  }

  private rejectPendingCalls(state: BridgeRelayState, code: string, message: string): void {
    for (const pending of state.pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.resolve(formatWebMcpToolResult(undefined, true, { code, message }, {
        artifactId: state.artifactId,
        toolName: pending.toolName,
      }));
    }
    state.pendingCalls.clear();
  }
}

export async function startWebMcpRelay(options: WebMcpRelayOptions = {}): Promise<WebMcpRelay> {
  const relay = new WebMcpRelay(options);
  await relay.start();
  return relay;
}

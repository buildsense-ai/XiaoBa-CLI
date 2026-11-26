/**
 * WebMCP Artifact Relay（浏览器 WebMCP ↔ 标准 Streamable HTTP MCP 桥）。
 *
 * 架构职责：
 * 1. 为授权的 Artifact 会话签发短生命周期连接令牌（绑定 `artifactId` + `sessionKey`）。
 * 2. 接受浏览器侧 `webmcp-shim` 的 WebSocket 长连接（`/ws/artifacts/:artifactId`），
 *    接收页面通过 `navigator.modelContext.registerTool` 上报的动态工具清单。
 * 3. 为每个活跃 Artifact 在本机 loopback 暴露标准 Streamable HTTP MCP 端点
 *    （`/mcp/:artifactId`，支持 `initialize`、`ping`、`tools/list`、`tools/call`
 *    以及 `GET` SSE `notifications/tools/list_changed`），并自动调用
 *    `ArtifactMcpBridgeSink.registerArtifactBridge()` 挂入 `McpClientManager`。
 * 4. 页面工具变更时推送 `notifications/tools/list_changed` 触发即时热更新；
 *    页面断连超过宽限期（`disconnectGraceMs`）后自动 `unregisterArtifactBridge` 清理僵尸工具。
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  artifactServerId,
  type ArtifactMcpBridgeSink,
} from './artifact-mcp-registry';
import {
  DEFAULT_WEBMCP_TOKEN_TTL_MS,
  DEFAULT_WEBMCP_TOOL_CALL_TIMEOUT_MS,
  MAX_WEBMCP_PAYLOAD_BYTES,
  WEBMCP_RELAY_PROTOCOL_VERSION,
  formatWebMcpToolResult,
  normalizeWebMcpToolList,
  type WebMcpClientMessage,
  type WebMcpToolDescriptor,
} from './webmcp-protocol';
import { buildWebMcpShimScript } from './webmcp-shim';

export class WebMcpRelayError extends Error {
  constructor(
    message: string,
    public readonly status: number = 422,
    public readonly code: string = 'webmcp_relay_error',
  ) {
    super(message);
    this.name = 'WebMcpRelayError';
  }
}

export interface WebMcpSessionIssueInput {
  artifactId: string;
  sessionKey?: string;
  topic?: string;
  ttlMs?: number;
}

export interface WebMcpSessionTicket {
  ok: true;
  artifactId: string;
  serverId: string;
  token: string;
  wsUrl: string;
  mcpUrl: string;
  shimUrl: string;
  sessionKey?: string;
  topic?: string;
  expiresAt: string;
}

export interface WebMcpSessionSummary {
  artifactId: string;
  serverId: string;
  connected: boolean;
  attached: boolean;
  toolCount: number;
  toolNames: string[];
  sessionKey?: string;
  topic?: string;
  pageUrl?: string;
  title?: string;
  connectedAt?: string;
  lastSeenAt?: string;
}

export interface WebMcpRevokeResult {
  ok: true;
  artifactId: string;
  existed: boolean;
  detached: boolean;
}

/** 供 Dashboard / Connector 跨进程桥接复用的 WebMCP Relay 路由契约。 */
export interface WebMcpRelaySink {
  issueSession(input: WebMcpSessionIssueInput): Promise<WebMcpSessionTicket> | WebMcpSessionTicket;
  revokeSession(artifactId: string, options?: { unbindSession?: boolean }): Promise<WebMcpRevokeResult> | WebMcpRevokeResult;
  listSessions(): Promise<WebMcpSessionSummary[]> | WebMcpSessionSummary[];
}

export interface WebMcpRemoteToolCallRequest {
  bridgeId: string;
  artifactId: string;
  topic?: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface WebMcpRelayOptions {
  /** 监听地址（默认 127.0.0.1；若通过反向代理公网接入可配置为 127.0.0.1 并由反代转发 WS）。 */
  host?: string;
  /** 监听端口（默认 0 自动分配）。 */
  port?: number;
  /** 可选：对外暴露的公网/反代 WS 基址（如 `wss://artifacts.example.com/webmcp`），仅影响签发票据里的 `wsUrl`。 */
  publicWsBaseUrl?: string;
  /** 自动挂接/卸载 Artifact MCP Bridge 的目标（通常为 `artifactMcpRegistry`）。 */
  bridgeSink?: ArtifactMcpBridgeSink;
  /** 可选：通过 CatsCo Hub 双向通道下发 tool_call（生产模式，无需浏览器直连本地 WS）。 */
  onRemoteToolCall?: (request: WebMcpRemoteToolCallRequest) => boolean | Promise<boolean>;
  /** 单次浏览器工具调用超时时间（ms，默认 15000）。 */
  toolCallTimeoutMs?: number;
  /** 页面断连后等待重连的宽限期（ms，默认 5000）；超时未重连则自动 detach。 */
  disconnectGraceMs?: number;
  /** 心跳间隔（ms，默认 25000；设 0 禁用）。 */
  heartbeatIntervalMs?: number;
}

interface IssuedTokenRecord {
  token: string;
  artifactId: string;
  sessionKey?: string;
  topic?: string;
  expiresAtMs: number;
}

interface PendingToolCall {
  callId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ReturnType<typeof formatWebMcpToolResult>) => void;
}

interface ArtifactRelayState {
  artifactId: string;
  serverId: string;
  mcpBearerToken: string;
  mcpSessionId: string;
  sessionKey?: string;
  topic?: string;
  socket: WebSocket | null;
  remoteBridgeId?: string;
  tools: WebMcpToolDescriptor[];
  attached: boolean;
  pageUrl?: string;
  title?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  sseStreams: Set<http.ServerResponse>;
  pendingCalls: Map<string, PendingToolCall>;
}

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

export class WebMcpRelay implements WebMcpRelaySink {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly publicWsBaseUrl?: string;
  private readonly bridgeSink?: ArtifactMcpBridgeSink;
  private readonly onRemoteToolCall?: (request: WebMcpRemoteToolCallRequest) => boolean | Promise<boolean>;
  private readonly toolCallTimeoutMs: number;
  private readonly disconnectGraceMs: number;
  private readonly heartbeatIntervalMs: number;

  private readonly tokens = new Map<string, IssuedTokenRecord>();
  private readonly artifacts = new Map<string, ArtifactRelayState>();
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private boundPort = 0;
  private stopped = false;

  constructor(options: WebMcpRelayOptions = {}) {
    this.host = options.host || '127.0.0.1';
    this.requestedPort = options.port ?? 0;
    this.publicWsBaseUrl = options.publicWsBaseUrl?.replace(/\/+$/, '');
    this.bridgeSink = options.bridgeSink;
    this.onRemoteToolCall = options.onRemoteToolCall;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_WEBMCP_TOOL_CALL_TIMEOUT_MS;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
  }

  get port(): number {
    return this.boundPort;
  }

  get baseHttpUrl(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    this.stopped = false;

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WEBMCP_PAYLOAD_BYTES,
    });
    this.wss = wss;

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(this.requestedPort, this.host, () => {
        server.off('error', onError);
        resolve();
      });
    });

    this.httpServer = server;
    this.boundPort = (server.address() as AddressInfo).port;

    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  /** 为指定 artifact 签发 WebSocket 连接票据（同时绑定可选 sessionKey）。 */
  issueSession(input: WebMcpSessionIssueInput): WebMcpSessionTicket {
    const artifactId = String(input?.artifactId ?? '').trim();
    if (!artifactId) {
      throw new WebMcpRelayError('artifactId is required', 400, 'missing_artifact_id');
    }
    const sessionKey = typeof input.sessionKey === 'string' && input.sessionKey.trim()
      ? input.sessionKey.trim()
      : undefined;
    const topic = typeof input.topic === 'string' && input.topic.trim()
      ? input.topic.trim()
      : undefined;
    if (!sessionKey && topic) {
      throw new WebMcpRelayError(
        'binding an artifact requires a canonical sessionKey (topic alone cannot derive a CatsCo sessionKey)',
        422,
        'missing_session_key',
      );
    }

    const ttlMs = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0
      ? Math.min(Math.floor(input.ttlMs), 24 * 60 * 60 * 1000)
      : DEFAULT_WEBMCP_TOKEN_TTL_MS;
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAtMs = Date.now() + ttlMs;

    this.tokens.set(token, {
      token,
      artifactId,
      sessionKey,
      topic,
      expiresAtMs,
    });

    const state = this.getOrCreateArtifactState(artifactId, sessionKey, topic);
    const encodedId = encodeURIComponent(artifactId);
    const wsBase = this.publicWsBaseUrl || `ws://127.0.0.1:${this.boundPort}`;
    return {
      ok: true,
      artifactId,
      serverId: state.serverId,
      token,
      wsUrl: `${wsBase}/ws/artifacts/${encodedId}`,
      mcpUrl: `${this.baseHttpUrl}/mcp/${encodedId}`,
      shimUrl: `${this.baseHttpUrl}/shim.js`,
      ...(state.sessionKey ? { sessionKey: state.sessionKey } : {}),
      ...(state.topic ? { topic: state.topic } : {}),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** 吊销指定 artifact 的所有令牌、断开浏览器连接并卸载 MCP Bridge。 */
  async revokeSession(
    rawArtifactId: string,
    options: { unbindSession?: boolean } = {},
  ): Promise<WebMcpRevokeResult> {
    const artifactId = String(rawArtifactId ?? '').trim();
    if (!artifactId) {
      throw new WebMcpRelayError('artifactId is required', 400, 'missing_artifact_id');
    }

    let existed = false;
    for (const [tok, rec] of this.tokens.entries()) {
      if (rec.artifactId === artifactId) {
        this.tokens.delete(tok);
        existed = true;
      }
    }

    const state = this.artifacts.get(artifactId);
    let detached = false;
    if (state) {
      existed = true;
      if (state.disconnectTimer) {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = null;
      }
      this.rejectPendingCalls(state, 'session_revoked', 'WebMCP session was revoked');
      if (state.socket) {
        try {
          state.socket.close(4001, 'session_revoked');
        } catch {
          // ignore
        }
        state.socket = null;
      }
      for (const stream of state.sseStreams) {
        try { stream.end(); } catch { /* ignore */ }
      }
      state.sseStreams.clear();
      if (state.attached && this.bridgeSink) {
        await Promise.resolve(
          this.bridgeSink.unregisterArtifactBridge(artifactId, { unbindSession: options.unbindSession }),
        ).catch(() => {});
        state.attached = false;
        detached = true;
      }
      this.artifacts.delete(artifactId);
    }

    return { ok: true, artifactId, existed, detached };
  }

  listSessions(): WebMcpSessionSummary[] {
    return [...this.artifacts.values()].map((state) => ({
      artifactId: state.artifactId,
      serverId: state.serverId,
      connected: Boolean((state.socket && state.socket.readyState === WebSocket.OPEN) || state.remoteBridgeId),
      attached: state.attached,
      toolCount: state.tools.length,
      toolNames: state.tools.map((t) => t.name),
      ...(state.sessionKey ? { sessionKey: state.sessionKey } : {}),
      ...(state.topic ? { topic: state.topic } : {}),
      ...(state.pageUrl ? { pageUrl: state.pageUrl } : {}),
      ...(state.title ? { title: state.title } : {}),
      ...(state.connectedAt ? { connectedAt: state.connectedAt } : {}),
      ...(state.lastSeenAt ? { lastSeenAt: state.lastSeenAt } : {}),
    }));
  }

  /**
   * 生产模式（Gateway + CatsCo Hub）：接收经 CatsCo WebSocket 转发的 `tools_sync`，
   * 自动挂载或热刷新本机 Streamable HTTP MCP 端点。
   */
  async handleRemoteToolsSync(input: {
    bridgeId: string;
    artifactId: string;
    topic?: string;
    sessionKey?: string;
    tools: unknown[];
  }): Promise<void> {
    if (this.stopped) return;
    const bridgeId = String(input.bridgeId ?? '').trim();
    const artifactId = String(input.artifactId ?? '').trim();
    if (!bridgeId || !artifactId) return;

    const state = this.getOrCreateArtifactState(artifactId, input.sessionKey, input.topic);
    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }
    const now = new Date().toISOString();
    if (!state.remoteBridgeId) {
      state.connectedAt = now;
    } else if (state.remoteBridgeId !== bridgeId) {
      this.rejectPendingCalls(state, 'page_replaced', 'Artifact page connection was replaced by a newer tab');
    }
    state.remoteBridgeId = bridgeId;
    state.lastSeenAt = now;

    const nextTools = normalizeWebMcpToolList(input.tools);
    const changed = !areToolListsEqual(state.tools, nextTools);
    state.tools = nextTools;

    if (!state.attached && nextTools.length > 0 && this.bridgeSink) {
      try {
        await Promise.resolve(this.bridgeSink.registerArtifactBridge({
          artifactId: state.artifactId,
          url: `${this.baseHttpUrl}/mcp/${encodeURIComponent(state.artifactId)}`,
          bearerToken: state.mcpBearerToken,
          ...(state.sessionKey
            ? {
                sessionKey: state.sessionKey,
                ...(state.topic ? { topic: state.topic } : {}),
              }
            : {}),
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
    for (const state of this.artifacts.values()) {
      if (state.remoteBridgeId !== bridgeId) continue;
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
      pending.resolve(formatWebMcpToolResult(rawResult, input.isError === true, input.error));
      return;
    }
  }

  /** 接收经 CatsCo WebSocket 转发的 `detach`（页面关闭 / 断连 / open_ref 撤销）。 */
  async handleRemoteDetach(input: { bridgeId: string; reason?: string }): Promise<void> {
    const bridgeId = String(input.bridgeId ?? '').trim();
    if (!bridgeId) return;
    for (const [artifactId, state] of this.artifacts.entries()) {
      if (state.remoteBridgeId !== bridgeId) continue;
      state.remoteBridgeId = undefined;
      this.rejectPendingCalls(state, 'page_not_open', input.reason || 'Artifact page detached');
      if (!state.socket) {
        await this.revokeSession(artifactId);
      }
      return;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    const artifactIds = [...this.artifacts.keys()];
    await Promise.allSettled(artifactIds.map((id) => this.revokeSession(id)));
    this.tokens.clear();

    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // ---------------- Internal Helpers ----------------

  private getOrCreateArtifactState(
    artifactId: string,
    sessionKey?: string,
    topic?: string,
  ): ArtifactRelayState {
    let state = this.artifacts.get(artifactId);
    if (!state) {
      state = {
        artifactId,
        serverId: artifactServerId(artifactId),
        mcpBearerToken: crypto.randomBytes(24).toString('hex'),
        mcpSessionId: `webmcp-${crypto.randomBytes(12).toString('hex')}`,
        ...(sessionKey ? { sessionKey } : {}),
        ...(topic ? { topic } : {}),
        socket: null,
        tools: [],
        attached: false,
        disconnectTimer: null,
        sseStreams: new Set(),
        pendingCalls: new Map(),
      };
      this.artifacts.set(artifactId, state);
    } else {
      if (sessionKey) state.sessionKey = sessionKey;
      if (topic) state.topic = topic;
    }
    return state;
  }

  private validateWsToken(artifactId: string, rawToken: string | undefined): IssuedTokenRecord | null {
    if (!rawToken) return null;
    const now = Date.now();
    // 清理过期票据，避免内存缓慢增长。
    for (const [k, rec] of this.tokens.entries()) {
      if (rec.expiresAtMs <= now) this.tokens.delete(k);
    }
    const record = this.tokens.get(rawToken);
    if (!record) return null;
    if (record.artifactId !== artifactId) return null;
    if (record.expiresAtMs <= now) {
      this.tokens.delete(rawToken);
      return null;
    }
    return record;
  }

  private handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer): void {
    const wss = this.wss;
    if (!wss || this.stopped) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const match = url.pathname.match(/^\/ws\/artifacts\/([^/]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    let artifactId: string;
    try {
      artifactId = decodeURIComponent(match[1]).trim();
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const authHeader = String(req.headers.authorization || '');
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : undefined;
    const queryToken = url.searchParams.get('token')?.trim() || undefined;
    const token = bearerToken || queryToken;

    const record = this.validateWsToken(artifactId, token);
    if (!record) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      this.onBrowserSocketConnected(artifactId, record, ws);
    });
  }

  private onBrowserSocketConnected(
    artifactId: string,
    record: IssuedTokenRecord,
    ws: WebSocket,
  ): void {
    const state = this.getOrCreateArtifactState(artifactId, record.sessionKey, record.topic);

    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }

    // 同一 artifact 新页面连接到达时，优雅替换旧 socket。
    if (state.socket && state.socket !== ws) {
      const prev = state.socket;
      state.socket = null;
      this.rejectPendingCalls(state, 'page_replaced', 'Artifact page connection was replaced by a newer tab');
      try {
        prev.close(4000, 'replaced_by_new_connection');
      } catch {
        // ignore
      }
    }

    state.socket = ws;
    const nowIso = new Date().toISOString();
    state.connectedAt = nowIso;
    state.lastSeenAt = nowIso;

    this.sendWsJson(ws, {
      type: 'welcome',
      protocolVersion: WEBMCP_RELAY_PROTOCOL_VERSION,
      artifactId,
      serverId: state.serverId,
      sessionBound: Boolean(state.sessionKey),
    });

    ws.on('message', (data) => {
      if (state.socket !== ws) return;
      state.lastSeenAt = new Date().toISOString();
      const raw = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      void this.handleBrowserMessage(state, raw);
    });

    ws.on('close', () => {
      if (state.socket !== ws) return;
      state.socket = null;
      this.rejectPendingCalls(state, 'page_disconnected', 'Artifact page disconnected before returning tool result');

      if (this.stopped) return;
      if (this.disconnectGraceMs <= 0) {
        void this.detachArtifactAfterGrace(state);
      } else {
        state.disconnectTimer = setTimeout(() => {
          state.disconnectTimer = null;
          if (!state.socket) {
            void this.detachArtifactAfterGrace(state);
          }
        }, this.disconnectGraceMs);
        state.disconnectTimer.unref?.();
      }
    });

    ws.on('error', () => {
      // close 事件统一清理。
    });
  }

  private async detachArtifactAfterGrace(state: ArtifactRelayState): Promise<void> {
    if (state.socket) return;
    if (state.attached && this.bridgeSink) {
      state.attached = false;
      await Promise.resolve(
        this.bridgeSink.unregisterArtifactBridge(state.artifactId, { unbindSession: false }),
      ).catch(() => {});
    }
  }

  private async handleBrowserMessage(state: ArtifactRelayState, raw: string): Promise<void> {
    let msg: WebMcpClientMessage;
    try {
      msg = JSON.parse(raw) as WebMcpClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      if (typeof msg.pageUrl === 'string') state.pageUrl = msg.pageUrl.slice(0, 2000);
      if (typeof msg.title === 'string') state.title = msg.title.slice(0, 500);
      return;
    }

    if (msg.type === 'pong') {
      return;
    }

    if (msg.type === 'tools_sync') {
      const nextTools = normalizeWebMcpToolList(msg.tools);
      const changed = !areToolListsEqual(state.tools, nextTools);
      state.tools = nextTools;

      if (!state.attached && nextTools.length > 0 && this.bridgeSink) {
        try {
          await Promise.resolve(this.bridgeSink.registerArtifactBridge({
            artifactId: state.artifactId,
            url: `${this.baseHttpUrl}/mcp/${encodeURIComponent(state.artifactId)}`,
            bearerToken: state.mcpBearerToken,
            ...(state.sessionKey ? { sessionKey: state.sessionKey } : {}),
            ...(state.topic ? { topic: state.topic } : {}),
          }));
          state.attached = true;
        } catch {
          // 挂载失败时不崩溃，后续 tools_sync 可继续重试。
        }
      } else if (changed && state.attached) {
        this.broadcastToolsListChanged(state);
      }
      return;
    }

    if (msg.type === 'tool_result') {
      const callId = String(msg.callId || '');
      const pending = state.pendingCalls.get(callId);
      if (!pending) return;
      state.pendingCalls.delete(callId);
      clearTimeout(pending.timer);
      pending.resolve(formatWebMcpToolResult(msg.result, msg.isError, msg.error));
    }
  }

  private broadcastToolsListChanged(state: ArtifactRelayState): void {
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: {},
    };
    const frame = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
    for (const stream of state.sseStreams) {
      try {
        stream.write(frame);
      } catch {
        state.sseStreams.delete(stream);
      }
    }
  }

  private sendHeartbeats(): void {
    const ts = Date.now();
    for (const state of this.artifacts.values()) {
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        this.sendWsJson(state.socket, { type: 'ping', ts });
      }
    }
  }

  private sendWsJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  private rejectPendingCalls(state: ArtifactRelayState, code: string, message: string): void {
    for (const pending of state.pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.resolve(formatWebMcpToolResult(undefined, true, { code, message }));
    }
    state.pendingCalls.clear();
  }

  // ---------------- Streamable HTTP MCP Endpoint + /shim.js ----------------

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/shim.js') {
      const script = buildWebMcpShimScript();
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(script);
      return;
    }

    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!mcpMatch) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }

    let artifactId: string;
    try {
      artifactId = decodeURIComponent(mcpMatch[1]).trim();
    } catch {
      res.writeHead(400).end();
      return;
    }

    const state = this.artifacts.get(artifactId);
    if (!state) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'artifact_not_found' }));
      return;
    }

    // 校验内部 MCP Bearer token（由 Relay 生成并在 registerArtifactBridge 时交给 McpClientManager）。
    const authHeader = String(req.headers.authorization || '');
    const expected = `Bearer ${state.mcpBearerToken}`;
    if (
      authHeader.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
    ) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'mcp-session-id': state.mcpSessionId,
      });
      res.write('retry: 1000\n\n');
      state.sseStreams.add(res);
      req.on('close', () => state.sseStreams.delete(res));
      return;
    }

    if (req.method === 'DELETE') {
      res.writeHead(202, { 'mcp-session-id': state.mcpSessionId }).end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(req, MAX_WEBMCP_PAYLOAD_BYTES);
    } catch {
      res.writeHead(413).end();
      return;
    }

    let message: any;
    try {
      message = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    // JSON-RPC Notification（无 id）：返回 202。
    if (!message || typeof message !== 'object' || message.id === undefined) {
      res.writeHead(202, { 'mcp-session-id': state.mcpSessionId }).end();
      return;
    }

    const reply = await this.handleMcpRpcRequest(state, message);
    res.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': state.mcpSessionId,
    });
    res.end(JSON.stringify(reply));
  }

  private async handleMcpRpcRequest(state: ArtifactRelayState, message: any): Promise<Record<string, unknown>> {
    const base = { jsonrpc: '2.0', id: message.id };

    switch (message.method) {
      case 'initialize':
        return {
          ...base,
          result: {
            protocolVersion: typeof message.params?.protocolVersion === 'string'
              ? message.params.protocolVersion
              : DEFAULT_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: true },
            },
            serverInfo: {
              name: 'xiaoba-webmcp-relay',
              version: '1.0.0',
            },
          },
        };

      case 'ping':
        return { ...base, result: {} };

      case 'tools/list':
        return {
          ...base,
          result: {
            tools: state.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          },
        };

      case 'tools/call': {
        const toolName = String(message.params?.name ?? '').trim();
        const toolArgs = (message.params?.arguments && typeof message.params.arguments === 'object')
          ? (message.params.arguments as Record<string, unknown>)
          : {};
        const result = await this.invokeBrowserTool(state, toolName, toolArgs);
        return { ...base, result };
      }

      default:
        return {
          ...base,
          error: { code: -32601, message: `Method not found: ${String(message.method ?? '')}` },
        };
    }
  }

  private async invokeBrowserTool(
    state: ArtifactRelayState,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ReturnType<typeof formatWebMcpToolResult>> {
    const hasLocalSocket = Boolean(state.socket && state.socket.readyState === WebSocket.OPEN);
    const hasRemoteBridge = Boolean(state.remoteBridgeId && this.onRemoteToolCall);

    if (!hasLocalSocket && !hasRemoteBridge) {
      return formatWebMcpToolResult(undefined, true, {
        code: 'page_not_open',
        message: `Artifact "${state.artifactId}" page is not currently connected`,
      });
    }

    if (!state.tools.some((t) => t.name === name)) {
      return formatWebMcpToolResult(undefined, true, {
        code: 'tool_not_found',
        message: `WebMCP tool "${name}" is not registered on artifact "${state.artifactId}"`,
      });
    }

    const callId = crypto.randomUUID();
    const timeoutMs = this.toolCallTimeoutMs;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.pendingCalls.delete(callId);
        resolve(formatWebMcpToolResult(undefined, true, {
          code: 'tool_call_timeout',
          message: `WebMCP tool "${name}" timed out after ${timeoutMs}ms`,
        }));
      }, timeoutMs);
      timer.unref?.();

      state.pendingCalls.set(callId, { callId, timer, resolve });
      if (hasRemoteBridge) {
        Promise.resolve(
          this.onRemoteToolCall!({
            bridgeId: state.remoteBridgeId!,
            artifactId: state.artifactId,
            topic: state.topic,
            callId,
            name,
            arguments: args,
          }),
        ).then((sent) => {
          if (!sent && state.pendingCalls.has(callId)) {
            clearTimeout(timer);
            state.pendingCalls.delete(callId);
            resolve(formatWebMcpToolResult(undefined, true, {
              code: 'page_not_open',
              message: `Failed to forward WebMCP tool call for artifact "${state.artifactId}"`,
            }));
          }
        }).catch(() => {
          if (state.pendingCalls.has(callId)) {
            clearTimeout(timer);
            state.pendingCalls.delete(callId);
            resolve(formatWebMcpToolResult(undefined, true, {
              code: 'page_not_open',
              message: `Failed to forward WebMCP tool call for artifact "${state.artifactId}"`,
            }));
          }
        });
      } else {
        this.sendWsJson(state.socket!, {
          type: 'tool_call',
          callId,
          name,
          arguments: args,
          timeoutMs,
        });
      }
    });
  }
}

export async function startWebMcpRelay(options: WebMcpRelayOptions = {}): Promise<WebMcpRelay> {
  const relay = new WebMcpRelay(options);
  await relay.start();
  return relay;
}

function areToolListsEqual(a: WebMcpToolDescriptor[], b: WebMcpToolDescriptor[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

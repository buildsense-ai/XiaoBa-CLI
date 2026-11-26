/**
 * WebMCP 浏览器侧宿主代理（Frontend Host Shim）。
 *
 * 承担两件事：
 * 1. `createWebMcpBrowserShim()`：TypeScript 实现，可直接嵌入前端项目或在 Node 集成测试中运行；
 *    安装/包装 `navigator.modelContext`（兼容原生双写），通过 WebSocket 与服务端 `WebMcpRelay`
 *    同步工具清单并执行远程 `tools/call`。
 * 2. `buildWebMcpShimScript()`：生成零依赖、浏览器可直接 `<script src=".../webmcp/shim.js">`
 *    加载的 ES2020 脚本，同时支持直连 WebSocket 与 iframe `postMessage` 宿主桥接。
 */
import {
  WEBMCP_RELAY_PROTOCOL_VERSION,
  normalizeWebMcpToolDescriptor,
  type WebMcpModelContext,
  type WebMcpServerMessage,
  type WebMcpToolDefinition,
  type WebMcpToolDescriptor,
} from './webmcp-protocol';

/** 兼容浏览器原生 `WebSocket` 与 Node `ws` 的最小接口。 */
export interface WebMcpSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  on?(type: string, listener: (...args: any[]) => void): void;
  off?(type: string, listener: (...args: any[]) => void): void;
}

export interface WebMcpBrowserShimOptions {
  /** 要安装 `modelContext` 的 navigator 对象（默认创建一个独立对象以便测试）。 */
  navigator?: { modelContext?: WebMcpModelContext };
  /** WebSocket 构造函数工厂（浏览器传 `(url) => new WebSocket(url)`，Node 测试可传 `ws`）。 */
  createWebSocket?: (url: string) => WebMcpSocketLike;
  /** Relay WebSocket URL（例如 `ws://127.0.0.1:41234/ws/artifacts/art-1?token=...`）。 */
  wsUrl?: string;
  artifactId?: string;
  token?: string;
  pageUrl?: string;
  title?: string;
  clientId?: string;
  /** 是否在检测到原生 `navigator.modelContext` 时双写透传（默认 true）。 */
  dualWriteNative?: boolean;
  /** 断线自动重连基础间隔（ms，默认 1000；设 0 禁用重连）。 */
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export interface WebMcpBrowserShimHandle {
  readonly modelContext: WebMcpModelContext;
  connect(options?: { wsUrl?: string; artifactId?: string; token?: string }): void;
  disconnect(): void;
  getTools(): WebMcpToolDescriptor[];
  getState(): {
    connected: boolean;
    artifactId?: string;
    toolCount: number;
    hasNativeModelContext: boolean;
  };
}

const WS_OPEN = 1;

/**
 * 创建一个标准 WebMCP 宿主 Shim：
 * - 暴露并挂载 `navigator.modelContext`（`registerTool` / `unregisterTool` / `provideContext` / `clearContext`）
 * - 自动把工具清单增量变更汇总为 `tools_sync` 快照上报给 `WebMcpRelay`
 * - 接收 Relay 下发的 `tool_call` 并在本地执行对应 `execute(args)`，回传 `tool_result`
 */
export function createWebMcpBrowserShim(options: WebMcpBrowserShimOptions = {}): WebMcpBrowserShimHandle {
  const nav = options.navigator ?? {};
  const nativeContext = options.dualWriteNative !== false ? nav.modelContext : undefined;
  const tools = new Map<string, { descriptor: WebMcpToolDescriptor; execute: WebMcpToolDefinition['execute'] }>();

  let socket: WebMcpSocketLike | null = null;
  let connected = false;
  let closedByUser = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let currentWsUrl = options.wsUrl;
  let currentArtifactId = options.artifactId;
  let currentToken = options.token;

  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1000;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 15_000;

  function listDescriptors(): WebMcpToolDescriptor[] {
    return [...tools.values()].map((entry) => entry.descriptor);
  }

  function sendJson(payload: unknown): void {
    if (!socket || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // 发送失败由 socket close/error 路径统一处理。
    }
  }

  function syncTools(): void {
    if (!connected) return;
    sendJson({
      type: 'tools_sync',
      tools: listDescriptors(),
    });
  }

  async function handleIncomingMessage(raw: string): Promise<void> {
    let msg: WebMcpServerMessage;
    try {
      msg = JSON.parse(raw) as WebMcpServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      sendJson({ type: 'pong', ts: msg.ts });
      return;
    }

    if (msg.type === 'tool_call') {
      const { callId, name, arguments: args } = msg;
      const entry = tools.get(name);
      if (!entry) {
        sendJson({
          type: 'tool_result',
          callId,
          isError: true,
          error: { code: 'tool_not_found', message: `WebMCP tool "${name}" is not registered on this page` },
        });
        return;
      }
      try {
        const result = await Promise.resolve(entry.execute(args && typeof args === 'object' ? args : {}));
        sendJson({
          type: 'tool_result',
          callId,
          result,
        });
      } catch (error: any) {
        sendJson({
          type: 'tool_result',
          callId,
          isError: true,
          error: {
            code: 'tool_execution_error',
            message: error instanceof Error ? error.message : String(error || 'tool execution failed'),
          },
        });
      }
    }
  }

  function buildTargetUrl(): string | null {
    if (!currentWsUrl) return null;
    if (!currentToken) return currentWsUrl;
    try {
      const url = new URL(currentWsUrl);
      if (!url.searchParams.has('token')) {
        url.searchParams.set('token', currentToken);
      }
      return url.toString();
    } catch {
      return currentWsUrl;
    }
  }

  function attachSocketListener(
    ws: WebMcpSocketLike,
    event: 'open' | 'message' | 'close' | 'error',
    handler: (payload: any) => void,
  ): void {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener(event, (ev: any) => {
        if (event === 'message') {
          const data = typeof ev?.data === 'string' ? ev.data : String(ev?.data ?? '');
          handler(data);
        } else {
          handler(ev);
        }
      });
    } else if (typeof ws.on === 'function') {
      ws.on(event, (arg: any) => {
        if (event === 'message') {
          handler(typeof arg === 'string' ? arg : Buffer.isBuffer(arg) ? arg.toString('utf8') : String(arg ?? ''));
        } else {
          handler(arg);
        }
      });
    }
  }

  function scheduleReconnect(): void {
    if (closedByUser || reconnectBaseDelayMs <= 0) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * Math.pow(2, reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function openSocket(): void {
    const targetUrl = buildTargetUrl();
    if (!targetUrl || !options.createWebSocket) return;
    if (socket) {
      try {
        socket.close(1000, 'reconnecting');
      } catch {
        // ignore
      }
      socket = null;
    }

    const ws = options.createWebSocket(targetUrl);
    socket = ws;

    attachSocketListener(ws, 'open', () => {
      if (socket !== ws) return;
      connected = true;
      reconnectAttempt = 0;
      sendJson({
        type: 'hello',
        protocolVersion: WEBMCP_RELAY_PROTOCOL_VERSION,
        ...(currentArtifactId ? { artifactId: currentArtifactId } : {}),
        ...(options.pageUrl ? { pageUrl: options.pageUrl } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(options.clientId ? { clientId: options.clientId } : {}),
      });
      syncTools();
    });

    attachSocketListener(ws, 'message', (raw: string) => {
      if (socket !== ws) return;
      void handleIncomingMessage(raw);
    });

    attachSocketListener(ws, 'close', () => {
      if (socket !== ws) return;
      connected = false;
      socket = null;
      scheduleReconnect();
    });

    attachSocketListener(ws, 'error', () => {
      // close 事件会紧随其后触发重连，这里避免未捕获异常。
    });
  }

  const modelContext: WebMcpModelContext = {
    registerTool(tool: WebMcpToolDefinition): void {
      if (!tool || typeof tool.execute !== 'function') {
        throw new TypeError('WebMCP registerTool requires a tool object with an execute function');
      }
      const descriptor = normalizeWebMcpToolDescriptor(tool);
      if (!descriptor) {
        throw new TypeError(`Invalid WebMCP tool name: ${String(tool.name ?? '')}`);
      }
      tools.set(descriptor.name, { descriptor, execute: tool.execute });
      try {
        nativeContext?.registerTool?.(tool);
      } catch {
        // 原生双写失败不阻断 Relay 通道。
      }
      syncTools();
    },

    unregisterTool(name: string): void {
      const key = String(name ?? '').trim();
      if (!key) return;
      const existed = tools.delete(key);
      try {
        nativeContext?.unregisterTool?.(key);
      } catch {
        // ignore
      }
      if (existed) syncTools();
    },

    provideContext(context?: { tools?: WebMcpToolDefinition[] }): void {
      tools.clear();
      const nextTools = Array.isArray(context?.tools) ? context.tools : [];
      for (const tool of nextTools) {
        if (!tool || typeof tool.execute !== 'function') continue;
        const descriptor = normalizeWebMcpToolDescriptor(tool);
        if (!descriptor) continue;
        tools.set(descriptor.name, { descriptor, execute: tool.execute });
      }
      try {
        nativeContext?.provideContext?.(context);
      } catch {
        // ignore
      }
      syncTools();
    },

    clearContext(): void {
      const hadTools = tools.size > 0;
      tools.clear();
      try {
        nativeContext?.clearContext?.();
      } catch {
        // ignore
      }
      if (hadTools) syncTools();
    },
  };

  try {
    Object.defineProperty(nav, 'modelContext', {
      value: modelContext,
      configurable: true,
      writable: true,
    });
  } catch {
    nav.modelContext = modelContext;
  }

  return {
    modelContext,
    connect(connectOpts?: { wsUrl?: string; artifactId?: string; token?: string }): void {
      if (connectOpts?.wsUrl !== undefined) currentWsUrl = connectOpts.wsUrl;
      if (connectOpts?.artifactId !== undefined) currentArtifactId = connectOpts.artifactId;
      if (connectOpts?.token !== undefined) currentToken = connectOpts.token;
      closedByUser = false;
      reconnectAttempt = 0;
      openSocket();
    },
    disconnect(): void {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connected = false;
      if (socket) {
        try {
          socket.close(1000, 'client_disconnect');
        } catch {
          // ignore
        }
        socket = null;
      }
    },
    getTools: listDescriptors,
    getState: () => ({
      connected,
      artifactId: currentArtifactId,
      toolCount: tools.size,
      hasNativeModelContext: Boolean(nativeContext),
    }),
  };
}

export interface WebMcpShimScriptOptions {
  defaultWsUrl?: string;
  defaultArtifactId?: string;
  defaultToken?: string;
}

/**
 * 生成浏览器可直接加载的零依赖 WebMCP Shim 脚本（ES2020 IIFE）。
 *
 * 用法示例：
 * 1. 直连 Relay（自动从 script data 属性或 URL 查询参数读取 wsUrl/token）：
 *    `<script src="/api/artifacts/webmcp/shim.js" data-ws-url="ws://..." data-token="..."></script>`
 * 2. 编程式连接：
 *    `window.__XIAOBA_WEBMCP_SHIM__.connect({ wsUrl, artifactId, token })`
 * 3. iframe 宿主桥接（外层宿主壳转发给 sandbox iframe）：
 *    `window.__XIAOBA_WEBMCP_SHIM__.attachIframeBridge(iframeEl, { targetOrigin })`
 */
export function buildWebMcpShimScript(options: WebMcpShimScriptOptions = {}): string {
  const defaults = JSON.stringify({
    wsUrl: options.defaultWsUrl || '',
    artifactId: options.defaultArtifactId || '',
    token: options.defaultToken || '',
    protocolVersion: WEBMCP_RELAY_PROTOCOL_VERSION,
  });

  return `(function () {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (window.__XIAOBA_WEBMCP_SHIM__) return;

  var DEFAULTS = ${defaults};
  var TOOL_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
  var IFRAME_CHANNEL = 'xiaoba.webmcp.v1';
  var nativeContext = navigator.modelContext || null;
  var tools = new Map();
  var ws = null;
  var connected = false;
  var closedByUser = false;
  var reconnectTimer = null;
  var reconnectAttempt = 0;
  var config = {
    wsUrl: DEFAULTS.wsUrl,
    artifactId: DEFAULTS.artifactId,
    token: DEFAULTS.token,
    mode: 'auto',
    parentOrigin: '*',
  };

  function readScriptConfig() {
    var script = document.currentScript;
    if (!script) return;
    if (script.dataset.wsUrl) config.wsUrl = script.dataset.wsUrl;
    if (script.dataset.artifactId) config.artifactId = script.dataset.artifactId;
    if (script.dataset.token) config.token = script.dataset.token;
    if (script.dataset.mode) config.mode = script.dataset.mode;
    if (script.dataset.parentOrigin) config.parentOrigin = script.dataset.parentOrigin;
  }

  function normalizeTool(tool) {
    if (!tool || typeof tool !== 'object' || typeof tool.execute !== 'function') {
      throw new TypeError('WebMCP registerTool requires { name, description, execute }');
    }
    var name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name || !TOOL_NAME_RE.test(name)) {
      throw new TypeError('Invalid WebMCP tool name: ' + name);
    }
    var description = typeof tool.description === 'string' && tool.description.trim()
      ? tool.description.trim().slice(0, 2000)
      : ('WebMCP tool ' + name);
    var inputSchema = (tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema))
      ? Object.assign({ type: 'object' }, tool.inputSchema)
      : { type: 'object', properties: {} };
    var descriptor = { name: name, description: description, inputSchema: inputSchema };
    if (tool.annotations && typeof tool.annotations === 'object' && !Array.isArray(tool.annotations)) {
      descriptor.annotations = tool.annotations;
    }
    return { descriptor: descriptor, execute: tool.execute };
  }

  function listDescriptors() {
    var out = [];
    tools.forEach(function (entry) { out.push(entry.descriptor); });
    return out;
  }

  function isIframeBridgeMode() {
    if (config.mode === 'iframe') return true;
    return config.mode === 'auto' && !config.wsUrl && window.parent && window.parent !== window;
  }

  function sendTransport(payload) {
    if (isIframeBridgeMode()) {
      try {
        window.parent.postMessage({ channel: IFRAME_CHANNEL, payload: payload }, config.parentOrigin || '*');
      } catch (_) {}
      return;
    }
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(payload)); } catch (_) {}
  }

  function syncTools() {
    if (!connected && !isIframeBridgeMode()) return;
    sendTransport({ type: 'tools_sync', tools: listDescriptors() });
  }

  function handleServerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      sendTransport({ type: 'pong', ts: msg.ts });
      return;
    }
    if (msg.type === 'tool_call') {
      var callId = msg.callId;
      var entry = tools.get(msg.name);
      if (!entry) {
        sendTransport({
          type: 'tool_result',
          callId: callId,
          isError: true,
          error: { code: 'tool_not_found', message: 'WebMCP tool "' + msg.name + '" is not registered on this page' },
        });
        return;
      }
      Promise.resolve()
        .then(function () { return entry.execute(msg.arguments && typeof msg.arguments === 'object' ? msg.arguments : {}); })
        .then(function (result) {
          sendTransport({ type: 'tool_result', callId: callId, result: result });
        })
        .catch(function (err) {
          sendTransport({
            type: 'tool_result',
            callId: callId,
            isError: true,
            error: { code: 'tool_execution_error', message: (err && err.message) ? err.message : String(err || 'tool execution failed') },
          });
        });
    }
  }

  function scheduleReconnect() {
    if (closedByUser || !config.wsUrl) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    var delay = Math.min(15000, 1000 * Math.pow(2, reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      openWebSocket();
    }, delay);
  }

  function openWebSocket() {
    if (!config.wsUrl) return;
    var url = config.wsUrl;
    if (config.token) {
      try {
        var parsed = new URL(url, window.location.href);
        if (!parsed.searchParams.has('token')) parsed.searchParams.set('token', config.token);
        url = parsed.toString();
      } catch (_) {}
    }
    if (ws) {
      try { ws.close(1000, 'reconnecting'); } catch (_) {}
      ws = null;
    }
    var socket = new WebSocket(url);
    ws = socket;
    socket.addEventListener('open', function () {
      if (ws !== socket) return;
      connected = true;
      reconnectAttempt = 0;
      sendTransport({
        type: 'hello',
        protocolVersion: DEFAULTS.protocolVersion,
        artifactId: config.artifactId || undefined,
        pageUrl: window.location ? window.location.href : undefined,
        title: typeof document !== 'undefined' ? document.title : undefined,
      });
      syncTools();
    });
    socket.addEventListener('message', function (ev) {
      if (ws !== socket) return;
      try { handleServerMessage(JSON.parse(String(ev.data || ''))); } catch (_) {}
    });
    socket.addEventListener('close', function () {
      if (ws !== socket) return;
      connected = false;
      ws = null;
      scheduleReconnect();
    });
    socket.addEventListener('error', function () {});
  }

  window.addEventListener('message', function (ev) {
    if (!ev || !ev.data || ev.data.channel !== IFRAME_CHANNEL) return;
    if (config.parentOrigin && config.parentOrigin !== '*' && ev.origin !== config.parentOrigin) return;
    if (ev.data.payload) handleServerMessage(ev.data.payload);
  });

  var modelContext = {
    registerTool: function (tool) {
      var normalized = normalizeTool(tool);
      tools.set(normalized.descriptor.name, normalized);
      if (nativeContext && typeof nativeContext.registerTool === 'function') {
        try { nativeContext.registerTool(tool); } catch (_) {}
      }
      syncTools();
    },
    unregisterTool: function (name) {
      var key = String(name || '').trim();
      if (!key) return;
      var existed = tools.delete(key);
      if (nativeContext && typeof nativeContext.unregisterTool === 'function') {
        try { nativeContext.unregisterTool(key); } catch (_) {}
      }
      if (existed) syncTools();
    },
    provideContext: function (ctx) {
      tools.clear();
      var list = ctx && Array.isArray(ctx.tools) ? ctx.tools : [];
      for (var i = 0; i < list.length; i += 1) {
        try {
          var normalized = normalizeTool(list[i]);
          tools.set(normalized.descriptor.name, normalized);
        } catch (_) {}
      }
      if (nativeContext && typeof nativeContext.provideContext === 'function') {
        try { nativeContext.provideContext(ctx); } catch (_) {}
      }
      syncTools();
    },
    clearContext: function () {
      var had = tools.size > 0;
      tools.clear();
      if (nativeContext && typeof nativeContext.clearContext === 'function') {
        try { nativeContext.clearContext(); } catch (_) {}
      }
      if (had) syncTools();
    },
  };

  try {
    Object.defineProperty(navigator, 'modelContext', { value: modelContext, configurable: true, writable: true });
  } catch (_) {
    navigator.modelContext = modelContext;
  }

  function attachIframeBridge(iframeEl, opts) {
    var targetOrigin = (opts && opts.targetOrigin) || '*';
    var onMessage = function (ev) {
      if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
      if (targetOrigin !== '*' && ev.origin !== targetOrigin) return;
      if (!ev.data || ev.data.channel !== IFRAME_CHANNEL || !ev.data.payload) return;
      var payload = ev.data.payload;
      if (payload.type === 'tools_sync' || payload.type === 'tool_result' || payload.type === 'pong') {
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify(payload)); } catch (_) {}
        }
      }
    };
    window.addEventListener('message', onMessage);
    var prevHandle = handleServerMessage;
    handleServerMessage = function (msg) {
      if (msg && msg.type === 'tool_call' && iframeEl && iframeEl.contentWindow) {
        iframeEl.contentWindow.postMessage({ channel: IFRAME_CHANNEL, payload: msg }, targetOrigin);
        return;
      }
      prevHandle(msg);
    };
    return function detach() {
      window.removeEventListener('message', onMessage);
      handleServerMessage = prevHandle;
    };
  }

  window.__XIAOBA_WEBMCP_SHIM__ = {
    connect: function (opts) {
      if (opts && opts.wsUrl !== undefined) config.wsUrl = opts.wsUrl;
      if (opts && opts.artifactId !== undefined) config.artifactId = opts.artifactId;
      if (opts && opts.token !== undefined) config.token = opts.token;
      if (opts && opts.mode !== undefined) config.mode = opts.mode;
      closedByUser = false;
      reconnectAttempt = 0;
      openWebSocket();
    },
    disconnect: function () {
      closedByUser = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connected = false;
      if (ws) { try { ws.close(1000, 'client_disconnect'); } catch (_) {} ws = null; }
    },
    getTools: listDescriptors,
    getState: function () {
      return {
        connected: connected,
        artifactId: config.artifactId,
        toolCount: tools.size,
        hasNativeModelContext: Boolean(nativeContext),
      };
    },
    attachIframeBridge: attachIframeBridge,
  };

  readScriptConfig();
  if (config.wsUrl) {
    openWebSocket();
  }
})();
`;
}

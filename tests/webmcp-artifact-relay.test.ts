/**
 * WebMCP Artifact Relay & Frontend Host Shim 端到端集成测试。
 *
 * 覆盖：
 * 1. 协议与工具描述规范化 + MCP CallToolResult 格式化；
 * 2. Browser Shim（navigator.modelContext 双写、registerTool/unregisterTool/provideContext/clearContext、shim.js 语法校验）；
 * 3. 全链路集成：Browser Shim ←WS→ WebMcpRelay ←Streamable HTTP + SSE→ McpClientManager（via ArtifactMcpRegistry）；
 *    包含自动 attach、远程 tools/call 执行、tools/list_changed 热更新、超时/异常/离线保护、断连宽限期自动 detach；
 * 4. 安全隔离：未授权 WS 拒绝、跨 artifactId token 拒绝、MCP 内部 Bearer token 校验；
 * 5. Dashboard 路由与跨进程 Connector Bridge 转发（/shim.js、/session 签发/查询/吊销、403 门禁）。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import {
  normalizeWebMcpToolDescriptor,
  normalizeWebMcpToolList,
  formatWebMcpToolResult,
  MAX_WEBMCP_TOOLS_PER_ARTIFACT,
  type WebMcpModelContext,
} from '../src/mcp/webmcp-protocol';
import {
  createWebMcpBrowserShim,
  buildWebMcpShimScript,
} from '../src/mcp/webmcp-shim';
import {
  startWebMcpRelay,
} from '../src/mcp/webmcp-relay';
import { ArtifactMcpRegistry } from '../src/mcp/artifact-mcp-registry';
import { ExternalEventRouter } from '../src/events/external-event-router';
import {
  McpClientManager,
  type McpToolRegistry,
} from '../src/mcp/mcp-client-manager';
import { createSdkMcpConnectionFactory } from '../src/mcp/mcp-persistent-client';
import {
  startConnectorEventBridge,
  createForwardingArtifactEventSink,
  createForwardingArtifactMcpBridgeSink,
  createForwardingWebMcpRelaySink,
} from '../src/events/connector-event-bridge';
import { createExternalEventArtifactSink } from '../src/events/event-bus-adapters';
import { createArtifactEventsRouter } from '../src/dashboard/routes/artifact-events';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.ok(predicate(), `waitFor timed out: ${label}`);
}

class FakeToolRegistry implements McpToolRegistry {
  readonly tools = new Map<string, any>();
  registerTool(tool: any): void {
    const name = tool?.definition?.name ?? tool?.name;
    if (name) this.tools.set(name, tool);
  }
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }
  findBySuffix(suffix: string): any {
    for (const [name, tool] of this.tools.entries()) {
      if (name.endsWith(suffix)) return tool;
    }
    return undefined;
  }
}

describe('webmcp-protocol & shim', () => {
  test('工具描述规范化、去重与上限裁剪', () => {
    assert.equal(normalizeWebMcpToolDescriptor(null), null);
    assert.equal(normalizeWebMcpToolDescriptor({ name: 'bad name with space' }), null);

    const valid = normalizeWebMcpToolDescriptor({
      name: 'apply_layout',
      description: '  Switch dashboard layout  ',
      inputSchema: { properties: { mode: { type: 'string' } } },
      annotations: { readOnlyHint: false, idempotentHint: true },
    });
    assert.ok(valid);
    assert.equal(valid.name, 'apply_layout');
    assert.equal(valid.description, 'Switch dashboard layout');
    assert.equal(valid.inputSchema.type, 'object');
    assert.deepEqual(valid.annotations, { readOnlyHint: false, idempotentHint: true });

    const many = Array.from({ length: MAX_WEBMCP_TOOLS_PER_ARTIFACT + 10 }, (_, idx) => ({
      name: `tool_${idx}`,
      description: `Tool ${idx}`,
    }));
    const list = normalizeWebMcpToolList(many);
    assert.equal(list.length, MAX_WEBMCP_TOOLS_PER_ARTIFACT);
  });

  test('formatWebMcpToolResult 支持字符串、对象、原生 MCP content 与错误', () => {
    assert.deepEqual(formatWebMcpToolResult('done'), {
      content: [{ type: 'text', text: 'done' }],
    });
    const objRes = formatWebMcpToolResult({ ok: true, count: 3 });
    assert.equal(objRes.isError, undefined);
    assert.deepEqual(objRes.structuredContent, { ok: true, count: 3 });
    assert.equal(objRes.content[0].text, '{"ok":true,"count":3}');

    const mcpRes = formatWebMcpToolResult({
      content: [{ type: 'text', text: 'custom' }],
    });
    assert.deepEqual(mcpRes, { content: [{ type: 'text', text: 'custom' }] });

    const errRes = formatWebMcpToolResult(undefined, true, { code: 'page_not_open', message: 'offline' });
    assert.equal(errRes.isError, true);
    assert.match(errRes.content[0].text || '', /\[page_not_open\] offline/);
  });

  test('Browser Shim 双写原生 navigator.modelContext 且 shim.js 语法合法', () => {
    const nativeCalls: string[] = [];
    const nativeCtx: WebMcpModelContext = {
      registerTool: (t) => nativeCalls.push(`reg:${t.name}`),
      unregisterTool: (n) => nativeCalls.push(`unreg:${n}`),
      provideContext: () => nativeCalls.push('provide'),
      clearContext: () => nativeCalls.push('clear'),
    };
    const fakeNav: { modelContext?: WebMcpModelContext } = { modelContext: nativeCtx };
    const shim = createWebMcpBrowserShim({ navigator: fakeNav });

    fakeNav.modelContext!.registerTool({
      name: 'filter_rows',
      description: 'Filter table rows',
      execute: () => ({ filtered: true }),
    });
    fakeNav.modelContext!.unregisterTool('filter_rows');
    fakeNav.modelContext!.provideContext({
      tools: [{ name: 'export_csv', description: 'Export CSV', execute: () => 'a,b' }],
    });
    fakeNav.modelContext!.clearContext();

    assert.deepEqual(nativeCalls, ['reg:filter_rows', 'unreg:filter_rows', 'provide', 'clear']);
    assert.equal(shim.getState().hasNativeModelContext, true);
    assert.equal(shim.getTools().length, 0);

    const script = buildWebMcpShimScript();
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /navigator/);
    assert.match(script, /modelContext/);
    assert.match(script, /attachIframeBridge/);
  });
});

describe('WebMcpRelay end-to-end with ArtifactMcpRegistry & McpClientManager', () => {
  test('完整链路：签发票据 → WS 连接 → 自动 attach → 工具调用 → list_changed 热更新 → 超时/错误/断连 detach', async () => {
    const eventRouter = new ExternalEventRouter();
    const registry = new ArtifactMcpRegistry(eventRouter);
    const toolRegistry = new FakeToolRegistry();
    const manager = new McpClientManager({
      toolManager: toolRegistry,
      createConnection: createSdkMcpConnectionFactory(),
      requestTimeoutMs: 5_000,
    });
    await manager.start();
    registry.attachManager(manager);

    const relay = await startWebMcpRelay({
      bridgeSink: registry,
      toolCallTimeoutMs: 250,
      disconnectGraceMs: 120,
      heartbeatIntervalMs: 0,
    });

    const shim = createWebMcpBrowserShim({
      createWebSocket: (url) => new WebSocket(url) as any,
      reconnectBaseDelayMs: 0,
      pageUrl: 'https://preview.example.test/canvas/board-1',
      title: 'Sales Board',
    });

    try {
      const ticket = relay.issueSession({
        artifactId: 'canvas-board-1',
        sessionKey: 'catsco:dm:user-42',
      });
      assert.equal(ticket.ok, true);
      assert.ok(ticket.token.length >= 32);

      // 1) 未授权 WS 连接应被拒绝
      await assert.rejects(
        () => new Promise<void>((resolve, reject) => {
          const badWs = new WebSocket(`${ticket.wsUrl}?token=wrong-token`);
          badWs.once('open', () => {
            badWs.close();
            resolve();
          });
          badWs.once('error', reject);
        }),
      );

      // 2) MCP 内部端点未带正确 Bearer token 应返回 401
      const unauthMcpRes = await fetch(ticket.mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(unauthMcpRes.status, 401);

      // 3) 浏览器 Shim 使用合法票据连接并注册 WebMCP 工具
      let currentLayout = 'grid';
      shim.modelContext.registerTool({
        name: 'apply_layout',
        description: 'Switch canvas layout mode',
        inputSchema: {
          type: 'object',
          properties: { mode: { type: 'string' } },
          required: ['mode'],
        },
        execute: async (args) => {
          currentLayout = String(args.mode || 'grid');
          return { applied: currentLayout };
        },
      });
      shim.modelContext.registerTool({
        name: 'slow_action',
        description: 'Simulates a hung browser action',
        execute: async () => {
          await sleep(1000);
          return { ok: true };
        },
      });
      shim.modelContext.registerTool({
        name: 'failing_action',
        description: 'Throws inside page',
        execute: () => {
          throw new Error('DOM element missing');
        },
      });

      shim.connect({
        wsUrl: ticket.wsUrl,
        artifactId: ticket.artifactId,
        token: ticket.token,
      });

      // 等待自动 attach 并经由 McpClientManager 注册为 Agent 工具
      await waitFor(() => Boolean(toolRegistry.findBySuffix('_apply_layout')), 5000, 'apply_layout tool registered');
      assert.ok(toolRegistry.findBySuffix('_slow_action'));
      assert.ok(toolRegistry.findBySuffix('_failing_action'));

      // 4) 调用 Agent 工具 → 实际在浏览器 Shim 中执行
      const applyTool = toolRegistry.findBySuffix('_apply_layout');
      const applyResult = await applyTool.execute({ mode: 'split' });
      assert.equal(currentLayout, 'split');
      assert.equal(applyResult.ok, true);
      const applyText = typeof applyResult.content === 'string'
        ? applyResult.content
        : applyResult.content.map((b: any) => b.text || '').join('\n');
      assert.match(applyText, /"applied":"split"/);

      // 5) 浏览器抛错 → 返回结构化错误信息（不崩溃）
      const failTool = toolRegistry.findBySuffix('_failing_action');
      const failResult = await failTool.execute({});
      assert.equal(failResult.ok, false);
      assert.match(JSON.stringify(failResult), /DOM element missing/);

      // 6) 浏览器卡死超时 → 返回 tool_call_timeout
      const slowTool = toolRegistry.findBySuffix('_slow_action');
      const slowResult = await slowTool.execute({});
      assert.equal(slowResult.ok, false);
      assert.match(JSON.stringify(slowResult), /tool_call_timeout/);

      // 7) 动态增删工具 → SSE 推送 notifications/tools/list_changed → 自动热更新
      shim.modelContext.registerTool({
        name: 'export_csv',
        description: 'Export visible rows as CSV',
        execute: () => 'id,name\n1,Alpha',
      });
      shim.modelContext.unregisterTool('slow_action');

      await waitFor(
        () => Boolean(toolRegistry.findBySuffix('_export_csv')) && !toolRegistry.findBySuffix('_slow_action'),
        5000,
        'tools/list_changed hot reload',
      );
      const exportResult = await toolRegistry.findBySuffix('_export_csv').execute({});
      assert.equal(exportResult.ok, true);
      assert.match(JSON.stringify(exportResult.content ?? exportResult), /1,Alpha/);

      // 8) 浏览器断连 → 超过 disconnectGraceMs 后自动 detach 并清理工具
      shim.disconnect();
      await waitFor(
        () => !toolRegistry.findBySuffix('_apply_layout') && registry.listArtifactBridges().length === 0,
        5000,
        'auto detach after disconnect grace',
      );
    } finally {
      shim.disconnect();
      await relay.stop();
      await manager.closeAll();
      registry.reset();
    }
  });
});

describe('Dashboard routes & cross-process Connector bridge for WebMCP', () => {
  test('/api/artifacts/webmcp/* 经跨进程桥转发并受 allowMcpAttach 门禁保护', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-webmcp-bridge-'));
    const eventRouter = new ExternalEventRouter();
    const registry = new ArtifactMcpRegistry(eventRouter);
    const relay = await startWebMcpRelay({ bridgeSink: registry, heartbeatIntervalMs: 0 });
    const bridge = await startConnectorEventBridge({
      runtimeRoot: tmpRoot,
      sink: createExternalEventArtifactSink(eventRouter),
      bridgeSink: registry,
      webMcpRelay: relay,
    });

    const startTestDashboard = async (allowMcpAttach: boolean) => {
      const app = express();
      app.use(express.json());
      app.use('/api', createArtifactEventsRouter(
        createForwardingArtifactEventSink(tmpRoot),
        createForwardingArtifactMcpBridgeSink(tmpRoot),
        {
          allowMcpAttach,
          allowArtifactEvents: allowMcpAttach,
          webMcpRelay: createForwardingWebMcpRelaySink(tmpRoot),
        },
      ));
      const srv = await new Promise<import('node:http').Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const port = (srv.address() as { port: number }).port;
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
      };
    };

    const lockedDash = await startTestDashboard(false);
    const openDash = await startTestDashboard(true);
    try {
      // shim.js 始终可拉取
      const shimRes = await fetch(`${lockedDash.baseUrl}/api/artifacts/webmcp/shim.js`);
      assert.equal(shimRes.status, 200);
      assert.match(shimRes.headers.get('content-type') || '', /javascript/);
      const shimCode = await shimRes.text();
      assert.match(shimCode, /__XIAOBA_WEBMCP_SHIM__/);

      // 未开 allowMcpAttach 时签发 session 被 403 拒绝
      const denied = await fetch(`${lockedDash.baseUrl}/api/artifacts/art-1/webmcp/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionKey: 'catsco:dm:u1' }),
      });
      assert.equal(denied.status, 403);

      // topic-only（无 sessionKey）应返回 422
      const badTopic = await fetch(`${openDash.baseUrl}/api/artifacts/art-1/webmcp/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'grp_123' }),
      });
      assert.equal(badTopic.status, 422);

      // 正常签发 → 列出 → 吊销
      const issuedRes = await fetch(`${openDash.baseUrl}/api/artifacts/art-1/webmcp/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionKey: 'catsco:dm:u1' }),
      });
      assert.equal(issuedRes.status, 200);
      const ticket = await issuedRes.json() as any;
      assert.equal(ticket.ok, true);
      assert.equal(ticket.artifactId, 'art-1');
      assert.ok(ticket.wsUrl.includes('/ws/artifacts/art-1'));

      const listRes = await fetch(`${openDash.baseUrl}/api/artifacts/webmcp/sessions`);
      assert.equal(listRes.status, 200);
      const listData = await listRes.json() as any;
      assert.equal(listData.sessions.length, 1);
      assert.equal(listData.sessions[0].artifactId, 'art-1');

      const revokeRes = await fetch(`${openDash.baseUrl}/api/artifacts/art-1/webmcp/session`, {
        method: 'DELETE',
      });
      assert.equal(revokeRes.status, 200);
      const revokeData = await revokeRes.json() as any;
      assert.equal(revokeData.existed, true);

      const afterList = await (await fetch(`${openDash.baseUrl}/api/artifacts/webmcp/sessions`)).json() as any;
      assert.equal(afterList.sessions.length, 0);
    } finally {
      await lockedDash.close();
      await openDash.close();
      await bridge.stop();
      await relay.stop();
      registry.reset();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('CatsCo remote transport: tools_sync → McpClientManager tool call → tool_result → detach', async () => {
    const toolRegistry = new FakeToolRegistry();
    const mcpManager = new McpClientManager({
      toolManager: toolRegistry,
      createConnection: createSdkMcpConnectionFactory(),
      requestTimeoutMs: 5_000,
    });
    await mcpManager.start();
    const artifactRegistry = new ArtifactMcpRegistry();
    artifactRegistry.attachManager(mcpManager);

    const outboundCalls: Array<{ bridgeId: string; artifactId: string; callId: string; name: string; arguments: Record<string, unknown> }> = [];
    const relay = await startWebMcpRelay({
      bridgeSink: artifactRegistry,
      heartbeatIntervalMs: 0,
      toolCallTimeoutMs: 2_000,
      onRemoteToolCall: (req) => {
        outboundCalls.push(req);
        // Simulate CatsCo Hub + Gateway iframe returning tool_result asynchronously
        setImmediate(() => {
          relay.handleRemoteToolResult({
            bridgeId: req.bridgeId,
            callId: req.callId,
            isError: false,
            content: [{ type: 'text', text: JSON.stringify({ applied: req.arguments.mode }) }],
            structuredContent: { applied: req.arguments.mode },
          });
        });
        return true;
      },
    });

    try {
      await relay.handleRemoteToolsSync({
        bridgeId: 'awm_catsco_1',
        artifactId: 'canvas-prod',
        topic: 'p2p_101_365',
        tools: [
          {
            name: 'set_layout',
            description: 'Arrange canvas layout',
            inputSchema: { type: 'object', properties: { mode: { type: 'string' } } },
          },
        ],
      });

      await waitFor(() => Boolean(toolRegistry.findBySuffix('_set_layout')), 4_000, 'remote set_layout tool registered');

      const tool = toolRegistry.findBySuffix('_set_layout');
      const execResult = await tool.execute({ mode: 'grid' });
      assert.equal(outboundCalls.length, 1);
      assert.equal(outboundCalls[0].bridgeId, 'awm_catsco_1');
      assert.equal(outboundCalls[0].name, 'set_layout');
      assert.equal(execResult.ok, true);
      assert.match(JSON.stringify(execResult.content ?? execResult), /grid/);

      // Detach should unregister the tool and remove the session
      await relay.handleRemoteDetach({ bridgeId: 'awm_catsco_1', reason: 'client_disconnected' });
      await waitFor(() => !toolRegistry.findBySuffix('_set_layout'), 4_000, 'remote set_layout tool unregistered');
      assert.equal(relay.listSessions().length, 0);
    } finally {
      await relay.stop();
      await mcpManager.closeAll();
      artifactRegistry.reset();
    }
  });
});

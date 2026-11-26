/**
 * WebMCP Artifact Relay 端到端集成测试（生产 CatsCo `artifact_webmcp` 双向传输模式）。
 *
 * 覆盖：
 * 1. 协议规范化、48 KiB UTF-8 字节上限、untrusted description / tool output 边界标记；
 * 2. CatsCo 远端传输全链路：tools_sync → McpClientManager 挂载 → tool_call/tool_result →
 *    tools/list_changed 热更新 → 超时/错误保护 → detach 清理；
 * 3. 多用户隔离回归（X1 & X2）：
 *    - 用户 A 与用户 B 同时打开同一 Artifact（canvas）时按 bridge_id 独立建槽；
 *    - 各会话调用各自工具互不串台，跨会话调用被 session_scope_mismatch 拦截；
 *    - 用户 B detach 仅卸载 awm_B，不影响用户 A 的 awm_A。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  normalizeWebMcpToolDescriptor,
  normalizeWebMcpToolList,
  labelUntrustedWebMcpDescription,
  formatWebMcpToolResult,
  MAX_WEBMCP_TOOLS_PER_ARTIFACT,
  MAX_WEBMCP_PAYLOAD_BYTES,
} from '../src/mcp/webmcp-protocol';
import {
  startWebMcpRelay,
} from '../src/mcp/webmcp-relay';
import { ArtifactMcpRegistry } from '../src/mcp/artifact-mcp-registry';
import {
  McpClientManager,
  type McpToolRegistry,
} from '../src/mcp/mcp-client-manager';
import { createSdkMcpConnectionFactory } from '../src/mcp/mcp-persistent-client';

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
  findAllBySuffix(suffix: string): any[] {
    const out: any[] = [];
    for (const [name, tool] of this.tools.entries()) {
      if (name.endsWith(suffix)) out.push(tool);
    }
    return out;
  }
}

describe('webmcp-protocol', () => {
  test('工具描述规范化、去重、上限裁剪与 untrusted 标注', () => {
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

    const labeled = labelUntrustedWebMcpDescription(valid.description, 'canvas');
    assert.match(labeled, /Untrusted Artifact Page Tool \(canvas\)/);
    assert.match(labeled, /Switch dashboard layout/);

    const many = Array.from({ length: MAX_WEBMCP_TOOLS_PER_ARTIFACT + 10 }, (_, idx) => ({
      name: `tool_${idx}`,
      description: `Tool ${idx}`,
    }));
    const list = normalizeWebMcpToolList(many);
    assert.equal(list.length, MAX_WEBMCP_TOOLS_PER_ARTIFACT);
  });

  test('formatWebMcpToolResult 包裹 untrusted 标签并强制 48 KiB UTF-8 上限', () => {
    const ok = formatWebMcpToolResult({ applied: 'grid' }, false, undefined, {
      artifactId: 'canvas',
      toolName: 'set_layout',
    });
    assert.equal(ok.isError, undefined);
    assert.match(ok.content[0].text ?? '', /^<untrusted_artifact_tool_output artifact="canvas" tool="set_layout">/);
    assert.match(ok.content[0].text ?? '', /"applied":"grid"/);

    // 20,000 CJK chars = 60,000 UTF-8 bytes > 48 KiB
    assert.equal(MAX_WEBMCP_PAYLOAD_BYTES, 48 * 1024);
    const tooBig = formatWebMcpToolResult('中'.repeat(20_000), false, undefined, {
      artifactId: 'canvas',
      toolName: 'dump',
    });
    assert.equal(tooBig.isError, true);
    assert.match(tooBig.content[0].text ?? '', /result_too_large/);
  });
});

describe('WebMcpRelay CatsCo remote transport', () => {
  test('全链路：tools_sync → McpClientManager 工具调用 → 热更新 → 超时/错误 → detach', async () => {
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
      toolCallTimeoutMs: 250,
      onRemoteToolCall: (req) => {
        outboundCalls.push(req);
        if (req.name === 'slow_action') {
          // Never respond -> should hit toolCallTimeoutMs
          return true;
        }
        setImmediate(() => {
          if (req.name === 'failing_action') {
            relay.handleRemoteToolResult({
              bridgeId: req.bridgeId,
              callId: req.callId,
              isError: true,
              error: { code: 'tool_execution_error', message: 'DOM element missing' },
            });
            return;
          }
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
        sessionKey: 'catscompany:p2p:p2p_101_365:101',
        tools: [
          {
            name: 'set_layout',
            description: 'Arrange canvas layout',
            inputSchema: { type: 'object', properties: { mode: { type: 'string' } } },
          },
          { name: 'slow_action', description: 'Hangs' },
          { name: 'failing_action', description: 'Fails' },
        ],
      });

      await waitFor(() => Boolean(toolRegistry.findBySuffix('_set_layout')), 4_000, 'remote set_layout tool registered');

      const tool = toolRegistry.findBySuffix('_set_layout');
      assert.match(tool.definition.description, /Untrusted Artifact Page Tool \(canvas-prod\)/);

      const execResult = await tool.execute({ mode: 'grid' }, {
        executionScope: {
          sessionKey: 'catscompany:p2p:p2p_101_365:101',
          topicId: 'p2p_101_365',
          topicType: 'p2p',
          actorUserId: '101',
        },
      });
      assert.equal(outboundCalls.length, 1);
      assert.equal(outboundCalls[0].bridgeId, 'awm_catsco_1');
      assert.equal(execResult.ok, true);
      assert.match(JSON.stringify(execResult.content ?? execResult), /untrusted_artifact_tool_output/);
      assert.match(JSON.stringify(execResult.content ?? execResult), /grid/);

      // Error propagation
      const failResult = await toolRegistry.findBySuffix('_failing_action').execute({});
      assert.equal(failResult.ok, false);
      assert.match(JSON.stringify(failResult), /DOM element missing/);

      // Timeout protection
      const slowResult = await toolRegistry.findBySuffix('_slow_action').execute({});
      assert.equal(slowResult.ok, false);
      assert.match(JSON.stringify(slowResult), /tool_call_timeout/);

      // Hot reload via tools_sync -> SSE notifications/tools/list_changed
      await relay.handleRemoteToolsSync({
        bridgeId: 'awm_catsco_1',
        artifactId: 'canvas-prod',
        topic: 'p2p_101_365',
        sessionKey: 'catscompany:p2p:p2p_101_365:101',
        tools: [
          { name: 'set_layout', description: 'Arrange canvas layout' },
          { name: 'export_csv', description: 'Export visible rows' },
        ],
      });
      await waitFor(
        () => Boolean(toolRegistry.findBySuffix('_export_csv')) && !toolRegistry.findBySuffix('_slow_action'),
        4_000,
        'tools/list_changed hot reload',
      );

      // Detach cleans up tools and session
      await relay.handleRemoteDetach({ bridgeId: 'awm_catsco_1', reason: 'client_disconnected' });
      await waitFor(() => !toolRegistry.findBySuffix('_set_layout'), 4_000, 'remote set_layout tool unregistered');
      assert.equal(relay.listSessions().length, 0);
    } finally {
      await relay.stop();
      await mcpManager.closeAll();
      artifactRegistry.reset();
    }
  });

  test('X1 & X2 多用户隔离：同 artifactId 按 bridge_id 隔离、跨会话调用被拒、单方 detach 不影响他人', async () => {
    const toolRegistry = new FakeToolRegistry();
    const mcpManager = new McpClientManager({
      toolManager: toolRegistry,
      createConnection: createSdkMcpConnectionFactory(),
      requestTimeoutMs: 5_000,
    });
    await mcpManager.start();
    const artifactRegistry = new ArtifactMcpRegistry();
    artifactRegistry.attachManager(mcpManager);

    const routedCalls: Array<{ bridgeId: string; topic?: string }> = [];
    const relay = await startWebMcpRelay({
      bridgeSink: artifactRegistry,
      toolCallTimeoutMs: 2_000,
      onRemoteToolCall: (req) => {
        routedCalls.push({ bridgeId: req.bridgeId, topic: req.topic });
        setImmediate(() => {
          relay.handleRemoteToolResult({
            bridgeId: req.bridgeId,
            callId: req.callId,
            isError: false,
            content: [{ type: 'text', text: `state_from_${req.bridgeId}` }],
          });
        });
        return true;
      },
    });

    try {
      // User A and User B both open the exact same artifact ("canvas")
      await relay.handleRemoteToolsSync({
        bridgeId: 'awm_A',
        artifactId: 'canvas',
        topic: 'p2p_101_365',
        sessionKey: 'catscompany:p2p:p2p_101_365:101',
        tools: [{ name: 'get_state', description: 'Read canvas state' }],
      });
      await relay.handleRemoteToolsSync({
        bridgeId: 'awm_B',
        artifactId: 'canvas',
        topic: 'p2p_202_365',
        sessionKey: 'catscompany:p2p:p2p_202_365:202',
        tools: [{ name: 'get_state', description: 'Read canvas state' }],
      });

      await waitFor(() => toolRegistry.findAllBySuffix('_get_state').length === 2, 4_000, 'both user tools registered');
      assert.equal(relay.listSessions().length, 2);

      const sessions = relay.listSessions();
      const sessionA = sessions.find((s) => s.bridgeId === 'awm_A')!;
      const sessionB = sessions.find((s) => s.bridgeId === 'awm_B')!;
      const toolA = toolRegistry.tools.get(`mcp_${sessionA.serverId}_get_state`);
      const toolB = toolRegistry.tools.get(`mcp_${sessionB.serverId}_get_state`);
      assert.ok(toolA && toolB, 'each bridge must have its own distinct tool registration');

      const scopeA = {
        executionScope: {
          sessionKey: 'catscompany:p2p:p2p_101_365:101',
          topicId: 'p2p_101_365',
          topicType: 'p2p' as const,
          actorUserId: '101',
        },
      };

      // User A calling User A's tool routes strictly to awm_A
      const resA = await toolA.execute({}, scopeA);
      assert.equal(resA.ok, true);
      assert.match(JSON.stringify(resA.content ?? resA), /state_from_awm_A/);
      assert.equal(routedCalls.at(-1)?.bridgeId, 'awm_A');

      // User A attempting to invoke User B's tool is blocked by session_scope_mismatch
      const crossCall = await toolB.execute({}, scopeA);
      assert.equal(crossCall.ok, false);
      assert.equal(crossCall.errorCode, 'session_scope_mismatch');
      assert.equal(routedCalls.length, 1, 'cross-session call must never reach awm_B');

      // X2: User B detaching awm_B must NOT tear down User A's awm_A
      await relay.handleRemoteDetach({ bridgeId: 'awm_B', reason: 'client_disconnected' });
      await waitFor(() => !toolRegistry.tools.has(`mcp_${sessionB.serverId}_get_state`), 4_000, 'awm_B unregistered');
      assert.ok(toolRegistry.tools.has(`mcp_${sessionA.serverId}_get_state`), 'awm_A tool must remain registered');
      assert.equal(relay.listSessions().length, 1);

      const resAAfterBDetach = await toolA.execute({}, scopeA);
      assert.equal(resAAfterBDetach.ok, true);
      assert.match(JSON.stringify(resAAfterBDetach.content ?? resAAfterBDetach), /state_from_awm_A/);
    } finally {
      await relay.stop();
      await mcpManager.closeAll();
      artifactRegistry.reset();
    }
  });
});

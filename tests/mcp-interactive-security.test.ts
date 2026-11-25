/**
 * Track 3：MCP Interactive / Tasks / OAuth 2.1 / Security 综合测试。
 *
 * 覆盖：
 * - MRTR input_required 挂起 → 用户回答 → requestState/inputResponses 重试
 * - legacy elicitation/create（form + url 域名安全校验）+ 文本降级
 * - MCP tasks 终态 → ExternalEventRouter 唤醒 + input_required 交接 + cancel
 * - sampling allowlist / token cap / 默认拒绝；roots 对齐 ExecutionScope/device-grants
 * - OAuth 2.1 PKCE + 403 insufficient_scope step-up + CatsCo grant 注入
 * - 群聊 actorUserId !== ownerUserId 拒绝 + 通知限流
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { McpInteractionBroker, validateElicitationUrl, parseUserInputContent } from '../src/mcp/mcp-interaction-broker';
import type { InteractionDelivery } from '../src/mcp/mcp-interaction-broker';
import { McpTasksBridge } from '../src/mcp/mcp-tasks-bridge';
import { McpSamplingController, buildScopedRoots, pathToFileUri } from '../src/mcp/mcp-sampling-roots';
import { CatsCoMcpOAuthProvider } from '../src/mcp/mcp-oauth-provider';
import {
  McpSecurityPolicy,
  NotificationRateLimiter,
  SessionScopeAllowlist,
  evaluateServerAccess,
  isOwnerOnlyServer,
} from '../src/mcp/mcp-security-policy';
import { McpClientManager, extractInputRequiredResult } from '../src/mcp/mcp-client-manager';
import type { McpConnection } from '../src/mcp/mcp-persistent-client';
import { ExternalEventRouter, type ExternalEventDispatch } from '../src/events/external-event-router';
import type { Tool } from '../src/types/tool';
import type { ExecutionScope } from '../src/types/session-identity';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

function flushMicrotasks(rounds = 5): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) chain = chain.then(() => new Promise<void>((r) => setImmediate(r)));
  return chain;
}

function makeScope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'cc_group:bot1:grp1',
    topicId: 'grp_1',
    topicType: 'group',
    actorUserId: 'usr_actor',
    identityTrust: 'server_canonical',
    isTrusted: true,
    deviceOwnerUserId: 'usr_owner',
    ...overrides,
  };
}

function fakeConnection(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    close: async () => {},
    listTools: async () => ({ tools: [{ name: 'do_thing', description: 'x' }] }),
    callTool: async () => ({ isError: false, content: [{ type: 'text', text: 'ok' }] }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    subscribeResource: async () => {},
    unsubscribeResource: async () => {},
    listPrompts: async () => ({ prompts: [] }),
    getPrompt: async () => ({}),
    ...overrides,
  } as McpConnection;
}

function createManagerHarness(connectionOverrides: Partial<McpConnection>, managerOptions: Record<string, unknown> = {}) {
  const registeredTools = new Map<string, Tool>();
  const manager = new McpClientManager({
    toolManager: {
      registerTool: (tool) => registeredTools.set(tool.definition.name, tool),
      unregisterTool: (name) => registeredTools.delete(name),
    },
    servers: {
      srv: { transport: 'streamable-http', url: 'https://mcp.example.test/mcp' },
    },
    createConnection: () => fakeConnection(connectionOverrides),
    ...managerOptions,
  } as ConstructorParameters<typeof McpClientManager>[0]);
  return { manager, registeredTools };
}

// ---------------------------------------------------------------- MRTR

describe('MRTR input_required 挂起与重试', () => {
  test('input_required → 用户回答 → 携带 requestState/inputResponses 重试并返回终态', async () => {
    const sentTexts: Array<{ sessionKey: string; text: string }> = [];
    const broker = new McpInteractionBroker({
      timeoutMs: 5_000,
      sendText: (sessionKey, text) => { sentTexts.push({ sessionKey, text }); },
    });

    const calls: Array<Record<string, unknown>> = [];
    const { manager, registeredTools } = createManagerHarness({
      callTool: async (params) => {
        calls.push({ ...(params.arguments ?? {}), __name: params.name } as Record<string, unknown>);
        if (calls.length === 1) {
          return {
            content: [],
            resultType: 'input_required',
            requestState: 'state-token-abc',
            inputRequests: [
              { requestId: 'req-1', kind: 'text', message: '请提供部署目标环境' },
            ],
          } as never;
        }
        return { isError: false, content: [{ type: 'text', text: 'deployed to prod' }] } as never;
      },
    }, { interactionBroker: broker });

    manager.start();
    await manager.waitForInitialConnect();
    await manager.refreshServerTools('srv');
    const tool = registeredTools.get('mcp_srv_do_thing');
    assert.ok(tool, 'remote tool should be registered');

    const scope = makeScope({ topicType: 'p2p', actorUserId: 'usr_owner', deviceOwnerUserId: 'usr_owner', sessionKey: 'cc_user:bot1:usr_owner' });
    const execPromise = tool.execute({ env: 'ask' }, { workingDirectory: '/tmp', conversationHistory: [], executionScope: scope });

    // 等第一轮调用 + 交互挂起 + 文本降级投递完成
    await flushMicrotasks();
    assert.equal(sentTexts.length, 1, 'fallback text should be delivered');
    assert.ok(sentTexts[0].text.includes('部署目标环境'), 'prompt should carry server message');
    assert.equal(broker.hasPendingForSession(scope.sessionKey), true);

    // 用户在会话里回复 → broker 消费 → 触发重试
    assert.equal(broker.handleUserMessage(scope.sessionKey, 'production'), true);
    const result = await execPromise;

    assert.equal(calls.length, 2, 'original call + one retry');
    assert.equal(calls[1].requestState, 'state-token-abc', 'retry must carry opaque requestState');
    const responses = calls[1].inputResponses as Array<{ requestId: string; action: string; content: Record<string, unknown> }>;
    assert.ok(Array.isArray(responses), 'retry must carry inputResponses');
    assert.equal(responses[0].requestId, 'req-1');
    assert.equal(responses[0].action, 'accept');
    assert.equal(responses[0].content['req-1'], 'production');
    assert.equal(result.ok, true);
    assert.ok(String(result.ok ? result.content : '').includes('deployed to prod'));

    await manager.closeAll();
    broker.dispose();
  });

  test('structuredContent 里的 input_required 也能识别', () => {
    const extracted = extractInputRequiredResult({
      content: [],
      structuredContent: {
        resultType: 'input_required',
        requestState: 'st',
        inputRequests: [{ requestId: 'r1' }],
      },
    });
    assert.ok(extracted);
    assert.equal(extracted.requestState, 'st');
    assert.equal(extractInputRequiredResult({ content: [] }), undefined);
  });

  test('用户取消 → 工具调用以 mcp_input_cancelled 失败返回', async () => {
    const broker = new McpInteractionBroker({ timeoutMs: 5_000, sendText: () => {} });
    const { manager, registeredTools } = createManagerHarness({
      callTool: async () => ({
        content: [],
        resultType: 'input_required',
        requestState: 'state-xyz',
        inputRequests: [{ requestId: 'req-1', kind: 'text', message: '确认?' }],
      }) as never,
    }, { interactionBroker: broker });

    manager.start();
    await manager.waitForInitialConnect();
    await manager.refreshServerTools('srv');
    const tool = registeredTools.get('mcp_srv_do_thing')!;
    const scope = makeScope({ topicType: 'p2p', actorUserId: 'u1', deviceOwnerUserId: 'u1', sessionKey: 'sess-u1' });
    const execPromise = tool.execute({}, { workingDirectory: '/tmp', conversationHistory: [], executionScope: scope });
    await flushMicrotasks();
    broker.handleUserMessage('sess-u1', '取消');
    const result = await execPromise;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.errorCode, 'mcp_input_cancelled');
    await manager.closeAll();
    broker.dispose();
  });
});

// ---------------------------------------------------------------- elicitation/create

describe('elicitation/create（form + url + 文本降级）', () => {
  test('form 模式：卡片通道不可用时降级文本，用户回答被正确解析', async () => {
    const texts: string[] = [];
    const cards: InteractionDelivery[] = [];
    const broker = new McpInteractionBroker({
      timeoutMs: 5_000,
      sendCard: async () => false, // 卡片不可用
      sendText: (_s, text) => { texts.push(text); },
    });

    const promise = broker.handleElicitRequest('srv', {
      mode: 'form',
      message: '请填写发布信息',
      requestedSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', title: '标题' },
          count: { type: 'integer', title: '数量' },
          confirm: { type: 'boolean', title: '确认发布' },
        },
        required: ['title'],
      },
    }, { sessionKey: 'sess-1', topic: 'p2p_1' });

    await flushMicrotasks();
    assert.equal(cards.length, 0);
    assert.equal(texts.length, 1, 'card unavailable → text fallback');
    assert.ok(texts[0].includes('请填写发布信息'));
    assert.ok(texts[0].includes('标题'));
    assert.ok(texts[0].includes('取消'));

    broker.handleUserMessage('sess-1', 'title=发布 v2\ncount=3\nconfirm=是');
    const result = await promise;
    assert.equal(result.action, 'accept');
    assert.deepEqual(result.content, { title: '发布 v2', count: 3, confirm: true });
    broker.dispose();
  });

  test('form 模式：卡片通道可用时优先走 mcp_elicitation 结构化 payload', async () => {
    const deliveries: InteractionDelivery[] = [];
    const texts: string[] = [];
    const broker = new McpInteractionBroker({
      timeoutMs: 5_000,
      sendCard: async (delivery) => { deliveries.push(delivery); return true; },
      sendText: (_s, text) => { texts.push(text); },
    });

    const promise = broker.handleElicitRequest('srv', {
      mode: 'form',
      message: '需要确认',
      requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    }, { sessionKey: 'sess-2' });

    await flushMicrotasks();
    assert.equal(deliveries.length, 1);
    assert.equal(texts.length, 0, 'card delivered → no text fallback');
    const payload = deliveries[0].payload;
    assert.equal(payload.type, 'mcp_elicitation');
    assert.equal(payload.mode, 'form');
    assert.equal(payload.state, 'pending');
    assert.ok(payload.interactionId.startsWith('ix-'));
    assert.equal(payload.fields[0].name, 'ok');

    broker.handleUserMessage('sess-2', '{"ok": true}');
    const result = await promise;
    assert.equal(result.action, 'accept');
    broker.dispose();
  });

  test('url 模式：合法 https 链接 → 接受并投递带 origin 的卡片', async () => {
    const deliveries: InteractionDelivery[] = [];
    const broker = new McpInteractionBroker({
      sendCard: async (delivery) => { deliveries.push(delivery); return true; },
    });
    const result = await broker.handleElicitRequest('srv', {
      mode: 'url',
      message: '请完成网页授权',
      elicitationId: 'el-1',
      url: 'https://accounts.example.com/authorize?client_id=abc',
    }, { sessionKey: 'sess-3' });
    assert.equal(result.action, 'accept');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.urlOrigin, 'https://accounts.example.com');
    assert.equal(deliveries[0].payload.urlTrusted, true);
    broker.dispose();
  });

  test('url 模式：http 非 localhost / 钓鱼域名 → 拒绝且不投递链接', async () => {
    assert.equal(validateElicitationUrl('http://evil.example.com/x').ok, false);
    assert.equal(validateElicitationUrl('https://user:pass@example.com/').ok, false);
    assert.equal(validateElicitationUrl('not a url').ok, false);
    assert.equal(validateElicitationUrl('https://evil.example.com/x', ['example.org']).ok, false);
    assert.equal(validateElicitationUrl('https://api.example.org/x', ['example.org']).ok, true);
    assert.equal(validateElicitationUrl('http://localhost:8080/cb').ok, true);

    const texts: string[] = [];
    const broker = new McpInteractionBroker({
      allowedUrlDomains: ['example.org'],
      sendText: (_s, text) => { texts.push(text); },
    });
    const result = await broker.handleElicitRequest('srv', {
      mode: 'url',
      message: '点这里',
      elicitationId: 'el-2',
      url: 'https://phishing.example.net/steal',
    }, { sessionKey: 'sess-4' });
    assert.equal(result.action, 'decline');
    assert.equal(texts.length, 1);
    assert.ok(!texts[0].includes('phishing.example.net/steal'), '被拒绝的链接不应原样投递');
    broker.dispose();
  });

  test('超时未回答 → cancel 结果，pending 状态被回收', async () => {
    const broker = new McpInteractionBroker({ timeoutMs: 30 });
    const result = await broker.handleElicitRequest('srv', {
      mode: 'form',
      message: '快回答',
      requestedSchema: { type: 'object', properties: {} },
    }, { sessionKey: 'sess-5' });
    assert.equal(result.action, 'cancel');
    assert.equal(broker.pendingCount, 0);
    broker.dispose();
  });

  test('parseUserInputContent：JSON / kv / 单字段 / 纯确认', () => {
    const fields = [
      { name: 'env', type: 'string', required: true },
      { name: 'dryRun', type: 'boolean', required: false },
    ];
    assert.deepEqual(parseUserInputContent('{"env":"prod","dryRun":true}', fields), { env: 'prod', dryRun: true });
    assert.deepEqual(parseUserInputContent('env=staging\ndryRun=true', fields), { env: 'staging', dryRun: true });
    assert.deepEqual(
      parseUserInputContent('production', [{ name: 'env', type: 'string', required: true }]),
      { env: 'production' },
    );
    assert.deepEqual(parseUserInputContent('好的', []), { confirmed: true, text: '好的' });
    assert.deepEqual(parseUserInputContent('yes', [{ name: 'confirm', type: 'boolean', required: true }]), { confirm: true });
  });
});

// ---------------------------------------------------------------- tasks bridge

describe('MCP Tasks 桥接', () => {
  test('终态 completed → ExternalEventRouter 唤醒原会话', async () => {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    const bridge = new McpTasksBridge({ router });

    bridge.trackTask({ serverId: 'srv', taskId: 'task-1', sessionKey: 'sess-t1', topic: 'p2p_1', actorUserId: 'usr_1' });
    const outcome = bridge.handleStatusNotification('srv', { taskId: 'task-1', status: 'completed', statusMessage: 'done' });
    assert.equal(outcome, 'dispatched');
    await router.emitAndWait({
      source: 'catsco:receipt', type: 'x', target: { sessionKey: 'sess-other' }, priority: 'immediate',
    });
    const hit = dispatches.find((d) => d.sessionKey === 'sess-t1');
    assert.ok(hit, 'terminal status should wake originating session');
    assert.equal(hit.topic, 'p2p_1');
    assert.equal(hit.actorUserId, 'usr_1');
    assert.equal(hit.event.type, 'tasks/completed');
    assert.ok(hit.text.includes('已完成'));
    assert.equal(bridge.trackedCount, 0, 'terminal task should be untracked');
    router.reset();
    bridge.dispose();
  });

  test('failed/cancelled 也是终态唤醒；未登记的任务不唤醒任何会话', async () => {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    const bridge = new McpTasksBridge({ router });

    assert.equal(bridge.handleStatusNotification('srv', { taskId: 'ghost', status: 'completed' }), 'untracked');
    bridge.trackTask({ serverId: 'srv', taskId: 'task-f', sessionKey: 'sess-f' });
    assert.equal(bridge.handleStatusNotification('srv', { taskId: 'task-f', status: 'failed', statusMessage: 'boom' }), 'dispatched');
    await flushMicrotasks(2);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].text.includes('失败'));
    router.reset();
    bridge.dispose();
  });

  test('input_required 交接 broker；working 不唤醒', async () => {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const broker = new McpInteractionBroker({});
    const bridge = new McpTasksBridge({ router, broker });
    bridge.trackTask({ serverId: 'srv', taskId: 'task-w', sessionKey: 'sess-w' });
    assert.equal(bridge.handleStatusNotification('srv', { taskId: 'task-w', status: 'working' }), 'working');
    assert.equal(bridge.handleStatusNotification('srv', { taskId: 'task-w', status: 'input_required' }), 'handed_to_broker');
    router.reset();
    bridge.dispose();
    broker.dispose();
  });

  test('cancelTask：调用 tasks/cancel 并唤醒会话告知', async () => {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    const cancelled: string[] = [];
    const bridge = new McpTasksBridge({
      router,
      resolveTasksClient: () => ({
        getTask: async () => ({ taskId: 'task-c', status: 'working' }),
        getTaskResult: async () => ({}),
        cancelTask: async (taskId) => { cancelled.push(taskId); },
      }),
    });
    bridge.trackTask({ serverId: 'srv', taskId: 'task-c', sessionKey: 'sess-c' });
    assert.equal(await bridge.cancelTask('srv', 'task-c'), true);
    assert.deepEqual(cancelled, ['task-c']);
    await flushMicrotasks(2);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].text.includes('已取消'));
    assert.equal(bridge.trackedCount, 0);
    router.reset();
    bridge.dispose();
  });

  test('轮询兜底：working→completed 有界轮询后唤醒', async () => {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    let polls = 0;
    const bridge = new McpTasksBridge({
      router,
      pollingEnabled: true,
      minPollIntervalMs: 5,
      sleep: async () => {},
      resolveTasksClient: () => ({
        getTask: async (taskId) => {
          polls += 1;
          return { taskId, status: polls >= 3 ? 'completed' : 'working' } as never;
        },
        getTaskResult: async () => ({}),
        cancelTask: async () => {},
      }),
    });
    bridge.trackTask({ serverId: 'srv', taskId: 'task-p', sessionKey: 'sess-p' });
    await flushMicrotasks(20);
    assert.ok(polls >= 3, `expected bounded polling, got ${polls}`);
    assert.ok(dispatches.some((d) => d.sessionKey === 'sess-p'), 'polled terminal should wake session');
    router.reset();
    bridge.dispose();
  });

  test('manager 通知路径：tasks/status 走桥而不走泛化转发', async () => {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    const bridge = new McpTasksBridge({ router });
    const forwarded: string[] = [];
    let capturedHooks: { onNotification?: (n: { method: string; params?: unknown }) => void } | undefined;

    const manager = new McpClientManager({
      toolManager: { registerTool: () => {}, unregisterTool: () => {} },
      servers: { srv: { transport: 'streamable-http', url: 'https://x.test/mcp' } },
      createConnection: (_c, hooks) => {
        capturedHooks = hooks;
        return fakeConnection();
      },
      tasksBridge: bridge,
      onEvent: (event) => forwarded.push(event.method),
    });
    manager.start();
    await manager.waitForInitialConnect();

    bridge.trackTask({ serverId: 'srv', taskId: 'task-m', sessionKey: 'sess-m' });
    capturedHooks!.onNotification!({
      method: 'notifications/tasks/status',
      params: { taskId: 'task-m', status: 'completed' },
    });
    await flushMicrotasks(3);
    assert.ok(dispatches.some((d) => d.sessionKey === 'sess-m'), 'terminal routed via bridge');
    assert.deepEqual(forwarded, [], 'tracked task terminal should not double-forward to generic path');

    capturedHooks!.onNotification!({
      method: 'notifications/tasks/status',
      params: { taskId: 'untracked-task', status: 'completed' },
    });
    await flushMicrotasks(2);
    assert.deepEqual(forwarded, ['notifications/tasks/status'], 'untracked falls through to generic path');

    await manager.closeAll();
    router.reset();
    bridge.dispose();
  });
});

// ---------------------------------------------------------------- sampling & roots

describe('受控 Sampling', () => {
  const baseParams = {
    messages: [{ role: 'user' as const, content: { type: 'text', text: '总结这段文本' } }],
    maxTokens: 100_000,
  };

  test('默认拒绝：不在 allowlist 的 server 一律 denied', async () => {
    const controller = new McpSamplingController({
      chat: async () => ({ content: 'summary' }),
    });
    assert.equal(controller.capable, false, 'empty allowlist = no capability');
    await assert.rejects(() => controller.handleCreateMessage('srv', baseParams), /not on the sampling allowlist|backend unavailable/);
  });

  test('allowlist 内 server 可采样，maxTokens 被封顶', async () => {
    const seen: Array<{ systemPrompt?: string }> = [];
    const controller = new McpSamplingController({
      allowlist: ['srv'],
      maxTokensPerCall: 512,
      chat: async (_msgs, opts) => { seen.push(opts); return { content: 'summary', model: 'test-model' }; },
    });
    assert.equal(controller.capable, true);
    const gate = controller.checkGate('srv', 100_000);
    assert.equal(gate.allowed, true);
    if (gate.allowed) assert.equal(gate.effectiveMaxTokens, 512, 'token cap enforced');

    const result = await controller.handleCreateMessage('srv', { ...baseParams, systemPrompt: 'sys' });
    assert.equal(result.role, 'assistant');
    assert.equal(result.content.text, 'summary');
    assert.equal(result.model, 'test-model');
    assert.equal(seen[0].systemPrompt, 'sys');
  });

  test('turn 与 minute 限额：超限拒绝', async () => {
    const controller = new McpSamplingController({
      allowlist: ['srv'],
      maxCallsPerTurn: 2,
      maxCallsPerMinute: 3,
      chat: async () => ({ content: 'x' }),
    });
    await controller.handleCreateMessage('srv', baseParams);
    await controller.handleCreateMessage('srv', baseParams);
    await assert.rejects(() => controller.handleCreateMessage('srv', baseParams), /turn limit/);
    controller.endTurn('srv');
    await controller.handleCreateMessage('srv', baseParams);
    await assert.rejects(() => controller.handleCreateMessage('srv', baseParams), /per-minute limit/);
  });

  test('审批回调否决 → 拒绝', async () => {
    const controller = new McpSamplingController({
      allowlist: ['srv'],
      approvalCallback: async () => false,
      chat: async () => ({ content: 'x' }),
    });
    await assert.rejects(() => controller.handleCreateMessage('srv', baseParams), /approval rejected/);
  });

  test('manager 只在 allowSampling 配置下接线 sampling handler', async () => {
    let capturedHooks: Record<string, unknown> | undefined;
    const mkManager = (allowSampling: boolean) => new McpClientManager({
      toolManager: { registerTool: () => {}, unregisterTool: () => {} },
      servers: { srv: { transport: 'streamable-http', url: 'https://x.test/mcp', allowSampling } },
      createConnection: (_c, hooks) => {
        capturedHooks = hooks as unknown as Record<string, unknown>;
        return fakeConnection();
      },
      samplingController: new McpSamplingController({ allowlist: ['srv'], chat: async () => ({ content: 'x' }) }),
    });
    const m1 = mkManager(true);
    m1.start();
    await m1.waitForInitialConnect();
    assert.ok(capturedHooks?.onSamplingCreateMessage, 'allowSampling=true wires handler');
    await m1.closeAll();

    capturedHooks = undefined;
    const m2 = mkManager(false);
    m2.start();
    await m2.waitForInitialConnect();
    assert.equal(capturedHooks?.onSamplingCreateMessage, undefined, 'default = no sampling capability');
    await m2.closeAll();
  });
});

describe('Roots 对齐 ExecutionScope / device-grants', () => {
  test('根 = 会话 workingDirectory，绝不暴露文件系统根', () => {
    const roots = buildScopedRoots({ workingDirectory: '/Users/x/project' });
    assert.equal(roots.length, 1);
    assert.equal(roots[0].uri, 'file:///Users/x/project');
    const rootAttempt = buildScopedRoots({ workingDirectory: '/' });
    assert.equal(rootAttempt.length, 0, 'filesystem root must never be exposed');
  });

  test('ownerOnly server + 群聊非 owner → 空根列表', () => {
    const roots = buildScopedRoots({
      workingDirectory: '/Users/x/project',
      riskProfile: { oauthBacked: true },
      scope: makeScope(),
    });
    assert.equal(roots.length, 0);
    const ownerRoots = buildScopedRoots({
      workingDirectory: '/Users/x/project',
      riskProfile: { oauthBacked: true },
      scope: makeScope({ actorUserId: 'usr_owner' }),
    });
    assert.equal(ownerRoots.length, 1);
  });

  test('pathToFileUri 转义与 extraRoots 去重', () => {
    assert.equal(pathToFileUri('/tmp/a b'), 'file:///tmp/a%20b');
    const roots = buildScopedRoots({
      workingDirectory: '/tmp/ws',
      extraRoots: ['/tmp/ws', '/tmp/extra'],
    });
    assert.equal(roots.length, 2, 'duplicates collapsed');
  });
});

// ---------------------------------------------------------------- OAuth 2.1

describe('OAuth 2.1 Provider', () => {
  test('PKCE S256 + 授权码交换 + insufficient_scope step-up', async () => {
    // 内存授权服务器：metadata 发现 + token 交换（校验 code_verifier 与 scope）
    const seenTokenRequests: Array<Record<string, string>> = [];
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json({
        issuer: issuerUrl,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
        registration_endpoint: `${issuerUrl}/register`,
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    });
    app.post('/register', (req, res) => {
      // RFC 7591：注册响应回显客户端元数据 + client_id。
      res.status(201).json({
        ...(req.body as Record<string, unknown>),
        client_id: 'dyn-client-1',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
    });
    app.post('/token', (req, res) => {
      const body = req.body as Record<string, string>;
      seenTokenRequests.push(body);
      // 刷新 grant 模拟「scope 不足，refresh 被拒」—— 逼迫 auth() 走完整重新授权（重定向）。
      if (body.grant_type === 'refresh_token') {
        res.status(400).json({ error: 'invalid_grant', error_description: 'scope escalation requires re-authorization' });
        return;
      }
      res.json({
        access_token: `at-${seenTokenRequests.length}`,
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: `rt-${seenTokenRequests.length}`,
      });
    });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const issuerUrl = `http://127.0.0.1:${port}`;

    const redirects: string[] = [];
    const provider = new CatsCoMcpOAuthProvider({
      serverId: 'srv',
      ownerUserId: 'usr_owner',
      redirectUrl: 'https://catsco.example.com/api/mcp/oauth/callback',
      sendAuthorizationRequest: (req) => { redirects.push(req.authorizationUrl); return true; },
    });

    try {
      // 第一轮：scope=read —— auth() 走完 发现→注册→PKCE→重定向
      const first = await auth(provider as never, { serverUrl: issuerUrl, scope: 'read' });
      assert.equal(first, 'REDIRECT');
      assert.equal(redirects.length, 1);
      const authUrl = new URL(redirects[0]);
      assert.equal(authUrl.searchParams.get('response_type'), 'code');
      const challenge = authUrl.searchParams.get('code_challenge')!;
      assert.ok(challenge, 'PKCE S256 challenge present');
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authUrl.searchParams.get('scope'), 'read');

      // 用授权码完成交换：verifier 的 S256 必须等于 challenge
      const exchanged = await auth(provider as never, {
        serverUrl: issuerUrl,
        authorizationCode: 'authcode-1',
        scope: 'read',
      });
      assert.equal(exchanged, 'AUTHORIZED');
      assert.equal(seenTokenRequests.length, 1);
      const tokenReq = seenTokenRequests[0];
      assert.equal(tokenReq.grant_type, 'authorization_code');
      assert.equal(tokenReq.code, 'authcode-1');
      const crypto = await import('node:crypto');
      const expectChallenge = crypto.createHash('sha256').update(tokenReq.code_verifier).digest('base64url');
      assert.equal(expectChallenge, challenge, 'PKCE verifier matches original challenge');

      const tokens = await provider.tokens();
      assert.equal(tokens?.access_token, 'at-1');

      // 403 insufficient_scope step-up：提取 scope 后用更大 scope 重新授权
      const { extractWWWAuthenticateParams } = await import('@modelcontextprotocol/sdk/client/auth.js');
      const fake403 = new Response('', {
        status: 403,
        headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read write"' },
      });
      const extracted = extractWWWAuthenticateParams(fake403);
      assert.equal(extracted.error, 'insufficient_scope');
      assert.equal(extracted.scope, 'read write');

      const stepUp = await auth(provider as never, { serverUrl: issuerUrl, scope: extracted.scope });
      assert.equal(stepUp, 'REDIRECT');
      assert.equal(redirects.length, 2);
      const stepUpUrl = new URL(redirects[1]);
      assert.equal(stepUpUrl.searchParams.get('scope'), 'read write', 'step-up carries escalated scope');
    } finally {
      provider.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('CatsCo grant 注入：state 匹配 + owner 绑定 + 过期拒绝', async () => {
    const requests: Array<{ authorizationUrl: string; state?: string }> = [];
    const provider = new CatsCoMcpOAuthProvider({
      serverId: 'srv',
      ownerUserId: 'usr_owner',
      redirectUrl: 'https://catsco.example.com/api/mcp/oauth/callback',
      sendAuthorizationRequest: (req) => {
        requests.push({ authorizationUrl: req.authorizationUrl, ...(req.state ? { state: req.state } : {}) });
        return true;
      },
    });

    const url = new URL('https://as.example.com/authorize?state=st-1&client_id=c');
    await provider.redirectToAuthorization(url);
    assert.equal(provider.pendingAuthorizationCount, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].state, 'st-1');

    // 错误 owner / server / 过期 grant 全部被拒
    const future = Date.now() + 60_000;
    assert.equal(provider.injectAuthorizationGrant({
      serverId: 'srv', ownerUserId: 'usr_other', accessToken: 'tok', expiresAt: future, state: 'st-1',
    }), false);
    assert.equal(provider.injectAuthorizationGrant({
      serverId: 'other-srv', ownerUserId: 'usr_owner', accessToken: 'tok', expiresAt: future, state: 'st-1',
    }), false);
    assert.equal(provider.injectAuthorizationGrant({
      serverId: 'srv', ownerUserId: 'usr_owner', accessToken: 'tok', expiresAt: Date.now() - 1000, state: 'st-1',
    }), false);
    assert.equal(provider.pendingAuthorizationCount, 1);

    // 正确 grant → 挂起授权被唤醒，token 落盘
    assert.equal(provider.injectAuthorizationGrant({
      serverId: 'srv', ownerUserId: 'usr_owner', accessToken: 'tok-good', refreshToken: 'rt-good', expiresAt: future, state: 'st-1',
    }), true);
    assert.equal(provider.pendingAuthorizationCount, 0);
    await flushMicrotasks(2);
    const tokens = await provider.tokens();
    assert.equal(tokens?.access_token, 'tok-good');
    assert.equal(tokens?.refresh_token, 'rt-good');
    provider.dispose();
  });

  test('tokenStore 持久化回调被调用', async () => {
    const saved: Array<[string, string, string]> = [];
    const provider = new CatsCoMcpOAuthProvider({
      serverId: 'srv',
      ownerUserId: 'usr_owner',
      tokenStore: {
        save: (serverId, owner, tokens) => { saved.push([serverId, owner, tokens.access_token]); },
      },
    });
    await provider.saveTokens({ access_token: 'at-x', token_type: 'bearer' } as never);
    assert.deepEqual(saved, [['srv', 'usr_owner', 'at-x']]);
    provider.dispose();
  });
});

// ---------------------------------------------------------------- 群聊/私聊安全策略

describe('群聊/私聊安全隔离', () => {
  test('oauth/localRoots 默认推导 ownerOnly；显式声明优先', () => {
    assert.equal(isOwnerOnlyServer({ oauthBacked: true }), true);
    assert.equal(isOwnerOnlyServer({ localRoots: true }), true);
    assert.equal(isOwnerOnlyServer({}), false);
    assert.equal(isOwnerOnlyServer(undefined), false);
    assert.equal(isOwnerOnlyServer({ oauthBacked: true, ownerOnly: false }), false, 'explicit override wins');
  });

  test('群聊 actorUserId !== ownerUserId → 拒绝；owner 本人/私聊 → 放行', () => {
    const profile = { oauthBacked: true };
    const denied = evaluateServerAccess(profile, {
      topicType: 'group', actorUserId: 'usr_actor', ownerUserId: 'usr_owner',
    });
    assert.equal(denied.allowed, false);
    if (!denied.allowed) assert.equal(denied.code, 'mcp_owner_only_actor_mismatch');

    assert.equal(evaluateServerAccess(profile, {
      topicType: 'group', actorUserId: 'usr_owner', ownerUserId: 'usr_owner',
    }).allowed, true);
    assert.equal(evaluateServerAccess(profile, {
      topicType: 'p2p', actorUserId: 'usr_actor', ownerUserId: 'usr_actor',
    }).allowed, true);
    // 群聊中 owner 身份缺失 → 宁可拒绝
    assert.equal(evaluateServerAccess(profile, { topicType: 'group', actorUserId: 'x' }).allowed, false);
    // 非 ownerOnly server 不受影响
    assert.equal(evaluateServerAccess({}, { topicType: 'group', actorUserId: 'a', ownerUserId: 'b' }).allowed, true);
  });

  test('manager 端到端：ownerOnly server 群聊非 owner 调用被拒', async () => {
    let called = 0;
    const { manager, registeredTools } = createManagerHarness({
      callTool: async () => { called += 1; return { isError: false, content: [{ type: 'text', text: 'ok' }] } as never; },
    }, {
      servers: {
        srv: { transport: 'streamable-http', url: 'https://x.test/mcp', oauth: true },
      },
    });
    manager.start();
    await manager.waitForInitialConnect();
    await manager.refreshServerTools('srv');
    const tool = registeredTools.get('mcp_srv_do_thing')!;

    const deniedResult = await tool.execute({}, {
      workingDirectory: '/tmp', conversationHistory: [], executionScope: makeScope(),
    });
    assert.equal(deniedResult.ok, false);
    assert.equal(deniedResult.ok === false && deniedResult.errorCode, 'mcp_owner_only_actor_mismatch');
    assert.equal(called, 0, 'denied call must never reach the server');

    const ownerResult = await tool.execute({}, {
      workingDirectory: '/tmp', conversationHistory: [],
      executionScope: makeScope({ actorUserId: 'usr_owner' }),
    });
    assert.equal(ownerResult.ok, true);
    assert.equal(called, 1);
    await manager.closeAll();
  });

  test('通知限流：令牌桶耗尽后丢弃', async () => {
    let now = 1_000;
    const limiter = new NotificationRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => now });
    assert.equal(limiter.consume('srv'), true);
    assert.equal(limiter.consume('srv'), true);
    assert.equal(limiter.consume('srv'), true);
    assert.equal(limiter.consume('srv'), false, 'bucket empty');
    now += 2_000; // +2 tokens (cap 3)
    assert.equal(limiter.consume('srv'), true);
    assert.equal(limiter.consume('srv'), true);
    assert.equal(limiter.consume('srv'), false);
    // 不同 server 独立桶
    assert.equal(limiter.consume('other'), true);
  });

  test('manager 通知路径超限丢弃，不进入 onEvent', async () => {
    const events: string[] = [];
    let capturedHooks: { onNotification?: (n: { method: string; params?: unknown }) => void } | undefined;
    const manager = new McpClientManager({
      toolManager: { registerTool: () => {}, unregisterTool: () => {} },
      servers: { srv: { transport: 'streamable-http', url: 'https://x.test/mcp' } },
      createConnection: (_c, hooks) => {
        capturedHooks = hooks;
        return fakeConnection();
      },
      notificationRateLimit: { capacity: 2, refillPerSecond: 0.0001 },
      onEvent: (event) => events.push(event.method),
    });
    manager.start();
    await manager.waitForInitialConnect();
    for (let i = 0; i < 5; i += 1) {
      capturedHooks!.onNotification!({ method: 'notifications/resources/updated', params: { uri: `x://${i}`, seq: i } });
    }
    assert.equal(events.length, 2, 'burst beyond capacity dropped');
    await manager.closeAll();
  });

  test('SessionScopeAllowlist：空表中立 / 命中放行 / 未命中拒绝', () => {
    const allowlist = new SessionScopeAllowlist();
    assert.equal(allowlist.isAllowed('sess-1'), undefined, 'empty = caller decides');
    allowlist.allow('sess-1');
    allowlist.allow('sess-2', 'topic-x');
    assert.equal(allowlist.isAllowed('sess-1'), true);
    assert.equal(allowlist.isAllowed('sess-1', 'any-topic'), true);
    assert.equal(allowlist.isAllowed('sess-2', 'topic-x'), true);
    assert.equal(allowlist.isAllowed('sess-2', 'topic-y'), false);
    assert.equal(allowlist.isAllowed('sess-3'), false);
    allowlist.revoke('sess-1');
    assert.equal(allowlist.isAllowed('sess-1'), false);
  });
});

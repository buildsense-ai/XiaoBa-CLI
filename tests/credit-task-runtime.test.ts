import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CreditTaskRuntime, CreditTaskPausedError, checkCreditTask, currentCreditTask, isCatsCoCreditProvider } from '../src/core/credit-task-runtime';
import { AIService } from '../src/utils/ai-service';
import { AgentSession } from '../src/core/agent-session';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { SessionStore } from '../src/utils/session-store';
import type { ChatConfig } from '../src/types';

async function relay(t: TestContext) {
  const actions: Array<{ action: string; task_id: string; headers: IncomingHttpHeaders }> = [];
  const calls: Array<{ path: string; headers: IncomingHttpHeaders; body: any }> = [];
  const control = { enabled: true, allowed: true, spendable: 10, debt: 0, status: 200,
    modelStatus: 200, finishStatus: 200, retained: '', reason: '余额不足', modelReply: undefined as any,
    decide: undefined as undefined | ((action: string, id: string) => Partial<Record<string, any>>) };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/credit-tasks') {
      actions.push({ ...body, headers: req.headers });
      res.statusCode = body.action === 'finish' ? control.finishStatus : control.status;
      res.end(JSON.stringify({ enabled: control.enabled, allowed: control.allowed, task_id: body.task_id,
        state: body.action === 'finish' ? 'completed' : control.allowed ? 'running' : 'paused',
        retained_task_id: control.retained || undefined, reason: control.reason,
        spendable_units: control.spendable, debt_units: control.debt, ...control.decide?.(body.action, body.task_id) }));
      return;
    }
    calls.push({ path: req.url!, headers: req.headers, body });
    res.statusCode = control.modelStatus;
    if (control.modelStatus !== 200) { res.end(JSON.stringify({ error: { message: 'budget exceeded' } })); return; }
    const response = { id: 'resp-test', status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }] }] };
    const anthropic = { id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) {
      res.end(JSON.stringify(req.url?.endsWith('/responses') ? response
        : req.url?.endsWith('/messages') ? anthropic
        : { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const event = (name: string, payload: any) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    if (req.url?.endsWith('/responses')) res.end(event('response.completed', { type: 'response.completed', response }));
    else if (req.url?.endsWith('/messages')) {
      res.end(event('message_start', { type: 'message_start', message: { ...anthropic, content: [] } })
        + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
        + event('content_block_stop', { type: 'content_block_stop', index: 0 })
        + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
        + event('message_stop', { type: 'message_stop' }));
    } else res.end(`data: ${JSON.stringify({ choices: [{ delta: control.modelReply || { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as any).port;
  const config: ChatConfig = { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-relay-key',
    model: 'test-model', provider: 'openai', catsCoRelay: true };
  return { actions, calls, control, config };
}

function services(aiService: AIService, extra: any = {}): any {
  return { aiService, toolManager: { getToolDefinitions: () => [], executeTool: () => { throw Error('unexpected tool'); },
    getWorkspaceRoot: () => process.env.TEMP || process.cwd(), ...extra },
    skillManager: { getSkill: () => undefined, getUserInvocableSkills: () => [], getAutoInvocableSkills: () => [],
      findAutoInvocableSkillByText: () => undefined, loadSkills: async () => {} } };
}

function session(config: ChatConfig, key = `credit-task-${randomUUID()}`, extra: any = {}) {
  const instance = new AgentSession(key, services(new AIService(config), extra));
  instance.setSystemPromptProvider(() => 'Test system prompt');
  return instance;
}

for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
  for (const stream of [false, true]) {
    test(`${protocol} ${stream ? 'stream' : 'nonstream'} sends the stable root header and authenticates the same origin gate`, async t => {
      const f = await relay(t);
      const config: ChatConfig = { ...f.config, apiUrl: f.config.apiUrl!.replace('/v1', protocol === 'anthropic' ? '/anthropic' : '/openai'),
        provider: protocol === 'anthropic' ? 'anthropic' : 'openai', openaiApiMode: protocol === 'responses' ? 'responses' : 'chat_completions' };
      const root = new CreditTaskRuntime(config);
      const ai = new AIService(config);
      await root.run(async () => {
        await Promise.all([root.start(), root.start()]);
        const messages = [{ role: 'user' as const, content: 'original task' }];
        assert.equal((await (stream ? ai.chatStream(messages) : ai.chat(messages))).content, 'done');
        assert.equal((await ai.chat(messages)).content, 'done');
        await Promise.all([root.complete(), root.complete()]);
      });
      assert.equal(f.actions.filter(a => a.action === 'start').length, 1);
      assert.equal(f.actions.filter(a => a.action === 'finish').length, 1);
      assert.equal(f.actions.filter(a => a.action === 'status').length, 2);
      for (const call of f.calls) assert.equal(call.headers['x-catsco-root-task-id'], root.snapshot.taskId);
      for (const action of f.actions) assert.equal(action.headers.authorization, 'Bearer test-relay-key');
    });
  }
}

test('ordinary providers never call the gate; lookalike host names do not establish CatsCo identity', async t => {
  const f = await relay(t);
  const config = { ...f.config, catsCoRelay: false };
  await new AIService(config).chat([{ role: 'user', content: 'hello' }]);
  assert.equal(f.actions.length, 0);
  assert.equal(f.calls[0].headers['x-catsco-root-task-id'], undefined);
  assert.equal(isCatsCoCreditProvider({ apiUrl: 'https://relay.catsco.cn.attacker.example/v1' }), false);
  assert.equal(isCatsCoCreditProvider({ apiUrl: 'https://relay.catsco.cn/anthropic' }), true);
});

test('explicit enabled:false keeps legacy budget behavior and skips per-call credit checks', async t => {
  const f = await relay(t);
  f.control.enabled = false;
  const root = new CreditTaskRuntime(f.config);
  const ai = new AIService(f.config);
  await root.run(async () => {
    await root.start();
    await ai.chat([{ role: 'user', content: 'legacy' }]);
    f.control.modelStatus = 402;
    await assert.rejects(ai.chat([{ role: 'user', content: 'legacy' }]), /402/);
    assert.equal(root.snapshot.state, 'running');
    await root.complete();
  });
  assert.deepEqual(f.actions.map(a => a.action), ['start']);
});

for (const status of [404, 500, 503]) {
  test(`gate HTTP ${status} fails closed without a paid model request`, async t => {
    const f = await relay(t);
    f.control.status = status;
    const s = session(f.config);
    assert.match((await s.handleMessage('new goal')).text, /任务已暂停/);
    assert.equal(f.calls.length, 0);
    assert.equal((await s.handleMessage('try again automatically')).taskOutcome, 'failed');
    assert.deepEqual(f.actions.map(a => a.action), ['start']);
  });
}

test('network errors, malformed decisions and cross-origin redirects cannot enable credit bypass', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('ECONNRESET'); },
    async () => new Response('{}'),
    async () => new Response('', { status: 302, headers: { Location: 'https://attacker.example/v1/credit-tasks' } }),
  ]) {
    const root = new CreditTaskRuntime({ apiUrl: 'https://relay.catsco.cn/v1', apiKey: 'key' }, undefined, undefined, fetchImpl as typeof fetch);
    await assert.rejects(root.start(), CreditTaskPausedError);
    assert.equal(root.snapshot.state, 'paused');
  }
});

test('invalid unit counts and a denied legacy decision fail closed', async () => {
  for (const invalid of [{ spendable_units: -1 }, { spendable_units: 1.5 }, { debt_units: -1 },
    { debt_units: Number.MAX_SAFE_INTEGER + 1 }, { enabled: false, allowed: false }]) {
    const root = new CreditTaskRuntime({ apiUrl: 'https://relay.catsco.cn/v1', apiKey: 'key' }, undefined,
      undefined, (async (_url, init) => new Response(JSON.stringify({ enabled: true, allowed: true,
        task_id: JSON.parse(init!.body as string).task_id, state: 'running', spendable_units: 10,
        debt_units: 0, ...invalid }))) as typeof fetch);
    await assert.rejects(root.start(), CreditTaskPausedError);
    assert.equal(root.snapshot.state, 'paused');
  }
});

test('parallel original tasks use distinct roots and obey server retained selection; no automatic reassignment', async t => {
  const f = await relay(t);
  const first = new CreditTaskRuntime(f.config);
  const second = new CreditTaskRuntime(f.config);
  await Promise.all([first.start(), second.start()]);
  assert.notEqual(first.snapshot.taskId, second.snapshot.taskId);
  f.control.decide = (action, id) => action === 'status' && id === first.snapshot.taskId
    ? { allowed: false, state: 'paused', retained_task_id: second.snapshot.taskId } : {};
  await assert.rejects(first.status(), CreditTaskPausedError);
  assert.match(first.pauseMessage, new RegExp(second.snapshot.taskId));
  await second.status();
  await second.complete();
  const count = f.actions.length;
  await assert.rejects(first.status(), CreditTaskPausedError);
  await first.complete();
  assert.equal(f.actions.length, count);
});

test('a stale concurrent status cannot undo a local budget pause', async () => {
  let resolve!: (response: Response) => void;
  const root = new CreditTaskRuntime({ apiUrl: 'https://relay.catsco.cn/v1', apiKey: 'key' },
    { taskId: randomUUID(), state: 'running', enabled: true, startSent: true }, undefined,
    (() => new Promise<Response>(r => { resolve = r; })) as typeof fetch);
  const check = root.status();
  root.pause('额度不足');
  resolve(new Response(JSON.stringify({ enabled: true, allowed: true, task_id: root.snapshot.taskId, state: 'running', spendable_units: 0, debt_units: 10 })));
  await assert.rejects(check, CreditTaskPausedError);
  assert.equal(root.snapshot.state, 'paused');
});

test('402 persists paused/root across restart; only manual resume passes current debt/balance/permission gate', async t => {
  const f = await relay(t);
  f.control.modelStatus = 402;
  const original = session(f.config);
  const paused = await original.handleMessage('original task');
  assert.match(paused.text, /任务已暂停/);
  const snapshot = SessionStore.getInstance().loadRuntimeState(original.key).creditTask!;
  assert.equal(snapshot.state, 'paused');
  assert.equal(f.calls.length, 1);
  assert.equal(f.actions.some(a => a.action === 'finish'), false);
  f.control.modelStatus = 200;
  const restored = session(f.config, original.key);
  restored.restoreFromStore();
  assert.match((await restored.handleMessage('unrelated new task')).text, /任务已暂停/);
  assert.equal(f.calls.length, 1);
  for (const condition of [{ debt: 5, spendable: 20, allowed: true }, { debt: 0, spendable: 0, allowed: true },
    { debt: 0, spendable: 20, allowed: false }]) {
    Object.assign(f.control, condition);
    assert.match((await restored.handleCommand('resume', [])).reply!, /任务已暂停/);
    assert.equal(f.calls.length, 1);
  }
  Object.assign(f.control, { debt: 0, spendable: 20, allowed: true });
  assert.equal((await restored.handleCommand('resume', [])).reply, 'done');
  assert.equal(f.actions.filter(a => a.action === 'start').length, 1);
  assert.equal(f.actions.filter(a => a.action === 'resume').length, 4);
  assert.equal(f.actions.filter(a => a.action === 'finish').length, 1);
  for (const action of f.actions) assert.equal(action.task_id, snapshot.taskId);
  for (const call of f.calls) assert.equal(call.headers['x-catsco-root-task-id'], snapshot.taskId);
  const history = (restored as any).messages;
  assert.equal(history.filter((m: any) => m.content === 'original task').length, 1);
  assert.equal(history.some((m: any) => /switch_model/.test(String(m.content))), false);
});

test('a concurrent reserve 409 preserves the root as paused without retry or finish', async t => {
  const f = await relay(t);
  f.control.modelStatus = 409;
  const original = session(f.config);
  assert.match((await original.handleMessage('original task')).text, /任务已暂停/);
  const snapshot = SessionStore.getInstance().loadRuntimeState(original.key).creditTask!;
  assert.equal(snapshot.state, 'paused');
  assert.equal(f.calls.length, 1);
  assert.equal(f.actions.some(a => a.action === 'finish'), false);
  assert.match((await original.handleMessage('automatic retry')).text, /任务已暂停/);
  assert.equal(f.calls.length, 1);
});

test('denied new task preserves pending input for manual resume and never auto-starts another root', async t => {
  const f = await relay(t);
  f.control.allowed = false;
  const s = session(f.config);
  await s.handleMessage('queued original goal');
  assert.equal(f.calls.length, 0);
  f.control.allowed = true;
  assert.equal((await s.handleCommand('resume', [])).reply, 'done');
  assert.equal(f.actions.filter(a => a.action === 'start').length, 1);
  assert.ok(JSON.stringify(f.calls[0].body).includes('queued original goal'));
});

test('nested async scopes cannot replace root; finish waits for actual SubAgentManager children', async t => {
  const f = await relay(t);
  const root = new CreditTaskRuntime(f.config);
  const impostor = new CreditTaskRuntime(f.config);
  const manager = SubAgentManager.getInstance();
  const key = `credit-parent-${randomUUID()}`;
  manager.registerPlatformCallbacks(key, { injectMessage: async () => {} });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const ids: string[] = [];
  const ai: any = { getConfig: () => f.config, chatStream: async () => {
    ids.push(currentCreditTask()!.snapshot.taskId);
    await gate;
    await checkCreditTask(f.config);
    return { content: 'child done' };
  } };
  await root.run(async () => {
    await root.start();
    await impostor.run(async () => assert.equal(currentCreditTask(), root));
    await manager.spawn(key, { agentType: 'explorer', taskDescription: 'necessary child', userMessage: 'read state', allowedTools: [] },
      process.env.TEMP!, ai, { getSkill: () => undefined, loadSkills: async () => {} } as any);
    for (let i = 0; !ids.length && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(ids, [root.snapshot.taskId]);
    await root.complete();
    assert.equal(f.actions.some(a => a.action === 'finish'), false);
  });
  release();
  for (let i = 0; (root.snapshot.state !== 'completed' || root.snapshot.finishPending) && i < 100; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(root.snapshot.state, 'completed');
  assert.equal(f.actions.filter(a => a.action === 'start').length, 1);
  assert.equal(f.actions.filter(a => a.action === 'finish').length, 1);
  manager.unregisterPlatformCallbacks(key);
});

test('credit queued inputs stay queued and each subsequent user goal starts a fresh UUID', async t => {
  const f = await relay(t);
  let consumed = 0;
  const s = session(f.config);
  const first = await s.handleMessage('first goal', { pendingUserInputProvider: () => { consumed++; return []; } });
  assert.equal(first.taskOutcome, 'completed');
  assert.equal(consumed, 0);
  assert.equal((await s.handleMessage('second goal')).taskOutcome, 'completed');
  const starts = f.actions.filter(a => a.action === 'start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].task_id, starts[1].task_id);
});

test('iteration gate saves successful tool progress and blocks the next model call until manual resume', async t => {
  const f = await relay(t);
  f.control.modelReply = { tool_calls: [{ index: 0, id: 'tool-credit', type: 'function', function: { name: 'noop', arguments: '{}' } }] };
  const s = session(f.config, undefined, {
    getToolDefinitions: () => [{ name: 'noop', description: 'Record progress', parameters: { type: 'object', properties: {} } }],
    executeTool: async (call: any) => {
      f.control.allowed = false;
      return { role: 'tool', tool_call_id: call.id, name: 'noop', content: 'durable success', ok: true };
    },
  });
  assert.match((await s.handleMessage('multi-step goal')).text, /任务已暂停/);
  assert.equal(f.calls.length, 1);
  assert.ok(JSON.stringify(SessionStore.getInstance().loadContext(s.key)).includes('durable success'));
  assert.equal(f.actions.some(a => a.action === 'finish'), false);
  f.control.allowed = true;
  f.control.modelReply = undefined;
  assert.equal((await s.handleCommand('resume', [])).reply, 'done');
  assert.ok(JSON.stringify(f.calls[1].body).includes('durable success'));
});

test('a paused child saves its transcript in the root snapshot and never retries or finishes the root', async t => {
  const f = await relay(t);
  f.control.modelStatus = 402;
  const root = new CreditTaskRuntime(f.config);
  const manager = SubAgentManager.getInstance();
  const key = `credit-child-pause-${randomUUID()}`;
  manager.registerPlatformCallbacks(key, { injectMessage: async () => {} });
  await root.run(async () => {
    await root.start();
    await manager.spawn(key, { agentType: 'explorer', taskDescription: 'necessary paused step', userMessage: 'keep child input', allowedTools: [] },
      process.env.TEMP!, new AIService(f.config), { getSkill: () => undefined, loadSkills: async () => {} } as any);
  });
  for (let i = 0; manager.hasActiveForParent(key) && i < 100; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(root.snapshot.state, 'paused');
  assert.ok(JSON.stringify(root.snapshot.subagentProgress).includes('keep child input'));
  assert.equal(f.calls.length, 1);
  await root.complete();
  assert.equal(f.actions.some(a => a.action === 'finish'), false);
  manager.unregisterPlatformCallbacks(key);
});

test('stop during admission cannot start the model after the gate returns', async t => {
  const f = await relay(t);
  const s = session(f.config);
  const running = s.handleMessage('will be cancelled');
  assert.equal(s.isBusy(), true);
  s.requestInterrupt();
  assert.equal((await running).taskOutcome, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.equal(f.actions.filter(a => a.action === 'finish').length, 1);
});

test('standalone compact has admission and persists its command across a credit pause and restart', async t => {
  const f = await relay(t);
  f.control.modelStatus = 402;
  const first = session(f.config);
  const installCheckpoint = (s: AgentSession) => {
    (s as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: any[]) => {
      await (s as any).services.aiService.chat([{ role: 'user', content: 'summarize checkpoint' }]);
      return { messages, compacted: false };
    };
  };
  installCheckpoint(first);
  assert.match((await first.handleCommand('compact', [])).reply!, /任务已暂停/);
  const snapshot = SessionStore.getInstance().loadRuntimeState(first.key).creditTask!;
  assert.equal(snapshot.pendingCommand, 'compact');
  assert.equal(f.actions.some(a => a.action === 'finish'), false);
  f.control.modelStatus = 200;
  const restored = session(f.config, first.key);
  installCheckpoint(restored);
  assert.match((await restored.handleCommand('compact', [])).reply!, /任务已暂停/);
  assert.equal(f.calls.length, 1);
  assert.match((await restored.handleCommand('resume', [])).reply!, /无需压缩/);
  assert.equal(f.actions.filter(a => a.action === 'start').length, 1);
  assert.equal(f.actions.filter(a => a.action === 'resume').length, 1);
  assert.equal(f.actions.filter(a => a.action === 'finish').length, 1);
  for (const a of f.actions) assert.equal(a.task_id, snapshot.taskId);
  for (const call of f.calls) assert.equal(call.headers['x-catsco-root-task-id'], snapshot.taskId);
});

test('manual resume repairs a blocked checkpoint inside the original task before continuing', async t => {
  const f = await relay(t);
  f.control.allowed = false;
  const s = session(f.config);
  await s.handleMessage('original goal with checkpoint');
  (s as any).checkpointBlockedReason = 'checkpoint_authentication';
  (s as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: any[]) => {
    await (s as any).services.aiService.chat([{ role: 'user', content: 'recover checkpoint' }]);
    return { messages, compacted: false };
  };
  f.control.allowed = true;
  assert.equal((await s.handleCommand('resume', [])).reply, 'done');
  assert.equal((s as any).checkpointBlockedReason, null);
  assert.equal(f.actions.filter(a => a.action === 'start').length, 1);
  assert.equal(f.actions.filter(a => a.action === 'resume').length, 1);
  assert.ok(f.calls.length >= 2);
  const id = f.actions[0].task_id;
  for (const call of f.calls) assert.equal(call.headers['x-catsco-root-task-id'], id);
});

test('history hydration defers paid checkpoint work until a user task passes admission', async t => {
  const f = await relay(t);
  const s = session(f.config);
  let checkpoints = 0;
  (s as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: any[]) => {
    checkpoints++;
    await (s as any).services.aiService.chat([{ role: 'user', content: 'checkpoint' }]);
    return { messages, compacted: false };
  };
  assert.equal(await s.appendDurableContext(['remote history']), true);
  assert.equal(checkpoints, 0);
  assert.equal(f.actions.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await s.handleMessage('new goal')).taskOutcome, 'completed');
  assert.ok(checkpoints > 0);
});

test('a stale status cannot reopen an already finished root', async () => {
  let release!: (response: Response) => void;
  const root = new CreditTaskRuntime({ apiUrl: 'https://relay.catsco.cn/v1', apiKey: 'key' },
    { taskId: randomUUID(), state: 'running', enabled: true, startSent: true }, undefined,
    (async (_url: any, init: any) => {
      const { action } = JSON.parse(init.body);
      if (action === 'status') return new Promise<Response>(r => { release = r; });
      return new Response(JSON.stringify({ enabled: true, allowed: true, task_id: root.snapshot.taskId,
        state: 'completed', spendable_units: 0, debt_units: 10 }));
    }) as typeof fetch);
  const status = root.status();
  await root.complete();
  release(new Response(JSON.stringify({ enabled: true, allowed: true, task_id: root.snapshot.taskId,
    state: 'running', spendable_units: 0, debt_units: 10 })));
  await assert.rejects(status, CreditTaskPausedError);
  assert.equal(root.snapshot.state, 'completed');
});

test('CatsCo child result processing waits for the original session and completes before finish', async t => {
  const { CatsCompanyBot } = await import('../src/catscompany');
  const f = await relay(t);
  const root = new CreditTaskRuntime(f.config);
  const s = session(f.config);
  const bot: any = Object.create(CatsCompanyBot.prototype);
  let available = false;
  let released = false;
  Object.assign(bot, {
    sessionManager: { getOrCreate: () => s },
    getSessionClearGeneration: () => 0, getSessionStopGeneration: () => 0,
    registerSubAgentPlatformCallbacks: () => {}, buildChannel: () => ({}),
    tryReserveSessionExecution: () => available,
    releaseSessionExecution: () => { released = true; },
    drainMessageQueue: async () => {}, buildSessionCallbacks: () => ({}),
    startTypingHeartbeat: () => () => {}, sender: { reply: async () => {} },
    scheduleSubAgentCompletionBatch: () => { throw new Error('credit result must retain its root until processed'); },
    enqueueSubAgentFeedback: () => { throw new Error('credit result must not detach into another task'); },
  });
  await root.run(async () => {
    await root.start();
    const observation = root.child(() => bot.handleSubAgentFeedbackInner(s.key, 'topic', 'sender',
      '[子agent1 已完成]\nID：sa-credit-result\n任务：necessary step\n结果摘要：child progress', undefined, 0, 0));
    await root.complete();
    assert.equal(f.actions.some(a => a.action === 'finish'), false);
    assert.equal(f.calls.length, 0);
    available = true;
    await observation;
  });
  assert.equal(released, true);
  assert.equal(f.actions.filter(a => a.action === 'start').length, 1);
  assert.equal(f.actions.filter(a => a.action === 'finish').length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['x-catsco-root-task-id'], root.snapshot.taskId);
  assert.equal(root.snapshot.state, 'completed');
});

for (const stream of [false, true]) {
  test(`Anthropic ${stream ? 'stream' : 'nonstream'} retries return through status admission`, async t => {
    const f = await relay(t);
    const config: ChatConfig = { ...f.config, provider: 'anthropic' };
    const root = new CreditTaskRuntime(config);
    const ai = new AIService(config);
    (ai as any).sleepWithAbort = async () => {};
    f.control.modelStatus = 500;
    f.control.decide = action => action === 'status' && f.calls.length > 0
      ? { allowed: false, state: 'paused' } : {};
    await root.run(async () => {
      await root.start();
      await assert.rejects(stream ? ai.chatStream([{ role: 'user', content: 'goal' }])
        : ai.chat([{ role: 'user', content: 'goal' }]), CreditTaskPausedError);
    });
    assert.equal(f.calls.length, 1);
    assert.equal(root.snapshot.state, 'paused');
    assert.equal(f.actions.filter(a => a.action === 'status').length, 2);
  });
}

test('finish acknowledgement failures persist separately and retry idempotently without rerunning work', async t => {
  const f = await relay(t);
  f.control.finishStatus = 503;
  const ended = new Set<string>();
  f.control.decide = (action, id) => {
    if (action === 'finish') ended.add(id);
    return {};
  };
  const first = session(f.config);
  assert.match((await first.handleMessage('one original goal')).text, /结束状态尚未同步/);
  const snapshot = SessionStore.getInstance().loadRuntimeState(first.key).creditTask!;
  assert.equal(snapshot.state, 'completed');
  assert.equal(snapshot.finishPending, true);
  assert.equal(f.calls.length, 1);
  const restored = session(f.config, first.key);
  assert.match((await restored.handleMessage('new goal before sync')).text, /结束状态尚未同步/);
  assert.match((await restored.handleCommand('compact', [])).reply!, /结束状态尚未同步/);
  f.control.finishStatus = 200;
  f.control.decide = (action, id) => {
    if (action === 'finish') ended.add(id);
    return action === 'finish' ? { state: 'completed', allowed: false, spendable_units: 0, debt_units: 10 } : {};
  };
  assert.match((await restored.handleCommand('resume', [])).reply!, /结束状态已同步/);
  assert.equal(ended.size, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.actions.filter(a => a.action !== 'status').map(a => a.action), ['start', 'finish', 'finish']);
  assert.equal(SessionStore.getInstance().loadRuntimeState(first.key).creditTask!.finishPending, false);
  for (const action of f.actions) assert.equal(action.task_id, snapshot.taskId);
});

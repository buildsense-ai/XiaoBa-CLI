import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceGrantLease, DeviceGrantRenewalError, isDeviceGrantRenewal } from '../src/core/device-grant-lease';
import { scopedDeviceContext } from './helpers/scoped-device-context';
import type { ScopedDeviceGrant } from '../src/types/session-identity';
import type { ToolExecutionContext } from '../src/types/tool';
import { CatsClient, CatsSendError } from '../src/catscompany/client';
import { Logger } from '../src/utils/logger';
import { CatsCompanyBot } from '../src/catscompany/index';
import { resolveExecutionRoute, executeRouteIfRemote } from '../src/tools/execution-router';
import { buildTargetRoutes } from '../src/catscompany/runtime-context';
import { ConversationRunner } from '../src/core/conversation-runner';
import { unknownRemoteMutationResult, executeRemoteDeviceRpcTool } from '../src/tools/device-rpc-tool';

function fixture() {
  let now = Date.now();
  let renewals = 0;
  const context: ToolExecutionContext = { workingDirectory: '.', surface: 'catscompany',
    ...scopedDeviceContext('usr7', 'a', ['execute_shell', 'read_file']),
    targetRoutes: buildTargetRoutes([{ userId: 'usr7', ownerUserId: 'usr7', deviceId: 'a', label: 'A', status: 'ready', os: 'windows' }]),
    thinToolRpc: { supportsRemoteShellTimeout: true, executeTool: async () => ({ ok: true, content: 'done' }),
      renewGrant: async grant => { renewals++; return { ...grant, grantId: `renewed-${renewals}`, expiresAt: now + 600_000 }; } },
  };
  const lease = new DeviceGrantLease(() => context, () => true, () => now);
  return { context, lease, advance: (ms: number) => { now += ms; }, renewals: () => renewals };
}

test('active task survives multiple ten-minute boundaries without widening device authority', async () => {
  const f = fixture();
  const grant = f.context.deviceGrants![0];
  const original = { ...grant };
  for (let i = 0; i < 12; i++) { f.advance(240_000); await f.lease.refresh(); }
  assert.equal(f.renewals(), 12);
  assert.equal(grant.createdAt, original.createdAt);
  assert.equal(grant.deviceId, original.deviceId);
  assert.equal(grant.ownerUserId, original.ownerUserId);
  assert.ok(grant.expiresAt > original.expiresAt + 40 * 60_000);
  assert.deepEqual(grant.operations, original.operations);
  f.lease.stop(); f.advance(240_000); await f.lease.refresh();
  assert.equal(f.renewals(), 12);
});

test('fresh grants, unsupported servers, expired and untrusted authority are never renewed', async () => {
  for (const variant of ['fresh', 'unsupported', 'expired', 'untrusted', 'wrong actor', 'delegated', 'aborted']) {
    const f = fixture();
    if (variant !== 'fresh') f.advance(300_000);
    switch (variant) {
      case 'unsupported': delete f.context.thinToolRpc!.renewGrant; break;
      case 'expired': f.advance(300_001); break;
      case 'untrusted': f.context.deviceGrants![0].identityTrust = 'untrusted'; break;
      case 'wrong actor': f.context.deviceGrants![0].actorUserId = 'usr8'; break;
      case 'delegated': f.context.deviceGrants![0].ownerUserId = 'usr8'; break;
      case 'aborted': f.context.abortSignal = AbortSignal.abort(); break;
    }
    await f.lease.refresh(); assert.equal(f.renewals(), 0, variant);
  }
});

for (const variant of ['device', 'actor', 'session', 'scope', 'revision', 'operations', 'duplicate operations', 'expiry', 'body', 'creation']) {
  test(`rejects renewal response with changed ${variant}`, () => {
    const f = fixture(); const old = f.context.deviceGrants![0];
    const next: ScopedDeviceGrant = { ...old, grantId: 'new-id', expiresAt: Date.now() + 600_000 };
    switch (variant) {
      case 'device': next.deviceId = 'b'; break;
      case 'actor': next.actorUserId = 'usr8'; break;
      case 'session': next.sessionKey = 'other'; break;
      case 'scope': next.targetScope = 'explicit_device'; break;
      case 'revision': next.selectionRevision = 'other'; break;
      case 'operations': next.operations = [...old.operations, 'write_file']; break;
      case 'duplicate operations': next.operations = old.operations.map(() => old.operations[0]); break;
      case 'expiry': next.expiresAt = old.expiresAt + 600_001; break;
      case 'body': next.deviceBodyId = 'other'; break;
      case 'creation': next.createdAt++; break;
    }
    assert.equal(isDeviceGrantRenewal(old, next), false);
  });
}

for (const variant of ['stop', 'abort', 'selection', 'context replaced']) {
  test(`late renewal cannot apply after ${variant}`, async () => {
    const f = fixture(); f.advance(300_000);
    const old = f.context.deviceGrants![0]; const originalID = old.grantId;
    let complete!: (grant: ScopedDeviceGrant) => void;
    f.context.thinToolRpc!.renewGrant = async grant => new Promise(resolve => { complete = resolve; });
    const pending = f.lease.refresh();
    switch (variant) {
      case 'stop': f.lease.stop(); break;
      case 'abort': f.context.abortSignal = AbortSignal.abort(); break;
      case 'selection': f.context.deviceSelection = { revision: 'changed' } as any; break;
      case 'context replaced': f.context.deviceGrants = [{ ...old, grantId: 'new-turn' }]; break;
    }
    complete({ ...old, grantId: 'late', expiresAt: old.expiresAt + 300_000 });
    await pending;
    assert.equal(old.grantId, originalID);
  });
}

test('concurrent heartbeats coalesce; failed renewal does not replay operations or busy loop', async () => {
  const f = fixture(); f.advance(300_000);
  let calls = 0;
  f.context.thinToolRpc!.renewGrant = async () => { calls++; throw new Error('disconnected'); };
  const before = { ...f.context.deviceGrants![0] };
  await Promise.all([f.lease.refresh(), f.lease.refresh(), f.lease.refresh()]);
  await f.lease.refresh();
  assert.equal(calls, 1);
  assert.deepEqual(f.context.deviceGrants![0], before);
  f.advance(30_001); await f.lease.refresh(); assert.equal(calls, 2);
  f.advance(300_000); await f.lease.refresh(); assert.equal(calls, 2);
});

test('two devices renew independently and never change the default', async () => {
  const f = fixture(); const a = f.context.deviceGrants![0];
  a.selectionRevision = 'selected-a';
  f.context.deviceSelection = { revision: 'selected-a', selectedDeviceId: 'a' } as any;
  const b = { ...a, grantId: 'b-original', deviceId: 'b', targetScope: 'explicit_device' as const };
  f.context.deviceGrants!.push(b); f.advance(300_000);
  f.context.thinToolRpc!.renewGrant = async grant => {
    if (grant.deviceId === 'a') throw new Error('A offline');
    return { ...grant, grantId: 'b-renewed', expiresAt: grant.expiresAt + 300_000 };
  };
  await f.lease.refresh();
  assert.equal(a.grantId, 'fake-scoped-grant'); assert.equal(b.grantId, 'b-renewed');
  assert.equal(f.context.deviceSelection.selectedDeviceId, 'a');
});

test('client renewal negotiates support and sends only an opaque original grant id', async () => {
  const client = new CatsClient({ serverUrl: 'ws://127.0.0.1:1' });
  const grant = fixture().context.deviceGrants![0];
  await assert.rejects(client.renewDeviceGrant(grant), /does not support/);
  client.supportsDeviceGrantRenewal = true;
  let sent: any;
  (client as any).sendOrThrow = (message: any) => { sent = message; };
  const pending = client.renewDeviceGrant(grant);
  const request = sent.device_grant_renewal;
  assert.deepEqual(Object.keys(request).sort(), ['grant_id', 'id', 'request_id', 'type']);
  assert.equal(typeof request.id, 'string');
  (client as any).handleMessage({ device_grant_renewal: { ...request, type: 'result',
    grant: { ...grant, grantId: 'new-grant', expiresAt: Date.now() + 600_000 } } });
  assert.equal((await pending).grantId, 'new-grant');
  const disconnected = client.renewDeviceGrant(grant);
  (client as any).rejectPendingThinToolRpc(new Error('disconnected'));
  await assert.rejects(disconnected, /disconnected/);
});

test('client rejects mismatched renewal results without exposing a new grant', async () => {
  const client = new CatsClient({ serverUrl: 'ws://127.0.0.1:1' });
  client.supportsDeviceGrantRenewal = true;
  let sent: any;
  (client as any).sendOrThrow = (message: any) => { sent = message.device_grant_renewal; };
  const grant = fixture().context.deviceGrants![0];
  const pending = client.renewDeviceGrant(grant);
  (client as any).handleMessage({ device_grant_renewal: { ...sent, type: 'result',
    grant: { ...grant, grantId: 'new-grant', deviceId: 'wrong-device', expiresAt: Date.now() + 600_000 } } });
  await assert.rejects(pending, /续期失败/);
});

test('an existing transport re-reads server capabilities after reconnect or downgrade', () => {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.bot = { supportsDeviceGrantRenewal: false, supportsRemoteShellTimeout: false };
  const transport = bot.buildThinToolRpcTransport();
  assert.equal(transport.renewGrant, undefined);
  assert.equal(transport.supportsRemoteShellTimeout, false);
  bot.bot.supportsDeviceGrantRenewal = true;
  bot.bot.supportsRemoteShellTimeout = true;
  assert.equal(typeof transport.renewGrant, 'function');
  assert.equal(transport.supportsRemoteShellTimeout, true);
  bot.bot.supportsDeviceGrantRenewal = false;
  bot.bot.supportsRemoteShellTimeout = false;
  assert.equal(transport.renewGrant, undefined);
  assert.equal(transport.supportsRemoteShellTimeout, false);
});

test('remote shell uses requested execution time plus result margin and rejects overlong dispatch', async () => {
  const f = fixture(); let request: any; let calls = 0;
  f.context.thinToolRpc!.executeTool = async value => { request = value; calls++; return { ok: true, content: 'done' }; };
  const route = resolveExecutionRoute(f.context, { toolName: 'execute_shell', operation: 'execute_shell', target: 'a' });
  assert.equal(route.ok, true);
  const result = await executeRouteIfRemote(f.context, route, 'execute_shell', 'execute_shell', { command: 'echo harmless', timeout: 180_000 });
  assert.equal(result?.ok, true); assert.equal(request.timeoutMs, 190_000); assert.equal(request.args.timeout, 180_000);
  const overlong = await executeRouteIfRemote(f.context, route, 'execute_shell', 'execute_shell', { command: 'echo harmless', timeout: 600_000 });
  assert.equal(overlong?.ok, false); assert.equal(calls, 1);
  delete f.context.thinToolRpc!.supportsRemoteShellTimeout;
  await executeRouteIfRemote(f.context, route, 'execute_shell', 'execute_shell', { command: 'echo harmless', timeout: 180_000 });
  assert.equal(request.timeoutMs, undefined, 'old server preserves old wire behavior');
});

test('runner renews before tool dispatch and cleans up on completion', async () => {
  const f = fixture(); f.context.deviceGrants![0].expiresAt = Date.now() + 120_000;
  let calls = 0;
  const runner = new ConversationRunner({ async chat() { calls++; return calls === 1
    ? { toolCalls: [{ id: 'one', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }
    : { content: 'done', toolCalls: [] }; } } as any,
  { getToolDefinitions: () => [{ name: 'read_file', description: 'test', parameters: { type: 'object', properties: {} } }],
    async executeTool(_call: any, _history: any, context: any) {
      assert.equal(context.deviceGrants[0].grantId, 'renewed-1');
      return { ok: true, content: 'read' };
    } }, { stream: false, toolExecutionContext: f.context });
  await runner.run([{ role: 'user', content: 'read the file' }]);
  assert.equal(f.renewals(), 1); assert.equal((runner as any).deviceGrantLease, undefined);
});

test('runner heartbeat renews while the model is thinking, then stops after completion', async t => {
  const initialNow = Date.now();
  (t.mock.timers as any).enable({ apis: ['setInterval', 'Date'], now: initialNow });
  const f = fixture();
  let renewals = 0;
  f.context.thinToolRpc!.renewGrant = async grant => {
    renewals++;
    return { ...grant, grantId: `heartbeat-${renewals}`, expiresAt: Date.now() + 600_000 };
  };
  let finish!: (value: any) => void;
  const runner = new ConversationRunner({ async chat() { return new Promise(resolve => { finish = resolve; }); } } as any,
    { getToolDefinitions: () => [], executeTool: async () => { throw new Error('not expected'); } },
    { stream: false, toolExecutionContext: f.context });
  const running = runner.run([{ role: 'user', content: 'long analysis' }]);
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 24; i++) {
    (t.mock.timers as any).tick(30_000);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(renewals >= 2, 'authorization expired while model was busy');
  finish({ content: 'done', toolCalls: [] });
  await running;
  const count = renewals;
  (t.mock.timers as any).tick(600_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renewals, count);
});

test('uncertain mutations are never replayable, while definite grant denial and read errors are preserved', () => {
  for (const tool of ['execute_shell', 'write_file', 'edit_file', 'send_file', 'import_file']) {
    for (const error of [new CatsSendError('transport', 'connection closed'), new CatsSendError('timeout', 'RPC result deadline')]) {
      const result = unknownRemoteMutationResult(tool, error);
      assert.equal(result?.ok, false);
      if (result && !result.ok) {
        assert.equal(result.retryable, false);
        assert.match(result.message, /无法确认是否已执行/);
      }
    }
    assert.equal(unknownRemoteMutationResult(tool, { errorCode: 'PERMISSION_DENIED', message: 'grant expired' }), undefined);
    assert.equal(unknownRemoteMutationResult(tool, new Error('device grant expired')), undefined);
    for (const error of [new Error('connection closed'), { kind: 'timeout' },
      { errorCode: 'EXECUTION_TIMEOUT', message: 'started; command was killed at deadline' },
      { errorCode: 'TOOL_EXECUTION_ERROR', message: 'EACCES /srv/transport/config.json' },
      { errorCode: 'TOOL_EXECUTION_ERROR', message: 'timeout 5 npm test: exit 254' },
      { errorCode: 'TOOL_EXECUTION_ERROR', message: 'curl: (28) Connection timed out' }]) {
      assert.equal(unknownRemoteMutationResult(tool, error), undefined);
    }
  }
  assert.equal(unknownRemoteMutationResult('read_file', new CatsSendError('timeout', 'RPC deadline')), undefined);
});

test('thin mutation transport timeout and disconnect return unknown result without redispatch or device fallback', async () => {
  for (const kind of ['transport', 'timeout'] as const) {
    const f = fixture(); let calls = 0;
    f.context.thinToolRpc!.executeTool = async request => {
      calls++; assert.equal(request.targetDeviceId, 'a');
      throw new CatsSendError(kind, 'no final RPC result');
    };
    const route = resolveExecutionRoute(f.context, { toolName: 'execute_shell', operation: 'execute_shell', target: 'a' });
    const result = await executeRouteIfRemote(f.context, route, 'execute_shell', 'execute_shell', { command: 'echo harmless' });
    assert.equal(result?.ok, false);
    if (result && !result.ok) { assert.equal(result.retryable, false); assert.match(result.message, /无法确认是否已执行/); }
    assert.equal(calls, 1);
  }
});

test('legacy device transport also prevents blind mutation replay after timeout', async () => {
  for (const kind of ['transport', 'timeout'] as const) {
    const f = fixture(); let calls = 0;
    f.context.deviceRpc = { executeTool: async () => {
      calls++;
      throw new CatsSendError(kind, 'no final RPC result');
    } } as any;
    const result = await executeRemoteDeviceRpcTool(f.context,
      { ok: true, mode: 'remote', grant: f.context.deviceGrants![0], targetDeviceId: 'a' },
      'execute_shell', 'execute_shell', { command: 'echo harmless' });
    assert.equal(result?.ok, false);
    if (result && !result.ok) assert.equal(result.retryable, false);
    assert.equal(calls, 1);
  }
});

test('confirmed tool failures preserve their output on both RPC transports regardless of timeout words', async () => {
  for (const thin of [true, false]) {
    for (const failure of [
      { ok: false as const, errorCode: 'EXECUTION_TIMEOUT', message: 'started\ncommand killed at deadline', retryable: false },
      { ok: false as const, errorCode: 'TOOL_EXECUTION_ERROR', message: 'curl: (28) Connection timed out\nexit 28', retryable: false },
      { ok: false as const, errorCode: 'TOOL_EXECUTION_ERROR', message: 'timeout 5 npm test: exit 254', retryable: false },
      { ok: false as const, errorCode: 'TOOL_EXECUTION_ERROR', message: 'EACCES /srv/transport/config.json', retryable: false },
    ]) {
      const f = fixture();
      let calls = 0;
      const executeTool = async () => { calls++; return failure; };
      let result;
      if (thin) {
        f.context.thinToolRpc!.executeTool = executeTool;
        const route = resolveExecutionRoute(f.context, { toolName: 'execute_shell', operation: 'execute_shell', target: 'a' });
        result = await executeRouteIfRemote(f.context, route, 'execute_shell', 'execute_shell', { command: 'fixture only' });
      } else {
        f.context.deviceRpc = { executeTool };
        result = await executeRemoteDeviceRpcTool(f.context,
          { ok: true, mode: 'remote', grant: f.context.deviceGrants![0], targetDeviceId: 'a' },
          'execute_shell', 'execute_shell', { command: 'fixture only' });
      }
      assert.equal(result?.ok, false);
      if (result && !result.ok) {
        assert.equal(result.errorCode, failure.errorCode);
        assert.ok(result.message.includes(failure.message));
        assert.doesNotMatch(result.message, /无法确认是否已执行/);
      }
      assert.equal(calls, 1);
    }
  }
});

test('real transport adapters separate RPC envelope timeout from a complete device tool timeout', async () => {
  const grant = fixture().context.deviceGrants![0];
  const deviceResult = { ok: false, errorCode: 'EXECUTION_TIMEOUT', message: 'started\ncommand killed', retryable: false };
  for (const thin of [true, false]) {
    for (const envelope of [true, false]) {
      const bot = Object.create(CatsCompanyBot.prototype) as any;
      const reply = async () => envelope ? { error: { code: thin ? 'thin_tool_rpc_timeout' : 'device_rpc_timeout', message: 'wire deadline' } }
        : { result: deviceResult };
      bot.bot = { sendThinToolRpcRequest: reply, sendDeviceRpcRequest: reply };
      const transport = thin ? bot.buildThinToolRpcTransport() : bot.buildDeviceRpcTransport();
      const result = await transport.executeTool({ grant, targetOwnerUserId: grant.ownerUserId,
        targetDeviceId: grant.deviceId, operation: 'execute_shell', toolName: 'execute_shell', args: {} });
      assert.equal(result.ok, false);
      assert.equal(result.retryable, false);
      if (envelope) assert.match(result.message, /无法确认是否已执行/);
      else assert.equal(result.message, deviceResult.message);
    }
  }
});

test('renewal tolerates fixed server clock skew but rejects excessive extension and a 24h chain breach', async () => {
  for (const skew of [-120_000, 120_000]) {
    const localNow = Date.now();
    let now = localNow;
    const f = fixture();
    const grant = f.context.deviceGrants![0];
    grant.createdAt = localNow + skew;
    grant.expiresAt = grant.createdAt + 600_000;
    f.context.thinToolRpc!.renewGrant = async old => ({ ...old, grantId: 'skew-renewed', expiresAt: now + skew + 600_000 });
    const lease = new DeviceGrantLease(() => f.context, () => true, () => now);
    now += 240_000 + Math.max(skew, 0);
    await lease.refresh();
    assert.equal(grant.grantId, 'skew-renewed', `fixed skew ${skew}`);
    assert.equal(lease.getDiagnostics().renewed, 1);
  }
  const old = fixture().context.deviceGrants![0];
  assert.equal(isDeviceGrantRenewal(old, { ...old, grantId: 'too-long', expiresAt: old.expiresAt + 600_001 }), false);
  const nearCap = { ...old, createdAt: Date.now() - 24 * 60 * 60_000 + 30_000, expiresAt: Date.now() + 30_000 };
  assert.equal(isDeviceGrantRenewal(nearCap, { ...nearCap, grantId: 'past-cap', expiresAt: nearCap.expiresAt + 1 }), false);
});

test('renewal diagnostics are counted, throttled and never log raw errors or bearer IDs', async t => {
  const logs: string[] = [];
  t.mock.method(Logger, 'warning', (line: string) => { logs.push(line); });
  for (const reason of ['denied', 'invalid_response', 'timeout', 'transport', 'unsupported'] as const) {
    const f = fixture(); f.advance(300_000);
    if (reason === 'unsupported') delete f.context.thinToolRpc!.renewGrant;
    else f.context.thinToolRpc!.renewGrant = async () => {
      if (reason === 'timeout' || reason === 'transport') throw new CatsSendError(reason, 'SECRET-BEARER /private/file');
      throw new DeviceGrantRenewalError(reason);
    };
    const before = logs.length;
    await f.lease.refresh(); await f.lease.refresh();
    f.advance(30_001); await f.lease.refresh();
    assert.equal(logs.length - before, 1, reason);
    assert.match(logs[before], new RegExp(`outcome=${reason}`));
    assert.ok((f.lease.getDiagnostics()[reason] || 0) >= 2);
    assert.equal(f.context.deviceGrants![0].grantId, 'fake-scoped-grant');
  }
  assert.doesNotMatch(logs.join('\n'), /SECRET|BEARER|fake-scoped-grant|private/);
});

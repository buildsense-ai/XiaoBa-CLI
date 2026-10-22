import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedDeviceContext } from './helpers/scoped-device-context';
import { buildTargetRoutes } from '../src/catscompany/runtime-context';
import { resolveExecutionRoute, executeRouteIfRemote } from '../src/tools/execution-router';
import type { ToolExecutionContext } from '../src/types/tool';
import { CatsCompanyBot } from '../src/catscompany/index';

function fixture() {
  const calls: unknown[] = [];
  const ctx: ToolExecutionContext = {
    workingDirectory: '.', surface: 'catscompany',
    ...scopedDeviceContext('usr7', 'audit-a', ['read_file', 'send_file']),
    targetRoutes: buildTargetRoutes([{ userId: 'usr7', ownerUserId: 'usr7', deviceId: 'audit-a',
      label: 'Audit A', userName: 'Alice', os: 'windows', status: 'ready' }]),
    thinToolRpc: { executeTool: async request => { calls.push(request); return { ok: true, content: 'fake' }; } },
  };
  return { ctx, calls };
}

test('scoped thin route transmits authorization separately from model arguments', async () => {
  const { ctx, calls } = fixture();
  const route = resolveExecutionRoute(ctx, { toolName: 'read_file', operation: 'read_file', target: 'Alice' });
  assert.equal(route.ok, true);
  const result = await executeRouteIfRemote(ctx, route, 'read_file', 'read_file', { file_path: 'placeholder', target: 'Alice' });
  assert.equal(result?.ok, true);
  assert.equal(calls.length, 1);
  const request = calls[0] as any;
  assert.equal(request.grant.grantId, ctx.deviceGrants![0].grantId);
  assert.deepEqual(request.args, { file_path: 'placeholder' });
});

for (const variant of ['no scope', 'untrusted scope', 'no grant', 'wrong owner', 'wrong actor', 'wrong session',
  'wrong bot', 'wrong body', 'wrong device', 'expired', 'revoked', 'untrusted grant', 'wrong operation']) {
  test(`scoped thin route rejects ${variant} before dispatch`, async () => {
    const { ctx, calls } = fixture();
    const grant = ctx.deviceGrants![0];
    switch (variant) {
      case 'no scope': ctx.executionScope = undefined; break;
      case 'untrusted scope': ctx.executionScope!.identityTrust = 'legacy_context'; break;
      case 'no grant': ctx.deviceGrants = []; break;
      case 'wrong owner': grant.ownerUserId = 'usr8'; break;
      case 'wrong actor': grant.actorUserId = 'usr8'; break;
      case 'wrong session': grant.sessionKey = 'another-session'; break;
      case 'wrong bot': grant.agentId = 'usr44'; break;
      case 'wrong body': grant.agentBodyId = 'another-body'; break;
      case 'wrong device': grant.deviceId = 'audit-b'; break;
      case 'expired': grant.expiresAt = Date.now() - 1; break;
      case 'revoked': grant.status = 'revoked'; break;
      case 'untrusted grant': grant.identityTrust = 'legacy_context'; break;
      case 'wrong operation': grant.operations = ['glob']; break;
    }
    const route = resolveExecutionRoute(ctx, { toolName: 'read_file', operation: 'read_file', target: 'Alice' });
    assert.equal(route.ok, false, JSON.stringify(route));
    await executeRouteIfRemote(ctx, route, 'read_file', 'read_file', { file_path: 'placeholder' });
    assert.equal(calls.length, 0);
  });
}

test('grant expiry between resolution and dispatch never falls back to another transport', async () => {
  const { ctx, calls } = fixture();
  ctx.deviceRpc = { executeTool: async () => { throw new Error('must not fallback'); } };
  const route = resolveExecutionRoute(ctx, { toolName: 'read_file', operation: 'read_file', target: 'Alice' });
  assert.equal(route.ok, true);
  ctx.deviceGrants![0].expiresAt = Date.now() - 1;
  const result = await executeRouteIfRemote(ctx, route, 'read_file', 'read_file', { file_path: 'placeholder' });
  assert.equal(result?.ok, false);
  assert.equal(calls.length, 0);
});

test('same bot cannot reuse user A authorization for a user B turn', () => {
  const { ctx } = fixture();
  ctx.executionScope!.actorUserId = 'usr8';
  const route = resolveExecutionRoute(ctx, { toolName: 'read_file', operation: 'read_file', target: 'Alice' });
  assert.equal(route.ok, false);
});

test('local cloud runtime execution is unchanged when target is omitted', () => {
  const { ctx } = fixture();
  ctx.deviceGrants = [];
  const route = resolveExecutionRoute(ctx, { toolName: 'read_file', operation: 'read_file' });
  assert.equal(route.ok && route.mode, 'local');
});

for (const operation of ['execute_shell', 'write_file', 'edit_file'] as const) {
  test(`authorized ${operation} keeps existing arguments without a new approval protocol`, async () => {
    const { ctx, calls } = fixture();
    ctx.deviceGrants![0].operations = [operation];
    const args = operation === 'execute_shell'
      ? { command: 'echo routing-fixture', target: 'Alice' }
      : { file_path: 'test-only-placeholder', content: 'fixture', target: 'Alice' };
    const route = resolveExecutionRoute(ctx, { toolName: operation, operation, target: 'Alice' });
    assert.equal(route.ok, true);
    const result = await executeRouteIfRemote(ctx, route, operation, operation, args);
    assert.equal(result?.ok, true);
    assert.equal(calls.length, 1);
    const { target, ...expected } = args;
    assert.deepEqual((calls[0] as any).args, expected);
    // This transport fixture executes no shell commands and writes no files.
  });

  test(`server-host ${operation} remains local without a desktop grant`, () => {
    const { ctx, calls } = fixture();
    ctx.deviceGrants = [];
    const route = resolveExecutionRoute(ctx, { toolName: operation, operation });
    assert.equal(route.ok && route.mode, 'local');
    assert.equal(calls.length, 0);
  });
}

test('cloud Bot transport serializes scoped authorization and rejects an old unscoped caller', async () => {
  const { ctx } = fixture();
  const requests: any[] = [];
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.bot = { sendThinToolRpcRequest: async (request: any) => {
    requests.push(request);
    return { result: { ok: true, content: 'mock receiver' } };
  } };
  const transport = bot.buildThinToolRpcTransport();
  const request = { targetOwnerUserId: 'usr7', targetDeviceId: 'audit-a', toolName: 'read_file', args: { file_path: 'placeholder' } };
  const blocked = await transport.executeTool(request);
  assert.equal(blocked.ok, false);
  assert.equal(requests.length, 0);
  const grant = ctx.deviceGrants![0];
  grant.expiresAt = Date.now() + 10_000;
  const result = await transport.executeTool({ ...request, grant, timeoutMs: 60_000 });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].grant_id, grant.grantId);
  assert.equal(requests[0].session_key, ctx.executionScope!.sessionKey);
  assert.equal(requests[0].actor_user_id, 'usr7');
  assert.equal(requests[0].expires_at, grant.expiresAt);
  assert.deepEqual(requests[0].payload, { args: request.args });
  assert.equal(bot.mapDeviceRpcToolErrorCode('device_authorization_required'), 'PERMISSION_DENIED');
  assert.equal(bot.isRetryableDeviceRpcError('device_authorization_required'), false);
});

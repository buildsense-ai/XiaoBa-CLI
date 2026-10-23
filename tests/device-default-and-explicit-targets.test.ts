import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionScope, createCatsCoMessageEnvelope } from '../src/catscompany/message-envelope';
import { extractCatsCoDeviceGrants } from '../src/catscompany/device-grants';
import { extractCatsCoDeviceSelection } from '../src/catscompany/device-selection';
import { extractCatsCoRuntimeContext } from '../src/catscompany/runtime-context';
import { buildRuntimeContextSnapshot, buildRuntimeContextText } from '../src/core/runtime-context-builder';
import { resolveExecutionRoute, executeRouteIfRemote } from '../src/tools/execution-router';
import { CatsCompanyBot } from '../src/catscompany';
import type { ToolExecutionContext } from '../src/types/tool';

function fixture(selected: 'selected' | 'unavailable' | 'needs_selection' = 'selected') {
  const sessionKey = 'session:v2:catscompany:p2p:p2p_7_42:agent:usr42';
  const common = { source: 'catscompany', sessionKey, topicId: 'p2p_7_42', topicType: 'p2p', actorUserId: 'usr7', agentId: 'usr42' };
  const grants = ['a', 'b'].filter(id => id !== 'a' || selected !== 'unavailable').map(id => ({
    ...common, kind: 'user_device_grant', grantId: `grant-${id}`, deviceId: id, ownerUserId: 'usr7',
    targetScope: 'explicit_device', selectionRevision: 'r1', identityTrust: 'server_canonical', status: 'active',
    operations: ['read_file', 'write_file'], createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  }));
  const selection = { ...common, kind: 'user_device_selection', revision: 'r1', status: selected,
    ...(selected === 'needs_selection' ? {} : { selectedDevice: { deviceId: 'a', displayName: 'Eason' } }),
    candidates: ['a', 'b'].map(id => ({ deviceId: id, displayName: id === 'a' ? 'Eason' : 'FFFFFFFK', os: 'windows',
      active: id !== 'a' || selected !== 'unavailable', routeConnected: true, routable: true })),
  };
  const metadata = {
    catsco_identity: {
      device_grants: selected === 'selected' ? [{ ...grants.find(grant => grant.deviceId === 'a')!, targetScope: undefined, grantId: 'default-a' }] : [],
      device_target_authorizations: { schema: 'catsco.device-targets.v1', grants },
      device_selection: selection, permissions: { source: 'server_canonical_message' },
    },
    // A legacy directory may contain only the most recently active device.
    xiaoba_runtime: { schema: 'xiaoba.runtime.v1', devices: [{ userId: 'usr7', deviceId: 'b', label: 'FFFFFFFK', os: 'windows' }] },
  };
  const scope = createExecutionScope(createCatsCoMessageEnvelope({ topic: 'p2p_7_42', senderId: 'usr7', text: 'test', botUid: '42' }));
  Object.assign(scope, common, { identityTrust: 'server_canonical', isTrusted: true });
  const calls: any[] = [];
  const ctx: ToolExecutionContext = {
    surface: 'catscompany', workingDirectory: '.', executionScope: scope,
    deviceGrants: extractCatsCoDeviceGrants(metadata, scope),
    deviceSelection: extractCatsCoDeviceSelection(metadata, scope),
    targetRoutes: extractCatsCoRuntimeContext(metadata, scope),
    thinToolRpc: { executeTool: async (request: any) => { calls.push(request); return { ok: true, content: 'done' }; } },
  };
  return { ctx, calls, metadata, scope };
}

const resolve = (ctx: ToolExecutionContext, target: string) => resolveExecutionRoute(ctx, { toolName: 'write_file', operation: 'write_file', target });

test('legacy directory is completed from canonical metadata; default A does not mean newest B', () => {
  const { ctx } = fixture();
  assert.equal(ctx.targetRoutes?.routes.length, 2);
  const route = resolve(ctx, 'speaker_default');
  assert.ok(route.ok && route.mode === 'remote');
  assert.equal(route.targetDeviceId, 'a');
  assert.equal(ctx.deviceSelection?.revision, 'r1');
});

test('explicit B and multi-device calls use distinct grants without changing default A', async () => {
  const { ctx, calls } = fixture();
  for (const target of ['FFFFFFFK', 'Eason', 'speaker_default']) {
    const route = resolve(ctx, target);
    assert.ok(route.ok && route.mode === 'remote');
    const result = await executeRouteIfRemote(ctx, route, 'write_file', 'write_file', { file_path: 'fixture-only', content: 'test' });
    assert.equal(result?.ok, true);
  }
  assert.deepEqual(calls.map(call => call.targetDeviceId), ['b', 'a', 'a']);
  assert.deepEqual(calls.map(call => call.grant.grantId), ['grant-b', 'grant-a', 'default-a']);
  assert.deepEqual(calls.map(call => call.targetScope), ['explicit_device', 'explicit_device', undefined]);
  assert.equal(ctx.deviceSelection?.selectedDeviceId, 'a');
});

test('both RPC transports preserve exact target scope and keep default requests unscoped', async () => {
  for (const transport of ['thin', 'device']) {
    const { ctx } = fixture();
    const wires: any[] = [];
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    const capture = async (wire: any) => {
      wires.push(wire);
      return { result: { ok: true, content: 'fixture only' } };
    };
    bot.bot = { sendThinToolRpcRequest: capture, sendDeviceRpcRequest: capture };
    for (const target of ['FFFFFFFK', 'speaker_default']) {
      // Resolve through the canonical directory, then exercise each dispatch
      // path independently, including the Device RPC fallback serializer.
      ctx.thinToolRpc = bot.buildThinToolRpcTransport();
      ctx.deviceRpc = bot.buildDeviceRpcTransport();
      const route = resolve(ctx, target);
      assert.ok(route.ok && route.mode === 'remote');
      if (transport === 'device') ctx.thinToolRpc = undefined;
      const result = await executeRouteIfRemote(ctx, route, 'write_file', 'write_file',
        { target, file_path: 'fixture-only', content: 'test' });
      assert.equal(result?.ok, true, transport);
    }
    assert.deepEqual(wires.map(wire => wire.target_scope), ['explicit_device', undefined], transport);
    assert.deepEqual(wires.map(wire => wire.target_device_id ?? wire.device_id), ['b', 'a'], transport);
    assert.deepEqual(wires.map(wire => wire.grant_id), ['grant-b', 'default-a'], transport);
    assert.ok(wires.every(wire => wire.payload.args.target === undefined));
    assert.equal(ctx.deviceSelection?.selectedDeviceId, 'a');
  }
});

test('both RPC transports reject target scope and grant mismatches before sending', async () => {
  const { ctx } = fixture();
  let sent = 0;
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.bot = {
    sendThinToolRpcRequest: async () => { sent++; },
    sendDeviceRpcRequest: async () => { sent++; },
  };
  for (const transport of [bot.buildThinToolRpcTransport(), bot.buildDeviceRpcTransport()]) {
    for (const grant of ctx.deviceGrants!) {
      const result = await transport.executeTool({
        toolName: 'write_file', operation: 'write_file', args: {}, grant,
        targetDeviceId: grant.deviceId, targetOwnerUserId: grant.ownerUserId,
        targetScope: grant.targetScope ? undefined : 'explicit_device',
      });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
    }
  }
  assert.equal(sent, 0);
});

test('offline default A never falls back to B, but explicitly requested B remains usable', () => {
  const { ctx } = fixture('unavailable');
  const explicit = resolve(ctx, 'FFFFFFFK');
  assert.ok(explicit.ok && explicit.mode === 'remote' && explicit.targetDeviceId === 'b');
  assert.equal(resolve(ctx, 'speaker_default').ok, false);
});

test('without a default an exact device is usable; snapshot must not advertise the first grant as default', () => {
  const { ctx } = fixture('needs_selection');
  assert.equal(resolve(ctx, 'FFFFFFFK').ok, true);
  const snapshot = buildRuntimeContextSnapshot({ sessionKey: ctx.executionScope!.sessionKey, executionScope: ctx.executionScope,
    deviceSelection: ctx.deviceSelection, deviceGrants: ctx.deviceGrants });
  assert.equal(snapshot?.executionTargets.find(target => target.id === 'speaker_default')?.status, 'unavailable');
  assert.equal(resolve(ctx, 'speaker_default').ok, false);
});

test('explicit B cannot borrow A grant, old selected-only grant, wrong revision, or expired authorization', () => {
  for (const kind of ['missing-b', 'old-server', 'revision', 'expired', 'foreign-owner', 'foreign-session', 'untrusted-selection']) {
    const { ctx } = fixture();
    const b = ctx.deviceGrants!.find(grant => grant.deviceId === 'b')!;
    if (kind === 'missing-b') ctx.deviceGrants = ctx.deviceGrants!.filter(grant => grant.deviceId !== 'b');
    if (kind === 'old-server') delete b.targetScope;
    if (kind === 'revision') b.selectionRevision = 'old';
    if (kind === 'expired') b.expiresAt = Date.now() - 1;
    if (kind === 'foreign-owner') b.ownerUserId = 'usr8';
    if (kind === 'foreign-session') b.sessionKey = 'other';
    if (kind === 'untrusted-selection') ctx.deviceSelection!.identityTrust = 'untrusted';
    assert.equal(resolve(ctx, 'FFFFFFFK').ok, false, kind);
  }
});

test('canonical directory enrichment does not accept forged permissions or another account', () => {
  for (const kind of ['permission', 'actor', 'grant-revision']) {
    const { metadata, scope } = fixture();
    if (kind === 'permission') metadata.catsco_identity.permissions.source = 'client';
    if (kind === 'actor') scope.actorUserId = 'usr8';
    if (kind === 'grant-revision') metadata.catsco_identity.device_target_authorizations.grants.forEach(grant => { grant.selectionRevision = 'old'; });
    assert.notEqual(extractCatsCoRuntimeContext(metadata, scope)?.routes.length, 2, kind);
  }
});

test('default requests never borrow explicit grants, including when the default IDs match', () => {
  const { ctx } = fixture();
  ctx.deviceGrants = ctx.deviceGrants!.filter(grant => grant.targetScope === 'explicit_device');
  assert.equal(resolve(ctx, 'speaker_default').ok, false);
  assert.equal(resolve(ctx, 'Eason').ok, true);
});

test('explicit capabilities are accepted only from the separate versioned envelope', () => {
  for (const location of ['legacy-list', 'unknown-envelope']) {
    const { metadata, scope } = fixture();
    const explicit = metadata.catsco_identity.device_target_authorizations;
    if (location === 'legacy-list') {
      (metadata.catsco_identity.device_grants as any[]).push(...explicit.grants);
    }
    explicit.schema = 'unsupported';
    const grants = extractCatsCoDeviceGrants(metadata, scope)!;
    assert.equal(grants.length, 1);
    assert.equal(grants[0].grantId, 'default-a');
  }
});

test('agent-host tools stay local and prompt distinguishes defaults from explicit task targets', () => {
  const { ctx } = fixture();
  const route = resolveExecutionRoute(ctx, { toolName: 'write_file', operation: 'write_file' });
  assert.ok(route.ok && route.mode === 'local');
  const prompt = buildRuntimeContextText(ctx.targetRoutes, undefined, undefined, ctx.deviceSelection);
  assert.match(prompt, /不必再次询问设备名/);
  assert.match(prompt, /本次任务的目标，不改变默认设备/);
  assert.match(prompt, /分别报告实际成功或失败/);
  assert.doesNotMatch(prompt, /与选择不一致时/);
});

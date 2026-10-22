import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatsCoMessageEnvelope, createExecutionScope } from '../src/catscompany/message-envelope';
import { extractCatsCoDeviceGrants } from '../src/catscompany/device-grants';
import { extractCatsCoDeviceSelection } from '../src/catscompany/device-selection';
import { extractCatsCoRuntimeContext } from '../src/catscompany/runtime-context';
import { createCatsCoSessionRoute } from '../src/core/session-router';
import { validateDeviceGrant } from '../src/core/device-grants';
import { executeRouteIfRemote, resolveExecutionRoute } from '../src/tools/execution-router';
import { resolveToolGatewayAccess } from '../src/tools/tool-gateway';
import type { ToolExecutionContext } from '../src/types/tool';

// Wire-shaped fixtures deliberately do not obtain the authorization key from
// CLI scope helpers. The paired Go contract also supplies server-built metadata.
function message(actor = 'usr7', agent = 'usr573', topic = 'grp_5791', type: 'group' | 'p2p' = 'group') {
  const sessionKey = type === 'group'
    ? `session:v2:catscompany:group:${topic}%3Aactor%3A${actor}:agent:${agent}`
    : `session:v2:catscompany:p2p:${topic}:agent:${agent}`;
  const metadata = {
    catsco_identity: {
      actor: { user_id: actor }, agent: { agent_id: agent, body_id: 'cloud-body' },
      topic: { topic_id: topic, type, channel_seq: 1 },
      permissions: { source: 'server_canonical_message' },
      device_selection: {
        kind: 'user_device_selection', source: 'catscompany', status: 'selected',
        sessionKey, topicId: topic, topicType: type, actorUserId: actor, agentId: agent,
        selectedDeviceId: 'device-a', selectedDeviceDisplayName: 'Eason',
      },
      device_grants: [{
        kind: 'user_device_grant', source: 'catscompany', status: 'active',
        identityTrust: 'server_canonical', grantId: `grant-${actor}-${agent}`, deviceId: 'device-a',
        sessionKey, topicId: topic, topicType: type, actorUserId: actor, ownerUserId: actor,
        agentId: agent, agentBodyId: 'cloud-body', operations: ['read_file', 'resolve_common_directory'],
        createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      }],
    },
    xiaoba_runtime: {
      schema: 'xiaoba.runtime.v2', ownerUserId: actor,
      devices: [
        { userId: actor, deviceId: 'device-a', label: 'Eason', status: 'ready' },
        { userId: actor, deviceId: 'device-b', label: 'Other PC', status: 'ready' },
      ],
    },
  };
  return { topic, senderId: actor, botUid: agent.replace(/^usr/, ''), text: '读取桌面文件', metadata };
}

function context(input = message()) {
  const envelope = createCatsCoMessageEnvelope(input);
  const executionScope = createExecutionScope(envelope);
  const calls: unknown[] = [];
  const ctx: ToolExecutionContext = {
    workingDirectory: '.', surface: 'catscompany', executionScope,
    deviceSelection: extractCatsCoDeviceSelection(input.metadata, executionScope),
    deviceGrants: extractCatsCoDeviceGrants(input.metadata, executionScope),
    targetRoutes: extractCatsCoRuntimeContext(input.metadata, executionScope),
    thinToolRpc: { executeTool: async request => { calls.push(request); return { ok: true, content: 'device-a result' }; } },
  };
  return { ctx, envelope, calls };
}

const routeOptions = { toolName: 'read_file', operation: 'read_file' as const, target: 'speaker_default' };

test('group message accepts actor-scoped device authorization without changing shared history', async () => {
  const { ctx, envelope, calls } = context();
  assert.equal(envelope.sessionKey, 'cc_group:grp_5791');
  assert.equal(createCatsCoSessionRoute(envelope).sessionKey, envelope.sessionKey);
  assert.equal(ctx.executionScope!.sessionKey, envelope.sessionKey);
  assert.equal(ctx.deviceSelection?.sessionKey, 'session:v2:catscompany:group:grp_5791%3Aactor%3Ausr7:agent:usr573');
  assert.equal(ctx.deviceGrants?.length, 1);
  for (const target of ['speaker_default', 'Eason', 'device-a']) {
    const route = resolveExecutionRoute(ctx, { ...routeOptions, target });
    assert.ok(route.ok && route.mode === 'remote', JSON.stringify(route));
    assert.equal(route.targetDeviceId, 'device-a');
    assert.equal(route.grant?.sessionKey, ctx.deviceSelection!.sessionKey);
    const result = await executeRouteIfRemote(ctx, route, 'read_file', 'read_file', { file_path: 'identity.txt', target });
    assert.equal(result?.ok, true);
  }
  assert.equal(calls.length, 3);
  assert.equal(envelope.legacyRestoreKey, 'cc_group:grp_5791');
  assert.equal(envelope.legacyCleanupKey, 'cc_group:grp_5791');
});

test('group authorization also passes the Device RPC gateway', () => {
  const { ctx } = context();
  ctx.localDeviceGrant = { kind: 'catscompany_body', source: 'catscompany', bodyId: 'different-cloud-body', createdAt: Date.now() };
  ctx.deviceRpc = { executeTool: async () => { throw new Error('gateway check must not dispatch'); } };
  const gateway = resolveToolGatewayAccess(ctx, { toolName: 'read_file', operation: 'read_file' });
  assert.ok(gateway.ok && gateway.mode === 'remote', JSON.stringify(gateway));
  assert.equal(gateway.targetDeviceId, 'device-a');
});

test('private chat keeps its existing authorization and history scope', () => {
  const { ctx, envelope } = context(message('usr7', 'usr573', 'p2p_7_573', 'p2p'));
  assert.equal(envelope.sessionKey, 'session:v2:catscompany:p2p:p2p_7_573:agent:usr573');
  assert.equal(ctx.deviceGrants?.length, 1);
  assert.ok(resolveExecutionRoute(ctx, routeOptions).ok);
});

for (const [name, other] of [
  ['actor', message('usr8')], ['bot', message('usr7', 'usr574')], ['group', message('usr7', 'usr573', 'grp_5792')],
] as const) {
  test(`group rejects another ${name}'s grants and selection at extraction and dispatch`, () => {
    const input = message();
    input.metadata.catsco_identity.device_grants = other.metadata.catsco_identity.device_grants;
    input.metadata.catsco_identity.device_selection = other.metadata.catsco_identity.device_selection;
    const { ctx, calls } = context(input);
    assert.equal(ctx.deviceGrants, undefined);
    assert.equal(ctx.deviceSelection, undefined);
    assert.equal(resolveExecutionRoute(ctx, routeOptions).ok, false);
    const otherContext = context(other).ctx;
    // In-memory injection must also fail, even after bypassing extraction.
    ctx.deviceSelection = otherContext.deviceSelection;
    ctx.deviceGrants = otherContext.deviceGrants;
    assert.equal(resolveExecutionRoute(ctx, routeOptions).ok, false);
    assert.equal(validateDeviceGrant(ctx, ctx.deviceGrants![0], { operation: 'read_file' }).ok, false);
    assert.equal(calls.length, 0);
  });
}

for (const [name, change] of [
  ['history key used as authorization', (input: ReturnType<typeof message>) => {
    input.metadata.catsco_identity.device_selection.sessionKey = 'cc_group:grp_5791';
    input.metadata.catsco_identity.device_grants[0].sessionKey = 'cc_group:grp_5791';
  }],
  ['wrong owner', (input: ReturnType<typeof message>) => { input.metadata.catsco_identity.device_grants[0].ownerUserId = 'usr8'; }],
  ['wrong body', (input: ReturnType<typeof message>) => { input.metadata.catsco_identity.device_grants[0].agentBodyId = 'other-body'; }],
  ['untrusted envelope', (input: ReturnType<typeof message>) => { input.senderId = 'usr8'; }],
  ['configured bot mismatch', (input: ReturnType<typeof message>) => { input.botUid = '574'; }],
] as const) {
  test(`group rejects ${name}`, () => {
    const input = message();
    change(input);
    const { ctx, calls } = context(input);
    assert.equal(ctx.deviceGrants, undefined);
    assert.equal(resolveExecutionRoute(ctx, routeOptions).ok, false);
    assert.equal(calls.length, 0);
  });
}

test('offline group selection never falls back to another ready device', () => {
  const input = message();
  input.metadata.catsco_identity.device_selection.status = 'unavailable';
  input.metadata.xiaoba_runtime.devices[0].status = 'unavailable';
  const { ctx, calls } = context(input);
  assert.equal(ctx.deviceSelection?.status, 'unavailable');
  const route = resolveExecutionRoute(ctx, routeOptions);
  assert.ok(!route.ok && route.errorCode === 'TARGET_UNAVAILABLE', JSON.stringify(route));
  assert.equal(calls.length, 0);
});

test('group dispatch rechecks grant expiration and changed selection', async () => {
  for (const change of ['expire', 'switch']) {
    const { ctx, calls } = context();
    const route = resolveExecutionRoute(ctx, routeOptions);
    assert.ok(route.ok && route.mode === 'remote');
    if (change === 'expire') ctx.deviceGrants![0].expiresAt = Date.now() - 1;
    else ctx.deviceSelection!.selectedDeviceId = 'device-b';
    const result = await executeRouteIfRemote(ctx, route, 'read_file', 'read_file', { file_path: 'identity.txt' });
    assert.equal(result?.ok, false);
    assert.equal(calls.length, 0);
  }
});

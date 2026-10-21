import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionRoute } from '../src/tools/execution-router';
import { buildTargetRoutes, extractCatsCoRuntimeContext } from '../src/catscompany/runtime-context';
import { buildRuntimeContextText } from '../src/core/runtime-context-builder';
import { scopedDeviceContext } from './helpers/scoped-device-context';
import type { ToolExecutionContext } from '../src/types/tool';

// Regression specifications for the observed alias drift. All transports are
// fake: these tests never contact a Connector or execute a filesystem tool.
function context(selectedStatus: 'selected' | 'unavailable'): ToolExecutionContext {
  const sessionKey = 'session:v2:catscompany:p2p:p2p_7_42:agent:usr42';
  return {
    workingDirectory: '.', workspaceRoot: '.', conversationHistory: [], surface: 'catscompany',
    executionScope: {
      source: 'catscompany', sessionKey, topicId: 'p2p_7_42', topicType: 'p2p',
      actorUserId: 'usr7', agentId: 'usr42', identityTrust: 'server_canonical', isTrusted: true,
    },
    deviceSelection: {
      kind: 'user_device_selection', source: 'catscompany', status: selectedStatus,
      sessionKey, topicId: 'p2p_7_42', topicType: 'p2p', actorUserId: 'usr7', agentId: 'usr42',
      identityTrust: 'server_canonical', selectedDeviceId: 'audit-a', selectedDeviceDisplayName: 'Laptop A',
    },
    // A later heartbeat changed the one-device-per-user runtime directory.
    targetRoutes: buildTargetRoutes([{
      userId: 'usr7', ownerUserId: 'usr7', userName: 'audit-alice',
      deviceId: 'audit-b', label: 'Laptop B', os: 'windows', status: 'ready',
    }]),
    thinToolRpc: { executeTool: async () => { throw new Error('test must never execute a remote tool'); } },
  };
}

test('multi-device regression: username alias must not override selected A with newer B', () => {
  const route = resolveExecutionRoute(context('selected'), { toolName: 'glob', operation: 'glob', target: 'audit-alice' });
  assert.ok(!route.ok || (route.mode === 'remote' && route.targetDeviceId === 'audit-a'),
    `must keep A or reject inconsistent metadata, got ${JSON.stringify(route)}`);
});

test('multi-device regression: unavailable selected A must not dispatch write to B', () => {
  const route = resolveExecutionRoute(context('unavailable'), { toolName: 'write_file', operation: 'write_file', target: 'audit-alice' });
  assert.equal(route.ok, false, `unavailable selection must fail closed, got ${JSON.stringify(route)}`);
});

function directoryContext() {
  const ctx = context('selected');
  const trusted = scopedDeviceContext('usr7', 'audit-a', ['glob']);
  ctx.executionScope = trusted.executionScope;
  ctx.deviceGrants = trusted.deviceGrants;
  ctx.deviceSelection = {
    ...ctx.deviceSelection!, ...trusted.executionScope!, kind: 'user_device_selection',
  };
  ctx.targetRoutes = buildTargetRoutes([
    { userId: 'usr7', ownerUserId: 'usr7', userName: 'audit-alice', deviceId: 'audit-b', label: 'Laptop B', os: 'windows', status: 'ready' },
    { userId: 'usr7', ownerUserId: 'usr7', userName: 'audit-alice', deviceId: 'audit-a', label: 'Laptop A', os: 'windows', status: 'ready' },
  ]);
  return ctx;
}

test('complete directory resolves username to selected A regardless of heartbeat order', () => {
  for (const target of ['audit-alice', 'usr7', 'speaker_default', 'audit-a', 'Laptop A']) {
    const route = resolveExecutionRoute(directoryContext(), { toolName: 'glob', operation: 'glob', target });
    assert.ok(route.ok && route.mode === 'remote' && route.targetDeviceId === 'audit-a', JSON.stringify(route));
  }
});

test('explicit B target cannot use A authorization or silently execute on A', () => {
  const route = resolveExecutionRoute(directoryContext(), { toolName: 'glob', operation: 'glob', target: 'Laptop B' });
  assert.equal(route.ok, false);
});

test('offline A remains visible and blocks username routing despite online B', () => {
  const ctx = directoryContext();
  ctx.targetRoutes!.routes.find(route => route.deviceId === 'audit-a')!.status = 'unavailable';
  ctx.deviceSelection!.status = 'unavailable';
  const route = resolveExecutionRoute(ctx, { toolName: 'glob', operation: 'glob', target: 'audit-alice' });
  assert.equal(route.ok, false);
  const prompt = buildRuntimeContextText(ctx.targetRoutes, undefined, undefined, ctx.deviceSelection);
  assert.match(prompt, /Laptop A.*暂时不可用/);
  assert.match(prompt, /Laptop B.*在线/);
  assert.match(prompt, /本轮设备选择：unavailable/);
  assert.doesNotMatch(prompt, /fake-scoped-grant/);
});

test('duplicate names including offline devices remain ambiguous', () => {
  const ctx = directoryContext();
  ctx.targetRoutes = buildTargetRoutes(ctx.targetRoutes!.routes.map(route => ({ ...route, label: 'Shared laptop', status: route.deviceId === 'audit-b' ? 'unavailable' : 'ready' })));
  const route = resolveExecutionRoute(ctx, { toolName: 'glob', operation: 'glob', target: 'Shared laptop' });
  assert.ok(!route.ok && route.errorCode === 'TARGET_AMBIGUOUS');
});

test('v2 directory requires trusted matching owner and does not discard offline computers', () => {
  const { executionScope } = scopedDeviceContext('usr7', 'audit-a', ['glob']);
  const metadata = { xiaoba_runtime: { schema: 'xiaoba.runtime.v2', ownerUserId: 'usr7', devices: [
    { userId: 'usr7', deviceId: 'audit-a', label: 'A', status: 'unavailable' },
    { userId: 'usr7', deviceId: 'audit-b', label: 'B', status: 'ready' },
    { userId: 'usr8', deviceId: 'foreign', label: 'Private', status: 'ready' },
  ] } };
  assert.equal(extractCatsCoRuntimeContext(metadata), undefined);
  const routes = extractCatsCoRuntimeContext(metadata, executionScope)!;
  assert.equal(routes.routes.length, 2);
  assert.equal(routes.routes[0].status, 'unavailable');
  assert.equal(routes.byName.get('audit-b')?.[0].deviceId, 'audit-b');
  assert.equal(extractCatsCoRuntimeContext(metadata, { ...executionScope!, actorUserId: 'usr8' }), undefined);
  assert.equal(extractCatsCoRuntimeContext(metadata, { ...executionScope!, identityTrust: 'untrusted' }), undefined);
});

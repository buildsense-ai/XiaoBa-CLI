import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceAuthorizationSessionKey, isDelegatedDeviceGrant, resolveDeviceGrant, validateDeviceGrant } from '../src/core/device-grants';
import { RequestDeviceAccessTool } from '../src/tools/request-device-access-tool';
import type { ExecutionScope, ScopedDeviceGrant } from '../src/types/session-identity';
import type { ToolExecutionContext } from '../src/types/tool';

const scope: ExecutionScope = {
  source: 'catscompany', topicId: 'grp_2', topicType: 'group', actorUserId: 'usr1', agentId: 'usr3',
  agentBodyId: 'cloud-b', sessionKey: 'cc_group:grp_2', channelSeq: 42,
  isTrusted: true, identityTrust: 'server_canonical',
};
function shared(overrides: Partial<ScopedDeviceGrant> = {}): ScopedDeviceGrant {
  return {
    kind: 'user_device_grant', source: 'catscompany', status: 'active', identityTrust: 'server_canonical',
    grantId: 'group-share-grant', identitySource: 'group_device_share', shareId: 'share-b', shareRevision: 3,
    actorUserId: 'usr1', ownerUserId: 'usr6', agentId: 'usr3', agentBodyId: 'cloud-b',
    deviceId: 'same-device-id', topicId: 'grp_2', topicType: 'group',
    sessionKey: getDeviceAuthorizationSessionKey(scope), operations: ['read_file'],
    createdAt: Date.now(), expiresAt: Date.now() + 60000, ...overrides,
  };
}

test('delegated group permission requires trusted, versioned group sharing provenance', () => {
  assert.equal(isDelegatedDeviceGrant(shared()), true);
  for (const mutation of [
    { shareId: undefined }, { shareRevision: 0 }, { shareRevision: 1.5 },
    { topicType: 'p2p' as const }, { identityTrust: 'untrusted' as const },
    { identitySource: 'model_asserted' },
  ]) assert.equal(isDelegatedDeviceGrant(shared(mutation)), false);
});

test('shared grants remain bound to actor, topic and executing Bot', () => {
  assert.equal(validateDeviceGrant({ executionScope: scope }, shared(), { operation: 'read_file' }).ok, true);
  for (const mutation of [{ actorUserId: 'usr9' }, { topicId: 'grp_8' }, { agentId: 'usr2' }]) {
    assert.equal(validateDeviceGrant({ executionScope: scope }, shared(mutation), { operation: 'read_file' }).ok, false);
  }
});

test('identical device IDs from different owners do not select the first grant', () => {
  const decision = resolveDeviceGrant({
    executionScope: scope,
    deviceGrants: [shared({ ownerUserId: 'usr1', identitySource: 'user_message' }), shared()],
  }, { deviceId: 'same-device-id', ownerUserId: 'usr6', operation: 'read_file' });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.grant.ownerUserId, 'usr6');
});

test('an exact device ID without an owner is ambiguous across owners', () => {
  const decision = resolveDeviceGrant({
    executionScope: scope,
    deviceGrants: [shared({ ownerUserId: 'usr1', identitySource: 'user_message' }), shared()],
  }, { deviceId: 'same-device-id', operation: 'read_file' });
  assert.equal(decision.ok, false);
});

test('request tool sends the trusted originating message and cannot approve a share', async () => {
  let payload: Record<string, unknown> | undefined;
  const tool = new RequestDeviceAccessTool(async value => { payload = value; if(value.owner === 'unknown') throw new Error('unknown group owner'); return {}; });
  const context = {
    workingDirectory: '/tmp', conversationHistory: [], executionScope: scope,
    groupRoster: [{ uid: 'usr6', name: 'userB', isBot: false }],
  } as ToolExecutionContext;
  assert.equal((await tool.execute({ owner: 'userB', description: '使用 pcB 读取文件' }, context)).ok, true);
  assert.equal(tool.definition.controlMode, 'pause_turn');
  assert.equal(payload?.action, 'create');
  assert.equal(payload?.message_id, 42);
  assert.equal(payload?.owner, 'userB');
  assert.equal(payload?.owner_uid, undefined);
  assert.equal(payload?.requester_uid, undefined);
  assert.equal((await tool.execute({ owner: 'unknown', description: 'test' }, context)).ok, false);
  assert.equal((await tool.execute({ owner: 'userB', description: 'test' }, {
    ...context, executionScope: { ...scope, topicType: 'p2p' },
  })).ok, false);
});

import { extractCatsCoDeviceGrants } from '../src/catscompany/device-grants';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceAuthorizationSessionKey, isDelegatedDeviceGrant, resolveDeviceGrant, validateDeviceGrant } from '../src/core/device-grants';
import type { ExecutionScope, ScopedDeviceGrant } from '../src/types/session-identity';

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

test('both receivers reject incomplete shared owner claims before writing a file', async () => {
  const { CatsCompanyBot } = await import('../src/catscompany');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-receiver-'));
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.localDeviceGrant = { ownerUserId: 'usr6', deviceId: 'pc-b', bodyId: 'pc-b', installationId: 'pc-b' };
  const base = {type: 'request' as const, request_id: 'shared-rpc', grant_id: 'grant', session_key: 'session', topic_id: 'grp_2', topic_type: 'group',
    actor_user_id: 'usr1', agent_id: 'usr3', identity_source: 'group_device_share', share_id: 'share-b', share_revision: 1,
    device_id: 'pc-b', target_device_id: 'pc-b', owner_user_id: 'usr6', target_owner_user_id: 'usr6',
    operation: 'write_file', tool_name: 'write_file', expires_at: Date.now()+60_000,
    payload: {args: {file_path: path.join(dir,'blocked.txt'),content:'must not write'}}};
  try {
    assert.equal(bot.validateDeviceRpcToolRequest(base), undefined);
    const allowedPath = path.join(dir,'allowed.txt');
    const result = await bot.executeLocalThinToolRpcTool({...base,payload:{args:{file_path:allowedPath,content:'authorized'}}});
    assert.equal(result.ok,true);
    assert.equal(fs.readFileSync(allowedPath,'utf8'),'authorized');
    for (const owner of [undefined, '', 'usr1', 'usr9']) {
      assert.equal(bot.validateDeviceRpcToolRequest({...base, owner_user_id:owner})?.code, 'invalid_shared_authorization');
      const result = await bot.executeLocalThinToolRpcTool({...base,target_owner_user_id:owner});
      assert.equal(result.ok,false);
      assert.equal(fs.existsSync(path.join(dir,'blocked.txt')),false);
    }
    for (const field of ['identity_source','grant_id','session_key','actor_user_id','agent_id','topic_id','share_id','expires_at']) {
      const wire = {...base,[field]:undefined};
      assert.ok(bot.validateDeviceRpcToolRequest(wire),field);
      assert.equal((await bot.executeLocalThinToolRpcTool(wire)).ok,false,field);
    }
    assert.ok(bot.validateDeviceRpcToolRequest({...base,device_id:'another-pc'}));
    assert.equal((await bot.executeLocalThinToolRpcTool({...base,target_device_id:'another-pc'})).ok,false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('canonical empty lists clear authority while absent or untrusted metadata is not an update', () => {
 const identity={permissions:{source:'server_canonical_message'}};
 assert.equal(extractCatsCoDeviceGrants({catsco_identity:identity},scope),undefined);
 assert.deepEqual(extractCatsCoDeviceGrants({catsco_identity:{...identity,device_grants:[]}},scope),[]);
 assert.deepEqual(extractCatsCoDeviceGrants({catsco_identity:{...identity,device_target_authorizations:{schema:'catsco.device-targets.v1',grants:[]}}},scope),[]);
 assert.deepEqual(extractCatsCoDeviceGrants({catsco_identity:{...identity,device_grants:[shared({actorUserId:'usr999'})]}},scope),[]);
 assert.equal(extractCatsCoDeviceGrants({catsco_identity:{...identity,device_grants:[]}}, {...scope,identityTrust:'untrusted'}),undefined);
});

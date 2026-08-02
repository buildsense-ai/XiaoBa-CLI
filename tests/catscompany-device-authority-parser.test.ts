import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractCatsCoDeviceGrantSnapshot } from '../src/catscompany/device-grants';
import { extractCatsCoDeviceSelection } from '../src/catscompany/device-selection';
import type { ExecutionScope } from '../src/types/session-identity';

function scope(): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'cc_group:grp-parser',
    topicId: 'grp-parser',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    channelSeq: 77,
    identityTrust: 'server_canonical',
    isTrusted: true,
  };
}

function rawGrant(id: string, operations = ['read_file', 'grep']) {
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grant_id: `grant-${id}`,
    status: 'active',
    identity_trust: 'server_canonical',
    identity_source: 'server_canonical_message',
    device_id: `device-${id}`,
    owner_user_id: 'usr7',
    session_key: 'cc_group:grp-parser',
    topic_id: 'grp-parser',
    topic_type: 'group',
    actor_user_id: 'usr7',
    agent_id: 'usr43',
    agent_body_id: 'body-main',
    operations,
    created_at: 1,
    expires_at: 4_102_444_800_000,
  };
}

function rawSelection(deviceId = 'device-a', operations = ['read_file', 'grep']) {
  return {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    session_key: 'cc_group:grp-parser',
    topic_id: 'grp-parser',
    topic_type: 'group',
    actor_user_id: 'usr7',
    agent_id: 'usr43',
    selected_device_id: deviceId,
    selected_device_operations: operations,
  };
}

function metadata(identityValue: unknown, permissionsValue: unknown) {
  return {
    catsco_identity: {
      actor: { user_id: 'usr7' },
      agent: { agent_id: 'usr43', body_id: 'body-main' },
      topic: { topic_id: 'grp-parser', type: 'group', channel_seq: 77 },
      device_grants: identityValue,
      permissions: {
        source: 'server_canonical_message',
        device_grants: permissionsValue,
      },
    },
  };
}

describe('CatsCo canonical device authority parsers', () => {
  test('fails closed when root and permissions grant containers disagree', () => {
    for (const value of [
      metadata([rawGrant('a')], []),
      metadata('malformed', [rawGrant('a')]),
      metadata([rawGrant('a')], [rawGrant('b')]),
    ]) {
      const snapshot = extractCatsCoDeviceGrantSnapshot(value, scope());
      assert.ok(snapshot);
      assert.equal(snapshot.revision, 77);
      assert.deepEqual(snapshot.grants, []);
    }
  });

  test('accepts semantically equal dual grant containers independent of ordering', () => {
    const snapshot = extractCatsCoDeviceGrantSnapshot(
      metadata(
        [rawGrant('b', ['grep', 'read_file']), rawGrant('a')],
        [rawGrant('a', ['grep', 'read_file']), rawGrant('b')],
      ),
      scope(),
    );
    assert.ok(snapshot);
    assert.deepEqual(snapshot.grants.map(grant => grant.grantId).sort(), ['grant-a', 'grant-b']);
    assert.deepEqual(snapshot.grants[0].operations, ['read_file', 'grep']);
  });

  test('fails closed on conflicting dual selection containers', () => {
    const value = metadata([rawGrant('a')], [rawGrant('a')]);
    (value.catsco_identity as any).device_selection = rawSelection('device-a');
    (value.catsco_identity.permissions as any).device_selection = rawSelection('device-b');
    const selection = extractCatsCoDeviceSelection(value, scope());
    assert.equal(selection?.status, 'unavailable');
    assert.deepEqual(selection?.selectedDeviceOperations, []);
  });

  test('accepts semantically equal dual selection containers independent of operation order', () => {
    const value = metadata([rawGrant('a')], [rawGrant('a')]);
    (value.catsco_identity as any).device_selection = rawSelection('device-a', ['grep', 'read_file']);
    (value.catsco_identity.permissions as any).device_selection = rawSelection('device-a', ['read_file', 'grep']);
    const selection = extractCatsCoDeviceSelection(value, scope());
    assert.ok(selection);
    assert.equal(selection.selectedDeviceId, 'device-a');
    assert.deepEqual(new Set(selection.selectedDeviceOperations), new Set(['read_file', 'grep']));
  });

  test('preserves explicit empty selection operations as deny-all while omission remains unrestricted', () => {
    const emptyValue = metadata([rawGrant('a')], [rawGrant('a')]);
    (emptyValue.catsco_identity as any).device_selection = rawSelection('device-a', []);
    assert.deepEqual(
      extractCatsCoDeviceSelection(emptyValue, scope())?.selectedDeviceOperations,
      [],
    );

    const malformedValue = metadata([rawGrant('a')], [rawGrant('a')]);
    (malformedValue.catsco_identity as any).device_selection = rawSelection('device-a', ['bogus']);
    assert.deepEqual(
      extractCatsCoDeviceSelection(malformedValue, scope())?.selectedDeviceOperations,
      [],
    );

    const omittedValue = metadata([rawGrant('a')], [rawGrant('a')]);
    const omitted = rawSelection('device-a') as any;
    delete omitted.selected_device_operations;
    (omittedValue.catsco_identity as any).device_selection = omitted;
    assert.equal(
      extractCatsCoDeviceSelection(omittedValue, scope())?.selectedDeviceOperations,
      undefined,
    );
  });

  test('distinguishes omitted operations from explicit deny-all across dual containers', () => {
    const value = metadata([rawGrant('a')], [rawGrant('a')]);
    const omitted = rawSelection('device-a') as any;
    delete omitted.selected_device_operations;
    (value.catsco_identity as any).device_selection = omitted;
    (value.catsco_identity.permissions as any).device_selection = rawSelection('device-a', []);
    const selection = extractCatsCoDeviceSelection(value, scope());
    assert.equal(selection?.status, 'unavailable');
    assert.deepEqual(selection?.selectedDeviceOperations, []);
  });

  test('fails closed on an explicit unknown selection status', () => {
    for (const status of ['unavailble', '']) {
      const value = metadata([rawGrant('a')], [rawGrant('a')]);
      const invalid = rawSelection('device-a') as any;
      invalid.status = status;
      (value.catsco_identity as any).device_selection = invalid;
      const selection = extractCatsCoDeviceSelection(value, scope());
      assert.equal(selection?.status, 'unavailable');
      assert.deepEqual(selection?.selectedDeviceOperations, []);
    }
  });
});

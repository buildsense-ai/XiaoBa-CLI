import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type CreateUserDeviceInput,
  createDeviceGrant,
  createUserDevice,
  resolveDeviceGrant,
  validateDeviceGrant,
} from '../src/core/device-grants';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
} from '../src/types/session-identity';

function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'session:v2:catscompany:group:grp_80%3Aactor%3Ausr7:agent:usr43',
    topicId: 'grp_80',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    permissionsSource: 'metadata.catsco_identity',
    identityTrust: 'server_canonical',
    isTrusted: true,
    ...overrides,
  };
}

function device(overrides: Partial<CreateUserDeviceInput> = {}) {
  const result = createUserDevice({
    source: 'catscompany',
    ownerUserId: ' usr7 ',
    deviceId: ' device-main ',
    displayName: ' Alice laptop ',
    bodyId: ' body-main ',
    installationId: ' install-main ',
    identityTrust: 'server_canonical',
    identitySource: 'device.registry',
    status: 'online',
    registeredAt: 100,
    lastSeenAt: 200,
    ...overrides,
  });
  assert.ok(result);
  return result;
}

function grant(overrides: Partial<ScopedDeviceGrant> = {}): ScopedDeviceGrant {
  const created = createDeviceGrant(scope(), device(), {
    grantId: 'grant-main',
    operations: ['read_file', 'send_file'],
    now: 1_000,
    ttlMs: 5_000,
  });
  assert.ok(created);
  return { ...created, ...overrides };
}

describe('device grants', () => {
  test('creates a normalized user device without exposing local filesystem concepts', () => {
    const result = device();

    assert.equal(result.ownerUserId, 'usr7');
    assert.equal(result.deviceId, 'device-main');
    assert.equal(result.displayName, 'Alice laptop');
    assert.equal(result.bodyId, 'body-main');
    assert.equal(result.installationId, 'install-main');
    assert.equal(result.identityTrust, 'server_canonical');
    assert.equal(result.status, 'online');
  });

  test('creates a scoped active grant tied to the current actor, agent, topic, and device', () => {
    const created = createDeviceGrant(scope(), device(), {
      grantId: 'grant-main',
      operations: ['read_file', 'read_file', 'execute_shell', 'invalid' as any],
      identitySource: 'catsco.device_grant',
      now: 1_000,
      ttlMs: 10_000,
    });

    assert.ok(created);
    assert.equal(created.kind, 'user_device_grant');
    assert.equal(created.status, 'active');
    assert.equal(created.identityTrust, 'server_canonical');
    assert.equal(created.identitySource, 'catsco.device_grant');
    assert.equal(created.ownerUserId, 'usr7');
    assert.equal(created.actorUserId, 'usr7');
    assert.equal(created.agentId, 'usr43');
    assert.equal(created.agentBodyId, 'body-main');
    assert.equal(created.deviceId, 'device-main');
    assert.equal(created.deviceBodyId, 'body-main');
    assert.equal(created.deviceInstallationId, 'install-main');
    assert.deepEqual(created.operations, ['read_file', 'execute_shell']);
    assert.equal(created.createdAt, 1_000);
    assert.equal(created.expiresAt, 11_000);
  });

  test('treats numeric CatsCo ids and usr-prefixed ids as the same user', () => {
    const created = createDeviceGrant(scope(), device({ ownerUserId: '7' }), {
      grantId: 'grant-numeric-owner',
      operations: ['read_file'],
      now: 1_000,
      ttlMs: 10_000,
    });

    assert.ok(created);
    assert.equal(created.ownerUserId, 'usr7');

    const decision = validateDeviceGrant({
      executionScope: scope(),
    }, grant({
      ownerUserId: '7',
      actorUserId: '7',
      agentId: '43',
    }), {
      operation: 'read_file',
      now: 2_000,
    });

    assert.equal(decision.ok, true);
  });

  test('refuses to create grants for empty operations, source mismatch, or a different owner', () => {
    assert.equal(createDeviceGrant(scope(), device(), { operations: [] }), undefined);
    assert.equal(createDeviceGrant(scope(), device({ source: 'feishu' }), { operations: ['read_file'] }), undefined);
    assert.equal(createDeviceGrant(scope(), device({ ownerUserId: 'usr8' }), { operations: ['read_file'] }), undefined);
  });

  test('resolves a matching grant by operation and optional target device', () => {
    const other = grant({
      grantId: 'grant-other',
      deviceId: 'device-other',
      operations: ['execute_shell'],
    });
    const result = resolveDeviceGrant({
      executionScope: scope(),
      deviceGrants: [other, grant()],
    }, {
      operation: 'send_file',
      deviceId: 'device-main',
      now: 2_000,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.grant.grantId, 'grant-main');
  });

  test('rejects ambiguous device resolution when multiple target devices can perform the same operation', () => {
    const result = resolveDeviceGrant({
      executionScope: scope(),
      deviceGrants: [
        grant({ grantId: 'grant-main', deviceId: 'device-main' }),
        grant({ grantId: 'grant-second', deviceId: 'device-second' }),
      ],
    }, {
      operation: 'read_file',
      now: 2_000,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /多个允许 read_file 的用户设备授权/);
  });

  test('skips invalid candidates when a later grant for the same target device is valid', () => {
    const result = resolveDeviceGrant({
      executionScope: scope(),
      deviceGrants: [
        grant({ grantId: 'grant-expired', expiresAt: 2_000 }),
        grant({ grantId: 'grant-valid', expiresAt: 6_000 }),
      ],
    }, {
      operation: 'read_file',
      deviceId: 'device-main',
      now: 2_000,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.grant.grantId, 'grant-valid');
  });

  test('rejects missing, revoked, expired, operation, and target-device mismatches', () => {
    assert.equal(resolveDeviceGrant({
      executionScope: scope(),
      deviceGrants: [],
    }, {
      operation: 'read_file',
      now: 2_000,
    }).ok, false);

    const cases: Array<[string, ScopedDeviceGrant, RegExp]> = [
      ['revoked', grant({ status: 'revoked' }), /不是 active/],
      ['expired', grant({ expiresAt: 2_000 }), /已过期/],
      ['operation', grant({ operations: ['send_file'] }), /不允许执行 read_file/],
      ['target device', grant(), /目标设备不一致/],
      ['untrusted', grant({ identityTrust: 'untrusted' }), /未可信身份/],
    ];

    for (const [name, candidate, messagePattern] of cases) {
      const decision = validateDeviceGrant({
        executionScope: scope(),
      }, candidate, {
        operation: 'read_file',
        deviceId: name === 'target device' ? 'device-other' : undefined,
        now: 2_000,
      });
      assert.equal(decision.ok, false, name);
      if (!decision.ok) assert.match(decision.message, messagePattern, name);
    }
  });

  test('rejects grants from another session, source, actor, topic type, agent, or body', () => {
    const mismatchCases: Array<[string, Partial<ScopedDeviceGrant>]> = [
      ['source', { source: 'feishu' }],
      ['sessionKey', { sessionKey: 'session:v2:catscompany:group:grp_81:agent:usr43' }],
      ['topicId', { topicId: 'grp_81' }],
      ['topicType', { topicType: 'p2p' }],
      ['actorUserId', { actorUserId: 'usr8', ownerUserId: 'usr8' }],
      ['ownerUserId', { ownerUserId: 'usr8' }],
      ['agentId', { agentId: 'usr99' }],
      ['agentBodyId', { agentBodyId: 'body-other' }],
    ];

    for (const [field, overrides] of mismatchCases) {
      const decision = validateDeviceGrant({
        executionScope: scope(),
      }, grant(overrides), {
        operation: 'read_file',
        now: 2_000,
      });

      assert.equal(decision.ok, false, field);
      if (!decision.ok) assert.match(decision.message, new RegExp(field), field);
    }
  });
});

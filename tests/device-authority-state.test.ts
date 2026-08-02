import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { DeviceAuthorityState } from '../src/core/device-authority-state';
import { AgentSession } from '../src/core/agent-session';
import { resolveDeviceGrant } from '../src/core/device-grants';
import { buildTargetRoutes } from '../src/catscompany/runtime-context';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceGrantSnapshot,
  ScopedDeviceSelection,
} from '../src/types/session-identity';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scope(): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'cc_group:authority-state',
    topicId: 'authority-state',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    channelSeq: 10,
    identityTrust: 'server_canonical',
    isTrusted: true,
  };
}

function grant(overrides: Partial<ScopedDeviceGrant> = {}): ScopedDeviceGrant {
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: 'grant-sensitive',
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'server_canonical_message',
    deviceId: 'device-sensitive',
    ownerUserId: 'usr7',
    sessionKey: 'cc_group:authority-state',
    topicId: 'authority-state',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    operations: ['read_file', 'grep'],
    createdAt: 1,
    expiresAt: 4_102_444_800_000,
    ...overrides,
  };
}

function snapshot(revision: number, grants: ScopedDeviceGrant[]): ScopedDeviceGrantSnapshot {
  return {
    kind: 'user_device_grant_snapshot',
    source: 'catscompany',
    sessionKey: 'cc_group:authority-state',
    topicId: 'authority-state',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    identityTrust: 'server_canonical',
    revision,
    grants,
  };
}

function selection(operations = ['read_file', 'grep'] as const): ScopedDeviceSelection {
  return {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    sessionKey: 'cc_group:authority-state',
    topicId: 'authority-state',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    identityTrust: 'server_canonical',
    selectedDeviceId: 'device-sensitive',
    selectedDeviceOperations: [...operations],
  };
}

function routes(label = 'Alice Laptop') {
  const value = buildTargetRoutes([{
    userId: 'usr7',
    userName: 'Alice',
    ownerUserId: 'usr7',
    deviceId: 'device-sensitive',
    label,
    os: 'macos',
    status: 'ready',
  }]);
  assert.ok(value);
  return value;
}

function watermarkDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-device-authority-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('device authority state', () => {
  test('never establishes authority from an unversioned canonical snapshot', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    const current = state.replace({
      executionScope: { ...scope(), channelSeq: undefined },
      deviceGrantSnapshot: { ...snapshot(10, [grant()]), revision: undefined },
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    assert.equal(current.deviceGrants, undefined);
  });

  test('treats an omitted snapshot as no update', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    const preserved = state.replace({ executionScope: { ...scope(), channelSeq: 11 } });
    assert.equal(preserved.deviceGrants?.length, 1);
    assert.equal(preserved.deviceSelection?.selectedDeviceId, 'device-sensitive');
  });

  test('applies ordered selection-only narrowing and ignores stale replay', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    const omittedOperations = selection() as ScopedDeviceSelection;
    delete omittedOperations.selectedDeviceOperations;
    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: omittedOperations,
      targetRoutes: routes(),
    });

    const narrowed = state.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceSelection: selection([]),
    });
    assert.deepEqual(narrowed.deviceSelection?.selectedDeviceOperations, []);

    const stale = state.replace({
      executionScope: { ...scope(), channelSeq: 10 },
      deviceSelection: selection(['read_file', 'grep']),
    });
    assert.deepEqual(stale.deviceSelection?.selectedDeviceOperations, []);

    const restored = state.replace({
      executionScope: { ...scope(), channelSeq: 12 },
      deviceSelection: selection(['read_file']),
    });
    assert.deepEqual(restored.deviceSelection?.selectedDeviceOperations, ['read_file']);
  });

  test('does not let an older full snapshot undo a newer unavailable selection delta', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    const unavailable: ScopedDeviceSelection = {
      ...selection([]),
      status: 'unavailable',
      selectedDeviceId: undefined,
    };
    state.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceSelection: unavailable,
    });
    const delayed = state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    assert.equal(delayed.deviceSelection?.status, 'unavailable');
    assert.deepEqual(delayed.deviceSelection?.selectedDeviceOperations, []);
  });

  test('persists a selection-only floor across restart', () => {
    const directory = watermarkDirectory();
    const first = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(['read_file', 'grep']),
      targetRoutes: routes(),
    });
    first.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceSelection: selection(['read_file']),
    });

    const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    assert.equal(restarted.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, [grant()]),
      deviceSelection: selection(['read_file', 'grep']),
      targetRoutes: routes(),
    }).deviceGrants, undefined);
    assert.equal(restarted.replace({
      executionScope: { ...scope(), channelSeq: 12 },
      deviceGrantSnapshot: snapshot(12, [grant()]),
      deviceSelection: selection(['read_file']),
      targetRoutes: routes(),
    }).deviceGrants?.length, 1);
  });

  test('does not let a stale selection delta roll back the restart watermark', () => {
    const directory = watermarkDirectory();
    const first = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
    });

    const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    restarted.replace({
      executionScope: { ...scope(), channelSeq: 9 },
      deviceSelection: selection([]),
    });
    assert.equal(restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
    }).deviceGrants, undefined);
    assert.equal(restarted.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, [grant()]),
      deviceSelection: selection(['read_file']),
    }).deviceGrants?.length, 1);
  });

  test('tombstones a full snapshot that conflicts with a selection delta at the same sequence', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    state.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceSelection: { ...selection([]), status: 'unavailable', selectedDeviceId: undefined },
    });
    const conflict = state.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, []),
    });
    assert.equal(conflict.deviceGrants, undefined);
    assert.equal(state.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, [grant()]),
      deviceSelection: selection(),
    }).deviceGrants, undefined);
  });

  test('tombstones equal-sequence selection conflicts before a full snapshot can replay', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(['read_file']),
      targetRoutes: routes(),
    });
    const conflict = state.replace({
      executionScope: scope(),
      deviceSelection: selection([]),
    });
    assert.equal(conflict.deviceGrants, undefined);
    assert.equal(state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(['read_file']),
      targetRoutes: routes(),
    }).deviceGrants, undefined);
  });

  test('treats omitted and explicit empty operations as an authority-changing conflict', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    const omitted = selection() as ScopedDeviceSelection;
    delete omitted.selectedDeviceOperations;
    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: omitted,
      targetRoutes: routes(),
    });
    const conflict = state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection([]),
      targetRoutes: routes(),
    });
    assert.equal(conflict.deviceGrants, undefined);
  });

  test('turns a selection-only switch outside current grants into unavailable', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    const invalid = state.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceSelection: {
        ...selection(),
        selectedDeviceId: 'not-currently-granted',
      },
    });
    assert.equal(invalid.deviceSelection?.status, 'unavailable');
    assert.deepEqual(invalid.deviceSelection?.selectedDeviceOperations, []);
  });

  test('does not expose mutable grant or operation references', () => {
    const inputGrant = grant({ operations: ['read_file'] });
    const inputSnapshot = snapshot(10, [inputGrant]);
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    const first = state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: inputSnapshot,
    });
    inputGrant.operations.push('execute_shell');
    first.deviceGrants?.[0].operations.push('execute_shell');
    first.deviceGrantSnapshot?.grants[0].operations.push('execute_shell');

    const current = state.getCurrent();
    assert.deepEqual(current.deviceGrants?.[0].operations, ['read_file']);
    assert.deepEqual(current.deviceGrantSnapshot?.grants[0].operations, ['read_file']);
    assert.equal(resolveDeviceGrant({
      executionScope: scope(),
      deviceAuthority: state,
    }, {
      operation: 'execute_shell',
      deviceId: inputGrant.deviceId,
      now: 100,
    }).ok, false);
  });

  test('shares immediate revocation with contexts that still hold copied grants', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    const active = state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    assert.equal(active.deviceGrants?.length, 1);

    state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(11, []),
    });
    const decision = resolveDeviceGrant({
      executionScope: scope(),
      deviceGrants: active.deviceGrants,
      deviceAuthority: state,
    }, {
      operation: 'read_file',
      deviceId: 'device-sensitive',
      now: 100,
    });
    assert.equal(decision.ok, false);
    assert.equal(state.getCurrent().deviceGrants, undefined);
    assert.equal(state.getCurrent().deviceSelection, undefined);
    assert.equal(state.getCurrent().targetRoutes, undefined);
  });

  test('persists only a hashed watermark and rejects stale resurrection after restart', () => {
    const directory = watermarkDirectory();
    const first = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    first.replace({ executionScope: scope(), deviceGrantSnapshot: snapshot(11, []) });

    const persisted = fs.readdirSync(directory)
      .map(file => fs.readFileSync(path.join(directory, file), 'utf8'))
      .join('\n');
    for (const secret of ['authority-state', 'grant-sensitive', 'device-sensitive', 'usr7']) {
      assert.equal(persisted.includes(secret), false, secret);
    }

    const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    const stale = restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    assert.equal(stale.deviceGrants, undefined);

    const equalRevisionResurrection = restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(11, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    assert.equal(equalRevisionResurrection.deviceGrants, undefined);

    const newer = restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(12, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes(),
    });
    assert.equal(newer.deviceGrants?.length, 1);
  });

  test('treats equivalent ordering as idempotent and equal-revision route drift as conflict', () => {
    const state = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    const first = state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(['read_file', 'grep']),
      targetRoutes: routes(),
    });
    const equivalent = state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant({ operations: ['grep', 'read_file'] })]),
      deviceSelection: selection(['grep', 'read_file']),
      targetRoutes: routes(),
    });
    assert.equal(equivalent.deviceGrants?.length, 1);
    assert.ok(equivalent.generation > first.generation);

    const conflict = state.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
      deviceSelection: selection(),
      targetRoutes: routes('Changed Label'),
    });
    assert.equal(conflict.deviceGrants, undefined);
  });

  test('persists versioned-to-unversioned revocation across restart', () => {
    const directory = watermarkDirectory();
    const first = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    });
    first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: { ...snapshot(10, [grant()]), revision: undefined },
    });
    assert.equal(first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    }).deviceGrants, undefined);

    const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    assert.equal(restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    }).deviceGrants, undefined);
    assert.equal(restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(11, [grant()]),
    }).deviceGrants?.length, 1);
  });

  test('fails closed for corrupted, incomplete, or missing established watermarks', () => {
    for (const failure of ['corrupt', 'pending', 'missing'] as const) {
      const directory = watermarkDirectory();
      const first = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
      first.replace({
        executionScope: scope(),
        deviceGrantSnapshot: snapshot(10, [grant()]),
      });
      const jsonPath = fs.readdirSync(directory)
        .map(file => path.join(directory, file))
        .find(file => file.endsWith('.json'))!;
      if (failure === 'corrupt') fs.writeFileSync(jsonPath, '{broken', 'utf8');
      if (failure === 'pending') fs.writeFileSync(`${jsonPath}.pending`, 'interrupted\n', 'utf8');
      if (failure === 'missing') fs.unlinkSync(jsonPath);

      const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
      assert.equal(restarted.replace({
        executionScope: scope(),
        deviceGrantSnapshot: snapshot(11, [grant()]),
      }).deviceGrants, undefined, failure);
    }
  });

  test('requires a newer revision after restart before re-authorizing an active scope', () => {
    const directory = watermarkDirectory();
    const first = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    });
    const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    assert.equal(restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    }).deviceGrants, undefined);
    assert.equal(restarted.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(11, [grant()]),
    }).deviceGrants?.length, 1);
  });

  test('re-reads the durable floor before a stale instance can overwrite it', () => {
    const directory = watermarkDirectory();
    const initial = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    initial.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    });

    // Both instances begin with the same rev10 view. The stale writer must
    // compare-and-tombstone against rev11 on disk after it obtains the lock.
    const revoker = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    const staleWriter = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    revoker.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, []),
    });
    assert.equal(initial.getCurrent().deviceGrants, undefined);
    const replay = staleWriter.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, [grant()]),
    });
    assert.equal(replay.deviceGrants, undefined);

    const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    assert.equal(restarted.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, [grant()]),
    }).deviceGrants, undefined);
    assert.equal(restarted.replace({
      executionScope: { ...scope(), channelSeq: 12 },
      deviceGrantSnapshot: snapshot(12, [grant()]),
    }).deviceGrants?.length, 1);
  });

  test('persists a connector-level revoked floor before any live session exists', () => {
    const directory = watermarkDirectory();
    const deferred = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    assert.equal(deferred.persistRevokedFloor(11), true);

    const sessionState = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    assert.equal(sessionState.replace({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceGrantSnapshot: snapshot(11, [grant()]),
    }).deviceGrants, undefined);
    assert.equal(sessionState.replace({
      executionScope: { ...scope(), channelSeq: 12 },
      deviceGrantSnapshot: snapshot(12, [grant()]),
    }).deviceGrants?.length, 1);
  });

  test('AgentSession adopts the exact connector lease instead of replaying its watermark', () => {
    const authority = new DeviceAuthorityState(scope(), { watermarkDirectory: null });
    authority.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    });
    const session = Object.create(AgentSession.prototype) as any;
    session.deviceAuthorityStates = new Map();

    assert.equal(session.adoptDeviceAuthorityState(scope(), authority), authority);
    const lease = session.updateDeviceAuthority({
      executionScope: { ...scope(), channelSeq: 11 },
      deviceSelection: selection(['read_file']),
    });
    assert.equal(lease, authority);
    assert.deepEqual(authority.getCurrent().deviceSelection?.selectedDeviceOperations, ['read_file']);
  });

  test('leaves durable fail-closed evidence when revoke cannot start its transaction', () => {
    const directory = watermarkDirectory();
    const first = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    first.replace({
      executionScope: scope(),
      deviceGrantSnapshot: snapshot(10, [grant()]),
    });

    fs.chmodSync(directory, 0o500);
    try {
      const revoked = first.replace({
        executionScope: { ...scope(), channelSeq: 11 },
        deviceGrantSnapshot: snapshot(11, []),
      });
      assert.equal(revoked.deviceGrants, undefined);
    } finally {
      fs.chmodSync(directory, 0o700);
    }

    const restarted = new DeviceAuthorityState(scope(), { watermarkDirectory: directory });
    assert.equal(restarted.replace({
      executionScope: { ...scope(), channelSeq: 12 },
      deviceGrantSnapshot: snapshot(12, [grant()]),
    }).deviceGrants, undefined);
  });
});

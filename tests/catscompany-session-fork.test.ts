import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionForkSnapshot } from '../src/core/session-fork';
import type { SessionRuntimeState } from '../src/utils/session-store';
import { CatsSessionForkController, forkSessionRoute, normalizeSessionForkControl,
  type CatsSessionForkCompletion, type CatsSessionForkStatus } from '../src/catscompany/session-fork';

const wire = { request_id: 'fork-1', source_topic_id: 'p2p_7_9', target_topic_id: 'grp_22',
  actor_user_id: 7, agent_uid: 9, source_last_seq: 12, message_id_map: { '10': 101, '12': 103 } };

function harness() {
  const control = normalizeSessionForkControl(wire)!;
  const source = forkSessionRoute(control.source_topic_id, control.actor_user_id, control.agent_uid);
  const target = forkSessionRoute(control.target_topic_id, control.actor_user_id, control.agent_uid);
  const snapshots = new Map<string, SessionForkSnapshot>();
  const states = new Map<string, SessionRuntimeState>([[source.sessionKey, { currentDirectory: '/workspace' }]]);
  const acks: CatsSessionForkCompletion[] = [];
  const busy = new Set<string>();
  const live = new Map<string, any>();
  const readKeys: string[] = [];
  let installs = 0;
  const readErrors = new Map<string, Error>();
  let complete: (input: CatsSessionForkCompletion) => Promise<CatsSessionForkStatus> = async input => ({
    ...input, source_topic_id: control.source_topic_id,
  });
  const store = {
    getForkIdentity: (key: string) => snapshots.get(key),
    loadRuntimeState: (key: string) => states.get(key) || {},
    readContextForFork: (key: string) => {
      readKeys.push(key);
      if (readErrors.has(key)) throw readErrors.get(key);
      if (key === target.sessionKey) return structuredClone(snapshots.get(key)!.messages);
      return [{ role: 'user' as const, content: 'A', __remoteContextSource: 'catscompany.agent_context', __remoteContextId: 10 },
        { role: 'assistant' as const, content: 'B' }];
    },
    installFork: (snapshot: SessionForkSnapshot): 'created' | 'existing' => {
      installs++;
      assert.equal(snapshots.has(snapshot.targetSessionKey), false);
      snapshots.set(snapshot.targetSessionKey, structuredClone(snapshot));
      return 'created';
    },
  };
  const controller = new CatsSessionForkController({ store, agentUid: () => '9',
    isIdle: key => !busy.has(key), getSession: route => live.get(route.sessionKey) || null,
    complete: async input => { acks.push(input); return complete(input); },
  });
  return { controller, control, source, target, snapshots, states, acks, busy, live,
    reads: () => readKeys.length, readKeys, installs: () => installs,
    readError: (error: Error, key = source.sessionKey) => { readErrors.set(key, error); },
    complete: (fn: typeof complete) => { complete = fn; },
  };
}

test('control normalizes numeric UIDs and derives the same p2p/group routes as ordinary input', () => {
  const h = harness();
  assert.equal(h.control.agent_uid, 'usr9');
  assert.equal(h.control.actor_user_id, 'usr7');
  assert.equal(h.source.sessionKey, 'session:v2:catscompany:p2p:p2p_7_9:agent:usr9');
  assert.equal(h.target.sessionKey, 'cc_group:grp_22');
  assert.equal(forkSessionRoute('grp_11', 'usr7', 'usr9').sessionKey, 'cc_group:grp_11');
});

test('rejects invalid scope, unsafe numeric IDs, malformed mappings and self-forks', () => {
  for (const overrides of [
    { agent_uid: Number.MAX_SAFE_INTEGER + 1 }, { actor_user_id: 'unknown' },
    { source_topic_id: 'p2p_5_9' }, { target_topic_id: 'p2p_7_9' },
    { source_topic_id: 'grp_22' }, { request_id: 'bad\nrequest' },
    { message_id_map: { '13': 200 } }, { message_id_map: { '10': 100, '12': 100 } },
    { message_id_map: { '10': 1.5 } }, { message_id_map: [] },
  ]) assert.equal(normalizeSessionForkControl({ ...wire, ...overrides }), undefined, JSON.stringify(overrides));
});

test('existing cold source installs actual durable context atomically without a completion certificate', async () => {
  const h = harness();
  await h.controller.handle(h.control);
  const snapshot = h.snapshots.get(h.target.sessionKey)!;
  assert.equal(snapshot.currentDirectory, '/workspace');
  assert.equal(snapshot.messages[0].__remoteContextId, 101);
  assert.equal(snapshot.sourceLastSeq, 12);
  assert.equal(h.installs(), 1);
  assert.equal(h.acks[0].state, 'ready');
});

test('live source uses synchronous export without model initialization', async () => {
  const h = harness();
  h.live.set(h.source.sessionKey, { exportForkContext: (map: any) => {
    assert.equal(map['12'], 103);
    return { messages: [{ role: 'user', content: 'retained summary', __checkpointSummary: true }], currentDirectory: '/actual' };
  } });
  await h.controller.handle(h.control);
  assert.equal(h.snapshots.get(h.target.sessionKey)?.messages[0].content, 'retained summary');
  assert.equal(h.reads(), 1, 'persisted source must also exist and parse strictly');
});

test('interrupted source fails closed even if otherwise idle', async () => {
  const h = harness();
  h.states.set(h.source.sessionKey, { interruptedTurn: { topic: 'p2p_7_9', reason: 'crash', startedAt: new Date().toISOString(), attempts: 0 } });
  await h.controller.handle(h.control);
  assert.equal(h.acks[0].error, 'session_fork_source_interrupted');
  assert.equal(h.installs(), 0);
});

test('busy source or target fails without copying source', async () => {
  for (const endpoint of ['source', 'target'] as const) {
    const h = harness();
    h.busy.add(h[endpoint].sessionKey);
    await h.controller.handle(h.control);
    assert.equal(h.acks[0].error, 'session_fork_source_busy');
    assert.equal(h.reads(), 0);
  }
});

test('missing/corrupt source and exporter failures do not leak local paths', async () => {
  for (const kind of ['read', 'export']) {
    const h = harness();
    const error = new Error('ENOENT C:/private/source.jsonl');
    if (kind === 'read') h.readError(error);
    else h.live.set(h.source.sessionKey, { exportForkContext: () => { throw error; } });
    await h.controller.handle(h.control);
    assert.deepEqual(h.acks[0], { request_id: 'fork-1', target_topic_id: 'grp_22', state: 'failed', error: 'session_fork_initialization_failed' });
    assert.equal(h.installs(), 0);
  }
});

test('installed matching retry acknowledges after source and target progress without overwriting either', async () => {
  const h = harness();
  await h.controller.handle(h.control);
  h.states.set(h.source.sessionKey, { currentDirectory: '/later-workspace' });
  h.busy.add(h.source.sessionKey);
  h.busy.add(h.target.sessionKey);
  h.readError(new Error('source removed'));
  h.snapshots.get(h.target.sessionKey)!.messages.push({ role: 'user', content: 'later progress' });
  await h.controller.handle(h.control);
  assert.equal(h.acks[1].state, 'ready');
  assert.equal(h.installs(), 1);
  assert.deepEqual(h.readKeys, [h.source.sessionKey, h.target.sessionKey]);
  assert.equal(h.snapshots.get(h.target.sessionKey)!.messages.at(-1)!.content, 'later progress');
});

test('installed retry fails closed when target context is lost or corrupt after an uncertain ACK', async () => {
  for (const error of [new Error('ENOENT C:/private/target.jsonl'), new SyntaxError('corrupt C:/private/target.jsonl')]) {
    const h = harness();
    h.complete(async () => { throw new Error('response lost'); });
    await assert.rejects(h.controller.handle(h.control), /response lost/);
    const installed = structuredClone(h.snapshots.get(h.target.sessionKey));
    h.readError(new Error('source removed'));
    h.readError(error, h.target.sessionKey);
    h.complete(async input => ({ ...input, source_topic_id: wire.source_topic_id }));
    await h.controller.handle(h.control);
    assert.deepEqual(h.acks[1], { request_id: 'fork-1', target_topic_id: 'grp_22',
      state: 'failed', error: 'session_fork_initialization_failed' });
    assert.deepEqual(h.readKeys, [h.source.sessionKey, h.target.sessionKey]);
    assert.equal(h.installs(), 1);
    assert.deepEqual(h.snapshots.get(h.target.sessionKey), installed);
  }
});

test('installed retry accepts an empty clear tombstone without resurrecting source context', async () => {
  const h = harness();
  await h.controller.handle(h.control);
  const tombstone = h.snapshots.get(h.target.sessionKey)!;
  tombstone.messages = [];
  delete tombstone.currentDirectory;
  h.readError(new Error('source removed'));
  await h.controller.handle(h.control);
  assert.equal(h.acks[1].state, 'ready');
  assert.deepEqual(h.readKeys, [h.source.sessionKey, h.target.sessionKey]);
  assert.equal(h.installs(), 1);
  assert.deepEqual(h.snapshots.get(h.target.sessionKey), tombstone);
  assert.deepEqual(tombstone.messages, []);
});

test('installed target identity mismatch never overwrites or acknowledges ready', async () => {
  const h = harness();
  await h.controller.handle(h.control);
  await h.controller.handle({ ...h.control, request_id: 'other-request' });
  assert.equal(h.acks[1].error, 'session_fork_request_conflict');
  assert.equal(h.installs(), 1);
});

test('lost completion response leaves an idempotent install and sends no compensating failure', async () => {
  const h = harness();
  h.complete(async () => { throw new Error('response lost'); });
  await assert.rejects(h.controller.handle(h.control), /response lost/);
  assert.equal(h.acks.length, 1);
  assert.equal(h.acks[0].state, 'ready');
  assert.equal(h.controller.isLocked(h.source.sessionKey), false);
  h.complete(async input => ({ ...input, source_topic_id: wire.source_topic_id, state: 'ready' }));
  await h.controller.handle(h.control);
  assert.equal(h.installs(), 1);
});

test('source/target barriers remain held through ACK and duplicate in-flight requests coalesce', async () => {
  const h = harness();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  h.complete(async input => { await wait; return { ...input, source_topic_id: wire.source_topic_id }; });
  const first = h.controller.handle(h.control);
  const duplicate = h.controller.handle(h.control);
  assert.equal(first, duplicate);
  assert.equal(h.controller.isLocked(h.source.sessionKey), true);
  assert.equal(h.controller.isLocked(h.target.sessionKey), true);
  let resumed = false;
  const waiter = h.controller.waitForSession(h.source.sessionKey)!.then(() => { resumed = true; });
  await Promise.resolve();
  assert.equal(resumed, false);
  release();
  await first;
  await waiter;
  assert.equal(h.acks.length, 1);
  assert.equal(resumed, true);
});

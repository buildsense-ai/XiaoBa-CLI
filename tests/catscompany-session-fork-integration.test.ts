import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CatsCompanyBot } from '../src/catscompany';
import { SessionStore, type SessionRuntimeState } from '../src/utils/session-store';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { forkSessionRoute, normalizeSessionForkControl } from '../src/catscompany/session-fork';

const control = normalizeSessionForkControl({ request_id: 'r1', source_topic_id: 'p2p_7_9', target_topic_id: 'grp_22',
  actor_user_id: 7, agent_uid: 9, source_last_seq: 12, message_id_map: { '12': 103 } })!;
const source = forkSessionRoute(control.source_topic_id, control.actor_user_id, control.agent_uid);
const target = forkSessionRoute(control.target_topic_id, control.actor_user_id, control.agent_uid);
const input = { topic: 'p2p_7_9', senderId: 'usr7', text: 'perform the task', content: 'perform the task', isGroup: false, seq: 10 };

function harness(t: TestContext) {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const states = new Map<string, SessionRuntimeState>([[source.sessionKey, { currentDirectory: '/workspace' }]]);
  const acks: any[] = [];
  const installs: any[] = [];
  const replies: string[] = [];
  let hasLocal = true;
  let creates = 0;
  let childActive = false;
  const store = {
    loadRuntimeState: (key: string) => states.get(key) || {},
    saveRuntimeState: (key: string, value: SessionRuntimeState) => { states.set(key, value); return true; },
    hasSession: () => hasLocal,
    getForkIdentity: () => undefined,
    readContextForFork: () => [{ role: 'user', content: 'durable' }],
    installFork: (snapshot: any) => { installs.push(snapshot); return 'created'; },
  };
  t.mock.method(SessionStore, 'getInstance', () => store as any);
  t.mock.method(SubAgentManager, 'getInstance', () => ({ hasActiveForParent: () => childActive }) as any);
  const session = {
    isBusy: () => false,
    handleMessage: async () => ({ text: 'finished', visibleToUser: true, taskOutcome: 'completed' }),
    handleCommand: async () => ({ handled: true, reply: 'cleared' }),
    exportForkContext: () => ({ messages: [{ role: 'user', content: 'durable' }], currentDirectory: '/workspace' }),
    requestInterrupt: () => undefined,
  };
  bot.botUid = 'usr9';
  bot.shuttingDown = false;
  bot.activeMessageHandlers = 0;
  bot.sessionManager = {
    get: (route: any) => hasLocal && (typeof route === 'string' ? route : route.sessionKey) === source.sessionKey ? session : null,
    getOrCreate: () => { creates++; return session; },
  };
  bot.bot = {
    getSessionFork: async () => undefined,
    completeSessionFork: async (ack: any) => { acks.push(ack); return { ...ack, source_topic_id: source.topicId }; },
  };
  bot.sender = {
    reply: async (_topic: string, text: string) => { replies.push(text); },
    sendTaskStatus: async () => undefined,
  };
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.sessionExecutionReservations = new Set();
  bot.sessionClearGenerations = new Map();
  bot.sessionStopGenerations = new Map();
  bot.cloudSessionRestorePromises = new Map();
  bot.cloudSessionRestoreAbortControllers = new Map();
  bot.subAgentCompletionBatches = new Map();
  bot.activeConversationTasks = new Map();
  bot.taskStatusTasks = new Map();
  bot.registerSubAgentPlatformCallbacks = () => undefined;
  bot.buildChannel = () => ({});
  bot.buildSessionCallbacks = () => ({});
  bot.buildDeviceRpcTransport = () => undefined;
  bot.maybeBuildThinToolRpcTransport = () => undefined;
  bot.startTypingHeartbeat = () => () => undefined;
  bot.cloudSessionRestorer = { markLocalSessionCleared: () => true };
  return { bot, states, acks, installs, replies, session, store,
    hasLocal: (value: boolean) => { hasLocal = value; },
    childActive: (value: boolean) => { childActive = value; },
    creates: () => creates };
}

test('incoming pre-turn work blocks fork before awaiting and cleans handler count', async t => {
  const h = harness(t);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  h.bot.onMessageInner = async () => {
    await barrier;
  };
  const inputWork = h.bot.onMessage(input);
  await h.bot.getSessionForkController().handle(control);
  assert.equal(h.acks[0].error, 'session_fork_source_busy');
  assert.equal(h.installs.length, 0);
  release();
  await inputWork;
  assert.equal(h.bot.activeSessionMessageHandlers.size, 0);
});

test('pure copy preserves existing actual context despite a different visible history', async t => {
  const h = harness(t);
  h.bot.bot.getAgentContextHistory = async () => assert.fail('fork must not import cloud display history');
  const stateBefore = structuredClone(h.states.get(source.sessionKey));
  await h.bot.getSessionForkController().handle({ ...control, source_last_seq: 99,
    message_id_map: { '10': 101, '98': 102, '99': 103 } });
  assert.equal(h.acks[0].state, 'ready');
  assert.deepEqual(h.installs[0].messages, [{ role: 'user', content: 'durable' }]);
  assert.deepEqual(h.states.get(source.sessionKey), stateBefore);
  assert.equal(h.creates(), 0);
  assert.deepEqual(h.replies, []);
});

test('ordinary replies require no fork receipt tracking or certification state writes', async t => {
  const h = harness(t);
  h.store.saveRuntimeState = () => assert.fail('fork certification must not write runtime state');
  await h.bot.onMessage(input);
  assert.deepEqual(h.replies, ['finished']);
});

test('source/target guards do not reject because an unrelated session is active', async t => {
  const h = harness(t);
  h.bot.activeSessionMessageHandlers = new Map([['unrelated', 1]]);
  h.bot.sessionExecutionReservations.add('unrelated');
  h.bot.sessionManager.isIdle = () => false;
  await h.bot.getSessionForkController().handle(control);
  assert.equal(h.acks[0].state, 'ready');
  assert.equal(h.creates(), 0);
});

test('queued input, pending attachments, child tasks, and pre-turn restoration each reject fork', async t => {
  for (const mode of ['queue', 'attachment', 'child', 'restore', 'batch', 'reservation']) {
    const h = harness(t);
    if (mode === 'queue') h.bot.messageQueue.set(source.sessionKey, [{}]);
    if (mode === 'attachment') h.bot.pendingAttachments.set(source.sessionKey, [{}]);
    if (mode === 'child') h.childActive(true);
    if (mode === 'restore') h.bot.cloudSessionRestorePromises.set(source.sessionKey, Promise.resolve());
    if (mode === 'batch') h.bot.subAgentCompletionBatches.set(source.sessionKey, {});
    if (mode === 'reservation') h.bot.sessionExecutionReservations.add(source.sessionKey);
    await h.bot.getSessionForkController().handle(control);
    assert.equal(h.acks[0].error, 'session_fork_source_busy', mode);
  }
});

test('an incoming source command waits for fork completion without racing snapshot state', async t => {
  const h = harness(t);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  h.bot.bot.completeSessionFork = async (ack: any) => { await barrier; return { ...ack, source_topic_id: source.topicId }; };
  const fork = h.bot.getSessionForkController().handle(control);
  let prepared = false;
  h.bot.onMessageInner = async () => { prepared = true; };
  const command = h.bot.onMessage({ ...input, text: '/clear' });
  assert.equal(prepared, false);
  release();
  await fork;
  await command;
  assert.equal(prepared, true);
});

test('missing fork target never falls back to cloud display history or initializes a session', async t => {
  for (const state of ['pending', 'ready', 'failed']) {
    const h = harness(t);
    h.hasLocal(false);
    h.bot.bot.getSessionFork = async () => ({ request_id: 'r1', source_topic_id: source.topicId, target_topic_id: target.topicId, state });
    h.bot.restoreCloudSessionWithStatus = async () => assert.fail('must not restore cloud display history');
    const result = await h.bot.ensureCloudSessionRestored({ topic: target.topicId, seq: 105 }, target);
    assert.equal(result.status, 'failed');
    assert.equal(h.creates(), 0);
    assert.equal(h.bot.cloudSessionRestorePromises.size, 0);
  }
});

test('provenance lookup errors also prohibit missing-local cloud restoration', async t => {
  const h = harness(t);
  h.hasLocal(false);
  h.bot.bot.getSessionFork = async () => { throw new Error('unavailable'); };
  h.bot.restoreCloudSessionWithStatus = async () => assert.fail('must not restore');
  assert.equal((await h.bot.ensureCloudSessionRestored({ topic: target.topicId, seq: 105 }, target)).status, 'failed');
});

test('ordinary missing session may restore only after provenance proves absence', async t => {
  const h = harness(t);
  h.hasLocal(false);
  const events: string[] = [];
  h.bot.bot.getSessionFork = async () => { events.push('provenance'); return undefined; };
  h.bot.restoreCloudSessionWithStatus = async () => { events.push('restore'); return { status: 'empty' }; };
  assert.equal((await h.bot.ensureCloudSessionRestored({ topic: source.topicId, seq: 10 }, source)).status, 'empty');
  assert.deepEqual(events, ['provenance', 'restore']);
});

test('clear cannot initialize a missing fork target', async t => {
  const h = harness(t);
  h.hasLocal(false);
  h.bot.bot.getSessionFork = async () => ({ request_id: 'r1', source_topic_id: source.topicId, target_topic_id: target.topicId, state: 'ready' });
  await h.bot.onMessage({ topic: target.topicId, senderId: 'usr7', text: '/clear', content: '/clear', isGroup: true, memberCount: 2, botCount: 1, seq: 105 });
  assert.equal(h.creates(), 0);
});

test('clear fences an older restore before awaiting its own provenance lookup', async t => {
  const h = harness(t);
  h.hasLocal(false);
  let startRestore!: () => void;
  let finishRestore!: (value: any) => void;
  let finishLookup!: () => void;
  const started = new Promise<void>(resolve => { startRestore = resolve; });
  const lookup = new Promise<void>(resolve => { finishLookup = resolve; });
  const restore = new Promise(resolve => { finishRestore = resolve; });
  let lookups = 0;
  h.bot.bot.getSessionFork = async () => { if (++lookups > 1) await lookup; return undefined; };
  h.bot.restoreCloudSessionWithStatus = async () => { startRestore(); return restore; };
  const oldInput = h.bot.onMessage(input);
  await started;
  const clear = h.bot.onMessage({ ...input, text: '/clear', content: '/clear', seq: 11 });
  finishRestore({ status: 'empty' });
  await oldInput;
  const createsBeforeClear = h.creates();
  finishLookup();
  await clear;
  assert.equal(createsBeforeClear, 0, 'older restore must not initialize or run while clear lookup is pending');
});

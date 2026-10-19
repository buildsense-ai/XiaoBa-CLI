import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cats-fork-recovery-'));
process.env.XIAOBA_USER_DATA_DIR = root;
const require = createRequire(import.meta.url);
const { SessionStore } = require('../src/utils/session-store');
const { CatsCompanyBot } = require('../src/catscompany');
const { CatsClient } = require('../src/catscompany/client');
const { CatsSessionForkController, normalizeSessionForkControl, forkSessionRoute } = require('../src/catscompany/session-fork');

after(() => {
  require('../src/utils/logger').Logger.closeLogFile();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

let serial = 1000;
function fixture(t: TestContext) {
  const topic = `grp_${++serial}`;
  const key = `cc_group:${topic}`;
  const store = new SessionStore();
  t.mock.method(SessionStore, 'getInstance', () => store);
  const marker = { sessionKey: key, topic, reason: 'oom-kill', startedAt: new Date().toISOString(), attempts: 0 };
  const stem = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const contextFile = path.join(root, 'data', 'sessions', `${stem}.jsonl`);
  const bootstrapFile = path.join(root, 'data', 'session-forks', `${stem}.json`);
  const stateFile = path.join(root, 'data', 'session-state', `${stem}.json`);
  const events: string[] = [];
  let live: any;
  const session = { isBusy: () => false, handleRuntimeObservation: async () => {
    events.push('observation');
    return { text: '', visibleToUser: false };
  } };
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  Object.assign(bot, {
    botUid: 'usr9', connectorReady: true, shuttingDown: false, activeMessageHandlers: 0,
    resumedInterruptedTurns: new Set(), sessionExecutionReservations: new Set(),
    activeConversationTasks: new Map(), messageQueue: new Map(), sessionClearGenerations: new Map(), sessionStopGenerations: new Map(),
    sessionManager: { get: () => live, getOrCreate: () => { events.push('create'); live = session; return session; } },
    bot: new CatsClient({ serverUrl: 'ws://fixture.invalid', httpBaseUrl: 'https://fixture.invalid', apiKey: 'test', bodyId: 'test' }),
    sender: { reply: async () => { events.push('notice'); } },
    startTypingHeartbeat: () => () => undefined,
    buildChannel: () => ({}), buildSessionCallbacks: () => ({}),
    buildDeviceRpcTransport: () => undefined, maybeBuildThinToolRpcTransport: () => undefined,
  });
  let response = () => Response.json({ request_id: 'fork', source_topic_id: 'p2p_7_9', target_topic_id: topic, state: 'ready' });
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(url.pathname, '/api/bot/session-forks', 'no cloud history restoration');
    assert.equal(url.searchParams.get('topic_id'), topic);
    events.push('provenance');
    return response();
  });
  const install = () => {
    store.installFork({ version: 1, requestId: 'fork', sourceSessionKey: 'source', targetSessionKey: key,
      sourceLastSeq: 20, messages: [{ role: 'user', content: 'original actual context' }] });
    store.saveContext(key, [{ role: 'user', content: 'later actual progress' }]);
  };
  const mark = () => store.saveRuntimeState(key, { interruptedTurn: marker });
  return { bot, store, marker, key, events, install, mark, contextFile, bootstrapFile, stateFile,
    response: (next: typeof response) => { response = next; } };
}

for (const mode of ['missing-materialized', 'all-context-files-missing', 'corrupt-materialized'] as const) {
  test(`startup rejects ${mode} fork before initialization, notice or attempt consumption`, async t => {
    const h = fixture(t);
    h.install();
    h.mark();
    if (mode === 'corrupt-materialized') fs.appendFileSync(h.contextFile, '\n{broken');
    else fs.unlinkSync(h.contextFile);
    if (mode === 'all-context-files-missing') fs.unlinkSync(h.bootstrapFile);
    const before = fs.readFileSync(h.stateFile, 'utf8');
    await assert.rejects(h.bot.resumeOneInterruptedTurn(h.marker));
    assert.deepEqual(h.events, mode === 'all-context-files-missing' ? ['provenance'] : []);
    assert.equal(fs.readFileSync(h.stateFile, 'utf8'), before);
    assert.equal(h.bot.resumedInterruptedTurns.size, 0);
    assert.equal(h.bot.sessionExecutionReservations.size, 0);
  });
}

test('direct startup execution entry also rejects a missing fork without retiring the marker', async t => {
  const h = fixture(t);
  h.install();
  h.mark();
  fs.unlinkSync(h.contextFile);
  const before = fs.readFileSync(h.stateFile, 'utf8');
  await assert.rejects(h.bot.runInterruptedTurnResume(h.key, h.marker.topic, 'resume'));
  assert.deepEqual(h.events, []);
  assert.equal(fs.readFileSync(h.stateFile, 'utf8'), before);
});

for (const mode of ['pending', 'failed', 'unavailable', 'generic404'] as const) {
  test(`startup fails closed on ${mode} provenance when local files are absent`, async t => {
    const h = fixture(t);
    h.mark();
    h.response(() => mode === 'unavailable' ? Response.json({}, { status: 503 })
      : mode === 'generic404' ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ request_id: 'fork', source_topic_id: 'p2p_7_9', target_topic_id: h.marker.topic, state: mode }));
    await assert.rejects(h.bot.resumeOneInterruptedTurn(h.marker));
    assert.deepEqual(h.events, ['provenance']);
    assert.deepEqual(h.store.loadRuntimeState(h.key).interruptedTurn, h.marker);
  });
}

test('ordinary missing-local startup resumes after explicit not-a-fork 404', async t => {
  const h = fixture(t);
  h.mark();
  h.response(() => Response.json({ error: 'session_fork_not_found' }, { status: 404 }));
  await h.bot.resumeOneInterruptedTurn(h.marker);
  assert.equal(h.events[0], 'provenance');
  assert.equal(h.events.filter(x => x === 'notice').length, 1);
  assert.equal(h.events.filter(x => x === 'observation').length, 1);
  assert.equal(h.store.loadRuntimeState(h.key).interruptedTurn, undefined);
});

test('valid local fork startup resumes its actual context without cloud lookup', async t => {
  const h = fixture(t);
  h.install();
  h.mark();
  await h.bot.resumeOneInterruptedTurn(h.marker);
  assert.equal(h.events.includes('provenance'), false);
  assert.equal(h.events.filter(x => x === 'observation').length, 1);
  assert.equal(h.store.readContextForFork(h.key)[0].content, 'later actual progress');
});

test('startup rechecks fork lock after asynchronous provenance and preserves the resume budget', async t => {
  const h = fixture(t);
  h.mark();
  let locked = false;
  h.bot.sessionForkController = { isLocked: () => locked };
  t.mock.method(h.bot.bot, 'getSessionFork', async () => {
    locked = true;
    return undefined;
  });
  await h.bot.resumeOneInterruptedTurn(h.marker);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.store.loadRuntimeState(h.key).interruptedTurn, h.marker);
  assert.equal(h.bot.resumedInterruptedTurns.size, 0);
  assert.equal(h.bot.sessionExecutionReservations.size, 0);
});

test('direct startup execution also respects a fork lock without retiring the marker', async t => {
  const h = fixture(t);
  h.install();
  h.mark();
  h.bot.sessionForkController = { isLocked: () => true };
  await h.bot.runInterruptedTurnResume(h.key, h.marker.topic, 'resume');
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.store.loadRuntimeState(h.key).interruptedTurn, h.marker);
});

test('pure copy supports existing sessions after restart and a fork of a fork without model initialization', async () => {
  let store = new SessionStore();
  const source = forkSessionRoute('p2p_7_9', 'usr7', 'usr9').sessionKey;
  const messages = [{ role: 'user', content: 'retained local summary', __checkpointSummary: true },
    { role: 'assistant', content: 'local-only result' }];
  store.saveContext(source, messages);
  store.saveRuntimeState(source, { currentDirectory: root });
  const before = JSON.stringify(store.readContextForFork(source));
  const acks: any[] = [];
  const controller = () => new CatsSessionForkController({ store, agentUid: () => 'usr9', isIdle: () => true,
    getSession: () => null, complete: async (ack: any) => { acks.push(ack); return ack; } });
  const first = normalizeSessionForkControl({ request_id: 'copy1', source_topic_id: 'p2p_7_9', target_topic_id: 'grp_2001',
    actor_user_id: 7, agent_uid: 9, source_last_seq: 99, message_id_map: { '98': 101, '99': 102 } });
  store = new SessionStore();
  await controller().handle(first);
  store = new SessionStore();
  const second = { ...first, request_id: 'copy2', source_topic_id: 'grp_2001', target_topic_id: 'grp_2002',
    source_last_seq: 102, message_id_map: { '101': 201, '102': 202 } };
  await controller().handle(second);
  assert.deepEqual(acks.map(ack => ack.state), ['ready', 'ready']);
  assert.equal(JSON.stringify(store.readContextForFork(source)), before);
  for (const key of ['cc_group:grp_2001', 'cc_group:grp_2002']) {
    assert.deepEqual(store.readContextForFork(key), messages);
    assert.equal(store.loadRuntimeState(key).currentDirectory, root);
  }
});

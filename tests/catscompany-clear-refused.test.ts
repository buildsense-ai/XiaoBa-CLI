import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CatsCompanyBot } from '../src/catscompany';
import { createCatsCoMessageEnvelope } from '../src/catscompany/message-envelope';
import { SessionStore, type SessionRuntimeState } from '../src/utils/session-store';

const TOPIC = 'p2p_7_9';
const CLEAR_REFUSED_REPLY = '原任务尚未结束，历史已保留。可用 /resume 恢复，或确认放弃后执行 /clear --abandon。';
const CLEAR_REFUSED_BUSY_REPLY = '原任务仍在执行或保存进度，历史已保留。请等待结束后再清空。';
const CLEAR_APPLIED_REPLY = '历史已清空';

const sessionKey = createCatsCoMessageEnvelope({
  topic: TOPIC,
  isGroup: false,
  senderId: 'usr7',
  seq: 10,
  text: '/clear',
  botUid: 'usr9',
}).sessionKey;

interface Harness {
  bot: any;
  states: Map<string, SessionRuntimeState>;
  replies: string[];
  cleared: string[];
  interrupts: () => number;
  cancelled: () => number;
  queue: () => any[];
  hasAttachments: () => boolean;
}

function harness(
  t: TestContext,
  clearResult: { handled: boolean; reply: string; clearRefused?: true },
): Harness {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const states = new Map<string, SessionRuntimeState>();
  const replies: string[] = [];
  const cleared: string[] = [];
  let interrupts = 0;
  let cancelled = 0;
  const store = {
    loadRuntimeState: (key: string) => states.get(key) || {},
    saveRuntimeState: (key: string, value: SessionRuntimeState) => { states.set(key, value); return true; },
    hasSession: () => true,
    getForkIdentity: () => undefined,
    readContextForFork: () => [{ role: 'user', content: 'durable' }],
    installFork: () => 'created',
  };
  t.mock.method(SessionStore, 'getInstance', () => store as any);
  const session = {
    recordInputReceipt: () => 'receipt-test',
    isBusy: () => false,
    handleMessage: async () => ({ text: 'finished', visibleToUser: true, taskOutcome: 'completed' }),
    handleCommand: async () => clearResult,
    requestInterrupt: () => { interrupts += 1; },
    exportForkContext: () => ({ messages: [], currentDirectory: '/workspace' }),
  };
  bot.botUid = 'usr9';
  bot.shuttingDown = false;
  bot.activeMessageHandlers = 0;
  bot.sessionManager = {
    getInputReceiptRecorder: () => session,
    get: () => session,
    getOrCreate: () => session,
  };
  bot.bot = { getSessionFork: async () => undefined, completeSessionFork: async () => undefined };
  bot.sender = {
    reply: async (_topic: string, text: string) => { replies.push(text); },
    sendTaskStatus: async () => undefined,
    downloadFile: async () => undefined,
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
  bot.cancelConversationTask = () => { cancelled += 1; };
  bot.buildChannel = () => ({});
  bot.buildSessionCallbacks = () => ({});
  bot.buildDeviceRpcTransport = () => undefined;
  bot.maybeBuildThinToolRpcTransport = () => undefined;
  bot.startTypingHeartbeat = () => () => undefined;
  bot.cloudSessionRestorer = {
    markLocalSessionCleared: (key: string) => { cleared.push(key); return true; },
  };
  bot.pendingAttachments.set(sessionKey, [{ fileName: 'a.txt', localPath: '/tmp/a.txt', type: 'file', receivedAt: 1 }]);
  bot.messageQueue.set(sessionKey, [{ userMessage: 'queued', topic: TOPIC, senderId: 'usr7', seq: 9, receivedAt: 1, clearGeneration: 0 }]);
  return {
    bot,
    states,
    replies,
    cleared,
    interrupts: () => interrupts,
    cancelled: () => cancelled,
    queue: () => bot.messageQueue.get(sessionKey) || [],
    hasAttachments: () => bot.pendingAttachments.has(sessionKey),
  };
}

function parsed(text: string, envelope?: unknown): any {
  return {
    topic: TOPIC,
    chatType: 'p2p',
    senderId: 'usr7',
    text,
    seq: 12,
    ...(envelope ? { envelope } : {}),
  };
}

function envelopeFor(text: string) {
  return createCatsCoMessageEnvelope({
    topic: TOPIC,
    isGroup: false,
    senderId: 'usr7',
    seq: 12,
    text,
    botUid: 'usr9',
  });
}

test('a refused /clear keeps queued work, attachments and the durable history', async t => {
  const h = harness(t, { handled: true, reply: CLEAR_REFUSED_REPLY, clearRefused: true });

  await h.bot.processParsedMessage(parsed('/clear'), sessionKey);

  assert.deepEqual(h.replies, [CLEAR_REFUSED_REPLY]);
  assert.equal(h.queue().length, 1, 'queued work must survive a refused clear');
  assert.equal(h.hasAttachments(), true, 'pending attachments must survive a refused clear');
  assert.deepEqual(h.cleared, [], 'a refused clear must not write the empty-history sentinel');
  assert.equal(h.interrupts(), 0, 'a refused clear must not interrupt the protected task');
  assert.equal(h.cancelled(), 0, 'a refused clear must not cancel the conversation task');
  assert.equal(h.bot.getSessionClearGeneration(sessionKey), 0);
});

test('a refused /clear --abandon while the task is still running changes nothing either', async t => {
  const h = harness(t, { handled: true, reply: CLEAR_REFUSED_BUSY_REPLY, clearRefused: true });

  await h.bot.processParsedMessage(parsed('/clear --abandon'), sessionKey);

  assert.deepEqual(h.replies, [CLEAR_REFUSED_BUSY_REPLY]);
  assert.equal(h.queue().length, 1);
  assert.equal(h.hasAttachments(), true);
  assert.deepEqual(h.cleared, []);
  assert.equal(h.interrupts(), 0);
  assert.equal(h.cancelled(), 0);
});

test('a refused routed /clear keeps queued work, restore and interruption state', async t => {
  const h = harness(t, { handled: true, reply: CLEAR_REFUSED_REPLY, clearRefused: true });
  const marker = t.mock.method(h.bot, 'clearInterruptedTurn', () => undefined);
  const restore = new AbortController();
  h.bot.cloudSessionRestoreAbortControllers.set(sessionKey, restore);
  const reply = t.mock.method(h.bot.sender, 'reply');

  await h.bot.processParsedMessage(parsed('/clear', envelopeFor('/clear')), sessionKey);

  const generation = h.bot.getSessionClearGeneration(sessionKey);
  assert.equal(generation, 0, 'a refused clear must not invalidate active work');
  assert.equal(restore.signal.aborted, false);
  assert.equal(marker.mock.callCount(), 0);
  assert.deepEqual(reply.mock.calls[0].arguments, [TOPIC, CLEAR_REFUSED_REPLY, { replyTo: 12 }]);
  assert.equal(h.queue().length, 1, 'queued work must survive a refused clear');
  assert.equal(h.queue()[0].clearGeneration, generation);
  assert.equal(h.hasAttachments(), true);
  assert.deepEqual(h.cleared, []);
  assert.equal(h.interrupts(), 0);
  assert.equal(h.cancelled(), 0);
});

test('an applied /clear still destroys queued work, attachments and writes the empty sentinel', async t => {
  const h = harness(t, { handled: true, reply: CLEAR_APPLIED_REPLY });

  await h.bot.processParsedMessage(parsed('/clear'), sessionKey);

  assert.deepEqual(h.replies, [CLEAR_APPLIED_REPLY]);
  assert.equal(h.queue().length, 0);
  assert.equal(h.hasAttachments(), false);
  assert.deepEqual(h.cleared, [sessionKey]);
  assert.equal(h.interrupts(), 1);
  assert.equal(h.cancelled(), 1);
});

test('an applied /clear --all deletes history without writing the sentinel', async t => {
  const h = harness(t, { handled: true, reply: CLEAR_APPLIED_REPLY });

  await h.bot.processParsedMessage(parsed('/clear --all'), sessionKey);

  assert.deepEqual(h.replies, [CLEAR_APPLIED_REPLY]);
  assert.equal(h.queue().length, 0);
  assert.equal(h.hasAttachments(), false);
  assert.deepEqual(h.cleared, [], '--all owns its own file deletion semantics');
  assert.equal(h.interrupts(), 1);
  assert.equal(h.cancelled(), 1);
});

test('an applied /clear --abandon clears like an ordinary successful clear', async t => {
  const h = harness(t, { handled: true, reply: CLEAR_APPLIED_REPLY });

  await h.bot.processParsedMessage(parsed('/clear --abandon'), sessionKey);

  assert.deepEqual(h.replies, [CLEAR_APPLIED_REPLY]);
  assert.equal(h.queue().length, 0);
  assert.equal(h.hasAttachments(), false);
  assert.deepEqual(h.cleared, [sessionKey]);
  assert.equal(h.interrupts(), 1);
  assert.equal(h.cancelled(), 1);
});

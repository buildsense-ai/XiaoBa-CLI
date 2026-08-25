import { test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';

test('terminateTopic is idempotent and fences every topic-owned runtime side effect', async () => {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const topic = 'grp_lifecycle_test';
  const sessionKey = `cc_group:${topic}`;
  let interruptCalls = 0;
  let terminateCalls = 0;
  let releaseTermination!: () => void;
  const terminationGate = new Promise<void>(resolve => { releaseTermination = resolve; });
  const restoreController = new AbortController();
  const batchTimer = setTimeout(() => undefined, 60_000);
  batchTimer.unref?.();
  const deliveryTimer = setTimeout(() => undefined, 60_000);
  deliveryTimer.unref?.();

  bot.topicTerminationTasks = new Map();
  bot.terminatedTopicKeys = new Set();
  bot.sessionClearGenerations = new Map([[sessionKey, 7]]);
  bot.pendingAttachments = new Map([[sessionKey, [{ fileName: 'old.zip' }]]]);
  bot.messageQueue = new Map([[sessionKey, [{ userMessage: 'old queued work' }]]]);
  bot.messageQueueDrainTimers = new Map([[sessionKey, new Set([deliveryTimer])]]);
  bot.sessionExecutionReservations = new Set([sessionKey]);
  bot.cloudSessionRestoreAbortControllers = new Map([[sessionKey, restoreController]]);
  bot.cloudSessionRestorePromises = new Map([[sessionKey, Promise.resolve({ status: 'restored' })]]);
  bot.subAgentCompletionBatches = new Map([[sessionKey, {
    timer: batchTimer,
    items: new Map([['old', { observation: 'old result' }]]),
  }]]);
  bot.subAgentEventRoutes = new Map([
    ['completed-child', { sessionKey, topic }],
    ['other-topic-child', { sessionKey: 'cc_group:grp_other', topic: 'grp_other' }],
  ]);
  bot.activeConversationTasks = new Map();
  bot.taskStatusTasks = new Map();
  bot.sessionManager = {
    get: () => ({ requestInterrupt: () => { interruptCalls += 1; } }),
    terminate: async () => {
      terminateCalls += 1;
      await terminationGate;
    },
  };

  const first = bot.terminateTopic(topic, 'access_revoked');
  const duplicateWhileRunning = bot.terminateTopic(topic, 'topic_forbidden');
  assert.strictEqual(first, duplicateWhileRunning);
  assert.equal(bot.sessionClearGenerations.get(sessionKey), 8);
  assert.equal(restoreController.signal.aborted, true);
  assert.equal(bot.pendingAttachments.has(sessionKey), false);
  assert.equal(bot.messageQueue.has(sessionKey), false);
  assert.equal(bot.messageQueueDrainTimers.has(sessionKey), false);
  assert.equal(bot.sessionExecutionReservations.has(sessionKey), false);
  assert.equal(bot.cloudSessionRestorePromises.has(sessionKey), false);
  assert.equal(bot.subAgentCompletionBatches.has(sessionKey), false);
  assert.equal(bot.subAgentEventRoutes.has('completed-child'), false);
  assert.equal(bot.subAgentEventRoutes.has('other-topic-child'), true);
  assert.equal(interruptCalls, 1);
  assert.equal(terminateCalls, 1);

  releaseTermination();
  await first;
  await bot.terminateTopic(topic, 'group_disbanded');
  assert.equal(bot.sessionClearGenerations.get(sessionKey), 8, 'late duplicate event is a no-op');
  assert.equal(terminateCalls, 1);

  // A newly delivered server message is the re-invite boundary. The old
  // generation remains fenced while the topic can create fresh work.
  bot.terminatedTopicKeys.delete(sessionKey);
  await bot.terminateTopic(topic, 'access_revoked');
  assert.equal(bot.sessionClearGenerations.get(sessionKey), 9);
  assert.equal(terminateCalls, 2);
});

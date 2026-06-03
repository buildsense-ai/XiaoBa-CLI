import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';
import { createCatsCoMessageEnvelope, createExecutionScope } from '../src/catscompany/message-envelope';

function canonicalMetadata(actorUserId: string, topicId: string, agentId = 'usr43', bodyId = 'body-main') {
  return {
    catsco_identity: {
      actor: { user_id: actorUserId },
      agent: { agent_id: agentId, body_id: bodyId },
      topic: { topic_id: topicId, type: topicId.startsWith('grp_') ? 'group' : 'p2p', channel_seq: 12 },
      permissions: { source: 'server_canonical_message' },
    },
  };
}

function createHarness(options: { busy?: boolean } = {}) {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const handledTurns: Array<{ userMessage: unknown; options: any }> = [];
  const sessionKeys: string[] = [];
  const sessionInputs: any[] = [];
  let busy = options.busy ?? false;

  const session = {
    isBusy: () => busy,
    setBusy: (next: boolean) => {
      busy = next;
    },
    handleMessage: async (userMessage: unknown, handleOptions: any) => {
      handledTurns.push({ userMessage, options: handleOptions });
      return { visibleToUser: false, text: '' };
    },
    handleRuntimeObservation: async () => ({ visibleToUser: false, text: '' }),
  };

  bot.sessionManager = {
    getOrCreate: (input: any) => {
      sessionInputs.push(input);
      sessionKeys.push(typeof input === 'string' ? input : input.sessionKey);
      return session;
    },
    get: () => session,
  };
  bot.sender = {
    downloadFile: async () => null,
    sendTyping: () => undefined,
    reply: async () => undefined,
    sendFile: async () => undefined,
    sendText: async () => undefined,
    sendThinking: async () => undefined,
    sendToolUse: async () => undefined,
    sendToolResult: async () => undefined,
  };
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.botUid = 'usr43';

  return { bot, handledTurns, sessionKeys, sessionInputs, session };
}

describe('CatsCompany execution scope flow', () => {
  test('passes canonical execution scope from websocket message into session turn', async () => {
    const { bot, handledTurns, sessionKeys, sessionInputs } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '查合同',
      content: '查合同',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 12,
    });

    assert.deepEqual(sessionKeys, ['session:v2:catscompany:p2p:p2p_7_43:agent:usr43']);
    assert.equal(sessionInputs[0].version, 2);
    assert.equal(sessionInputs[0].legacySessionKey, 'cc_user:usr7');
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.sessionRoute.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(handledTurns[0].options.executionScope.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(handledTurns[0].options.executionScope.legacySessionKey, 'cc_user:usr7');
    assert.equal(handledTurns[0].options.executionScope.actorUserId, 'usr7');
    assert.equal(handledTurns[0].options.executionScope.agentId, 'usr43');
    assert.equal(handledTurns[0].options.executionScope.agentBodyId, 'body-main');
    assert.equal(handledTurns[0].options.executionScope.isTrusted, true);
  });

  test('keeps execution scope when a busy CatsCompany turn is queued then drained', async () => {
    const { bot, handledTurns, sessionKeys, session } = createHarness({ busy: true });

    await (bot as any).onMessage({
      topic: 'p2p_8_43',
      senderId: 'usr8',
      text: '继续查',
      content: '继续查',
      metadata: canonicalMetadata('usr8', 'p2p_8_43'),
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 0);
    session.setBusy(false);
    await (bot as any).drainMessageQueue('session:v2:catscompany:p2p:p2p_8_43:agent:usr43');

    assert.deepEqual(sessionKeys, [
      'session:v2:catscompany:p2p:p2p_8_43:agent:usr43',
      'session:v2:catscompany:p2p:p2p_8_43:agent:usr43',
    ]);
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.executionScope.actorUserId, 'usr8');
    assert.equal(handledTurns[0].options.executionScope.topicId, 'p2p_8_43');
    assert.equal(handledTurns[0].options.executionScope.isTrusted, true);
  });

  test('group turn uses group session key while preserving actor in scope', async () => {
    const { bot, handledTurns, sessionKeys } = createHarness();

    await (bot as any).onMessage({
      topic: 'grp_80',
      senderId: 'usr7',
      text: '@usr43 看一下',
      content: '@usr43 看一下',
      metadata: canonicalMetadata('usr7', 'grp_80'),
      isGroup: true,
      seq: 12,
    });

    assert.deepEqual(sessionKeys, ['session:v2:catscompany:group:grp_80:agent:usr43']);
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.executionScope.topicType, 'group');
    assert.equal(handledTurns[0].options.executionScope.topicId, 'grp_80');
    assert.equal(handledTurns[0].options.executionScope.actorUserId, 'usr7');
  });

  test('does not merge queued CatsCo group input from another actor into the current actor scope', () => {
    const { bot } = createHarness();
    const sessionKey = 'session:v2:catscompany:group:grp_80:agent:usr43';
    const aliceScope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'grp_80',
      isGroup: true,
      senderId: 'alice',
      text: 'alice asks',
      metadata: canonicalMetadata('alice', 'grp_80'),
      botUid: 'usr43',
    }));
    const bobScope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'grp_80',
      isGroup: true,
      senderId: 'bob',
      text: 'bob asks',
      metadata: canonicalMetadata('bob', 'grp_80'),
      botUid: 'usr43',
    }));

    bot.messageQueue.set(sessionKey, [{
      userMessage: 'bob follow-up',
      topic: 'grp_80',
      senderId: 'bob',
      seq: 13,
      executionScope: bobScope,
      receivedAt: Date.now(),
      source: 'user',
    }]);

    assert.equal((bot as any).consumeQueuedUserInput(sessionKey, aliceScope), null);
    assert.equal(bot.messageQueue.get(sessionKey)?.length, 1);

    const pendingForBob = (bot as any).consumeQueuedUserInput(sessionKey, bobScope);
    assert.equal(pendingForBob, 'bob follow-up');
    assert.equal(bot.messageQueue.has(sessionKey), false);
  });
});

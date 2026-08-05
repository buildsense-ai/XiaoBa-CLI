import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { FeishuBot } from '../src/feishu';
import { SubAgentManager } from '../src/core/sub-agent-manager';

describe('Feishu SessionRoute V2', () => {
  test('routes private messages through a Feishu V2 session key', async () => {
    const bot = createHarness({
      message: {
        messageId: 'msg-1',
        chatId: 'shared',
        chatType: 'p2p',
        senderId: 'shared',
        text: 'hello',
        mentionBot: false,
        msgType: 'text',
      },
    });

    try {
      await (bot as any).onMessage({});

      assert.deepEqual(bot.createdSessions, ['session:v2:feishu:p2p:shared']);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.channel.chatId, 'shared');
      assert.equal(bot.handledTurns[0].options.sessionRoute.sessionKey, 'session:v2:feishu:p2p:shared');
      assert.equal(bot.handledTurns[0].options.executionScope.source, 'feishu');
      assert.equal(bot.handledTurns[0].options.executionScope.topicType, 'p2p');
      assert.equal(bot.handledTurns[0].options.executionScope.topicId, 'shared');
      assert.equal(bot.handledTurns[0].options.executionScope.actorUserId, 'shared');
      assert.equal(bot.messageQueue.size, 0);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:feishu:p2p:shared');
    }
  });

  test('queues group messages under the same V2 route used for draining', async () => {
    const bot = createHarness({
      busy: true,
      message: {
        messageId: 'msg-2',
        chatId: 'oc_group',
        chatType: 'group',
        senderId: 'ou_user',
        text: '@bot 继续',
        mentionBot: true,
        msgType: 'text',
      },
    });

    try {
      await (bot as any).onMessage({});

      const sessionKey = 'session:v2:feishu:group:oc_group';
      assert.equal(bot.messageQueue.has(sessionKey), true);
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.senderId, 'ou_user');
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.sessionRoute.actorUserId, 'ou_user');
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);

      assert.deepEqual(bot.createdSessions, [sessionKey, sessionKey]);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.channel.chatId, 'oc_group');
      assert.equal(bot.handledTurns[0].options.sessionRoute.sessionKey, sessionKey);
      assert.equal(bot.handledTurns[0].options.executionScope.topicType, 'group');
      assert.equal(bot.handledTurns[0].options.executionScope.actorUserId, 'ou_user');
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:feishu:group:oc_group');
    }
  });

  test('delivers classified failed replies without relying on the legacy fallback text', async () => {
    const bot = createHarness({
      message: {
        messageId: 'msg-error',
        chatId: 'shared',
        chatType: 'p2p',
        senderId: 'shared',
        text: '继续',
        mentionBot: false,
        msgType: 'text',
      },
    });
    bot.sessionResult = {
      visibleToUser: true,
      text: '模型服务暂时不可用，请稍后再试。',
      taskOutcome: 'failed',
    };

    try {
      await (bot as any).onMessage({});

      assert.deepEqual(bot.replies, [
        { chatId: 'shared', text: '模型服务暂时不可用，请稍后再试。' },
      ]);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:feishu:p2p:shared');
    }
  });
});

function createHarness(options: { busy?: boolean; message: any }): any {
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.sessionBusy = options.busy ?? false;
  bot.createdSessions = [] as string[];
  bot.handledTurns = [] as any[];
  bot.replies = [] as Array<{ chatId: string; text: string }>;
  bot.sessionResult = { visibleToUser: false, text: '' };
  bot.processedMsgIds = new Set();
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.bridgeClient = null;
  bot.bridgeConfig = undefined;
  bot.handler = {
    parse: () => options.message,
  };
  const session = {
    isBusy: () => bot.sessionBusy,
    handleCommand: async () => ({ handled: false }),
    handleMessage: async (userText: string, handleOptions: any) => {
      bot.handledTurns.push({ userText, options: handleOptions });
      return bot.sessionResult;
    },
    handleRuntimeObservation: async (userText: string, handleOptions: any) => {
      bot.handledTurns.push({ userText, options: handleOptions });
      return { visibleToUser: false, text: '' };
    },
  };
  bot.sessionManager = {
    getOrCreate: (input: any) => {
      bot.createdSessions.push(typeof input === 'string' ? input : input.sessionKey);
      return session;
    },
  };
  bot.sender = {
    reply: async (chatId: string, text: string) => {
      bot.replies.push({ chatId, text });
    },
    downloadFile: async () => null,
    fetchMergeForwardTexts: async () => '',
    sendFile: async () => undefined,
  };
  return bot;
}

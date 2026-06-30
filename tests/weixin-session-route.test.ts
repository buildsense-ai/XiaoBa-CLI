import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { WeixinBot } from '../src/weixin';
import { SubAgentManager } from '../src/core/sub-agent-manager';

describe('Weixin SessionRoute V2', () => {
  test('routes messages through a Weixin V2 key while preserving the outbound user id', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      parsed: {
        message_id: 'wx-msg-1',
        from: { id: 'shared' },
        chat: { id: 'wx-bot' },
        text: 'hello',
        context_token: 'ctx-token',
      },
    });

    try {
      await (bot as any).handleMessage({
        message_type: 0,
        message_id: 'wx-msg-1',
        from_user_id: 'shared',
        to_user_id: 'wx-bot',
        context_token: 'ctx-token',
      });

      const sessionKey = 'session:v2:weixin:p2p:shared';
      assert.deepEqual(bot.createdSessions, [sessionKey]);
      assert.equal(bot.contextTokens.get(sessionKey), 'ctx-token');
      assert.equal(bot.contextTokens.get('user:shared'), 'ctx-token');
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.channel.chatId, 'shared');
      assert.equal(bot.handledTurns[0].options.sessionRoute.sessionKey, sessionKey);
      assert.equal(bot.handledTurns[0].options.executionScope.source, 'weixin');
      assert.equal(bot.handledTurns[0].options.executionScope.topicType, 'p2p');
      assert.equal(bot.handledTurns[0].options.executionScope.topicId, 'shared');
      assert.equal(bot.handledTurns[0].options.executionScope.actorUserId, 'shared');

      await bot.handledTurns[0].options.channel.reply('ignored-chat-id', 'reply text');

      assert.deepEqual(sentTexts, [
        { userId: 'shared', text: 'reply text', contextToken: 'ctx-token', fromUserId: 'wx-bot' },
      ]);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:weixin:p2p:shared');
    }
  });

  test('keeps busy queue entries bound to the same Weixin actor user id', async () => {
    const bot = createHarness({
      busy: true,
      parsed: {
        message_id: 'wx-msg-2',
        from: { id: 'shared' },
        chat: { id: 'wx-bot' },
        text: 'queued',
        context_token: 'ctx-token',
      },
    });

    try {
      await (bot as any).handleMessage({
        message_type: 0,
        message_id: 'wx-msg-2',
        from_user_id: 'shared',
        to_user_id: 'wx-bot',
        context_token: 'ctx-token',
      });

      const sessionKey = 'session:v2:weixin:p2p:shared';
      assert.equal(bot.messageQueue.has(sessionKey), true);
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.userId, 'shared');
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.sessionRoute.actorUserId, 'shared');
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);

      assert.deepEqual(bot.createdSessions, [sessionKey, sessionKey]);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.channel.chatId, 'shared');
      assert.equal(bot.handledTurns[0].options.executionScope.topicId, 'shared');
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:weixin:p2p:shared');
    }
  });
});

function createHarness(options: {
  busy?: boolean;
  parsed: any;
  sentTexts?: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }>;
}): any {
  const bot = Object.create(WeixinBot.prototype) as any;
  bot.sessionBusy = options.busy ?? false;
  bot.createdSessions = [] as string[];
  bot.handledTurns = [] as any[];
  bot.contextTokens = new Map();
  bot.messageQueue = new Map();
  bot.saveState = async () => undefined;
  bot.handler = {
    parseMessage: () => options.parsed,
    shouldIgnoreMessage: () => false,
    downloadMedia: async () => [],
  };
  const session = {
    isBusy: () => bot.sessionBusy,
    handleMessage: async (userText: string, handleOptions: any) => {
      bot.handledTurns.push({ userText, options: handleOptions });
      return { visibleToUser: false, text: '' };
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
    sendText: async (userId: string, text: string, contextToken?: string, fromUserId?: string) => {
      options.sentTexts?.push({ userId, text, contextToken, fromUserId });
    },
    sendFile: async () => undefined,
  };
  return bot;
}

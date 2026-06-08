import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { WeixinBot } from '../src/weixin';
import { SubAgentManager } from '../src/core/sub-agent-manager';

describe('Weixin SessionRoute V2', () => {
  test('routes messages through a Weixin V2 key while preserving the outbound user id', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string }> = [];
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
        { userId: 'shared', text: 'reply text', contextToken: 'ctx-token' },
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

  test('does not create a model session when channel binding is required but missing', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string }> = [];
    const bot = createHarness({
      sentTexts,
      bindingResolver: {
        enabled: true,
        required: true,
        resolve: async () => ({ bound: false }),
      },
      parsed: {
        message_id: 'wx-msg-binding-missing',
        from: { id: 'shared' },
        chat: { id: 'wx-bot' },
        text: 'hello',
        context_token: 'ctx-token',
      },
    });

    await (bot as any).handleMessage({
      message_type: 0,
      message_id: 'wx-msg-binding-missing',
      from_user_id: 'shared',
      to_user_id: 'wx-bot',
      context_token: 'ctx-token',
    });

    assert.deepEqual(bot.createdSessions, []);
    assert.equal(bot.handledTurns.length, 0);
    assert.equal(sentTexts.length, 1);
    assert.equal(sentTexts[0].userId, 'shared');
    assert.match(sentTexts[0].text, /入口码|绑定/);
  });

  test('uses resolved channel binding as the Weixin agent session route', async () => {
    const bindingInputs: any[] = [];
    const bot = createHarness({
      channelAppId: 'wx_app',
      bindingResolver: {
        enabled: true,
        required: true,
        resolve: async (input: any) => {
          bindingInputs.push(input);
          return {
            bound: true,
            agentId: 'usr43',
            agentBodyId: 'body-contract',
            identityTrust: 'server_canonical',
            identitySource: 'channel_agent_binding',
          };
        },
      },
      parsed: {
        message_id: 'wx-msg-binding-ok',
        from: { id: 'openid-user' },
        chat: { id: 'wx-bot' },
        text: '查合同',
        context_token: 'ctx-token',
      },
    });

    try {
      await (bot as any).handleMessage({
        message_type: 0,
        message_id: 'wx-msg-binding-ok',
        from_user_id: 'openid-user',
        to_user_id: 'wx-bot',
        context_token: 'ctx-token',
      });

      const sessionKey = 'session:v2:weixin:p2p:openid-user:agent:usr43';
      assert.deepEqual(bot.createdSessions, [sessionKey]);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.sessionRoute.agentId, 'usr43');
      assert.equal(bot.handledTurns[0].options.sessionRoute.agentBodyId, 'body-contract');
      assert.equal(bot.handledTurns[0].options.sessionRoute.identityTrust, 'server_canonical');
      assert.equal(bot.handledTurns[0].options.executionScope.agentId, 'usr43');
      assert.equal(bot.handledTurns[0].options.executionScope.agentBodyId, 'body-contract');
      assert.equal(bot.handledTurns[0].options.executionScope.isTrusted, true);
      assert.deepEqual(bindingInputs, [{
        channel: 'weixin',
        channelAppId: 'wx_app',
        channelUserId: 'openid-user',
        channelConversationType: 'p2p',
      }]);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:weixin:p2p:openid-user:agent:usr43');
    }
  });
});

function createHarness(options: {
  busy?: boolean;
  parsed: any;
  sentTexts?: Array<{ userId: string; text: string; contextToken?: string }>;
  bindingResolver?: any;
  channelAppId?: string;
}): any {
  const bot = Object.create(WeixinBot.prototype) as any;
  bot.sessionBusy = options.busy ?? false;
  bot.createdSessions = [] as string[];
  bot.handledTurns = [] as any[];
  bot.contextTokens = new Map();
  bot.messageQueue = new Map();
  bot.bindingResolver = options.bindingResolver || { enabled: false, required: false };
  bot.channelAppId = options.channelAppId || '';
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
    sendText: async (userId: string, text: string, contextToken?: string) => {
      options.sentTexts?.push({ userId, text, contextToken });
    },
    sendFile: async () => undefined,
  };
  return bot;
}

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

  test('does not apply QR channel binding to Feishu group messages yet', async () => {
    const bot = createHarness({
      bindingResolver: {
        enabled: true,
        required: true,
        resolve: async () => {
          throw new Error('group binding should not be resolved in this PR');
        },
      },
      message: {
        messageId: 'msg-group-binding-skipped',
        chatId: 'oc_group',
        chatType: 'group',
        senderId: 'ou_user',
        text: '@bot 看一下',
        mentionBot: true,
        msgType: 'text',
      },
    });

    try {
      await (bot as any).onMessage({});

      const sessionKey = 'session:v2:feishu:group:oc_group';
      assert.deepEqual(bot.createdSessions, [sessionKey]);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.sessionRoute.sessionKey, sessionKey);
      assert.equal(bot.handledTurns[0].options.executionScope.topicType, 'group');
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:feishu:group:oc_group');
    }
  });

  test('does not create a model session when channel binding is required but missing', async () => {
    const replies: string[] = [];
    const bot = createHarness({
      replies,
      bindingResolver: {
        enabled: true,
        required: true,
        resolve: async () => ({ bound: false }),
      },
      message: {
        messageId: 'msg-binding-missing',
        chatId: 'shared',
        chatType: 'p2p',
        senderId: 'shared',
        text: 'hello',
        mentionBot: false,
        msgType: 'text',
      },
    });

    await (bot as any).onMessage({});

    assert.deepEqual(bot.createdSessions, []);
    assert.equal(bot.handledTurns.length, 0);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /入口码|绑定/);
  });

  test('uses resolved channel binding as the Feishu agent session route', async () => {
    const bot = createHarness({
      bindingResolver: {
        enabled: true,
        required: true,
        resolve: async () => ({
          bound: true,
          agentId: 'usr43',
          agentBodyId: 'body-contract',
          identityTrust: 'server_canonical',
          identitySource: 'channel_agent_binding',
        }),
      },
      message: {
        messageId: 'msg-binding-ok',
        chatId: 'shared',
        chatType: 'p2p',
        senderId: 'ou_user',
        text: '查合同',
        mentionBot: false,
        msgType: 'text',
      },
    });

    try {
      await (bot as any).onMessage({});

      const sessionKey = 'session:v2:feishu:p2p:shared:agent:usr43';
      assert.deepEqual(bot.createdSessions, [sessionKey]);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.sessionRoute.agentId, 'usr43');
      assert.equal(bot.handledTurns[0].options.sessionRoute.agentBodyId, 'body-contract');
      assert.equal(bot.handledTurns[0].options.sessionRoute.identityTrust, 'server_canonical');
      assert.equal(bot.handledTurns[0].options.executionScope.agentId, 'usr43');
      assert.equal(bot.handledTurns[0].options.executionScope.agentBodyId, 'body-contract');
      assert.equal(bot.handledTurns[0].options.executionScope.isTrusted, true);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:feishu:p2p:shared:agent:usr43');
    }
  });
});

function createHarness(options: { busy?: boolean; message: any; bindingResolver?: any; replies?: string[] }): any {
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.sessionBusy = options.busy ?? false;
  bot.createdSessions = [] as string[];
  bot.handledTurns = [] as any[];
  bot.processedMsgIds = new Set();
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.bridgeClient = null;
  bot.bridgeConfig = undefined;
  bot.channelAppId = 'cli_app';
  bot.bindingResolver = options.bindingResolver || { enabled: false, required: false };
  bot.handler = {
    parse: () => options.message,
  };
  const session = {
    isBusy: () => bot.sessionBusy,
    handleCommand: async () => ({ handled: false }),
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
    reply: async (_chatId: string, text: string) => {
      options.replies?.push(text);
    },
    downloadFile: async () => null,
    fetchMergeForwardTexts: async () => '',
    sendFile: async () => undefined,
  };
  return bot;
}

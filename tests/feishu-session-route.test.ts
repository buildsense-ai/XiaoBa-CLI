import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { FeishuBot } from '../src/feishu';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { BUSY_MESSAGE } from '../src/core/agent-session';

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
  test('sends a classified failed result instead of collapsing it to ERROR_MESSAGE', async () => {
    const sentTexts: string[] = [];
    const bot = createHarness({
      sentTexts,
      result: { visibleToUser: true, text: '模型访问凭证无效。', taskOutcome: 'failed' },
      message: {
        messageId: 'msg-failed', chatId: 'private', chatType: 'p2p', senderId: 'private',
        text: 'hello', mentionBot: true, msgType: 'text',
      },
    });
    try {
      await (bot as any).onMessage({});
      assert.deepEqual(sentTexts, ['模型访问凭证无效。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:feishu:p2p:private');
    }
  });

  test('requeues a direct racing BUSY user message and sends the later failure once', async () => {
    const sentTexts: string[] = [];
    const bot = createHarness({
      sentTexts,
      results: [
        { visibleToUser: true, text: BUSY_MESSAGE },
        { visibleToUser: true, text: '模型请求超时。', taskOutcome: 'failed' },
      ],
      message: {
        messageId: 'msg-direct-race', chatId: 'oc_direct_race', chatType: 'group', senderId: 'ou_direct_race',
        text: 'direct racing user text', mentionBot: true, msgType: 'text',
      },
    });
    const sessionKey = 'session:v2:feishu:group:oc_direct_race';
    try {
      await (bot as any).onMessage({});
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.userText, 'direct racing user text');
      assert.deepEqual(sentTexts, []);

      await (bot as any).drainMessageQueue(sessionKey);
      assert.equal(bot.messageQueue.has(sessionKey), false);
      assert.deepEqual(sentTexts, ['模型请求超时。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks(sessionKey);
    }
  });

  test('sends a queued classified failure exactly once', async () => {
    const sentTexts: string[] = [];
    const bot = createHarness({
      busy: true,
      sentTexts,
      result: { visibleToUser: true, text: '模型请求参数无效。', taskOutcome: 'failed' },
      message: {
        messageId: 'msg-queued-failed', chatId: 'oc_failed', chatType: 'group', senderId: 'ou_failed',
        text: '@bot 继续', mentionBot: true, msgType: 'text',
      },
    });
    const sessionKey = 'session:v2:feishu:group:oc_failed';
    try {
      await (bot as any).onMessage({});
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);
      assert.deepEqual(sentTexts, ['模型请求参数无效。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks(sessionKey);
    }
  });

  test('sends a subagent classified failure exactly once', async () => {
    const sentTexts: string[] = [];
    const bot = createHarness({
      sentTexts,
      runtimeResult: { visibleToUser: true, text: '模型服务暂时不可用。', taskOutcome: 'failed' },
      message: {
        messageId: 'unused', chatId: 'private', chatType: 'p2p', senderId: 'private',
        text: 'unused', mentionBot: false, msgType: 'text',
      },
    });
    await (bot as any).handleSubAgentFeedback(
      'session:v2:feishu:p2p:private',
      'private',
      'private',
      'subagent result',
    );
    assert.deepEqual(sentTexts, ['模型服务暂时不可用。']);
  });

  test('queues busy subagent feedback and later sends its classified failure once', async () => {
    const sentTexts: string[] = [];
    const bot = createHarness({
      busy: true,
      sentTexts,
      runtimeResult: { visibleToUser: true, text: '模型超时，请稍后重试。', taskOutcome: 'failed' },
      message: { messageId: 'unused', chatId: 'private', chatType: 'p2p', senderId: 'private', text: '', mentionBot: false, msgType: 'text' },
    });
    const sessionKey = 'session:v2:feishu:p2p:private';
    await (bot as any).handleSubAgentFeedback(sessionKey, 'private', 'private', 'subagent result');
    assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.source, 'subagent_feedback');
    bot.sessionBusy = false;
    await (bot as any).drainMessageQueue(sessionKey);
    assert.deepEqual(sentTexts, ['模型超时，请稍后重试。']);
  });

  test('requeues a racing BUSY subagent result and sends the later failure once', async () => {
    const sentTexts: string[] = [];
    const bot = createHarness({
      sentTexts,
      runtimeResults: [
        { visibleToUser: true, text: BUSY_MESSAGE },
        { visibleToUser: true, text: '模型权限不足。', taskOutcome: 'failed' },
      ],
      message: { messageId: 'unused', chatId: 'private', chatType: 'p2p', senderId: 'private', text: '', mentionBot: false, msgType: 'text' },
    });
    const sessionKey = 'session:v2:feishu:p2p:private';
    await (bot as any).handleSubAgentFeedback(sessionKey, 'private', 'private', 'subagent result');
    assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.source, 'subagent_feedback');
    await (bot as any).drainMessageQueue(sessionKey);
    assert.deepEqual(sentTexts, ['模型权限不足。']);
  });


  test('requeues a racing BUSY queued user message and sends the later failure once', async () => {
    const sentTexts: string[] = [];
    const bot = createHarness({
      sentTexts,
      results: [
        { visibleToUser: true, text: BUSY_MESSAGE },
        { visibleToUser: true, text: '模型请求超时。', taskOutcome: 'failed' },
      ],
      message: { messageId: 'queued-race', chatId: 'oc_race', chatType: 'group', senderId: 'ou_race', text: 'queued user text', mentionBot: true, msgType: 'text' },
    });
    const sessionKey = 'session:v2:feishu:group:oc_race';
    bot.sessionBusy = true;
    try {
      await (bot as any).onMessage({});
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);
      assert.equal(bot.messageQueue.get(sessionKey)?.length, 1);
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.userText, 'queued user text');
      assert.deepEqual(sentTexts, []);

      await (bot as any).drainMessageQueue(sessionKey);
      assert.equal(bot.messageQueue.has(sessionKey), false);
      assert.deepEqual(sentTexts, ['模型请求超时。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks(sessionKey);
    }
  });

});

function createHarness(options: {
  busy?: boolean;
  message: any;
  result?: any;
  results?: any[];
  runtimeResult?: any;
  runtimeResults?: any[];
  sentTexts?: string[];
}): any {
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
      return options.results?.shift() ?? options.result ?? { visibleToUser: false, text: '' };
    },
    handleRuntimeObservation: async (userText: string, handleOptions: any) => {
      bot.handledTurns.push({ userText, options: handleOptions });
      return options.runtimeResults?.shift() ?? options.runtimeResult ?? { visibleToUser: false, text: '' };
    },
  };
  bot.sessionManager = {
    getOrCreate: (input: any) => {
      bot.createdSessions.push(typeof input === 'string' ? input : input.sessionKey);
      return session;
    },
  };
  bot.sender = {
    reply: async (_chatId: string, text: string) => { options.sentTexts?.push(text); },
    downloadFile: async () => null,
    fetchMergeForwardTexts: async () => '',
    sendFile: async () => undefined,
  };
  return bot;
}

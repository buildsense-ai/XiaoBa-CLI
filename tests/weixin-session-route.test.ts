import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { WeixinBot } from '../src/weixin';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { BUSY_MESSAGE } from '../src/core/agent-session';

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
  test('delivers classified failed replies without relying on the legacy fallback text', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      result: {
        visibleToUser: true,
        text: '模型响应超时，本轮上下文已保留，请稍后继续。',
        taskOutcome: 'failed',
      },
      parsed: {
        message_id: 'wx-msg-error', from: { id: 'shared' }, chat: { id: 'wx-bot' },
        text: '继续', context_token: 'ctx-token',
      },
    });
    try {
      await (bot as any).handleMessage({
        message_type: 0, message_id: 'wx-msg-error', from_user_id: 'shared',
        to_user_id: 'wx-bot', context_token: 'ctx-token',
      });
      assert.deepEqual(sentTexts, [{
        userId: 'shared',
        text: '模型响应超时，本轮上下文已保留，请稍后继续。',
        contextToken: 'ctx-token',
        fromUserId: 'wx-bot',
      }]);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:weixin:p2p:shared');
    }
  });

  test('sends a classified failed result instead of collapsing it to ERROR_MESSAGE', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      result: { visibleToUser: true, text: '当前模型的访问凭证无效。', taskOutcome: 'failed' },
      parsed: {
        message_id: 'wx-msg-failed', from: { id: 'user-failed' }, chat: { id: 'wx-bot' },
        text: 'hello', context_token: 'ctx-failed',
      },
    });
    try {
      await (bot as any).handleMessage({
        message_type: 0, message_id: 'wx-msg-failed', from_user_id: 'user-failed',
        to_user_id: 'wx-bot', context_token: 'ctx-failed',
      });
      assert.deepEqual(sentTexts.map(entry => entry.text), ['当前模型的访问凭证无效。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:weixin:p2p:user-failed');
    }
  });

  test('requeues a direct racing BUSY user message and sends the later failure once', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      results: [
        { visibleToUser: true, text: BUSY_MESSAGE },
        { visibleToUser: true, text: '模型请求超时。', taskOutcome: 'failed' },
      ],
      parsed: {
        message_id: 'wx-direct-race', from: { id: 'direct-race-user' }, chat: { id: 'wx-bot' },
        text: 'direct racing user text', context_token: 'ctx-direct-race',
      },
    });
    const sessionKey = 'session:v2:weixin:p2p:direct-race-user';
    try {
      await (bot as any).handleMessage({
        message_type: 0, message_id: 'wx-direct-race', from_user_id: 'direct-race-user',
        to_user_id: 'wx-bot', context_token: 'ctx-direct-race',
      });
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.userText, 'direct racing user text');
      assert.deepEqual(sentTexts, []);

      await (bot as any).drainMessageQueue(sessionKey);
      assert.equal(bot.messageQueue.has(sessionKey), false);
      assert.deepEqual(sentTexts.map(entry => entry.text), ['模型请求超时。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks(sessionKey);
    }
  });

  test('sends a queued classified failure exactly once', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      busy: true,
      sentTexts,
      result: { visibleToUser: true, text: '模型请求参数无效。', taskOutcome: 'failed' },
      parsed: {
        message_id: 'wx-msg-queued-failed', from: { id: 'queued-user' }, chat: { id: 'wx-bot' },
        text: '继续', context_token: 'ctx-queued',
      },
    });
    const sessionKey = 'session:v2:weixin:p2p:queued-user';
    try {
      await (bot as any).handleMessage({
        message_type: 0, message_id: 'wx-msg-queued-failed', from_user_id: 'queued-user',
        to_user_id: 'wx-bot', context_token: 'ctx-queued',
      });
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);
      assert.deepEqual(sentTexts.map(entry => entry.text), ['模型请求参数无效。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks(sessionKey);
    }
  });

  test('sends a subagent classified failure exactly once', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      runtimeResult: { visibleToUser: true, text: '模型服务暂时不可用。', taskOutcome: 'failed' },
      parsed: {
        message_id: 'unused', from: { id: 'subagent-user' }, chat: { id: 'wx-bot' },
        text: 'unused', context_token: 'ctx-subagent',
      },
    });
    await (bot as any).handleSubAgentFeedback(
      'session:v2:weixin:p2p:subagent-user',
      'subagent-user',
      'subagent-user',
      'subagent result',
    );
    assert.deepEqual(sentTexts.map(entry => entry.text), ['模型服务暂时不可用。']);
  });

  test('queues busy subagent feedback and later sends its classified failure once', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      busy: true,
      sentTexts,
      runtimeResult: { visibleToUser: true, text: '模型超时，请稍后重试。', taskOutcome: 'failed' },
      parsed: { message_id: 'unused', from: { id: 'subagent-user' }, chat: { id: 'wx-bot' }, text: '', context_token: 'ctx-subagent' },
    });
    const sessionKey = 'session:v2:weixin:p2p:subagent-user';
    await (bot as any).handleSubAgentFeedback(sessionKey, 'subagent-user', 'subagent-user', 'subagent result');
    assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.source, 'subagent_feedback');
    bot.sessionBusy = false;
    await (bot as any).drainMessageQueue(sessionKey);
    assert.deepEqual(sentTexts.map(entry => entry.text), ['模型超时，请稍后重试。']);
  });

  test('requeues a racing BUSY subagent result and sends the later failure once', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      runtimeResults: [
        { visibleToUser: true, text: BUSY_MESSAGE },
        { visibleToUser: true, text: '模型权限不足。', taskOutcome: 'failed' },
      ],
      parsed: { message_id: 'unused', from: { id: 'subagent-user' }, chat: { id: 'wx-bot' }, text: '', context_token: 'ctx-subagent' },
    });
    const sessionKey = 'session:v2:weixin:p2p:subagent-user';
    await (bot as any).handleSubAgentFeedback(sessionKey, 'subagent-user', 'subagent-user', 'subagent result');
    assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.source, 'subagent_feedback');
    await (bot as any).drainMessageQueue(sessionKey);
    assert.deepEqual(sentTexts.map(entry => entry.text), ['模型权限不足。']);
  });


  test('requeues a racing BUSY queued user message and sends the later failure once', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      results: [
        { visibleToUser: true, text: BUSY_MESSAGE },
        { visibleToUser: true, text: '模型请求超时。', taskOutcome: 'failed' },
      ],
      parsed: { message_id: 'wx-race', from: { id: 'race-user' }, chat: { id: 'wx-bot' }, text: 'queued user text', context_token: 'ctx-race' },
    });
    const sessionKey = 'session:v2:weixin:p2p:race-user';
    bot.sessionBusy = true;
    try {
      await (bot as any).handleMessage({
        message_type: 0, message_id: 'wx-race', from_user_id: 'race-user',
        to_user_id: 'wx-bot', context_token: 'ctx-race',
      });
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);
      assert.equal(bot.messageQueue.get(sessionKey)?.length, 1);
      assert.equal(bot.messageQueue.get(sessionKey)?.[0]?.userText, 'queued user text');
      assert.deepEqual(sentTexts, []);

      await (bot as any).drainMessageQueue(sessionKey);
      assert.equal(bot.messageQueue.has(sessionKey), false);
      assert.deepEqual(sentTexts.map(entry => entry.text), ['模型请求超时。']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks(sessionKey);
    }
  });

});

function createHarness(options: {
  busy?: boolean;
  parsed: any;
  result?: any;
  results?: any[];
  runtimeResult?: any;
  runtimeResults?: any[];
  sentTexts?: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }>;
}): any {
  const bot = Object.create(WeixinBot.prototype) as any;
  bot.sessionBusy = options.busy ?? false;
  bot.createdSessions = [] as string[];
  bot.handledTurns = [] as any[];
  bot.sessionResult = { visibleToUser: false, text: '' };
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
    sendText: async (userId: string, text: string, contextToken?: string, fromUserId?: string) => {
      options.sentTexts?.push({ userId, text, contextToken, fromUserId });
    },
    sendFile: async () => undefined,
  };
  return bot;
}

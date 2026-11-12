import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import axios from 'axios';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
      assert.deepEqual(bot.receipts, [{ content: 'hello', metadata: {
        source: 'weixin', messageId: 'wx-msg-1', senderId: 'shared', attachments: [],
      } }]);
      assert.deepEqual(bot.handledTurns[0].options.transcriptInputIds, ['receipt-1']);
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
      assert.deepEqual(bot.messageQueue.get(sessionKey)[0].transcriptInputIds, ['receipt-1']);
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);

      assert.deepEqual(bot.createdSessions, [sessionKey, sessionKey]);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.channel.chatId, 'shared');
      assert.equal(bot.handledTurns[0].options.executionScope.topicId, 'shared');
      assert.equal(bot.receipts.length, 1, 'draining must reuse the arrival receipt');
      assert.deepEqual(bot.handledTurns[0].options.transcriptInputIds, ['receipt-1']);
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:weixin:p2p:shared');
    }
  });

  test('delivers classified failed replies without relying on the legacy fallback text', async () => {
    const sentTexts: Array<{ userId: string; text: string; contextToken?: string; fromUserId?: string }> = [];
    const bot = createHarness({
      sentTexts,
      parsed: {
        message_id: 'wx-msg-error',
        from: { id: 'shared' },
        chat: { id: 'wx-bot' },
        text: '继续',
        context_token: 'ctx-token',
      },
    });
    bot.sessionResult = {
      visibleToUser: true,
      text: '模型响应超时，本轮上下文已保留，请稍后继续。',
      taskOutcome: 'failed',
    };

    try {
      await (bot as any).handleMessage({
        message_type: 0,
        message_id: 'wx-msg-error',
        from_user_id: 'shared',
        to_user_id: 'wx-bot',
        context_token: 'ctx-token',
      });

      assert.deepEqual(sentTexts, [
        {
          userId: 'shared',
          text: '模型响应超时，本轮上下文已保留，请稍后继续。',
          contextToken: 'ctx-token',
          fromUserId: 'wx-bot',
        },
      ]);
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
  bot.receipts = [] as any[];
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
    recordInputReceipt: (content: unknown, metadata: unknown) => {
      bot.receipts.push({ content, metadata });
      return `receipt-${bot.receipts.length}`;
    },
    isBusy: () => bot.sessionBusy,
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
    sendText: async (userId: string, text: string, contextToken?: string, fromUserId?: string) => {
      options.sentTexts?.push({ userId, text, contextToken, fromUserId });
    },
    sendFile: async () => undefined,
  };
  return bot;
}

test('Weixin receipts precede media failure and exclude encrypted transport credentials', async () => {
  const text = `  original\n${'detail '.repeat(2000)}  `;
  const bot = createHarness({ parsed: {
    message_id: 'media-1', from: { id: 'shared' }, chat: { id: 'wx-bot' }, text,
    item_list: [
      { type: 2, image_item: { media: { encrypt_query_param: 'image-ref', aes_key: 'never-log-this-key' } } },
      { type: 4, file_item: { file_name: 'source.txt', media: { encrypt_query_param: 'file-ref', aes_key: 'never-log-this-key' } } },
    ],
  } });
  bot.handler.downloadMedia = async () => {
    assert.equal(bot.receipts.length, 1);
    return [];
  };
  try {
    await bot.handleMessage({ message_type: 0, from_user_id: 'shared' });
    assert.deepEqual(bot.receipts, [{ content: text, metadata: {
      source: 'weixin', messageId: 'media-1', senderId: 'shared', attachments: [
        { name: 'image', type: 'image', url: undefined },
        { name: 'source.txt', type: 'file' },
      ],
    } }]);
    assert.deepEqual(bot.handledTurns[0].options.transcriptInputIds, ['receipt-1']);
    assert.equal(JSON.stringify(bot.receipts).includes('never-log-this-key'), false);
    assert.equal(JSON.stringify(bot.receipts).includes('image-ref'), false);
    assert.equal(JSON.stringify(bot.receipts).includes('file-ref'), false);
  } finally {
    SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:weixin:p2p:shared');
  }
});

test('Weixin subagent feedback does not create a user receipt', async () => {
  const bot = createHarness({ busy: true, parsed: {} });
  const key = 'session:v2:weixin:p2p:shared';
  await bot.handleSubAgentFeedback(key, 'shared', 'shared', '[子agent1 已完成]\n结果摘要：done');
  bot.sessionBusy = false;
  await bot.drainMessageQueue(key);
  assert.equal(bot.receipts.length, 0);
  assert.equal(bot.handledTurns[0].options.source, 'subagent_result');
});

test('Weixin records accepted input before a context-token save can fail', async () => {
  const bot = createHarness({ parsed: {
    message_id: 'state-failure', from: { id: 'shared' }, chat: { id: 'wx-bot' }, text: 'keep accepted input',
  } });
  bot.saveState = async () => {
    assert.equal(bot.receipts.length, 1, 'receipt must precede the first state await');
    throw new Error('synthetic state failure');
  };
  await assert.rejects(bot.handleMessage({ message_type: 0, from_user_id: 'shared', context_token: 'reply-token' }),
    /synthetic state failure/);
  assert.equal(bot.receipts[0].content, 'keep accepted input');
  assert.equal(bot.contextTokens.get('session:v2:weixin:p2p:shared'), 'reply-token');
  assert.equal(JSON.stringify(bot.receipts).includes('reply-token'), false);
  assert.equal(bot.handledTurns.length, 0);
});

for (const dispatchFails of [false, true]) {
  test(`Weixin ${dispatchFails ? 'retains' : 'advances'} its durable cursor ${dispatchFails ? 'when dispatch fails' : 'after batch receipts'}`, async t => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-receipt-cursor-'));
    const key = 'session:v2:weixin:p2p:shared';
    const bot = createHarness({ busy: true, parsed: {} });
    bot.config = { baseUrl: 'https://weixin.example.test', token: 'synthetic-poll-token' };
    bot.stateDir = stateDir;
    bot.getUpdatesBuf = 'previous-cursor';
    bot.isRunning = true;
    const snapshots: Array<{ cursor: string; receipts: number; token: string }> = [];
    bot.handler.parseMessage = (raw: any) => ({
      message_id: raw.message_id, from: { id: 'shared' }, chat: { id: 'wx-bot' }, text: raw.message_id,
    });
    bot.saveState = async () => {
      await (WeixinBot.prototype as any).saveState.call(bot);
      snapshots.push({
        cursor: fs.readFileSync(path.join(stateDir, 'get_updates.buf'), 'utf8'),
        receipts: bot.receipts.length,
        token: JSON.parse(fs.readFileSync(path.join(stateDir, 'context_tokens.json'), 'utf8'))[key],
      });
    };
    bot.handler.downloadMedia = async (parsed: any) => {
      assert.equal(fs.readFileSync(path.join(stateDir, 'get_updates.buf'), 'utf8'), 'previous-cursor');
      assert.equal(bot.contextTokens.get(key), `reply-${parsed.message_id}`);
      if (parsed.message_id === 'second') {
        bot.isRunning = false;
        if (dispatchFails) throw Object.assign(new Error('synthetic dispatch failure'), { code: 'ECONNABORTED' });
      }
      return [];
    };
    t.mock.method(axios, 'post', async (_url: string, body: any) => {
      assert.equal(body.get_updates_buf, 'previous-cursor');
      return { data: { msgs: [
        { message_type: 0, from_user_id: 'shared', message_id: 'first', context_token: 'reply-first' },
        { message_type: 2, from_user_id: 'shared', message_id: 'outbound-echo' },
        { message_type: 1, from_user_id: 'shared', message_id: 'second', context_token: 'reply-second' },
      ], get_updates_buf: 'next-cursor' } };
    });
    try {
      await bot.poll();
      assert.deepEqual(snapshots, [
        { cursor: 'previous-cursor', receipts: 1, token: 'reply-first' },
        { cursor: 'previous-cursor', receipts: 2, token: 'reply-second' },
        ...(!dispatchFails ? [{ cursor: 'next-cursor', receipts: 2, token: 'reply-second' }] : []),
      ]);
      assert.equal(bot.getUpdatesBuf, dispatchFails ? 'previous-cursor' : 'next-cursor');
      assert.deepEqual(bot.receipts.map((receipt: any) => receipt.content), ['first', 'second']);
      assert.equal(JSON.stringify(bot.receipts).includes('reply-'), false);
      assert.deepEqual(bot.messageQueue.get(key).map((item: any) => item.transcriptInputIds),
        dispatchFails ? [['receipt-1']] : [['receipt-1'], ['receipt-2']]);
      assert.equal(bot.handledTurns.length, 0, 'synthetic busy sessions must never call a model');
    } finally {
      SubAgentManager.getInstance().unregisterPlatformCallbacks(key);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

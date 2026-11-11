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
      assert.deepEqual(bot.receipts, [{ content: 'hello', metadata: {
        source: 'feishu', messageId: 'msg-1', senderId: 'shared', attachments: undefined,
      } }]);
      assert.deepEqual(bot.handledTurns[0].options.transcriptInputIds, ['receipt-1']);
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
      assert.deepEqual(bot.messageQueue.get(sessionKey)[0].transcriptInputIds, ['receipt-1']);
      bot.sessionBusy = false;
      await (bot as any).drainMessageQueue(sessionKey);

      assert.deepEqual(bot.createdSessions, [sessionKey, sessionKey]);
      assert.equal(bot.handledTurns.length, 1);
      assert.equal(bot.handledTurns[0].options.channel.chatId, 'oc_group');
      assert.equal(bot.handledTurns[0].options.sessionRoute.sessionKey, sessionKey);
      assert.equal(bot.handledTurns[0].options.executionScope.topicType, 'group');
      assert.equal(bot.handledTurns[0].options.executionScope.actorUserId, 'ou_user');
      assert.equal(bot.receipts.length, 1, 'draining must reuse the arrival receipt');
      assert.deepEqual(bot.handledTurns[0].options.transcriptInputIds, ['receipt-1']);
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
  bot.receipts = [] as any[];
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
    recordInputReceipt: (content: unknown, metadata: unknown) => {
      bot.receipts.push({ content, metadata });
      return `receipt-${bot.receipts.length}`;
    },
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

test('Feishu receipts preserve original event text and file references before download failure', async () => {
  const text = `  @_user_1 original\n${'detail '.repeat(2000)}  `;
  const bot = createHarness({ message: {
    messageId: 'file-1', chatId: 'shared', chatType: 'p2p', senderId: 'shared',
    text: 'parsed text', msgType: 'file', file: { fileName: 'source.txt', fileKey: 'file-ref', type: 'file' },
  } });
  bot.sender.downloadFile = async () => {
    assert.equal(bot.receipts.length, 1);
    return null;
  };
  try {
    await bot.onMessage({ message: { content: JSON.stringify({ text }) } });
    assert.deepEqual(bot.receipts, [{ content: text, metadata: {
      source: 'feishu', messageId: 'file-1', senderId: 'shared',
      attachments: [{ name: 'source.txt', type: 'file', reference: 'file-ref' }],
    } }]);
    assert.deepEqual(bot.handledTurns[0].options.transcriptInputIds, ['receipt-1']);
    assert.match(bot.handledTurns[0].userText, /未能下载/);
    await bot.onMessage({});
    assert.equal(bot.receipts.length, 1, 'duplicate source messages must stay filtered');
  } finally {
    SubAgentManager.getInstance().unregisterPlatformCallbacks('session:v2:feishu:p2p:shared');
  }
});

test('Feishu records intercepted question answers with a distinct source and no model turn', async () => {
  const bot = createHarness({ message: {
    messageId: 'answer-1', chatId: 'shared', chatType: 'p2p', senderId: 'shared', text: 'answer', msgType: 'text',
  } });
  const key = 'session:v2:feishu:p2p:shared';
  let answer: string | undefined;
  bot.pendingAnswerBySession.set(key, 'pending-1');
  bot.pendingAnswers.set('pending-1', {
    id: 'pending-1', sessionKey: key, chatId: 'shared', expectedSenderId: 'shared',
    resolve: (text: string) => { answer = text; },
  });
  await bot.onMessage({});
  assert.equal(answer, 'answer');
  assert.equal(bot.receipts[0].metadata.source, 'feishu.ask_question.answer');
  assert.equal(bot.receipts[0].metadata.messageId, 'answer-1');
  assert.equal(bot.handledTurns.length, 0);
});

test('Feishu subagent feedback does not create a user receipt', async () => {
  const bot = createHarness({ busy: true, message: {} });
  const key = 'session:v2:feishu:p2p:shared';
  await bot.handleSubAgentFeedback(key, 'shared', 'shared', '[子agent1 已完成]\n结果摘要：done');
  bot.sessionBusy = false;
  await bot.drainMessageQueue(key);
  assert.equal(bot.receipts.length, 0);
  assert.equal(bot.handledTurns[0].options.source, 'subagent_result');
});

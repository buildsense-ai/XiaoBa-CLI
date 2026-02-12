import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuBot } from '../src/feishu';
import { BUSY_MESSAGE } from '../src/core/agent-session';

test('feishu pending answer only accepts expected sender', async () => {
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.processedMsgIds = new Set<string>();
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.pendingAttachments = new Map();
  bot.sessionManager = {
    getSessionKey: (msg: any) => `group:${msg.chatId}`,
  };

  let resolved = '';
  bot.registerPendingAnswer('group:chat-1', 'chat-1', 'user-a', (text: string) => {
    resolved = text;
  });

  const queue = [
    {
      messageId: 'msg-1',
      chatId: 'chat-1',
      chatType: 'group',
      senderId: 'user-b',
      text: '抢答',
      mentionBot: false,
      msgType: 'text',
    },
    {
      messageId: 'msg-2',
      chatId: 'chat-1',
      chatType: 'group',
      senderId: 'user-a',
      text: '正确回答',
      mentionBot: false,
      msgType: 'text',
    },
  ];

  bot.handler = {
    parse: () => queue.shift() ?? null,
  };

  await bot.onMessage({});
  assert.equal(resolved, '');
  assert.equal(bot.pendingAnswerBySession.has('group:chat-1'), true);

  await bot.onMessage({});
  assert.equal(resolved, '正确回答');
  assert.equal(bot.pendingAnswerBySession.has('group:chat-1'), false);
});

test('feishu forwards busy message to user in tool-only mode', async () => {
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.processedMsgIds = new Set<string>();
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.pendingAttachments = new Map();

  const replies: string[] = [];
  bot.sender = {
    reply: async (_chatId: string, text: string) => {
      replies.push(text);
    },
    sendFile: async () => {},
    downloadFile: async () => null,
  };
  bot.handler = {
    parse: () => ({
      messageId: 'msg-3',
      chatId: 'chat-2',
      chatType: 'p2p',
      senderId: 'user-c',
      text: 'hello',
      mentionBot: false,
      msgType: 'text',
    }),
  };
  bot.sessionManager = {
    getSessionKey: () => 'user:user-c',
    getOrCreate: () => ({
      handleCommand: async () => ({ handled: false }),
      handleMessage: async () => BUSY_MESSAGE,
    }),
  };
  bot.feishuReplyTool = {
    bindSession: () => {},
    unbindSession: () => {},
  };
  bot.feishuSendFileTool = {
    bindSession: () => {},
    unbindSession: () => {},
  };
  bot.askUserQuestionTool = null;

  await bot.onMessage({});
  assert.deepEqual(replies, [BUSY_MESSAGE]);
});

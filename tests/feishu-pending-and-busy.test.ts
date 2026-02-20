import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuBot } from '../src/feishu';

test('feishu silently enqueues messages when busy (no reply)', async () => {
  const enqueuedTexts: string[] = [];
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.processedMsgIds = new Set<string>();
  bot.pendingAttachments = new Map();
  bot.sessionManager = {
    getSessionKey: (msg: any) => `group:${msg.chatId}`,
    getOrCreate: () => ({
      isBusy: () => true,
      enqueue: (text: string) => { enqueuedTexts.push(text); },
      getQueueLength: () => enqueuedTexts.length,
      handleCommand: async () => ({ handled: false }),
      handleMessage: async () => 'reply',
    }),
  };

  const replies: string[] = [];
  bot.sender = {
    reply: async (_chatId: string, text: string) => { replies.push(text); },
    sendFile: async () => {},
    downloadFile: async () => null,
  };
  bot.handler = {
    parse: () => ({
      messageId: 'msg-1',
      chatId: 'chat-1',
      chatType: 'group',
      senderId: 'user-a',
      text: '第一条消息',
      mentionBot: true,
      msgType: 'text',
    }),
  };

  await bot.onMessage({});

  // 静默入队，不回复任何内容
  assert.equal(replies.length, 0, `不应有回复，实际: ${replies.length}`);
  assert.equal(enqueuedTexts.length, 1, '应入队 1 条消息');
  assert.equal(enqueuedTexts[0], '第一条消息');
});

test('feishu forwards busy message to user in tool-only mode', async () => {
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.processedMsgIds = new Set<string>();
  bot.pendingAttachments = new Map();

  const replies: string[] = [];
  bot.sender = {
    reply: async (_chatId: string, text: string) => { replies.push(text); },
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
      isBusy: () => false,
      enqueue: () => {},
      getQueueLength: () => 0,
      handleCommand: async () => ({ handled: false }),
      handleMessage: async () => 'API 暂时限流，本轮处理已中止，请稍后再试。',
    }),
  };
  bot.sendMessageTool = { bindSession: () => {}, unbindSession: () => {} };
  bot.sendFileTool = { bindSession: () => {}, unbindSession: () => {} };

  await bot.onMessage({});

  assert.equal(replies.length, 1, `应该有一条回复，实际: ${replies.length}`);
  assert.ok(replies[0].includes('限流'), `应该包含"限流"，实际: ${replies[0]}`);
});

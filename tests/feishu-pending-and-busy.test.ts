import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuBot } from '../src/feishu';

test('feishu enqueues messages when busy and processes after completion', async () => {
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.processedMsgIds = new Set<string>();
  bot.pendingMessages = new Map();
  bot.pendingAttachments = new Map();
  bot.sessionManager = {
    getSessionKey: (msg: any) => `group:${msg.chatId}`,
    getOrCreate: () => ({
      isBusy: () => true,  // 模拟 busy 状态
      handleCommand: async () => ({ handled: false }),
      handleMessage: async () => 'reply',
    }),
  };

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
      messageId: 'msg-1',
      chatId: 'chat-1',
      chatType: 'group',
      senderId: 'user-a',
      text: '第一条消息',
      mentionBot: true,  // 群聊需要 @机器人
      msgType: 'text',
    }),
  };

  await bot.onMessage({});

  // busy 时应该入队并回复"收到"
  assert.equal(replies.length, 1, `应该有一条回复，实际: ${replies.length}`);
  assert.ok(replies[0].includes('收到'), `应该回复"收到"，实际: ${replies[0]}`);

  // 消息应该在队列中
  const pending = bot.pendingMessages.get('group:chat-1');
  assert.ok(pending, '消息应该入队');
  assert.equal(pending.texts.length, 1);
  assert.equal(pending.texts[0], '第一条消息');
});

test('feishu forwards busy message to user in tool-only mode', async () => {
  const bot = Object.create(FeishuBot.prototype) as any;
  bot.processedMsgIds = new Set<string>();
  bot.pendingMessages = new Map();
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
      isBusy: () => false,
      handleCommand: async () => ({ handled: false }),
      // 返回 429 限流消息
      handleMessage: async () => 'API 暂时限流，本轮处理已中止，请稍后再试。',
    }),
  };
  bot.sendMessageTool = {
    bindSession: () => {},
    unbindSession: () => {},
  };
  bot.sendFileTool = {
    bindSession: () => {},
    unbindSession: () => {},
  };

  await bot.onMessage({});

  // 应该收到限流回复
  assert.equal(replies.length, 1, `应该有一条回复，实际: ${replies.length}`);
  assert.ok(replies[0].includes('限流'), `应该包含"限流"，实际: ${replies[0]}`);
});

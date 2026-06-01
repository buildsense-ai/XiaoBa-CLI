import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';

function createProcessHarness() {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const downloads: Array<{ url: string; fileName: string }> = [];
  const multimodalCalls: Array<{ text: string; attachments: any[] }> = [];
  const handledTurns: Array<{ userMessage: any; options: any }> = [];
  const runtimeObservations: Array<{ text: string; options: any }> = [];
  const sentTexts: Array<{ topic: string; text: string }> = [];
  const replies: Array<{ topic: string; text: string }> = [];
  const sentThinking: Array<{ text: string; metadata?: any }> = [];
  const toolUses: Array<{ topic: string; toolUseId: string; name: string; input: any; metadata?: any }> = [];
  const toolResults: Array<{ topic: string; toolUseId: string; content: string; isError?: boolean; metadata?: any }> = [];

  const session = {
    isBusy: () => false,
    handleMessage: async (userMessage: any, options: any) => {
      handledTurns.push({ userMessage, options });
      return { visibleToUser: false, text: '' };
    },
    handleRuntimeObservation: async (text: string, options: any) => {
      runtimeObservations.push({ text, options });
      return { visibleToUser: false, text: '' };
    },
  };

  bot.sessionManager = {
    getOrCreate: () => session,
    get: () => session,
  };
  bot.sender = {
    downloadFile: async (url: string, fileName: string) => {
      downloads.push({ url, fileName });
      return `C:\\tmp\\catsco-test\\${fileName}`;
    },
    sendTyping: () => undefined,
    reply: async (topic: string, text: string) => {
      replies.push({ topic, text });
    },
    sendFile: async () => undefined,
    sendText: async (topic: string, text: string) => {
      sentTexts.push({ topic, text });
    },
    sendThinking: async (_topic: string, text: string, metadata?: any) => {
      sentThinking.push({ text, metadata });
    },
    sendToolUse: async (topic: string, toolUseId: string, name: string, input: any, metadata?: any) => {
      toolUses.push({ topic, toolUseId, name, input, metadata });
    },
    sendToolResult: async (topic: string, toolUseId: string, content: string, isError?: boolean, metadata?: any) => {
      toolResults.push({ topic, toolUseId, content, isError, metadata });
    },
  };
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.buildMultimodalMessage = async (text: string, attachments: any[]) => {
    multimodalCalls.push({ text, attachments });
    return [
      { type: 'text', text },
      ...attachments.map((attachment) => ({
        type: 'text',
        text: `[${attachment.type}] ${attachment.fileName} -> ${attachment.localPath}`,
      })),
    ];
  };

  return { bot, downloads, multimodalCalls, handledTurns, runtimeObservations, sentTexts, replies, sentThinking, toolUses, toolResults, session };
}

describe('CatsCo content blocks', () => {
  test('parses text and multiple attachments from one CatsCompany message', () => {
    const bot = Object.create(CatsCompanyBot.prototype);

    const parsed = (bot as any).parseMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '帮我一起看这两张图',
      content: '帮我一起看这两张图',
      content_blocks: [
        { type: 'text', text: '帮我一起看这两张图' },
        { type: 'image', payload: { url: '/uploads/images/a.png', name: 'a.png', size: 12 } },
        { type: 'file', payload: { url: '/uploads/files/b.pdf', name: 'b.pdf', size: 34 } },
      ],
      isGroup: false,
      seq: 7,
    });

    assert.ok(parsed);
    assert.strictEqual(parsed.text, '帮我一起看这两张图');
    assert.strictEqual(parsed.files.length, 2);
    assert.deepStrictEqual(parsed.files.map((file: any) => file.type), ['image', 'file']);
    assert.deepStrictEqual(parsed.files.map((file: any) => file.fileName), ['a.png', 'b.pdf']);
  });

  test('deduplicates attachments when content_blocks and legacy rich content overlap', () => {
    const bot = Object.create(CatsCompanyBot.prototype);

    const parsed = (bot as any).parseMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '帮我看这两张图',
      content: {
        type: 'image',
        payload: { url: '/uploads/images/a.png', name: 'a.png', size: 12 },
      },
      content_blocks: [
        { type: 'text', text: '帮我看这两张图' },
        { type: 'image', payload: { url: '/uploads/images/a.png', name: 'a.png', size: 12 } },
        { type: 'image', payload: { url: '/uploads/images/b.png', name: 'b.png', size: 34 } },
      ],
      isGroup: false,
      seq: 8,
    });

    assert.ok(parsed);
    assert.strictEqual(parsed.text, '帮我看这两张图');
    assert.strictEqual(parsed.files.length, 2);
    assert.deepStrictEqual(parsed.files.map((file: any) => file.type), ['image', 'image']);
    assert.deepStrictEqual(parsed.files.map((file: any) => file.fileName), ['a.png', 'b.png']);
    assert.deepStrictEqual(parsed.files.map((file: any) => file.url), ['/uploads/images/a.png', '/uploads/images/b.png']);
  });

  test('prefers content block text over top-level attachment summary', () => {
    const bot = Object.create(CatsCompanyBot.prototype);

    const parsed = (bot as any).parseMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '[图片] crack.png',
      content: '[图片] crack.png',
      content_blocks: [
        { type: 'text', text: '帮我分析这张图里的裂缝' },
        { type: 'image', payload: { url: '/uploads/images/crack.png', name: 'crack.png', size: 12 } },
      ],
      isGroup: false,
      seq: 9,
    });

    assert.ok(parsed);
    assert.strictEqual(parsed.text, '帮我分析这张图里的裂缝');
    assert.strictEqual(parsed.files.length, 1);
    assert.strictEqual(parsed.files[0].fileName, 'crack.png');
  });

  test('processes multiple attachments as one user turn', async () => {
    const { bot, downloads, multimodalCalls, handledTurns } = createProcessHarness();

    await bot.processParsedMessage({
      topic: 'p2p_1_2',
      chatType: 'p2p',
      senderId: 'usr1',
      seq: 9,
      text: '一起看这些附件',
      rawContent: '一起看这些附件',
      file: { url: '/uploads/images/a.png', fileName: 'a.png', type: 'image' },
      files: [
        { url: '/uploads/images/a.png', fileName: 'a.png', type: 'image' },
        { url: '/uploads/images/c.png', fileName: 'c.png', type: 'image' },
        { url: '/uploads/files/b.pdf', fileName: 'b.pdf', type: 'file' },
      ],
    }, 'cc_user:usr1');

    assert.deepStrictEqual(downloads, [
      { url: '/uploads/images/a.png', fileName: 'a.png' },
      { url: '/uploads/images/c.png', fileName: 'c.png' },
      { url: '/uploads/files/b.pdf', fileName: 'b.pdf' },
    ]);
    assert.strictEqual(multimodalCalls.length, 1);
    assert.strictEqual(multimodalCalls[0].text, '一起看这些附件');
    assert.deepStrictEqual(
      multimodalCalls[0].attachments.map((attachment) => ({
        fileName: attachment.fileName,
        localPath: attachment.localPath,
        type: attachment.type,
      })),
      [
        { fileName: 'a.png', localPath: 'C:\\tmp\\catsco-test\\a.png', type: 'image' },
        { fileName: 'c.png', localPath: 'C:\\tmp\\catsco-test\\c.png', type: 'image' },
        { fileName: 'b.pdf', localPath: 'C:\\tmp\\catsco-test\\b.pdf', type: 'file' },
      ],
    );
    assert.strictEqual(handledTurns.length, 1);
    assert.deepStrictEqual(handledTurns[0].userMessage, [
      { type: 'text', text: '一起看这些附件' },
      { type: 'text', text: '[image] a.png -> C:\\tmp\\catsco-test\\a.png' },
      { type: 'text', text: '[image] c.png -> C:\\tmp\\catsco-test\\c.png' },
      { type: 'text', text: '[file] b.pdf -> C:\\tmp\\catsco-test\\b.pdf' },
    ]);
    assert.deepStrictEqual(handledTurns[0].options.runtimeFeedback, []);
  });

  test('processes CatsCompany websocket content_blocks as one user turn', async () => {
    const { bot, downloads, multimodalCalls, handledTurns } = createProcessHarness();

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '[附件] a.png, b.pdf',
      content: '[附件] a.png, b.pdf',
      content_blocks: [
        { type: 'text', text: '非 Dashboard 入口一起看这些附件' },
        { type: 'image', payload: { url: '/uploads/images/a.png', name: 'a.png', size: 12 } },
        { type: 'file', payload: { url: '/uploads/files/b.pdf', name: 'b.pdf', size: 34 } },
      ],
      isGroup: false,
      seq: 10,
    });

    assert.deepStrictEqual(downloads, [
      { url: '/uploads/images/a.png', fileName: 'a.png' },
      { url: '/uploads/files/b.pdf', fileName: 'b.pdf' },
    ]);
    assert.strictEqual(multimodalCalls.length, 1);
    assert.strictEqual(multimodalCalls[0].text, '非 Dashboard 入口一起看这些附件');
    assert.deepStrictEqual(
      multimodalCalls[0].attachments.map((attachment) => ({
        fileName: attachment.fileName,
        localPath: attachment.localPath,
        type: attachment.type,
      })),
      [
        { fileName: 'a.png', localPath: 'C:\\tmp\\catsco-test\\a.png', type: 'image' },
        { fileName: 'b.pdf', localPath: 'C:\\tmp\\catsco-test\\b.pdf', type: 'file' },
      ],
    );
    assert.strictEqual(handledTurns.length, 1);
    assert.deepStrictEqual(handledTurns[0].userMessage, [
      { type: 'text', text: '非 Dashboard 入口一起看这些附件' },
      { type: 'text', text: '[image] a.png -> C:\\tmp\\catsco-test\\a.png' },
      { type: 'text', text: '[file] b.pdf -> C:\\tmp\\catsco-test\\b.pdf' },
    ]);
  });

  test('plain text messages are processed immediately without attachment coalesce wait', async () => {
    const { bot, handledTurns } = createProcessHarness();

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '这条纯文本不应该等待附件',
      content: '这条纯文本不应该等待附件',
      isGroup: false,
      seq: 10,
    });

    assert.strictEqual(handledTurns.length, 1);
    assert.strictEqual(handledTurns[0].userMessage, '这条纯文本不应该等待附件');
  });

  test('channel sendFile propagates upload failures to tool execution', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.sender = {
      sendFile: async () => {
        throw new Error('Upload failed: 400 - {"error":"file type not allowed"}');
      },
    };

    const channel = bot.buildChannel('p2p_1_2');

    await assert.rejects(
      () => channel.sendFile('p2p_1_2', 'C:\\tmp\\resume.html', 'resume.html'),
      /file type not allowed/,
    );
    assert.strictEqual(channel.hasOutbound, false);
  });

  test('interrupts active session on CatsCompany stream cancel event', () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    let interrupted = 0;
    bot.sessionManager = {
      get: (key: string) => key === 'cc_user:usr1'
        ? {
          requestInterrupt: () => {
            interrupted += 1;
          },
        }
        : null,
    };

    bot.handleCancelMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '',
      content: '',
      type: 'stream_cancel',
      metadata: { stream_event: 'cancel', control: 'interrupt' },
      isGroup: false,
      seq: 0,
    });

    assert.strictEqual(interrupted, 1);
  });

  test('subagent runtime events are sent as CatsCompany working metadata', async () => {
    const { bot, sentThinking, toolUses, toolResults } = createProcessHarness();
    const now = Date.now();
    const info = {
      id: 'sub-1',
      skillName: 'explorer',
      taskDescription: '扫描登录链路',
      status: 'running',
      createdAt: now,
      progressLog: [],
      outputFiles: [],
    };

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_spawned',
      timestamp: now,
      summary: '派遣子agent1 扫描登录链路',
    }, info);

    assert.strictEqual(toolUses.length, 1);
    assert.strictEqual(toolUses[0].toolUseId, 'subagent:sub-1');
    assert.strictEqual(toolUses[0].name, '子agent1');
    assert.strictEqual(toolUses[0].input.kind, 'subagent');
    assert.strictEqual(toolUses[0].metadata.kind, 'subagent_event');
    assert.strictEqual(toolUses[0].metadata.subagent_event_type, 'agent_spawned');

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_progress',
      timestamp: now,
      summary: '开始执行：扫描登录链路',
    }, info);

    assert.deepStrictEqual(sentThinking.map(item => item.text), ['[子agent1] 开始执行：扫描登录链路']);
    assert.strictEqual(sentThinking[0].metadata.kind, 'subagent_event');

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_waiting',
      timestamp: now,
      summary: '等待主 agent 回复：需要确认范围',
    }, info);

    assert.deepStrictEqual(sentThinking.map(item => item.text), ['[子agent1] 开始执行：扫描登录链路']);

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_completed',
      timestamp: now + 1,
      summary: '完成',
    }, {
      ...info,
      status: 'completed',
      resultSummary: '登录链路正常',
      outputFiles: ['logs/report.md'],
    });

    assert.strictEqual(toolResults.length, 1);
    assert.strictEqual(toolResults[0].toolUseId, 'subagent:sub-1');
    assert.strictEqual(toolResults[0].metadata.kind, 'subagent_event');
    assert.strictEqual(toolResults[0].metadata.subagent_event_type, 'agent_completed');
    assert.match(toolResults[0].content, /已完成/);
    assert.match(toolResults[0].content, /登录链路正常/);
    assert.match(toolResults[0].content, /logs\/report\.md/);
  });

  test('subagent feedback visible reply is sent back to CatsCompany', async () => {
    const { bot, runtimeObservations, sentTexts, session } = createProcessHarness();
    session.handleRuntimeObservation = async (text: string, options: any) => {
      runtimeObservations.push({ text, options });
      return { visibleToUser: true, text: '已根据子 agent 结果处理完。' };
    };

    await (bot as any).handleSubAgentFeedback(
      'cc_user:usr38',
      'p2p_38_110',
      'usr38',
      '[子agent1 已完成]\n结果摘要：审查完成',
    );

    assert.strictEqual(runtimeObservations.length, 1);
    assert.strictEqual(runtimeObservations[0].options.source, 'subagent_result');
    assert.deepStrictEqual(sentTexts, [
      { topic: 'p2p_38_110', text: '已根据子 agent 结果处理完。' },
    ]);
  });

  test('queued subagent error reply is not sent twice', async () => {
    const { bot, sentTexts, replies, session } = createProcessHarness();
    session.handleRuntimeObservation = async () => ({
      visibleToUser: true,
      text: '处理消息时出错: 子 agent 结果处理失败',
    });
    bot.messageQueue.set('cc_user:usr38', [{
      userMessage: '[子agent1 已完成]\n结果摘要：审查完成',
      topic: 'p2p_38_110',
      senderId: 'usr38',
      seq: 0,
      receivedAt: Date.now(),
      source: 'subagent_feedback',
    }]);

    await (bot as any).drainMessageQueue('cc_user:usr38');

    assert.deepStrictEqual(sentTexts, []);
    assert.deepStrictEqual(replies, [
      { topic: 'p2p_38_110', text: '处理消息时出错: 子 agent 结果处理失败' },
    ]);
  });
});

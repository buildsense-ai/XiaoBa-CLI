import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';

function createProcessHarness() {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const downloads: Array<{ url: string; fileName: string }> = [];
  const multimodalCalls: Array<{ text: string; attachments: any[] }> = [];
  const handledTurns: Array<{ userMessage: any; options: any; kind?: string }> = [];
  const sentTexts: string[] = [];
  const sentThinking: Array<{ text: string; metadata?: any }> = [];
  const toolUses: Array<{ topic: string; toolUseId: string; name: string; input: any }> = [];
  const toolResults: Array<{ topic: string; toolUseId: string; content: string; isError?: boolean; metadata?: any }> = [];

  const session = {
    isBusy: () => false,
    handleMessage: async (userMessage: any, options: any) => {
      handledTurns.push({ userMessage, options, kind: 'message' });
      return { visibleToUser: false, text: '' };
    },
    handleRuntimeObservation: async (userMessage: any, options: any) => {
      handledTurns.push({ userMessage, options, kind: 'runtime_observation' });
      return { visibleToUser: false, text: '' };
    },
  };

  bot.sessionManager = {
    getOrCreate: () => session,
  };
  bot.sender = {
    downloadFile: async (url: string, fileName: string) => {
      downloads.push({ url, fileName });
      return `C:\\tmp\\catsco-test\\${fileName}`;
    },
    sendTyping: () => undefined,
    reply: async () => undefined,
    sendFile: async () => undefined,
    sendText: async (_topic: string, text: string) => {
      sentTexts.push(text);
    },
    sendThinking: async (_topic: string, text: string, metadata?: any) => {
      sentThinking.push({ text, metadata });
    },
    sendToolUse: async (topic: string, toolUseId: string, name: string, input: any) => {
      toolUses.push({ topic, toolUseId, name, input });
    },
    sendToolResult: async (topic: string, toolUseId: string, content: string, isError?: boolean, metadata?: any) => {
      toolResults.push({ topic, toolUseId, content, isError, metadata });
    },
  };
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.pendingAttachments = new Map();
  bot.pendingTextMessages = new Map();
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

  return { bot, downloads, multimodalCalls, handledTurns, sentTexts, sentThinking, toolUses, toolResults };
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

  test('interrupts active session on CatsCompany stream cancel event', () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    let interrupted = 0;
    const session = {
      isBusy: () => true,
      requestInterrupt: () => {
        interrupted += 1;
      },
    };

    bot.sessionManager = {
      get: (key: string) => key === 'cc_user:usr1' ? session : null,
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

  test('subagent feedback wakeup sends visible main-agent reply', async () => {
    const { bot, sentTexts, handledTurns } = createProcessHarness();
    const session = {
      isBusy: () => false,
      handleMessage: async (userMessage: any, options: any) => {
        handledTurns.push({ userMessage, options, kind: 'message' });
        return { visibleToUser: true, text: '我已经整理好子 agent 的结果。' };
      },
      handleRuntimeObservation: async (userMessage: any, options: any) => {
        handledTurns.push({ userMessage, options, kind: 'runtime_observation' });
        return { visibleToUser: true, text: '我已经整理好子 agent 的结果。' };
      },
    };
    bot.sessionManager = {
      getOrCreate: () => session,
    };

    await bot.handleSubAgentFeedback(
      'cc_user:usr1',
      'p2p_1_2',
      'usr1',
      '[子agent1 已完成]\n结果：done',
    );

    assert.strictEqual(handledTurns.length, 1);
    assert.strictEqual(handledTurns[0].userMessage, '[子agent1 已完成]\n结果：done');
    assert.strictEqual(handledTurns[0].kind, 'runtime_observation');
    assert.strictEqual(handledTurns[0].options.source, 'subagent_result');
    assert.deepStrictEqual(sentTexts, ['我已经整理好子 agent 的结果。']);
  });

  test('subagent feedback queues while main session is busy and drains later', async () => {
    const { bot, sentTexts, handledTurns } = createProcessHarness();
    let busy = true;
    const session = {
      isBusy: () => busy,
      handleMessage: async (userMessage: any, options: any) => {
        handledTurns.push({ userMessage, options, kind: 'message' });
        return { visibleToUser: true, text: '已接上后台结果。' };
      },
      handleRuntimeObservation: async (userMessage: any, options: any) => {
        handledTurns.push({ userMessage, options, kind: 'runtime_observation' });
        return { visibleToUser: true, text: '已接上后台结果。' };
      },
    };
    bot.sessionManager = {
      getOrCreate: () => session,
    };

    await bot.handleSubAgentFeedback(
      'cc_user:usr1',
      'p2p_1_2',
      'usr1',
      '[子agent1 已完成]\n结果：done',
    );

    assert.strictEqual(handledTurns.length, 0);
    assert.strictEqual(bot.messageQueue.get('cc_user:usr1').length, 1);
    assert.strictEqual(bot.messageQueue.get('cc_user:usr1')[0].source, 'subagent_feedback');

    busy = false;
    await bot.drainMessageQueue('cc_user:usr1');

    assert.strictEqual(handledTurns.length, 1);
    assert.strictEqual(handledTurns[0].userMessage, '[子agent1 已完成]\n结果：done');
    assert.strictEqual(handledTurns[0].kind, 'runtime_observation');
    assert.strictEqual(handledTurns[0].options.source, 'subagent_result');
    assert.deepStrictEqual(sentTexts, ['已接上后台结果。']);
    assert.strictEqual(bot.messageQueue.has('cc_user:usr1'), false);
  });

  test('subagent runtime events keep CatsCompany working card open until terminal event', async () => {
    const { bot, sentThinking, toolUses, toolResults } = createProcessHarness();
    const now = Date.now();
    const info = {
      id: 'sub-1',
      displayName: '子agent1',
      agentType: 'explorer',
      skillName: 'explorer',
      toolScope: 'read_only',
      taskDescription: '扫描登录链路',
      status: 'running',
      createdAt: now,
      progressLog: [],
      outputFiles: [],
      allowedTools: ['read_file', 'grep'],
    };

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      id: 'evt-1',
      parentSessionKey: 'cc_user:usr1',
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_spawned',
      timestamp: now,
      seq: 1,
      summary: '派遣子agent1 执行扫描登录链路',
    }, info);

    assert.strictEqual(toolUses.length, 1);
    assert.strictEqual(toolUses[0].toolUseId, 'subagent:sub-1');
    assert.strictEqual(toolUses[0].name, '子agent1');
    assert.strictEqual(toolUses[0].input.status, 'running');
    assert.strictEqual(toolResults.length, 0);

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      id: 'evt-progress',
      parentSessionKey: 'cc_user:usr1',
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_progress',
      timestamp: now,
      seq: 2,
      summary: '开始执行：扫描登录链路',
    }, info);

    assert.deepStrictEqual(sentThinking.map(item => item.text), ['[子agent1] 开始执行：扫描登录链路']);
    assert.strictEqual(sentThinking[0].metadata.kind, 'subagent_event');
    assert.strictEqual(sentThinking[0].metadata.subagent_id, 'sub-1');
    assert.strictEqual(sentThinking[0].metadata.subagent_event_type, 'agent_progress');

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      id: 'evt-waiting',
      parentSessionKey: 'cc_user:usr1',
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_waiting',
      timestamp: now,
      seq: 3,
      summary: '等待主 agent 回复：需要确认范围',
    }, {
      ...info,
      status: 'waiting_for_input',
      pendingQuestion: '需要确认范围',
    });

    assert.deepStrictEqual(sentThinking.map(item => item.text), ['[子agent1] 开始执行：扫描登录链路']);

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      id: 'evt-2',
      parentSessionKey: 'cc_user:usr1',
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_completed',
      timestamp: now + 1,
      seq: 4,
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
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatsCompanyBot } from '../src/catscompany';
import { extractContentBlocks } from '../src/catscompany/content-blocks';
import { ConfigManager } from '../src/utils/config';
import { SubAgentManager } from '../src/core/sub-agent-manager';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function withPatchedModel<T>(
  config: any,
  run: () => Promise<T>,
): Promise<T> {
  const originalGetConfigReadonly = ConfigManager.getConfigReadonly;
  (ConfigManager as any).getConfigReadonly = () => config;
  try {
    return await run();
  } finally {
    (ConfigManager as any).getConfigReadonly = originalGetConfigReadonly;
  }
}

function createTempPng(name: string): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-image-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
  return {
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function canonicalMetadata(actorUserId: string, topicId: string, agentId = 'usr43', bodyId = 'body-main', channelSource?: string) {
  return {
    ...(channelSource ? { source_channel: channelSource } : {}),
    catsco_identity: {
      actor: { user_id: actorUserId },
      agent: { agent_id: agentId, body_id: bodyId },
      topic: { topic_id: topicId, type: topicId.startsWith('grp_') ? 'group' : 'p2p', channel_seq: 12 },
      permissions: { source: 'server_canonical_message' },
    },
  };
}

function createProcessHarness() {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const downloads: Array<{ url: string; fileName: string }> = [];
  const multimodalCalls: Array<{ text: string; attachments: any[] }> = [];
  const handledTurns: Array<{ userMessage: any; options: any }> = [];
  const runtimeObservations: Array<{ text: string; options: any }> = [];
  const sentTexts: Array<{ topic: string; text: string }> = [];
  const replies: Array<{ topic: string; text: string }> = [];
  const sentTyping: Array<{ topic: string }> = [];
  const sentThinking: Array<{ topic: string; text: string; metadata?: any }> = [];
  const toolUses: Array<{ topic: string; toolUseId: string; name: string; input: any; metadata?: any }> = [];
  const toolResults: Array<{ topic: string; toolUseId: string; content: string; isError?: boolean; metadata?: any }> = [];
  const runtimePlans: Array<{ topic: string; snapshot: any }> = [];
  const taskStatuses: Array<{ topic: string; status: any }> = [];

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
    sendTyping: (topic: string) => {
      sentTyping.push({ topic });
    },
    reply: async (topic: string, text: string) => {
      replies.push({ topic, text });
    },
    sendFile: async () => undefined,
    sendText: async (topic: string, text: string) => {
      sentTexts.push({ topic, text });
    },
    sendThinking: async (topic: string, text: string, metadata?: any) => {
      sentThinking.push({ topic, text, metadata });
    },
    sendToolUse: async (topic: string, toolUseId: string, name: string, input: any, metadata?: any) => {
      toolUses.push({ topic, toolUseId, name, input, metadata });
    },
    sendToolResult: async (topic: string, toolUseId: string, content: string, isError?: boolean, metadata?: any) => {
      toolResults.push({ topic, toolUseId, content, isError, metadata });
    },
    sendRuntimePlan: async (topic: string, snapshot: any) => {
      runtimePlans.push({ topic, snapshot });
    },
    sendTaskStatus: async (topic: string, status: any) => {
      taskStatuses.push({ topic, status });
    },
  };
  bot.messageQueue = new Map();
  bot.subAgentEventRoutes = new Map();
  bot.subAgentCompletionBatches = new Map();
  bot.botUid = 'usr43';
  bot.buildMultimodalMessage = async (text: string, attachments: any[]) => {
    multimodalCalls.push({ text, attachments });
    return [
      { type: 'text', text },
      ...attachments.map((attachment) => ({
        type: 'text',
        text: `[${attachment.type}] ${attachment.fileName} -> ${attachment.localFileGrant?.attachmentRef || '(no authorized attachment reference)'}`,
      })),
    ];
  };

  return { bot, downloads, multimodalCalls, handledTurns, runtimeObservations, sentTexts, replies, sentTyping, sentThinking, toolUses, toolResults, runtimePlans, taskStatuses, session };
}

describe('CatsCo content blocks', () => {
  test('does not render assistant pre-tool text as working thinking', () => {
    const blocks = extractContentBlocks([{
      role: 'assistant',
      content: '我先查一下天气。',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'execute_shell',
          arguments: JSON.stringify({ command: 'echo weather' }),
        },
      }],
    } as any]);

    assert.deepStrictEqual(blocks, [{
      type: 'tool_use',
      id: 'call_1',
      name: 'execute_shell',
      input: { command: 'echo weather' },
    }]);
  });

  test('model retry progress is sent as working thinking instead of a normal reply', async () => {
    const { bot, sentThinking, replies } = createProcessHarness();
    const callbacks = (bot as any).buildSessionCallbacks('p2p_retry');

    await callbacks.onRetry(3, 14, {
      attempt: 3,
      maxRetries: 14,
      delayMs: 8000,
      elapsedMs: 12000,
      maxElapsedMs: 5 * 60 * 1000,
      status: 503,
      message: 'temporary upstream error',
    });

    assert.equal(replies.length, 0);
    assert.equal(sentThinking.length, 1);
    assert.equal(sentThinking[0].topic, 'p2p_retry');
    assert.equal(sentThinking[0].text, '模型连接异常（503），正在重试 3/14，约 8 秒后继续...');
    assert.equal(sentThinking[0].metadata.model_retry, true);
    assert.equal(sentThinking[0].metadata.delay_ms, 8000);
  });

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

  test('drops top-level attachment summary when message has only attachments', () => {
    const bot = Object.create(CatsCompanyBot.prototype);

    const parsed = (bot as any).parseMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '[附件] image.png, image.png',
      content: '[附件] image.png, image.png',
      content_blocks: [
        { type: 'image', payload: { url: '/uploads/images/a.png', name: 'image.png', size: 12 } },
        { type: 'image', payload: { url: '/uploads/images/b.png', name: 'image.png', size: 34 } },
      ],
      isGroup: false,
      seq: 10,
    });

    assert.ok(parsed);
    assert.strictEqual(parsed.text, '');
    assert.strictEqual(parsed.files.length, 2);
    assert.deepStrictEqual(parsed.files.map((file: any) => file.fileName), ['image.png', 'image.png']);
  });

  test('builds CatsCo attachment context with stable local cache paths', async () => {
    const bot = Object.create(CatsCompanyBot.prototype);
    const localPath = 'C:\\tmp\\catsco-secret\\tmp\\downloads\\report.pdf';
    const attachment = {
      fileName: 'report.pdf',
      localPath,
      type: 'file',
      receivedAt: Date.now(),
      localFileGrant: {
        attachmentRef: 'catsco_attachment:visible-ref',
      },
    };

    const blocks = await (bot as any).buildMultimodalMessage('请读取这个文件', [attachment]);
    const modelVisible = blocks
      .map((block: any) => block.type === 'text' ? block.text : JSON.stringify(block))
      .join('\n');

    assert.doesNotMatch(modelVisible, /catsco_attachment:visible-ref/);
    assert.match(modelVisible, /本地缓存路径:/);
    assert.match(modelVisible, new RegExp(escapeRegExp(localPath)));
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
      { type: 'text', text: '[发言人: usr1]\n一起看这些附件' },
      { type: 'text', text: '[image] a.png -> (no authorized attachment reference)' },
      { type: 'text', text: '[image] c.png -> (no authorized attachment reference)' },
      { type: 'text', text: '[file] b.pdf -> (no authorized attachment reference)' },
    ]);
    assert.deepStrictEqual(handledTurns[0].options.runtimeFeedback, []);
  });

  test('publishes ordered running and completed states for a CatsCo user turn', async () => {
    const { bot, session, taskStatuses } = createProcessHarness();
    session.handleMessage = async () => ({ visibleToUser: true, text: '处理完成' });

    await (bot as any).processParsedMessage({
      topic: 'p2p_1_2',
      chatType: 'p2p',
      senderId: 'usr1',
      seq: 10,
      text: '请完成这个任务',
      rawContent: '请完成这个任务',
    }, 'cc_user:usr1');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepStrictEqual(
      taskStatuses.map(({ topic, status }) => ({ topic, state: status.state, summary: status.summary })),
      [
        { topic: 'p2p_1_2', state: 'running', summary: '正在处理请求' },
        { topic: 'p2p_1_2', state: 'completed', summary: '任务已完成' },
      ],
    );
    assert.strictEqual(taskStatuses[0].status.run_id, taskStatuses[1].status.run_id);
  });

  test('marks the task as failed when the final CatsCo reply cannot be delivered', async () => {
    const { bot, session, taskStatuses } = createProcessHarness();
    session.handleMessage = async () => ({ visibleToUser: true, text: '处理完成' });
    bot.sender.reply = async () => { throw new Error('socket closed'); };

    await (bot as any).processParsedMessage({
      topic: 'p2p_1_2',
      chatType: 'p2p',
      senderId: 'usr1',
      seq: 10,
      text: '请完成这个任务',
      rawContent: '请完成这个任务',
    }, 'cc_user:usr1');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepStrictEqual(
      taskStatuses.map(({ status }) => status.state),
      ['running', 'failed'],
    );
    assert.strictEqual(taskStatuses[1].status.summary, '回复发送失败');
  });

  test('preserves an explicit failed session outcome even when its fallback reply is delivered', async () => {
    const { bot, session, taskStatuses } = createProcessHarness();
    session.handleMessage = async () => ({
      visibleToUser: true,
      text: '不好意思，刚才处理出了点问题，你再试一次？',
      taskOutcome: 'failed',
    });

    await (bot as any).processParsedMessage({
      topic: 'p2p_1_2',
      chatType: 'p2p',
      senderId: 'usr1',
      seq: 10,
      text: '请完成这个任务',
      rawContent: '请完成这个任务',
    }, 'cc_user:usr1');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepStrictEqual(taskStatuses.map(({ status }) => status.state), ['running', 'failed']);
    assert.strictEqual(taskStatuses[1].status.summary, '任务执行失败');
  });

  test('marks an active task as cancelled when CatsCo sends a cancel control event', async () => {
    const { bot, session, taskStatuses } = createProcessHarness();
    let interrupted = false;
    session.requestInterrupt = () => { interrupted = true; };
    (bot as any).beginConversationTask('session:v2:catscompany:p2p:p2p_1_2:agent:usr43', 'p2p_1_2');

    (bot as any).handleCancelMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '',
      isGroup: false,
      seq: 11,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.strictEqual(interrupted, true);
    assert.deepStrictEqual(taskStatuses.map(({ status }) => status.state), ['running', 'cancelled']);
  });

  test('builds direct image blocks for MiniMax M3 relay model', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    const temp = createTempPng('red-blue.png');

    try {
      const blocks = await withPatchedModel(
        {
          provider: 'anthropic',
          apiUrl: 'https://relay.catsco.cc/anthropic',
          model: 'MiniMax-M3',
        },
        () => bot.buildMultimodalMessage('看图', [{
          type: 'image',
          fileName: 'red-blue.png',
          localPath: temp.filePath,
        }]),
      );

      assert.strictEqual(blocks.length, 3);
      assert.deepStrictEqual(blocks[0], { type: 'text', text: '看图' });
      assert.strictEqual(blocks[1].type, 'text');
      assert.match((blocks[1] as any).text, /red-blue\.png/);
      assert.strictEqual(blocks[2].type, 'image');
      assert.strictEqual((blocks[2] as any).source.type, 'base64');
      assert.strictEqual((blocks[2] as any).source.media_type, 'image/jpeg');
      assert.ok((blocks[2] as any).source.data.length > 0);
    } finally {
      temp.cleanup();
    }
  });

  test('exposes read_file fallback attachment reference for non-vision relay models', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;

    const blocks = await withPatchedModel(
      {
        provider: 'anthropic',
        apiUrl: 'https://relay.catsco.cc/anthropic',
        model: 'MiniMax-M2.7',
      },
      () => bot.buildMultimodalMessage('看图', [{
        type: 'image',
        fileName: 'red-blue.png',
        localPath: 'C:\\tmp\\red-blue.png',
        localFileGrant: { attachmentRef: 'catsco_attachment:image-ref' },
      }]),
    );

    assert.strictEqual(blocks.length, 2);
    assert.deepStrictEqual(blocks[0], { type: 'text', text: '看图' });
    assert.strictEqual(blocks[1].type, 'text');
    assert.match((blocks[1] as any).text, /Current user turn contains image attachments/);
    assert.match((blocks[1] as any).text, /call read_file/);
    assert.match((blocks[1] as any).text, /C:\\tmp\\red-blue\.png/);
    assert.doesNotMatch((blocks[1] as any).text, /catsco_attachment:image-ref/);
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
      { type: 'text', text: '[发言人: usr1]\n非 Dashboard 入口一起看这些附件' },
      { type: 'text', text: '[image] a.png -> (no authorized attachment reference)' },
      { type: 'text', text: '[file] b.pdf -> (no authorized attachment reference)' },
    ]);
  });

  test('passes scoped local file grants from canonical CatsCompany attachments into the session turn', async () => {
    const originalCwd = process.cwd();
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-content-grants-'));

    try {
      process.chdir(testRoot);
      const { bot, handledTurns } = createProcessHarness();
      bot.localDeviceGrant = {
        kind: 'catscompany_body',
        source: 'catscompany',
        bodyId: 'body-main',
        installationId: 'install-main',
        deviceId: 'install-main',
        createdAt: Date.now(),
      };
      bot.sender.downloadFile = async (_url: string, fileName: string) => {
        const localPath = path.join(testRoot, 'tmp', 'downloads', fileName);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, 'hello');
        return localPath;
      };

      await (bot as any).onMessage({
        topic: 'p2p_1_43',
        senderId: 'usr1',
        text: '[附件] report.pdf',
        content: '[附件] report.pdf',
        metadata: canonicalMetadata('usr1', 'p2p_1_43'),
        content_blocks: [
          { type: 'text', text: '请读取这个文件' },
          { type: 'file', payload: { url: '/uploads/files/report.pdf', name: 'report.pdf', size: 34 } },
        ],
        isGroup: false,
        seq: 12,
      });

      assert.strictEqual(handledTurns.length, 1);
      const grants = handledTurns[0].options.localFileGrants;
      assert.strictEqual(grants.length, 1);
      assert.strictEqual(grants[0].sessionKey, 'session:v2:catscompany:p2p:p2p_1_43:agent:usr43');
      assert.strictEqual(grants[0].topicId, 'p2p_1_43');
      assert.strictEqual(grants[0].actorUserId, 'usr1');
      assert.strictEqual(grants[0].agentBodyId, 'body-main');
      assert.strictEqual(grants[0].deviceBodyId, 'body-main');
      assert.strictEqual(grants[0].fileType, 'file');
      assert.strictEqual(grants[0].fileName, 'report.pdf');
      const attachmentRef = grants[0].attachmentRef;
      assert.ok(attachmentRef);
      assert.match(attachmentRef, /^catsco_attachment:/);
      assert.strictEqual(grants[0].filePath, fs.realpathSync(path.join(testRoot, 'tmp', 'downloads', 'report.pdf')));
      const renderedUserMessage = (handledTurns[0].userMessage as any[])
        .map(block => block.text || '')
        .join('\n');
      assert.match(renderedUserMessage, new RegExp(attachmentRef));
      assert.doesNotMatch(renderedUserMessage, /tmp[\\/]+downloads/);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('does not create local file grants for legacy CatsCompany attachments', async () => {
    const originalCwd = process.cwd();
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-content-grants-'));

    try {
      process.chdir(testRoot);
      const { bot, handledTurns } = createProcessHarness();
      bot.localDeviceGrant = {
        kind: 'catscompany_body',
        source: 'catscompany',
        bodyId: 'body-main',
        createdAt: Date.now(),
      };
      bot.sender.downloadFile = async (_url: string, fileName: string) => {
        const localPath = path.join(testRoot, 'tmp', 'downloads', fileName);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, 'hello');
        return localPath;
      };

      await (bot as any).onMessage({
        topic: 'p2p_1_43',
        senderId: 'usr1',
        text: '[附件] report.pdf',
        content: '[附件] report.pdf',
        content_blocks: [
          { type: 'text', text: '请读取这个文件' },
          { type: 'file', payload: { url: '/uploads/files/report.pdf', name: 'report.pdf', size: 34 } },
        ],
        isGroup: false,
        seq: 12,
      });

      assert.strictEqual(handledTurns.length, 1);
      assert.deepStrictEqual(handledTurns[0].options.localFileGrants, []);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('builds attachment messages with stable local cache paths', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    const localPath = 'C:\\tmp\\catsco-test\\secret-report.pdf';

    const blocks = await bot.buildMultimodalMessage('请读取这个文件', [{
      fileName: 'secret-report.pdf',
      localPath,
      type: 'file',
      receivedAt: Date.now(),
      localFileGrant: {
        attachmentRef: 'catsco_attachment:opaque-ref',
      },
    }]);

    const text = blocks
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');

    assert.match(text, /请读取这个文件/);
    assert.match(text, /本地缓存路径:/);
    assert.match(text, new RegExp(escapeRegExp(localPath)));
    assert.doesNotMatch(text, /catsco_attachment:opaque-ref/);
  });

  test('keeps CatsCo image block metadata on the stable local cache path', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-image-ref-'));
    const localPath = path.join(testRoot, 'tmp', 'downloads', 'secret-image.png');

    try {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(
        localPath,
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
      );

      const blocks = await withPatchedModel(
        { model: 'gpt-4o', apiUrl: 'https://api.openai.com/v1', provider: 'openai' },
        () => bot.buildMultimodalMessage('看看这张图', [{
          fileName: 'secret-image.png',
          localPath,
          type: 'image',
          receivedAt: Date.now(),
          localFileGrant: {
            attachmentRef: 'catsco_attachment:image-ref',
          },
        }]),
      );

      const imageBlock = blocks.find((block: any) => block.type === 'image') as any;
      assert.ok(imageBlock);
      assert.strictEqual(imageBlock.filePath, localPath);
      assert.ok(blocks.some((block: any) => block.type === 'text' && String(block.text).includes(localPath)));
      assert.doesNotMatch(JSON.stringify(blocks), /catsco_attachment:image-ref/);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('plain text messages are processed immediately without attachment coalesce wait', async () => {
    const { bot, handledTurns, sentThinking, replies } = createProcessHarness();

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '这条纯文本不应该等待附件',
      content: '这条纯文本不应该等待附件',
      isGroup: false,
      seq: 10,
    });

    assert.strictEqual(handledTurns.length, 1);
    assert.strictEqual(handledTurns[0].userMessage, '[发言人: usr1]\n这条纯文本不应该等待附件');
    assert.strictEqual(typeof handledTurns[0].options.callbacks?.onThinking, 'function');
    assert.strictEqual(typeof handledTurns[0].options.callbacks?.onAssistantText, 'function');
    await handledTurns[0].options.callbacks.onAssistantText('工具调用前的可见回复');
    await handledTurns[0].options.callbacks.onThinking('纯文本压缩状态');
    assert.deepStrictEqual(
      replies.map(({ topic, text }) => ({ topic, text })),
      [{ topic: 'p2p_1_2', text: '工具调用前的可见回复' }],
    );
    assert.deepStrictEqual(
      sentThinking.map(({ topic, text }) => ({ topic, text })),
      [{ topic: 'p2p_1_2', text: '纯文本压缩状态' }],
    );
  });

  test('sends structured tool progress on CatsCompany-native channels', async () => {
    const { bot, handledTurns, toolUses, toolResults, runtimePlans } = createProcessHarness();

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '看一下桌面文件',
      content: '看一下桌面文件',
      metadata: canonicalMetadata('usr1', 'p2p_1_2'),
      isGroup: false,
      seq: 12,
    });

    const callbacks = handledTurns[0].options.callbacks;
    await callbacks.onToolStart('glob', 'call_glob', { pattern: '*', path: 'C:\\Users\\me\\Desktop' });
    await callbacks.onToolEnd('glob', 'call_glob', '找到 1 个匹配文件:\n\n  1. desktop.ini');
    await handledTurns[0].options.channel.sendRuntimePlan('p2p_1_2', {
      revision: 1,
      updatedAt: Date.now(),
      steps: [{ text: '查看桌面文件', status: 'in_progress' }],
    });

    assert.deepStrictEqual(
      toolUses.map(({ topic, toolUseId, name }) => ({ topic, toolUseId, name })),
      [{ topic: 'p2p_1_2', toolUseId: 'call_glob', name: 'glob' }],
    );
    assert.deepStrictEqual(
      toolResults.map(({ topic, toolUseId, content }) => ({ topic, toolUseId, content })),
      [{ topic: 'p2p_1_2', toolUseId: 'call_glob', content: '1. desktop.ini' }],
    );
    assert.strictEqual(runtimePlans.length, 1);
    assert.strictEqual(runtimePlans[0].topic, 'p2p_1_2');
  });

  test('suppresses structured tool progress for Weixin mobile bridge channels', async () => {
    const { bot, handledTurns, replies, sentThinking, toolUses, toolResults, runtimePlans } = createProcessHarness();

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '你帮我看一下我的桌面有什么文件吧',
      content: '你帮我看一下我的桌面有什么文件吧',
      metadata: canonicalMetadata('usr1', 'p2p_1_2', 'usr43', 'body-main', 'weixin'),
      isGroup: false,
      seq: 13,
    });

    assert.strictEqual(handledTurns[0].options.executionScope.channelSource, 'weixin');
    const callbacks = handledTurns[0].options.callbacks;
    await callbacks.onToolStart('resolve_common_directory', 'call_resolve', { kind: 'desktop' });
    await callbacks.onToolEnd(
      'resolve_common_directory',
      'call_resolve',
      'Resolved common directory:\nkind: desktop\npath: C:\\Users\\me\\Desktop',
    );
    await callbacks.onToolStart('glob', 'call_glob', { pattern: '*', path: 'C:\\Users\\me\\Desktop' });
    await callbacks.onToolEnd('glob', 'call_glob', '找到 12 个文件 (14ms):\n\n  1. desktop.ini');
    await callbacks.onThinking('正在压缩上下文。');
    await handledTurns[0].options.channel.sendRuntimePlan('p2p_1_2', {
      revision: 1,
      updatedAt: Date.now(),
      steps: [{ text: '查看桌面文件', status: 'in_progress' }],
    });
    await callbacks.onAssistantText('我先看一下桌面。');

    assert.deepStrictEqual(toolUses, []);
    assert.deepStrictEqual(toolResults, []);
    assert.deepStrictEqual(sentThinking, []);
    assert.deepStrictEqual(runtimePlans, []);
    assert.deepStrictEqual(replies, [{ topic: 'p2p_1_2', text: '我先看一下桌面。' }]);
  });

  test('suppresses structured progress for Weixin ClawBot bridge channels', async () => {
    const { bot, handledTurns, replies, sentThinking, toolUses, toolResults, runtimePlans } = createProcessHarness();

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '你帮我看一下我的桌面有什么文件吧',
      content: '你帮我看一下我的桌面有什么文件吧',
      metadata: canonicalMetadata('usr1', 'p2p_1_2', 'usr43', 'body-main', 'weixin_clawbot'),
      isGroup: false,
      seq: 16,
    });

    assert.strictEqual(handledTurns[0].options.executionScope.channelSource, 'weixin_clawbot');
    const callbacks = handledTurns[0].options.callbacks;
    await callbacks.onToolStart('glob', 'call_glob', { pattern: '*', path: 'C:\\Users\\me\\Desktop' });
    await callbacks.onToolEnd('glob', 'call_glob', '找到 12 个文件 (14ms):\n\n  1. desktop.ini');
    await callbacks.onThinking('正在压缩上下文。');
    await handledTurns[0].options.channel.sendRuntimePlan('p2p_1_2', {
      revision: 1,
      updatedAt: Date.now(),
      steps: [{ text: '查看桌面文件', status: 'in_progress' }],
    });
    await callbacks.onAssistantText('我先看一下桌面。');

    const now = Date.now();
    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-clawbot',
      subAgentName: '子agent1',
      type: 'agent_spawned',
      timestamp: now,
      summary: '派遣子agent1 扫描桌面文件',
    }, {
      id: 'sub-clawbot',
      skillName: 'explorer',
      taskDescription: '扫描桌面文件',
      status: 'running',
      createdAt: now,
      progressLog: [],
      outputFiles: [],
    }, 'weixin_clawbot');
    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-clawbot',
      subAgentName: '子agent1',
      type: 'agent_completed',
      timestamp: now + 1,
      summary: '完成',
    }, {
      id: 'sub-clawbot',
      skillName: 'explorer',
      taskDescription: '扫描桌面文件',
      status: 'completed',
      createdAt: now,
      progressLog: [],
      outputFiles: [],
      resultSummary: '桌面文件扫描完成',
    });

    assert.deepStrictEqual(toolUses, []);
    assert.deepStrictEqual(toolResults, []);
    assert.deepStrictEqual(sentThinking, []);
    assert.deepStrictEqual(runtimePlans, []);
    assert.deepStrictEqual(replies, [{ topic: 'p2p_1_2', text: '我先看一下桌面。' }]);
  });

  test('busy queued native message does not overwrite active mobile subagent event suppression', async () => {
    const { bot, handledTurns, sentThinking, session } = createProcessHarness();

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '移动端发起一个需要子任务的请求',
      content: '移动端发起一个需要子任务的请求',
      metadata: canonicalMetadata('usr1', 'p2p_1_2', 'usr43', 'body-main', 'weixin'),
      isGroup: false,
      seq: 14,
    });

    const sessionKey = handledTurns[0].options.sessionRoute.sessionKey;
    session.isBusy = () => true;

    await (bot as any).onMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '网页端后来的同会话消息应该排队',
      content: '网页端后来的同会话消息应该排队',
      metadata: canonicalMetadata('usr1', 'p2p_1_2'),
      isGroup: false,
      seq: 15,
    });

    SubAgentManager.getInstance().recordEvent(
      sessionKey,
      'sub-mobile-active',
      'agent_progress',
      '开始执行：扫描桌面文件',
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    SubAgentManager.getInstance().unregisterPlatformCallbacks(sessionKey);

    assert.deepStrictEqual(sentThinking, []);
  });

  test('queued CatsCompany turns keep working callbacks for compaction status', async () => {
    const { bot, handledTurns, sentThinking } = createProcessHarness();
    bot.messageQueue.set('session:v2:catscompany:p2p:p2p_1_2:agent:usr43', [{
      userMessage: '排队消息也应该显示压缩状态',
      topic: 'p2p_1_2',
      senderId: 'usr1',
      seq: 11,
      receivedAt: Date.now(),
      source: 'user',
      runtimeFeedback: [],
    }]);

    await (bot as any).drainMessageQueue('session:v2:catscompany:p2p:p2p_1_2:agent:usr43');

    assert.strictEqual(handledTurns.length, 1);
    assert.strictEqual(handledTurns[0].userMessage, '排队消息也应该显示压缩状态');
    assert.strictEqual(typeof handledTurns[0].options.callbacks?.onThinking, 'function');
    await handledTurns[0].options.callbacks.onThinking('排队压缩状态');
    assert.deepStrictEqual(
      sentThinking.map(({ topic, text }) => ({ topic, text })),
      [{ topic: 'p2p_1_2', text: '排队压缩状态' }],
    );
  });

  test('keeps CatsCompany typing visible while a turn is processing', async () => {
    const { bot, sentTyping } = createProcessHarness();

    const stopTyping = (bot as any).startTypingHeartbeat('p2p_1_2', 10);
    await new Promise((resolve) => setTimeout(resolve, 25));
    stopTyping();
    const countAfterStop = sentTyping.length;
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(countAfterStop >= 2);
    assert.strictEqual(sentTyping.length, countAfterStop);
    assert.deepStrictEqual(
      sentTyping.map(({ topic }) => topic),
      Array(sentTyping.length).fill('p2p_1_2'),
    );
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
    bot.botUid = 'usr43';
    let interrupted = 0;
    bot.sessionManager = {
      get: (key: string) => key === 'session:v2:catscompany:p2p:p2p_1_2:agent:usr43'
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

  test('subagent runtime events are suppressed after the parent turn is idle', async () => {
    const { bot, sentThinking, toolResults } = createProcessHarness();
    const now = Date.now();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_1_2:agent:usr43';
    const info = {
      id: 'sub-bg',
      skillName: 'worker',
      taskDescription: '后台生成详情页',
      status: 'running',
      createdAt: now,
      progressLog: [],
      outputFiles: [],
    };
    bot.subAgentEventRoutes.set('sub-bg', { topic: 'p2p_1_2' });

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-bg',
      subAgentName: '子agent1',
      type: 'agent_progress',
      timestamp: now,
      summary: '后台继续写文件',
    }, info, undefined, sessionKey);

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-bg',
      subAgentName: '子agent1',
      type: 'agent_completed',
      timestamp: now + 1,
      summary: '完成',
    }, {
      ...info,
      status: 'completed',
      resultSummary: '详情页已完成',
    }, undefined, sessionKey);

    assert.deepStrictEqual(sentThinking, []);
    assert.deepStrictEqual(toolResults, []);
    assert.equal(bot.subAgentEventRoutes.has('sub-bg'), false);
  });

  test('unclaimed subagent terminal events stay off CatsCompany working stream', async () => {
    const { bot, sentThinking, toolResults, session } = createProcessHarness();
    const manager = SubAgentManager.getInstance();
    const now = Date.now();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_1_2:agent:usr43';
    const subAgentId = 'sub-nowait';
    const info = {
      id: subAgentId,
      skillName: 'worker',
      taskDescription: '后台生成详情页',
      status: 'completed',
      createdAt: now,
      completedAt: now + 1,
      progressLog: [],
      outputFiles: [],
      resultSummary: '详情页已完成',
    };
    session.isBusy = () => true;
    bot.subAgentEventRoutes.set(subAgentId, { topic: 'p2p_1_2' });
    (manager as any).parentMap.set(subAgentId, sessionKey);

    try {
      await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
        subAgentId,
        subAgentName: '子agent1',
        type: 'agent_completed',
        timestamp: now + 1,
        summary: '完成',
      }, info, undefined, sessionKey);

      await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
        subAgentId,
        subAgentName: '子agent1',
        type: 'agent_progress',
        timestamp: now + 2,
        summary: '临时目录已清理',
      }, info, undefined, sessionKey);

      assert.deepStrictEqual(toolResults, []);
      assert.deepStrictEqual(sentThinking, []);
      assert.equal(bot.subAgentEventRoutes.has(subAgentId), false);
    } finally {
      (manager as any).parentMap.delete(subAgentId);
    }
  });

  test('wait-claimed subagent terminal events can close CatsCompany working stream', async () => {
    const { bot, toolResults, session } = createProcessHarness();
    const manager = SubAgentManager.getInstance();
    const now = Date.now();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_1_2:agent:usr43';
    const subAgentId = 'sub-waited';
    const info = {
      id: subAgentId,
      skillName: 'worker',
      taskDescription: '后台生成详情页',
      status: 'completed',
      createdAt: now,
      completedAt: now + 1,
      progressLog: [],
      outputFiles: ['detail.html'],
      resultSummary: '详情页已完成',
    };
    session.isBusy = () => true;
    bot.subAgentEventRoutes.set(subAgentId, { topic: 'p2p_1_2' });
    (manager as any).parentMap.set(subAgentId, sessionKey);
    (manager as any).resultWaitClaimCount.set(subAgentId, 1);

    try {
      await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
        subAgentId,
        subAgentName: '子agent1',
        type: 'agent_completed',
        timestamp: now + 1,
        summary: '完成',
      }, info, undefined, sessionKey);

      assert.strictEqual(toolResults.length, 1);
      assert.strictEqual(toolResults[0].toolUseId, `subagent:${subAgentId}`);
      assert.strictEqual(toolResults[0].metadata.subagent_event_type, 'agent_completed');
      assert.match(toolResults[0].content, /详情页已完成/);
      assert.equal(bot.subAgentEventRoutes.has(subAgentId), false);
    } finally {
      (manager as any).parentMap.delete(subAgentId);
      (manager as any).resultWaitClaimCount.delete(subAgentId);
    }
  });

  test('subagent runtime events are suppressed for Weixin mobile bridge channels', async () => {
    const { bot, sentThinking, toolUses, toolResults } = createProcessHarness();
    const now = Date.now();
    const info = {
      id: 'sub-1',
      skillName: 'explorer',
      taskDescription: '扫描桌面文件',
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
      summary: '派遣子agent1 扫描桌面文件',
    }, info, 'weixin');

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_progress',
      timestamp: now + 1,
      summary: '开始执行：扫描桌面文件',
    }, info);

    await bot.handleSubAgentRuntimeEvent('p2p_1_2', {
      subAgentId: 'sub-1',
      subAgentName: '子agent1',
      type: 'agent_completed',
      timestamp: now + 2,
      summary: '完成',
    }, {
      ...info,
      status: 'completed',
      resultSummary: '桌面文件扫描完成',
    });

    assert.deepStrictEqual(toolUses, []);
    assert.deepStrictEqual(toolResults, []);
    assert.deepStrictEqual(sentThinking, []);
  });

  test('subagent completion feedback is batched back to the model once', async () => {
    const { bot, runtimeObservations, replies, sentThinking, session } = createProcessHarness();
    session.handleRuntimeObservation = async (text: string, options: any) => {
      runtimeObservations.push({ text, options });
      return { visibleToUser: true, text: '后台结果我看到了，已经补充完成。' };
    };

    await (bot as any).handleSubAgentFeedback(
      'session:v2:catscompany:p2p:p2p_38_110:agent:usr43',
      'p2p_38_110',
      'usr38',
      '[子agent1 已完成]\n结果摘要：审查完成',
    );

    assert.deepStrictEqual(runtimeObservations, []);
    assert.deepStrictEqual(sentThinking, []);
    assert.deepStrictEqual(replies, []);

    await (bot as any).flushSubAgentCompletionBatch(
      'session:v2:catscompany:p2p:p2p_38_110:agent:usr43',
      true,
    );

    assert.strictEqual(runtimeObservations.length, 1);
    assert.strictEqual(runtimeObservations[0].options.source, 'subagent_result_batch');
    assert.strictEqual(runtimeObservations[0].options.suppressFinalResponse, false);
    assert.match(runtimeObservations[0].text, /后台子任务批量回流/);
    assert.match(runtimeObservations[0].text, /审查完成/);
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].text, '后台结果我看到了，已经补充完成。');
  });

  test('multiple no-wait subagent completions are batched as one runtime observation', async () => {
    const { bot, runtimeObservations, replies, session } = createProcessHarness();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_38_110:agent:usr43';
    session.handleRuntimeObservation = async (text: string, options: any) => {
      runtimeObservations.push({ text, options });
      return { visibleToUser: false, text: '' };
    };

    await (bot as any).handleSubAgentFeedback(
      sessionKey,
      'p2p_38_110',
      'usr38',
      '[子agent1 已完成]\n任务：创建首页\n结果摘要：首页完成\n产出文件：\n- C:\\Users\\35267\\Desktop\\site\\index.html',
    );
    await (bot as any).handleSubAgentFeedback(
      sessionKey,
      'p2p_38_110',
      'usr38',
      '[子agent2 已完成]\n任务：创建详情页\n结果摘要：详情页完成\n产出文件：\n- C:\\Users\\35267\\Desktop\\site\\detail.html',
    );
    await (bot as any).handleSubAgentFeedback(
      sessionKey,
      'p2p_38_110',
      'usr38',
      '[子agent3 已完成]\n任务：补充详情页内容\n结果摘要：详情页补充完成\n产出文件：\n- C:\\Users\\35267\\Desktop\\site\\detail.html',
    );

    assert.deepStrictEqual(runtimeObservations, []);
    assert.deepStrictEqual(replies, []);

    await (bot as any).flushSubAgentCompletionBatch(sessionKey, true);

    assert.strictEqual(runtimeObservations.length, 1);
    assert.match(runtimeObservations[0].text, /3 条已完成/);
    assert.match(runtimeObservations[0].text, /涉及 2 个产出\/任务/);
    assert.match(runtimeObservations[0].text, /2 条回传/);
    assert.match(runtimeObservations[0].text, /创建首页/);
    assert.match(runtimeObservations[0].text, /创建详情页/);
    assert.match(runtimeObservations[0].text, /index\.html/);
    assert.match(runtimeObservations[0].text, /detail\.html/);
    assert.deepStrictEqual(replies, []);
  });

  test('keeps a completion batch when both model回流 and fallback delivery fail', async () => {
    const { bot, session } = createProcessHarness();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_38_110:agent:usr43';
    session.handleRuntimeObservation = async () => {
      throw new Error('model observation failed');
    };
    bot.sender.reply = async () => {
      throw new Error('fallback delivery failed');
    };

    await (bot as any).handleSubAgentFeedback(
      sessionKey,
      'p2p_38_110',
      'usr38',
      '[子agent1 已完成]\n任务：审查\n结果摘要：审查完成',
    );
    await (bot as any).flushSubAgentCompletionBatch(sessionKey, true);

    const retained = bot.subAgentCompletionBatches.get(sessionKey);
    assert.ok(retained);
    assert.equal(retained.items.size, 1);
    if (retained.timer) clearTimeout(retained.timer);
    bot.subAgentCompletionBatches.delete(sessionKey);
  });

  test('drops an in-flight completion batch result when clear advances its generation', async () => {
    const { bot, session, replies } = createProcessHarness();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_38_110:agent:usr43';
    session.handleRuntimeObservation = async () => {
      bot.bumpSessionClearGeneration(sessionKey);
      return { visibleToUser: true, text: '不应在 clear 后出现的旧结果' };
    };

    await bot.handleSubAgentFeedback(
      sessionKey,
      'p2p_38_110',
      'usr38',
      '[子agent1 已完成]\n任务：审查\n结果摘要：旧结果',
    );
    await bot.flushSubAgentCompletionBatch(sessionKey, true);

    assert.deepStrictEqual(replies, []);
    assert.equal(bot.subAgentCompletionBatches.has(sessionKey), false);
    assert.equal(bot.sessionExecutionReservations.has(sessionKey), false);
  });

  test('completion batch setup failures still release the session reservation', async () => {
    const { bot, replies } = createProcessHarness();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_38_110:agent:usr43';

    await bot.handleSubAgentFeedback(
      sessionKey,
      'p2p_38_110',
      'usr38',
      '[子agent1 已完成]\n任务：审查\n结果摘要：需要兜底的结果',
    );
    bot.registerSubAgentPlatformCallbacks = () => {
      throw new Error('callback setup failed');
    };
    await bot.flushSubAgentCompletionBatch(sessionKey, true);

    assert.equal(bot.sessionExecutionReservations.has(sessionKey), false);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /后台子任务已回传/);
    assert.match(replies[0].text, /审查（已完成）/);
  });

  test('consumed subagent completion feedback is dropped before runtime observation', async () => {
    const { bot, runtimeObservations, replies, sentTyping } = createProcessHarness();
    const manager = SubAgentManager.getInstance();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_38_110:agent:usr43';
    const subAgentId = 'sub-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const observation = `[子agent1 已完成]\nID：${subAgentId}\n结果摘要：审查完成`;

    (manager as any).parentMap.set(subAgentId, sessionKey);
    (manager as any).resultConsumedByWait.add(subAgentId);

    try {
      await (bot as any).handleSubAgentFeedback(
        sessionKey,
        'p2p_38_110',
        'usr38',
        observation,
      );

      assert.deepStrictEqual(runtimeObservations, []);
      assert.deepStrictEqual(replies, []);
      assert.deepStrictEqual(sentTyping, []);

      bot.messageQueue.set(sessionKey, [{
        userMessage: observation,
        topic: 'p2p_38_110',
        senderId: 'usr38',
        seq: 0,
        receivedAt: Date.now(),
        source: 'subagent_feedback',
      }]);

      await (bot as any).drainMessageQueue(sessionKey);

      assert.deepStrictEqual(runtimeObservations, []);
      assert.equal(bot.messageQueue.has(sessionKey), false);
    } finally {
      (manager as any).parentMap.delete(subAgentId);
      (manager as any).resultConsumedByWait.delete(subAgentId);
    }
  });

  test('unconsumed wait-claimed subagent completion can send a follow-up reply', async () => {
    const { bot, runtimeObservations, replies, session } = createProcessHarness();
    const manager = SubAgentManager.getInstance();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_38_110:agent:usr43';
    const subAgentId = 'sub-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const observation = `[子agent1 已完成]\nID：${subAgentId}\n结果摘要：超时后完成`;

    session.handleRuntimeObservation = async (text: string, options: any) => {
      runtimeObservations.push({ text, options });
      return { visibleToUser: true, text: '后台子任务刚完成，我补充一下结果。' };
    };

    (manager as any).parentMap.set(subAgentId, sessionKey);
    (manager as any).resultNotifyOnObservation.add(subAgentId);

    try {
      await (bot as any).handleSubAgentFeedback(
        sessionKey,
        'p2p_38_110',
        'usr38',
        observation,
      );

      assert.strictEqual(runtimeObservations.length, 1);
      assert.strictEqual(runtimeObservations[0].options.source, 'subagent_result');
      assert.strictEqual(runtimeObservations[0].options.suppressFinalResponse, false);
      assert.deepStrictEqual(replies, [
        { topic: 'p2p_38_110', text: '后台子任务刚完成，我补充一下结果。' },
      ]);
      assert.equal((manager as any).resultNotifyOnObservation.has(subAgentId), false);
    } finally {
      (manager as any).parentMap.delete(subAgentId);
      (manager as any).resultNotifyOnObservation.delete(subAgentId);
    }
  });

  test('queued subagent completion feedback is batched back to the model', async () => {
    const { bot, runtimeObservations, sentTexts, replies, sentThinking, session } = createProcessHarness();
    session.handleRuntimeObservation = async (text: string, options: any) => {
      runtimeObservations.push({ text, options });
      return {
        visibleToUser: true,
        text: '处理消息时出错: 子 agent 结果处理失败',
      };
    };
    bot.messageQueue.set('session:v2:catscompany:p2p:p2p_38_110:agent:usr43', [{
      userMessage: '[子agent1 已完成]\n结果摘要：审查完成',
      topic: 'p2p_38_110',
      senderId: 'usr38',
      seq: 0,
      receivedAt: Date.now(),
      source: 'subagent_feedback',
    }]);

    await (bot as any).drainMessageQueue('session:v2:catscompany:p2p:p2p_38_110:agent:usr43');

    assert.deepStrictEqual(runtimeObservations, []);
    assert.deepStrictEqual(sentThinking, []);
    assert.deepStrictEqual(sentTexts, []);
    assert.deepStrictEqual(replies, []);

    await (bot as any).flushSubAgentCompletionBatch(
      'session:v2:catscompany:p2p:p2p_38_110:agent:usr43',
      true,
    );

    assert.strictEqual(runtimeObservations.length, 1);
    assert.strictEqual(runtimeObservations[0].options.source, 'subagent_result_batch');
    assert.strictEqual(replies.length, 1);
    assert.match(replies[0].text, /子 agent 结果处理失败/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

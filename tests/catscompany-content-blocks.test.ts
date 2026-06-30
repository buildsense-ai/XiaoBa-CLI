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
  };
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.subAgentEventRoutes = new Map();
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

  return { bot, downloads, multimodalCalls, handledTurns, runtimeObservations, sentTexts, replies, sentTyping, sentThinking, toolUses, toolResults, runtimePlans, session };
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

  test('builds CatsCo attachment context with opaque references instead of local paths', async () => {
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
    const prompt = (bot as any).buildAttachmentOnlyPrompt([attachment]);
    const modelVisible = JSON.stringify(blocks) + '\n' + prompt;

    assert.match(modelVisible, /catsco_attachment:visible-ref/);
    assert.match(modelVisible, /授权附件引用/);
    assert.doesNotMatch(modelVisible, /catsco-secret/);
    assert.doesNotMatch(modelVisible, new RegExp(escapeRegExp(localPath)));
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
      { type: 'text', text: 'usr1：\n一起看这些附件' },
      { type: 'text', text: '[image] a.png -> (no authorized attachment reference)' },
      { type: 'text', text: '[image] c.png -> (no authorized attachment reference)' },
      { type: 'text', text: '[file] b.pdf -> (no authorized attachment reference)' },
    ]);
    assert.deepStrictEqual(handledTurns[0].options.runtimeFeedback, []);
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
    assert.match((blocks[1] as any).text, /catsco_attachment:image-ref/);
    assert.doesNotMatch((blocks[1] as any).text, /C:\\tmp\\red-blue\.png/);
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
      { type: 'text', text: 'usr1：\n非 Dashboard 入口一起看这些附件' },
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

  test('builds attachment messages with opaque references instead of local paths', async () => {
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
    assert.match(text, /catsco_attachment:opaque-ref/);
    assert.doesNotMatch(text, /secret-report\.pdf -> C:/);
    assert.doesNotMatch(text, /C:\\tmp\\catsco-test/);
    assert.doesNotMatch(text, /授权附件路径/);
  });

  test('sanitizes CatsCo image block metadata to use opaque references', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    const originalModel = process.env.GAUZ_LLM_MODEL;
    const originalApiBase = process.env.GAUZ_LLM_API_BASE;
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-image-ref-'));
    const localPath = path.join(testRoot, 'tmp', 'downloads', 'secret-image.png');

    try {
      process.env.GAUZ_LLM_MODEL = 'gpt-4o';
      process.env.GAUZ_LLM_API_BASE = 'https://api.openai.com/v1';
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(
        localPath,
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
      );

      const blocks = await bot.buildMultimodalMessage('看看这张图', [{
        fileName: 'secret-image.png',
        localPath,
        type: 'image',
        receivedAt: Date.now(),
        localFileGrant: {
          attachmentRef: 'catsco_attachment:image-ref',
        },
      }]);

      const imageBlock = blocks.find((block: any) => block.type === 'image') as any;
      assert.ok(imageBlock);
      assert.strictEqual(imageBlock.filePath, 'catsco_attachment:image-ref');
      assert.doesNotMatch(JSON.stringify(blocks), new RegExp(escapeRegExp(localPath)));
      assert.doesNotMatch(JSON.stringify(blocks), new RegExp(escapeRegExp(testRoot)));
    } finally {
      if (originalModel === undefined) {
        delete process.env.GAUZ_LLM_MODEL;
      } else {
        process.env.GAUZ_LLM_MODEL = originalModel;
      }
      if (originalApiBase === undefined) {
        delete process.env.GAUZ_LLM_API_BASE;
      } else {
        process.env.GAUZ_LLM_API_BASE = originalApiBase;
      }
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
    assert.strictEqual(handledTurns[0].userMessage, 'usr1：\n这条纯文本不应该等待附件');
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

  test('subagent feedback visible reply is sent back to CatsCompany', async () => {
    const { bot, runtimeObservations, replies, sentThinking, session } = createProcessHarness();
    session.handleRuntimeObservation = async (text: string, options: any) => {
      runtimeObservations.push({ text, options });
      return { visibleToUser: true, text: '已根据子 agent 结果处理完。' };
    };

    await (bot as any).handleSubAgentFeedback(
      'session:v2:catscompany:p2p:p2p_38_110:agent:usr43',
      'p2p_38_110',
      'usr38',
      '[子agent1 已完成]\n结果摘要：审查完成',
    );

    assert.strictEqual(runtimeObservations.length, 1);
    assert.strictEqual(runtimeObservations[0].options.source, 'subagent_result');
    assert.strictEqual(typeof runtimeObservations[0].options.callbacks?.onThinking, 'function');
    await runtimeObservations[0].options.callbacks.onThinking('子 agent 回流压缩状态');
    assert.deepStrictEqual(
      sentThinking.map(({ topic, text }) => ({ topic, text })),
      [{ topic: 'p2p_38_110', text: '子 agent 回流压缩状态' }],
    );
    assert.deepStrictEqual(replies, [
      { topic: 'p2p_38_110', text: '已根据子 agent 结果处理完。' },
    ]);
  });

  test('queued subagent error reply is not sent twice', async () => {
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

    assert.strictEqual(runtimeObservations.length, 1);
    assert.strictEqual(runtimeObservations[0].options.source, 'subagent_result');
    assert.strictEqual(typeof runtimeObservations[0].options.callbacks?.onThinking, 'function');
    await runtimeObservations[0].options.callbacks.onThinking('排队子 agent 压缩状态');
    assert.deepStrictEqual(
      sentThinking.map(({ topic, text }) => ({ topic, text })),
      [{ topic: 'p2p_38_110', text: '排队子 agent 压缩状态' }],
    );
    assert.deepStrictEqual(sentTexts, []);
    assert.deepStrictEqual(replies, [
      { topic: 'p2p_38_110', text: '处理消息时出错: 子 agent 结果处理失败' },
    ]);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';

function createProcessHarness() {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const downloads: Array<{ url: string; fileName: string }> = [];
  const multimodalCalls: Array<{ text: string; attachments: any[] }> = [];
  const handledTurns: Array<{ userMessage: any; options: any }> = [];
  const sentThinking: Array<{ text: string; metadata?: any }> = [];
  const sentTexts: string[] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  const toolUses: Array<{ topic: string; toolUseId: string; name: string; input: any; metadata?: any }> = [];
  const toolResults: Array<{ topic: string; toolUseId: string; content: string; isError?: boolean; metadata?: any }> = [];

  const session = {
    isBusy: () => false,
    handleMessage: async (userMessage: any, options: any) => {
      handledTurns.push({ userMessage, options });
      return { visibleToUser: false, text: '' };
    },
    handleCommand: async (command: string, args: string[]) => {
      commands.push({ command, args });
      return { handled: true, reply: '' };
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
    reply: async () => undefined,
    sendFile: async () => undefined,
    sendText: async (_topic: string, text: string) => {
      sentTexts.push(text);
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
  bot.pendingTextMessages = new Map();
  bot.messageQueue = new Map();
  bot.botUid = 'bot42';
  bot.runtimeProfile = { displayName: 'Dev Agent', prompt: { displayName: 'Dev Agent' } };
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

  return { bot, downloads, multimodalCalls, handledTurns, sentThinking, sentTexts, commands, toolUses, toolResults };
}

describe('CatsCo content blocks', () => {
  test('parses text and multiple attachments from one CatsCompany message', () => {
    const bot = Object.create(CatsCompanyBot.prototype);

    const parsed = (bot as any).parseMessage({
      topic: 'p2p_1_2',
      senderId: 'usr1',
      text: '帮我一起看这两张图',
      metadata: { sender_display_name: 'Alice' },
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
    assert.deepStrictEqual(parsed.metadata, { sender_display_name: 'Alice' });
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
    assert.equal(handledTurns[0].options.sessionIdentity.sessionId, 'cc_user:usr1');
    assert.equal(handledTurns[0].options.sessionIdentity.channel, 'catsco');
    assert.equal(handledTurns[0].options.sessionIdentity.actor.actorUserId, 'usr1');
    assert.equal(handledTurns[0].options.sessionIdentity.topic.topicId, 'p2p_1_2');
    assert.equal(handledTurns[0].options.sessionIdentity.topic.channelSeq, 9);
  });

  test('maps platform catsco_identity metadata into session identity', async () => {
    const { bot, handledTurns } = createProcessHarness();

    await bot.processParsedMessage({
      topic: 'p2p_7_42',
      chatType: 'p2p',
      senderId: 'usr7',
      seq: 15,
      text: '帮我看一下资料',
      rawContent: '帮我看一下资料',
      metadata: {
        catsco_identity: {
          actor: { user_id: 7, display_name: 'Alice' },
          agent: { agent_id: 42, display_name: 'Dev Agent', body_id: 'body-mac', relation: 'member' },
          topic: { topic_id: 'p2p_7_42', type: 'p2p', channel_seq: 15 },
          permissions: { can_chat: true, source: 'server_canonical_message' },
        },
      },
      files: [],
    }, 'cc_user:usr7');

    const identity = handledTurns[0].options.sessionIdentity;
    assert.equal(identity.actor.actorUserId, 'usr7');
    assert.equal(identity.actor.actorDisplayName, 'Alice');
    assert.equal(identity.agent.agentId, 'usr42');
    assert.equal(identity.agent.bodyId, 'body-mac');
    assert.equal(identity.topic.topicId, 'p2p_7_42');
    assert.equal(identity.topic.channelSeq, 15);
    assert.equal(identity.permissionsSnapshot.source, 'server_canonical_message');
  });

  test('queued pending user input keeps per-message identity context', () => {
    const { bot } = createProcessHarness();
    bot.messageQueue.set('cc_group:grp_school_ops', [
      {
        userMessage: 'A 的补充',
        topic: 'grp_school_ops',
        senderId: 'usr7',
        seq: 12,
        receivedAt: 100,
        source: 'user',
        sessionIdentity: {
          schemaVersion: 1,
          sessionId: 'cc_group:grp_school_ops',
          legacySessionKey: 'cc_group:grp_school_ops',
          sessionType: 'catscompany',
          channel: 'catsco',
          actor: { actorUserId: 'usr7', actorDisplayName: 'Alice', externalUserId: 'usr7' },
          agent: { agentId: 'bot42', agentDisplayName: 'Dev Agent', bodyId: 'device_mac' },
          topic: { topicId: 'grp_school_ops', topicType: 'group', channelSeq: 12 },
        },
      },
      {
        userMessage: 'B 的补充',
        topic: 'grp_school_ops',
        senderId: 'usr8',
        seq: 13,
        receivedAt: 101,
        source: 'user',
        sessionIdentity: {
          schemaVersion: 1,
          sessionId: 'cc_group:grp_school_ops',
          legacySessionKey: 'cc_group:grp_school_ops',
          sessionType: 'catscompany',
          channel: 'catsco',
          actor: { actorUserId: 'usr8', actorDisplayName: 'Bob', externalUserId: 'usr8' },
          agent: { agentId: 'bot42', agentDisplayName: 'Dev Agent', bodyId: 'device_mac' },
          topic: { topicId: 'grp_school_ops', topicType: 'group', channelSeq: 13 },
        },
      },
    ]);

    const pending = (bot as any).consumeQueuedUserInput('cc_group:grp_school_ops');

    assert.ok(pending);
    assert.equal(typeof pending.content, 'string');
    assert.match(pending.content, /1\. usr7: A 的补充/);
    assert.match(pending.content, /2\. usr8: B 的补充/);
    assert.match(pending.transientContext, /^\[transient_session_identity\]/);
    assert.match(pending.transientContext, /actor=Alice \/ usr7/);
    assert.match(pending.transientContext, /actor=Bob \/ usr8/);
    assert.match(pending.transientContext, /seq=12/);
    assert.match(pending.transientContext, /seq=13/);
  });

  test('slash command with leading whitespace is handled as a command', async () => {
    const { bot, handledTurns, commands } = createProcessHarness();

    await bot.processParsedMessage({
      topic: 'grp_school_ops',
      chatType: 'group',
      senderId: 'usr1',
      seq: 27,
      text: '  /clear now',
      rawContent: '  /clear now',
      metadata: { sender_kind: 'human' },
    }, 'cc_group:grp_school_ops');

    assert.deepStrictEqual(commands, [{ command: 'clear', args: ['now'] }]);
    assert.strictEqual(handledTurns.length, 0);
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
});

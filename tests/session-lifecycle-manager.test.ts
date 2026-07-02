import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('AgentSession lifecycle', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-session-lifecycle-'));
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('restores persisted history before injected context', async () => {
    const { AgentSession, SessionStore } = loadSessionModules();
    SessionStore.getInstance().saveContext('user:lifecycle-restore', [
      { role: 'system', content: 'stale system should not persist' },
      { role: 'user', content: 'old user message' },
      { role: 'assistant', content: 'old assistant message' },
      { role: 'user', content: 'old injected message', __injected: true },
    ]);

    const session = new AgentSession('user:lifecycle-restore', buildMockServices(), 'feishu');
    session.setSystemPromptProvider(() => 'system prompt');

    assert.equal(session.restoreFromStore(), true);
    session.injectContext('adapter context');
    await session.init();

    const messages = (session as any).messages;
    assert.deepStrictEqual(
      messages.map((message: any) => message.content),
      [
        'system prompt',
        'old user message',
        'old assistant message',
        'adapter context',
      ],
    );
    assert.equal(messages[3].__injected, true);
  });

  test('reset and clear discard pending restored history before initialization', async () => {
    const { AgentSession, SessionStore } = loadSessionModules();
    SessionStore.getInstance().saveContext('user:lifecycle-reset', [
      { role: 'user', content: 'restored before reset' },
    ]);
    const resetSession = new AgentSession('user:lifecycle-reset', buildMockServices(), 'feishu');
    resetSession.setSystemPromptProvider(() => 'system prompt');
    assert.equal(resetSession.restoreFromStore(), true);
    resetSession.reset();
    await resetSession.init();
    assert.equal(
      (resetSession as any).messages.some((message: any) => message.content === 'restored before reset'),
      false,
    );

    SessionStore.getInstance().saveContext('user:lifecycle-clear', [
      { role: 'user', content: 'restored before clear' },
    ]);
    const clearSession = new AgentSession('user:lifecycle-clear', buildMockServices(), 'feishu');
    clearSession.setSystemPromptProvider(() => 'system prompt');
    assert.equal(clearSession.restoreFromStore(), true);
    clearSession.clear();
    await clearSession.init();
    assert.equal(
      (clearSession as any).messages.some((message: any) => message.content === 'restored before clear'),
      false,
    );
    assert.equal(SessionStore.getInstance().hasSession('user:lifecycle-clear'), false);
  });

  test('current directory is persisted per session and reset clears it to default directory', async () => {
    const { AgentSession, SessionStore } = loadSessionModules();
    const defaultDir = fs.mkdtempSync(path.join(testRoot, 'default-'));
    const nestedDir = path.join(defaultDir, 'nested');
    fs.mkdirSync(nestedDir);
    const services = buildMockServices({
      toolManager: {
        getWorkspaceRoot() { return defaultDir; },
        getToolDefinitions() { return []; },
        executeTool() { throw new Error('not expected'); },
      },
    });

    const session = new AgentSession('user:lifecycle-cwd', services, 'feishu');
    (session as any).updateCurrentDirectory(nestedDir);

    const restored = new AgentSession('user:lifecycle-cwd', services, 'feishu');
    assert.equal((restored as any).currentDirectory, nestedDir);

    restored.reset();
    assert.equal((restored as any).currentDirectory, defaultDir);
    assert.equal(SessionStore.getInstance().loadRuntimeState('user:lifecycle-cwd').currentDirectory, defaultDir);
  });

  test('current directory inside Electron userData is preserved when explicitly persisted', async () => {
    const { AgentSession, SessionStore } = loadSessionModules();
    const originalUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    const defaultDir = fs.mkdtempSync(path.join(testRoot, 'workspace-'));
    const userDataDir = fs.mkdtempSync(path.join(testRoot, 'user-data-'));
    const storedDir = path.join(userDataDir, 'nested');
    fs.mkdirSync(storedDir);
    const services = buildMockServices({
      toolManager: {
        getWorkspaceRoot() { return defaultDir; },
        getToolDefinitions() { return []; },
        executeTool() { throw new Error('not expected'); },
      },
    });

    try {
      process.env.XIAOBA_USER_DATA_DIR = userDataDir;
      SessionStore.getInstance().saveRuntimeState('user:lifecycle-user-data-cwd', { currentDirectory: storedDir });

      const session = new AgentSession('user:lifecycle-user-data-cwd', services, 'feishu');

      assert.equal((session as any).currentDirectory, storedDir);
      assert.equal(
        SessionStore.getInstance().loadRuntimeState('user:lifecycle-user-data-cwd').currentDirectory,
        storedDir,
      );
    } finally {
      if (originalUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
      else process.env.XIAOBA_USER_DATA_DIR = originalUserDataDir;
    }
  });

  test('CatsCo group uses the legacy key as its primary session', async () => {
    const { AgentSession, SessionStore, createCatsCoSessionRoute } = loadSessionModules();
    const defaultDir = fs.mkdtempSync(path.join(testRoot, 'default-'));
    const legacyDir = fs.mkdtempSync(path.join(testRoot, 'legacy-'));
    const store = SessionStore.getInstance();
    store.saveContext('cc_group:grp_80', [
      { role: 'user', content: 'legacy group history' },
    ]);
    store.saveRuntimeState('cc_group:grp_80', { currentDirectory: legacyDir });

    const route = createCatsCoSessionRoute({
      source: 'catscompany',
      sessionKey: 'cc_group:grp_80',
      topicType: 'group',
      topicId: 'grp_80',
      rawText: 'hello',
      actorUserId: 'alice',
      agentId: 'usr43',
      identityTrust: 'server_canonical',
      identitySource: 'test',
      legacyRestoreKey: 'cc_group:grp_80',
      legacyCleanupKey: 'cc_group:grp_80',
    });
    assert.equal(route.sessionKey, 'cc_group:grp_80');
    assert.equal(route.legacySessionKey, 'cc_group:grp_80');
    assert.equal(route.legacyRestoreKey, 'cc_group:grp_80');
    assert.equal(route.legacyCleanupKey, 'cc_group:grp_80');

    const session = new AgentSession(route.sessionKey, buildMockServices({
      toolManager: {
        getWorkspaceRoot() { return defaultDir; },
        getToolDefinitions() { return []; },
        executeTool() { throw new Error('not expected'); },
      },
    }), 'catscompany', route);
    session.setSystemPromptProvider(() => 'system prompt');

    assert.equal(session.restoreFromStore(), true);
    assert.equal((session as any).currentDirectory, legacyDir);
    await session.init();
    assert.equal(
      (session as any).messages.some((message: any) => message.content === 'legacy group history'),
      true,
    );

    session.clear();
    assert.equal(store.hasSession('cc_group:grp_80'), false);
  });

  test('CatsCo group migrates actor-v2 and topic-v2 session files to the legacy key', async () => {
    const { SessionStore } = loadSessionModules();
    const sessionsDir = path.join(testRoot, 'data', 'sessions');
    const stateDir = path.join(testRoot, 'data', 'session-state');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const actorV2File = path.join(sessionsDir, 'session_v2_catscompany_group_grp_80_3Aactor_3Ausr7_agent_usr43.jsonl');
    const topicV2File = path.join(sessionsDir, 'session_v2_catscompany_group_grp_80_agent_usr43.jsonl');
    fs.writeFileSync(topicV2File, `${JSON.stringify({ role: 'user', content: 'topic v2 history' })}\n`, 'utf-8');
    fs.writeFileSync(actorV2File, `${JSON.stringify({ role: 'user', content: 'actor v2 history' })}\n`, 'utf-8');
    fs.writeFileSync(
      path.join(stateDir, 'session_v2_catscompany_group_grp_80_3Aactor_3Ausr7_agent_usr43.json'),
      JSON.stringify({ currentDirectory: 'D:\\actor-v2' }),
      'utf-8',
    );

    const store = SessionStore.getInstance();
    assert.equal(store.hasSession('cc_group:grp_80'), true);
    assert.deepEqual(
      store.loadContext('cc_group:grp_80').map((message: any) => message.content),
      ['actor v2 history'],
    );
    assert.equal(
      fs.existsSync(path.join(sessionsDir, 'cc_group_grp_80.jsonl')),
      true,
    );
    assert.deepEqual(store.loadRuntimeState('cc_group:grp_80').currentDirectory, 'D:\\actor-v2');
  });

  test('CatsCo group migrates topic-v2 files when no actor-v2 file exists', async () => {
    const { SessionStore } = loadSessionModules();
    const sessionsDir = path.join(testRoot, 'data', 'sessions');
    const stateDir = path.join(testRoot, 'data', 'session-state');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionsDir, 'session_v2_catscompany_group_grp_80_agent_usr43.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'topic v2 history' })}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(stateDir, 'session_v2_catscompany_group_grp_80_agent_usr43.json'),
      JSON.stringify({ currentDirectory: 'D:\\topic-v2' }),
      'utf-8',
    );

    const store = SessionStore.getInstance();
    assert.equal(store.hasSession('cc_group:grp_80'), true);
    assert.deepEqual(
      store.loadContext('cc_group:grp_80').map((message: any) => message.content),
      ['topic v2 history'],
    );
    assert.deepEqual(store.loadRuntimeState('cc_group:grp_80').currentDirectory, 'D:\\topic-v2');
  });

  test('reset and clear discard pending runtime feedback', async () => {
    const { AgentSession } = loadSessionModules();
    const resetSession = new AgentSession('user:lifecycle-feedback-reset', buildMockServices(), 'feishu');

    assert.equal(resetSession.injectRuntimeFeedback('test.source', 'reset me'), true);
    assert.equal((resetSession as any).runtimeFeedbackInbox.getPendingCount(), 1);
    resetSession.reset();
    assert.equal((resetSession as any).runtimeFeedbackInbox.getPendingCount(), 0);

    const clearSession = new AgentSession('user:lifecycle-feedback-clear', buildMockServices(), 'feishu');
    assert.equal(clearSession.injectRuntimeFeedback('test.source', 'clear me'), true);
    assert.equal((clearSession as any).runtimeFeedbackInbox.getPendingCount(), 1);
    clearSession.clear();
    assert.equal((clearSession as any).runtimeFeedbackInbox.getPendingCount(), 0);
  });

  test('cleanup persists durable context only and keeps clear from overwriting old file', async () => {
    const { AgentSession, SessionStore } = loadSessionModules();
    const session = new AgentSession('user:lifecycle-cleanup', buildMockServices(), 'feishu');
    session.setSystemPromptProvider(() => 'system prompt');
    await session.init();
    (session as any).messages.push(
      { role: 'user', content: 'durable user' },
      { role: 'assistant', content: 'durable assistant' },
      { role: 'user', content: 'injected context', __injected: true },
    );

    await session.cleanup();
    const restored = SessionStore.getInstance().loadContext('user:lifecycle-cleanup');
    assert.deepStrictEqual(
      restored.map(message => message.content),
      ['durable user', 'durable assistant'],
    );

    const resetSession = new AgentSession('user:lifecycle-cleanup', buildMockServices(), 'feishu');
    resetSession.restoreFromStore();
    resetSession.reset();
    await resetSession.cleanup();

    const restoredAfterReset = SessionStore.getInstance().loadContext('user:lifecycle-cleanup');
    assert.deepStrictEqual(
      restoredAfterReset.map(message => message.content),
      ['durable user', 'durable assistant'],
    );
  });

  test('session persistence strips provider replay hidden thinking from restored history', async () => {
    const { SessionStore } = loadSessionModules();
    SessionStore.getInstance().saveContext('user:lifecycle-provider-replay', [
      { role: 'user', content: '需要读文件' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'toolu_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"notes.md"}' },
        }],
        providerContent: [
          { type: 'thinking', thinking: 'hidden chain text', signature: 'sig_secret' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.md' } },
        ],
      },
      { role: 'tool', content: 'private tool result', tool_call_id: 'toolu_1', name: 'read_file' },
      { role: 'assistant', content: '读完了' },
    ]);

    const restored = SessionStore.getInstance().loadContext('user:lifecycle-provider-replay');
    const raw = fs.readFileSync(
      path.join(testRoot, 'data', 'sessions', 'user_lifecycle-provider-replay.jsonl'),
      'utf-8',
    );

    assert.deepStrictEqual(
      restored.map((message: any) => message.content),
      ['需要读文件', null, '[历史工具结果已省略；read_file 已完成。]', '读完了'],
    );
    assert.equal(restored.some((message: any) => Array.isArray(message.providerContent)), false);
    assert.equal(restored.some((message: any) => message.role === 'tool'), true);
    assert.equal(restored.some((message: any) => message.tool_calls?.length), true);
    assert.equal(
      restored.some((message: any) => message.role === 'tool' && message.tool_call_id === 'toolu_1'),
      true,
    );
    assert.equal(restored.some((message: any) => String(message.content || '').includes('provider replay 隐藏内容')), false);
    assert.equal(restored.some((message: any) => String(message.content || '').includes('private tool result')), false);
    assert.doesNotMatch(raw, /hidden chain text/);
    assert.doesNotMatch(raw, /sig_secret/);
    assert.doesNotMatch(raw, /provider replay 隐藏内容/);
    assert.doesNotMatch(raw, /private tool result/);
  });

  test('loading legacy sessions migrates provider replay hidden thinking off disk', async () => {
    const { SessionStore } = loadSessionModules();
    const sessionFile = path.join(testRoot, 'data', 'sessions', 'user_lifecycle-legacy-provider-replay.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ role: 'user', content: '旧历史' }),
      JSON.stringify({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'toolu_legacy',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"legacy.md"}' },
        }],
        providerContent: [
          { type: 'thinking', thinking: 'legacy hidden chain', signature: 'legacy_sig' },
          { type: 'tool_use', id: 'toolu_legacy', name: 'read_file', input: { path: 'legacy.md' } },
        ],
      }),
      JSON.stringify({ role: 'tool', content: 'legacy tool result', tool_call_id: 'toolu_legacy', name: 'read_file' }),
    ].join('\n') + '\n', 'utf-8');

    const restored = SessionStore.getInstance().loadContext('user:lifecycle-legacy-provider-replay');
    const migratedRaw = fs.readFileSync(sessionFile, 'utf-8');

    assert.deepStrictEqual(
      restored.map((message: any) => message.content),
      ['旧历史', null, '[历史工具结果已省略；read_file 已完成。]'],
    );
    assert.equal(restored.some((message: any) => Array.isArray(message.providerContent)), false);
    assert.equal(restored.some((message: any) => message.role === 'tool'), true);
    assert.equal(restored.some((message: any) => message.tool_calls?.length), true);
    assert.equal(
      restored.some((message: any) => message.role === 'tool' && message.tool_call_id === 'toolu_legacy'),
      true,
    );
    assert.doesNotMatch(migratedRaw, /legacy tool result/);
    assert.doesNotMatch(migratedRaw, /legacy hidden chain/);
    assert.doesNotMatch(migratedRaw, /legacy_sig/);
    assert.doesNotMatch(migratedRaw, /provider replay 隐藏内容/);
  });

  test('loading already-migrated provider replay placeholders strips them from assistant text', async () => {
    const { SessionStore } = loadSessionModules();
    const sessionFile = path.join(testRoot, 'data', 'sessions', 'user_lifecycle-placeholder-leak.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ role: 'user', content: '旧会话继续' }),
      JSON.stringify({
        role: 'assistant',
        content: '[历史工具调用已完成；provider replay 隐藏内容未写入本地会话。 工具调用: write_file。]\n[历史工具结果摘要]\n[工具 write_file] 写入了 report.md',
      }),
      JSON.stringify({
        role: 'assistant',
        content: '保留这句公开回复\n[历史工具调用已完成；provider replay 隐藏内容未写入本地会话。 工具调用: read_file。]\n继续保留这句',
      }),
    ].join('\n') + '\n', 'utf-8');

    const restored = SessionStore.getInstance().loadContext('user:lifecycle-placeholder-leak');
    const migratedRaw = fs.readFileSync(sessionFile, 'utf-8');

    assert.deepStrictEqual(
      restored.map((message: any) => message.content),
      ['旧会话继续', '保留这句公开回复\n继续保留这句'],
    );
    assert.doesNotMatch(migratedRaw, /历史工具调用已完成/);
    assert.doesNotMatch(migratedRaw, /历史工具结果摘要/);
    assert.doesNotMatch(migratedRaw, /写入了 report\.md/);
  });

  test('loading legacy sessions strips internal runtime error placeholders from assistant text', async () => {
    const { SessionStore } = loadSessionModules();
    const sessionFile = path.join(testRoot, 'data', 'sessions', 'user_lifecycle-runtime-error-leak.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ role: 'user', content: '继续处理' }),
      JSON.stringify({
        role: 'assistant',
        content: '[处理失败: API错误 (500): 500 {"type":"error","error":{"message":"anthropic: MaxRetriesExceededError: HTTPSConnectionPool(host=\'api.anthropic.com\')"}}]',
      }),
      JSON.stringify({ role: 'assistant', content: '[处理失败: unknown provider failure]' }),
      JSON.stringify({
        role: 'assistant',
        content: '[处理中断: 模型中转请求超时。错误摘要: request timed out]',
      }),
      JSON.stringify({
        role: 'assistant',
        content: '保留公开说明\n继续保留说明',
      }),
    ].join('\n') + '\n', 'utf-8');

    const restored = SessionStore.getInstance().loadContext('user:lifecycle-runtime-error-leak');
    const migratedRaw = fs.readFileSync(sessionFile, 'utf-8');

    assert.deepStrictEqual(
      restored.map((message: any) => message.content),
      ['继续处理', '保留公开说明\n继续保留说明'],
    );
    assert.doesNotMatch(migratedRaw, /处理失败/);
    assert.doesNotMatch(migratedRaw, /处理中断/);
    assert.doesNotMatch(migratedRaw, /api\.anthropic\.com/);
    assert.doesNotMatch(migratedRaw, /MaxRetriesExceededError/);
  });

  test('loading sessions preserves ordinary assistant text that only resembles an error note', async () => {
    const { SessionStore } = loadSessionModules();
    const sessionFile = path.join(testRoot, 'data', 'sessions', 'user_lifecycle-error-looking-text.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ role: 'user', content: '解释这段日志格式' }),
      JSON.stringify({
        role: 'assistant',
        content: '这是一段普通说明：\n[处理失败: 这是用户文档里的示例文本]\n它不应该被删除。',
      }),
      JSON.stringify({
        role: 'assistant',
        content: '这也是普通说明：\n[处理失败: API错误 (500): 用户文档里的示例文本]\n[历史工具结果摘要]\n这里是文档摘录。',
      }),
      JSON.stringify({
        role: 'assistant',
        content: '[历史工具结果摘要]\n这是用户文档标题，不是 provider replay。',
      }),
      JSON.stringify({
        role: 'assistant',
        content: '错误排查说明：\n[处理失败: API错误 (500): anthropic: MaxRetriesExceededError 是用户粘贴的日志示例]\n保留分析。',
      }),
      JSON.stringify({ role: 'user', content: '[处理失败: API错误 (500): 用户自己发来的文本也要保留]' }),
    ].join('\n') + '\n', 'utf-8');

    const restored = SessionStore.getInstance().loadContext('user:lifecycle-error-looking-text');

    assert.deepStrictEqual(
      restored.map((message: any) => message.content),
      [
        '解释这段日志格式',
        '这是一段普通说明：\n[处理失败: 这是用户文档里的示例文本]\n它不应该被删除。',
        '这也是普通说明：\n[处理失败: API错误 (500): 用户文档里的示例文本]\n[历史工具结果摘要]\n这里是文档摘录。',
        '[历史工具结果摘要]\n这是用户文档标题，不是 provider replay。',
        '错误排查说明：\n[处理失败: API错误 (500): anthropic: MaxRetriesExceededError 是用户粘贴的日志示例]\n保留分析。',
        '[处理失败: API错误 (500): 用户自己发来的文本也要保留]',
      ],
    );
  });

  test('handleMessage persists each completed turn before cleanup', async () => {
    const { AgentSession, SessionStore } = loadSessionModules();
    const session = new AgentSession('catscompany:lifecycle-autosave', buildMockServices(), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage('autosave user');

    assert.equal(result.text, 'ok');
    const restored = SessionStore.getInstance().loadContext('catscompany:lifecycle-autosave');
    assert.deepStrictEqual(
      restored.map(message => message.content),
      ['autosave user', 'ok'],
    );
  });

  test('handleMessage surfaces restored-history compaction as thinking status', async () => {
    const {
      AgentSession,
      SessionStore,
      CONTEXT_COMPACTION_START_MESSAGE,
      CONTEXT_COMPACTION_COMPLETE_MESSAGE,
    } = loadSessionModules();
    SessionStore.getInstance().saveContext('catscompany:lifecycle-compact-status', [
      { role: 'user', content: 'old user message' },
      { role: 'assistant', content: 'old assistant message' },
    ]);

    const session = new AgentSession('catscompany:lifecycle-compact-status', buildMockServices(), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');
    assert.equal(session.restoreFromStore(), true);

    const compactReasons: string[] = [];
    (session as any).contextWindowManager.compactIfNeeded = async (messages: any[], options: any) => {
      compactReasons.push(options.reason || '');
      if (options.reason === '恢复后') {
        await options.onStatus?.({
          status: 'start',
          sessionKey: 'catscompany:lifecycle-compact-status',
          reason: options.reason,
          usedTokens: 900,
          maxTokens: 1000,
          usagePercent: 90,
        });
        await options.onStatus?.({
          status: 'complete',
          sessionKey: 'catscompany:lifecycle-compact-status',
          reason: options.reason,
          usedTokens: 900,
          maxTokens: 1000,
          usagePercent: 90,
          messageCount: messages.length,
        });
      }
      return messages;
    };

    const thinking: string[] = [];
    await session.handleMessage('new user message', {
      callbacks: {
        onThinking: text => {
          thinking.push(text);
        },
      },
    });

    assert.deepStrictEqual(compactReasons, ['处理前', '恢复后']);
    assert.deepStrictEqual(thinking, [
      CONTEXT_COMPACTION_START_MESSAGE,
      CONTEXT_COMPACTION_COMPLETE_MESSAGE,
    ]);
  });

  test('handleMessage strips internal error artifacts before context compaction sees them', async () => {
    const { AgentSession } = loadSessionModules();
    const session = new AgentSession('catscompany:lifecycle-precompact-sanitize', buildMockServices(), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');
    (session as any).messages.push(
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '[处理失败: API错误 (500): 500 {"type":"error"}]' },
      { role: 'assistant', content: '普通回复保留' },
    );

    let preCompactMessages: any[] = [];
    (session as any).contextWindowManager.compactIfNeeded = async (messages: any[], options: any) => {
      if (options.reason === '处理前') {
        preCompactMessages = messages.map(message => ({ ...message }));
      }
      return messages;
    };

    await session.handleMessage('继续');

    assert.equal(preCompactMessages.some(message =>
      typeof message.content === 'string' && message.content.includes('处理失败')
    ), false);
    assert.equal(preCompactMessages.some(message => message.content === '普通回复保留'), true);
  });

  test('handleMessage preserves completed tool context when model relay times out', async () => {
    const { AgentSession, SessionStore, MODEL_TIMEOUT_MESSAGE } = loadSessionModules();
    let aiCalls = 0;
    const toolCall = {
      id: 'call_read',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'notes.txt' }),
      },
    };
    const session = new AgentSession('catscompany:lifecycle-timeout-recovery', buildMockServices({
      aiService: {
        async chatStream() {
          aiCalls++;
          if (aiCalls === 1) {
            return {
              content: null,
              toolCalls: [toolCall],
              usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
            };
          }
          throw new Error('API错误 (504): 504 {"type":"error","error":{"type":"request_timed_out","message":"request timed out (default is 30 seconds)"}}');
        },
      },
      toolManager: {
        getToolDefinitions() {
          return [{
            name: 'read_file',
            description: 'read file',
            parameters: {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
              },
              required: ['file_path'],
            },
          }];
        },
        async executeTool() {
          return {
            tool_call_id: 'call_read',
            role: 'tool',
            name: 'read_file',
            content: 'notes content',
            ok: true,
          };
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage('read notes then continue');

    assert.equal(result.text, MODEL_TIMEOUT_MESSAGE);
    assert.equal(aiCalls, 2);

    const retainedMessages = (session as any).messages as any[];
    assert.equal(retainedMessages.some(message => message.content === 'notes content'), true);
    assert.equal(retainedMessages.some(message =>
      message.role === 'assistant'
      && message.tool_calls?.[0]?.id === 'call_read'
    ), true);
    assert.equal(retainedMessages.some(message =>
      message.role === 'tool'
      && message.tool_call_id === 'call_read'
      && message.content === 'notes content'
    ), true);
    assert.equal(retainedMessages.some(message =>
      typeof message.content === 'string'
      && message.content.includes('模型中转请求超时')
    ), false);

    const restored = SessionStore.getInstance().loadContext('catscompany:lifecycle-timeout-recovery');
    assert.equal(restored.some(message => message.content === 'notes content'), true);
    assert.equal(restored.some(message =>
      typeof message.content === 'string'
      && message.content.includes('避免重复已经完成的工具步骤')
    ), false);
  });

  test('handleMessage surfaces relay budget exhaustion without leaking raw provider errors', async () => {
    const { AgentSession } = loadSessionModules();
    const session = new AgentSession('catscompany:lifecycle-model-budget', buildMockServices({
      aiService: {
        getConfig() {
          return { model: 'MiniMax-M3' };
        },
        async chatStream() {
          throw new Error('API错误 (402): {"type":"error","error":{"message":"model budget exceeded"}}');
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage('continue');

    assert.match(result.text, /当前模型 MiniMax-M3 的中转额度已用完/);
    assert.doesNotMatch(result.text, /model budget exceeded|API错误/i);
  });

  test('handleMessage surfaces account budget exhaustion when model config is unavailable', async () => {
    const { AgentSession } = loadSessionModules();
    const session = new AgentSession('catscompany:lifecycle-account-budget', buildMockServices({
      aiService: {
        async chatStream() {
          throw new Error('Request failed: Payment Required: monthly budget exceeded');
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage('continue');

    assert.match(result.text, /当前账号的中转额度已用完/);
    assert.doesNotMatch(result.text, /当前模型 当前模型/);
  });

  test('handleMessage does not treat unrelated 402 text as relay budget exhaustion', async () => {
    const { AgentSession, ERROR_MESSAGE } = loadSessionModules();
    const session = new AgentSession('catscompany:lifecycle-nonbudget-402', buildMockServices({
      aiService: {
        async chatStream() {
          throw new Error('API错误 (400): request body mentions 402 tokens but schema is invalid');
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage('continue');

    assert.equal(result.text, ERROR_MESSAGE);
  });

  test('handleMessage surfaces transient provider failures without leaking raw upstream payload', async () => {
    const { AgentSession } = loadSessionModules();
    const session = new AgentSession('catscompany:lifecycle-transient-provider', buildMockServices({
      aiService: {
        getConfig() {
          return { model: 'MiniMax-M3' };
        },
        async chatStream() {
          throw new Error('API错误 (500): 500 {"type":"error","error":{"type":"api_error","message":"unknown error, 520 (1000)"},"request_id":"req_123"}');
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage('continue');

    assert.match(result.text, /当前模型 MiniMax-M3 的服务临时异常/);
    assert.doesNotMatch(result.text, /unknown error|request_id|API错误|520/);
  });

  test('handleMessage treats wrapped 503 request errors as transient provider failures', async () => {
    const { AgentSession } = loadSessionModules();
    const session = new AgentSession('catscompany:lifecycle-transient-503', buildMockServices({
      aiService: {
        getConfig() {
          return { model: 'gpt-5.5' };
        },
        async chatStream() {
          throw new Error('API错误 (503): 503 请求错误(状态码: 503)');
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleMessage('继续');

    assert.match(result.text, /当前模型 gpt-5\.5 的服务临时异常/);
    assert.doesNotMatch(result.text, /API错误|状态码|503/);
  });

  test('cleanup persists without invoking hidden AI wakeup checks', async () => {
    const { AgentSession, SessionStore } = loadSessionModules();
    let aiCalls = 0;
    const session = new AgentSession('user:lifecycle-cleanup-no-wakeup', buildMockServices({
      aiService: {
        async chat() {
          aiCalls++;
          throw new Error('cleanup should not call AI');
        },
      },
    }), 'feishu');
    (session as any).messages.push(
      { role: 'user', content: 'cleanup user' },
      { role: 'assistant', content: 'cleanup assistant' },
    );

    await session.cleanup();

    assert.equal(aiCalls, 0);
    assert.deepStrictEqual(
      SessionStore.getInstance().loadContext('user:lifecycle-cleanup-no-wakeup').map(message => message.content),
      ['cleanup user', 'cleanup assistant'],
    );
    assert.equal((session as any).messages.length, 0);
  });

  test('summarizeAndDestroy clears conversation without AI summary', async () => {
    const { AgentSession } = loadSessionModules();
    let aiCalls = 0;
    const session = new AgentSession('user:lifecycle-exit-simple', buildMockServices({
      aiService: {
        async chat() {
          aiCalls++;
          throw new Error('exit should not call AI');
        },
      },
    }), 'feishu');
    (session as any).messages.push(
      { role: 'user', content: 'exit user message' },
      { role: 'assistant', content: 'exit assistant message' },
    );

    assert.equal(await session.summarizeAndDestroy(), true);
    assert.equal(aiCalls, 0);
    assert.equal((session as any).messages.length, 0);
  });

  test('summarizeAndDestroy returns false for an already empty session', async () => {
    const { AgentSession } = loadSessionModules();
    const session = new AgentSession('user:lifecycle-exit-empty', buildMockServices(), 'feishu');

    assert.equal(await session.summarizeAndDestroy(), false);
    assert.equal((session as any).messages.length, 0);
  });
});

function loadSessionModules(): any {
  for (const modulePath of [
    '../src/core/agent-session',
    '../src/core/session-lifecycle-manager',
    '../src/utils/session-store',
    '../src/core/session-router',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  return {
    AgentSession: require('../src/core/agent-session').AgentSession,
    ERROR_MESSAGE: require('../src/core/agent-session').ERROR_MESSAGE,
    MODEL_TIMEOUT_MESSAGE: require('../src/core/agent-session').MODEL_TIMEOUT_MESSAGE,
    MODEL_TRANSIENT_ERROR_MESSAGE: require('../src/core/agent-session').MODEL_TRANSIENT_ERROR_MESSAGE,
    CONTEXT_COMPACTION_START_MESSAGE: require('../src/core/agent-session').CONTEXT_COMPACTION_START_MESSAGE,
    CONTEXT_COMPACTION_COMPLETE_MESSAGE: require('../src/core/agent-session').CONTEXT_COMPACTION_COMPLETE_MESSAGE,
    SessionStore: require('../src/utils/session-store').SessionStore,
    createSessionRoute: require('../src/core/session-router').createSessionRoute,
    createCatsCoSessionRoute: require('../src/core/session-router').createCatsCoSessionRoute,
  };
}

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: {
      async chat() {
        return { content: 'summary' };
      },
      async chatStream() {
        return { content: 'ok', toolCalls: [] };
      },
      ...(overrides.aiService || {}),
    },
    toolManager: overrides.toolManager ?? {
      getToolDefinitions() { return []; },
      executeTool() { throw new Error('not expected'); },
    },
    skillManager: {
      getSkill() { return undefined; },
      getUserInvocableSkills() { return []; },
      getAutoInvocableSkills() { return []; },
      findAutoInvocableSkillByText() { return undefined; },
      loadSkills: async () => {},
    },
  };
}

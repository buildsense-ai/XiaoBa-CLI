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

  test('runtime state preserves session identity when current directory changes', () => {
    const { SessionStore } = loadSessionModules();
    const store = SessionStore.getInstance();
    store.saveRuntimeState('cc_user:identity-state', {
      sessionIdentity: {
        schemaVersion: 1,
        sessionId: 'cc_user:identity-state',
        legacySessionKey: 'cc_user:identity-state',
        sessionType: 'catscompany',
        channel: 'catsco',
        actor: { actorUserId: 'usr1', externalUserId: 'usr1' },
        topic: { topicId: 'p2p_1_2', topicType: 'p2p', channelSeq: 9 },
      },
    });
    store.saveRuntimeState('cc_user:identity-state', {
      currentDirectory: testRoot,
    });

    const state = store.loadRuntimeState('cc_user:identity-state');
    assert.equal(state.currentDirectory, testRoot);
    assert.equal(state.sessionIdentity?.actor?.actorUserId, 'usr1');
    assert.equal(state.sessionIdentity?.topic?.channelSeq, 9);
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
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  return {
    AgentSession: require('../src/core/agent-session').AgentSession,
    SessionStore: require('../src/utils/session-store').SessionStore,
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

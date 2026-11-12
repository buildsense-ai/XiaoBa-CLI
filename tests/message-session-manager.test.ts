import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('MessageSessionManager', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-message-session-manager-'));
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  for (const createBeforeMidnight of [false, true]) {
    test(`keeps receipts in the execution log across midnight (${createBeforeMidnight ? 'existing session' : 'restoration pending'})`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1, 23, 59).getTime() });
      const { MessageSessionManager, createSessionRoute } = loadSessionManagerModules();
      const manager = new MessageSessionManager(buildMockServices(), 'catscompany');
      const route = createSessionRoute({
        source: 'catscompany', topicType: 'p2p', topicId: `midnight-${createBeforeMidnight}`,
        actorUserId: 'usr7', agentId: '43', identityTrust: 'server_canonical',
      });
      let logger: any;
      try {
        const earlySession = createBeforeMidnight ? manager.getOrCreate(route) : null;
        const recorder = manager.getInputReceiptRecorder(route);
        const firstId = recorder.recordInputReceipt('before midnight');
        logger = earlySession ? (earlySession as any).sessionTurnLogger : recorder;
        const file = logger.getLogFilePath();
        assert.equal(manager.get(route), earlySession, 'receipt must not create a session');
        assert.match(file, /2026-01-01/);

        t.mock.timers.setTime(new Date(2026, 0, 2, 0, 1).getTime());
        const session = manager.getOrCreate(route);
        const secondId = manager.getInputReceiptRecorder(route).recordInputReceipt('after midnight');
        assert.strictEqual((session as any).sessionTurnLogger, logger);
        assert.equal((manager as any).receiptLoggers.size, 0);
        const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
          .filter(entry => entry.event?.type === 'input_received');
        assert.deepEqual(entries.map(entry => entry.event.input_id), [firstId, secondId]);
        assert.deepEqual(entries.map(entry => entry.event.text), ['before midnight', 'after midnight']);
        assert.ok(entries.every(entry => entry.agent_identity.agent_id === 'usr43'));
        assert.ok(entries.every(entry => entry.agent_identity.trust === 'server_canonical'));
        assert.equal(entries[1].timestamp, new Date(2026, 0, 2, 0, 1).toISOString());
      } finally {
        await manager.destroy();
        if (logger) fs.rmSync(logger.getLogFilePath(), { force: true });
      }
    });
  }

  test('expires receipt-only writers without deleting accepted input', async () => {
    const { MessageSessionManager } = loadSessionManagerModules();
    const manager = new MessageSessionManager(buildMockServices(), 'receipt-ttl-test', { ttl: 10 });
    const recorder = manager.getInputReceiptRecorder('user:pending-recovery') as any;
    const inputId = recorder.recordInputReceipt('accepted but recovery failed');
    try {
      const pending = (manager as any).receiptLoggers.get('user:pending-recovery');
      await (manager as any).cleanupExpiredSessions(pending.lastActiveAt + 11);
      assert.equal((manager as any).receiptLoggers.size, 0);
      assert.equal(manager.get('user:pending-recovery'), null);
      assert.match(fs.readFileSync(recorder.getLogFilePath(), 'utf8'), new RegExp(inputId));
    } finally {
      await manager.destroy();
      fs.rmSync(recorder.getLogFilePath(), { force: true });
    }
  });

  test('injects system prompt providers into newly created sessions', async () => {
    const { MessageSessionManager } = loadSessionManagerModules();
    const manager = new MessageSessionManager(buildMockServices(), 'feishu-test', {
      systemPromptProviderFactory: (sessionKey: string) => () => `system prompt for ${sessionKey}`,
    });

    try {
      const session = manager.getOrCreate('user:adapter-demo');
      await session.init();

      const messages = (session as any).messages;
      assert.equal(messages[0].role, 'system');
      assert.match(messages[0].content, /^system prompt for user:adapter-demo/);
      assert.doesNotMatch(messages[0].content, /\[surface:/);
    } finally {
      await manager.destroy();
    }
  });

  test('initializes provider system prompt before injected context', async () => {
    const { MessageSessionManager } = loadSessionManagerModules();
    const manager = new MessageSessionManager(buildMockServices(), 'context-order-test', {
      systemPromptProviderFactory: (sessionKey: string) => () => `system prompt for ${sessionKey}`,
    });
    manager.setContextInjector((session: any) => session.injectContext('adapter context'));

    try {
      const session = manager.getOrCreate('user:context-demo');
      await session.init();

      const messages = (session as any).messages;
      assert.match(messages[0].content, /^system prompt for user:context-demo/);
      assert.doesNotMatch(messages[0].content, /\[surface:/);
      assert.equal(messages[1].content, 'adapter context');
      assert.equal(messages[1].__injected, true);
    } finally {
      await manager.destroy();
    }
  });

  test('restores persisted history before adapter injected context', async () => {
    const { MessageSessionManager, SessionStore } = loadSessionManagerModules();
    SessionStore.getInstance().saveContext('user:restore-demo', [
      { role: 'user', content: 'old user message' },
      { role: 'assistant', content: 'old assistant message' },
    ]);
    const manager = new MessageSessionManager(buildMockServices(), 'context-restore-test', {
      systemPromptProviderFactory: (sessionKey: string) => () => `system prompt for ${sessionKey}`,
    });
    manager.setContextInjector((session: any) => session.injectContext('adapter context'));

    try {
      const session = manager.getOrCreate('user:restore-demo');
      await session.init();

      const messages = (session as any).messages;
      assert.match(messages[0].content, /^system prompt for user:restore-demo/);
      assert.equal(messages[1].content, 'old user message');
      assert.equal(messages[2].content, 'old assistant message');
      assert.equal(messages[3].content, 'adapter context');
      assert.equal(messages[3].__injected, true);
    } finally {
      await manager.destroy();
    }
  });

  test('restores legacy session history when creating a V2 routed session', async () => {
    const { MessageSessionManager, SessionStore, createSessionRoute } = loadSessionManagerModules();
    SessionStore.getInstance().saveContext('user:legacy-route-demo', [
      { role: 'user', content: 'legacy user message' },
      { role: 'assistant', content: 'legacy assistant message' },
    ]);
    const route = createSessionRoute({
      source: 'feishu',
      topicType: 'p2p',
      topicId: 'chat-route-demo',
      actorUserId: 'legacy-route-demo',
      identityTrust: 'legacy_context',
      legacySessionKey: 'user:legacy-route-demo',
    });
    const manager = new MessageSessionManager(buildMockServices(), 'feishu', {
      systemPromptProviderFactory: (sessionKey: string) => () => `system prompt for ${sessionKey}`,
    });

    try {
      const session = manager.getOrCreate(route);
      await session.init();

      const messages = (session as any).messages;
      assert.match(messages[0].content, /^system prompt for session:v2:feishu:p2p:chat-route-demo/);
      assert.doesNotMatch(messages[0].content, /\[surface:/);
      assert.equal(messages[1].content, 'legacy user message');
      assert.equal(messages[2].content, 'legacy assistant message');

      (session as any).messages.push({ role: 'assistant', content: 'new canonical reply' });
      await manager.destroy();

      assert.deepEqual(
        SessionStore.getInstance().loadContext(route.sessionKey).map((message: any) => message.content),
        ['legacy user message', 'legacy assistant message', 'new canonical reply'],
      );
    } finally {
      await manager.destroy();
    }
  });

  test('does not restore broad CatsCo legacy history for V2 sessions', async () => {
    const { MessageSessionManager, SessionStore, createSessionRoute } = loadSessionManagerModules();
    SessionStore.getInstance().saveContext('cc_user:usr99', [
      { role: 'user', content: 'legacy CatsCo history from another bot' },
      { role: 'assistant', content: 'legacy CatsCo reply' },
    ]);
    const routes = [
      createSessionRoute({
        source: 'catscompany',
        topicType: 'p2p',
        topicId: 'p2p_99_298',
        actorUserId: 'usr99',
        agentId: 'usr298',
        identityTrust: 'legacy_context',
        legacySessionKey: 'cc_user:usr99',
      }),
      createSessionRoute({
        source: 'catscompany',
        topicType: 'p2p',
        topicId: 'p2p_99_299',
        actorUserId: 'usr99',
        agentId: 'usr299',
        identityTrust: 'legacy_context',
        legacySessionKey: 'cc_user:usr99',
      }),
      createSessionRoute({
        source: 'catscompany',
        topicType: 'p2p',
        topicId: 'p2p_99_unknown',
        actorUserId: 'usr99',
        identityTrust: 'legacy_context',
        legacySessionKey: 'cc_user:usr99',
      }),
    ];
    const manager = new MessageSessionManager(buildMockServices(), 'catscompany', {
      systemPromptProviderFactory: (sessionKey: string) => () => `system prompt for ${sessionKey}`,
    });

    try {
      for (const route of routes) {
        const session = manager.getOrCreate(route);
        await session.init();
        const contents = ((session as any).messages as any[]).map(message => message.content);

        assert.equal(contents.includes('legacy CatsCo history from another bot'), false);
        assert.match(contents[0], new RegExp(`^system prompt for ${route.sessionKey}`));
      }
    } finally {
      await manager.destroy();
    }
  });

  test('injects skill reload handler into newly created sessions', async () => {
    const { MessageSessionManager } = loadSessionManagerModules();
    let reloadCount = 0;
    const manager = new MessageSessionManager(buildMockServices(), 'skill-reload-test', {
      systemPromptProviderFactory: (sessionKey: string) => () => `system prompt for ${sessionKey}`,
      skillReloadHandler: async () => {
        reloadCount++;
      },
    });

    try {
      const session = manager.getOrCreate('user:skill-reload-demo');
      await (session as any).skillRuntime.reloadSkills();

      assert.equal(reloadCount, 1);
    } finally {
      await manager.destroy();
    }
  });

  test('keeps numeric ttl constructor compatibility', async () => {
    const { MessageSessionManager } = loadSessionManagerModules();
    const manager = new MessageSessionManager(buildMockServices(), 'legacy-ttl-test', 1234);

    try {
      assert.equal((manager as any).ttl, 1234);
    } finally {
      await manager.destroy();
    }
  });

  test('reports idle only when sessions and their subagents are inactive', async () => {
    const { MessageSessionManager, SubAgentManager } = loadSessionManagerModules();
    const manager = new MessageSessionManager(buildMockServices(), 'runtime-reload-idle-test');
    const subAgentManager = SubAgentManager.getInstance();
    const originalHasActiveForParent = subAgentManager.hasActiveForParent.bind(subAgentManager);

    try {
      assert.equal(manager.isIdle(), true);
      const session = manager.getOrCreate('user:runtime-reload');
      const originalIsBusy = session.isBusy.bind(session);
      (session as any).isBusy = () => true;
      assert.equal(manager.isIdle(), false);

      (session as any).isBusy = originalIsBusy;
      (subAgentManager as any).hasActiveForParent = (key: string) => key === session.key;
      assert.equal(manager.isIdle(), false);

      (subAgentManager as any).hasActiveForParent = () => false;
      assert.equal(manager.isIdle(), true);
    } finally {
      (subAgentManager as any).hasActiveForParent = originalHasActiveForParent;
      await manager.destroy();
    }
  });

  test('ttl cleanup saves expired sessions without hidden AI wakeup', async () => {
    const { MessageSessionManager, SessionStore } = loadSessionManagerModules();
    let aiCalls = 0;
    const manager = new MessageSessionManager(buildMockServices({
      aiService: {
        async chat() {
          aiCalls++;
          throw new Error('ttl cleanup should not call AI');
        },
      },
    }), 'ttl-cleanup-test', { ttl: 10 });

    try {
      const session = manager.getOrCreate('user:ttl-expired');
      (session as any).messages.push(
        { role: 'user', content: 'expire user' },
        { role: 'assistant', content: 'expire assistant' },
      );
      session.lastActiveAt = 100;

      await (manager as any).cleanupExpiredSessions(111);

      assert.equal(aiCalls, 0);
      assert.equal((manager as any).sessions.has('user:ttl-expired'), false);
      assert.deepStrictEqual(
        SessionStore.getInstance().loadContext('user:ttl-expired').map((message: any) => message.content),
        ['expire user', 'expire assistant'],
      );
    } finally {
      await manager.destroy();
    }
  });

  test('ttl cleanup keeps sessions with active subagents', async () => {
    const { MessageSessionManager, SubAgentManager } = loadSessionManagerModules();
    const manager = new MessageSessionManager(buildMockServices(), 'ttl-active-subagent-test', { ttl: 10 });
    const subAgentManager = SubAgentManager.getInstance();
    const originalHasActiveForParent = subAgentManager.hasActiveForParent.bind(subAgentManager);
    (subAgentManager as any).hasActiveForParent = (key: string) => key === 'user:ttl-active-subagent';

    try {
      const session = manager.getOrCreate('user:ttl-active-subagent');
      session.lastActiveAt = 100;

      await (manager as any).cleanupExpiredSessions(111);

      assert.equal((manager as any).sessions.has('user:ttl-active-subagent'), true);
      assert.equal(session.lastActiveAt, 111);
    } finally {
      (subAgentManager as any).hasActiveForParent = originalHasActiveForParent;
      await manager.destroy();
    }
  });

  test('ttl cleanup does not remove a new same-key session created while old cleanup is pending', async () => {
    const { MessageSessionManager } = loadSessionManagerModules();
    const manager = new MessageSessionManager(buildMockServices(), 'ttl-race-test', { ttl: 10 });
    let releaseCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>(resolve => {
      releaseCleanup = resolve;
    });

    try {
      const oldSession = manager.getOrCreate('user:ttl-race');
      oldSession.lastActiveAt = 100;
      (oldSession as any).cleanup = async () => cleanupReleased;

      const cleanupPromise = (manager as any).cleanupExpiredSessions(111);
      assert.equal((manager as any).sessions.has('user:ttl-race'), false);

      const newSession = manager.getOrCreate('user:ttl-race');
      assert.notStrictEqual(newSession, oldSession);
      assert.strictEqual((manager as any).sessions.get('user:ttl-race'), newSession);

      releaseCleanup?.();
      await cleanupPromise;

      assert.strictEqual((manager as any).sessions.get('user:ttl-race'), newSession);
    } finally {
      releaseCleanup?.();
      await manager.destroy();
    }
  });
});

function loadSessionManagerModules(): any {
  for (const modulePath of [
    '../src/core/message-session-manager',
    '../src/core/agent-session',
    '../src/core/sub-agent-manager',
    '../src/core/session-lifecycle-manager',
    '../src/utils/session-store',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  return {
    MessageSessionManager: require('../src/core/message-session-manager').MessageSessionManager,
    SubAgentManager: require('../src/core/sub-agent-manager').SubAgentManager,
    SessionStore: require('../src/utils/session-store').SessionStore,
    createSessionRoute: require('../src/core/session-router').createSessionRoute,
  };
}

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: {
      ...(overrides.aiService || {}),
    },
    toolManager: {
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

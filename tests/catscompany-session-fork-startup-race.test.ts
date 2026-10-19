import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatsCompanyBot } from '../src/catscompany';
import { SessionStore } from '../src/utils/session-store';

// Exercise the real command/resume paths with deterministic async barriers and isolated storage.
for (const checkpoint of [1, 2, 'notice', 'direct'] as const) {
  for (const command of ['stop', 'clear']) {
    test(`${command} cancels startup resume at ${checkpoint}`, async t => {
      const key = 'cc_group:grp_22';
      const topic = 'grp_22';
      let state: any = { interruptedTurn: { sessionKey: key, topic, reason: 'oom',
        startedAt: new Date().toISOString(), attempts: 0 } };
      const marker = structuredClone(state.interruptedTurn);
      let local = false;
      const events: string[] = [];
      t.mock.method(SessionStore, 'getInstance', () => ({
        getForkIdentity: () => undefined, hasSession: () => local,
        loadRuntimeState: () => state,
        saveRuntimeState: (_key: string, next: any) => { state = next; return true; },
      }) as any);
      let entered!: () => void;
      let release!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      let lookups = 0;
      const session = {
        isBusy: () => false,
        requestInterrupt: () => { events.push('interrupt'); },
        handleRuntimeObservation: async () => { events.push('observation'); return { text: '', visibleToUser: false }; },
        handleCommand: async () => { local = true; events.push('cleared'); return { handled: true, reply: 'cleared' }; },
      };
      const bot = Object.create(CatsCompanyBot.prototype) as any;
      Object.assign(bot, {
        botUid: 'usr9', connectorReady: true, shuttingDown: false, activeMessageHandlers: 0,
        resumedInterruptedTurns: new Set(), sessionExecutionReservations: new Set(),
        activeConversationTasks: new Map(), activeSessionMessageHandlers: new Map(),
        messageQueue: new Map(), pendingAttachments: new Map(), subAgentCompletionBatches: new Map(),
        sessionClearGenerations: new Map(), sessionStopGenerations: new Map(),
        cloudSessionRestorePromises: new Map(), cloudSessionRestoreAbortControllers: new Map(),
        sessionManager: { get: () => session, getOrCreate: () => { events.push('create'); return session; } },
        bot: { getSessionFork: async () => {
          lookups++;
          if (lookups === checkpoint || (checkpoint === 'direct' && lookups === 1)) { events.push('guard-paused'); entered(); await wait; }
          return undefined;
        } },
        sender: { reply: async () => {
          if (checkpoint === 'notice' && !events.includes('notice-paused')) {
            events.push('notice-paused'); entered(); await wait;
          }
          events.push('reply-complete');
        } },
        cloudSessionRestorer: { markLocalSessionCleared: () => true },
        startTypingHeartbeat: () => () => undefined,
        buildChannel: () => ({}), buildSessionCallbacks: () => ({}),
        buildDeviceRpcTransport: () => undefined, maybeBuildThinToolRpcTransport: () => undefined,
      });
      const resume = checkpoint === 'direct'
        ? bot.runInterruptedTurnResume(key, topic, 'resume')
        : bot.resumeOneInterruptedTurn(marker);
      await paused;
      assert.equal(events.includes('observation'), false);
      if (checkpoint === 2) assert.ok(events.indexOf('reply-complete') < events.indexOf('guard-paused'), 'notice completed before the race');
      await bot.onMessage({ topic, senderId: 'usr7', text: `/${command}`, content: `/${command}`,
        isGroup: true, memberCount: 2, botCount: 1, seq: 21 });
      assert.equal(state.interruptedTurn, undefined, 'control retired old marker');
      const createsBeforeRelease = events.filter(x => x === 'create').length;
      release();
      await resume;
      assert.equal(events.filter(x => x === 'create').length, createsBeforeRelease, 'cancelled resume must not getOrCreate again');
      assert.equal(bot.sessionExecutionReservations.size, 0);
      const observations = events.filter(x => x === 'observation').length;
      assert.equal(observations, 0, 'cancelled old work must not start after provenance returns');
    });
  }
}

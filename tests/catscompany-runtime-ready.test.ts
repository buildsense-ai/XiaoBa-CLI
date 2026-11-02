import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { CatsCompanyBot } from '../src/catscompany';
import { recoverCloudModelFallbackConnector } from '../src/commands/catscompany';

describe('CatsCompanyBot runtime readiness', () => {
  test('coalesces reconnect reconciliation and permits a later retry', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = '43';
    let calls = 0;
    let release!: () => void;
    let task: Promise<void>;
    bot.runTrackedConversationWork = (work: () => Promise<void>) => (task = work());
    bot.waitForSkillHubRuntimeIdle = () => new Promise<boolean>(resolve => {
      calls += 1;
      release = () => resolve(false);
    });
    bot.reconcileSkillDefinitionAfterReconnect('43');
    bot.reconcileSkillDefinitionAfterReconnect('43');
    assert.equal(calls, 1);
    release();
    await task!;
    await new Promise(resolve => setImmediate(resolve));
    bot.reconcileSkillDefinitionAfterReconnect('43');
    assert.equal(calls, 2);
    release();
    await task!;
  });

  test('does not apply a stale Bot after waiting for idle', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = '43';
    let task: Promise<void>;
    let applied = 0;
    bot.runTrackedConversationWork = (work: () => Promise<void>) => (task = work());
    bot.waitForSkillHubRuntimeIdle = async () => { bot.botUid = '44'; return true; };
    bot.applySkillHubBotDefinition = async () => { applied += 1; return {}; };
    bot.reconcileSkillDefinitionAfterReconnect('43');
    await task!;
    assert.equal(applied, 0);
  });

  test('waits for the connector handshake before resolving', async () => {
    const events = new EventEmitter();
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.bot = events;
    bot.connectorReady = false;

    let resolved = false;
    const pending = bot.waitUntilReady(1_000).then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(resolved, false);

    bot.connectorReady = true;
    events.emit('ready', { uid: '43', name: 'Bot' });
    await pending;
    assert.equal(resolved, true);
  });

  test('rejects when the connector never completes its handshake', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.bot = new EventEmitter();
    bot.connectorReady = false;

    await assert.rejects(bot.waitUntilReady(20), /handshake timed out/);
    assert.equal(bot.bot.listenerCount('ready'), 0);
  });

  test('retries fallback construction until an old-model connector can start', async () => {
    let attempts = 0;
    let destroyed = 0;
    let replacement: unknown;
    const recovered = {
      start: async () => undefined,
      waitUntilReady: async () => undefined,
      destroy: async () => { destroyed += 1; },
    };

    await recoverCloudModelFallbackConnector({
      canApply: () => true,
      retryDelayMs: 0,
      createBot: () => {
        attempts += 1;
        if (attempts < 3) {
          return {
            start: async () => { throw new Error('temporary startup failure'); },
            waitUntilReady: async () => undefined,
            destroy: async () => { destroyed += 1; },
          } as any;
        }
        return recovered as any;
      },
      replaceBot: bot => { replacement = bot; },
    });

    assert.equal(attempts, 3);
    assert.equal(destroyed, 2);
    assert.equal(replacement, recovered);
  });

  test('keeps a started fallback alive when its websocket will continue reconnecting', async () => {
    let destroyed = 0;
    let replacement: unknown;
    const fallback = {
      start: async () => undefined,
      waitUntilReady: async () => { throw new Error('handshake timeout'); },
      destroy: async () => { destroyed += 1; },
    };

    await recoverCloudModelFallbackConnector({
      canApply: () => true,
      retryDelayMs: 0,
      createBot: () => fallback as any,
      replaceBot: bot => { replacement = bot; },
    });

    assert.equal(replacement, fallback);
    assert.equal(destroyed, 0);
  });
});

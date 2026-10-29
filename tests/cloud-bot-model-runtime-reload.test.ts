import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CloudBotModelRuntimeReloadController } from '../src/bot-definition/runtime-reload';
import type { CloudBotModelSelection } from '../src/bot-definition/cloud-client';

describe('CloudBotModelRuntimeReloadController', () => {
  for (const revision of [undefined, 5, 7, 8]) {
    test(`startup pending revision 7 only accepts same/newer cloud revision: ${revision}`, async () => {
      const applied: number[] = [];
      const controller = new CloudBotModelRuntimeReloadController({
        initialPendingRevision: 7,
        pullSelection: async () => revision === undefined ? undefined : { modelId: 'm', revision },
        isIdle: () => true,
        applySelection: async value => { applied.push(value.revision); return 'applied'; },
      });
      await controller.pollOnce();
      await controller.pollOnce();
      assert.deepEqual(applied, revision !== undefined && revision >= 7 ? [revision] : []);
    });
  }

  test('an already applied startup revision is not prepared or restarted', async () => {
    const controller = new CloudBotModelRuntimeReloadController({
      initialRevision: 7, initialPendingRevision: 7,
      pullSelection: async () => ({ modelId: 'm', revision: 7 }), isIdle: () => true,
      applySelection: async () => assert.fail('must not restart'),
    });
    await controller.pollOnce();
  });

  test('persistent deferrals back off to 60 seconds and a newer revision bypasses the delay', async () => {
    let now = 0;
    let revision = 7;
    const attempts: number[] = [];
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now, random: () => 0,
      pullSelection: async () => ({ modelId: 'm', revision }), isIdle: () => true,
      applySelection: async () => { attempts.push(now); return 'deferred'; },
    });
    for (now = 0; now <= 200000; now += 1000) await controller.pollOnce();
    assert.deepEqual(attempts, [0, 5000, 15000, 35000, 75000, 135000, 195000]);
    revision = 8;
    await controller.pollOnce();
    assert.equal(attempts.at(-1), 201000);
  });

  test('shutdown fences a late poll and concurrent polls do not overlap', async () => {
    let active = true;
    let finish!: (value: CloudBotModelSelection) => void;
    let polls = 0;
    const controller = new CloudBotModelRuntimeReloadController({
      isActive: () => active, isIdle: () => true,
      pullSelection: () => { polls++; return new Promise(resolve => { finish = resolve; }); },
      applySelection: async () => assert.fail('must not apply after shutdown'),
    });
    const pending = controller.pollOnce();
    await controller.pollOnce();
    active = false;
    finish({ modelId: 'm', revision: 7 });
    await pending;
    await controller.pollOnce();
    assert.equal(polls, 1);
  });
  test('applies each new revision once', async () => {
    let selection: CloudBotModelSelection | undefined = { modelId: 'minimax-m3', revision: 2 };
    const applied: number[] = [];
    const controller = new CloudBotModelRuntimeReloadController({
      initialRevision: 1,
      pullSelection: async () => selection,
      isIdle: () => true,
      applySelection: async value => {
        applied.push(value.revision);
        return 'applied';
      },
    });

    await controller.pollOnce();
    await controller.pollOnce();
    selection = { modelId: 'gpt-5.6-terra', reasoningEffort: 'high', revision: 3 };
    await controller.pollOnce();

    assert.deepStrictEqual(applied, [2, 3]);
  });

  test('keeps the latest revision pending until the runtime is idle', async () => {
    let idle = false;
    let selection: CloudBotModelSelection | undefined = { modelId: 'minimax-m3', revision: 2 };
    const applied: CloudBotModelSelection[] = [];
    const controller = new CloudBotModelRuntimeReloadController({
      pullSelection: async () => selection,
      isIdle: () => idle,
      applySelection: async value => {
        applied.push(value);
        return 'applied';
      },
    });

    await controller.pollOnce();
    selection = { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium', revision: 3 };
    await controller.pollOnce();
    idle = true;
    await controller.pollOnce();

    assert.deepStrictEqual(applied, [selection]);
  });

  test('retries the same revision after a transient apply deferral', async () => {
    const selection: CloudBotModelSelection = { modelId: 'glm-5.3-flash', revision: 4 };
    let attempts = 0;
    let now = 0;
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now, random: () => 0,
      pullSelection: async () => selection,
      isIdle: () => true,
      applySelection: async () => {
        attempts += 1;
        return attempts === 1 ? 'deferred' : 'applied';
      },
    });

    await controller.pollOnce();
    now = 5000;
    await controller.pollOnce();
    await controller.pollOnce();

    assert.equal(attempts, 2);
  });

  test('does not loop a failed revision and allows a newer retry revision', async () => {
    let selection: CloudBotModelSelection = { modelId: 'gpt-5.6-luna', revision: 4 };
    const attempts: number[] = [];
    const errors: number[] = [];
    const controller = new CloudBotModelRuntimeReloadController({
      pullSelection: async () => selection,
      isIdle: () => true,
      applySelection: async value => {
        attempts.push(value.revision);
        throw new Error('reload failed');
      },
      onError: (_error, value) => errors.push(value?.revision ?? -1),
    });

    await controller.pollOnce();
    await controller.pollOnce();
    selection = { ...selection, revision: 5 };
    await controller.pollOnce();

    assert.deepStrictEqual(attempts, [4, 5]);
    assert.deepStrictEqual(errors, [4, 5]);
  });

  test('drops a deferred cloud selection after cloud management is disabled', async () => {
    let selection: CloudBotModelSelection | undefined = { modelId: 'minimax-m3', revision: 2 };
    let idle = false;
    let applyCount = 0;
    const controller = new CloudBotModelRuntimeReloadController({
      pullSelection: async () => selection,
      isIdle: () => idle,
      applySelection: async () => {
        applyCount += 1;
        return 'applied';
      },
    });

    await controller.pollOnce();
    selection = undefined;
    await controller.pollOnce();
    idle = true;
    await controller.pollOnce();

    assert.equal(applyCount, 0);
  });

  test('reports an in-flight poll that has stopped making progress', async () => {
    let now = 1_000;
    let finish!: (value: CloudBotModelSelection | undefined) => void;
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now,
      pullSelection: () => new Promise(resolve => { finish = resolve; }),
      isIdle: () => true,
      applySelection: async () => assert.fail('an unresolved poll must not apply'),
    });

    const pending = controller.pollOnce();
    now = 51_000;
    assert.deepStrictEqual(controller.getHealth(), {
      polling: true,
      createdAt: 1_000,
      lastPollStartedAt: 1_000,
      handledRevision: -1,
      pollAgeMs: 50_000,
    });

    finish(undefined);
    await pending;
    assert.deepStrictEqual(controller.getHealth(), {
      polling: false,
      createdAt: 1_000,
      lastPollStartedAt: 1_000,
      lastPollCompletedAt: 51_000,
      handledRevision: -1,
      pollAgeMs: 0,
    });
  });

  test('tracks the age of an unapplied revision and clears it after apply', async () => {
    let now = 100;
    let idle = false;
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now,
      pullSelection: async () => ({ modelId: 'deepseek-flash', revision: 34 }),
      isIdle: () => idle,
      applySelection: async () => 'applied',
    });

    await controller.pollOnce();
    now = 120_100;
    assert.deepStrictEqual(controller.getHealth(), {
      polling: false,
      createdAt: 100,
      lastPollStartedAt: 100,
      lastPollCompletedAt: 100,
      handledRevision: -1,
      pendingRevision: 34,
      pendingSince: 100,
      pendingAgeMs: 120_000,
      // The wait itself is now tracked, so a switch that never lands is visible
      // in the watchdog snapshot instead of looking like an idle controller.
      deferredMs: 120_000,
      deferredAttempts: 1,
      pollAgeMs: 120_000,
    });

    idle = true;
    await controller.pollOnce();
    assert.deepStrictEqual(controller.getHealth(), {
      polling: false,
      createdAt: 100,
      lastPollStartedAt: 120_100,
      lastPollCompletedAt: 120_100,
      handledRevision: 34,
      pollAgeMs: 0,
    });
  });

  test('reports a switch that stays deferred instead of leaving it silent', async () => {
    let now = 0;
    const stalls: Array<{ revision: number; deferredMs: number; attempts: number; idle: boolean }> = [];
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now,
      random: () => 0,
      deferredStallMs: 60_000,
      pullSelection: async () => ({ modelId: 'deepseek-flash', revision: 9 }),
      // The runtime is busy because the current model keeps failing, which is
      // exactly the state that used to make the switch silent forever.
      isIdle: () => false,
      applySelection: async () => 'deferred',
      onDeferredStalled: (selection, info) => {
        stalls.push({ revision: selection.revision, ...info });
      },
    });

    for (now = 0; now <= 300_000; now += 5_000) await controller.pollOnce();

    assert.equal(stalls.length, 1, 'a stalled switch is escalated once, not on every poll');
    assert.equal(stalls[0].revision, 9);
    assert.equal(stalls[0].idle, false);
    assert.ok(stalls[0].deferredMs >= 60_000);
  });

  test('crosses the idle fence when a deferred switch cannot wait any longer', async () => {
    let now = 0;
    const applied: Array<{ revision: number; forced: boolean }> = [];
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now,
      random: () => 0,
      forceApplyAfterMs: 120_000,
      pullSelection: async () => ({ modelId: 'deepseek-flash', revision: 11 }),
      isIdle: () => false,
      applySelection: async (selection, options) => {
        applied.push({ revision: selection.revision, forced: options?.force === true });
        return options?.force ? 'applied' : 'deferred';
      },
    });

    for (now = 0; now <= 300_000; now += 5_000) await controller.pollOnce();

    assert.equal(applied.length, 1, 'the fence is crossed once, then the revision is applied');
    assert.deepEqual(applied[0], { revision: 11, forced: true });
    assert.equal(controller.getHealth().handledRevision, 11);
  });

  test('a busy runtime without a force budget keeps waiting instead of interrupting', async () => {
    let now = 0;
    let applies = 0;
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now,
      pullSelection: async () => ({ modelId: 'deepseek-flash', revision: 12 }),
      isIdle: () => false,
      applySelection: async () => { applies += 1; return 'deferred'; },
    });

    for (now = 0; now <= 600_000; now += 5_000) await controller.pollOnce();

    assert.equal(applies, 0, 'without forceApplyAfterMs the idle fence is never crossed');
    assert.equal(controller.getHealth().pendingRevision, 12);
  });

  test('a failed revision stays retryable instead of being retired by one throw', async () => {
    let now = 0;
    let attempts = 0;
    const controller = new CloudBotModelRuntimeReloadController({
      now: () => now,
      random: () => 0,
      pullSelection: async () => ({ modelId: 'deepseek-flash', revision: 13 }),
      isIdle: () => true,
      applySelection: async () => { attempts += 1; throw new Error('prepare exploded'); },
    });

    await controller.pollOnce();
    assert.equal(attempts, 1);
    // Backoff still throttles the retry, but the revision must not be retired.
    now = 1_000;
    await controller.pollOnce();
    assert.equal(attempts, 1, 'backoff holds the retry');
    now = 10_000;
    await controller.pollOnce();
    assert.equal(attempts, 2, 'the same revision is retried after the backoff');
    assert.equal(controller.getHealth().handledRevision, -1);
  });
});

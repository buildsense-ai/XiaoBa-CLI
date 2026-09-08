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
});

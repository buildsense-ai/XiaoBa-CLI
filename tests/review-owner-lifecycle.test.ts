import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { startReviewOwnerLifecycle } from '../src/review/review-owner-lifecycle';

test('Review owner lifecycle starts enabled owners and stops each owner once', async () => {
  const calls: string[] = [];
  const lifecycle = await startReviewOwnerLifecycle({
    projectRoot: '/tmp/review-lifecycle',
    startHeartbeat: async options => {
      assert.equal(options.projectRoot, '/tmp/review-lifecycle');
      calls.push('heartbeat:start');
      return {
        adapter: {} as any,
        stop: async () => { calls.push('heartbeat:stop'); },
      };
    },
    startWorkbench: async options => {
      assert.equal(options.projectRoot, '/tmp/review-lifecycle');
      calls.push('workbench:start');
      return {
        stop: async () => { calls.push('workbench:stop'); },
      };
    },
  });

  await Promise.all([lifecycle.stop(), lifecycle.stop()]);
  assert.deepEqual(calls, [
    'heartbeat:start',
    'workbench:start',
    'heartbeat:stop',
    'workbench:stop',
  ]);
});

test('Review owner lifecycle rolls back a partial startup', async () => {
  const calls: string[] = [];
  await assert.rejects(() => startReviewOwnerLifecycle({
    projectRoot: '/tmp/review-lifecycle',
    startHeartbeat: async () => ({
      adapter: {} as any,
      stop: async () => { calls.push('heartbeat:stop'); },
    }),
    startWorkbench: async () => {
      throw new Error('workbench startup failed');
    },
  }), /workbench startup failed/);

  assert.deepEqual(calls, ['heartbeat:stop']);
});

test('Review owner lifecycle treats missing optional owners as a no-op', async () => {
  const lifecycle = await startReviewOwnerLifecycle({
    projectRoot: '/tmp/review-lifecycle',
    startHeartbeat: async () => undefined,
    startWorkbench: async () => undefined,
  });

  assert.equal(lifecycle.heartbeat, undefined);
  assert.equal(lifecycle.workbench, undefined);
  await lifecycle.stop();
});

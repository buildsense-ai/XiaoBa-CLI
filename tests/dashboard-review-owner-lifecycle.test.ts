import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startDashboard } from '../src/dashboard/server';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Dashboard owns the Review lifecycle from startup through idempotent stop', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-review-owner-'));
  roots.push(projectRoot);
  const calls: string[] = [];

  const handle = await startDashboard(0, {
    projectRoot,
    startReviewOwners: async root => {
      assert.equal(root, projectRoot);
      calls.push('review:start');
      let stopped = false;
      return {
        stop: async () => {
          if (stopped) return;
          stopped = true;
          calls.push('review:stop');
        },
      };
    },
  });

  await Promise.all([handle.stop(), handle.stop()]);
  assert.deepEqual(calls, ['review:start', 'review:stop']);
});

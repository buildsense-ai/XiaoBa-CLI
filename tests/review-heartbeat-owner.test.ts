import { afterEach, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startReviewHeartbeatOwner } from '../src/review/review-heartbeat-owner';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('Dashboard Review Heartbeat owner is a no-op without a Review workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-owner-empty-'));
  roots.push(root);
  let createCalls = 0;
  const owner = await startReviewHeartbeatOwner({
    projectRoot: root,
    createAdapter: (async () => { createCalls += 1; return {} as any; }) as any,
  });
  assert.equal(owner, undefined);
  assert.equal(createCalls, 0);
});

test('Dashboard Review Heartbeat owner recovers, starts one timer and drains on stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-owner-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'review', 'evidence-envelopes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'build-evidence-envelope-review'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'build-evidence-envelope-review', 'SKILL.md'), '# Review\n');

  const calls: unknown[][] = [];
  const fakeAdapter = {
    recoverAll: async (...args: unknown[]) => { calls.push(['recover', ...args]); return []; },
    startHeartbeat: (...args: unknown[]) => { calls.push(['start', ...args]); },
    destroy: async () => { calls.push(['destroy']); },
  };
  const owner = await startReviewHeartbeatOwner({
    projectRoot: root,
    env: { XIAOBA_REVIEW_HEARTBEAT_INTERVAL_MS: '2500' },
    createAdapter: (async options => {
      calls.push(['create', options]);
      return fakeAdapter as any;
    }) as any,
  });
  assert.ok(owner);
  assert.deepEqual(calls.map(call => call[0]), ['create', 'recover', 'start']);
  assert.deepEqual(calls[1], ['recover', 'dashboard-review-recovery']);
  assert.deepEqual(calls[2], ['start', 2500, 'dashboard-review-heartbeat']);
  await owner!.stop();
  assert.deepEqual(calls.at(-1), ['destroy']);
});

test('Dashboard Review Heartbeat owner honors explicit disable and rejects unsafe intervals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-owner-config-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'review', 'evidence-envelopes', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'build-evidence-envelope-review'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'build-evidence-envelope-review', 'SKILL.md'), '# Review\n');

  const disabled = await startReviewHeartbeatOwner({
    projectRoot: root,
    env: { XIAOBA_REVIEW_HEARTBEAT_ENABLED: 'false' },
    createAdapter: (async () => { throw new Error('must not run'); }) as any,
  });
  assert.equal(disabled, undefined);
  await assert.rejects(() => startReviewHeartbeatOwner({
    projectRoot: root,
    env: { XIAOBA_REVIEW_HEARTBEAT_INTERVAL_MS: '999' },
    createAdapter: (async () => ({} as any)) as any,
  }), /must be at least 1000/);
});

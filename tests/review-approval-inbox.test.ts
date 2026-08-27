import { afterEach, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReviewApprovalInbox } from '../src/review/review-approval-inbox';
import type { ReviewRunProjection } from '../src/review/review-runtime-types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('private approval inbox hands a natural-language command to the persistent owner', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'review-approval-inbox-'));
  roots.push(workspace);
  const inbox = new ReviewApprovalInbox({ workspace, pollIntervalMs: 50 });
  const seen: unknown[] = [];
  const projection: ReviewRunProjection = {
    runId: 'run-1', findingId: 'F-1', status: 'active', reviewState: 'INCOMPLETE',
    createdAt: '2026-07-26T00:00:00Z', updatedAt: '2026-07-26T00:00:01Z',
    taskCounts: { running: 1 }, tasks: [], recentEvents: [],
  };
  inbox.start(async request => { seen.push(request); return projection; });
  const result = await inbox.submit({ sessionKey: 'review:F-1', message: '批准 task-1：只读重试', actor: 'bruce' }, 3_000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.projection, projection);
  assert.equal((seen[0] as any).sessionKey, 'review:F-1');
  assert.equal((seen[0] as any).message, '批准 task-1：只读重试');
  assert.equal((seen[0] as any).actor, 'bruce');
  assert.equal(fs.statSync(path.join(workspace, '.review-approval-inbox')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(workspace, '.review-approval-results')).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.review-approval-inbox')), []);
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.review-approval-results')), []);
  await inbox.stop();
});

test('approval inbox returns only a controlled error code', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'review-approval-inbox-error-'));
  roots.push(workspace);
  const inbox = new ReviewApprovalInbox({ workspace, pollIntervalMs: 50 });
  inbox.start(async () => { throw new Error('Multiple Tasks await approval; include the exact Task ID SECRET_DETAIL'); });
  const result = await inbox.submit({ sessionKey: 'review:F-2', message: '批准', actor: 'bruce' }, 3_000);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'APPROVAL_AMBIGUOUS');
  assert.equal(JSON.stringify(result).includes('SECRET_DETAIL'), false);
  await inbox.stop();
});

test('approval inbox recovers a claimed request after owner restart', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'review-approval-inbox-recover-'));
  roots.push(workspace);
  const requestDir = path.join(workspace, '.review-approval-inbox');
  fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  fs.writeFileSync(path.join(requestDir, `${requestId}.json.processing`), JSON.stringify({
    schemaVersion: 1, requestId, sessionKey: 'review:F-3', message: '批准 task-3', actor: 'bruce',
    createdAt: '2026-07-26T00:00:00.000Z',
  }), { mode: 0o600 });
  const inbox = new ReviewApprovalInbox({ workspace, pollIntervalMs: 50 });
  let consumed = false;
  try {
    inbox.start(async () => {
      consumed = true;
      return {
        runId: 'run-3', findingId: 'F-3', status: 'active', reviewState: 'INCOMPLETE',
        createdAt: '', updatedAt: '', taskCounts: {}, tasks: [], recentEvents: [],
      };
    });
    const processingPath = path.join(requestDir, `${requestId}.json.processing`);
    for (let attempt = 0; attempt < 30 && (!consumed || fs.existsSync(processingPath)); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(consumed, true);
    assert.equal(fs.existsSync(processingPath), false);
  } finally {
    await inbox.stop();
  }
});

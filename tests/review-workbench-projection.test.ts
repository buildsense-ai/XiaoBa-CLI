import { afterEach, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('Workbench approval projection is an exact read-only whitelist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-workbench-'));
  roots.push(root);
  const storePath = path.join(root, 'review-runs.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schemaVersion: 1,
    runs: {
      'run-public': {
        findingId: 'F-PUBLIC', sessionKey: 'SECRET_SESSION', goal: 'SECRET_GOAL',
        envelopePath: '/secret/envelope',
        tasks: {
          'task-proposed': {
            status: 'proposed', approvalRequired: true, risk: 'medium',
            proposedAt: '2026-07-26T09:00:00Z', title: 'SECRET_TITLE',
            objective: 'SECRET_OBJECTIVE', resultSummary: 'SECRET_RESULT',
          },
          'task-interrupted': {
            status: 'interrupted', approvalRequired: false, risk: 'high',
            proposedAt: '2026-07-26T09:01:00Z', failureReason: 'SECRET_ERROR',
          },
          'task-running': {
            status: 'running', approvalRequired: true, risk: 'high',
            proposedAt: '2026-07-26T09:02:00Z', title: 'HIDDEN_RUNNING',
          },
        },
      },
    },
  }), { mode: 0o600 });

  const serverPath = path.join(process.cwd(), 'skills', 'build-evidence-envelope-review', 'scripts', 'webapp_server.py');
  const probe = [
    'import importlib.util,json,sys',
    `spec=importlib.util.spec_from_file_location("workbench",${JSON.stringify(serverPath)})`,
    'm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
    `print(json.dumps(m.shared_review_approvals(${JSON.stringify(root)}),sort_keys=True))`,
  ].join(';');
  const result = spawnSync('python3', ['-c', probe], { encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr);
  const raw = result.stdout.trim();
  const projection = JSON.parse(raw);
  assert.deepEqual(projection.approvals, [
    {
      run_id: 'run-public', finding_id: 'F-PUBLIC', task_id: 'task-proposed',
      status: 'proposed', risk: 'medium', approval_required: true,
      proposed_at: '2026-07-26T09:00:00Z',
    },
    {
      run_id: 'run-public', finding_id: 'F-PUBLIC', task_id: 'task-interrupted',
      status: 'interrupted', risk: 'high', approval_required: true,
      proposed_at: '2026-07-26T09:01:00Z',
    },
  ]);
  for (const secret of ['SECRET', '/secret', 'HIDDEN_RUNNING', 'goal', 'objective', 'title', 'resultSummary', 'failureReason']) {
    assert.equal(raw.includes(secret), false, `projection leaked ${secret}`);
  }
});

test('Workbench renders approvals as view-only natural-language guidance', () => {
  const html = fs.readFileSync(path.join(
    process.cwd(), 'skills', 'build-evidence-envelope-review', 'webapp', 'index.html',
  ), 'utf-8');
  assert.match(html, /待审批专项/);
  assert.match(html, /对应 Review Session 用自然语言批准或拒绝/);
  assert.match(html, /此页没有审批按钮/);
  assert.match(html, /\/api\/review\/approvals/);
  assert.equal(/approveTask|rejectTask|\/api\/review\/approvals[^'"`]*POST/.test(html), false);
});

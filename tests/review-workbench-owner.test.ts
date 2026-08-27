import { afterEach, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawnSync } from 'node:child_process';
import { startReviewWorkbenchOwner } from '../src/review/review-workbench-owner';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('Review Workbench owner is explicitly enabled and validates its port', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-workbench-owner-config-'));
  roots.push(root);
  assert.equal(await startReviewWorkbenchOwner({ projectRoot: root, env: {} }), undefined);

  fs.mkdirSync(path.join(root, 'review', 'evidence-envelopes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'build-evidence-envelope-review', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'review', 'evidence-envelopes', 'registry.sqlite3'), 'placeholder');
  fs.writeFileSync(path.join(root, 'skills', 'build-evidence-envelope-review', 'scripts', 'webapp_server.py'), 'pass\n');
  await assert.rejects(() => startReviewWorkbenchOwner({
    projectRoot: root,
    env: { XIAOBA_REVIEW_WORKBENCH_ENABLED: 'true', XIAOBA_REVIEW_WORKBENCH_PORT: '70000' },
  }), /integer from 1 to 65535/);
});

test('Review Workbench owner starts the real read-only server and drains it', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'review-workbench-owner-live-'));
  roots.push(workspace);
  const findingManager = path.join(
    process.cwd(),
    'skills',
    'build-evidence-envelope-review',
    'scripts',
    'finding_manager.py',
  );
  const initialized = spawnSync('/usr/bin/python3', [
    '-c',
    'import importlib.util, pathlib, sys; spec=importlib.util.spec_from_file_location("fm", sys.argv[1]); fm=importlib.util.module_from_spec(spec); spec.loader.exec_module(fm); fm.connect(pathlib.Path(sys.argv[2])).close()',
    findingManager,
    workspace,
  ], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const port = await reservePort();
  const owner = await startReviewWorkbenchOwner({
    projectRoot: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XIAOBA_REVIEW_WORKBENCH_ENABLED: 'true',
      XIAOBA_REVIEW_WORKSPACE: workspace,
      XIAOBA_REVIEW_WORKBENCH_HOST: '127.0.0.1',
      XIAOBA_REVIEW_WORKBENCH_PORT: String(port),
    },
  });
  assert.ok(owner?.pid);
  const response = await retryFetch(`http://127.0.0.1:${port}/api/review/approvals`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { approvals: [], generated_at: '' });
  await owner!.stop();
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/review/approvals`));
});

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing TCP address'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function retryFetch(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await fetch(url); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError;
}

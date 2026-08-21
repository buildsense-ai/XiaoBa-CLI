import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BRANCH_LOG_MAX_BYTES, BranchSessionLogger } from '../src/core/branch-session';

test('branch logger caps a single branch file and records the dropped event', () => {
  const previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-branch-log-cap-'));
  process.env.XIAOBA_USER_DATA_DIR = root;
  try {
    const logger = new BranchSessionLogger({
      branchId: 'bounded-log',
      branchType: 'memory',
      workingDirectory: root,
      enabled: true,
    });
    const payload = 'x'.repeat(100_000);
    for (let index = 0; index < 20; index += 1) {
      logger.write('large_diagnostic', { index, payload });
    }

    const branchRoot = path.join(root, 'logs', 'branches', 'memory');
    const dateDir = path.join(branchRoot, fs.readdirSync(branchRoot)[0]);
    const filePath = path.join(dateDir, fs.readdirSync(dateDir)[0]);
    const contents = fs.readFileSync(filePath, 'utf8');
    assert.ok(fs.statSync(filePath).size <= BRANCH_LOG_MAX_BYTES);
    assert.match(contents, /log_limit_reached/);
    assert.match(contents, /large_diagnostic/);
  } finally {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

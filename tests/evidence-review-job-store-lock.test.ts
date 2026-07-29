import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

import {
  loadEvidenceReviewJobStore,
  mutateEvidenceReviewJobStore,
} from '../src/utils/evidence-review-job-store';

describe('Evidence Review whole-store lock', () => {
  test('waits through a short cross-process owner and preserves both mutations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-review-store-lock-'));
    const storePath = path.join(root, 'data', 'evidence-review-jobs.json');
    const readyPath = path.join(root, 'ready');
    try {
      const moduleUrl = pathToFileURL(path.resolve('src/utils/evidence-review-job-store.ts')).href;
      const childScript = `
        const { mutateEvidenceReviewJobStore } = await import(${JSON.stringify(moduleUrl)});
        const fs = await import('node:fs');
        const [storePath, readyPath] = process.argv.slice(1);
        mutateEvidenceReviewJobStore(storePath, state => {
          fs.writeFileSync(readyPath, 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
          state.fairness.jobCursors.child = 'child-update';
        });
      `;
      const child = spawn(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e', childScript, storePath, readyPath,
      ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(readyPath) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(fs.existsSync(readyPath), true, 'child acquired the store lock');

      mutateEvidenceReviewJobStore(storePath, state => {
        state.fairness.jobCursors.parent = 'parent-update';
      });
      const [exitCode] = await once(child, 'exit');
      assert.equal(exitCode, 0);

      const state = loadEvidenceReviewJobStore(storePath);
      assert.equal(state.fairness.jobCursors.child, 'child-update');
      assert.equal(state.fairness.jobCursors.parent, 'parent-update');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';

import {
  loadEvidenceReviewJobStore,
  mutateEvidenceReviewJobStore,
} from '../src/utils/evidence-review-job-store';
import { createProcessLockClaimIdentity } from '../src/utils/process-lock-claim';

describe('Evidence Review whole-store lock', () => {
  test('recovers one damaged owner record from the atomically published backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-review-store-broken-lock-'));
    const storePath = path.join(root, 'data', 'evidence-review-jobs.json');
    const lockPath = `${storePath}.lock`;
    try {
      const deadOwner = JSON.stringify({ pid: 999_999_999, startedAt: new Date(0).toISOString(), token: randomUUID() });
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), '{not-json', 'utf8');
      fs.writeFileSync(path.join(lockPath, 'owner.backup.json'), deadOwner, 'utf8');
      mutateEvidenceReviewJobStore(storePath, state => {
        state.fairness.jobCursors.recovered = 'backup-owner';
      });
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(loadEvidenceReviewJobStore(storePath).fairness.jobCursors.recovered, 'backup-owner');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reclaims a stale owner after its PID has been reused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-review-store-reused-pid-'));
    const storePath = path.join(root, 'data', 'evidence-review-jobs.json');
    const lockPath = `${storePath}.lock`;
    try {
      const currentIdentity = createProcessLockClaimIdentity();
      assert.ok(currentIdentity.processStartedAt, 'expected an OS process-start identity');
      const reusedPidOwner = JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        processStartedAt: new Date(
          Date.parse(currentIdentity.processStartedAt) + 1_000,
        ).toISOString(),
        token: randomUUID(),
      });
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), reusedPidOwner, 'utf8');
      fs.writeFileSync(path.join(lockPath, 'owner.backup.json'), reusedPidOwner, 'utf8');

      mutateEvidenceReviewJobStore(storePath, state => {
        state.fairness.jobCursors.recovered = 'reused-pid';
      });

      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(loadEvidenceReviewJobStore(storePath).fairness.jobCursors.recovered, 'reused-pid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when both owner records are missing or malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-review-store-ambiguous-lock-'));
    const storePath = path.join(root, 'data', 'evidence-review-jobs.json');
    const lockPath = `${storePath}.lock`;
    try {
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), '{not-json', 'utf8');
      assert.throws(
        () => mutateEvidenceReviewJobStore(storePath, () => undefined),
        /store is busy/i,
      );
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when redundant owner records disagree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-review-store-mismatched-lock-'));
    const storePath = path.join(root, 'data', 'evidence-review-jobs.json');
    const lockPath = `${storePath}.lock`;
    try {
      fs.mkdirSync(lockPath, { recursive: true });
      for (const fileName of ['owner.json', 'owner.backup.json']) {
        fs.writeFileSync(path.join(lockPath, fileName), JSON.stringify({
          pid: 999_999_999,
          startedAt: new Date(0).toISOString(),
          token: randomUUID(),
        }), 'utf8');
      }
      assert.throws(
        () => mutateEvidenceReviewJobStore(storePath, () => undefined),
        /store is busy/i,
      );
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('waits through a short cross-process owner and preserves both mutations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-review-store-lock-'));
    const storePath = path.join(root, 'data', 'evidence-review-jobs.json');
    const readyPath = path.join(root, 'ready');
    try {
      const moduleUrl = pathToFileURL(path.resolve('src/utils/evidence-review-job-store.ts')).href;
      const childScript = `
        const imported = await import(${JSON.stringify(moduleUrl)});
        const { mutateEvidenceReviewJobStore } = imported.default ?? imported;
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
      fs.writeFileSync(`${storePath}.lock/owner.json`, '{not-json', 'utf8');

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

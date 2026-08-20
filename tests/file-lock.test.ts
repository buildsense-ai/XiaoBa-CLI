import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withExclusiveFileLockAsync } from '../src/core/file-lock';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('file lock', () => {
  test('renews a live asynchronous lease beyond the stale threshold', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-')); roots.push(root);
    const lockPath = path.join(root, 'goal.lock');
    const previous = process.env.XIAOBA_FILE_LOCK_STALE_MS;
    process.env.XIAOBA_FILE_LOCK_STALE_MS = '2000';
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let secondEntered = false;
    try {
      const first = withExclusiveFileLockAsync(lockPath, async ({ contended }) => {
        assert.equal(contended, false);
        entered();
        await gate;
      });
      await enteredPromise;
      await new Promise(resolve => setTimeout(resolve, 2500));
      const second = withExclusiveFileLockAsync(lockPath, async ({ contended }) => {
        assert.equal(contended, true);
        secondEntered = true;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(secondEntered, false);
      release();
      await Promise.all([first, second]);
      assert.equal(secondEntered, true);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      if (previous === undefined) delete process.env.XIAOBA_FILE_LOCK_STALE_MS;
      else process.env.XIAOBA_FILE_LOCK_STALE_MS = previous;
    }
  });

  test('serializes two contenders recovering the same stale lock directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-')); roots.push(root);
    const lockPath = path.join(root, 'stale.lock');
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);
    let active = 0;
    let overlap = false;
    const operation = () => withExclusiveFileLockAsync(lockPath, async () => {
      active += 1;
      if (active > 1) overlap = true;
      await new Promise(resolve => setTimeout(resolve, 30));
      active -= 1;
    });
    await Promise.all([operation(), operation()]);
    assert.equal(overlap, false);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('recovers an old malformed lock left before owner metadata was written', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-')); roots.push(root);
    const lockPath = path.join(root, 'orphan.lock');
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);
    let entered = false;
    await withExclusiveFileLockAsync(lockPath, async () => { entered = true; });
    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('treats a directory that becomes stale while waiting as recovery, not a duplicate owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-')); roots.push(root);
    const lockPath = path.join(root, 'late-stale-directory.lock');
    const previous = process.env.XIAOBA_FILE_LOCK_STALE_MS;
    process.env.XIAOBA_FILE_LOCK_STALE_MS = '2000';
    fs.mkdirSync(lockPath);
    const almostStale = new Date(Date.now() - 1700);
    fs.utimesSync(lockPath, almostStale, almostStale);
    try {
      let context: { contended: boolean } | undefined;
      await withExclusiveFileLockAsync(lockPath, async acquired => { context = acquired; });
      assert.deepEqual(context, { contended: false });
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      if (previous === undefined) delete process.env.XIAOBA_FILE_LOCK_STALE_MS;
      else process.env.XIAOBA_FILE_LOCK_STALE_MS = previous;
    }
  });

  test('retries a legacy file lock that becomes stale while waiting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-')); roots.push(root);
    const lockPath = path.join(root, 'late-stale-file.lock');
    const previous = process.env.XIAOBA_FILE_LOCK_STALE_MS;
    process.env.XIAOBA_FILE_LOCK_STALE_MS = '2000';
    fs.writeFileSync(lockPath, 'legacy lock');
    const almostStale = new Date(Date.now() - 1700);
    fs.utimesSync(lockPath, almostStale, almostStale);
    try {
      let context: { contended: boolean } | undefined;
      await withExclusiveFileLockAsync(lockPath, async acquired => { context = acquired; });
      assert.deepEqual(context, { contended: false });
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      if (previous === undefined) delete process.env.XIAOBA_FILE_LOCK_STALE_MS;
      else process.env.XIAOBA_FILE_LOCK_STALE_MS = previous;
    }
  });
});

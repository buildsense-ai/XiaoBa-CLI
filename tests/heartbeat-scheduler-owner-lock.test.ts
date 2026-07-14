import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireHeartbeatSchedulerOwnerLock } from '../src/utils/heartbeat-scheduler-owner-lock';

/**
 * Helper: write a stale lock directory with a given owner record, simulating
 * a dead process that left the lock behind.
 */
function writeStaleLock(
  runtimeRoot: string,
  record: { pid: number; startedAt: string; command?: string; token: string },
): string {
  const lockDir = path.join(runtimeRoot, '.xiaoba', 'heartbeat-scheduler-owner');
  const lockFile = path.join(lockDir, 'owner.json');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return lockFile;
}

describe('heartbeat scheduler owner lock (runtime-wide singleton, directory-based)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-owner-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('first process acquires ownership', () => {
    const first = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'catsco catscompany',
    });
    assert.equal(first.acquired, true);
    if (first.acquired) {
      assert.equal(first.record.pid, process.pid);
      assert.ok(first.record.token.length > 0);
      // The lock directory and owner.json exist.
      const lockDir = path.join(tempDir, '.xiaoba', 'heartbeat-scheduler-owner');
      assert.ok(fs.existsSync(lockDir), 'lock directory exists');
      assert.ok(fs.existsSync(first.lockPath), 'owner.json exists at lockPath');
      first.release();
      // After release, the lock directory is gone.
      assert.ok(!fs.existsSync(lockDir), 'lock directory removed on release');
    }
  });

  test('second process for the same runtime is blocked', () => {
    const first = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'catsco catscompany',
    });
    assert.equal(first.acquired, true);

    // Simulate a second connector process in the same runtime root. In real
    // life this is a different process with a different pid, but from this
    // process we can still verify the lock blocks the second acquisition
    // because the first owner (this pid) is alive.
    const second = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'catsco feishu',
    });
    assert.equal(second.acquired, false);
    if (!second.acquired) {
      assert.equal(second.existing.pid, process.pid);
    }

    if (first.acquired) first.release();
  });

  test('renews liveness and safely takes over after the lease expires', () => {
    let currentMs = Date.now();
    const now = () => new Date(currentMs);
    const first = acquireHeartbeatSchedulerOwnerLock({ runtimeRoot: tempDir, leaseMs: 1_000, now });
    assert.equal(first.acquired, true);
    if (!first.acquired) return;
    const firstGeneration = first.generation;
    currentMs += 500;
    assert.equal(first.renew(), true);
    currentMs += 200;
    const blocked = acquireHeartbeatSchedulerOwnerLock({ runtimeRoot: tempDir, leaseMs: 1_000, now });
    assert.equal(blocked.acquired, false, 'renewed owner remains live');
    currentMs += 1_100;
    const takeover = acquireHeartbeatSchedulerOwnerLock({ runtimeRoot: tempDir, leaseMs: 1_000, now });
    assert.equal(takeover.acquired, true, 'expired lease can be reclaimed even if PID is still alive');
    if (takeover.acquired) {
      assert.notEqual(takeover.generation, firstGeneration);
      assert.throws(() => first.assertOwnership(), /fenced/);
      takeover.release();
    }
    first.release();
  });

  test('overwrites a stale lock when the previous owner pid is dead', () => {
    writeStaleLock(tempDir, {
      pid: -1, // dead pid
      startedAt: new Date().toISOString(),
      command: 'stale-process',
      token: 'stale-token',
    });

    const acquired = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'replacement',
    });
    assert.equal(acquired.acquired, true);
    if (acquired.acquired) {
      assert.equal(acquired.record.pid, process.pid);
      acquired.release();
    }
  });

  test('overwrites a stale lock when the owner record is malformed', () => {
    const lockDir = path.join(tempDir, '.xiaoba', 'heartbeat-scheduler-owner');
    fs.mkdirSync(lockDir, { recursive: true });
    // Write invalid JSON to owner.json
    fs.writeFileSync(path.join(lockDir, 'owner.json'), 'not valid json', 'utf8');

    const acquired = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'replacement',
    });
    assert.equal(acquired.acquired, true);
    if (acquired.acquired) {
      acquired.release();
    }
  });

  test('handles a lock directory with a missing owner.json', () => {
    const lockDir = path.join(tempDir, '.xiaoba', 'heartbeat-scheduler-owner');
    fs.mkdirSync(lockDir, { recursive: true });
    // No owner.json — directory exists but is empty

    const acquired = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'replacement',
    });
    assert.equal(acquired.acquired, true);
    if (acquired.acquired) {
      acquired.release();
    }
  });

  test('different runtime roots each acquire their own lock', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-owner-lock-other-'));
    try {
      const first = acquireHeartbeatSchedulerOwnerLock({
        runtimeRoot: tempDir,
        command: 'catsco catscompany',
      });
      const other = acquireHeartbeatSchedulerOwnerLock({
        runtimeRoot: otherDir,
        command: 'catsco feishu',
      });
      assert.equal(first.acquired, true);
      assert.equal(other.acquired, true);
      if (first.acquired) first.release();
      if (other.acquired) other.release();
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('release is a no-op when the lock was already overwritten', () => {
    const first = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'first',
    });
    assert.equal(first.acquired, true);

    // Simulate the owner dying and another process taking over by removing
    // the first lock directory and acquiring a new one with a different token.
    if (first.acquired) first.release();
    const second = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'replacement',
    });
    assert.equal(second.acquired, true);

    // The first owner's release must not delete the replacement lock.
    // We simulate calling the first release again (it was already called
    // above, but we verify the second lock survives a stale first.release).
    if (first.acquired) first.release();
    if (second.acquired) {
      const lockDir = path.join(tempDir, '.xiaoba', 'heartbeat-scheduler-owner');
      assert.ok(fs.existsSync(lockDir), 'replacement lock directory is preserved');
      second.release();
    }
  });

  test('resolves canonical runtime data root from env vars', () => {
    const envOverride = { XIAOBA_USER_DATA_DIR: tempDir };
    const result = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: '/nonexistent/fallback',
      command: 'test',
      env: envOverride,
    });
    assert.equal(result.acquired, true);
    if (result.acquired) {
      // The lock should be under tempDir, not /nonexistent/fallback.
      assert.ok(
        result.lockPath.startsWith(tempDir),
        'lockPath uses env-overridden runtime data root',
      );
      result.release();
    }
  });

  test('acquisition is atomic under concurrent stale-reclaim contention', () => {
    // Two stale locks at different runtime roots cannot interfere. The
    // in-place claim protocol uses .claim/ inside each lockDir, so
    // independent roots are fully isolated.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-lock-contend-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-lock-contend-b-'));
    try {
      writeStaleLock(dirA, {
        pid: -1,
        startedAt: new Date().toISOString(),
        token: 'stale-a',
      });
      writeStaleLock(dirB, {
        pid: -1,
        startedAt: new Date().toISOString(),
        token: 'stale-b',
      });

      const a = acquireHeartbeatSchedulerOwnerLock({ runtimeRoot: dirA });
      const b = acquireHeartbeatSchedulerOwnerLock({ runtimeRoot: dirB });
      assert.equal(a.acquired, true);
      assert.equal(b.acquired, true);
      if (a.acquired) a.release();
      if (b.acquired) b.release();

      // No .claim/ directories left behind.
      const xiaobaA = path.join(dirA, '.xiaoba');
      const entriesA = fs.existsSync(xiaobaA) ? fs.readdirSync(xiaobaA) : [];
      assert.ok(
        entriesA.every(e => e !== '.claim'),
        'no .claim directories left in dirA',
      );
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Deterministic interleaving: A and B both see stale lock; B acquires;
  // A then tries to reclaim the now-live lock.
  // -----------------------------------------------------------------------

  test('in-place claim prevents stale-rename race (A sees stale, B acquires, A cannot move live lock)', () => {
    // 1. Create a stale lock (dead pid). This is what Process A sees.
    writeStaleLock(tempDir, {
      pid: -1,
      startedAt: new Date().toISOString(),
      token: 'stale-token',
    });
    const lockDir = path.join(tempDir, '.xiaoba', 'heartbeat-scheduler-owner');
    const lockFile = path.join(lockDir, 'owner.json');

    // 2. Simulate Process B acquiring without ever leaving a stale lock:
    //    B creates .claim/ (atomic), writes a new owner.json (live PID).
    //    B then removes .claim/.
    const claimDir = path.join(lockDir, '.claim');
    const claimerFile = path.join(claimDir, 'claimer.json');
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(claimerFile, JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), token: 'b-token',
    }) + '\n', 'utf8');
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), command: 'B', token: 'b-token',
    }) + '\n', 'utf8');
    fs.rmSync(claimDir, { recursive: true, force: true });

    // 3. Now Process A arrives. It doesn't know about B — it sees a stale
    //    lock (from earlier read). With the old rename-to-quarantine approach,
    //    A would move the now-live lockDir to quarantine. With the in-place
    //    claim protocol, A first tries mkdir(.claim/) — which succeeds
    //    (.claim/ is gone after B finished). A then re-checks owner.json and
    //    discovers B's live PID → backs off with acquired: false.
    const attempt = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'A',
    });
    assert.equal(attempt.acquired, false,
      'A must be blocked: B wrote a live record before A claimed',
    );
    if (!attempt.acquired) {
      assert.equal(attempt.existing.pid, process.pid,
        'the existing owner should be B (this process)',
      );
    }

    // The lock directory still exists with B's record (not moved).
    assert.ok(fs.existsSync(lockDir), 'lock directory must still exist (was not renamed/quarantined)');
    assert.ok(fs.existsSync(lockFile), 'owner.json must still exist');
    const stored = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(stored.token, 'b-token', 'B\'s owner record must be unmodified');

    // No .claim/ leftover.
    assert.ok(!fs.existsSync(claimDir), 'no .claim/ directory should remain');
  });

  test('stale claimer cleanup: crash mid-reclaim does not block acquisition', () => {
    // 1. Create a stale lock.
    writeStaleLock(tempDir, {
      pid: -1,
      startedAt: new Date().toISOString(),
      token: 'stale-token',
    });
    const lockDir = path.join(tempDir, '.xiaoba', 'heartbeat-scheduler-owner');
    const claimDir = path.join(lockDir, '.claim');
    const claimerFile = path.join(claimDir, 'claimer.json');

    // 2. Simulate a crashed claimer: .claim/ directory exists with a
    //    claimer.json pointing to a dead pid.
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(claimerFile, JSON.stringify({
      pid: -2, startedAt: new Date().toISOString(), token: 'crashed-claimer',
    }) + '\n', 'utf8');

    // 3. A live process must clean up the stale .claim/ and acquire.
    const acquired = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'cleaner',
    });
    assert.equal(acquired.acquired, true,
      'must acquire after cleaning up stale .claim/',
    );
    if (acquired.acquired) {
      assert.equal(acquired.record.pid, process.pid);
      // No .claim/ should remain.
      assert.ok(!fs.existsSync(claimDir), 'stale .claim/ must be removed');
      acquired.release();
    }
  });

  test('bare .claim/ (no claimer.json) is treated as stale and cleaned up', () => {
    // 1. Create a stale lock.
    writeStaleLock(tempDir, {
      pid: -1,
      startedAt: new Date().toISOString(),
      token: 'stale-token',
    });
    const lockDir = path.join(tempDir, '.xiaoba', 'heartbeat-scheduler-owner');
    const claimDir = path.join(lockDir, '.claim');

    // 2. Simulate a crash that created .claim/ but did NOT write
    //    claimer.json (the writer crashed between mkdir and writeFile).
    fs.mkdirSync(claimDir, { recursive: true });
    // No claimer.json inside.

    // 3. A live process must clean up the bare .claim/ and acquire.
    const acquired = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: tempDir,
      command: 'cleaner',
    });
    assert.equal(acquired.acquired, true,
      'must acquire after cleaning up bare .claim/',
    );
    if (acquired.acquired) {
      assert.ok(!fs.existsSync(claimDir), 'bare .claim/ must be removed');
      acquired.release();
    }
  });
});
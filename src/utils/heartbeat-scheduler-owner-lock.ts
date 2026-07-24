/**
 * Heartbeat Scheduler Owner Lock — runtime-wide singleton ownership.
 *
 * One Runtime (one working-directory / data directory) must have at most
 * one active Distillation Heartbeat Scheduler across all connector
 * processes (catscompany, feishu, weixin, chat). A process-local singleton
 * (`activeSupport` in `runtime-command-support.ts`) only prevents duplicates
 * within one process; it cannot prevent two connector processes — both
 * spawned by the Dashboard ServiceManager against the same Runtime root —
 * from each starting their own scheduler and racing on durable state writes.
 *
 * This lock is a file-based, cross-process ownership record modeled on
 * `CatsCoConnectorLock`. It lives under `<runtimeDataRoot>/.xiaoba/` and
 * records the owning pid, start time, and an opaque token. A second process
 * that finds a live owner skips scheduler creation; a stale owner (dead pid)
 * is overwritten atomically via an in-place claim protocol. The lock is
 * released on graceful stop or process exit.
 *
 * === In-place claim protocol (avoids the stale-rename race) ===
 *
 * The lock directory (`heartbeat-scheduler-owner/`) is created atomically
 * via `mkdir`. A stale lock — where the recorded `pid` is dead — is
 * reclaimed IN-PLACE by creating a `.claim/` subdirectory (atomic `mkdir`)
 * inside the existing lockDir. The winner writes its owner record to
 * `owner.json`, then removes `.claim/`. After winning the `mkdir(.claim/)`
 * slot, the winner RE-READS `owner.json` before writing: if another process
 * acquired the lock between the staleness read and the claim (a narrow
 * window), the winner releases the claim and backs off. This prevents the
 * classic race: "A and B both see stale lock; B acquires a live lock; A then
 * renames the now-live lock directory to quarantine and destroys it."
 *
 * === No rename-to-quarantine ===
 *
 * Earlier versions renamed the stale lock directory to a unique quarantine
 * path, then re-created the lockDir. This was vulnerable to the race
 * described above when two processes contended on the same stale lock.
 * By claiming IN-PLACE (a `.claim/` mkdir inside the existing directory)
 * and verifying the owner after the claim, we never move a live lock.
 *
 * === Release ===
 *
 * Release first detaches the complete lock generation with an atomic rename,
 * then verifies pid+token before deleting it. A replacement generation at the
 * canonical path is never touched.
 *
 * See CONTEXT.md → "Distillation Heartbeat" / "Graceful Runtime Drain".
 * See ADR 0038, 0041.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  reclaimStaleClaimDirectory,
  tryInstallRecordDirectory,
} from './process-lock-claim';

export interface HeartbeatSchedulerOwnerRecord {
  pid: number;
  startedAt: string;
  lastHeartbeatAt?: string;
  generation: string;
  command?: string;
  token: string;
}

export interface HeartbeatSchedulerOwnerLockOptions {
  runtimeRoot: string;
  command?: string;
  /** Injectable env for test determinism. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  leaseMs?: number;
  now?: () => Date;
}

export interface HeartbeatSchedulerOwnerLock {
  acquired: true;
  /** Path to the owner.json record file inside the lock directory. */
  lockPath: string;
  record: HeartbeatSchedulerOwnerRecord;
  generation: string;
  renew: () => boolean;
  assertOwnership: () => void;
  release: () => void;
}

export interface HeartbeatSchedulerOwnerLockBlocked {
  acquired: false;
  /** Path to the owner.json record file inside the lock directory. */
  lockPath: string;
  existing: HeartbeatSchedulerOwnerRecord;
}

export type HeartbeatSchedulerOwnerLockResult =
  | HeartbeatSchedulerOwnerLock
  | HeartbeatSchedulerOwnerLockBlocked;

const LOCK_DIR_NAME = 'heartbeat-scheduler-owner';
const LOCK_FILE_NAME = 'owner.json';
const CLAIM_DIR_NAME = '.claim';
const CLAIMER_FILE_NAME = 'claimer.json';
const MAX_ACQUIRE_RETRIES = 5;

// ---------------------------------------------------------------------------
// Claimer record (the PID that created `.claim/` for an in-progress reclaim)
// ---------------------------------------------------------------------------

interface ClaimerRecord {
  pid: number;
  startedAt: string;
  token: string;
}

// ---------------------------------------------------------------------------
// Env-based runtime data root resolution
// ---------------------------------------------------------------------------

function resolveRuntimeDataRoot(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  for (const key of [
    'XIAOBA_USER_DATA_DIR',
    'CATSCO_USER_DATA_DIR',
    'XIAOBA_ELECTRON_USER_DATA_DIR',
    'XIAOBA_RUNTIME_ROOT',
  ]) {
    const value = env[key]?.trim();
    if (value) return path.resolve(value);
  }
  return path.resolve(runtimeRoot);
}

// ---------------------------------------------------------------------------
// File reads (return null on missing/corrupt)
// ---------------------------------------------------------------------------

function readOwnerRecord(lockFile: string): HeartbeatSchedulerOwnerRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(lockFile, 'utf8'),
    ) as Partial<HeartbeatSchedulerOwnerRecord>;
    const pid = parsed.pid;
    if (
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.token === 'string'
    ) {
      return {
        pid,
        startedAt: parsed.startedAt,
        command: typeof parsed.command === 'string' ? parsed.command : undefined,
        token: parsed.token,
        generation: typeof parsed.generation === 'string' ? parsed.generation : parsed.token,
        ...(typeof parsed.lastHeartbeatAt === 'string' ? { lastHeartbeatAt: parsed.lastHeartbeatAt } : {}),
      };
    }
  } catch {
    // Missing, corrupt, or incomplete file → null (stale reclaimable)
  }
  return null;
}

function readClaimerRecord(claimerFile: string): ClaimerRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(claimerFile, 'utf8'),
    ) as Partial<ClaimerRecord>;
    if (
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.token === 'string' &&
      typeof parsed.startedAt === 'string'
    ) {
      return { pid: parsed.pid, token: parsed.token, startedAt: parsed.startedAt };
    }
  } catch {
    // Missing or corrupt → null (stale, reclaimable)
  }
  return null;
}

function isOwnerLive(record: HeartbeatSchedulerOwnerRecord, now: Date, leaseMs: number): boolean {
  void now;
  void leaseMs;
  // Generation fencing currently exists at scheduler/review boundaries, not
  // inside every synchronous durable writer. Therefore a live-but-stalled PID
  // must remain the owner even after its observability lease ages out; taking
  // over solely on elapsed time could create two writers when it resumes.
  // Supervisors already kill an unresponsive child at the shared drain
  // deadline, after which the dead-PID reclaim path is safe.
  return isProcessAlive(record.pid);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: process exists, belongs to another user.
    return code === 'EPERM';
  }
}

/**
 * Install a directory containing a complete record at `targetDir`.
 *
 * The candidate is populated before it becomes visible at the canonical
 * path. `rename` will not replace an existing non-empty directory, so a
 * concurrent installer loses without ever exposing an empty lock/claim
 * directory to another process.
 */
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to become the single heartbeat-scheduler owner for the Runtime
 * rooted at `runtimeRoot`. Returns `acquired: true` when this process now
 * owns the scheduler, or `acquired: false` when another live process already
 * owns it (in which case the caller must skip scheduler creation).
 *
 * Acquisition is atomic: a fresh lock directory is created with `mkdir`.
 * A stale lock (dead pid or invalid record) is reclaimed IN-PLACE by
 * creating a `.claim/` subdirectory via `mkdir` (atomic). After winning the
 * claim, the owner is re-verified before writing — this prevents the race
 * where one process's live lock is accidentally moved to quarantine by
 * another process that read the stale state before the live lock was created.
 * There is no non-exclusive fallback — after bounded retries the acquisition
 * throws so the caller can surface the failure.
 */
export function acquireHeartbeatSchedulerOwnerLock(
  options: HeartbeatSchedulerOwnerLockOptions,
): HeartbeatSchedulerOwnerLockResult {
  const env = options.env ?? process.env;
  const runtimeDataRoot = resolveRuntimeDataRoot(options.runtimeRoot, env);
  const xiaobaDir = path.join(runtimeDataRoot, '.xiaoba');
  const lockDir = path.join(xiaobaDir, LOCK_DIR_NAME);
  const lockFile = path.join(lockDir, LOCK_FILE_NAME);
  fs.mkdirSync(xiaobaDir, { recursive: true });

  const now = options.now ?? (() => new Date());
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const generation = crypto.randomUUID();
  const record: HeartbeatSchedulerOwnerRecord = {
    pid: process.pid,
    startedAt: now().toISOString(),
    lastHeartbeatAt: now().toISOString(),
    generation,
    command: options.command,
    token: crypto.randomUUID(),
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const claimerRecord: ClaimerRecord = {
    pid: process.pid,
    startedAt: record.startedAt,
    token: record.token,
  };
  const claimerSerialized = `${JSON.stringify(claimerRecord, null, 2)}\n`;
  let renewalTimer: NodeJS.Timeout | null = null;
  const makeAcquired = (): HeartbeatSchedulerOwnerLock => {
    const renew = (): boolean => {
      const current = readOwnerRecord(lockFile);
      if (!current || current.token !== record.token || current.generation !== record.generation) return false;
      const renewed = { ...record, lastHeartbeatAt: now().toISOString() };
      const tmp = `${lockFile}.${process.pid}.renew.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(renewed, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, lockFile);
        record.lastHeartbeatAt = renewed.lastHeartbeatAt;
        return true;
      } catch {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        return false;
      }
    };
    renewalTimer = setInterval(() => { renew(); }, Math.max(250, Math.floor(leaseMs / 3)));
    renewalTimer.unref?.();
    return {
      acquired: true,
      lockPath: lockFile,
      record,
      generation: record.generation,
      renew,
      assertOwnership: () => {
        if (!renew()) throw new Error(`Heartbeat scheduler owner fenced (generation=${record.generation})`);
      },
      release: () => {
        if (renewalTimer) { clearInterval(renewalTimer); renewalTimer = null; }
        releaseHeartbeatSchedulerOwnerLock(lockDir, record);
      },
    };
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_RETRIES; attempt++) {
    // -----------------------------------------------------------------------
    // Attempt 1a: populate a candidate directory, then publish it with one
    // rename. This avoids exposing an empty lockDir while owner.json is being
    // written; another process can only observe a complete owner record.
    // -----------------------------------------------------------------------
    try {
      if (tryInstallRecordDirectory(lockDir, LOCK_FILE_NAME, serialized)) {
        return makeAcquired();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EEXIST') throw error;
      // A concurrent release may have removed the target while we were
      // publishing; retry from the top rather than treating it as stale.
      if (code === 'ENOENT') continue;
    }

    // -----------------------------------------------------------------------
    // lockDir exists: check whether the recorded owner is alive.
    // -----------------------------------------------------------------------
    const existingOwner = readOwnerRecord(lockFile);
    if (existingOwner && isOwnerLive(existingOwner, now(), leaseMs)) {
      return {
        acquired: false,
        lockPath: lockFile,
        existing: existingOwner,
      };
    }

    // -----------------------------------------------------------------------
    // Stale owner: claim in-place via atomic mkdir(.claim/) inside lockDir.
    //
    // We NEVER rename lockDir. Rename would let a process that read the stale
    // state before a live lock was created move the now-live directory. By
    // claiming inside lockDir via mkdir (atomic), the loser gets EEXIST and
    // can check who is alive before deciding to back off.
    // -----------------------------------------------------------------------
    const claimDir = path.join(lockDir, CLAIM_DIR_NAME);
    const claimerFile = path.join(claimDir, CLAIMER_FILE_NAME);
    try {
      if (tryInstallRecordDirectory(claimDir, CLAIMER_FILE_NAME, claimerSerialized)) {
        // We hold the .claim/ atomic slot.
      } else {
        // .claim/ exists — someone else is (or was) reclaiming.
        const claimer = readClaimerRecord(claimerFile);
        if (claimer && isProcessAlive(claimer.pid)) {
          // A live claimer is actively reclaiming. Back off.
          return {
            acquired: false,
            lockPath: lockFile,
            existing: existingOwner ?? { pid: -1, startedAt: '', generation: '', token: '' },
          };
        }
        const reclaimed = reclaimStaleClaimDirectory({
          claimDir,
          claimFileName: CLAIMER_FILE_NAME,
          observed: claimer,
          reclaimer: claimerRecord,
          readClaim: readClaimerRecord,
          isProcessAlive,
        });
        if (!reclaimed) {
          return {
            acquired: false,
            lockPath: lockFile,
            existing: existingOwner ?? { pid: -1, startedAt: '', generation: '', token: '' },
          };
        }
        continue;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw error;
    }

    // ---- We hold the .claim/ atomic slot. ----

    // Re-read the owner record: another process may have acquired the lock
    // between our staleness check and our claim. If a live owner now exists,
    // release the claim and back off.
    const recheckOwner = readOwnerRecord(lockFile);
    if (recheckOwner && isOwnerLive(recheckOwner, now(), leaseMs)) {
      try {
        fs.rmSync(claimDir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
      return {
        acquired: false,
        lockPath: lockFile,
        existing: recheckOwner,
      };
    }

    // Owner is still stale. Write our record as the new owner.
    try {
      fs.writeFileSync(lockFile, serialized, 'utf8');
    } catch {
      // If write fails (unlikely), release claim and retry.
      try {
        fs.rmSync(claimDir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
      continue;
    }

    // Remove the claim now that we have written our ownership record.
    try {
      fs.rmSync(claimDir, { recursive: true, force: true });
    } catch {
      // Non-critical; the owner.json record is already at the canonical path.
    }

    return makeAcquired();
  }

  // Max retries exhausted. Surface the failure — no non-exclusive fallback.
  const existingOwner = readOwnerRecord(lockFile);
  if (existingOwner && isOwnerLive(existingOwner, now(), leaseMs)) {
    return {
      acquired: false,
      lockPath: lockFile,
      existing: existingOwner,
    };
  }
  throw new Error(
    `Failed to acquire heartbeat scheduler owner lock after ${MAX_ACQUIRE_RETRIES} attempts ` +
      `(lock dir: ${lockDir}). The lock appears stale but the reclaim claim could not ` +
      `be established — another process may be contending for ownership.`,
  );
}

/**
 * Release the lock by verifying pid+token, then removing the entire lock
 * directory. If the lock was already overwritten (different token found),
 * the release is a no-op.
 */
function releaseHeartbeatSchedulerOwnerLock(
  lockDir: string,
  record: HeartbeatSchedulerOwnerRecord,
): void {
  // Detach the whole generation atomically before deleting it. A replacement
  // owner can publish a fresh canonical directory while this old generation
  // is being removed, without being touched by recursive cleanup.
  const detachedPath = `${lockDir}.released-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDir, detachedPath);
    const current = readOwnerRecord(path.join(detachedPath, LOCK_FILE_NAME));
    if (
      current
      && current.pid === record.pid
      && current.token === record.token
      && current.generation === record.generation
    ) {
      fs.rmSync(detachedPath, { recursive: true, force: true });
    } else {
      try { fs.renameSync(detachedPath, lockDir); } catch { /* replacement already published */ }
    }
  } catch {
    // Best-effort; a future acquirer can reclaim stale generations.
  }
}

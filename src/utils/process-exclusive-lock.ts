import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  createProcessLockClaimIdentity,
  isProcessIdAlive,
  isProcessLockClaimAlive,
  readProcessLockClaim,
  reclaimStaleClaimDirectory,
  sameProcessLockClaim,
  tryInstallRecordDirectory,
} from './process-lock-claim';

const OWNER_FILE = 'owner.json';
const OWNER_BACKUP_FILE = 'owner.backup.json';
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export interface ProcessExclusiveLockOptions {
  retryAttempts?: number;
  retryDelayMs?: number;
}

function resolveRedundantOwner(
  primary: ReturnType<typeof readProcessLockClaim>,
  backup: ReturnType<typeof readProcessLockClaim>,
): ReturnType<typeof readProcessLockClaim> {
  if (primary && backup && !sameProcessLockClaim(primary, backup)) return null;
  return primary ?? backup;
}

/** Run synchronous durable side effects under one cross-process owner. */
export function withProcessExclusiveLock<T>(
  lockPath: string,
  work: () => T,
  options: ProcessExclusiveLockOptions = {},
): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const identity = createProcessLockClaimIdentity();
  const serialized = `${JSON.stringify(identity)}\n`;
  const install = () => tryInstallRecordDirectory(
    lockPath,
    OWNER_FILE,
    serialized,
    { [OWNER_BACKUP_FILE]: serialized },
  );
  const retryAttempts = Math.max(0, Math.floor(options.retryAttempts ?? 0));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 0));
  let installed = false;
  for (let attempt = 0; attempt <= retryAttempts && !installed; attempt++) {
    installed = install();
    if (installed) break;
    const primary = readProcessLockClaim(path.join(lockPath, OWNER_FILE));
    const backup = readProcessLockClaim(path.join(lockPath, OWNER_BACKUP_FILE));
    const observed = resolveRedundantOwner(primary, backup);
    // A malformed legacy/singly-corrupted lock is ambiguous: fail closed rather
    // than deleting a directory that a live owner may still be using.
    if (observed && !isProcessLockClaimAlive(observed)) {
      reclaimStaleClaimDirectory({
        claimDir: lockPath,
        claimFileName: primary ? OWNER_FILE : OWNER_BACKUP_FILE,
        observed,
        reclaimer: identity,
        readClaim: readProcessLockClaim,
        isProcessAlive: isProcessIdAlive,
        isClaimAlive: isProcessLockClaimAlive,
      });
      continue;
    }
    if (attempt < retryAttempts && retryDelayMs > 0) {
      Atomics.wait(LOCK_SLEEP, 0, 0, retryDelayMs);
    }
  }
  if (!installed) throw new Error(`Process-exclusive lock is busy: ${lockPath}`);

  try {
    return work();
  } finally {
    const installedOwner = resolveRedundantOwner(
      readProcessLockClaim(path.join(lockPath, OWNER_FILE)),
      readProcessLockClaim(path.join(lockPath, OWNER_BACKUP_FILE)),
    );
    if (sameProcessLockClaim(installedOwner, identity)) {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

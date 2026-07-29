import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  reclaimStaleClaimDirectory,
  sameProcessLockClaim,
  tryInstallRecordDirectory,
  type ProcessLockClaimIdentity,
} from './process-lock-claim';

const OWNER_FILE = 'owner.json';

function readOwner(filePath: string): ProcessLockClaimIdentity | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ProcessLockClaimIdentity>;
    return typeof value.pid === 'number'
      && typeof value.startedAt === 'string'
      && typeof value.token === 'string'
      ? { pid: value.pid, startedAt: value.startedAt, token: value.token }
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Run synchronous durable side effects under one cross-process owner. */
export function withProcessExclusiveLock<T>(lockPath: string, work: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const identity: ProcessLockClaimIdentity = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: crypto.randomUUID(),
  };
  const serialized = `${JSON.stringify(identity)}\n`;
  const install = () => tryInstallRecordDirectory(lockPath, OWNER_FILE, serialized);
  let installed = install();
  if (!installed) {
    const observed = readOwner(path.join(lockPath, OWNER_FILE));
    if (!observed || !isProcessAlive(observed.pid)) {
      reclaimStaleClaimDirectory({
        claimDir: lockPath,
        claimFileName: OWNER_FILE,
        observed,
        reclaimer: identity,
        readClaim: readOwner,
        isProcessAlive,
      });
      installed = install();
    }
  }
  if (!installed) throw new Error(`Process-exclusive lock is busy: ${lockPath}`);

  try {
    return work();
  } finally {
    const installedOwner = readOwner(path.join(lockPath, OWNER_FILE));
    if (sameProcessLockClaim(installedOwner, identity)) {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

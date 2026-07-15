import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProcessLockClaimIdentity {
  pid: number;
  startedAt: string;
  token: string;
}

const RECLAIM_DIR_NAME = '.reclaim';
const RECLAIMER_FILE_NAME = 'claimer.json';
const MAX_RECLAIM_DEPTH = 32;

export function sameProcessLockClaim(
  left: ProcessLockClaimIdentity | null,
  right: ProcessLockClaimIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid && left.token === right.token;
}

/** Publish a populated directory without exposing a partial record. */
export function tryInstallRecordDirectory(
  targetDir: string,
  fileName: string,
  serialized: string,
): boolean {
  const candidateDir = `${targetDir}.candidate-${process.pid}-${crypto.randomUUID()}`;
  fs.mkdirSync(candidateDir, { recursive: false });
  try {
    fs.writeFileSync(path.join(candidateDir, fileName), serialized, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.renameSync(candidateDir, targetDir);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === 'EEXIST'
        || code === 'ENOTEMPTY'
        || code === 'EPERM'
        || code === 'EACCES'
        || code === 'ENOENT'
      ) {
        return false;
      }
      throw error;
    }
  } finally {
    try { fs.rmSync(candidateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Reclaim a dead claim without deleting a replacement claim by path.
 *
 * Each reclaimer adds an immutable child guard. If a reclaimer crashes, the
 * next process nests another guard instead of replacing the old one. A live
 * process can therefore never lose its guard to a contender that observed an
 * older token before acting.
 */
export function reclaimStaleClaimDirectory(options: {
  claimDir: string;
  claimFileName: string;
  observed: ProcessLockClaimIdentity | null;
  reclaimer: ProcessLockClaimIdentity;
  readClaim: (claimPath: string) => ProcessLockClaimIdentity | null;
  isProcessAlive: (pid: number) => boolean;
}): boolean {
  const {
    claimDir,
    claimFileName,
    observed,
    reclaimer,
    readClaim,
    isProcessAlive,
  } = options;
  const serialized = `${JSON.stringify(reclaimer, null, 2)}\n`;
  let guardParent = claimDir;

  for (let depth = 0; depth < MAX_RECLAIM_DEPTH; depth++) {
    const guardDir = path.join(guardParent, RECLAIM_DIR_NAME);
    let installed = false;
    try {
      installed = tryInstallRecordDirectory(guardDir, RECLAIMER_FILE_NAME, serialized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }

    if (!installed) {
      const existingGuard = readClaim(path.join(guardDir, RECLAIMER_FILE_NAME));
      if (existingGuard && isProcessAlive(existingGuard.pid)) return false;
      guardParent = guardDir;
      continue;
    }

    const currentClaim = readClaim(path.join(claimDir, claimFileName));
    const currentGuard = readClaim(path.join(guardDir, RECLAIMER_FILE_NAME));
    if (
      !sameProcessLockClaim(currentClaim, observed)
      || !sameProcessLockClaim(currentGuard, reclaimer)
      || (currentClaim !== null && isProcessAlive(currentClaim.pid))
    ) {
      return false;
    }

    try {
      fs.rmSync(claimDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

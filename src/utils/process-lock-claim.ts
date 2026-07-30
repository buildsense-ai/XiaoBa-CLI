import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProcessLockClaimIdentity {
  pid: number;
  startedAt: string;
  /** Stable OS process-start identity used to distinguish a reused PID. */
  processStartedAt?: string;
  token: string;
}

const RECLAIM_DIR_NAME = '.reclaim';
const RECLAIMER_FILE_NAME = 'claimer.json';
const MAX_RECLAIM_DEPTH = 32;
const CURRENT_PROCESS_STARTED_AT_MS = readOsProcessStartedAt(process.pid);
const CURRENT_PROCESS_STARTED_AT = CURRENT_PROCESS_STARTED_AT_MS === undefined
  ? undefined
  : new Date(CURRENT_PROCESS_STARTED_AT_MS).toISOString();

export function createProcessLockClaimIdentity(now = new Date()): ProcessLockClaimIdentity {
  return {
    pid: process.pid,
    startedAt: now.toISOString(),
    ...(CURRENT_PROCESS_STARTED_AT ? { processStartedAt: CURRENT_PROCESS_STARTED_AT } : {}),
    token: crypto.randomUUID(),
  };
}

export function readProcessLockClaim(filePath: string): ProcessLockClaimIdentity | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ProcessLockClaimIdentity>;
    return typeof value.pid === 'number'
      && typeof value.startedAt === 'string'
      && typeof value.token === 'string'
      && (value.processStartedAt === undefined || typeof value.processStartedAt === 'string')
      ? {
        pid: value.pid,
        startedAt: value.startedAt,
        ...(value.processStartedAt ? { processStartedAt: value.processStartedAt } : {}),
        token: value.token,
      }
      : null;
  } catch {
    return null;
  }
}

export function isProcessIdAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * PID liveness is insufficient after PID reuse. New claims also pin the OS
 * process-start identity; legacy claims without it remain fail-closed.
 */
export function isProcessLockClaimAlive(claim: ProcessLockClaimIdentity): boolean {
  if (!isProcessIdAlive(claim.pid)) return false;
  if (!claim.processStartedAt) return true;
  const expectedStart = Date.parse(claim.processStartedAt);
  if (!Number.isFinite(expectedStart)) return true;
  const liveStart = readLiveProcessStartedAt(claim.pid);
  if (liveStart === undefined) return true;
  return liveStart === expectedStart;
}

function readLiveProcessStartedAt(pid: number): number | undefined {
  if (pid === process.pid) return CURRENT_PROCESS_STARTED_AT_MS;
  return readOsProcessStartedAt(pid);
}

function readOsProcessStartedAt(pid: number): number | undefined {
  try {
    const output = process.platform === 'win32'
      ? execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', windowsHide: true },
      )
      : execFileSync(
        'ps',
        ['-p', String(pid), '-o', 'lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C' },
          windowsHide: true,
        },
      );
    const parsed = Date.parse(output.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

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
  additionalRecords: Readonly<Record<string, string>> = {},
): boolean {
  const candidateDir = `${targetDir}.candidate-${process.pid}-${crypto.randomUUID()}`;
  fs.mkdirSync(candidateDir, { recursive: false });
  try {
    fs.writeFileSync(path.join(candidateDir, fileName), serialized, {
      encoding: 'utf8',
      mode: 0o600,
    });
    for (const [additionalName, additionalSerialized] of Object.entries(additionalRecords)) {
      if (!additionalName || path.basename(additionalName) !== additionalName || additionalName === fileName) {
        throw new Error(`Invalid additional lock record name: ${additionalName}`);
      }
      fs.writeFileSync(path.join(candidateDir, additionalName), additionalSerialized, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
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
  isClaimAlive?: (claim: ProcessLockClaimIdentity) => boolean;
}): boolean {
  const {
    claimDir,
    claimFileName,
    observed,
    reclaimer,
    readClaim,
    isProcessAlive,
    isClaimAlive = claim => isProcessAlive(claim.pid),
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
      if (existingGuard && isClaimAlive(existingGuard)) return false;
      guardParent = guardDir;
      continue;
    }

    const currentClaim = readClaim(path.join(claimDir, claimFileName));
    const currentGuard = readClaim(path.join(guardDir, RECLAIMER_FILE_NAME));
    if (
      !sameProcessLockClaim(currentClaim, observed)
      || !sameProcessLockClaim(currentGuard, reclaimer)
      || (currentClaim !== null && isClaimAlive(currentClaim))
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

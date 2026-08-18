import * as fs from 'node:fs';
import * as path from 'node:path';

interface ProperLockOptions {
  realpath: boolean;
  lockfilePath: string;
  stale: number;
  update: number | boolean;
  retries?: number | { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean };
}
interface ProperLockfile {
  lock(file: string, options: ProperLockOptions): Promise<() => Promise<void>>;
  lockSync(file: string, options: ProperLockOptions): () => void;
}

const properLockfile = require('proper-lockfile') as ProperLockfile;
const RETRY_MS = 10;
const STALE_MS = 60_000;

/** Synchronous cross-process mutex for short persistence critical sections. */
export function withExclusiveFileLock<T>(lockPath: string, operation: () => T): T {
  prepare(lockPath);
  let release: (() => void) | undefined;
  for (;;) {
    try {
      release = properLockfile.lockSync(lockPath, options(lockPath, false));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      sleep(RETRY_MS);
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
}

export interface ExclusiveFileLockContext {
  /** True when another owner held the lock before this caller acquired it. */
  contended: boolean;
}

/** Cross-process mutex with a renewed lease for Goal drafting and wake work. */
export async function withExclusiveFileLockAsync<T>(
  lockPath: string,
  operation: (context: ExclusiveFileLockContext) => Promise<T>,
): Promise<T> {
  prepare(lockPath);
  let contended = false;
  let sawOwner = false;
  let lastObservedLockMtime: number | undefined;
  let release: (() => Promise<void>) | undefined;
  let lastLockedError: unknown;
  for (let attempt = 0; attempt <= 12_000; attempt += 1) {
    // Re-check compatibility on every retry: a legacy file may become stale
    // while this caller waits. A stale directory is recovered by
    // proper-lockfile itself, but sampling it lets us distinguish takeover
    // (no winning wake) from a live owner that released (duplicate wake).
    const recoveredLegacyFile = recoverStaleLegacyFile(lockPath);
    const sampledLock = sampleLockPath(lockPath);
    if (sampledLock?.kind === 'file') {
      // proper-lockfile expects a directory at lockfilePath and may throw
      // ENOTDIR while a legacy file ages into staleness. Wait for and migrate
      // that representation ourselves instead of passing it to the library.
      sawOwner = true;
      lastObservedLockMtime = sampledLock.mtimeMs;
      if (attempt === 12_000) throw new Error(`Timed out waiting for legacy lock ${lockPath}`);
      await delay(RETRY_MS);
      continue;
    }
    try {
      release = await properLockfile.lock(lockPath, options(lockPath, true));
      const staleTakeover = recoveredLegacyFile
        || sampledLock?.stale === true
        || (lastObservedLockMtime !== undefined && Date.now() - lastObservedLockMtime > staleMs());
      contended = sawOwner && !staleTakeover;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      lastLockedError = error;
      sawOwner = true;
      if (sampledLock) lastObservedLockMtime = sampledLock.mtimeMs;
      if (attempt === 12_000) throw lastLockedError;
      await delay(RETRY_MS);
    }
  }
  if (!release) throw lastLockedError || new Error(`Failed to acquire lock ${lockPath}`);
  try {
    return await operation({ contended });
  } finally {
    await release();
  }
}

function options(lockPath: string, asynchronous: boolean): ProperLockOptions {
  return {
    realpath: false,
    lockfilePath: lockPath,
    stale: staleMs(),
    update: asynchronous ? staleMs() / 3 : false,
  };
}

function prepare(lockPath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  recoverStaleLegacyFile(lockPath);
}

function recoverStaleLegacyFile(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (!stat.isFile() || Date.now() - stat.mtimeMs <= staleMs()) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    // Missing paths and racing recovery attempts are expected.
    return false;
  }
}

function sampleLockPath(lockPath: string): { kind: 'file' | 'directory' | 'other'; mtimeMs: number; stale: boolean } | undefined {
  try {
    const stat = fs.statSync(lockPath);
    const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    return { kind, mtimeMs: stat.mtimeMs, stale: Date.now() - stat.mtimeMs > staleMs() };
  } catch {
    return undefined;
  }
}

function staleMs(): number {
  const configured = Number(process.env.XIAOBA_FILE_LOCK_STALE_MS);
  return Number.isFinite(configured) && configured >= 2_000 ? configured : STALE_MS;
}

function sleep(milliseconds: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

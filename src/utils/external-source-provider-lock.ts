import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  reclaimStaleClaimDirectory,
  tryInstallRecordDirectory,
} from './process-lock-claim';

export interface ExternalSourceProviderLockRecord {
  provider: string;
  pid: number;
  startedAt: string;
  operation: string;
  sourceId?: string;
  token: string;
}

export interface ExternalSourceProviderLock {
  acquired: true;
  lockPath: string;
  record: ExternalSourceProviderLockRecord;
  release: () => void;
}

export interface ExternalSourceProviderLockBlocked {
  acquired: false;
  lockPath: string;
  existing: ExternalSourceProviderLockRecord;
}

export type ExternalSourceProviderLockResult =
  | ExternalSourceProviderLock
  | ExternalSourceProviderLockBlocked;

interface ExternalSourceProviderLockClaimer {
  pid: number;
  startedAt: string;
  token: string;
}

const CLAIM_DIR_NAME = '.claim';
const CLAIM_FILE_NAME = 'claimer.json';
const MAX_ACQUIRE_RETRIES = 5;

export function acquireExternalSourceProviderLock(options: {
  runtimeRoot: string;
  provider: string;
  operation: string;
  sourceId?: string;
  now?: () => Date;
}): ExternalSourceProviderLockResult {
  const now = options.now ?? (() => new Date());
  const root = path.join(path.resolve(options.runtimeRoot), '.xiaoba', 'external-source-provider-locks');
  const providerToken = `${sanitizeToken(options.provider)}-${crypto
    .createHash('sha256')
    .update(options.provider)
    .digest('hex')
    .slice(0, 12)}`;
  const lockDir = path.join(root, providerToken);
  const lockPath = path.join(lockDir, 'owner.json');
  fs.mkdirSync(root, { recursive: true });

  const record: ExternalSourceProviderLockRecord = {
    provider: options.provider,
    pid: process.pid,
    startedAt: now().toISOString(),
    operation: options.operation,
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    token: crypto.randomUUID(),
  };
  const serializedRecord = `${JSON.stringify(record, null, 2)}\n`;
  const claimer: ExternalSourceProviderLockClaimer = {
    pid: process.pid,
    startedAt: record.startedAt,
    token: record.token,
  };
  const serializedClaimer = `${JSON.stringify(claimer, null, 2)}\n`;

  for (let attempt = 0; attempt < MAX_ACQUIRE_RETRIES; attempt++) {
    if (tryInstallRecordDirectory(lockDir, 'owner.json', serializedRecord)) {
      return makeAcquiredProviderLock(lockDir, lockPath, record);
    }

    const existing = readLock(lockPath);
    if (existing && isProcessAlive(existing.pid)) {
      return {
        acquired: false,
        lockPath,
        existing,
      };
    }

    const claimDir = path.join(lockDir, CLAIM_DIR_NAME);
    const claimPath = path.join(claimDir, CLAIM_FILE_NAME);
    let claimInstalled = false;
    try {
      claimInstalled = tryInstallRecordDirectory(claimDir, CLAIM_FILE_NAME, serializedClaimer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!claimInstalled) {
      const existingClaimer = readClaimer(claimPath);
      if (existingClaimer && isProcessAlive(existingClaimer.pid)) {
        return {
          acquired: false,
          lockPath,
          existing: existing ?? unknownLockRecord(options.provider, now),
        };
      }
      reclaimStaleClaimDirectory({
        claimDir,
        claimFileName: CLAIM_FILE_NAME,
        observed: existingClaimer,
        reclaimer: claimer,
        readClaim: readClaimer,
        isProcessAlive,
      });
      continue;
    }

    const rechecked = readLock(lockPath);
    if (rechecked && isProcessAlive(rechecked.pid)) {
      releaseClaim(claimDir, claimer);
      return { acquired: false, lockPath, existing: rechecked };
    }

    try {
      // The live claim fences every other reclaimer, so an in-place write is
      // safe here and avoids platform-specific rename-over-existing behavior.
      // A crash can leave an incomplete owner record, but the dead claim then
      // makes both records stale and recoverable on the next attempt.
      fs.writeFileSync(lockPath, serializedRecord, { encoding: 'utf8', mode: 0o600 });
      releaseClaim(claimDir, claimer);
      return makeAcquiredProviderLock(lockDir, lockPath, record);
    } catch (error) {
      releaseClaim(claimDir, claimer);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const existing = readLock(lockPath) ?? unknownLockRecord(options.provider, now);
  return {
    acquired: false,
    lockPath,
    existing,
  };
}

function makeAcquiredProviderLock(
  lockDir: string,
  lockPath: string,
  record: ExternalSourceProviderLockRecord,
): ExternalSourceProviderLock {
  return {
    acquired: true,
    lockPath,
    record,
    release: () => releaseExternalSourceProviderLock(lockDir, record),
  };
}

function unknownLockRecord(provider: string, now: () => Date): ExternalSourceProviderLockRecord {
  return {
    provider,
    pid: -1,
    startedAt: now().toISOString(),
    operation: 'unknown',
    token: 'unknown',
  };
}

function readClaimer(claimPath: string): ExternalSourceProviderLockClaimer | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as Partial<ExternalSourceProviderLockClaimer>;
    if (
      typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && typeof parsed.startedAt === 'string'
      && typeof parsed.token === 'string'
    ) {
      return { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token };
    }
  } catch {
    return null;
  }
  return null;
}

function releaseClaim(
  claimDir: string,
  claimer: ExternalSourceProviderLockClaimer,
): void {
  const detachedPath = `${claimDir}.released-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(claimDir, detachedPath);
    const current = readClaimer(path.join(detachedPath, CLAIM_FILE_NAME));
    if (current && current.pid === claimer.pid && current.token === claimer.token) {
      fs.rmSync(detachedPath, { recursive: true, force: true });
    } else {
      try { fs.renameSync(detachedPath, claimDir); } catch { /* replacement already published */ }
    }
  } catch { /* claim was already detached or replaced */ }
}

function releaseExternalSourceProviderLock(
  lockDir: string,
  record: ExternalSourceProviderLockRecord,
): void {
  const detachedPath = `${lockDir}.released-${process.pid}-${crypto.randomUUID()}`;
  try {
    // Detach the whole generation atomically. A new owner can publish a fresh
    // canonical lock directory while this old generation is being removed.
    fs.renameSync(lockDir, detachedPath);
    const current = readLock(path.join(detachedPath, 'owner.json'));
    if (current && current.pid === record.pid && current.token === record.token) {
      fs.rmSync(detachedPath, { recursive: true, force: true });
    } else {
      try { fs.renameSync(detachedPath, lockDir); } catch { /* replacement already published */ }
    }
  } catch {
    // Best effort only.
  }
}

function readLock(lockPath: string): ExternalSourceProviderLockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<ExternalSourceProviderLockRecord>;
    if (
      typeof parsed.provider === 'string'
      && typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && typeof parsed.startedAt === 'string'
      && typeof parsed.operation === 'string'
      && typeof parsed.token === 'string'
    ) {
      return {
        provider: parsed.provider,
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        operation: parsed.operation,
        ...(typeof parsed.sourceId === 'string' ? { sourceId: parsed.sourceId } : {}),
        token: parsed.token,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function sanitizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
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

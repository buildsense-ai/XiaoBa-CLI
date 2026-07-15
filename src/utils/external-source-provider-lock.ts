import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

export function acquireExternalSourceProviderLock(options: {
  runtimeRoot: string;
  provider: string;
  operation: string;
  sourceId?: string;
  now?: () => Date;
}): ExternalSourceProviderLockResult {
  const now = options.now ?? (() => new Date());
  const root = path.join(path.resolve(options.runtimeRoot), '.xiaoba', 'external-source-provider-locks');
  const providerToken = sanitizeToken(options.provider);
  const lockDir = path.join(root, providerToken);
  const lockPath = path.join(lockDir, 'owner.json');
  fs.mkdirSync(root, { recursive: true });

  for (let attempt = 0; attempt < 5; attempt++) {
    const record: ExternalSourceProviderLockRecord = {
      provider: options.provider,
      pid: process.pid,
      startedAt: now().toISOString(),
      operation: options.operation,
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      token: crypto.randomUUID(),
    };

    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(lockPath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
      return {
        acquired: true,
        lockPath,
        record,
        release: () => releaseExternalSourceProviderLock(lockDir, lockPath, record),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }

    const existing = readLock(lockPath);
    if (existing && isProcessAlive(existing.pid)) {
      return {
        acquired: false,
        lockPath,
        existing,
      };
    }

    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Best effort; another contender may win the replacement.
    }
  }

  const existing = readLock(lockPath) ?? {
    provider: options.provider,
    pid: -1,
    startedAt: now().toISOString(),
    operation: 'unknown',
    token: 'unknown',
  };
  return {
    acquired: false,
    lockPath,
    existing,
  };
}

function releaseExternalSourceProviderLock(
  lockDir: string,
  lockPath: string,
  record: ExternalSourceProviderLockRecord,
): void {
  const current = readLock(lockPath);
  if (!current || current.pid !== record.pid || current.token !== record.token) return;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
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

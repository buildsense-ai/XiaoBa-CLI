import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CatsCoConnectorLockRecord {
  bodyId: string;
  pid: number;
  startedAt: string;
  command?: string;
  token: string;
}

export interface CatsCoConnectorLock {
  acquired: true;
  lockPath: string;
  record: CatsCoConnectorLockRecord;
  release: () => void;
}

export interface CatsCoConnectorLockBlocked {
  acquired: false;
  lockPath: string;
  existing: CatsCoConnectorLockRecord;
}

export type CatsCoConnectorLockResult = CatsCoConnectorLock | CatsCoConnectorLockBlocked;

export function acquireCatsCoConnectorLock(options: {
  runtimeRoot: string;
  bodyId: string;
  command?: string;
}): CatsCoConnectorLockResult {
  const lockDir = path.join(options.runtimeRoot, '.xiaoba');
  const lockPath = path.join(lockDir, 'catsco-connector.lock.json');
  fs.mkdirSync(lockDir, { recursive: true });

  const existing = readLock(lockPath);
  if (existing && existing.bodyId === options.bodyId && isProcessAlive(existing.pid)) {
    return {
      acquired: false,
      lockPath,
      existing,
    };
  }

  const record: CatsCoConnectorLockRecord = {
    bodyId: options.bodyId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: options.command,
    token: crypto.randomUUID(),
  };
  writeLock(lockPath, record);

  return {
    acquired: true,
    lockPath,
    record,
    release: () => releaseCatsCoConnectorLock(lockPath, record),
  };
}

function readLock(lockPath: string): CatsCoConnectorLockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<CatsCoConnectorLockRecord>;
    const pid = parsed.pid;
    if (
      typeof parsed.bodyId === 'string' &&
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.token === 'string'
    ) {
      return {
        bodyId: parsed.bodyId,
        pid,
        startedAt: parsed.startedAt,
        command: typeof parsed.command === 'string' ? parsed.command : undefined,
        token: parsed.token,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function writeLock(lockPath: string, record: CatsCoConnectorLockRecord): void {
  fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function releaseCatsCoConnectorLock(lockPath: string, record: CatsCoConnectorLockRecord): void {
  const current = readLock(lockPath);
  if (!current || current.bodyId !== record.bodyId || current.pid !== record.pid || current.token !== record.token) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup only.
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

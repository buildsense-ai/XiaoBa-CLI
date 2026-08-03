import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LOCK_WAIT_MS = 5 * 60_000;
const DEFAULT_LOCK_RETRY_MS = 50;
const OWNERLESS_LOCK_GRACE_MS = 30_000;

interface BotSkillLockOwner {
  pid: number;
  createdAt: string;
}

export interface BotSkillWorkspaceLockOptions {
  waitMs?: number;
  retryMs?: number;
}

export async function withBotSkillWorkspaceLock<T>(
  runtimeRoot: string,
  operation: () => Promise<T> | T,
  options: BotSkillWorkspaceLockOptions = {},
): Promise<T> {
  const waitMs = nonNegativeDuration(options.waitMs, DEFAULT_LOCK_WAIT_MS);
  const retryMs = positiveDuration(options.retryMs, DEFAULT_LOCK_RETRY_MS);
  const lockPath = path.join(path.resolve(runtimeRoot), 'data', 'bot-skills', 'workspace.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (isStaleLock(lockPath)) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        } catch {
          // Another process may be recovering the same stale lock.
        }
      }
      if (Date.now() - startedAt >= waitMs) {
        throw new Error('Timed out waiting for the Bot Skill workspace lock');
      }
      await delay(retryMs);
    }
  }

  try {
    const owner: BotSkillLockOwner = { pid: process.pid, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8');
    return await operation();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // A stale lock owned by this dead process is recoverable on the next run.
    }
  }
}

function isStaleLock(lockPath: string): boolean {
  const ownerPath = path.join(lockPath, 'owner.json');
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as BotSkillLockOwner;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !String(owner.createdAt || '').trim()) {
      return false;
    }
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error: any) {
      return error?.code === 'ESRCH';
    }
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs >= OWNERLESS_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function nonNegativeDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

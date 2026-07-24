import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

const workspaceTails = new Map<string, Promise<void>>();
const heldWorkspaceLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const CORRUPT_LOCK_STALE_MS = 5_000;

export async function withBotSkillWorkspaceLock<T>(
  workspaceKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const normalizedKey = normalizeWorkspaceKey(workspaceKey);
  const inheritedLocks = heldWorkspaceLocks.getStore();
  if (inheritedLocks?.has(normalizedKey)) return operation();

  const previous = workspaceTails.get(normalizedKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  workspaceTails.set(normalizedKey, tail);
  await previous.catch(() => undefined);
  const fileLock = await acquireWorkspaceFileLock(normalizedKey);
  try {
    const nextLocks = new Set(inheritedLocks ?? []);
    nextLocks.add(normalizedKey);
    return await heldWorkspaceLocks.run(nextLocks, operation);
  } finally {
    fileLock.release();
    release();
    if (workspaceTails.get(normalizedKey) === tail) workspaceTails.delete(normalizedKey);
  }
}

async function acquireWorkspaceFileLock(workspaceKey: string): Promise<{ release(): void }> {
  const lockPath = path.join(
    path.dirname(workspaceKey),
    `.${path.basename(workspaceKey)}.bot-skill.lock`,
  );
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const nonce = crypto.randomUUID();
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() }));
      return {
        release(): void {
          try {
            fs.closeSync(descriptor);
          } finally {
            try {
              const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
              if (current?.nonce === nonce) fs.rmSync(lockPath, { force: true });
            } catch {
              // Never remove a lock we cannot prove belongs to this holder.
            }
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        const timeout: any = new Error('Timed out waiting for the Bot Skill workspace lock.');
        timeout.code = 'BOT_SKILL_WORKSPACE_LOCK_TIMEOUT';
        throw timeout;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

function normalizeWorkspaceKey(workspaceKey: string): string {
  const resolved = path.resolve(workspaceKey);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function removeStaleLock(lockPath: string): void {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const pid = Number(value?.pid);
    if (!Number.isInteger(pid) || pid < 1 || !isProcessAlive(pid)) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // A fresh partial write may belong to a live acquirer. A sufficiently old
    // unreadable file can only be crash residue and must not brick the workspace.
    try {
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs >= CORRUPT_LOCK_STALE_MS) fs.rmSync(lockPath, { force: true });
    } catch {
      // The lock disappeared or cannot be inspected; retry acquisition.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

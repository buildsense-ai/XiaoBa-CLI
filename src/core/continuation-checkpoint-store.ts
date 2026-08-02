import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from '../types';
import { PathResolver } from '../utils/path-resolver';

export function continuationCheckpointPath(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey, 'utf8').digest('hex');
  return path.join(
    PathResolver.getRuntimeDataRoot(),
    'state',
    'continuation-checkpoints',
    `${digest}.json`,
  );
}

export async function persistContinuationCheckpoint(
  messages: Message[],
  checkpointPath: string,
): Promise<void> {
  const serialized = JSON.stringify(messages);
  const directoryPath = path.dirname(checkpointPath);
  await fs.promises.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  try { await fs.promises.chmod(directoryPath, 0o700); } catch { /* best effort */ }
  const temporaryPath = `${checkpointPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, checkpointPath);
    try { await fs.promises.chmod(checkpointPath, 0o600); } catch { /* best effort */ }
    await fsyncDirectory(directoryPath);
    const restoredSerialized = await fs.promises.readFile(checkpointPath, 'utf8');
    if (restoredSerialized !== serialized) {
      throw new Error('continuation checkpoint restore mismatch');
    }
    const restored = JSON.parse(restoredSerialized) as Message[];
    messages.splice(0, messages.length, ...restored);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function removeContinuationCheckpoint(checkpointPath: string): Promise<void> {
  await fs.promises.unlink(checkpointPath).catch(error => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  try {
    const directory = await fs.promises.open(directoryPath, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Directory fsync is unavailable on some platforms; rename still publishes
    // a complete file and the read-back check gates episode resume.
  }
}

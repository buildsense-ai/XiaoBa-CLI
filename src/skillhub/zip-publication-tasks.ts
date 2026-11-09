import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { collectBotSkillPackageFiles } from '../bot-skills/local-manifest';
import type { ToolExecutionContext } from '../types/tool';

const TASK_TTL_MS = 60 * 60_000;
const MAX_TASKS = 8;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ZipPublicationTask {
  id: string;
  owner: string;
  fileName: string;
  directory: string;
  cleanupDirectory: string;
  fingerprint: string;
  bytes: number;
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

/** Only packages safely extracted under a live attachment grant enter this store.
 * No historical attachment paths or grants are consulted on subsequent turns. */
export class ZipPublicationTaskStore {
  private readonly tasks = new Map<string, ZipPublicationTask>();

  retain(context: ToolExecutionContext, fileName: string, directory: string, cleanupDirectory: string, uncompressedBytes: number): ZipPublicationTask | undefined {
    const owner = publicationTaskOwner(context);
    if (!owner) return undefined;
    const snapshot = fingerprint(directory);
    snapshot.bytes = Math.max(snapshot.bytes, uncompressedBytes);
    if (snapshot.bytes > MAX_TOTAL_BYTES) return undefined;
    this.prune();
    while (this.tasks.size >= MAX_TASKS || this.totalBytes() + snapshot.bytes > MAX_TOTAL_BYTES) {
      const oldest = this.tasks.values().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
    const task: ZipPublicationTask = {
      id: randomUUID(), owner, fileName, directory, cleanupDirectory,
      ...snapshot, expiresAt: Date.now() + TASK_TTL_MS,
    };
    this.tasks.set(task.id, task);
    task.timer = setTimeout(() => this.remove(task), TASK_TTL_MS);
    task.timer.unref?.();
    return task;
  }

  find(context: ToolExecutionContext, selector: { id?: string; fileName?: string }): ZipPublicationTask[] {
    this.prune();
    const owner = publicationTaskOwner(context);
    if (!owner) return [];
    return [...this.tasks.values()].filter(task => task.owner === owner
      && (selector.id ? task.id === selector.id : task.fileName === selector.fileName));
  }

  verify(task: ZipPublicationTask): void {
    if (this.tasks.get(task.id) !== task || task.expiresAt <= Date.now()
      || fingerprint(task.directory).fingerprint !== task.fingerprint) {
      throw new Error('保留的 ZIP 发布副本已过期、被清理或发生改动。请重新上传原始 ZIP；不要改用缓存路径绕过校验。');
    }
  }

  private prune(): void {
    for (const task of this.tasks.values()) if (task.expiresAt <= Date.now()) this.remove(task);
  }

  private totalBytes(): number {
    return [...this.tasks.values()].reduce((sum, task) => sum + task.bytes, 0);
  }

  private remove(task: ZipPublicationTask): void {
    if (this.tasks.get(task.id) !== task) return;
    this.tasks.delete(task.id);
    if (task.timer) clearTimeout(task.timer);
    void fs.promises.rm(task.cleanupDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function fingerprint(directory: string): { fingerprint: string; bytes: number } {
  const files = collectBotSkillPackageFiles(directory)
    .map(file => ({ path: file.path, contentBase64: file.contentBase64 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.contentBase64, 'base64'), 0),
  };
}

export function publicationTaskOwner(context: ToolExecutionContext): string | undefined {
  const scope = context.executionScope;
  if (context.surface !== 'catscompany' || !context.sessionId || scope?.source !== 'catscompany'
    || !scope.isTrusted || scope.identityTrust !== 'server_canonical'
    || !scope.actorUserId || !scope.sessionKey || !scope.topicId || !scope.agentId || !scope.agentBodyId) return undefined;
  return JSON.stringify([context.sessionId, scope.sessionKey, scope.topicId, scope.topicType,
    scope.actorUserId, scope.agentId, scope.agentBodyId]);
}

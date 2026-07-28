import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  BotDefinitionFieldPatch,
  CloudBotDefinitionSnapshot,
  LocalBotDefinitionCloudState,
  PendingBotDefinitionAck,
  PendingBotDefinitionPatch,
} from './types';

const STATE_SCHEMA = 'xiaoba.bot-definition-cloud-state.v1' as const;

export class FileBotDefinitionCloudStateRepository {
  private readonly root: string;
  private readonly lockRoot: string;

  constructor(runtimeRoot: string) {
    this.root = path.join(path.resolve(runtimeRoot), 'data', 'bot-definition-cloud-state');
    this.lockRoot = path.join(this.root, '.locks');
  }

  read(botId: string): LocalBotDefinitionCloudState {
    return this.readUnlocked(botId);
  }

  write(state: LocalBotDefinitionCloudState): void {
    this.withWriteLock(state.botId, () => this.writeUnlocked(state));
  }

  recordSnapshot(botId: string, snapshot: CloudBotDefinitionSnapshot): LocalBotDefinitionCloudState {
    return this.mutate(botId, state => ({ ...state, snapshot, definitionProtocolSeen: true }));
  }

  markDefinitionProtocolSeen(botId: string): void {
    this.mutate(botId, state => ({ ...state, definitionProtocolSeen: true }));
  }

  queuePatch(
    botId: string,
    expectedRevision: number,
    changes: BotDefinitionFieldPatch,
    source: PendingBotDefinitionPatch['source'] = 'user',
  ): PendingBotDefinitionPatch {
    let queued!: PendingBotDefinitionPatch;
    this.mutate(botId, state => {
      const previous = state.pendingPatch;
      queued = {
        botId,
        expectedRevision: previous?.expectedRevision ?? expectedRevision,
        changes: { ...previous?.changes, ...changes },
        source: previous?.source === 'user' ? 'user' : source,
        idempotencyKey: previous?.idempotencyKey ?? randomUUID(),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        status: previous?.status ?? 'pending',
        ...(previous?.conflictRevision !== undefined
          ? { conflictRevision: previous.conflictRevision }
          : {}),
      };
      return { ...state, pendingPatch: queued };
    });
    return queued;
  }

  markPatchConflicted(botId: string, conflictRevision?: number): void {
    this.mutate(botId, state => {
      if (!state.pendingPatch) return state;
      return {
        ...state,
        pendingPatch: {
          ...state.pendingPatch,
          status: 'conflicted',
          ...(conflictRevision !== undefined ? { conflictRevision } : {}),
        },
      };
    });
  }

  clearPatch(botId: string): void {
    this.mutate(botId, state => {
      if (!state.pendingPatch) return state;
      const { pendingPatch: _pendingPatch, ...next } = state;
      return next;
    });
  }

  acceptCloudAndClearConflict(
    botId: string,
    expectedPending: PendingBotDefinitionPatch,
    snapshot: CloudBotDefinitionSnapshot,
  ): boolean {
    let accepted = false;
    this.mutate(botId, state => {
      if (
        !state.pendingPatch
        || state.pendingPatch.status !== 'conflicted'
        || JSON.stringify(state.pendingPatch) !== JSON.stringify(expectedPending)
      ) {
        return state;
      }
      const { pendingPatch: _pendingPatch, ...next } = state;
      accepted = true;
      return { ...next, snapshot, definitionProtocolSeen: true };
    });
    return accepted;
  }

  completePatch(
    botId: string,
    submitted: PendingBotDefinitionPatch,
    committedRevision: number,
  ): void {
    this.mutate(botId, state => {
      const current = state.pendingPatch;
      if (!current) return state;
      const remaining: BotDefinitionFieldPatch = {};
      for (const field of ['model', 'savedCustomModel', 'prompt'] as const) {
        const currentValue = current.changes[field];
        if (currentValue === undefined) continue;
        const submittedValue = submitted.changes[field];
        if (
          submittedValue === undefined
          || JSON.stringify(currentValue) !== JSON.stringify(submittedValue)
        ) {
          (remaining as any)[field] = currentValue;
        }
      }
      if (Object.keys(remaining).length === 0) {
        const { pendingPatch: _pendingPatch, ...next } = state;
        return next;
      }
      return {
        ...state,
        pendingPatch: {
          botId,
          expectedRevision: committedRevision,
          changes: remaining,
          source: current.source,
          idempotencyKey: randomUUID(),
          createdAt: new Date().toISOString(),
          status: 'pending',
        },
      };
    });
  }

  rebasePatch(botId: string, expectedRevision: number): PendingBotDefinitionPatch | undefined {
    let rebased: PendingBotDefinitionPatch | undefined;
    this.mutate(botId, state => {
      if (!state.pendingPatch) return state;
      const { conflictRevision: _conflictRevision, ...pending } = state.pendingPatch;
      rebased = {
        ...pending,
        expectedRevision,
        status: 'pending',
        idempotencyKey: randomUUID(),
      };
      return { ...state, pendingPatch: rebased };
    });
    return rebased;
  }

  markApplied(botId: string, revision: number): void {
    this.mutate(botId, state => ({
      ...state,
      appliedRevision: revision,
      ...(state.snapshot?.revision === revision ? { appliedSnapshot: state.snapshot } : {}),
    }));
  }

  queueAck(botId: string, revision: number, error = ''): PendingBotDefinitionAck {
    const pendingAck: PendingBotDefinitionAck = {
      revision,
      ...(error ? { error } : {}),
      createdAt: new Date().toISOString(),
    };
    this.mutate(botId, state => ({ ...state, pendingAck }));
    return pendingAck;
  }

  clearAck(botId: string, revision: number): void {
    this.mutate(botId, state => {
      if (state.pendingAck?.revision !== revision) return state;
      const { pendingAck: _pendingAck, ...next } = state;
      return next;
    });
  }

  private mutate(
    botId: string,
    update: (state: LocalBotDefinitionCloudState) => LocalBotDefinitionCloudState,
  ): LocalBotDefinitionCloudState {
    return this.withWriteLock(botId, () => {
      const next = update(this.readUnlocked(botId));
      this.writeUnlocked(next);
      return next;
    });
  }

  private readUnlocked(botId: string): LocalBotDefinitionCloudState {
    const filePath = this.filePath(botId);
    if (!fs.existsSync(filePath)) return this.empty(botId);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LocalBotDefinitionCloudState;
      if (parsed?.schema === STATE_SCHEMA && parsed.botId === botId) return parsed;
    } catch {
      // Preserve unreadable durable work for diagnostics instead of silently
      // treating pending writes/ACKs as if they never existed.
    }
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(filePath, corruptPath);
    } catch {
      // Another process may already have quarantined it.
    }
    return this.empty(botId);
  }

  private writeUnlocked(state: LocalBotDefinitionCloudState): void {
    const filePath = this.filePath(state.botId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best effort on filesystems without POSIX permissions.
      }
    }
  }

  private empty(botId: string): LocalBotDefinitionCloudState {
    return { schema: STATE_SCHEMA, botId };
  }

  private filePath(botId: string): string {
    const normalized = String(botId || '').trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(normalized)) throw new Error('botId contains unsupported characters');
    return path.join(this.root, `${normalized}.json`);
  }

  private withWriteLock<T>(botId: string, operation: () => T): T {
    const normalized = String(botId || '').trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(normalized)) throw new Error('botId contains unsupported characters');
    fs.mkdirSync(this.lockRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.lockRoot, `${normalized}.lock`);
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const descriptor = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf-8');
          return operation();
        } finally {
          fs.closeSync(descriptor);
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // A stale-lock cleanup may already have removed it.
          }
        }
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        if (this.removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for BotDefinition cloud-state lock: ${normalized}`);
        }
        const until = Date.now() + 20;
        while (Date.now() < until) {
          // Synchronous repository API: keep the wait short and bounded.
        }
      }
    }
  }

  private removeStaleLock(lockPath: string): boolean {
    try {
      const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
      const stat = fs.statSync(lockPath);
      let processAlive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          processAlive = true;
        } catch {
          processAlive = false;
        }
      }
      if (processAlive || Date.now() - stat.mtimeMs < 30_000) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch (error: any) {
      return error?.code === 'ENOENT';
    }
  }
}

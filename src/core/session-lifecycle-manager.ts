import { Message } from '../types';
import { Logger } from '../utils/logger';
import { SessionStore } from '../utils/session-store';
import { RuntimeFeedbackInbox } from './runtime-feedback-inbox';

/**
 * 记多少条「本运行体发出的消息 seq」。回填受游标与分页（每页 100）限制，只可能
 * 覆盖最近这段历史；更早的早已被游标挡住，多留只会让状态文件无限增长。
 */
const MAX_SENT_REMOTE_IDS = 200;

export interface SessionLifecycleManagerOptions {
  sessionKey: string;
  legacySessionKey?: string;
  legacyRestoreKey?: string;
  legacyCleanupKey?: string;
  allowLegacySessionFallback?: boolean;
  runtimeFeedbackInbox: RuntimeFeedbackInbox;
  sessionStore?: SessionStore;
}

export interface ResetSessionStateResult {
  initialized: boolean;
  lastActiveAt: number;
}

export interface ClearSessionStateResult extends ResetSessionStateResult {
  persisted: boolean;
}

export interface PersistAndClearResult {
  messages: Message[];
  saved: boolean;
  savedCount: number;
}

/**
 * Owns local lifecycle state that is not part of the turn execution pipeline.
 */
export class SessionLifecycleManager {
  private pendingRestore?: Message[];
  private readonly sessionStore: SessionStore;

  constructor(private readonly options: SessionLifecycleManagerOptions) {
    this.sessionStore = options.sessionStore ?? SessionStore.getInstance();
  }

  markRestoreFromStore(): boolean {
    const restoreKey = this.resolveExistingSessionKey();
    if (!restoreKey) {
      this.pendingRestore = undefined;
      return false;
    }
    const messages = this.sessionStore.loadContext(restoreKey);
    if (messages.length === 0) {
      this.pendingRestore = undefined;
      return false;
    }
    this.pendingRestore = messages;
    Logger.info(`[会话 ${this.options.sessionKey}] 标记从 DB 恢复 ${messages.length} 条消息${restoreKey === this.options.sessionKey ? '' : ` (legacy: ${restoreKey})`}`);
    return true;
  }

  consumePendingRestore(): Message[] {
    const messages = this.pendingRestore ?? [];
    this.pendingRestore = undefined;
    return messages;
  }

  reset(): ResetSessionStateResult {
    this.pendingRestore = undefined;
    this.options.runtimeFeedbackInbox.reset();
    return {
      initialized: false,
      lastActiveAt: Date.now(),
    };
  }

  clear(): ClearSessionStateResult {
    const sessionDeleted = this.sessionStore.deleteSession(this.options.sessionKey);
    const stateDeleted = this.sessionStore.deleteRuntimeState(this.options.sessionKey);
    let persisted = sessionDeleted && stateDeleted;
    for (const cleanupKey of this.resolveLegacyCleanupKeys()) {
      const legacySessionDeleted = this.sessionStore.deleteSession(cleanupKey);
      const legacyStateDeleted = this.sessionStore.deleteRuntimeState(cleanupKey);
      persisted = legacySessionDeleted && legacyStateDeleted && persisted;
    }
    return { ...this.reset(), persisted };
  }

  saveContext(messages: Message[]): boolean {
    return this.sessionStore.saveContext(this.options.sessionKey, messages);
  }

  loadCurrentDirectory(): string | undefined {
    const current = this.sessionStore.loadRuntimeState(this.options.sessionKey).currentDirectory;
    if (current) return current;
    if (!this.shouldUseLegacySessionFallback()) {
      return undefined;
    }
    const legacyRestoreKey = this.resolveLegacyRestoreKey();
    if (!legacyRestoreKey || legacyRestoreKey === this.options.sessionKey) {
      return undefined;
    }
    return this.sessionStore.loadRuntimeState(legacyRestoreKey).currentDirectory;
  }

  saveCurrentDirectory(currentDirectory: string): void {
    this.sessionStore.saveRuntimeState(this.options.sessionKey, {
      ...this.sessionStore.loadRuntimeState(this.options.sessionKey),
      currentDirectory,
    });
  }

  loadRemoteContextCursor(source: string): number {
    const cursor = Number(this.sessionStore.loadRuntimeState(this.options.sessionKey).remoteContextCursors?.[source]);
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }

  /**
   * 本运行体发出的消息 seq（按远端 source 分组）。
   *
   * 只保留最近若干条：回填只可能覆盖最近这段历史，更早的早已被游标挡在
   * 外面，留着只会让状态文件无限增长。
   */
  loadSentRemoteIds(source: string): number[] {
    const raw = this.sessionStore.loadRuntimeState(this.options.sessionKey).sentRemoteIds?.[source];
    if (!Array.isArray(raw)) return [];
    return raw.filter(value => Number.isFinite(value) && value > 0);
  }

  recordSentRemoteIds(source: string, ids: number[]): boolean {
    if (!source) return false;
    const accepted = ids.filter(id => Number.isFinite(id) && id > 0);
    if (accepted.length === 0) return false;
    const state = this.sessionStore.loadRuntimeState(this.options.sessionKey);
    const previous = state.sentRemoteIds?.[source] || [];
    const merged = [...new Set([...previous, ...accepted])];
    const bounded = merged.length > MAX_SENT_REMOTE_IDS
      ? merged.slice(merged.length - MAX_SENT_REMOTE_IDS)
      : merged;
    return this.sessionStore.saveRuntimeState(this.options.sessionKey, {
      ...state,
      sentRemoteIds: {
        ...(state.sentRemoteIds || {}),
        [source]: bounded,
      },
    });
  }

  saveRemoteContextCursor(source: string, cursor: number): boolean {
    if (!source || !Number.isFinite(cursor) || cursor <= 0) return false;
    const state = this.sessionStore.loadRuntimeState(this.options.sessionKey);
    return this.sessionStore.saveRuntimeState(this.options.sessionKey, {
      ...state,
      remoteContextCursors: {
        ...(state.remoteContextCursors || {}),
        [source]: cursor,
      },
    });
  }

  persistAndClear(messages: Message[]): PersistAndClearResult {
    if (messages.length === 0) {
      return { messages, saved: false, savedCount: 0 };
    }

    const saved = this.saveContext(messages);
    return {
      messages: saved ? [] : messages,
      saved,
      savedCount: saved ? messages.length : 0,
    };
  }

  hasPendingRestore(): boolean {
    return !!this.pendingRestore;
  }

  private resolveExistingSessionKey(): string | undefined {
    if (this.sessionStore.hasSession(this.options.sessionKey)) {
      return this.options.sessionKey;
    }
    if (!this.shouldUseLegacySessionFallback()) {
      return undefined;
    }
    const legacy = this.resolveLegacyRestoreKey();
    if (legacy && legacy !== this.options.sessionKey && this.sessionStore.hasSession(legacy)) {
      return legacy;
    }
    return undefined;
  }

  private resolveLegacyRestoreKey(): string | undefined {
    return this.options.legacyRestoreKey || this.options.legacySessionKey;
  }

  private resolveLegacyCleanupKeys(): string[] {
    const keys = [
      this.options.legacyCleanupKey,
      this.options.legacyRestoreKey,
      this.options.legacySessionKey,
    ];
    const uniqueKeys = new Set<string>();
    for (const key of keys) {
      if (!key || key === this.options.sessionKey) continue;
      uniqueKeys.add(key);
    }
    return Array.from(uniqueKeys);
  }

  private shouldUseLegacySessionFallback(): boolean {
    return this.options.allowLegacySessionFallback !== false;
  }
}

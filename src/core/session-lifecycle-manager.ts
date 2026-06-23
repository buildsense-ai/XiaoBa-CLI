import { Message } from '../types';
import { Logger } from '../utils/logger';
import { SessionStore } from '../utils/session-store';
import { RuntimeFeedbackInbox } from './runtime-feedback-inbox';

export interface SessionLifecycleManagerOptions {
  sessionKey: string;
  legacySessionKey?: string;
  allowLegacySessionFallback?: boolean;
  runtimeFeedbackInbox: RuntimeFeedbackInbox;
  sessionStore?: SessionStore;
}

export interface ResetSessionStateResult {
  initialized: boolean;
  lastActiveAt: number;
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

  clear(): ResetSessionStateResult {
    this.sessionStore.deleteSession(this.options.sessionKey);
    this.sessionStore.deleteRuntimeState(this.options.sessionKey);
    if (this.shouldUseLegacySessionFallback()
      && this.options.legacySessionKey
      && this.options.legacySessionKey !== this.options.sessionKey) {
      this.sessionStore.deleteSession(this.options.legacySessionKey);
      this.sessionStore.deleteRuntimeState(this.options.legacySessionKey);
    }
    return this.reset();
  }

  saveContext(messages: Message[]): void {
    this.sessionStore.saveContext(this.options.sessionKey, messages);
  }

  loadCurrentDirectory(): string | undefined {
    const current = this.sessionStore.loadRuntimeState(this.options.sessionKey).currentDirectory;
    if (current) return current;
    if (!this.shouldUseLegacySessionFallback()
      || !this.options.legacySessionKey
      || this.options.legacySessionKey === this.options.sessionKey) {
      return undefined;
    }
    return this.sessionStore.loadRuntimeState(this.options.legacySessionKey).currentDirectory;
  }

  saveCurrentDirectory(currentDirectory: string): void {
    this.sessionStore.saveRuntimeState(this.options.sessionKey, { currentDirectory });
  }

  persistAndClear(messages: Message[]): PersistAndClearResult {
    if (messages.length === 0) {
      return { messages, saved: false, savedCount: 0 };
    }

    this.saveContext(messages);
    return { messages: [], saved: true, savedCount: messages.length };
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
    const legacy = this.options.legacySessionKey;
    if (legacy && legacy !== this.options.sessionKey && this.sessionStore.hasSession(legacy)) {
      return legacy;
    }
    return undefined;
  }

  private shouldUseLegacySessionFallback(): boolean {
    return this.options.allowLegacySessionFallback !== false;
  }
}

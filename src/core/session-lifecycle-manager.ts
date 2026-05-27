import { Message } from '../types';
import type { SessionIdentitySnapshot } from '../types/session-identity';
import { Logger } from '../utils/logger';
import { SessionStore } from '../utils/session-store';
import { RuntimeFeedbackInbox } from './runtime-feedback-inbox';

export interface SessionLifecycleManagerOptions {
  sessionKey: string;
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
    if (!this.sessionStore.hasSession(this.options.sessionKey)) {
      this.pendingRestore = undefined;
      return false;
    }
    const messages = this.sessionStore.loadContext(this.options.sessionKey);
    if (messages.length === 0) {
      this.pendingRestore = undefined;
      return false;
    }
    this.pendingRestore = messages;
    Logger.info(`[会话 ${this.options.sessionKey}] 标记从 DB 恢复 ${messages.length} 条消息`);
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
    return this.reset();
  }

  saveContext(messages: Message[]): void {
    this.sessionStore.saveContext(this.options.sessionKey, messages);
  }

  loadCurrentDirectory(): string | undefined {
    return this.sessionStore.loadRuntimeState(this.options.sessionKey).currentDirectory;
  }

  saveCurrentDirectory(currentDirectory: string): void {
    this.sessionStore.saveRuntimeState(this.options.sessionKey, { currentDirectory });
  }

  saveSessionIdentity(sessionIdentity: SessionIdentitySnapshot): void {
    this.sessionStore.saveRuntimeState(this.options.sessionKey, { sessionIdentity });
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
}

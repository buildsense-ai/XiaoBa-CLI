import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { Logger } from './logger';

const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'sessions');

function ensureDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function keyToFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl';
}

function filePath(key: string): string {
  return path.join(SESSIONS_DIR, keyToFilename(key));
}

function archivedPath(key: string): string {
  return path.join(SESSIONS_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.archived.jsonl');
}

export class SessionStore {
  private static instance: SessionStore | null = null;

  static getInstance(): SessionStore {
    if (!SessionStore.instance) SessionStore.instance = new SessionStore();
    return SessionStore.instance;
  }

  /** 追加消息（跳过 system 和 __injected） */
  appendMessages(sessionKey: string, messages: Message[]): void {
    try {
      ensureDir();
      const fp = filePath(sessionKey);
      const lines = messages
        .filter(m => m.role !== 'system' && !(m as any).__injected)
        .map(m => JSON.stringify(m));
      if (lines.length > 0) {
        fs.appendFileSync(fp, lines.join('\n') + '\n', 'utf-8');
      }
    } catch (err) {
      Logger.error(`持久化消息失败 [${sessionKey}]: ${err}`);
    }
  }

  /** 加载未归档的消息 */
  loadMessages(sessionKey: string): Message[] {
    try {
      const fp = filePath(sessionKey);
      if (!fs.existsSync(fp)) return [];
      const content = fs.readFileSync(fp, 'utf-8').trim();
      if (!content) return [];
      const msgs: Message[] = [];
      for (const line of content.split('\n')) {
        try { msgs.push(JSON.parse(line) as Message); }
        catch { Logger.warning(`跳过损坏的 JSONL 行 [${sessionKey}]: ${line.slice(0, 50)}`); }
      }
      return msgs;
    } catch (err) {
      Logger.error(`加载消息失败 [${sessionKey}]: ${err}`);
      return [];
    }
  }

  /** 归档会话（rename 为 .archived.jsonl） */
  archiveSession(sessionKey: string): void {
    try {
      const fp = filePath(sessionKey);
      if (!fs.existsSync(fp)) return;
      fs.renameSync(fp, archivedPath(sessionKey));
      Logger.info(`会话已归档: ${sessionKey}`);
    } catch (err) {
      Logger.error(`归档会话失败 [${sessionKey}]: ${err}`);
    }
  }

  /** 检查是否有未归档的会话文件 */
  hasActiveSession(sessionKey: string): boolean {
    return fs.existsSync(filePath(sessionKey));
  }
}

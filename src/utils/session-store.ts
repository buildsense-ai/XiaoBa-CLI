import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { Logger } from './logger';

const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'sessions');
const SESSION_STATE_DIR = path.resolve(process.cwd(), 'data', 'session-state');

function ensureDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function keyToFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl';
}

function filePath(key: string): string {
  return path.join(SESSIONS_DIR, keyToFilename(key));
}

function stateFilePath(key: string): string {
  return path.join(SESSION_STATE_DIR, keyToFilename(key).replace(/\.jsonl$/, '.json'));
}

export interface SessionRuntimeState {
  currentDirectory?: string;
  updatedAt?: string;
}

export class SessionStore {
  private static instance: SessionStore | null = null;

  static getInstance(): SessionStore {
    if (!SessionStore.instance) SessionStore.instance = new SessionStore();
    return SessionStore.instance;
  }

  /** 保存完整 context（覆盖写入） */
  saveContext(sessionKey: string, messages: Message[]): void {
    try {
      ensureDir();
      const fp = filePath(sessionKey);
      const lines = messages
        .filter(m => !(m as any).__injected) // 跳过注入的临时消息
        .filter(m => m.role !== 'system') // 跳过系统消息，恢复时会重新生成
        .map(m => JSON.stringify(m));
      fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
    } catch (err) {
      Logger.error(`保存 context 失败 [${sessionKey}]: ${err}`);
    }
  }

  /** 加载完整 context */
  loadContext(sessionKey: string): Message[] {
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
      Logger.error(`加载 context 失败 [${sessionKey}]: ${err}`);
      return [];
    }
  }

  /** 检查是否有会话文件 */
  hasSession(sessionKey: string): boolean {
    return fs.existsSync(filePath(sessionKey));
  }

  /** 删除会话文件 */
  deleteSession(sessionKey: string): void {
    try {
      const fp = filePath(sessionKey);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      Logger.info(`会话已删除: ${sessionKey}`);
    } catch (err) {
      Logger.error(`删除会话失败 [${sessionKey}]: ${err}`);
    }
  }

  loadRuntimeState(sessionKey: string): SessionRuntimeState {
    try {
      const fp = stateFilePath(sessionKey);
      if (!fs.existsSync(fp)) return {};
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as SessionRuntimeState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      Logger.error(`Failed to load session state [${sessionKey}]: ${err}`);
      return {};
    }
  }

  saveRuntimeState(sessionKey: string, state: SessionRuntimeState): void {
    try {
      if (!fs.existsSync(SESSION_STATE_DIR)) fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
      fs.writeFileSync(stateFilePath(sessionKey), JSON.stringify({
        ...state,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch (err) {
      Logger.error(`Failed to save session state [${sessionKey}]: ${err}`);
    }
  }

  deleteRuntimeState(sessionKey: string): void {
    try {
      const fp = stateFilePath(sessionKey);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (err) {
      Logger.error(`Failed to delete session state [${sessionKey}]: ${err}`);
    }
  }
}

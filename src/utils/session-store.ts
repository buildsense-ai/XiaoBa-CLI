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

  /** 归档会话文件（移动到 archive 目录） */
  archiveSession(sessionKey: string): void {
    try {
      const fp = filePath(sessionKey);
      if (!fs.existsSync(fp)) return;
      const archiveDir = path.join(SESSIONS_DIR, 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, keyToFilename(sessionKey));
      fs.renameSync(fp, archivePath);
      Logger.info(`会话已归档: ${sessionKey}`);
    } catch (err) {
      Logger.error(`归档会话失败 [${sessionKey}]: ${err}`);
    }
  }
}

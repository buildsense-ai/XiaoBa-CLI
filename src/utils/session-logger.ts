import * as fs from 'fs';
import * as path from 'path';

const SESSION_LOG_DIR = path.resolve(process.cwd(), 'logs', 'sessions');

/**
 * 轻量级 session 级日志，每个会话独立一个文件。
 * 只记录对话内容（user/assistant/tool），不替代全局 Logger。
 */
export class SessionLogger {
  private stream: fs.WriteStream | null = null;
  private _logPath: string | null = null;

  constructor(private sessionKey: string) {}

  get logPath(): string | null { return this._logPath; }

  open(): void {
    const now = new Date();
    const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const safeKey = this.sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${hh}-${mm}-${ss}_${safeKey}.log`;

    const dir = path.join(SESSION_LOG_DIR, dateDir);
    fs.mkdirSync(dir, { recursive: true });

    this._logPath = path.join(dir, fileName);
    this.stream = fs.createWriteStream(this._logPath, { flags: 'a' });
  }

  write(role: string, content: string): void {
    if (!this.stream) return;
    const ts = new Date().toISOString();
    this.stream.write(`[${ts}] [${role}] ${content}\n`);
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { styles } from '../theme/colors';
import ora, { Ora } from 'ora';
import type { SessionTurnLogger } from './session-turn-logger';
import type { SessionRuntimeLogEvent } from './session-log-schema';
import { PathResolver } from './path-resolver';

interface LoggerContextStore {
  sessionId?: string;
  sessionLogger?: SessionTurnLogger;
}

/** Maximum number of session contexts to keep before cleanup */
const MAX_SESSION_CONTEXTS = 1000;
/** Interval for cleaning up expired session contexts (in ms) */
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Session context registry for cleanup tracking.
 * Uses a simple ring buffer approach to avoid memory leaks in long-running processes.
 */
class SessionContextRegistry {
  private sessions: Map<string, number> = new Map();
  private lastCleanup = Date.now();

  /**
   * Track a session context.
   */
  track(sessionId: string): void {
    this.sessions.set(sessionId, Date.now());
    
    // Trigger cleanup if we have too many sessions
    if (this.sessions.size > MAX_SESSION_CONTEXTS) {
      this.cleanup();
    }
  }

  /**
   * Remove a session context.
   */
  untrack(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Clean up old session contexts.
   * Called periodically or when the registry is full.
   */
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - SESSION_CLEANUP_INTERVAL_MS;
    
    for (const [sessionId, lastAccess] of this.sessions) {
      if (lastAccess < cutoff) {
        this.sessions.delete(sessionId);
      }
    }
    
    this.lastCleanup = now;
  }

  /**
   * Clean up session contexts older than the specified max age.
   * Useful for forcing cleanup of stale sessions.
   * 
   * @param maxAgeMs - Maximum age in milliseconds. Sessions older than this will be removed.
   */
  cleanupStale(maxAgeMs: number): number {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    let removed = 0;
    
    for (const [sessionId, lastAccess] of this.sessions) {
      if (lastAccess < cutoff) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }
    
    return removed;
  }

  /**
   * Get the number of tracked sessions.
   */
  size(): number {
    return this.sessions.size;
  }
}

const sessionRegistry = new SessionContextRegistry();

// Set up periodic cleanup
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startPeriodicCleanup(): void {
  if (cleanupTimer) return;
  
  cleanupTimer = setInterval(() => {
    sessionRegistry.cleanup();
  }, SESSION_CLEANUP_INTERVAL_MS);
  
  // Don't prevent the process from exiting
  cleanupTimer.unref();
}

function stopPeriodicCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export class Logger {
  private static spinner: Ora | null = null;
  private static logStream: fs.WriteStream | null = null;
  private static logFilePath: string | null = null;
  private static silentMode: boolean = false;
  private static logContext = new AsyncLocalStorage<LoggerContextStore>();

  private static stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*m/g, '');
  }

  private static writeToFile(level: string, message: string, event?: SessionRuntimeLogEvent): void {
    const store = this.logContext.getStore();
    if (store?.sessionLogger) {
      store.sessionLogger.logRuntime(level, this.stripAnsi(message), event);
      return;
    }

    if (!this.logStream) {
      return;
    }

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    this.logStream.write(`[${ts}] [${level}] ${this.stripAnsi(message)}\n`);
  }

  static runtimeEvent(level: string, message: string, event: SessionRuntimeLogEvent): void {
    this.writeToFile(level, message, event);
  }

  static withSessionContext<T>(sessionId: string | undefined, fn: () => T): T;
  static withSessionContext<T>(sessionId: string | undefined, sessionLogger: SessionTurnLogger, fn: () => T): T;
  static withSessionContext<T>(
    sessionId: string | undefined,
    sessionLoggerOrFn: SessionTurnLogger | (() => T),
    maybeFn?: () => T,
  ): T {
    const normalizedSessionId = typeof sessionId === 'string'
      ? sessionId.replace(/\s+/g, ' ').trim()
      : '';
    const sessionLogger = typeof sessionLoggerOrFn === 'function' ? undefined : sessionLoggerOrFn;
    const fn = typeof sessionLoggerOrFn === 'function' ? sessionLoggerOrFn : maybeFn;
    if (!fn) {
      throw new Error('Logger.withSessionContext missing callback');
    }
    if (!normalizedSessionId) {
      return fn();
    }
    
    // Track the session for cleanup
    sessionRegistry.track(normalizedSessionId);
    
    // Wrap the function to untrack when it completes
    const wrappedFn = () => {
      try {
        return fn();
      } finally {
        // Note: We don't untrack here because the same session might be reused
        // The periodic cleanup handles actual removal
      }
    };
    
    return this.logContext.run({ sessionId: normalizedSessionId, sessionLogger }, wrappedFn);
  }

  /**
   * Clear a session context.
   * Call this when a session is fully terminated.
   */
  static clearSessionContext(sessionId: string): void {
    sessionRegistry.untrack(sessionId);
  }

  /**
   * Force cleanup of stale session contexts.
   * Useful for memory management in long-running processes.
   * 
   * @param maxAgeMs - Maximum age in milliseconds. Sessions older than this will be removed.
   *                  Defaults to 5 minutes.
   * @returns Number of sessions removed
   */
  static cleanupStaleSessions(maxAgeMs: number = SESSION_CLEANUP_INTERVAL_MS): number {
    return sessionRegistry.cleanupStale(maxAgeMs);
  }

  /**
   * Get the number of active session contexts.
   * Useful for monitoring memory usage.
   */
  static getActiveSessionCount(): number {
    return sessionRegistry.size();
  }

  static openLogFile(sessionType: string, sessionKey?: string, silent: boolean = false): void {
    this.silentMode = silent;
    
    // Start periodic cleanup for long-running processes
    startPeriodicCleanup();
    
    const now = new Date();
    const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const suffix = sessionKey ? `${sessionType}_${sessionKey}` : sessionType;
    const fileName = `${hh}-${mm}-${ss}_${suffix}.log`;
    const dir = PathResolver.getLogsPath(dateDir);

    fs.mkdirSync(dir, { recursive: true });
    this.logFilePath = path.join(dir, fileName);
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
  }

  static closeLogFile(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
      this.logFilePath = null;
    }
    
    // Optionally stop cleanup when no longer logging
    // Note: Keeping cleanup running is generally safe and prevents issues
    // if new log files are opened later
  }

  static getLogFilePath(): string | null {
    return this.logFilePath;
  }

  static success(message: string): void {
    this.writeToFile('SUCCESS', message);
    console.log(styles.success(message));
  }

  static error(message: string, event?: SessionRuntimeLogEvent): void {
    this.writeToFile('ERROR', message, event);
    console.error(styles.error(message));
  }

  static warning(message: string): void {
    this.writeToFile('WARN', message);
    console.warn(styles.warning(message));
  }

  static info(message: string): void {
    this.writeToFile('INFO', message);
    if (!this.silentMode) {
      console.log(styles.info(message));
    }
  }

  static title(message: string): void {
    this.writeToFile('INFO', message);
    console.log('\n' + styles.title(message) + '\n');
  }

  static text(message: string): void {
    this.writeToFile('TEXT', message);
    console.log(styles.text(message));
  }

  static highlight(message: string): void {
    this.writeToFile('TEXT', message);
    console.log(styles.highlight(message));
  }

  /**
   * 启动进度指示器
   * @param message 进度消息
   */
  static startProgress(message: string): void {
    if (this.spinner) {
      this.spinner.stop();
    }
    this.spinner = ora(styles.text(message)).start();
  }

  /**
   * 更新进度消息
   * @param message 新的进度消息
   */
  static updateProgress(message: string): void {
    if (this.spinner) {
      this.spinner.text = styles.text(message);
    }
  }

  /**
   * 停止进度指示器
   * @param success 是否成功（true=成功, false=失败, undefined=仅停止）
   * @param message 最终消息（可选）
   */
  static stopProgress(success?: boolean, message?: string): void {
    if (!this.spinner) {
      return;
    }

    if (success === true) {
      this.spinner.succeed(message ? styles.success(message) : undefined);
    } else if (success === false) {
      this.spinner.fail(message ? styles.error(message) : undefined);
    } else {
      this.spinner.stop();
      if (message) {
        console.log(message);
      }
    }

    this.spinner = null;
  }

  /**
   * 显示百分比进度条
   * @param current 当前进度
   * @param total 总数
   * @param message 进度消息（可选）
   */
  static progressBar(current: number, total: number, message?: string): void {
    const percentage = Math.round((current / total) * 100);
    const barLength = 30;
    const filledLength = Math.round((barLength * current) / total);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

    const progressText = `[${bar}] ${percentage}% (${current}/${total})`;
    const fullMessage = message ? `${message} ${progressText}` : progressText;

    if (this.spinner) {
      this.spinner.text = styles.text(fullMessage);
    } else {
      // 使用 \r 实现同行更新
      process.stdout.write('\r' + styles.text(fullMessage));
    }
  }

  /**
   * 清除进度条（换行）
   */
  static clearProgress(): void {
    if (!this.spinner) {
      process.stdout.write('\n');
    }
  }

  static brand(): void {
    const GAP = "   ";    // 左右两边的间距
    const CAT_WIDTH = 35; // ⚡️关键：左侧猫的占位宽度，必须固定！

    // 1. 左侧：猫 (纯文本)
    const leftRaw = [
      '       ▄████▄             ▄████▄',
      '      ████████▄▄▄▄▄▄▄▄▄▄▄████████',
      '      ███████████████████████████',
      '      ▐██▀  ▀██▀  ▀██▀  ▀██▀  ██▌',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '      ██ ▓▓▓▓██▓▓▓▓▓▓▓▓▓██▓▓▓▓ ██',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '       ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██',
      '        ▀██▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄██▀'
    ];

    // 2. 右侧：XIAO BA (纯文本，已校对)
    // 包含顶部空行以实现垂直居中
    const rightRaw = [
      '', 
      '   ██╗  ██╗██╗ █████╗  ██████╗     ██████╗  █████╗',
      '   ╚██╗██╔╝██║██╔══██╗██╔═══██╗    ██╔══██╗██╔══██╗',
      '    ╚███╔╝ ██║███████║██║   ██║    ██████╔╝███████║',
      '    ██╔██╗ ██║██╔══██║██║   ██║    ██╔══██╗██╔══██║',
      '   ██╔╝ ██╗██║██║  ██║╚██████╔╝    ██████╔╝██║  ██║',
      '   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝     ╚═════╝ ╚═╝  ╚═╝',
      '',
      '      < Your AI Assistant !!! Meow Meow !!! >'
    ];

    // 3. 循环拼接输出
    console.log('\n'); // 顶部留白

    const maxLines = Math.max(leftRaw.length, rightRaw.length);

    for (let i = 0; i < maxLines; i++) {
      const leftText = leftRaw[i] || '';
      const rightText = rightRaw[i] || '';

      // 核心逻辑：先用空格填满左侧宽度，再上色
      const leftPadded = leftText.padEnd(CAT_WIDTH, ' ');
      console.log(styles.title(leftPadded) + GAP + styles.title(rightText));
    }

    console.log('\n'); // 底部留白
  }
}

export default Logger;

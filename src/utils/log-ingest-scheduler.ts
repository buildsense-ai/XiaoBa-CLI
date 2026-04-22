import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { Logger } from './logger';
import { AutoDevLogClient } from './autodev-log-client';
import {
  getLogIngestAutoMaxFiles,
  getLogIngestAutoTime,
  getLogIngestServerUrl,
  getLogIngestStableMinutes,
  isLogIngestAutoEnabled,
} from './log-ingest-config';

interface IngestedLogState {
  size: number;
  mtimeMs: number;
  ingestedAt: string;
}

interface IngestStateFile {
  files: Record<string, IngestedLogState>;
}

type IngestReason = 'startup' | 'scheduled' | 'manual';

export class LogIngestScheduler {
  private readonly workingDirectory: string;
  private readonly logsRoot: string;
  private readonly stateFilePath: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
    this.logsRoot = path.resolve(this.workingDirectory, 'logs');
    this.stateFilePath = path.resolve(this.workingDirectory, 'data', 'log-ingest-state.json');
  }

  static isEnabled(): boolean {
    return isLogIngestAutoEnabled();
  }

  static shouldStartForCurrentRuntime(): boolean {
    const normalizedRole = String(process.env.XIAOBA_ROLE || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    return LogIngestScheduler.isEnabled()
      && normalizedRole !== 'inspector-cat'
      && !!getLogIngestServerUrl();
  }

  async start(): Promise<void> {
    if (this.started || !LogIngestScheduler.shouldStartForCurrentRuntime()) {
      return;
    }

    this.started = true;
    this.stopped = false;
    Logger.info('[LogIngest] scheduler started');

    void this.runPendingIngestCycle('startup');
    this.scheduleNextRun();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    Logger.info('[LogIngest] scheduler stopped');
  }

  async runPendingIngestCycle(reason: IngestReason = 'manual'): Promise<void> {
    if (this.running || this.stopped || !LogIngestScheduler.shouldStartForCurrentRuntime()) {
      return;
    }

    if (!fs.existsSync(this.logsRoot) || !fs.statSync(this.logsRoot).isDirectory()) {
      return;
    }

    this.running = true;
    try {
      const pendingLogPaths = await this.collectPendingLogPaths();
      if (pendingLogPaths.length === 0) {
        Logger.info(`[LogIngest] no pending stable logs (${reason})`);
        return;
      }

      const client = new AutoDevLogClient();
      if (!client.isConfigured()) {
        Logger.warning('[LogIngest] AUTODEV_SERVER_URL not set, skipping');
        return;
      }

      const batch = pendingLogPaths.slice(0, this.getMaxBatchFiles());
      const ingested: Array<{ relativePath: string; size: number; absolutePath: string }> = [];

      for (const relativePath of batch) {
        const absolutePath = path.resolve(this.workingDirectory, relativePath);
        try {
          const { sessionType, sessionId, logDate } = this.parseLogPath(relativePath, absolutePath);
          await client.ingestLog({ filePath: absolutePath, sessionType, sessionId, logDate });
          ingested.push({ relativePath, size: fs.statSync(absolutePath).size, absolutePath });
        } catch (err: any) {
          Logger.warning(`[LogIngest] failed to ingest ${relativePath}: ${err.message}`);
        }
      }

      if (ingested.length > 0) {
        this.markIngested(ingested);
        Logger.info(`[LogIngest] ingested ${ingested.length} files (${reason})`);
      }
    } catch (error: any) {
      Logger.warning(`[LogIngest] cycle failed (${reason}): ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  private parseLogPath(relativePath: string, absolutePath: string): { sessionType: string; sessionId: string; logDate: string } {
    const parts = relativePath.replace(/\\/g, '/').split('/');
    const sessionType = parts[2] || 'unknown';
    const logDate = parts[3] || '';
    const filename = parts[4] || '';
    const sessionId = this.readSessionIdFromJsonl(absolutePath) || this.parseSessionIdFromFilename(filename) || filename.replace(/\.jsonl$/i, '');
    return { sessionType, sessionId, logDate };
  }

  private readSessionIdFromJsonl(filePath: string): string | undefined {
    try {
      const firstLine = fs.readFileSync(filePath, 'utf-8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
      if (!firstLine) {
        return undefined;
      }
      const parsed = JSON.parse(firstLine);
      return typeof parsed?.session_id === 'string' ? parsed.session_id : undefined;
    } catch {
      return undefined;
    }
  }

  private parseSessionIdFromFilename(filename: string): string | undefined {
    const basename = filename.replace(/\.jsonl$/i, '');
    const userMatch = basename.match(/(?:^|_)user_(.+)$/);
    if (userMatch) {
      return `user:${userMatch[1]}`;
    }
    const groupMatch = basename.match(/(?:^|_)group_(.+)$/);
    if (groupMatch) {
      return `group:${groupMatch[1]}`;
    }
    return undefined;
  }

  private getMaxBatchFiles(): number {
    return getLogIngestAutoMaxFiles();
  }

  private getStableAgeMs(): number {
    const minutes = getLogIngestStableMinutes();
    return minutes * 60 * 1000;
  }

  private scheduleNextRun(): void {
    if (this.stopped) {
      return;
    }

    const uploadTime = getLogIngestAutoTime();
    const [hoursRaw, minutesRaw] = uploadTime.split(':');
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    const now = new Date();
    const next = new Date(now);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      next.setHours(20, 0, 0, 0);
    } else {
      next.setHours(hours, minutes, 0, 0);
    }

    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    const delay = Math.max(1000, next.getTime() - now.getTime());
    this.timer = setTimeout(async () => {
      await this.runPendingIngestCycle('scheduled');
      this.scheduleNextRun();
    }, delay);

    Logger.info(`[LogIngest] next run scheduled at ${next.toISOString()}`);
  }

  private async collectPendingLogPaths(): Promise<string[]> {
    const stableBefore = Date.now() - this.getStableAgeMs();
    const state = this.loadState();
    const candidates = await glob(['sessions/**/*.jsonl'], {
      cwd: this.logsRoot,
      absolute: false,
      nodir: true,
      windowsPathsNoEscape: true,
      ignore: ['**/*inspector-review*.jsonl'],
    });

    return candidates
      .map(relativePath => relativePath.replace(/\\/g, '/'))
      .filter(relativePath => this.isStableAndPending(
        relativePath,
        stableBefore,
        state.files[this.toStateKey(relativePath)] || state.files[relativePath],
      ))
      .sort((a, b) => {
        const aStats = fs.statSync(path.join(this.logsRoot, a));
        const bStats = fs.statSync(path.join(this.logsRoot, b));
        return bStats.mtimeMs - aStats.mtimeMs;
      })
      .map(relativePath => path.join('logs', relativePath).replace(/\\/g, '/'));
  }

  private isStableAndPending(relativePath: string, stableBefore: number, ingestedState?: IngestedLogState): boolean {
    const absolutePath = path.join(this.logsRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return false;
    }

    const stats = fs.statSync(absolutePath);
    if (stats.mtimeMs > stableBefore) {
      return false;
    }

    if (!ingestedState) {
      return true;
    }

    return ingestedState.size !== stats.size || ingestedState.mtimeMs !== stats.mtimeMs;
  }

  private markIngested(files: Array<{ relativePath: string; size: number; absolutePath: string }>): void {
    const state = this.loadState();
    for (const file of files) {
      const stats = fs.statSync(file.absolutePath);
      state.files[this.normalizeStateKey(file.relativePath)] = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ingestedAt: new Date().toISOString(),
      };
    }
    this.saveState(state);
  }

  private loadState(): IngestStateFile {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { files: {} };
      }
      const rawState = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8')) as IngestStateFile;
      const normalizedFiles = Object.entries(rawState.files || {}).reduce<Record<string, IngestedLogState>>((acc, [key, value]) => {
        acc[this.normalizeStateKey(key)] = value;
        return acc;
      }, {});
      return { files: normalizedFiles };
    } catch {
      return { files: {} };
    }
  }

  private saveState(state: IngestStateFile): void {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  private toStateKey(relativePath: string): string {
    return path.join('logs', relativePath).replace(/\\/g, '/');
  }

  private normalizeStateKey(key: string): string {
    const normalized = key.replace(/\\/g, '/').trim();
    if (!normalized) {
      return normalized;
    }
    if (normalized.startsWith('logs/')) {
      return normalized;
    }
    if (normalized.startsWith('sessions/')) {
      return `logs/${normalized}`;
    }
    return normalized;
  }
}

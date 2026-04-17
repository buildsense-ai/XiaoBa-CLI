import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { Logger } from './logger';
import { SendToInspectorTool } from '../tools/send-to-inspector-tool';
import { ToolExecutionContext } from '../types/tool';
import {
  getInspectorAutoUploadMaxFiles,
  getInspectorAutoUploadTime,
  getInspectorServerUrl,
  getInspectorStableMinutes,
  isInspectorAutoUploadEnabled,
} from './inspector-upload-config';

interface UploadedLogState {
  size: number;
  mtimeMs: number;
  uploadedAt: string;
  caseId?: string;
}

interface UploadStateFile {
  files: Record<string, UploadedLogState>;
}

type UploadReason = 'startup' | 'scheduled' | 'manual';

export class InspectorUploadScheduler {
  private readonly workingDirectory: string;
  private readonly logsRoot: string;
  private readonly stateFilePath: string;
  private readonly tool = new SendToInspectorTool();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
    this.logsRoot = path.resolve(this.workingDirectory, 'logs');
    this.stateFilePath = path.resolve(this.workingDirectory, 'data', 'inspector-upload-state.json');
  }

  static isEnabled(): boolean {
    return isInspectorAutoUploadEnabled();
  }

  static shouldStartForCurrentRuntime(): boolean {
    const normalizedRole = String(process.env.XIAOBA_ROLE || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    return InspectorUploadScheduler.isEnabled()
      && normalizedRole !== 'inspector-cat'
      && !!getInspectorServerUrl();
  }

  async start(): Promise<void> {
    if (this.started || !InspectorUploadScheduler.shouldStartForCurrentRuntime()) {
      return;
    }

    this.started = true;
    this.stopped = false;
    Logger.info('[InspectorAutoUpload] scheduler started');

    // 启动后先异步补传一次，不阻塞 runtime 正常启动。
    void this.runPendingUploadCycle('startup');
    this.scheduleNextRun();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    Logger.info('[InspectorAutoUpload] scheduler stopped');
  }

  async runPendingUploadCycle(reason: UploadReason = 'manual'): Promise<void> {
    if (this.running || this.stopped || !InspectorUploadScheduler.shouldStartForCurrentRuntime()) {
      return;
    }

    if (!fs.existsSync(this.logsRoot) || !fs.statSync(this.logsRoot).isDirectory()) {
      return;
    }

    this.running = true;
    try {
      const pendingLogPaths = await this.collectPendingLogPaths();
      if (pendingLogPaths.length === 0) {
        Logger.info(`[InspectorAutoUpload] no pending stable logs (${reason})`);
        return;
      }

      const batch = pendingLogPaths.slice(0, this.getMaxBatchFiles());
      const result = await this.tool.executeWithResult(
        {
          analysis_type: 'runtime',
          user_request: this.buildAutoUploadRequest(reason, batch.length),
          log_paths: batch,
          max_files: batch.length,
        },
        this.createToolContext(),
      );

      if (!result.uploaded) {
        Logger.warning(`[InspectorAutoUpload] upload skipped/failed (${reason}): ${result.message}`);
        return;
      }

      this.markUploaded(result.selectedFiles, result.caseId);
      Logger.info(`[InspectorAutoUpload] uploaded ${result.selectedFiles.length} files (${reason}) -> ${result.caseId || 'unknown-case'}`);
    } catch (error: any) {
      Logger.warning(`[InspectorAutoUpload] cycle failed (${reason}): ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  private createToolContext(): ToolExecutionContext {
    return {
      workingDirectory: this.workingDirectory,
      conversationHistory: [],
      surface: 'unknown',
    };
  }

  private buildAutoUploadRequest(reason: UploadReason, fileCount: number): string {
    if (reason === 'startup') {
      return `启动补传稳定日志，共 ${fileCount} 个文件，请督察猫异步审查 runtime 状态与用户行为。`;
    }
    if (reason === 'scheduled') {
      return `定时上传稳定日志，共 ${fileCount} 个文件，请督察猫审查今日 runtime 与用户行为。`;
    }
    return `后台上传稳定日志，共 ${fileCount} 个文件，请督察猫审查。`;
  }

  private getMaxBatchFiles(): number {
    return getInspectorAutoUploadMaxFiles();
  }

  private getStableAgeMs(): number {
    const minutes = getInspectorStableMinutes();
    return minutes * 60 * 1000;
  }

  private scheduleNextRun(): void {
    if (this.stopped) {
      return;
    }

    const uploadTime = getInspectorAutoUploadTime();
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
      await this.runPendingUploadCycle('scheduled');
      this.scheduleNextRun();
    }, delay);

    Logger.info(`[InspectorAutoUpload] next run scheduled at ${next.toISOString()}`);
  }

  private async collectPendingLogPaths(): Promise<string[]> {
    const stableBefore = Date.now() - this.getStableAgeMs();
    const state = this.loadState();
    const candidates = await glob(['**/*.log', 'sessions/**/*.jsonl'], {
      cwd: this.logsRoot,
      absolute: false,
      nodir: true,
      windowsPathsNoEscape: true,
      ignore: ['**/*inspector-review*.jsonl'],
    });

    return candidates
      .map(relativePath => relativePath.replace(/\\/g, '/'))
      .filter(relativePath => this.isStableAndPending(relativePath, stableBefore, state.files[relativePath]))
      .sort((a, b) => {
        const aStats = fs.statSync(path.join(this.logsRoot, a));
        const bStats = fs.statSync(path.join(this.logsRoot, b));
        return bStats.mtimeMs - aStats.mtimeMs;
      })
      .map(relativePath => path.join('logs', relativePath).replace(/\\/g, '/'));
  }

  private isStableAndPending(relativePath: string, stableBefore: number, uploadedState?: UploadedLogState): boolean {
    const absolutePath = path.join(this.logsRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return false;
    }

    const stats = fs.statSync(absolutePath);
    if (stats.mtimeMs > stableBefore) {
      return false;
    }

    if (!uploadedState) {
      return true;
    }

    return uploadedState.size !== stats.size || uploadedState.mtimeMs !== stats.mtimeMs;
  }

  private markUploaded(files: Array<{ relativePath: string; size: number; absolutePath: string }>, caseId?: string): void {
    const state = this.loadState();
    for (const file of files) {
      const stats = fs.statSync(file.absolutePath);
      state.files[file.relativePath] = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        uploadedAt: new Date().toISOString(),
        caseId,
      };
    }
    this.saveState(state);
  }

  private loadState(): UploadStateFile {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { files: {} };
      }
      return JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8')) as UploadStateFile;
    } catch {
      return { files: {} };
    }
  }

  private saveState(state: UploadStateFile): void {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
  }
}

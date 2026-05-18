import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { glob } from 'glob';
import { APP_VERSION } from '../version';
import { CatscoLogAgentClient } from './catsco-log-agent-client';
import { getCatscoLogAgentConfig } from './catsco-log-agent-config';
import {
  CatscoLogAgentState,
  clearCatscoLogToken,
  ensureCatscoDeviceId,
  loadCatscoLogAgentState,
  saveCatscoLogAgentState,
} from './catsco-log-agent-state';
import { Logger } from './logger';

type UploadReason = 'startup' | 'scheduled' | 'manual';

const ALLOWED_SESSION_TYPES = new Set(['chat', 'cli', 'catscompany', 'feishu', 'weixin']);
const SESSION_LOG_PATH_RE = /^sessions\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/([^/]+\.jsonl)$/;

export class CatscoLogUploadScheduler {
  private readonly workingDirectory: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
  }

  static shouldStartForCurrentRuntime(
    workingDirectory: string = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
  ): boolean {
    const normalizedRole = String(env.XIAOBA_ROLE || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    if (normalizedRole === 'inspector-cat') {
      return false;
    }
    const config = getCatscoLogAgentConfig(workingDirectory, env);
    return config.enabled && Boolean(config.apiBaseUrl);
  }

  async start(): Promise<void> {
    if (this.started || !CatscoLogUploadScheduler.shouldStartForCurrentRuntime(this.workingDirectory)) {
      return;
    }

    this.started = true;
    this.stopped = false;
    Logger.info('[CatsLog] upload scheduler started');

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
    Logger.info('[CatsLog] upload scheduler stopped');
  }

  async runPendingUploadCycle(reason: UploadReason = 'manual'): Promise<void> {
    if (
      this.running
      || this.stopped
      || !CatscoLogUploadScheduler.shouldStartForCurrentRuntime(this.workingDirectory)
    ) {
      return;
    }

    const config = getCatscoLogAgentConfig(this.workingDirectory);
    if (!fs.existsSync(config.logsRoot) || !fs.statSync(config.logsRoot).isDirectory()) {
      return;
    }

    this.running = true;
    try {
      const state = loadCatscoLogAgentState(config.stateFilePath);
      if (state.stateCorrupt) {
        saveCatscoLogAgentState(config.stateFilePath, state);
        Logger.warning('[CatsLog] state file was corrupt and has been quarantined; upload paused until state is reviewed');
        return;
      }

      const token = await this.ensureUploadToken(state);
      if (!token) {
        Logger.info('[CatsLog] no CatsCo login token available, skipping log upload');
        return;
      }

      const pending = await this.collectPendingSessionLogs(state);
      if (pending.length === 0) {
        Logger.info(`[CatsLog] no pending stable session logs (${reason})`);
        return;
      }

      const client = new CatscoLogAgentClient(config.apiBaseUrl);
      let uploadedCount = 0;

      for (const item of pending.slice(0, config.maxFilesPerCycle)) {
        try {
          const result = await client.uploadLog({
            filePath: item.absolutePath,
            token,
            logDate: item.logDate,
          });
          const stats = fs.statSync(item.absolutePath);
          state.uploaded[item.stateKey] = {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            uploadedAt: new Date().toISOString(),
            uploadId: result.upload_id || result.record_id,
            sha256: result.sha256,
          };
          uploadedCount++;
        } catch (error: any) {
          if (Number(error?.status) === 401) {
            clearCatscoLogToken(state);
            saveCatscoLogAgentState(config.stateFilePath, state);
            Logger.warning('[CatsLog] upload token rejected; token cleared and will be refreshed next cycle');
            break;
          }
          Logger.warning(`[CatsLog] failed to upload ${item.stateKey}: ${error.message}`);
        }
      }

      saveCatscoLogAgentState(config.stateFilePath, state);
      if (uploadedCount > 0) {
        Logger.info(`[CatsLog] uploaded ${uploadedCount} session log files (${reason})`);
      }
    } catch (error: any) {
      Logger.warning(`[CatsLog] upload cycle failed (${reason}): ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  private async ensureUploadToken(state: CatscoLogAgentState): Promise<string | null> {
    if (state.token) {
      return state.token;
    }

    const config = getCatscoLogAgentConfig(this.workingDirectory);
    if (!config.catscoUserToken) {
      return null;
    }

    const deviceId = ensureCatscoDeviceId(state);
    const client = new CatscoLogAgentClient(config.apiBaseUrl);
    const response = await client.bootstrap({
      deviceId,
      deviceName: os.hostname(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      agentVersion: APP_VERSION,
      catscoUserToken: config.catscoUserToken,
    });

    state.userId = response.user_id;
    state.externalProvider = response.external_provider;
    state.externalUserId = response.external_user_id;
    state.deviceId = response.device_id;
    state.tokenId = response.token_id;
    state.token = response.token;
    state.tokenIssuedAt = response.issued_at;
    state.uploaded ||= {};
    saveCatscoLogAgentState(config.stateFilePath, state);

    Logger.info(`[CatsLog] bootstrapped log upload for device ${response.device_id}`);
    return response.token;
  }

  private async collectPendingSessionLogs(state: CatscoLogAgentState): Promise<Array<{
    absolutePath: string;
    stateKey: string;
    logDate: string;
  }>> {
    const config = getCatscoLogAgentConfig(this.workingDirectory);
    const stableBefore = Date.now() - config.stableMinutes * 60 * 1000;
    const candidates = await glob(['sessions/*/*/*.jsonl'], {
      cwd: config.logsRoot,
      absolute: false,
      nodir: true,
      windowsPathsNoEscape: true,
      ignore: [
        '**/*inspector-review*.jsonl',
        '**/*.tmp',
        '**/*.cache',
      ],
    });

    return candidates
      .map(relativePath => relativePath.replace(/\\/g, '/'))
      .filter(relativePath => this.isAllowedSessionLogPath(relativePath))
      .map(relativePath => this.toPendingCandidate(relativePath))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .filter(candidate => this.isStableAndPending(candidate, stableBefore, state))
      .sort((a, b) => {
        const aStats = fs.statSync(a.absolutePath);
        const bStats = fs.statSync(b.absolutePath);
        return bStats.mtimeMs - aStats.mtimeMs;
      });
  }

  private isAllowedSessionLogPath(relativePath: string): boolean {
    const match = relativePath.match(SESSION_LOG_PATH_RE);
    if (!match) {
      return false;
    }
    const sessionType = match[1];
    const filename = match[3];
    return ALLOWED_SESSION_TYPES.has(sessionType)
      && !filename.startsWith('.')
      && !filename.includes('..')
      && filename.toLowerCase().endsWith('.jsonl');
  }

  private toPendingCandidate(relativePath: string): {
    absolutePath: string;
    stateKey: string;
    logDate: string;
  } | null {
    const config = getCatscoLogAgentConfig(this.workingDirectory);
    const match = relativePath.match(SESSION_LOG_PATH_RE);
    if (!match) return null;

    const absolutePath = path.resolve(config.logsRoot, relativePath);
    const normalizedRoot = path.resolve(config.logsRoot).toLowerCase();
    if (!absolutePath.toLowerCase().startsWith(`${normalizedRoot}${path.sep}`)) {
      return null;
    }

    return {
      absolutePath,
      stateKey: path.join('logs', relativePath).replace(/\\/g, '/'),
      logDate: match[2],
    };
  }

  private isStableAndPending(
    candidate: { absolutePath: string; stateKey: string },
    stableBefore: number,
    state: CatscoLogAgentState,
  ): boolean {
    if (!fs.existsSync(candidate.absolutePath)) {
      return false;
    }
    const lstat = fs.lstatSync(candidate.absolutePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return false;
    }
    const config = getCatscoLogAgentConfig(this.workingDirectory);
    const stats = lstat;
    if (stats.size <= 0 || stats.size > config.maxFileBytes) {
      return false;
    }
    if (stats.mtimeMs > stableBefore) {
      return false;
    }

    const uploaded = state.uploaded[candidate.stateKey];
    return !uploaded || uploaded.size !== stats.size || uploaded.mtimeMs !== stats.mtimeMs;
  }

  private scheduleNextRun(): void {
    if (this.stopped) {
      return;
    }

    const config = getCatscoLogAgentConfig(this.workingDirectory);
    const delay = Math.max(60 * 1000, config.uploadIntervalMinutes * 60 * 1000);
    this.timer = setTimeout(async () => {
      await this.runPendingUploadCycle('scheduled');
      this.scheduleNextRun();
    }, delay);
  }
}

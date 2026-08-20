import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { glob } from 'glob';
import { APP_VERSION } from '../version';
import { CatscoAppendConflictError, CatscoLogAgentClient, type CatscoSkillReadResponse } from './catsco-log-agent-client';
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
const MAX_APPEND_CHUNK_BYTES = 4 * 1024 * 1024;

interface UploadSession {
  token: string;
  appendUrl?: string;
}

export interface CatscoLogSkillQuery {
  handle?: string;
  search?: string;
  includeContent?: boolean;
  includeTrace?: 'none' | 'summary' | 'full';
  limit?: number;
  cursor?: string;
}

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

      const uploadSession = await this.ensureUploadSession(state);
      if (!uploadSession) {
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
      let tokenRejected = false;

      await forEachConcurrent(
        pending.slice(0, config.maxFilesPerCycle),
        config.maxConcurrentUploads,
        async item => {
        if (tokenRejected) return;
        try {
          const appendUrl = uploadSession.appendUrl;
          if (appendUrl) {
            const appended = await this.appendV2(item, state, client, { ...uploadSession, appendUrl }, config.stateFilePath);
            if (!appended) {
              await this.uploadV1(item, state, client, uploadSession.token);
            }
          } else {
            await this.uploadV1(item, state, client, uploadSession.token);
          }
          uploadedCount++;
        } catch (error: any) {
          if (Number(error?.status) === 401) {
            tokenRejected = true;
            clearCatscoLogToken(state);
            saveCatscoLogAgentState(config.stateFilePath, state);
            Logger.warning('[CatsLog] upload token rejected; token cleared and will be refreshed next cycle');
            return;
          }
          Logger.warning(`[CatsLog] failed to upload ${item.stateKey}: ${error.message}`);
        }
      },
      );

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

  /**
   * Reads Skills using the device-bound capability returned by CatsLog
   * bootstrap. It deliberately exposes no UID selector and returns the server
   * content-trust marker unchanged, so callers cannot turn a local UID or an
   * untrusted generated Skill into an authorization decision.
   */
  async readSkills(query: CatscoLogSkillQuery = {}): Promise<CatscoSkillReadResponse> {
    const config = getCatscoLogAgentConfig(this.workingDirectory);
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (state.stateCorrupt) {
      saveCatscoLogAgentState(config.stateFilePath, state);
      throw new Error('CatsLog state is corrupt; Skill read is paused until it is reviewed');
    }
    let uploadSession = await this.ensureUploadSession(state);
    if (!uploadSession) {
      throw new Error('No CatsCo login token is available to bootstrap CatsLog Skill access');
    }
    if (!hasUsableSkillCapability(state)) {
      clearCatscoLogToken(state);
      saveCatscoLogAgentState(config.stateFilePath, state);
      uploadSession = await this.ensureUploadSession(state);
      if (!uploadSession || !hasUsableSkillCapability(state)) {
        throw new Error('CatsLog did not issue a valid device-bound Skill capability');
      }
    }
    const client = new CatscoLogAgentClient(config.apiBaseUrl);
    try {
      return await client.readSkills({
        token: state.skillToken!,
        skillsUrl: state.skillsUrl!,
        ...query,
      });
    } catch (error: any) {
      if (Number(error?.status) === 401) {
        clearCatscoLogToken(state);
        saveCatscoLogAgentState(config.stateFilePath, state);
      }
      throw error;
    }
  }

  private async ensureUploadSession(state: CatscoLogAgentState): Promise<UploadSession | null> {
    if (state.token) {
      return {
        token: state.token,
        ...(state.uploadProtocol === 2 && isSafeServerPath(state.appendUrl) && { appendUrl: state.appendUrl }),
      };
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
    state.uploadProtocol = response.upload_protocol === 2 ? 2 : 1;
    state.appendUrl = state.uploadProtocol === 2 && isSafeServerPath(response.append_url)
      ? response.append_url
      : undefined;
    state.skillTokenId = response.skill_token_id;
    state.skillToken = response.skill_token;
    state.skillTokenExpiresAt = response.skill_token_expires_at;
    state.skillsUrl = isSafeServerPath(response.skills_url) ? response.skills_url : undefined;
    state.uploaded ||= {};
    saveCatscoLogAgentState(config.stateFilePath, state);

    Logger.info(`[CatsLog] bootstrapped log upload for device ${response.device_id}`);
    return {
      token: response.token,
      ...(state.appendUrl && { appendUrl: state.appendUrl }),
    };
  }

  private async uploadV1(
    item: { absolutePath: string; stateKey: string; logDate: string },
    state: CatscoLogAgentState,
    client: CatscoLogAgentClient,
    token: string,
  ): Promise<void> {
    const result = await client.uploadLog({
      filePath: item.absolutePath,
      token,
      logDate: item.logDate,
    });
    if (result.status && !['created', 'appended', 'duplicate'].includes(result.status.toLowerCase())) {
      throw new Error(`CatsLog v1 fallback was not accepted (${String(result.status || 'unknown')})`);
    }
    const stats = fs.statSync(item.absolutePath);
    state.uploaded[item.stateKey] = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      uploadedAt: new Date().toISOString(),
      uploadId: result.upload_id || result.record_id,
      sha256: result.sha256 || sha256FilePrefix(item.absolutePath, stats.size),
    };
  }

  private async appendV2(
    item: { absolutePath: string; stateKey: string; logDate: string },
    state: CatscoLogAgentState,
    client: CatscoLogAgentClient,
    uploadSession: Required<UploadSession>,
    stateFilePath: string,
  ): Promise<boolean> {
    let record = state.uploaded[item.stateKey] || {};
    state.uploaded[item.stateKey] = record as CatscoLogAgentState['uploaded'][string];
    const stats = fs.statSync(item.absolutePath);

    while (true) {
      const append = record.append;
      const expectedOffset = append?.acceptedOffset || 0;
      if (expectedOffset > stats.size || (expectedOffset > 0 && !matchesKnownPrefix(item.absolutePath, expectedOffset, record))) {
        return false;
      }
      const chunk = readCompleteJSONLChunk(item.absolutePath, expectedOffset, MAX_APPEND_CHUNK_BYTES);
      if (!chunk) {
        if (expectedOffset !== stats.size) {
          throw new Error('CatsLog v2 append requires complete newline-terminated JSONL records');
        }
        state.uploaded[item.stateKey] = {
          ...record,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          uploadedAt: new Date().toISOString(),
        };
        return true;
      }

      let pending = append?.pending;
      const contentSha256 = sha256(chunk);
      if (
        !pending
        || pending.expectedOffset !== expectedOffset
        || pending.expectedRevision !== (append?.revision || '')
        || pending.contentBytes !== chunk.length
        || pending.contentSha256 !== contentSha256
      ) {
        pending = {
          expectedOffset,
          expectedRevision: append?.revision || '',
          requestId: crypto.randomUUID(),
          contentSha256,
          contentBytes: chunk.length,
        };
        record = {
          ...record,
          append: {
            acceptedOffset: expectedOffset,
            revision: append?.revision || '',
            prefixSha256: append?.prefixSha256 || '',
            pending,
          },
        };
        state.uploaded[item.stateKey] = record;
        saveCatscoLogAgentState(stateFilePath, state);
      }

      try {
        const result = await client.appendLog({
          filePath: item.absolutePath,
          token: uploadSession.token,
          logDate: item.logDate,
          appendUrl: uploadSession.appendUrl,
          expectedOffset: pending.expectedOffset,
          expectedRevision: pending.expectedRevision,
          requestId: pending.requestId,
          content: chunk,
        });
        const acceptedOffset = pending.expectedOffset + chunk.length;
        if (result.accepted_offset !== acceptedOffset || !result.revision.trim()) {
          throw new Error('CatsLog v2 append returned an invalid acknowledgement');
        }
        record = {
          ...record,
          uploadId: result.upload_id || record.uploadId,
          append: {
            acceptedOffset,
            revision: result.revision,
            prefixSha256: sha256FilePrefix(item.absolutePath, acceptedOffset),
          },
        };
        state.uploaded[item.stateKey] = record;
        saveCatscoLogAgentState(stateFilePath, state);
      } catch (error) {
        if (error instanceof CatscoAppendConflictError && this.adoptAppendConflict(item.absolutePath, record, error)) {
          record = state.uploaded[item.stateKey] = {
            ...record,
            append: {
              acceptedOffset: error.acceptedOffset,
              revision: error.revision,
              prefixSha256: error.acceptedOffset === 0 ? '' : sha256FilePrefix(item.absolutePath, error.acceptedOffset),
            },
          };
          saveCatscoLogAgentState(stateFilePath, state);
          continue;
        }
        if (error instanceof CatscoAppendConflictError) return false;
        throw error;
      }
    }
  }

  private adoptAppendConflict(
    filePath: string,
    record: NonNullable<CatscoLogAgentState['uploaded'][string]>,
    conflict: CatscoAppendConflictError,
  ): boolean {
    if (!Number.isSafeInteger(conflict.acceptedOffset) || conflict.acceptedOffset < 0 || !conflict.revision.trim()) {
      return false;
    }
    const size = fs.statSync(filePath).size;
    if (conflict.acceptedOffset > size) return false;
    if (conflict.acceptedOffset === 0) return true;
    const expectedHash = record.append?.acceptedOffset === conflict.acceptedOffset
      ? record.append.prefixSha256
      : record.size === conflict.acceptedOffset
        ? record.sha256
        : undefined;
    return Boolean(expectedHash && sha256FilePrefix(filePath, conflict.acceptedOffset) === expectedHash);
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
    return !uploaded
      || (uploaded.append !== undefined && uploaded.append.acceptedOffset !== stats.size)
      || uploaded.size !== stats.size
      || uploaded.mtimeMs !== stats.mtimeMs;
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

function readCompleteJSONLChunk(filePath: string, offset: number, maxBytes: number): Buffer | null {
  const stats = fs.statSync(filePath);
  if (offset >= stats.size) return null;
  const length = Math.min(maxBytes, stats.size - offset);
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
    const content = buffer.subarray(0, bytesRead);
    const lastNewline = content.lastIndexOf(0x0a);
    return lastNewline < 0 ? null : Buffer.from(content.subarray(0, lastNewline + 1));
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256(contents: Buffer): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function sha256FilePrefix(filePath: string, length: number): string {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(length, 1)));
    let offset = 0;
    while (offset < length) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (bytesRead <= 0) throw new Error('session log changed while calculating append checkpoint');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function matchesKnownPrefix(filePath: string, offset: number, record: CatscoLogAgentState['uploaded'][string]): boolean {
  const expectedHash = record.append?.acceptedOffset === offset
    ? record.append.prefixSha256
    : record.size === offset
      ? record.sha256
      : undefined;
  return Boolean(expectedHash && sha256FilePrefix(filePath, offset) === expectedHash);
}

function isSafeServerPath(value: string | undefined): value is string {
  const pathValue = String(value || '').trim();
  return /^\/[A-Za-z0-9._~\/-]*$/.test(pathValue) && !pathValue.startsWith('//');
}

function hasUsableSkillCapability(state: CatscoLogAgentState): boolean {
  if (!state.skillToken || !isSafeServerPath(state.skillsUrl)) return false;
  const expiresAt = Date.parse(state.skillTokenExpiresAt || '');
  return !Number.isNaN(expiresAt) && expiresAt > Date.now();
}

async function forEachConcurrent<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { glob } from 'glob';
import { APP_VERSION } from '../version';
import { CatscoLogAgentClient } from './catsco-log-agent-client';
import { getCatscoLogAgentConfig } from './catsco-log-agent-config';
import {
  CatscoBlockedFileState,
  CatscoAppendFileState,
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
const UPLOAD_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface PendingSessionLog {
  absolutePath: string;
  stateKey: string;
  logDate: string;
}

interface FileSnapshotMetadata {
  size: number;
  mtimeMs: number;
}

interface UploadSnapshot extends FileSnapshotMetadata {
  content: Buffer;
}

interface AppendChunk {
  content: Buffer;
  expectedOffset: number;
  expectedRevision: string;
  requestId: string;
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

      let pending = await this.collectPendingSessionLogs(state);
      // Bootstrap before the final eligibility decision. A new client cannot
      // know whether a server supports v2 bounded append until bootstrap, and
      // treating a large file as permanently blocked before that handshake
      // would recreate the exact silent-loss path v2 is meant to remove.
      let token = await this.ensureUploadToken(state);
      if (token && this.usesAppendProtocol(state)) {
        pending = await this.collectPendingSessionLogs(state);
      }
      if (pending.length === 0) {
        // Collection can record a visible blocked/conflict state even when it
        // finds no uploadable files, so persist those observations before
        // returning early.
        saveCatscoLogAgentState(config.stateFilePath, state);
        Logger.info(`[CatsLog] no pending stable session logs (${reason})`);
        return;
      }
      if (!token) {
        saveCatscoLogAgentState(config.stateFilePath, state);
        Logger.info('[CatsLog] no CatsCo login token available, skipping log upload');
        return;
      }

      const client = new CatscoLogAgentClient(config.apiBaseUrl);
      let uploadedCount = 0;

      for (const item of pending.slice(0, config.maxFilesPerCycle)) {
        try {
          if (await this.uploadPendingItem(client, state, item, token, config)) {
            uploadedCount++;
          }
        } catch (error: any) {
          if (Number(error?.status) === 401) {
            clearCatscoLogToken(state);
            saveCatscoLogAgentState(config.stateFilePath, state);

            Logger.warning('[CatsLog] upload token rejected; bootstrapping a replacement and retrying this file once');
            try {
              const refreshedToken = await this.ensureUploadToken(state);
              if (!refreshedToken) {
                Logger.warning('[CatsLog] upload token refresh is unavailable; remaining files will wait for the next cycle');
                break;
              }
              token = refreshedToken;

              if (await this.uploadPendingItem(client, state, item, token, config)) {
                uploadedCount++;
              }
            } catch (retryError: any) {
              if (Number(retryError?.status) === 401) {
                clearCatscoLogToken(state);
                saveCatscoLogAgentState(config.stateFilePath, state);
                Logger.warning('[CatsLog] replacement upload token was also rejected; stopping after one retry');
                break;
              }
              Logger.warning(`[CatsLog] failed to upload ${item.stateKey} after token refresh: ${retryError.message}`);
            }
            continue;
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
    if (this.hasFreshUploadToken(state)) {
      return state.token;
    }

    if (state.token) {
      Logger.info('[CatsLog] upload token is expired or expires soon; refreshing it before upload');
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
    if (response.expires_at) {
      state.tokenExpiresAt = response.expires_at;
    } else {
      delete state.tokenExpiresAt;
    }
    state.uploadProtocol = Number(response.upload_protocol) >= 2 ? 2 : 1;
    if (state.uploadProtocol === 2 && response.append_url?.trim()) {
      state.appendUrl = response.append_url.trim();
    } else {
      delete state.appendUrl;
    }
    // Older CatsLog deployments omit these fields. Persist them only when the
    // server explicitly issued a separate device-bound capability.
    if (response.skill_token?.trim() && response.skill_token_expires_at?.trim()) {
      state.skillTokenId = response.skill_token_id;
      state.skillToken = response.skill_token;
      state.skillTokenExpiresAt = response.skill_token_expires_at;
      state.skillsUrl = response.skills_url?.trim() || '/catsco/agent/skills';
    } else {
      delete state.skillTokenId;
      delete state.skillToken;
      delete state.skillTokenExpiresAt;
      delete state.skillsUrl;
    }
    state.uploaded ||= {};
    saveCatscoLogAgentState(config.stateFilePath, state);

    Logger.info(`[CatsLog] bootstrapped log upload for device ${response.device_id}`);
    return response.token;
  }

  private hasFreshUploadToken(state: CatscoLogAgentState): state is CatscoLogAgentState & { token: string } {
    if (!state.token || !state.tokenExpiresAt || !state.uploadProtocol) {
      return false;
    }
    const expiresAt = Date.parse(state.tokenExpiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now() + UPLOAD_TOKEN_REFRESH_SKEW_MS;
  }

  private usesAppendProtocol(state: CatscoLogAgentState): boolean {
    return state.uploadProtocol === 2;
  }

  private async uploadPendingItem(
    client: CatscoLogAgentClient,
    state: CatscoLogAgentState,
    item: PendingSessionLog,
    token: string,
    config: ReturnType<typeof getCatscoLogAgentConfig>,
  ): Promise<boolean> {
    if (this.usesAppendProtocol(state)) {
      return this.appendPendingItem(client, state, item, token, config);
    }
    const snapshot = this.captureUploadSnapshot(item);
    if (!snapshot) {
      return false;
    }
    const result = await client.uploadLog({
      filePath: item.absolutePath,
      token,
      logDate: item.logDate,
      content: snapshot.content,
    });
    return this.recordUploadResponse(state, item, snapshot, result);
  }

  private async appendPendingItem(
    client: CatscoLogAgentClient,
    state: CatscoLogAgentState,
    item: PendingSessionLog,
    token: string,
    config: ReturnType<typeof getCatscoLogAgentConfig>,
  ): Promise<boolean> {
    let advanced = false;
    for (let index = 0; index < config.maxAppendChunksPerFile; index++) {
      const chunk = this.captureAppendChunk(state, item, config);
      if (!chunk) {
        return advanced;
      }
      try {
        const result = await client.appendLog({
          token,
          logDate: item.logDate,
          content: chunk.content,
          fileName: path.basename(item.absolutePath),
          expectedOffset: chunk.expectedOffset,
          expectedRevision: chunk.expectedRevision,
          requestId: chunk.requestId,
          appendUrl: state.appendUrl,
        });
        const expectedEnd = chunk.expectedOffset + chunk.content.length;
        if (
          result.accepted_offset !== expectedEnd
          || !/^[a-f0-9]{64}$/i.test(result.revision || '')
          || this.isQuarantinedResponse(result)
        ) {
          this.recordAppendConflict(state, item, 'invalid_append_ack');
          saveCatscoLogAgentState(config.stateFilePath, state);
          Logger.warning(`[CatsLog] append acknowledgement for ${item.stateKey} was invalid; recorded a local conflict`);
          return advanced;
        }
        state.appends ||= {};
        state.appends[item.stateKey] = {
          offset: result.accepted_offset,
          revision: result.revision.toLowerCase(),
          updatedAt: new Date().toISOString(),
        };
        delete state.conflicts?.[item.stateKey];
        saveCatscoLogAgentState(config.stateFilePath, state);
        advanced = true;
      } catch (error: any) {
        if (Number(error?.status) === 409) {
          this.recordAppendConflict(state, item, 'append_conflict', error?.payload);
          saveCatscoLogAgentState(config.stateFilePath, state);
          Logger.warning(`[CatsLog] append conflict for ${item.stateKey}; it was not advanced locally`);
          return advanced;
        }
        throw error;
      }
    }
    return advanced;
  }

  private captureAppendChunk(
    state: CatscoLogAgentState,
    item: PendingSessionLog,
    config: ReturnType<typeof getCatscoLogAgentConfig>,
  ): AppendChunk | null {
    const appendState = this.appendStateFor(state, item.stateKey);
    const inFlight = appendState.inFlight;
    const expectedOffset = inFlight?.expectedOffset ?? appendState.offset;
    const expectedRevision = inFlight?.expectedRevision ?? appendState.revision;
    const length = inFlight?.length ?? this.nextAppendLength(item, expectedOffset, config, state);
    if (!length) {
      return null;
    }
    const content = this.readStableRange(item.absolutePath, expectedOffset, length);
    if (!content) {
      return null;
    }
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    if (inFlight) {
      if (
        inFlight.expectedOffset !== appendState.offset
        || inFlight.expectedRevision !== appendState.revision
        || inFlight.sha256 !== sha256
      ) {
        this.recordAppendConflict(state, item, 'append_snapshot_changed');
        return null;
      }
      return { content, expectedOffset, expectedRevision, requestId: inFlight.requestId };
    }
    const requestId = `append_${crypto.randomUUID().replace(/-/g, '')}`;
    appendState.inFlight = {
      requestId,
      expectedOffset,
      expectedRevision,
      length: content.length,
      sha256,
    };
    saveCatscoLogAgentState(config.stateFilePath, state);
    return { content, expectedOffset, expectedRevision, requestId };
  }

  private appendStateFor(state: CatscoLogAgentState, stateKey: string): CatscoAppendFileState {
    state.appends ||= {};
    const existing = state.appends[stateKey];
    if (existing) {
      return existing;
    }
    const legacy = state.uploaded[stateKey];
    const next: CatscoAppendFileState = legacy?.sha256
      ? {
          offset: legacy.size,
          revision: legacy.sha256.toLowerCase(),
          updatedAt: legacy.uploadedAt,
        }
      : { offset: 0, revision: '', updatedAt: new Date(0).toISOString() };
    state.appends[stateKey] = next;
    return next;
  }

  private nextAppendLength(
    item: PendingSessionLog,
    offset: number,
    config: ReturnType<typeof getCatscoLogAgentConfig>,
    state: CatscoLogAgentState,
  ): number | null {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(item.absolutePath);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || offset > stats.size) {
      this.recordAppendConflict(state, item, 'append_source_rewritten');
      return null;
    }
    const remaining = stats.size - offset;
    if (remaining <= 0) {
      return null;
    }
    const probeLength = Math.min(config.appendChunkBytes, remaining);
    const probe = this.readStableRange(item.absolutePath, offset, probeLength);
    if (!probe) {
      return null;
    }
    const lastLineEnd = probe.lastIndexOf(0x0a) + 1;
    if (lastLineEnd === 0) {
      if (remaining > config.appendChunkBytes) {
        this.recordAppendLineTooLarge(state, item, stats, config.appendChunkBytes);
      }
      return null;
    }
    return lastLineEnd;
  }

  private readStableRange(filePath: string, offset: number, length: number): Buffer | null {
    try {
      const before = fs.lstatSync(filePath);
      if (before.isSymbolicLink() || !before.isFile() || offset < 0 || offset + length > before.size) {
        return null;
      }
      const descriptor = fs.openSync(filePath, 'r');
      try {
        const content = Buffer.alloc(length);
        const bytesRead = fs.readSync(descriptor, content, 0, length, offset);
        if (bytesRead !== length) {
          return null;
        }
        const after = fs.lstatSync(filePath);
        if (after.isSymbolicLink() || !after.isFile() || !this.hasSameSnapshot(before, after)) {
          return null;
        }
        return content;
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      return null;
    }
  }

  private recordAppendConflict(
    state: CatscoLogAgentState,
    item: Pick<PendingSessionLog, 'absolutePath' | 'stateKey'>,
    status: string,
    payload?: { accepted_offset?: number; revision?: string },
  ): void {
    let stats: fs.Stats | null = null;
    try {
      stats = fs.lstatSync(item.absolutePath);
    } catch {
      // A missing file does not need a persistent conflict record.
    }
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      return;
    }
    const appendState = state.appends?.[item.stateKey];
    if (appendState) {
      // A conflict proves this request is not a lost-response replay. Keeping
      // its request ID would make a changed local file retry an obsolete chunk
      // forever, so preserve the diagnostic state and explicitly retire it.
      delete appendState.inFlight;
    }
    const acceptedOffset = typeof payload?.accepted_offset === 'number'
      ? payload.accepted_offset
      : Number.NaN;
    const revision = typeof payload?.revision === 'string'
      ? payload.revision.trim().toLowerCase()
      : '';
    state.conflicts ||= {};
    state.conflicts[item.stateKey] = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      detectedAt: new Date().toISOString(),
      status,
      parseStatus: typeof payload?.revision === 'string' ? 'server_state_received' : undefined,
      acceptedOffset: Number.isSafeInteger(acceptedOffset) && acceptedOffset >= 0
        ? acceptedOffset
        : undefined,
      revision: /^[a-f0-9]{64}$/.test(revision) ? revision : undefined,
    };
  }

  private isPermanentAppendConflict(status: string | undefined): boolean {
    return typeof status === 'string' && status.includes('append');
  }

  private recordAppendLineTooLarge(
    state: CatscoLogAgentState,
    item: PendingSessionLog,
    stats: fs.Stats,
    appendChunkBytes: number,
  ): void {
    state.blocked ||= {};
    state.blocked[item.stateKey] = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      blockedAt: new Date().toISOString(),
      reason: 'append_line_too_large',
      maxFileBytes: appendChunkBytes,
    };
    Logger.warning(`[CatsLog] ${item.stateKey} has a JSONL record above the ${appendChunkBytes}-byte append chunk limit; recorded as blocked`);
  }

  private async collectPendingSessionLogs(state: CatscoLogAgentState): Promise<PendingSessionLog[]> {
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
    candidate: Pick<PendingSessionLog, 'absolutePath' | 'stateKey'>,
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
    if (stats.size <= 0) {
      return false;
    }
    const appendProtocol = this.usesAppendProtocol(state);
    if (!appendProtocol && stats.size > config.maxFileBytes) {
      this.recordOversizedFile(state, candidate, stats, config.maxFileBytes);
      return false;
    }
    if (appendProtocol) {
      const blocked = state.blocked?.[candidate.stateKey];
      if (blocked && blocked.reason !== 'file_too_large' && this.hasSameSnapshot(blocked, stats)) {
        return false;
      }
      this.clearBlockedFile(state, candidate.stateKey);
    } else {
      this.clearBlockedFile(state, candidate.stateKey);
    }
    if (stats.mtimeMs > stableBefore) {
      return false;
    }

    const conflict = state.conflicts?.[candidate.stateKey];
    if (conflict) {
      if (this.isPermanentAppendConflict(conflict.status)) {
        return false;
      }
      if (this.hasSameSnapshot(conflict, stats)) {
        return false;
      }
      delete state.conflicts?.[candidate.stateKey];
    }

    const uploaded = state.uploaded[candidate.stateKey];
    if (appendProtocol) {
      const append = state.appends?.[candidate.stateKey];
      const offset = append?.offset ?? uploaded?.size ?? 0;
      if (offset > stats.size) {
        this.recordAppendConflict(state, candidate, 'append_source_rewritten');
        return false;
      }
      return offset < stats.size;
    }
    return !uploaded || uploaded.size !== stats.size || uploaded.mtimeMs !== stats.mtimeMs;
  }

  private captureUploadSnapshot(candidate: PendingSessionLog): UploadSnapshot | null {
    try {
      const before = fs.lstatSync(candidate.absolutePath);
      if (before.isSymbolicLink() || !before.isFile()) {
        return null;
      }

      const content = fs.readFileSync(candidate.absolutePath);
      const after = fs.lstatSync(candidate.absolutePath);
      if (
        after.isSymbolicLink()
        || !after.isFile()
        || content.length !== before.size
        || !this.hasSameSnapshot(before, after)
      ) {
        Logger.info(`[CatsLog] ${candidate.stateKey} changed while its upload snapshot was being captured; it will retry after stabilizing`);
        return null;
      }

      return { content, size: before.size, mtimeMs: before.mtimeMs };
    } catch (error: any) {
      Logger.warning(`[CatsLog] failed to snapshot ${candidate.stateKey}: ${error.message}`);
      return null;
    }
  }

  private recordUploadResponse(
    state: CatscoLogAgentState,
    item: PendingSessionLog,
    snapshot: UploadSnapshot,
    result: { upload_id?: string; record_id?: string; sha256?: string; parse_status?: string; status?: string },
  ): boolean {
    if (this.isQuarantinedResponse(result)) {
      state.conflicts ||= {};
      state.conflicts[item.stateKey] = {
        size: snapshot.size,
        mtimeMs: snapshot.mtimeMs,
        detectedAt: new Date().toISOString(),
        status: result.status,
        parseStatus: result.parse_status,
        uploadId: result.upload_id || result.record_id,
        sha256: result.sha256,
      };
      Logger.warning(`[CatsLog] server quarantined ${item.stateKey}; it was not marked uploaded and is recorded as a local conflict`);
      return false;
    }

    state.uploaded[item.stateKey] = {
      size: snapshot.size,
      mtimeMs: snapshot.mtimeMs,
      uploadedAt: new Date().toISOString(),
      uploadId: result.upload_id || result.record_id,
      sha256: result.sha256,
    };
    delete state.conflicts?.[item.stateKey];
    return true;
  }

  private isQuarantinedResponse(result: { status?: string; parse_status?: string }): boolean {
    return [result.status, result.parse_status]
      .some(value => value?.trim().toLowerCase() === 'quarantined');
  }

  private recordOversizedFile(
    state: CatscoLogAgentState,
    candidate: Pick<PendingSessionLog, 'stateKey'>,
    stats: fs.Stats,
    maxFileBytes: number,
  ): void {
    state.blocked ||= {};
    const existing = state.blocked[candidate.stateKey];
    if (
      existing
      && existing.reason === 'file_too_large'
      && existing.maxFileBytes === maxFileBytes
      && this.hasSameSnapshot(existing, stats)
    ) {
      return;
    }

    const blocked: CatscoBlockedFileState = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      blockedAt: new Date().toISOString(),
      reason: 'file_too_large',
      maxFileBytes,
    };
    state.blocked[candidate.stateKey] = blocked;
    Logger.warning(`[CatsLog] ${candidate.stateKey} is ${stats.size} bytes, above the ${maxFileBytes}-byte upload limit; recorded as blocked`);
  }

  private clearBlockedFile(state: CatscoLogAgentState, stateKey: string): void {
    delete state.blocked?.[stateKey];
  }

  private hasSameSnapshot(
    left: FileSnapshotMetadata,
    right: FileSnapshotMetadata,
  ): boolean {
    return left.size === right.size && left.mtimeMs === right.mtimeMs;
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

import * as os from 'os';
import { APP_VERSION } from '../version';
import {
  CatscoLogAgentClient,
  DEFAULT_MEMORY_NOTES_URL,
  DEFAULT_MEMORY_RECALL_URL,
  DEFAULT_MEMORY_URL,
  DEFAULT_SESSIONS_URL,
  DEFAULT_SKILL_GRAPH_URL,
  DEFAULT_SKILLS_URL,
  isSafeCatsLogPath,
} from './catsco-log-agent-client';
import type {
  CatscoMemoryNote,
  CatscoMemoryNoteInput,
  CatscoMemoryRecallQuery,
  CatscoMemoryRecallResponse,
  CatscoSessionQuery,
  CatscoSessionQueryResult,
  CatscoSkillGraphQuery,
  CatscoSkillGraphResponse,
  CatscoSkillMemoryQuery,
  CatscoSkillMemoryResponse,
  CatscoSkillsQuery,
  CatscoSkillsResponse,
  CatscoSkillOutcomeInput,
} from './catsco-log-agent-client';
import { getCatscoLogAgentConfig } from './catsco-log-agent-config';
import type { CatscoLogAgentState } from './catsco-log-agent-state';
import {
  clearCatscoMemoryWriteToken,
  clearCatscoSkillToken,
  ensureCatscoDeviceId,
  loadCatscoLogAgentState,
  saveCatscoLogAgentState,
} from './catsco-log-agent-state';

const CAPABILITY_REFRESH_SKEW_MS = 30_000;
const RECEIPT_TTL_MS = 30 * 60 * 1000;
const MAX_RECEIPTS = 128;

/**
 * Narrow seam consumed by the memory branch. Optional methods keep existing
 * embedders/fakes source-compatible while the concrete provider implements the
 * complete device-bound Agent API.
 */
export interface CatsLogMemoryBackend {
  /**
   * Whether the remote capability should be advertised for a new branch turn.
   * Optional to keep lightweight embedders and test fakes source-compatible.
   */
  isAvailable?(): boolean;
  retrieveSkillMemory(
    query: CatscoSkillMemoryQuery,
    signal?: AbortSignal,
  ): Promise<CatscoSkillMemoryResponse>;
  recallMemory(
    query: CatscoMemoryRecallQuery,
    signal?: AbortSignal,
  ): Promise<CatscoMemoryRecallResponse>;
  readSkills?(
    query: CatscoSkillsQuery,
    signal?: AbortSignal,
  ): Promise<CatscoSkillsResponse>;
  readSkillGraph?(
    query: CatscoSkillGraphQuery,
    signal?: AbortSignal,
  ): Promise<CatscoSkillGraphResponse>;
  querySessions?(
    query: CatscoSessionQuery,
    signal?: AbortSignal,
  ): Promise<CatscoSessionQueryResult>;
  reportSkillOutcome?(
    input: CatscoSkillOutcomeInput & { requireReceipt?: boolean },
    signal?: AbortSignal,
  ): Promise<void>;
  createMemoryNote?(
    input: CatscoMemoryNoteInput,
    signal?: AbortSignal,
  ): Promise<CatscoMemoryNote>;
  supportsSkillOutcomes?(): boolean;
  supportsMemoryNoteWrites?(): boolean;
}

export interface CatsLogMemoryProviderOptions {
  env?: NodeJS.ProcessEnv;
  clientFactory?: (apiBaseUrl: string) => CatscoLogAgentClient;
  now?: () => number;
  /** Explicit local CLI invocations may opt into the legacy outcome write. */
  allowSkillOutcomeWrites?: boolean;
}

interface CatsLogReadCapability {
  token: string;
  skillsUrl: string;
  skillGraphUrl: string;
  sessionsUrl: string;
  memoryUrl: string;
  memoryRecallUrl: string;
}

interface CatsLogWriteCapability {
  token: string;
  memoryNotesUrl: string;
}

interface CatsLogCapabilities {
  read?: CatsLogReadCapability;
  write?: CatsLogWriteCapability;
}

interface StoredReceipt {
  receipt: string;
  handle: string;
  revision: number;
  routeId?: string;
  hop?: number;
  edgeKey?: string;
  expiresAt: number;
  touchedAt: number;
}

/**
 * Resolves bootstrap-issued capabilities and exposes only bounded Agent APIs.
 * Upload credentials, operator credentials, and filesystem paths never cross
 * this boundary.
 */
export class CatsLogMemoryProvider implements CatsLogMemoryBackend {
  private bootstrapPromise: Promise<CatsLogCapabilities> | null = null;
  private readonly receipts = new Map<string, StoredReceipt>();

  constructor(
    private readonly workingDirectory: string,
    private readonly options: CatsLogMemoryProviderOptions = {},
  ) {}

  /**
   * Runtime adapters can live longer than the login/token state they were
   * created with. Re-read the current config/state at branch construction
   * time so a later login (or an explicit revocation/disable) takes effect
   * without rebuilding the whole adapter runtime.
   */
  isAvailable(): boolean {
    return CatsLogMemoryProvider.shouldExpose(this.workingDirectory, this.runtimeEnv(), this.now());
  }

  static shouldExpose(
    workingDirectory: string,
    env: NodeJS.ProcessEnv = process.env,
    now = Date.now(),
  ): boolean {
    const role = String(env.XIAOBA_ROLE || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    if (role === 'inspector-cat') return false;
    if (/^(0|false|off|no)$/i.test(String(env.CATSLOG_MEMORY_ENABLED || '').trim())) {
      return false;
    }
    const config = getCatscoLogAgentConfig(workingDirectory, env);
    if (!config.apiBaseUrl) return false;
    // The feature flag only permits the capability; a live login or persisted
    // device read token is still required before the branch may advertise it.
    if (config.memoryEnabled === false) return false;
    if (config.catscoUserToken) return true;
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (state.stateCorrupt) return false;
    return Boolean(readCapabilityFromState(state, now));
  }

  /** Outcome feedback is a write and is opt-in for an autonomous branch. */
  supportsSkillOutcomes(): boolean {
    const env = this.runtimeEnv();
    const config = this.currentConfig();
    return this.options.allowSkillOutcomeWrites === true
      || config.skillOutcomesEnabled === true
      || isEnabled(env, 'CATSLOG_SKILL_OUTCOMES_ENABLED');
  }

  /** Note writes use a separate memory_write_token and are independently opt-in. */
  supportsMemoryNoteWrites(): boolean {
    const config = this.currentConfig();
    return config.memoryWriteEnabled === true || isEnabled(this.runtimeEnv(), 'CATSLOG_MEMORY_WRITE_ENABLED');
  }

  async retrieveSkillMemory(
    query: CatscoSkillMemoryQuery,
    signal?: AbortSignal,
  ): Promise<CatscoSkillMemoryResponse> {
    const response = await this.withReadCapability(
      (capability, client) => client.retrieveSkillMemory({
        ...query,
        token: capability.token,
        memoryUrl: capability.memoryUrl,
        signal,
      }),
      signal,
    );
    this.rememberReceipts(response);
    return response;
  }

  async recallMemory(
    query: CatscoMemoryRecallQuery,
    signal?: AbortSignal,
  ): Promise<CatscoMemoryRecallResponse> {
    return this.withReadCapability(
      (capability, client) => client.recallMemory({
        ...query,
        token: capability.token,
        memoryRecallUrl: capability.memoryRecallUrl,
        signal,
      }),
      signal,
    );
  }

  async readSkills(query: CatscoSkillsQuery, signal?: AbortSignal): Promise<CatscoSkillsResponse> {
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).readSkills !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the Skills catalog route');
        }
        return client.readSkills({
        ...query,
        token: capability.token,
        skillsUrl: capability.skillsUrl,
        signal,
        });
      },
      signal,
    );
  }

  async readSkillGraph(query: CatscoSkillGraphQuery, signal?: AbortSignal): Promise<CatscoSkillGraphResponse> {
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).readSkillGraph !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the Skill Graph route');
        }
        return client.readSkillGraph({
        ...query,
        token: capability.token,
        skillGraphUrl: capability.skillGraphUrl,
        signal,
        });
      },
      signal,
    );
  }

  async querySessions(query: CatscoSessionQuery, signal?: AbortSignal): Promise<CatscoSessionQueryResult> {
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).querySessions !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the dedicated session route');
        }
        return client.querySessions({
        ...query,
        token: capability.token,
        sessionsUrl: capability.sessionsUrl,
        signal,
        });
      },
      signal,
    );
  }

  async reportSkillOutcome(
    input: CatscoSkillOutcomeInput & { requireReceipt?: boolean },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.supportsSkillOutcomes()) {
      throw new CatsLogMemoryUnavailableError(
        'CatsLog Skill outcomes are disabled; set CATSLOG_SKILL_OUTCOMES_ENABLED=true to enable them',
      );
    }
    const receipt = input.retrievalReceipt || this.findReceipt(input);
    const hasRouteOrFeedback = Boolean(
      input.feedback
      || input.routeId !== undefined
      || input.hop !== undefined
      || input.edgeKey !== undefined,
    );
    if (!receipt && hasRouteOrFeedback) {
      throw new CatsLogMemoryUnavailableError(
        'Route attribution and feedback require a live retrieval receipt; retrieve the Skill body first',
      );
    }
    if (input.requireReceipt && !receipt) {
      throw new CatsLogMemoryUnavailableError(
        'No live retrieval receipt is available for this Skill revision; retrieve its body first',
      );
    }
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).reportSkillOutcome !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support Skill outcomes');
        }
        return client.reportSkillOutcome({
        ...input,
        ...(receipt ? { retrievalReceipt: receipt } : {}),
        token: capability.token,
        skillsUrl: capability.skillsUrl,
        signal,
        });
      },
      signal,
    );
  }

  async createMemoryNote(input: CatscoMemoryNoteInput, signal?: AbortSignal): Promise<CatscoMemoryNote> {
    if (!this.supportsMemoryNoteWrites()) {
      throw new CatsLogMemoryUnavailableError(
        'CatsLog Agent Memory note writes are disabled; set CATSLOG_MEMORY_WRITE_ENABLED=true to enable them',
      );
    }
    return this.withWriteCapability(
      (capability, client) => {
        if (typeof (client as any).createMemoryNote !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support Agent Memory note writes');
        }
        return client.createMemoryNote({
        ...input,
        token: capability.token,
        memoryNotesUrl: capability.memoryNotesUrl,
        signal,
        });
      },
      signal,
    );
  }

  private async withReadCapability<T>(
    operation: (capability: CatsLogReadCapability, client: CatscoLogAgentClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let capability = await this.ensureReadCapability(false, signal);
    try {
      return await operation(capability, this.clientForCurrentConfig());
    } catch (error: any) {
      if (Number(error?.status) !== 401) throw error;
      this.invalidateSkillCapability(capability.token);
      capability = await this.ensureReadCapability(true, signal);
      return operation(capability, this.clientForCurrentConfig());
    }
  }

  private async withWriteCapability<T>(
    operation: (capability: CatsLogWriteCapability, client: CatscoLogAgentClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let capability = await this.ensureWriteCapability(false, signal);
    try {
      return await operation(capability, this.clientForCurrentConfig());
    } catch (error: any) {
      if (Number(error?.status) !== 401) throw error;
      this.invalidateMemoryWriteCapability(capability.token);
      capability = await this.ensureWriteCapability(true, signal);
      return operation(capability, this.clientForCurrentConfig());
    }
  }

  private async ensureReadCapability(forceRefresh: boolean, signal?: AbortSignal): Promise<CatsLogReadCapability> {
    const config = this.currentConfig();
    if (!config.apiBaseUrl) throw new CatsLogMemoryUnavailableError('CatsLog API is not configured');
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (state.stateCorrupt) {
      throw new CatsLogMemoryUnavailableError('CatsLog state is corrupt; read capability is paused');
    }
    if (!forceRefresh) {
      const existing = readCapabilityFromState(state, this.now());
      if (existing) return existing;
    }
    const capabilities = await this.bootstrapIfNeeded(config.stateFilePath, config.apiBaseUrl, config.catscoUserToken, signal);
    if (!capabilities.read) {
      throw new CatsLogMemoryUnavailableError('CatsLog bootstrap did not issue a Skill read capability');
    }
    return capabilities.read;
  }

  private async ensureWriteCapability(forceRefresh: boolean, signal?: AbortSignal): Promise<CatsLogWriteCapability> {
    const config = this.currentConfig();
    if (!config.apiBaseUrl) throw new CatsLogMemoryUnavailableError('CatsLog API is not configured');
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (state.stateCorrupt) {
      throw new CatsLogMemoryUnavailableError('CatsLog state is corrupt; write capability is paused');
    }
    if (!forceRefresh) {
      const existing = writeCapabilityFromState(state, this.now());
      if (existing) return existing;
    }
    const capabilities = await this.bootstrapIfNeeded(
      config.stateFilePath,
      config.apiBaseUrl,
      config.catscoUserToken,
      signal,
    );
    if (!capabilities.write) {
      throw new CatsLogMemoryUnavailableError('CatsLog bootstrap did not issue a memory write capability');
    }
    return capabilities.write;
  }

  private bootstrapIfNeeded(
    stateFilePath: string,
    apiBaseUrl: string,
    userToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<CatsLogCapabilities> {
    if (!userToken) {
      return Promise.reject(new CatsLogMemoryUnavailableError(
        'CatsLog capability is unavailable and no CatsCompany login token is configured',
      ));
    }
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrap(stateFilePath, apiBaseUrl, userToken, signal)
        .finally(() => {
          this.bootstrapPromise = null;
        });
    }
    return this.bootstrapPromise;
  }

  private async bootstrap(
    stateFilePath: string,
    apiBaseUrl: string,
    userToken: string,
    signal?: AbortSignal,
  ): Promise<CatsLogCapabilities> {
    const state = loadCatscoLogAgentState(stateFilePath);
    if (state.stateCorrupt) {
      throw new CatsLogMemoryUnavailableError('CatsLog state is corrupt; capability bootstrap is paused');
    }
    const deviceId = ensureCatscoDeviceId(state, stateFilePath);
    saveCatscoLogAgentState(stateFilePath, state);
    const response = await this.clientFor(apiBaseUrl).bootstrap({
      deviceId,
      deviceName: os.hostname(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      agentVersion: APP_VERSION,
      catscoUserToken: userToken,
      signal,
    });

    // CatsLog may normalize the client-supplied device label before returning
    // it (legacy servers use a canonical server-side spelling), so retain the
    // response identity while keeping the process-local requested ID stable.
    const responseDeviceId = clean(response.device_id);
    const skillToken = clean(response.skill_token);
    const skillExpiry = clean(response.skill_token_expires_at);
    const writeToken = clean(response.memory_write_token);
    const writeExpiry = clean(response.memory_write_token_expires_at);
    const uploadToken = clean(response.token);
    const hasRead = Boolean(
      skillToken
      && skillToken !== uploadToken
      && skillToken !== writeToken
      && isLiveExpiry(skillExpiry, this.now()),
    );
    const hasWrite = Boolean(
      writeToken
      && writeToken !== uploadToken
      && writeToken !== skillToken
      && isLiveExpiry(writeExpiry, this.now()),
    );
    if (!hasRead && !hasWrite) {
      throw new CatsLogMemoryUnavailableError('CatsLog bootstrap did not issue a live Agent capability');
    }

    const latest = loadCatscoLogAgentState(stateFilePath);
    if (latest.stateCorrupt) {
      throw new CatsLogMemoryUnavailableError('CatsLog state became corrupt during capability bootstrap');
    }
    latest.deviceId = responseDeviceId || deviceId;
    ensureCatscoDeviceId(latest, stateFilePath);

    if (hasRead) {
      latest.skillTokenId = clean(response.skill_token_id);
      latest.skillToken = skillToken;
      latest.skillTokenExpiresAt = skillExpiry;
      latest.skillsUrl = safePathOrDefault(response.skills_url, DEFAULT_SKILLS_URL);
      latest.skillGraphUrl = safePathOrDefault(response.skill_graph_url, DEFAULT_SKILL_GRAPH_URL);
      latest.sessionsUrl = safePathOrDefault(response.sessions_url, DEFAULT_SESSIONS_URL);
      latest.memoryUrl = safePathOrDefault(response.memory_url, DEFAULT_MEMORY_URL);
      latest.memoryRecallUrl = safePathOrDefault(response.memory_recall_url, DEFAULT_MEMORY_RECALL_URL);
    } else if (responseHasReadCapabilityFields(response as unknown as Record<string, unknown>)) {
      // Only clear the snapshot we actually attempted to replace. A second
      // bootstrap may have completed while this request was in flight; never
      // erase that newer capability with an older malformed response.
      const previousToken = clean(state.skillToken);
      if (clean(latest.skillToken) === previousToken) {
        clearCatscoSkillToken(latest);
      }
    }
    if (hasWrite) {
      latest.memoryWriteTokenId = clean(response.memory_write_token_id);
      latest.memoryWriteToken = writeToken;
      latest.memoryWriteTokenExpiresAt = writeExpiry;
      latest.memoryNotesUrl = safePathOrDefault(response.memory_notes_url, DEFAULT_MEMORY_NOTES_URL);
    } else if (responseHasWriteCapabilityFields(response as unknown as Record<string, unknown>)) {
      const previousToken = clean(state.memoryWriteToken);
      if (clean(latest.memoryWriteToken) === previousToken) {
        clearCatscoMemoryWriteToken(latest);
      }
    }
    saveCatscoLogAgentState(stateFilePath, latest);

    const capabilities = capabilitiesFromResponse(response, this.now());
    if (!capabilities.read && !capabilities.write) {
      throw new CatsLogMemoryUnavailableError('CatsLog bootstrap returned no usable capability');
    }
    return capabilities;
  }

  private invalidateSkillCapability(expectedToken?: string): void {
    const config = this.currentConfig();
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (state.stateCorrupt) return;
    if (expectedToken && clean(state.skillToken) !== expectedToken) return;
    clearCatscoSkillToken(state);
    saveCatscoLogAgentState(config.stateFilePath, state);
  }

  private invalidateMemoryWriteCapability(expectedToken?: string): void {
    const config = this.currentConfig();
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (state.stateCorrupt) return;
    if (expectedToken && clean(state.memoryWriteToken) !== expectedToken) return;
    clearCatscoMemoryWriteToken(state);
    saveCatscoLogAgentState(config.stateFilePath, state);
  }

  private currentConfig() {
    return getCatscoLogAgentConfig(this.workingDirectory, this.options.env ?? process.env);
  }

  private clientForCurrentConfig(): CatscoLogAgentClient {
    return this.clientFor(this.currentConfig().apiBaseUrl);
  }

  private clientFor(apiBaseUrl: string): CatscoLogAgentClient {
    return this.options.clientFactory?.(apiBaseUrl) ?? new CatscoLogAgentClient(apiBaseUrl);
  }

  private runtimeEnv(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private rememberReceipts(response: CatscoSkillMemoryResponse): void {
    const items = Array.isArray(response?.items) ? response.items : [];
    const now = this.now();
    const responseRoute = isRecord(response?.route) ? response.route : undefined;
    for (const raw of items) {
      if (!isRecord(raw)) continue;
      const receipt = clean(raw.retrieval_receipt);
      const handle = clean(raw.handle);
      const revision = positiveInteger(raw.revision);
      if (!receipt || !handle || !revision) continue;
      // A receipt may inherit the request-level route when the server omits
      // an item-specific copy. Keep that context so a later outcome can
      // repeat the same attribution without exposing the receipt itself.
      const route = isRecord(raw.route) ? raw.route : responseRoute;
      const entry: StoredReceipt = {
        receipt,
        handle,
        revision,
        routeId: clean(route?.route_id),
        hop: integerOrUndefined(route?.hop),
        edgeKey: clean(route?.edge_key),
        expiresAt: now + RECEIPT_TTL_MS,
        touchedAt: now,
      };
      this.receipts.set(receiptKey(entry), entry);
    }
    this.pruneReceipts(now);
  }

  private findReceipt(input: CatscoSkillOutcomeInput): string | undefined {
    const now = this.now();
    this.pruneReceipts(now);
    const handle = clean(input.handle);
    const routeId = clean(input.routeId);
    const edgeKey = clean(input.edgeKey);
    const candidates = [...this.receipts.values()]
      .filter(entry => entry.handle === handle && entry.revision === input.revision)
      .filter(entry => input.routeId === undefined || entry.routeId === routeId)
      .filter(entry => input.hop === undefined || entry.hop === input.hop)
      .filter(entry => input.edgeKey === undefined || entry.edgeKey === edgeKey)
      .sort((left, right) => right.touchedAt - left.touchedAt);
    const found = candidates[0];
    if (found) {
      found.touchedAt = now;
      return found.receipt;
    }
    return undefined;
  }

  private pruneReceipts(now: number): void {
    for (const [key, entry] of this.receipts) {
      if (entry.expiresAt <= now) this.receipts.delete(key);
    }
    if (this.receipts.size <= MAX_RECEIPTS) return;
    const ordered = [...this.receipts.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    for (const [key] of ordered.slice(0, this.receipts.size - MAX_RECEIPTS)) this.receipts.delete(key);
  }
}

export class CatsLogMemoryUnavailableError extends Error {
  readonly code = 'CATSLOG_MEMORY_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'CatsLogMemoryUnavailableError';
  }
}

function capabilitiesFromResponse(response: any, now: number): CatsLogCapabilities {
  const skillToken = clean(response?.skill_token);
  const skillExpiry = clean(response?.skill_token_expires_at);
  const uploadToken = clean(response?.token);
  const writeToken = clean(response?.memory_write_token);
  const read = skillToken && skillToken !== uploadToken && skillToken !== writeToken && isLiveExpiry(skillExpiry, now)
    ? {
      token: skillToken,
      skillsUrl: safePathOrDefault(response?.skills_url, DEFAULT_SKILLS_URL),
      skillGraphUrl: safePathOrDefault(response?.skill_graph_url, DEFAULT_SKILL_GRAPH_URL),
      sessionsUrl: safePathOrDefault(response?.sessions_url, DEFAULT_SESSIONS_URL),
      memoryUrl: safePathOrDefault(response?.memory_url, DEFAULT_MEMORY_URL),
      memoryRecallUrl: safePathOrDefault(response?.memory_recall_url, DEFAULT_MEMORY_RECALL_URL),
    }
    : null;
  const writeExpiry = clean(response?.memory_write_token_expires_at);
  const write = writeToken && writeToken !== uploadToken && writeToken !== skillToken && isLiveExpiry(writeExpiry, now)
    ? { token: writeToken, memoryNotesUrl: safePathOrDefault(response?.memory_notes_url, DEFAULT_MEMORY_NOTES_URL) }
    : undefined;
  return { ...(read ? { read } : {}), ...(write ? { write } : {}) };
}

function readCapabilityFromState(state: CatscoLogAgentState, now: number): CatsLogReadCapability | null {
  const token = clean(state.skillToken);
  const uploadToken = clean(state.token);
  const writeToken = clean(state.memoryWriteToken);
  if (!token || token === uploadToken || token === writeToken || !isLiveExpiry(state.skillTokenExpiresAt, now + CAPABILITY_REFRESH_SKEW_MS)) return null;
  return {
    token,
    skillsUrl: safePathOrDefault(state.skillsUrl, DEFAULT_SKILLS_URL),
    skillGraphUrl: safePathOrDefault(state.skillGraphUrl, DEFAULT_SKILL_GRAPH_URL),
    sessionsUrl: safePathOrDefault(state.sessionsUrl, DEFAULT_SESSIONS_URL),
    memoryUrl: safePathOrDefault(state.memoryUrl, DEFAULT_MEMORY_URL),
    memoryRecallUrl: safePathOrDefault(state.memoryRecallUrl, DEFAULT_MEMORY_RECALL_URL),
  };
}

function writeCapabilityFromState(state: CatscoLogAgentState, now: number): CatsLogWriteCapability | null {
  const token = clean(state.memoryWriteToken);
  const uploadToken = clean(state.token);
  const skillToken = clean(state.skillToken);
  if (!token || token === uploadToken || token === skillToken || !isLiveExpiry(state.memoryWriteTokenExpiresAt, now + CAPABILITY_REFRESH_SKEW_MS)) return null;
  return {
    token,
    memoryNotesUrl: safePathOrDefault(state.memoryNotesUrl, DEFAULT_MEMORY_NOTES_URL),
  };
}

function hasLiveToken(token: unknown, expiresAt: unknown, now: number): boolean {
  return Boolean(clean(token) && isLiveExpiry(clean(expiresAt), now));
}

function responseHasReadCapabilityFields(response: Record<string, unknown>): boolean {
  return [
    'skill_token_id', 'skill_token', 'skill_token_expires_at', 'skills_url',
    'skill_graph_url', 'sessions_url', 'memory_url', 'memory_recall_url',
  ].some(key => response[key] !== undefined);
}

function responseHasWriteCapabilityFields(response: Record<string, unknown>): boolean {
  return [
    'memory_notes_url', 'memory_write_token_id', 'memory_write_token',
    'memory_write_token_expires_at',
  ].some(key => response[key] !== undefined);
}

function isLiveExpiry(value: string | undefined, now: number): boolean {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && timestamp > now;
}

function safePathOrDefault(value: unknown, fallback: string): string {
  return isSafeCatsLogPath(typeof value === 'string' ? value : undefined) ? value as string : fallback;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function receiptKey(entry: StoredReceipt): string {
  return [entry.handle, entry.revision, entry.routeId || '', entry.hop ?? '', entry.edgeKey || ''].join('\u0000');
}

function isEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[key] || '').trim());
}

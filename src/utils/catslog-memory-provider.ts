import * as os from 'os';
import { APP_VERSION } from '../version';
import {
  CatscoLogAgentClient,
  DEFAULT_BRANCH_URL,
  DEFAULT_MEMORY_NOTES_URL,
  DEFAULT_MEMORY_RECALL_URL,
  DEFAULT_MEMORY_URL,
  DEFAULT_SESSIONS_URL,
  DEFAULT_SKILL_GRAPH_URL,
  DEFAULT_SKILLS_URL,
  isSafeCatsLogPath,
} from './catsco-log-agent-client';
import {
  DEFAULT_KNOWLEDGE_EXPAND_URL,
  DEFAULT_KNOWLEDGE_READ_URL,
  DEFAULT_KNOWLEDGE_SEARCH_URL,
} from './catslog-knowledge-types';
import type {
  CatscoBranchQuery,
  CatscoBranchResponse,
  CatscoSessionQuery,
  CatscoSessionQueryResult,
  CatscoSkillsQuery,
  CatscoSkillsResponse,
  CatscoSkillOutcomeInput,
} from './catsco-log-agent-client';
import type {
  CatsLogKnowledgeExpandQuery,
  CatsLogKnowledgeLinkPage,
  CatsLogKnowledgeReadQuery,
  CatsLogKnowledgeReadResult,
  CatsLogKnowledgeSearchPage,
  CatsLogKnowledgeSearchQuery,
} from './catslog-knowledge-types';
import { getCatscoLogAgentConfig } from './catsco-log-agent-config';
import type { CatscoLogAgentState } from './catsco-log-agent-state';
import {
  clearCatscoMemoryWriteToken,
  clearCatscoSkillToken,
  ensureCatscoDeviceId,
  loadCatscoLogAgentState,
  saveCatscoLogAgentState,
} from './catsco-log-agent-state';
import {
  cleanCapabilityText as clean,
  hasUsableReadCapability,
  hasUsableWriteCapability,
  responseHasReadCapabilityFields,
  responseHasWriteCapabilityFields,
} from './catsco-log-capability';

const CAPABILITY_REFRESH_SKEW_MS = 30_000;

/**
 * Narrow seam consumed by the memory branch and the local `catslog` CLI.
 * Thin v1: the branch only needs the fused ADR 0019 branch fan-out, so the
 * provider keeps the branch route plus the shared capability plumbing; the
 * Skills catalog and outcome routes remain for the explicit CLI commands.
 * Optional methods keep existing embedders/fakes source-compatible while the
 * concrete provider implements the complete device-bound Agent API.
 */
export interface CatsLogMemoryBackend {
  /**
   * Whether the remote capability should be advertised for a new branch turn.
   * Optional to keep lightweight embedders and test fakes source-compatible.
   */
  isAvailable?(): boolean;
  /** Optional ADR 0019 branch fan-out; omitted capability keeps older fakes source-compatible. */
  branch?(
    query: CatscoBranchQuery,
    signal?: AbortSignal,
  ): Promise<CatscoBranchResponse>;
  /**
   * Optional device-bound, redacted session-evidence query. Historical
   * sessions may only come from the server: the local JSONL tree has no
   * trustworthy per-agent scope labels, so it must never widen this.
   */
  querySessions?(
    query: CatscoSessionQuery,
    signal?: AbortSignal,
  ): Promise<CatscoSessionQueryResult>;
  /**
   * Optional downstream citation telemetry for the branch endpoint: reports
   * which pool refs the parent agent cited after consuming an injection.
   * Fire-and-forget by contract — callers must degrade silently.
   */
  reportBranchCitations?(input: {
    requestId: string;
    refs: string[];
  }, signal?: AbortSignal): Promise<void>;
  readSkills?(
    query: CatscoSkillsQuery,
    signal?: AbortSignal,
  ): Promise<CatscoSkillsResponse>;
  reportSkillOutcome?(
    input: CatscoSkillOutcomeInput & { requireReceipt?: boolean },
    signal?: AbortSignal,
  ): Promise<void>;
  supportsSkillOutcomes?(): boolean;
  /**
   * Whether the Agent-private daily knowledge recall surface is currently
   * exposed. Independent of the automatic branch switch: recall availability
   * is decided by login/state/config alone. Optional keeps fakes compatible.
   */
  isKnowledgeRecallAvailable?(): boolean;
  /** Optional knowledge/1 corpus search (device-bound, Agent-private scope). */
  searchKnowledge?(
    query: CatsLogKnowledgeSearchQuery,
    signal?: AbortSignal,
  ): Promise<CatsLogKnowledgeSearchPage>;
  /** Optional knowledge/1 document read; okf format returns the raw markdown body. */
  readKnowledge?(
    query: CatsLogKnowledgeReadQuery,
    signal?: AbortSignal,
  ): Promise<CatsLogKnowledgeReadResult>;
  /** Optional knowledge/1 link expansion around one typed anchor. */
  expandKnowledge?(
    query: CatsLogKnowledgeExpandQuery,
    signal?: AbortSignal,
  ): Promise<CatsLogKnowledgeLinkPage>;
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
  sessionsUrl: string;
  branchUrl: string;
  knowledgeSearchUrl: string;
  knowledgeReadUrl: string;
  knowledgeExpandUrl: string;
}

interface CatsLogCapabilities {
  read?: CatsLogReadCapability;
}

/**
 * Resolves bootstrap-issued capabilities and exposes only bounded Agent APIs.
 * Upload credentials, operator credentials, and filesystem paths never cross
 * this boundary.
 */
export class CatsLogMemoryProvider implements CatsLogMemoryBackend {
  private bootstrapPromise: Promise<CatsLogCapabilities> | null = null;

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

  async branch(query: CatscoBranchQuery, signal?: AbortSignal): Promise<CatscoBranchResponse> {
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).branch !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the branch route');
        }
        return client.branch({
          ...query,
          token: capability.token,
          branchUrl: capability.branchUrl,
          signal,
        });
      },
      signal,
    );
  }

  /** Read the dedicated, redacted, device-scoped session evidence projection. */
  async querySessions(query: CatscoSessionQuery, signal?: AbortSignal): Promise<CatscoSessionQueryResult> {
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).querySessions !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the session query route');
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

  /** Report downstream branch citations through the read capability. */
  async reportBranchCitations(input: {
    requestId: string;
    refs: string[];
  }, signal?: AbortSignal): Promise<void> {
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).reportBranchCitations !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the branch citations route');
        }
        return client.reportBranchCitations({
          ...input,
          token: capability.token,
          branchUrl: capability.branchUrl,
          signal,
        });
      },
      signal,
    );
  }

  /**
   * Whether the Agent-private daily knowledge recall surface is exposed.
   * Deliberately independent of the automatic branch switch: a device with a
   * live read capability may consult its private knowledge corpus even when
   * branch injection is off (or vice versa). `shouldExpose` keeps gating the
   * branch; this check only adds the knowledge-recall kill switch.
   */
  isKnowledgeRecallAvailable(): boolean {
    return CatsLogMemoryProvider.shouldExposeKnowledgeRecall(this.workingDirectory, this.runtimeEnv(), this.now());
  }

  static shouldExposeKnowledgeRecall(
    workingDirectory: string,
    env: NodeJS.ProcessEnv = process.env,
    now = Date.now(),
  ): boolean {
    const role = String(env.XIAOBA_ROLE || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    if (role === 'inspector-cat') return false;
    // Dedicated recall kill switch; defaults on. The branch-level override
    // (CATSLOG_MEMORY_ENABLED) intentionally does NOT gate recall.
    if (/^(0|false|off|no)$/i.test(String(env.CATSLOG_KNOWLEDGE_RECALL_ENABLED || '').trim())) {
      return false;
    }
    const config = getCatscoLogAgentConfig(workingDirectory, env);
    if (!config.apiBaseUrl) return false;
    if (config.catscoUserToken) return true;
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (state.stateCorrupt) return false;
    return Boolean(readCapabilityFromState(state, now));
  }

  /** Search the Agent-private daily knowledge corpus (knowledge/1). */
  async searchKnowledge(query: CatsLogKnowledgeSearchQuery, signal?: AbortSignal): Promise<CatsLogKnowledgeSearchPage> {
    // Kill-switch/role gate runs BEFORE any HTTP dispatch: with recall
    // disabled the provider must never emit a request, only a typed error.
    if (!this.isKnowledgeRecallAvailable()) {
      throw new CatsLogMemoryUnavailableError('CatsLog knowledge recall is disabled or has no live capability');
    }
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).searchKnowledge !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the knowledge search route');
        }
        return client.searchKnowledge({
          ...query,
          token: capability.token,
          knowledgeSearchUrl: capability.knowledgeSearchUrl,
          signal,
        });
      },
      signal,
    );
  }

  /** Read one daily knowledge document; `okf` returns the raw markdown body. */
  async readKnowledge(query: CatsLogKnowledgeReadQuery, signal?: AbortSignal): Promise<CatsLogKnowledgeReadResult> {
    if (!this.isKnowledgeRecallAvailable()) {
      throw new CatsLogMemoryUnavailableError('CatsLog knowledge recall is disabled or has no live capability');
    }
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).readKnowledge !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the knowledge read route');
        }
        return client.readKnowledge({
          ...query,
          token: capability.token,
          knowledgeReadUrl: capability.knowledgeReadUrl,
          signal,
        });
      },
      signal,
    );
  }

  /** Expand knowledge links around one typed anchor endpoint. */
  async expandKnowledge(query: CatsLogKnowledgeExpandQuery, signal?: AbortSignal): Promise<CatsLogKnowledgeLinkPage> {
    if (!this.isKnowledgeRecallAvailable()) {
      throw new CatsLogMemoryUnavailableError('CatsLog knowledge recall is disabled or has no live capability');
    }
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).expandKnowledge !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support the knowledge expand route');
        }
        return client.expandKnowledge({
          ...query,
          token: capability.token,
          knowledgeExpandUrl: capability.knowledgeExpandUrl,
          signal,
        });
      },
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

  async reportSkillOutcome(
    input: CatscoSkillOutcomeInput & { requireReceipt?: boolean },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.supportsSkillOutcomes()) {
      throw new CatsLogMemoryUnavailableError(
        'CatsLog Skill outcomes are disabled; set CATSLOG_SKILL_OUTCOMES_ENABLED=true to enable them',
      );
    }
    // Thin v1: no client-side receipt vault. Receipts are issued by the
    // server on a bounded body read and must be passed through explicitly;
    // route attribution is only meaningful alongside one.
    const hasRouteOrFeedback = Boolean(
      input.feedback
      || input.routeId !== undefined
      || input.hop !== undefined
      || input.edgeKey !== undefined,
    );
    if ((input.requireReceipt || hasRouteOrFeedback) && !input.retrievalReceipt) {
      throw new CatsLogMemoryUnavailableError(
        'Route attribution and requireReceipt outcomes need an explicit retrieval receipt; pass the receipt issued for this Skill body read',
      );
    }
    return this.withReadCapability(
      (capability, client) => {
        if (typeof (client as any).reportSkillOutcome !== 'function') {
          throw new CatsLogMemoryUnavailableError('CatsLog client does not support Skill outcomes');
        }
        return client.reportSkillOutcome({
          ...input,
          token: capability.token,
          skillsUrl: capability.skillsUrl,
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
    // Deliberate shared-handshake semantics: concurrent callers await one
    // bootstrap, and that handshake is bound to the first caller's signal.
    // A second caller cannot cancel the shared request individually and may
    // observe an abort raised by the first caller; the next capability read
    // simply retries. Per-caller cancellation would require per-caller
    // handshakes, which risks duplicate device scopes.
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
    const responseRecord = response as unknown as Record<string, unknown>;
    const skillToken = clean(response.skill_token);
    const skillExpiry = clean(response.skill_token_expires_at);
    const writeToken = clean(response.memory_write_token);
    const writeExpiry = clean(response.memory_write_token_expires_at);
    const hasRead = hasUsableReadCapability(responseRecord, this.now());
    const hasWrite = hasUsableWriteCapability(responseRecord, this.now());
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
      latest.branchUrl = safePathOrDefault(response.branch_url, DEFAULT_BRANCH_URL);
      latest.knowledgeSearchUrl = safePathOrDefault(responseRecord.knowledge_search_url, DEFAULT_KNOWLEDGE_SEARCH_URL);
      latest.knowledgeReadUrl = safePathOrDefault(responseRecord.knowledge_read_url, DEFAULT_KNOWLEDGE_READ_URL);
      latest.knowledgeExpandUrl = safePathOrDefault(responseRecord.knowledge_expand_url, DEFAULT_KNOWLEDGE_EXPAND_URL);
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
    if (!capabilities.read) {
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
}

export class CatsLogMemoryUnavailableError extends Error {
  readonly code = 'CATSLOG_MEMORY_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'CatsLogMemoryUnavailableError';
  }
}

function capabilitiesFromResponse(response: any, now: number): CatsLogCapabilities {
  const record = response as unknown as Record<string, unknown>;
  const read = hasUsableReadCapability(record, now)
    ? {
      token: clean(response?.skill_token)!,
      skillsUrl: safePathOrDefault(response?.skills_url, DEFAULT_SKILLS_URL),
      sessionsUrl: safePathOrDefault(response?.sessions_url, DEFAULT_SESSIONS_URL),
      branchUrl: safePathOrDefault(response?.branch_url, DEFAULT_BRANCH_URL),
      knowledgeSearchUrl: safePathOrDefault(response?.knowledge_search_url, DEFAULT_KNOWLEDGE_SEARCH_URL),
      knowledgeReadUrl: safePathOrDefault(response?.knowledge_read_url, DEFAULT_KNOWLEDGE_READ_URL),
      knowledgeExpandUrl: safePathOrDefault(response?.knowledge_expand_url, DEFAULT_KNOWLEDGE_EXPAND_URL),
    }
    : null;
  return { ...(read ? { read } : {}) };
}

function readCapabilityFromState(state: CatscoLogAgentState, now: number): CatsLogReadCapability | null {
  const token = clean(state.skillToken);
  const uploadToken = clean(state.token);
  const writeToken = clean(state.memoryWriteToken);
  if (!token || token === uploadToken || token === writeToken || !isLiveExpiry(state.skillTokenExpiresAt, now + CAPABILITY_REFRESH_SKEW_MS)) return null;
  return {
    token,
    skillsUrl: safePathOrDefault(state.skillsUrl, DEFAULT_SKILLS_URL),
    sessionsUrl: safePathOrDefault(state.sessionsUrl, DEFAULT_SESSIONS_URL),
    branchUrl: safePathOrDefault(state.branchUrl, DEFAULT_BRANCH_URL),
    knowledgeSearchUrl: safePathOrDefault(state.knowledgeSearchUrl, DEFAULT_KNOWLEDGE_SEARCH_URL),
    knowledgeReadUrl: safePathOrDefault(state.knowledgeReadUrl, DEFAULT_KNOWLEDGE_READ_URL),
    knowledgeExpandUrl: safePathOrDefault(state.knowledgeExpandUrl, DEFAULT_KNOWLEDGE_EXPAND_URL),
  };
}

function isLiveExpiry(value: string | undefined, now: number): boolean {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && timestamp > now;
}

function safePathOrDefault(value: unknown, fallback: string): string {
  return isSafeCatsLogPath(typeof value === 'string' ? value : undefined) ? value as string : fallback;
}

function isEnabled(env: NodeJS.ProcessEnv, key: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(env[key] || '').trim());
}

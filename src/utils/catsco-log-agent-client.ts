import * as fs from 'fs';
import * as path from 'path';

export interface CatscoBootstrapInput {
  deviceId: string;
  deviceName?: string;
  platform?: string;
  hostname?: string;
  agentVersion?: string;
  catscoUserToken: string;
  signal?: AbortSignal;
}
export interface CatscoBootstrapResponse {
  user_id: string;
  external_provider: string;
  external_user_id: string;
  device_id: string;
  token_id: string;
  token: string;
  /** Device-bound read capability; never substitute the upload token. */
  skill_token_id?: string;
  skill_token?: string;
  skill_token_expires_at?: string;
  skills_url?: string;
  skill_graph_url?: string;
  sessions_url?: string;
  memory_url?: string;
  memory_recall_url?: string;
  memory_notes_url?: string;
  memory_write_token_id?: string;
  memory_write_token?: string;
  memory_write_token_expires_at?: string;
  upload_url: string;
  upload_protocol?: number;
  append_url?: string;
  issued_at: string;
  expires_at?: string;
}

export interface CatscoUploadResponse {
  upload_id?: string;
  record_id?: string;
  sha256?: string;
  parse_status?: string;
  status?: string;
}

export interface CatscoSkillMemoryQuery {
  task?: string;
  handle?: string;
  limit?: number;
  includeContent?: boolean;
  routeId?: string;
  hop?: number;
  edgeKey?: string;
  /** Optional cache validator for metadata-only reads. */
  ifNoneMatch?: string;
}

export interface CatscoSkillMemoryResponse {
  schema_version?: number;
  content_trust?: string;
  catalog_revision?: number;
  items?: CatscoSkillMemoryItem[];
  graph?: Record<string, unknown>;
  truncated?: boolean;
  route?: Record<string, unknown>;
  /** True when the server answered 304 to an optional conditional read. */
  not_modified?: boolean;
  etag?: string;
}

export interface CatscoSkillMemoryItem {
  id?: string;
  handle?: string;
  revision?: number;
  routing_name?: string;
  description?: string;
  contract?: unknown;
  content_sha256?: string;
  updated_at?: string;
  content?: string;
  /** One-time capability; callers should not expose it to a model. */
  retrieval_receipt?: string;
  route?: Record<string, unknown>;
  score?: number;
  evidence_count?: number;
  dependency_count?: number;
  outcome?: Record<string, unknown>;
  feedback?: unknown[];
}

export type CatscoSkillTraceMode = 'none' | 'summary' | 'full';

export interface CatscoSkillsQuery {
  handle?: string;
  search?: string;
  includeContent?: boolean;
  includeTrace?: CatscoSkillTraceMode;
  limit?: number;
  cursor?: string;
  /** Optional cache validator for metadata-only reads. */
  ifNoneMatch?: string;
}

export interface CatscoSkill {
  id?: string;
  handle?: string;
  revision?: number;
  routing_name?: string;
  description?: string;
  contract?: unknown;
  content_sha256?: string;
  updated_at?: string;
  content?: string;
  trace?: unknown;
}

export interface CatscoSkillsResponse {
  schema_version?: number;
  content_trust?: string;
  catalog_revision?: number;
  skills?: CatscoSkill[];
  next_cursor?: string;
  truncated?: boolean;
  incomplete?: boolean;
  /** True when the server answered 304 to an optional conditional read. */
  not_modified?: boolean;
  etag?: string;
}

export interface CatscoSkillGraphQuery {
  handle?: string;
  limit?: number;
  depth?: 0 | 1;
  includeEvidence?: boolean;
  ifNoneMatch?: string;
}

export interface CatscoSkillGraphNode {
  id?: string;
  handle?: string;
  revision?: number;
  routing_name?: string;
  description?: string;
  content_sha256?: string;
  updated_at?: string;
  provenance_id?: string;
  transition_id?: string;
  origin?: string;
  status?: string;
  active?: boolean;
  evidence_count?: number;
  dependency_count?: number;
  evidence_refs?: string[];
}

export interface CatscoSkillGraphEdge {
  from?: string;
  to?: string;
  type?: string;
  resolved?: boolean;
  target_handle?: string;
  target_revision?: number;
  guidance_hash?: string;
}

export interface CatscoSkillGraphResponse {
  schema_version?: number;
  content_trust?: string;
  catalog_revision?: number;
  nodes?: CatscoSkillGraphNode[];
  edges?: CatscoSkillGraphEdge[];
  truncated?: boolean;
  not_modified?: boolean;
  etag?: string;
}

export interface CatscoMemoryRecallQuery {
  sessionId?: string;
  sessionType?: string;
  groupId?: string;
  agentId?: string;
  entryType?: string;
  latest?: boolean;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  noteLimit?: number;
  cursor?: string;
  includeNotes?: boolean;
  noteKind?: string;
  noteKey?: string;
  noteSearch?: string;
  includeNoteContent?: boolean;
  /** Optional cache validator for recalls that do not include note bodies. */
  ifNoneMatch?: string;
}

/** Dedicated session evidence query; unlike operator analysis it has no UID selectors. */
export interface CatscoSessionQuery {
  streamId?: string;
  sessionId?: string;
  sessionType?: string;
  groupId?: string;
  agentId?: string;
  entryType?: string;
  latest?: boolean;
  sessionSummary?: boolean;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
  ifNoneMatch?: string;
}

export interface CatscoMemoryRecallResponse {
  schema_version?: number;
  content_trust?: string;
  session_available?: boolean;
  session?: CatscoSessionQueryResult;
  notes?: CatscoMemoryNote[];
  notes_truncated?: boolean;
  not_modified?: boolean;
  etag?: string;
}

export interface CatscoSessionQueryResult {
  schema_version?: number;
  content_trust?: string;
  uid?: string;
  uids?: string[];
  records?: CatscoSessionRecord[];
  next_cursor?: string;
  truncated?: boolean;
  summary?: Record<string, unknown>;
  not_modified?: boolean;
  etag?: string;
}

export interface CatscoSkillOutcomeFeedback {
  code: string;
  summary?: string;
  tags?: string[];
}

export interface CatscoSkillOutcomeInput {
  handle: string;
  revision: number;
  outcome: 'succeeded' | 'failed' | 'corrected';
  retrievalReceipt?: string;
  routeId?: string;
  hop?: number;
  edgeKey?: string;
  feedback?: CatscoSkillOutcomeFeedback;
}

export interface CatscoMemoryNoteInput {
  kind: 'episode' | 'fact';
  key?: string;
  title?: string;
  content: string;
  includeContent?: boolean;
  sourceRefs?: string[];
  confidence?: number;
  validFrom?: string;
  validTo?: string;
  supersedesId?: string;
  requestId?: string;
}

export interface CatscoSessionRecord {
  ref?: string;
  stream_id?: string;
  session_id?: string;
  session_type?: string;
  log_date?: string;
  agent_id?: string;
  line?: number;
  entry_type?: string;
  timestamp?: string;
  turn?: number;
  user?: CatscoActor;
  agent?: CatscoActor;
  tool_calls?: Array<{ name?: string; type?: string }>;
  event?: { type?: string; level?: string; message?: string };
  prompt?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  skill_calls?: number;
  skill_names?: string[];
}

export interface CatscoActor {
  text?: string;
  truncated?: boolean;
  redacted?: boolean;
}

export interface CatscoMemoryNote {
  id?: string;
  kind?: string;
  key?: string;
  title?: string;
  content?: string;
  content_sha256?: string;
  source_refs?: string[];
  confidence?: number;
  valid_from?: string;
  valid_to?: string;
  supersedes_id?: string;
  created_at?: string;
  origin?: string;
  skill_version_id?: string;
  feedback_code?: string;
  feedback_outcome?: string;
  feedback_tags?: string[];
  feedback_summary?: string;
  feedback_summary_sha256?: string;
}

export const DEFAULT_SKILLS_URL = '/catsco/agent/skills';
export const DEFAULT_SKILL_GRAPH_URL = '/catsco/agent/skill-graph';
export const DEFAULT_SESSIONS_URL = '/catsco/agent/query/v1/sessions';
export const DEFAULT_MEMORY_URL = '/catsco/agent/memory/retrieve';
export const DEFAULT_MEMORY_RECALL_URL = '/catsco/agent/memory/recall';
export const DEFAULT_MEMORY_NOTES_URL = '/catsco/agent/memory/notes';

function addQueryValue(query: URLSearchParams, key: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) query.set(key, value);
}

function addQueryBoolean(query: URLSearchParams, key: string, value: unknown): void {
  // CatsLog defaults these flags to false; omitting false keeps metadata reads
  // cache-friendly and preserves the v2 client's wire shape.
  if (value === true) query.set(key, 'true');
}

function addQueryNumber(query: URLSearchParams, key: string, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) query.set(key, String(value));
}

function requireCapabilityToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) throw new Error('CatsLog capability token is missing');
  return token;
}

export function isSafeCatsLogSkillHandle(value: unknown): value is string {
  const handle = typeof value === 'string' ? value.trim() : '';
  return isSafeCatsLogOpaqueIdentifier(handle, 256);
}

/**
 * Validate a CatsLog opaque identifier using the same character and privacy
 * boundary as the server provenance package.  The server intentionally allows
 * punctuation as the first character (for example `@scope`), so do not add a
 * conventional identifier-leading-letter rule here.
 */
export function isSafeCatsLogOpaqueIdentifier(value: unknown, maxBytes = 512): value is string {
  const identifier = typeof value === 'string' ? value.trim() : '';
  if (!identifier || Buffer.byteLength(identifier, 'utf8') > maxBytes || !/^[A-Za-z0-9._:@#-]+$/.test(identifier)) return false;
  if (identifier.includes('..') || /[%~$]/.test(identifier)) return false;
  const lower = identifier.toLowerCase();
  if (lower.startsWith('file:') || lower.startsWith('http:') || lower.startsWith('https:') || lower.startsWith('ssh:')) return false;
  if (lower.startsWith('ref_') && !/^ref_[a-f0-9]{64}$/.test(lower)) return false;
  if ([
    'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_',
    'sk-', 'sk_', 'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'akia',
  ].some(marker => lower.includes(marker))) return false;
  return !looksLikeJWT(identifier) && !hasLongMixedToken(identifier);
}

function looksLikeJWT(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some(part => part.length < 8)) return false;
  return parts.every(part => /^[A-Za-z0-9_-]+$/.test(part));
}

function hasLongMixedToken(value: string): boolean {
  return value.split(/[/\\:#@_-]+/).some(part => {
    if (part.length < 64) return false;
    return /[a-z]/.test(part) && /[A-Z]/.test(part) && /[0-9]/.test(part);
  });
}

function normalizeSkillHandle(value: unknown): string {
  const handle = typeof value === 'string' ? value.trim() : '';
  // CatsLog provenance identifiers are path-free ASCII identifiers. Rejecting
  // anything else here keeps the outcome URL from becoming a path traversal or
  // an externally supplied endpoint.
  if (!isSafeCatsLogSkillHandle(handle)) throw new Error('CatsLog Skill handle is invalid');
  return handle;
}

export class CatscoLogAgentClient {
  constructor(private readonly apiBaseUrl: string) {}

  async bootstrap(input: CatscoBootstrapInput): Promise<CatscoBootstrapResponse> {
    const response = await fetch(this.buildUrl('/catsco/agent/bootstrap'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${input.catscoUserToken}`,
        'Content-Type': 'application/json',
      },
      signal: input.signal,
      body: JSON.stringify({
        device_id: input.deviceId,
        device_name: input.deviceName,
        platform: input.platform,
        hostname: input.hostname,
        agent_version: input.agentVersion,
      }),
    });

    return this.parseJsonResponse<CatscoBootstrapResponse>(response, 'CatsLog bootstrap failed');
  }

  async uploadLog(input: {
    filePath: string;
    token: string;
    logDate: string;
  }): Promise<CatscoUploadResponse> {
    const form = new FormData();
    form.append('log_date', input.logDate);

    const fileBuffer = fs.readFileSync(input.filePath);
    form.append(
      'file',
      new Blob([fileBuffer], { type: 'application/x-ndjson' }),
      path.basename(input.filePath),
    );

    const response = await fetch(this.buildUrl('/catsco/logs/upload'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
      },
      body: form,
    });

    return this.parseJsonResponse<CatscoUploadResponse>(response, 'CatsLog upload failed');
  }

  /**
   * Read the compatibility Skills catalog.  This route is metadata-first and
   * never accepts a UID selector; the caller supplies the device-bound token.
   */
  async readSkills(input: CatscoSkillsQuery & {
    token?: string;
    /** Alias kept for clients that used the v2 naming. */
    skillToken?: string;
    skillsUrl?: string;
    signal?: AbortSignal;
  }): Promise<CatscoSkillsResponse> {
    const token = requireCapabilityToken(input.token ?? input.skillToken);
    if (input.handle !== undefined && !isSafeCatsLogSkillHandle(input.handle)) {
      throw new Error('CatsLog Skill handle is invalid');
    }
    if (input.includeTrace !== undefined && !['none', 'summary', 'full'].includes(input.includeTrace)) {
      throw new Error('CatsLog Skill trace mode is invalid');
    }
    const query = new URLSearchParams();
    addQueryValue(query, 'handle', input.handle);
    addQueryValue(query, 'search', input.search);
    addQueryBoolean(query, 'include_content', input.includeContent);
    // CatsLog represents the cheap trace mode as an omitted/empty value;
    // accepting the friendly "none" alias must not send an invalid enum.
    if (input.includeTrace && input.includeTrace !== 'none') {
      addQueryValue(query, 'include_trace', input.includeTrace);
    }
    addQueryNumber(query, 'limit', input.limit);
    addQueryValue(query, 'cursor', input.cursor);
    const url = this.buildCapabilityUrl(input.skillsUrl || DEFAULT_SKILLS_URL, query);
    return this.getCapabilityJSON<CatscoSkillsResponse>(
      url,
      token,
      'CatsLog Skills catalog read failed',
      input.signal,
      input.ifNoneMatch,
    );
  }

  /** Read the bounded, one-hop Skill Graph for the device capability. */
  async readSkillGraph(input: CatscoSkillGraphQuery & {
    token?: string;
    skillToken?: string;
    skillGraphUrl?: string;
    signal?: AbortSignal;
  }): Promise<CatscoSkillGraphResponse> {
    const token = requireCapabilityToken(input.token ?? input.skillToken);
    if (input.handle !== undefined && !isSafeCatsLogSkillHandle(input.handle)) {
      throw new Error('CatsLog Skill handle is invalid');
    }
    const query = new URLSearchParams();
    addQueryValue(query, 'handle', input.handle);
    addQueryNumber(query, 'limit', input.limit);
    addQueryNumber(query, 'depth', input.depth);
    addQueryBoolean(query, 'include_evidence', input.includeEvidence);
    const url = this.buildCapabilityUrl(input.skillGraphUrl || DEFAULT_SKILL_GRAPH_URL, query);
    return this.getCapabilityJSON<CatscoSkillGraphResponse>(
      url,
      token,
      'CatsLog Skill Graph read failed',
      input.signal,
      input.ifNoneMatch,
    );
  }

  /** Read the dedicated, redacted session evidence projection. */
  async querySessions(input: CatscoSessionQuery & {
    token?: string;
    skillToken?: string;
    sessionsUrl?: string;
    signal?: AbortSignal;
  }): Promise<CatscoSessionQueryResult> {
    const token = requireCapabilityToken(input.token ?? input.skillToken);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      stream_id: input.streamId,
      session_id: input.sessionId,
      session_type: input.sessionType,
      group_id: input.groupId,
      agent_id: input.agentId,
      entry_type: input.entryType,
      latest: input.latest,
      session_summary: input.sessionSummary,
      search: input.search,
      from: input.from,
      to: input.to,
      limit: input.limit,
      cursor: input.cursor,
    })) {
      if (value !== undefined) body[key] = value;
    }
    return this.postCapabilityJSON<CatscoSessionQueryResult>(
      input.sessionsUrl || DEFAULT_SESSIONS_URL,
      token,
      body,
      'CatsLog session query failed',
      input.signal,
      input.ifNoneMatch,
    );
  }

  /** Retrieve current Skills through the device-bound Skill Memory capability. */
  async retrieveSkillMemory(input: CatscoSkillMemoryQuery & {
    token?: string;
    skillToken?: string;
    memoryUrl?: string;
    signal?: AbortSignal;
  }): Promise<CatscoSkillMemoryResponse> {
    const token = requireCapabilityToken(input.token ?? input.skillToken);
    if (input.handle !== undefined && !isSafeCatsLogSkillHandle(input.handle)) {
      throw new Error('CatsLog Skill handle is invalid');
    }
    validateSkillRoute(input.routeId, input.hop, input.edgeKey);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      task: input.task,
      handle: input.handle,
      limit: input.limit,
      include_content: input.includeContent,
      route_id: input.routeId,
      hop: input.hop,
      edge_key: input.edgeKey,
    })) {
      if (value !== undefined) body[key] = value;
    }
    return this.postCapabilityJSON<CatscoSkillMemoryResponse>(
      input.memoryUrl || DEFAULT_MEMORY_URL,
      token,
      body,
      'CatsLog Skill Memory retrieval failed',
      input.signal,
      input.ifNoneMatch,
    );
  }

  /** Retrieve redacted session evidence and optional Agent Memory notes. */
  async recallMemory(input: CatscoMemoryRecallQuery & {
    token?: string;
    skillToken?: string;
    memoryRecallUrl?: string;
    signal?: AbortSignal;
  }): Promise<CatscoMemoryRecallResponse> {
    const token = requireCapabilityToken(input.token ?? input.skillToken);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      session_id: input.sessionId,
      session_type: input.sessionType,
      group_id: input.groupId,
      agent_id: input.agentId,
      entry_type: input.entryType,
      latest: input.latest,
      search: input.search,
      from: input.from,
      to: input.to,
      limit: input.limit,
      note_limit: input.noteLimit,
      cursor: input.cursor,
      include_notes: input.includeNotes,
      note_kind: input.noteKind,
      note_key: input.noteKey,
      note_search: input.noteSearch,
      include_note_content: input.includeNoteContent,
    })) {
      if (value !== undefined) body[key] = value;
    }
    return this.postCapabilityJSON<CatscoMemoryRecallResponse>(
      input.memoryRecallUrl || DEFAULT_MEMORY_RECALL_URL,
      token,
      body,
      'CatsLog Agent Memory recall failed',
      input.signal,
      input.ifNoneMatch,
    );
  }

  /**
   * Report a bounded Skill terminal outcome.  The receipt is accepted only by
   * CatsLog and is never included in a model-visible tool result.
   */
  async reportSkillOutcome(input: CatscoSkillOutcomeInput & {
    token?: string;
    skillToken?: string;
    skillsUrl?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const token = requireCapabilityToken(input.token ?? input.skillToken);
    const handle = normalizeSkillHandle(input.handle);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error('CatsLog Skill revision is invalid');
    }
    if (!['succeeded', 'failed', 'corrected'].includes(input.outcome)) {
      throw new Error('CatsLog Skill outcome is invalid');
    }
    validateSkillRoute(input.routeId, input.hop, input.edgeKey);
    const feedback = normalizeSkillFeedback(input.feedback);
    const base = this.buildUrl((input.skillsUrl || DEFAULT_SKILLS_URL).replace(/\/+$/, ''));
    const outcomePath = `${base}/${encodeURIComponent(handle)}/outcomes`;
    const body: Record<string, unknown> = {
      revision: input.revision,
      outcome: input.outcome,
    };
    if (input.retrievalReceipt !== undefined) body.retrieval_receipt = input.retrievalReceipt;
    if (input.routeId !== undefined) body.route_id = input.routeId;
    if (input.hop !== undefined) body.hop = input.hop;
    if (input.edgeKey !== undefined) body.edge_key = input.edgeKey;
    if (feedback !== undefined) {
      body.feedback = {
        code: feedback.code,
        ...(feedback.summary !== undefined ? { summary: feedback.summary } : {}),
        ...(feedback.tags !== undefined ? { tags: feedback.tags } : {}),
      };
    }
    const response = await fetch(outcomePath, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: input.signal,
      body: JSON.stringify(body),
    });
    await this.parseJsonResponse<Record<string, never>>(response, 'CatsLog Skill outcome failed');
  }

  /** Write one explicitly requested episode/fact note with the separate write token. */
  async createMemoryNote(input: CatscoMemoryNoteInput & {
    token?: string;
    memoryWriteToken?: string;
    memoryNotesUrl?: string;
    signal?: AbortSignal;
  }): Promise<CatscoMemoryNote> {
    const token = requireCapabilityToken(input.token ?? input.memoryWriteToken);
    validateMemoryNoteInput(input);
    const body: Record<string, unknown> = {
      kind: input.kind,
      content: input.content,
    };
    for (const [key, value] of Object.entries({
      key: input.key,
      title: input.title,
      include_content: input.includeContent,
      source_refs: input.sourceRefs,
      confidence: input.confidence,
      valid_from: input.validFrom,
      valid_to: input.validTo,
      supersedes_id: input.supersedesId,
      request_id: input.requestId,
    })) {
      if (value !== undefined) body[key] = value;
    }
    return this.postCapabilityJSON<CatscoMemoryNote>(
      input.memoryNotesUrl || DEFAULT_MEMORY_NOTES_URL,
      token,
      body,
      'CatsLog Agent Memory note write failed',
      input.signal,
    );
  }

  private buildUrl(requestPath: string): string {
    if (!this.apiBaseUrl) {
      throw new Error('CATSCO_LOG_API_BASE_URL is not configured');
    }
    const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    if (!isSafeCatsLogPath(normalizedPath)) {
      throw new Error('CatsLog returned an unsafe endpoint path');
    }
    return `${this.apiBaseUrl}${normalizedPath}`;
  }

  private buildCapabilityUrl(requestPath: string, query: URLSearchParams): string {
    const base = this.buildUrl(requestPath);
    return query.size ? `${base}?${query.toString()}` : base;
  }

  private async getCapabilityJSON<T>(
    url: string,
    token: string,
    fallbackMessage: string,
    signal?: AbortSignal,
    ifNoneMatch?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const response = await fetch(url, { headers, signal });
    return this.parseJsonResponse<T>(response, fallbackMessage);
  }

  private async postCapabilityJSON<T>(
    requestPath: string,
    token: string,
    body: Record<string, unknown>,
    fallbackMessage: string,
    signal?: AbortSignal,
    ifNoneMatch?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const response = await fetch(this.buildUrl(requestPath), {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(body),
    });
    return this.parseJsonResponse<T>(response, fallbackMessage);
  }

  private async parseJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
    const etag = response.headers.get('etag') || undefined;
    if (response.status === 304) {
      return {
        not_modified: true,
        ...(etag ? { etag } : {}),
      } as T;
    }
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) {
          const error = new Error(`${fallbackMessage}: invalid JSON response`);
          (error as any).status = response.status;
          throw error;
        }
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const detail = data?.detail || data?.error || data?.message || data?.raw;
      const error = new Error(detail ? `${fallbackMessage}: ${detail}` : `${fallbackMessage}: HTTP ${response.status}`);
      (error as any).status = response.status;
      (error as any).payload = data;
      throw error;
    }

    // Every CatsLog JSON endpoint returns an object envelope. Rejecting null or
    // arrays here keeps a malformed/misrouted response from being mistaken for
    // an empty capability while the branch projection still filters malformed
    // nested entries defensively.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const error = new Error(`${fallbackMessage}: invalid response envelope`);
      (error as any).status = response.status;
      throw error;
    }

    return data as T;
  }
}

/** Bootstrap URLs are relative paths owned by CatsLog, never arbitrary URLs. */
export function isSafeCatsLogPath(value: string | undefined): value is string {
  const raw = String(value || '');
  const normalized = raw.trim();
  if (raw !== normalized || normalized.length === 0 || normalized.length > 512) return false;
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(normalized) || normalized.includes('//')) return false;
  if (normalized === '/') return false;
  return !normalized.split('/').some(segment => segment === '.' || segment === '..');
}

const SKILL_FEEDBACK_CODES = new Set([
  'missing_precondition',
  'environment_constraint',
  'outdated',
  'incorrect',
  'unsafe',
  'ambiguous',
  'performance',
  'other',
]);
const MEMORY_NOTE_SOURCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#@+=~-]*$/;

function validateSkillRoute(routeId: unknown, hop: unknown, edgeKey: unknown): void {
  if (routeId !== undefined && typeof routeId !== 'string') {
    throw new Error('CatsLog Skill route ID is invalid');
  }
  if (edgeKey !== undefined && typeof edgeKey !== 'string') {
    throw new Error('CatsLog Skill route edge key is invalid');
  }
  const normalizedRoute = typeof routeId === 'string' ? routeId.trim() : '';
  const normalizedEdge = typeof edgeKey === 'string' ? edgeKey.trim() : '';
  const normalizedHop = hop === undefined ? 0 : hop;
  if (!normalizedRoute && (normalizedEdge || normalizedHop !== 0)) {
    throw new Error('CatsLog Skill route attribution requires a route ID');
  }
  if (normalizedRoute && !isSafeCatsLogOpaqueIdentifier(normalizedRoute, 128)) {
    throw new Error('CatsLog Skill route ID is invalid');
  }
  if (!Number.isSafeInteger(normalizedHop) || Number(normalizedHop) < 0 || Number(normalizedHop) > 2) {
    throw new Error('CatsLog Skill route hop is invalid');
  }
  if (normalizedEdge && !isSafeCatsLogOpaqueIdentifier(normalizedEdge, 256)) {
    throw new Error('CatsLog Skill route edge key is invalid');
  }
}

function normalizeSkillFeedback(
  value: CatscoSkillOutcomeFeedback | undefined,
): CatscoSkillOutcomeFeedback | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('CatsLog Skill feedback is invalid');
  const code = typeof value.code === 'string' ? value.code.trim().toLowerCase() : '';
  if (!SKILL_FEEDBACK_CODES.has(code)) throw new Error('CatsLog Skill feedback code is invalid');
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    throw new Error('CatsLog Skill feedback summary is invalid');
  }
  const summary = value.summary === undefined ? undefined : value.summary.trim();
  if (summary !== undefined && (Buffer.byteLength(summary, 'utf8') > 2 * 1024 || hasDisallowedControl(summary))) {
    throw new Error('CatsLog Skill feedback summary is invalid');
  }
  const tags = value.tags === undefined ? undefined : value.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > 8)) {
    throw new Error('CatsLog Skill feedback tags are invalid');
  }
  const normalizedTags: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags || []) {
    if (typeof raw !== 'string') throw new Error('CatsLog Skill feedback tag is invalid');
    const tag = raw.trim().toLowerCase();
    if (!tag || Buffer.byteLength(tag, 'utf8') > 64 || /\s/.test(tag) || hasDisallowedControl(tag) || seen.has(tag)) {
      throw new Error('CatsLog Skill feedback tag is invalid');
    }
    seen.add(tag);
    normalizedTags.push(tag);
  }
  normalizedTags.sort();
  return {
    code,
    ...(summary ? { summary } : {}),
    ...(normalizedTags.length ? { tags: normalizedTags } : {}),
  };
}

function validateMemoryNoteInput(input: CatscoMemoryNoteInput): void {
  if (!input || (input.kind !== 'episode' && input.kind !== 'fact')) {
    throw new Error('CatsLog Agent Memory note kind is invalid');
  }
  if (typeof input.content !== 'string' || !input.content.trim()) {
    throw new Error('CatsLog Agent Memory note content is invalid');
  }
  if (Buffer.byteLength(input.content.trim(), 'utf8') > 32 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.content)) {
    throw new Error('CatsLog Agent Memory note content is invalid');
  }
  validateOptionalNoteText(input.key, 256, 'key');
  validateOptionalNoteText(input.title, 512, 'title');
  if (input.includeContent !== undefined && typeof input.includeContent !== 'boolean') {
    throw new Error('CatsLog Agent Memory note include_content is invalid');
  }
  if (input.sourceRefs !== undefined) {
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 32) {
      throw new Error('CatsLog Agent Memory note source_refs are invalid');
    }
    const seen = new Set<string>();
    for (const raw of input.sourceRefs) {
      const ref = typeof raw === 'string' ? raw.trim() : '';
      if (!ref || Buffer.byteLength(ref, 'utf8') > 512 || hasDisallowedControl(ref)
        || ref.includes('..') || ref.includes('/') || ref.includes('\\')
        || !MEMORY_NOTE_SOURCE_REF_PATTERN.test(ref) || seen.has(ref)) {
        throw new Error('CatsLog Agent Memory note source_refs are invalid');
      }
      seen.add(ref);
    }
  }
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error('CatsLog Agent Memory note confidence is invalid');
  }
  if (input.validFrom !== undefined) validateNoteTime(input.validFrom, 'valid_from');
  if (input.validTo !== undefined) validateNoteTime(input.validTo, 'valid_to');
  if (input.supersedesId !== undefined && !isSafeCatsLogOpaqueIdentifier(input.supersedesId, 512)) {
    throw new Error('CatsLog Agent Memory note supersedes_id is invalid');
  }
  if (input.requestId !== undefined && (typeof input.requestId !== 'string'
    || Buffer.byteLength(input.requestId.trim(), 'utf8') > 256 || hasDisallowedControl(input.requestId))) {
    throw new Error('CatsLog Agent Memory note request_id is invalid');
  }
  if (input.validFrom !== undefined && input.validTo !== undefined
    && typeof input.validFrom === 'string' && typeof input.validTo === 'string'
    && Date.parse(input.validFrom.trim()) >= Date.parse(input.validTo.trim())) {
    throw new Error('CatsLog Agent Memory note validity range is invalid');
  }
}

function validateOptionalNoteText(value: string | undefined, maxBytes: number, name: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || Buffer.byteLength(value.trim(), 'utf8') > maxBytes || hasDisallowedControl(value)) {
    throw new Error(`CatsLog Agent Memory note ${name} is invalid`);
  }
}

function validateNoteTime(value: string, name: string): void {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    || !Number.isFinite(Date.parse(text))) {
    throw new Error(`CatsLog Agent Memory note ${name} is invalid`);
  }
}

function hasDisallowedControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

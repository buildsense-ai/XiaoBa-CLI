import { loadSkillHubConfig, SkillHubConfig } from './config';
import { SkillHubSessionStore } from './session-store';
import type {
  SkillHubAuthState,
  SkillHubDeveloperDashboard,
  SkillHubRegistryEntry,
  SkillHubSearchResponse,
  SkillHubSkillDetailResponse,
  SkillHubTrustResponse,
} from './types';

export interface SkillHubClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  sessionScope?: 'persistent' | 'memory';
}

export interface SkillHubRegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export interface SkillHubLoginInput {
  email: string;
  password: string;
}

export interface SkillHubCatsCoExchangeInput {
  token: string;
  baseUrl: string;
  user?: {
    uid?: string;
    username?: string;
    displayName?: string;
  };
}

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_VALIDATION_ISSUES = 50;

export class SkillHubClient {
  readonly config: SkillHubConfig;
  private readonly sessionStore: SkillHubSessionStore;
  private readonly timeoutMs: number;

  constructor(options: SkillHubClientOptions = {}) {
    this.config = loadSkillHubConfig({ baseUrl: options.baseUrl });
    this.sessionStore = options.sessionScope === 'memory'
      ? SkillHubSessionStore.memory(this.config)
      : new SkillHubSessionStore(this.config);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async status(): Promise<SkillHubAuthState> {
    try {
      const me = await this.request<any>('GET', '/api/auth/me');
      return {
        authenticated: true,
        baseUrl: this.config.baseUrl,
        user: me.user,
        roles: me.roles || [],
        permissions: me.permissions || [],
        developerProfile: me.developerProfile,
      };
    } catch (error: any) {
      if (error?.status === 401) {
        return {
          authenticated: false,
          baseUrl: this.config.baseUrl,
          roles: [],
          permissions: [],
        };
      }
      throw error;
    }
  }

  async register(input: SkillHubRegisterInput): Promise<SkillHubAuthState> {
    await this.request('POST', '/api/auth/register', input);
    return this.status();
  }

  async login(input: SkillHubLoginInput): Promise<SkillHubAuthState> {
    await this.request('POST', '/api/auth/login', input);
    return this.status();
  }

  async loginWithCatsCo(input: SkillHubCatsCoExchangeInput): Promise<SkillHubAuthState> {
    const exchange = await this.request<any>('POST', '/api/auth/catsco-exchange', input);
    const auth = await this.status();
    return {
      ...auth,
      catsCo: exchange?.catsCo,
    };
  }

  async logout(): Promise<{ ok: true }> {
    await this.request('POST', '/api/auth/logout', {});
    this.sessionStore.clear();
    return { ok: true };
  }

  async searchSkills(query = '', options: { category?: string; agentVersion?: string; platform?: string } = {}): Promise<SkillHubSearchResponse> {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (options.category) params.set('category', options.category);
    if (options.agentVersion) params.set('agent_version', options.agentVersion);
    if (options.platform) params.set('platform', options.platform);
    const suffix = params.toString() ? `?${params}` : '';
    return this.request<SkillHubSearchResponse>('GET', `/api/skills${suffix}`);
  }

  async getSkill(skillId: string): Promise<SkillHubSkillDetailResponse> {
    return this.request<SkillHubSkillDetailResponse>('GET', `/api/skills/${encodeSkillIdPath(skillId)}`);
  }

  async getVersion(skillId: string, version: string): Promise<SkillHubSkillDetailResponse> {
    return this.request<SkillHubSkillDetailResponse>(
      'GET',
      `/api/skills/${encodeSkillIdPath(skillId)}/versions/${encodeURIComponent(version)}`,
    );
  }

  async getPresentation(skillId: string, version: string): Promise<any> {
    const query = new URLSearchParams({ skillId, version });
    return this.request('GET', `/api/skill-presentations?${query}`);
  }

  async getPresentationDraft(skillId: string, version: string): Promise<any> {
    const query = new URLSearchParams({ skillId, version });
    return this.request('GET', `/api/skill-presentations/draft?${query}`);
  }

  async savePresentationDraft(input: Record<string, unknown>): Promise<any> {
    return this.request('PUT', '/api/skill-presentations/draft', input);
  }

  async publishPresentation(input: Record<string, unknown>): Promise<any> {
    return this.request('POST', '/api/skill-presentations/publish', input);
  }

  async getTrust(): Promise<SkillHubTrustResponse> {
    return this.request<SkillHubTrustResponse>('GET', '/api/trust/public-keys');
  }

  async getCatsCoShareTargets(
    token: string,
    kind: 'friends' | 'search',
    query = '',
  ): Promise<{ users: Array<{ uid: string; username: string; displayName: string }> }> {
    const accessToken = String(token || '').trim();
    if (!accessToken) {
      const error: any = new Error('CatsCo login is required before loading Skill share targets.');
      error.status = 401;
      error.code = 'skillhub.catsco_login_required';
      throw error;
    }
    const path = kind === 'friends'
      ? '/api/catsco/share-targets/friends'
      : `/api/catsco/share-targets/search?q=${encodeURIComponent(String(query || '').trim())}`;
    const response = await this.request<any>(
      'GET',
      path,
      undefined,
      { 'X-CatsCo-Access-Token': accessToken },
    );
    const users = Array.isArray(response?.users) ? response.users : [];
    return {
      users: users.map((user: any) => ({
        uid: String(user?.uid ?? '').trim(),
        username: String(user?.username ?? '').trim(),
        displayName: String(user?.displayName ?? '').trim(),
      })).filter((user: any) => user.uid && user.username && user.displayName),
    };
  }

  async downloadPackage(entry: SkillHubRegistryEntry): Promise<Buffer> {
    const path = `/api/skills/${encodeSkillIdPath(entry.skillId)}/versions/${encodeURIComponent(entry.latestVersion)}/download`;
    const response = await this.fetchRaw('GET', path);
    return readResponseBytes(response, MAX_PACKAGE_RESPONSE_BYTES, this.timeoutMs, this.config.baseUrl);
  }

  async getDeveloperDashboard(): Promise<SkillHubDeveloperDashboard> {
    const status = await this.status();
    if (!status.authenticated) {
      return {
        authenticated: false,
        roles: [],
        permissions: [],
        submissions: [],
      };
    }
    const packageVersionsResult = await this.request<any>('GET', '/api/me/skill-versions')
      .catch(error => ({ error, packageVersions: [], skillVersions: [] }));
    return {
      ...status,
      authenticated: true,
      application: null,
      submissions: [],
      packageVersions: packageVersionsResult?.skillVersions || packageVersionsResult?.packageVersions || [],
    };
  }

  async applyDeveloper(input: any): Promise<any> {
    return this.getDeveloperDashboard();
  }

  async createManifestDraft(input: any): Promise<any> {
    return this.request('POST', '/api/developer/manifest-drafts', input);
  }

  async createSubmission(input: any): Promise<any> {
    return this.quickShare(input);
  }

  async quickShare(input: any): Promise<any> {
    return this.request('POST', '/api/skills/share', {
      ...input,
      quickShare: true,
    });
  }

  async yankOwnPackageVersion(packageVersionId: string, reason = ''): Promise<any> {
    return this.request(
      'POST',
      `/api/me/skill-versions/${encodeURIComponent(packageVersionId)}/yank`,
      { reason },
    );
  }

  async restoreOwnPackageVersion(packageVersionId: string): Promise<any> {
    return this.request(
      'POST',
      `/api/me/skill-versions/${encodeURIComponent(packageVersionId)}/restore`,
      {},
    );
  }

  async deleteOwnPackageVersion(packageVersionId: string): Promise<any> {
    return this.request(
      'DELETE',
      `/api/me/skill-versions/${encodeURIComponent(packageVersionId)}`,
    );
  }

  private async request<T>(method: string, apiPath: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const response = await this.fetchRaw(method, apiPath, body, extraHeaders);
    const bytes = await readResponseBytes(
      response,
      MAX_JSON_RESPONSE_BYTES,
      this.timeoutMs,
      this.config.baseUrl,
    );
    if (bytes.length === 0) return {} as T;
    try {
      return JSON.parse(bytes.toString('utf8')) as T;
    } catch {
      throw responseError(
        'SkillHub 返回了无法解析的响应。',
        502,
        'skillhub.invalid_response',
        this.config.baseUrl,
      );
    }
  }

  private async fetchRaw(method: string, apiPath: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = this.sessionStore.getCookieHeader(this.config.baseUrl);
    if (cookie) headers.Cookie = cookie;
    Object.assign(headers, extraHeaders);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error: any) {
      throw createSkillHubConnectionError(error, this.config.baseUrl);
    } finally {
      clearTimeout(timer);
    }

    this.sessionStore.storeSetCookieHeaders(this.config.baseUrl, response.headers);

    if (!response.ok) {
      const bytes = await readResponseBytes(
        response,
        MAX_ERROR_RESPONSE_BYTES,
        this.timeoutMs,
        this.config.baseUrl,
      );
      let message = `SkillHub request failed: HTTP ${response.status}`;
      let code = 'skillhub.request_failed';
      let validation: Record<string, unknown> | undefined;
      if (bytes.length > 0) {
        try {
          const parsed = JSON.parse(bytes.toString('utf8'));
          message = safeUpstreamMessage(
            parsed?.error?.message || parsed?.message || parsed?.error,
            message,
          );
          code = safeUpstreamCode(parsed?.error?.code || parsed?.code, code);
          if (code === 'skillhub.publish_validation_failed') {
            validation = safeUpstreamValidation(parsed?.error?.validation);
          }
        } catch {
          // Never expose arbitrary upstream text to the Dashboard.
        }
      }
      const error = withStatus(new Error(message), response.status);
      (error as any).code = code;
      if (validation) (error as any).validation = validation;
      throw error;
    }

    return response;
  }
}

function encodeSkillIdPath(skillId: string): string {
  return String(skillId || '')
    .split('/')
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/');
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  baseUrl: string,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw responseError(
      'SkillHub 返回的数据超过大小限制。',
      502,
      'skillhub.response_too_large',
      baseUrl,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel('SkillHub response timeout');
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel('SkillHub response too large').catch(() => undefined);
        throw responseError(
          'SkillHub 返回的数据超过大小限制。',
          502,
          'skillhub.response_too_large',
          baseUrl,
        );
      }
      chunks.push(chunk);
    }
    if (timedOut) {
      throw createSkillHubConnectionError({ name: 'AbortError' }, baseUrl);
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error: any) {
    if (error?.code?.startsWith?.('skillhub.')) throw error;
    if (timedOut) throw createSkillHubConnectionError({ name: 'AbortError' }, baseUrl);
    throw createSkillHubConnectionError(error, baseUrl);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function responseError(message: string, status: number, code: string, baseUrl: string): Error {
  const error = withStatus(new Error(message), status);
  (error as any).code = code;
  (error as any).details = { target: safeOrigin(baseUrl) };
  return error;
}

function safeUpstreamMessage(value: unknown, fallback: string): string {
  const message = typeof value === 'string' ? value.trim() : '';
  return message && message.length <= 500 ? message : fallback;
}

function safeUpstreamCode(value: unknown, fallback: string): string {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._-]{1,100}$/.test(code) ? code : fallback;
}

function safeUpstreamValidation(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const report = value as Record<string, any>;
  if (report.schemaVersion !== '1' || report.outcome !== 'rejected'
    || !['complete', 'partial'].includes(report.coverage)
    || typeof report.reportId !== 'string' || !/^[a-f0-9-]{36}$/i.test(report.reportId)
    || !Array.isArray(report.issues) || report.issues.length > MAX_VALIDATION_ISSUES) return undefined;
  const issues = report.issues.map((item: any) => {
    if (!item || typeof item !== 'object' || typeof item.code !== 'string'
      || !/^[a-z0-9._-]{1,100}$/i.test(item.code)
      || typeof item.message !== 'string' || item.message.length > 500
      || !['format', 'compatibility', 'package_safety'].includes(item.category)
      || !['automatic', 'confirmation_required', 'manual', 'none'].includes(item.repairPolicy)
      || typeof item.blocking !== 'boolean') return null;
    const location = item.location && typeof item.location === 'object' && !Array.isArray(item.location)
      ? item.location : {};
    return {
      code: item.code,
      category: item.category,
      blocking: item.blocking,
      repairPolicy: item.repairPolicy,
      message: item.message,
      location: {
        ...(Number.isSafeInteger(location.entryIndex) && location.entryIndex >= 0 ? { entryIndex: location.entryIndex } : {}),
        ...(['SKILL.md', 'skill.json', 'README.md'].includes(location.relativePath) ? { relativePath: location.relativePath } : {}),
        ...(typeof location.field === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(location.field) ? { field: location.field } : {})
      }
    };
  });
  if (issues.some((item: unknown) => item === null)) return undefined;
  return {
    schemaVersion: '1',
    ruleVersion: typeof report.ruleVersion === 'string' && report.ruleVersion.length <= 80 ? report.ruleVersion : '',
    reportId: report.reportId,
    outcome: 'rejected',
    coverage: report.coverage,
    nextAction: typeof report.nextAction === 'string' && report.nextAction.length <= 40 ? report.nextAction : 'review_report',
    issues
  };
}

function withStatus(error: Error, status: number): Error {
  (error as any).status = status;
  return error;
}

export function createSkillHubConnectionError(error: unknown, baseUrl: string): Error {
  const input = error as any;
  const causeCode = firstErrorCode(input);
  const target = safeOrigin(baseUrl);
  const message = String(input?.cause?.message || input?.message || '').toLowerCase();

  if (input?.name === 'AbortError' || causeCode === 'ABORT_ERR') {
    return connectionError(`连接 SkillHub 超时（${target}），请稍后重试。`, 504, 'skillhub.timeout', target, causeCode);
  }
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return connectionError(`无法解析 SkillHub 地址（${target}）。`, 502, 'skillhub.dns_failed', target, causeCode);
  }
  if (isTlsFailure(causeCode, message)) {
    return connectionError(`SkillHub TLS 连接失败（${target}）。`, 502, 'skillhub.tls_failed', target, causeCode);
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(causeCode)) {
    return connectionError(`SkillHub 网络连接失败（${target}）。`, 502, 'skillhub.connection_failed', target, causeCode);
  }
  return connectionError(`无法连接 SkillHub（${target}）。`, 502, 'skillhub.unavailable', target, causeCode);
}

function connectionError(
  message: string,
  status: number,
  code: string,
  target: string,
  causeCode: string,
): Error {
  const error = withStatus(new Error(message), status);
  (error as any).code = code;
  (error as any).details = {
    target,
    ...(causeCode ? { causeCode } : {}),
  };
  return error;
}

function firstErrorCode(error: any): string {
  for (const candidate of [error?.cause?.code, error?.code, error?.cause?.cause?.code]) {
    const value = String(candidate || '').trim().toUpperCase();
    if (value) return value;
  }
  return '';
}

function safeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return 'SkillHub';
  }
}

function isTlsFailure(code: string, message: string): boolean {
  return code.startsWith('ERR_TLS_')
    || code.startsWith('ERR_SSL_')
    || code.includes('CERT')
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || message.includes('tls')
    || message.includes('ssl')
    || message.includes('certificate');
}

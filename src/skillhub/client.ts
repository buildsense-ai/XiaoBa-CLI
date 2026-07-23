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

const MAX_SKILLHUB_PACKAGE_BYTES = 32 * 1024 * 1024;

export class SkillHubClient {
  readonly config: SkillHubConfig;
  private readonly sessionStore: SkillHubSessionStore;
  private readonly timeoutMs: number;

  constructor(options: SkillHubClientOptions = {}) {
    this.config = loadSkillHubConfig({ baseUrl: options.baseUrl });
    this.sessionStore = new SkillHubSessionStore(this.config);
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
    await this.request('POST', '/api/auth/catsco-exchange', input);
    return this.status();
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

  async getTrust(): Promise<SkillHubTrustResponse> {
    return this.request<SkillHubTrustResponse>('GET', '/api/trust/public-keys');
  }

  async downloadPackage(entry: SkillHubRegistryEntry): Promise<Buffer> {
    const path = `/api/skills/${encodeSkillIdPath(entry.skillId)}/versions/${encodeURIComponent(entry.latestVersion)}/download`;
    const response = await this.fetchRaw('GET', path);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SKILLHUB_PACKAGE_BYTES) {
      throw packageTooLarge();
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SKILLHUB_PACKAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw packageTooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
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

  private async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const response = await this.fetchRaw(method, apiPath, body);
    const text = await response.text();
    return text ? JSON.parse(text) as T : {} as T;
  }

  private async fetchRaw(method: string, apiPath: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = this.sessionStore.getCookieHeader(this.config.baseUrl);
    if (cookie) headers.Cookie = cookie;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw withStatus(new Error('连接 SkillHub 超时，请稍后重试。'), 408);
      }
      throw withStatus(new Error(`无法连接 SkillHub：${error?.message || String(error)}`), 502);
    } finally {
      clearTimeout(timer);
    }

    this.sessionStore.storeSetCookieHeaders(this.config.baseUrl, response.headers);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = `SkillHub request failed: HTTP ${response.status}`;
      let code = 'skillhub.request_failed';
      if (text) {
        try {
          const parsed = JSON.parse(text);
          message = parsed?.error?.message || parsed?.message || parsed?.error || message;
          code = parsed?.error?.code || parsed?.code || code;
        } catch {
          message = text.slice(0, 500);
        }
      }
      const error = withStatus(new Error(message), response.status);
      (error as any).code = code;
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

function withStatus(error: Error, status: number): Error {
  (error as any).status = status;
  return error;
}

function packageTooLarge(): Error {
  const error = withStatus(
    new Error(`SkillHub package exceeds ${MAX_SKILLHUB_PACKAGE_BYTES} bytes.`),
    502,
  );
  (error as any).code = 'skillhub.package_too_large';
  return error;
}

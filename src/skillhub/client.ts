import * as crypto from 'node:crypto';
import { loadSkillHubConfig, SkillHubConfig } from './config';
import { SkillHubSessionStore } from './session-store';
import type {
  SkillHubAuthState,
  SkillHubBotCredential,
  SkillHubDeveloperDashboard,
  SkillHubPrivateSkillResponse,
  SkillHubPrivateUpsertInput,
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
const MAX_SKILLHUB_JSON_BYTES = 2 * 1024 * 1024;

export class SkillHubClient {
  readonly config: SkillHubConfig;
  private readonly sessionStore: SkillHubSessionStore;
  private readonly timeoutMs: number;

  constructor(options: SkillHubClientOptions = {}) {
    this.config = loadSkillHubConfig({ baseUrl: options.baseUrl });
    assertSafeSkillHubBaseUrl(this.config.baseUrl);
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
    const normalizedSkillId = validateSkillId(skillId);
    return this.request<SkillHubSkillDetailResponse>(
      'GET',
      `/api/skills/${encodeSkillIdPath(normalizedSkillId)}`,
    );
  }

  async getVersion(
    skillId: string,
    version: string,
    credential?: SkillHubBotCredential,
  ): Promise<SkillHubSkillDetailResponse> {
    const ref = validateSkillRef(skillId, version);
    return this.request<SkillHubSkillDetailResponse>(
      'GET',
      `/api/skills/${encodeSkillIdPath(ref.skillId)}/versions/${encodeURIComponent(ref.version)}`,
      undefined,
      credential,
    );
  }

  async upsertPrivateSkill(
    input: SkillHubPrivateUpsertInput,
    credential: SkillHubBotCredential,
  ): Promise<SkillHubPrivateSkillResponse> {
    const botId = validatePathSegment(input?.botId, 'botId');
    const workspaceId = validatePathSegment(input?.workspaceId, 'workspaceId');
    const localSkillId = validatePathSegment(input?.localSkillId, 'localSkillId');
    const contentHash = validateSha256(input?.contentHash, 'contentHash');
    const name = validateText(input?.name, 'name');
    const installName = validatePathSegment(input?.installName, 'installName');
    const files = validatePrivateSourceFiles(input?.files);
    const normalizedCredential = validateBotCredential(credential, botId);
    const forkedFrom = input.forkedFrom
      ? validateSkillRef(input.forkedFrom.skillId, input.forkedFrom.version)
      : undefined;
    return this.request<SkillHubPrivateSkillResponse>(
      'PUT',
      `/api/bots/${encodeURIComponent(botId)}/private-skills/${encodeURIComponent(localSkillId)}/versions/${contentHash}`,
      {
        botId,
        workspaceId,
        localSkillId,
        contentHash,
        name,
        installName,
        ...(forkedFrom ? { forkedFrom } : {}),
        files,
      },
      normalizedCredential,
    );
  }

  async getTrust(credential?: SkillHubBotCredential): Promise<SkillHubTrustResponse> {
    return this.request<SkillHubTrustResponse>(
      'GET',
      '/api/trust/public-keys',
      undefined,
      credential,
    );
  }

  async downloadPackage(
    entry: SkillHubRegistryEntry,
    credential?: SkillHubBotCredential,
  ): Promise<Buffer> {
    const ref = validateSkillRef(entry?.skillId, entry?.latestVersion);
    const apiPath = `/api/skills/${encodeSkillIdPath(ref.skillId)}/versions/${encodeURIComponent(ref.version)}/download`;
    const response = await this.fetchRaw('GET', apiPath, undefined, credential);
    return readBoundedResponseBytes(
      response,
      MAX_SKILLHUB_PACKAGE_BYTES,
      this.timeoutMs,
      packageTooLarge,
    );
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

  private async request<T>(
    method: string,
    apiPath: string,
    body?: unknown,
    credential?: SkillHubBotCredential,
  ): Promise<T> {
    const response = await this.fetchRaw(method, apiPath, body, credential);
    const text = await readBoundedResponseText(
      response,
      MAX_SKILLHUB_JSON_BYTES,
      this.timeoutMs,
    );
    return text ? JSON.parse(text) as T : {} as T;
  }

  private async fetchRaw(
    method: string,
    apiPath: string,
    body?: unknown,
    credential?: SkillHubBotCredential,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const botCredential = credential && validateBotCredential(credential);
    if (botCredential) {
      headers.Authorization = `ApiKey ${botCredential.apiKey}`;
      headers['X-CatsCo-Bot-Id'] = botCredential.botId;
    } else {
      const cookie = this.sessionStore.getCookieHeader(this.config.baseUrl);
      if (cookie) headers.Cookie = cookie;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: botCredential ? 'error' : 'follow',
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw withStatus(new Error('连接 SkillHub 超时，请稍后重试。'), 408);
      }
      throw withStatus(new Error(`无法连接 SkillHub：${error?.message || String(error)}`), 502);
    } finally {
      clearTimeout(timer);
    }

    if (!botCredential) {
      this.sessionStore.storeSetCookieHeaders(this.config.baseUrl, response.headers);
    }

    if (!response.ok) {
      const text = await readBoundedResponseText(
        response,
        MAX_SKILLHUB_JSON_BYTES,
        this.timeoutMs,
      )
        .catch(error => {
          if ((error as any)?.code === 'skillhub.response_too_large') throw error;
          return '';
        });
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
  return skillId
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
}

function validateSkillRef(skillIdValue: unknown, versionValue: unknown): {
  skillId: string;
  version: string;
} {
  const skillId = validateSkillId(skillIdValue);
  const version = validatePathSegment(versionValue, 'version');
  return { skillId, version };
}

function validateSkillId(value: unknown): string {
  const skillId = String(value ?? '').trim();
  if (
    !skillId
    || Buffer.byteLength(skillId, 'utf8') > 512
    || skillId.split('/').length > 32
    || skillId.includes('\\')
    || skillId.includes('?')
    || skillId.includes('#')
    || skillId.split('/').some(part => !part || part === '.' || part === '..')
    || /[\u0000-\u001f\u007f]/.test(skillId)
  ) {
    throw invalidReference('skillId');
  }
  return skillId;
}

function validatePathSegment(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (
    !text
    || Buffer.byteLength(text, 'utf8') > 512
    || text === '.'
    || text === '..'
    || /[\/\\?#\u0000-\u001f\u007f]/.test(text)
  ) {
    throw invalidReference(field);
  }
  return text;
}

function validateText(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (
    !text
    || Buffer.byteLength(text, 'utf8') > 1024
    || /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw invalidReference(field);
  }
  return text;
}

function validatePrivateSourceFiles(
  value: SkillHubPrivateUpsertInput['files'] | undefined,
): SkillHubPrivateUpsertInput['files'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw invalidReference('files');
  }
  let total = 0;
  const seen = new Set<string>();
  const normalized = value.map(file => {
    const filePath = String(file?.path ?? '').normalize('NFC');
    const segments = filePath.split('/');
    if (
      !filePath
      || Buffer.byteLength(filePath, 'utf8') > 512
      || filePath.includes('\\')
      || filePath.startsWith('/')
      || segments.length > 24
      || segments.some(segment => (
        !segment
        || segment === '.'
        || segment === '..'
        || /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment)
        || /[ .]$/u.test(segment)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
      ))
    ) {
      throw invalidReference('files.path');
    }
    const portable = filePath.toLocaleLowerCase('en-US');
    if (seen.has(portable)) throw invalidReference('files.path');
    seen.add(portable);
    const contentBase64 = String(file?.contentBase64 ?? '');
    if (
      contentBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(contentBase64)
      || Buffer.from(contentBase64, 'base64').toString('base64') !== contentBase64
    ) {
      throw invalidReference('files.contentBase64');
    }
    const content = Buffer.from(contentBase64, 'base64');
    if (
      !Number.isSafeInteger(file?.size)
      || file.size !== content.length
      || content.length > 8 * 1024 * 1024
      || validateSha256(file?.sha256, 'files.sha256')
        !== cryptoSha256(content)
    ) {
      throw invalidReference('files');
    }
    total += content.length;
    if (total > 20 * 1024 * 1024) throw invalidReference('files');
    return {
      path: filePath,
      size: content.length,
      sha256: cryptoSha256(content),
      contentBase64,
    };
  });
  if (normalized.filter(file => file.path === 'SKILL.md').length !== 1) {
    throw invalidReference('files.SKILL.md');
  }
  return normalized;
}

function cryptoSha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateSha256(value: unknown, field: string): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw invalidReference(field);
  return text;
}

function validateBotCredential(
  value: SkillHubBotCredential | undefined,
  expectedBotId?: string,
): SkillHubBotCredential {
  const botId = validatePathSegment(value?.botId, 'credential.botId');
  const apiKey = String(value?.apiKey ?? '').trim();
  if (!apiKey || Buffer.byteLength(apiKey, 'utf8') > 8192 || /[\r\n]/.test(apiKey)) {
    throw invalidReference('credential.apiKey');
  }
  if (expectedBotId && botId !== expectedBotId) {
    throw invalidReference('credential.botId');
  }
  return { botId, apiKey };
}

function invalidReference(field: string): Error {
  const error = withStatus(new Error(`Invalid SkillHub ${field}.`), 400);
  (error as any).code = 'skillhub.invalid_reference';
  return error;
}

function assertSafeSkillHubBaseUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error('SkillHub base URL must not contain credentials.');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return;
  throw new Error('SkillHub requires HTTPS except on a loopback address.');
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '::1') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  return (await readBoundedResponseBytes(
    response,
    maxBytes,
    timeoutMs,
    () => responseTooLarge(maxBytes),
  )).toString('utf8');
}

async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await readBeforeDeadline(reader, deadline);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const { done, value } = result;
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw responseTimeout();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(responseTimeout()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function responseTooLarge(maxBytes: number): Error {
  const error = withStatus(
    new Error(`SkillHub JSON response exceeds ${maxBytes} bytes.`),
    502,
  );
  (error as any).code = 'skillhub.response_too_large';
  return error;
}

function responseTimeout(): Error {
  const error = withStatus(new Error('SkillHub response body timed out.'), 408);
  (error as any).code = 'skillhub.response_timeout';
  return error;
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

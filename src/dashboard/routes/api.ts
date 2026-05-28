import { Router } from 'express';
import { SkillManager } from '../../skills/skill-manager';
import type { Skill } from '../../types/skill';
import { ConfigManager } from '../../utils/config';
import { ServiceManager } from '../service-manager';
import type { UpdateController } from '../server';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PathResolver } from '../../utils/path-resolver';
import { APP_VERSION } from '../../version';
import { createRuntimeConfigSnapshot } from '../../runtime/runtime-config-snapshot';
import {
  getDashboardReadiness,
  getServicePreflight,
} from '../readiness';
import {
  getDashboardSettings,
  isSensitiveEnvKey,
  updateDashboardSettings,
  writeDashboardEnvUpdates,
} from '../settings';
import {
  RuntimeProfileEditInput,
  hasRuntimeProfileRollback,
  previewRuntimeProfileEdit,
  rollbackRuntimeProfileEdit,
  saveRuntimeProfileEdit,
} from '../../runtime/runtime-profile-editor';
import { inferCatsUploadType, uploadCatsLocalFile } from '../../catscompany/upload';
import { consumeLocalFileGrant, validateLocalFileGrant } from '../local-file-grants';
import { registerSkillHubRoutes } from './skillhub';
// import { ReportGenerator } from '../../utils/report-generator';
// import { LogUploader } from '../../utils/log-uploader';

const DEFAULT_CATSCO_HTTP_BASE_URL = 'https://app.catsco.cc';
const DEFAULT_CATSCO_WS_URL = 'wss://app.catsco.cc/v0/channels';
const BUNDLED_SKILL_MARKER = '.xiaoba-bundled-skill.json';
const SYSTEM_SKILL_DIRS = new Set<string>();

type SkillSource = 'system' | 'bundled' | 'user';

interface SkillManagementInfo {
  source: SkillSource;
  protected: boolean;
  canDisable: boolean;
  canDelete: boolean;
}

interface CatsAuthState {
  token?: string;
  uid?: string;
  username?: string;
  displayName?: string;
  httpBaseUrl: string;
  serverUrl: string;
  botUid?: string;
  apiKey?: string;
}

interface CatsRequestOptions {
  timeoutMs?: number;
}

type RelayModelProtocol = 'anthropic' | 'openai';

function normalizeBaseUrl(value: unknown, fallback: string): string {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return text || fallback;
}

function p2pTopicId(uid1: string | number, uid2: string | number): string {
  const a = Number(uid1);
  const b = Number(uid2);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const [left, right] = a < b ? [a, b] : [b, a];
  return `p2p_${left}_${right}`;
}

function httpError(message: string, status: number): Error {
  const error = new Error(message);
  (error as any).status = status;
  return error;
}

function assertCurrentCatsTopic(state: CatsAuthState, topicId: string): void {
  const expectedTopic = state.uid && state.botUid ? p2pTopicId(state.uid, state.botUid) : '';
  if (!expectedTopic) {
    throw httpError('CatsCo account binding is incomplete', 409);
  }
  if (topicId !== expectedTopic) {
    throw httpError('topic does not belong to the current CatsCo account', 403);
  }
}

function hostLabel(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function createCatsNetworkError(error: any, httpBaseUrl: string): Error {
  const code = String(error?.cause?.code || error?.code || '').trim();
  const causeMessage = String(error?.cause?.message || error?.message || '').trim();
  const host = hostLabel(httpBaseUrl);
  let reason = `无法连接 CatsCo/CatsCompany 服务 ${host}`;

  if (/ENOTFOUND|EAI_AGAIN/i.test(code) || /getaddrinfo|dns/i.test(causeMessage)) {
    reason = `无法解析 CatsCo/CatsCompany 服务域名 ${host}`;
  } else if (/ECONNREFUSED/i.test(code)) {
    reason = `CatsCo/CatsCompany 服务 ${host} 拒绝连接`;
  } else if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code) || /timed?out|timeout/i.test(causeMessage)) {
    reason = `连接 CatsCo/CatsCompany 服务 ${host} 超时`;
  } else if (/CERT|TLS|SSL/i.test(code) || /certificate|tls|ssl/i.test(causeMessage)) {
    reason = `CatsCo/CatsCompany 服务 ${host} 的 HTTPS 证书校验失败`;
  }

  const wrapped = new Error(causeMessage ? `${reason}：${causeMessage}` : reason);
  (wrapped as any).status = 502;
  (wrapped as any).data = {
    reason: code || 'FETCH_FAILED',
    host,
  };
  return wrapped;
}

function readEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function writeEnvUpdates(updates: Record<string, string | undefined>): string[] {
  const envPath = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const updatedKeys: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const escaped = value.replace(/\n/g, '\\n');
    const line = `${key}=${escaped}`;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`;
    }
    process.env[key] = value;
    updatedKeys.push(key);
  }

  fs.writeFileSync(envPath, content);
  return updatedKeys;
}

function removeEnvKeys(keys: string[]): string[] {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return [];
  let content = fs.readFileSync(envPath, 'utf-8');
  const removed: string[] = [];

  for (const key of keys) {
    const regex = new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, '');
      delete process.env[key];
      removed.push(key);
    }
  }

  fs.writeFileSync(envPath, content);
  return removed;
}

export function getCatsAuthState(overrides: Record<string, unknown> = {}): CatsAuthState {
  const env = readEnvFile();
  return {
    token: firstNonEmpty(
      overrides.token,
      process.env.CATSCO_USER_TOKEN,
      env.CATSCO_USER_TOKEN,
      process.env.CATSCOMPANY_USER_TOKEN,
      env.CATSCOMPANY_USER_TOKEN,
    ),
    uid: firstNonEmpty(
      overrides.uid,
      process.env.CATSCO_USER_UID,
      env.CATSCO_USER_UID,
      process.env.CATSCOMPANY_USER_UID,
      env.CATSCOMPANY_USER_UID,
    ),
    username: firstNonEmpty(
      process.env.CATSCO_USER_NAME,
      env.CATSCO_USER_NAME,
      process.env.CATSCOMPANY_USER_NAME,
      env.CATSCOMPANY_USER_NAME,
    ),
    displayName: firstNonEmpty(
      process.env.CATSCO_USER_DISPLAY_NAME,
      env.CATSCO_USER_DISPLAY_NAME,
      process.env.CATSCOMPANY_USER_DISPLAY_NAME,
      env.CATSCOMPANY_USER_DISPLAY_NAME,
    ),
    httpBaseUrl: normalizeBaseUrl(
      firstNonEmpty(
        overrides.httpBaseUrl,
        process.env.CATSCO_HTTP_BASE_URL,
        env.CATSCO_HTTP_BASE_URL,
        process.env.CATSCOMPANY_HTTP_BASE_URL,
        env.CATSCOMPANY_HTTP_BASE_URL,
      ),
      DEFAULT_CATSCO_HTTP_BASE_URL,
    ),
    serverUrl: normalizeBaseUrl(
      firstNonEmpty(
        overrides.serverUrl,
        process.env.CATSCO_SERVER_URL,
        env.CATSCO_SERVER_URL,
        process.env.CATSCOMPANY_SERVER_URL,
        env.CATSCOMPANY_SERVER_URL,
      ),
      DEFAULT_CATSCO_WS_URL,
    ),
    botUid: firstNonEmpty(
      overrides.botUid,
      process.env.CATSCO_BOT_UID,
      env.CATSCO_BOT_UID,
      process.env.CATSCOMPANY_BOT_UID,
      env.CATSCOMPANY_BOT_UID,
    ),
    apiKey: firstNonEmpty(
      process.env.CATSCO_API_KEY,
      env.CATSCO_API_KEY,
      process.env.CATSCOMPANY_API_KEY,
      env.CATSCOMPANY_API_KEY,
    ),
  };
}

async function catsRequest(
  method: string,
  httpBaseUrl: string,
  apiPath: string,
  body?: unknown,
  token?: string,
  options: CatsRequestOptions = {},
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  let response: Response;

  try {
    response = await fetch(`${httpBaseUrl}${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`连接 CatsCo/CatsCompany 服务 ${hostLabel(httpBaseUrl)} 超时`);
      (timeoutError as any).status = 408;
      throw timeoutError;
    }
    throw createCatsNetworkError(error, httpBaseUrl);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const text = await response.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `CatsCo request failed: ${response.status}`;
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).data = data;
    throw error;
  }

  return data;
}

async function catsApiKeyRequest(
  method: string,
  httpBaseUrl: string,
  apiPath: string,
  apiKey: string,
  body?: unknown,
): Promise<any> {
  const response = await fetch(`${httpBaseUrl}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `CatsCo request failed: ${response.status}`;
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).data = data;
    throw error;
  }

  return data;
}

function normalizeRelayModelProtocol(value: unknown): RelayModelProtocol {
  const text = String(value || '').trim().toLowerCase();
  return text === 'openai' ? 'openai' : 'anthropic';
}

function relayProviderForProtocol(protocol: RelayModelProtocol): 'anthropic' | 'openai' {
  return protocol === 'openai' ? 'openai' : 'anthropic';
}

function relayEndpointForProtocol(config: any, protocol: RelayModelProtocol): string {
  const endpoints = Array.isArray(config?.endpoints) ? config.endpoints : [];
  const endpoint = endpoints.find((item: any) => {
    const label = String(item?.protocol || '').toLowerCase();
    return protocol === 'openai' ? label.includes('openai') : label.includes('anthropic');
  });
  const baseUrl = normalizeBaseUrl(config?.base_url, 'https://relay.catsco.cc');
  const fallback = protocol === 'openai' ? `${baseUrl}/v1` : `${baseUrl}/anthropic`;
  return normalizeBaseUrl(endpoint?.base_url, fallback);
}

function isCatsRelayApiBase(value: unknown): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    return new URL(text).hostname.toLowerCase() === 'relay.catsco.cc';
  } catch {
    return text.toLowerCase().includes('relay.catsco.cc');
  }
}

function sanitizeRelayKeyInfo(key: any): any {
  if (!key || typeof key !== 'object') return key || null;
  const safe: Record<string, unknown> = {};
  for (const field of [
    'id',
    'name',
    'prefix',
    'state',
    'created_at',
    'createdAt',
    'updated_at',
    'updatedAt',
    'revoked_at',
    'revokedAt',
    'last_used_at',
    'lastUsedAt',
  ]) {
    const value = key[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      safe[field] = value;
    }
  }
  return safe;
}

async function fetchCatsRelayConfig(state: CatsAuthState): Promise<any> {
  return catsRequest('GET', state.httpBaseUrl, '/api/relay/config', undefined, state.token);
}

async function fetchCatsRelayKey(state: CatsAuthState): Promise<any> {
  return catsRequest('GET', state.httpBaseUrl, '/api/relay/key', undefined, state.token);
}

async function ensureCatsRelayPlainKey(
  state: CatsAuthState,
  options: { rotateExisting?: boolean } = {},
): Promise<{ response: any; plainKey: string; created: boolean; rotated: boolean }> {
  const current = await fetchCatsRelayKey(state);
  const currentKey = current?.key;
  const active = currentKey && String(currentKey.state || 'active') === 'active';
  const currentPlainKey = String(currentKey?.key || '').trim();

  if (active && currentPlainKey) {
    return { response: current, plainKey: currentPlainKey, created: false, rotated: false };
  }

  const reusableLocalKey = active ? findReusableLocalRelayKey(currentKey) : undefined;
  if (reusableLocalKey) {
    return { response: current, plainKey: reusableLocalKey, created: false, rotated: false };
  }

  if (active && !options.rotateExisting) {
    throw httpError(
      '已有 CatsCo 中转 Key，但明文不会再次返回。请确认是否重新生成后再启用中转模型。',
      409,
    );
  }

  const next = active
    ? await catsRequest('POST', state.httpBaseUrl, '/api/relay/key/rotate', {}, state.token)
    : await catsRequest('POST', state.httpBaseUrl, '/api/relay/key', {
      name: state.displayName || state.username || (state.uid ? `CatsCo user ${state.uid}` : 'CatsCo desktop'),
    }, state.token);
  const plainKey = String(next?.key?.key || '').trim();
  if (!plainKey) {
    throw httpError('CatsCo 中转 Key 创建成功但没有返回明文，请在 CatsCompany 中转站页面复制。', 502);
  }

  return {
    response: next,
    plainKey,
    created: !active,
    rotated: active,
  };
}

function findReusableLocalRelayKey(currentKey: any): string | undefined {
  const fileEnv = readEnvFile();
  const currentConfig = ConfigManager.getConfigReadonly();
  const apiKey = firstNonEmpty(
    process.env.GAUZ_LLM_API_KEY,
    fileEnv.GAUZ_LLM_API_KEY,
    currentConfig.apiKey,
  );
  const apiBase = firstNonEmpty(
    process.env.GAUZ_LLM_API_BASE,
    fileEnv.GAUZ_LLM_API_BASE,
    currentConfig.apiUrl,
  );
  if (!apiKey || !isCatsRelayApiBase(apiBase)) {
    return undefined;
  }

  const prefix = String(currentKey?.prefix || '').trim();
  if (!prefix || !matchesRelayKeyPrefix(apiKey, prefix)) {
    return undefined;
  }

  return apiKey;
}

function matchesRelayKeyPrefix(apiKey: string, prefix: string): boolean {
  const marker = '...';
  const markerIndex = prefix.indexOf(marker);
  if (markerIndex >= 0) {
    const start = prefix.slice(0, markerIndex);
    const end = prefix.slice(markerIndex + marker.length);
    return (!start || apiKey.startsWith(start)) && (!end || apiKey.endsWith(end));
  }
  return apiKey.startsWith(prefix);
}

function sanitizeCatsErrorData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('key')
      || lower.includes('token')
      || lower.includes('secret')
      || lower.includes('authorization')
      || lower.includes('password')
    ) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function sanitizeCatsErrorMessage(value: unknown): string {
  return String(value || '请求失败')
    .replace(/cats_svc_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted-token]');
}

function catsErrorResponse(error: any): { status: number; body: Record<string, unknown> } {
  const body: Record<string, unknown> = { error: sanitizeCatsErrorMessage(error.message) };
  const data = sanitizeCatsErrorData(error.data);
  if (data) body.data = data;
  return { status: error.status || 500, body };
}

function restartCatsCompanyIfRunning(serviceManager: ServiceManager): {
  wasRunning: boolean;
  restartRequested: boolean;
  restartError?: string;
} {
  const getService = typeof (serviceManager as any).getService === 'function'
    ? serviceManager.getService.bind(serviceManager)
    : undefined;
  const restart = typeof (serviceManager as any).restart === 'function'
    ? serviceManager.restart.bind(serviceManager)
    : undefined;
  if (!getService || !restart) {
    return { wasRunning: false, restartRequested: false };
  }

  const service = getService('catscompany');
  if (service?.status !== 'running') {
    return { wasRunning: false, restartRequested: false };
  }

  try {
    restart('catscompany');
    return { wasRunning: true, restartRequested: true };
  } catch (error: any) {
    return {
      wasRunning: true,
      restartRequested: false,
      restartError: error?.message || String(error),
    };
  }
}

function persistCatsUserSession(state: CatsAuthState, login: any): void {
  writeEnvUpdates({
    CATSCO_HTTP_BASE_URL: state.httpBaseUrl,
    CATSCO_SERVER_URL: state.serverUrl,
    CATSCO_USER_TOKEN: login.token,
    CATSCO_USER_UID: String(login.uid || ''),
    CATSCO_USER_NAME: login.username || '',
    CATSCO_USER_DISPLAY_NAME: login.display_name || login.username || '',
    CATSCOMPANY_HTTP_BASE_URL: state.httpBaseUrl,
    CATSCOMPANY_SERVER_URL: state.serverUrl,
    CATSCOMPANY_USER_TOKEN: login.token,
    CATSCOMPANY_USER_UID: String(login.uid || ''),
    CATSCOMPANY_USER_NAME: login.username || '',
    CATSCOMPANY_USER_DISPLAY_NAME: login.display_name || login.username || '',
  });
}

export function createApiRouter(serviceManager: ServiceManager, updateController?: UpdateController): Router {
  const router = Router();
  registerSkillHubRoutes(router);

  // ==================== 总览 ====================

  
  router.get('/status', (_req, res) => {
    const config = ConfigManager.getConfigReadonly();
    const services = serviceManager.getAll();
    res.json({
      version: APP_VERSION,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      model: config.model,
      provider: config.provider,
      skillsPath: PathResolver.getSkillsPath(),
      services,
    });
  });

  router.get('/runtime/config', async (_req, res) => {
    try {
      res.json(await createRuntimeConfigSnapshot({
        config: ConfigManager.getConfigReadonly(),
      }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/readiness', async (_req, res) => {
    try {
      res.json(await getDashboardReadiness(serviceManager, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/runtime/profile/edit', (_req, res) => {
    try {
      const preview = previewRuntimeProfileEdit({}, { runtimeRoot: process.cwd() });
      res.json(sanitizeRuntimeProfileEditResponse({
        ...preview,
        rollbackAvailable: hasRuntimeProfileRollback({ runtimeRoot: process.cwd() }),
      }));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.post('/runtime/profile/preview', (req, res) => {
    try {
      const preview = previewRuntimeProfileEdit(req.body as RuntimeProfileEditInput, {
        runtimeRoot: process.cwd(),
      });
      res.json(sanitizeRuntimeProfileEditResponse({
        ...preview,
        rollbackAvailable: hasRuntimeProfileRollback({ runtimeRoot: process.cwd() }),
      }));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.put('/runtime/profile', (req, res) => {
    try {
      const result = saveRuntimeProfileEdit(req.body as RuntimeProfileEditInput, {
        runtimeRoot: process.cwd(),
      });
      res.json(sanitizeRuntimeProfileEditResponse(result));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.post('/runtime/profile/rollback', (_req, res) => {
    try {
      res.json(rollbackRuntimeProfileEdit({ runtimeRoot: process.cwd() }));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  const updaterUnavailable = () => ({
    enabled: false,
    stage: 'disabled',
    message: '当前环境不可用更新器',
  });

  router.get('/update/status', (_req, res) => {
    if (!updateController) {
      return res.json(updaterUnavailable());
    }
    try {
      return res.json(updateController.getStatus());
    } catch (e: any) {
      return res.status(500).json({
        ...updaterUnavailable(),
        stage: 'error',
        error: e?.message || String(e),
      });
    }
  });

  router.post('/update/check', async (_req, res) => {
    if (!updateController) {
      return res.json(updaterUnavailable());
    }
    try {
      const status = await updateController.checkForUpdates(true);
      return res.json(status);
    } catch (e: any) {
      return res.status(500).json({
        error: e?.message || String(e),
        reason: e?.reason || 'UPDATE_CHECK_FAILED',
      });
    }
  });

  router.post('/update/download', async (_req, res) => {
    if (!updateController) {
      return res.status(400).json({
        error: '当前环境不可用更新器',
        reason: 'UPDATER_UNAVAILABLE',
      });
    }
    try {
      const status = await updateController.downloadUpdate();
      return res.json(status);
    } catch (e: any) {
      return res.status(500).json({
        error: e?.message || String(e),
        reason: e?.reason || 'UPDATE_DOWNLOAD_FAILED',
      });
    }
  });

  router.post('/update/install', (_req, res) => {
    if (!updateController) {
      return res.status(400).json({
        error: '当前环境不可用更新器',
        reason: 'UPDATER_UNAVAILABLE',
      });
    }
    try {
      updateController.installUpdate();
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(500).json({
        error: e?.message || String(e),
        reason: e?.reason || 'UPDATE_INSTALL_FAILED',
      });
    }
  });

  // ==================== 服务管理 ====================

  router.get('/services', (_req, res) => {
    res.json(serviceManager.getAll());
  });

  router.post('/services/:name/preflight', (req, res) => {
    try {
      res.json(getServicePreflight(serviceManager, req.params.name, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      }));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/start', (req, res) => {
    try {
      const preflight = getServicePreflight(serviceManager, req.params.name, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      });
      if (preflight.status === 'blocked' && req.body?.force !== true) {
        return res.status(400).json({
          error: 'Service preflight blocked',
          preflight,
        });
      }
      res.json(serviceManager.start(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/stop', (req, res) => {
    try {
      res.json(serviceManager.stop(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/restart', (req, res) => {
    try {
      const preflight = getServicePreflight(serviceManager, req.params.name, {
        runtimeRoot: process.cwd(),
        config: ConfigManager.getConfigReadonly(),
      });
      if (preflight.status === 'blocked' && req.body?.force !== true) {
        return res.status(400).json({
          error: 'Service preflight blocked',
          preflight,
        });
      }
      res.json(serviceManager.restart(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/services/:name/logs', (req, res) => {
    const lines = parseInt(req.query.lines as string) || 100;
    res.json(serviceManager.getLogs(req.params.name, lines));
  });

  // ==================== Typed settings ====================

  router.get('/settings', (_req, res) => {
    try {
      res.json(getDashboardSettings({ runtimeRoot: process.cwd() }));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/settings', (req, res) => {
    try {
      const result = updateDashboardSettings(req.body, { runtimeRoot: process.cwd() });
      const changedModelSettings = result.updated.some(key => key.startsWith('GAUZ_LLM_'))
        || result.cleared.some(key => key.startsWith('GAUZ_LLM_'));
      const restartInfo = req.body?.restartConnector === true && changedModelSettings
        ? restartCatsCompanyIfRunning(serviceManager)
        : { wasRunning: false, restartRequested: false };
      res.json({
        ...result,
        connectorRestarted: restartInfo.restartRequested,
        restartError: restartInfo.restartError,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ==================== 配置管理 ====================

  router.get('/config', (_req, res) => {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return res.json({});
      const content = fs.readFileSync(envPath, 'utf-8');
      const parsed = dotenv.parse(content);

      const masked = { ...parsed };
      for (const key of Object.keys(masked)) {
        if (isSensitiveEnvKey(key)) {
          masked[key] = masked[key] && masked[key].length > 4
            ? `****${masked[key].slice(-4)}`
            : '****';
        }
      }
      res.json(masked);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/config', (req, res) => {
    try {
      const updates: Record<string, string> = req.body;
      const allowedKeys = new Set([
        'GAUZ_LLM_PROVIDER',
        'GAUZ_LLM_API_BASE',
        'GAUZ_LLM_API_KEY',
        'GAUZ_LLM_MODEL',
        'CATSCO_API_KEY',
        'CATSCO_HTTP_BASE_URL',
        'CATSCO_SERVER_URL',
        'CATSCOMPANY_API_KEY',
        'CATSCOMPANY_HTTP_BASE_URL',
        'CATSCOMPANY_SERVER_URL',
        'FEISHU_APP_ID',
        'FEISHU_APP_SECRET',
        'FEISHU_BOT_OPEN_ID',
        'FEISHU_BOT_ALIASES',
        'WEIXIN_TOKEN',
      ]);
      const safeUpdates: Record<string, string> = {};

      for (const [key, value] of Object.entries(updates)) {
        if (!allowedKeys.has(key)) {
          return res.status(400).json({ error: `Unknown config key: ${key}` });
        }
        if (typeof value !== 'string') continue;
        if (value.startsWith('****')) continue;
        if (/[\r\n]/.test(value)) {
          return res.status(400).json({ error: `Config value for ${key} must not contain newlines` });
        }
        safeUpdates[key] = value;
      }

      const result = writeDashboardEnvUpdates(process.cwd(), safeUpdates);
      for (const [key, value] of Object.entries(safeUpdates)) {
        process.env[key] = value;
      }
      res.json({ ok: true, updated: result.updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== Skills 管理 ====================

  router.get('/skills-all', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const active = manager.getAllSkills().map(skillToDashboardPayload);
      const disabled = findAllDisabledSkills(PathResolver.getSkillsPath());
      res.json([...active, ...disabled]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      res.json(manager.getAllSkills().map(s => ({
        name: s.metadata.name,
        description: s.metadata.description,
        argumentHint: s.metadata.argumentHint || null,
        userInvocable: s.metadata.userInvocable !== false,
        path: s.filePath,
        files: getSkillFiles(s.filePath),
      })));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills/:name', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      const management = getSkillManagementInfo(skill.filePath);
      res.json({
        name: skill.metadata.name,
        description: skill.metadata.description,
        content: skill.content,
        path: skill.filePath,
        files: getSkillFiles(skill.filePath),
        ...management,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/skills/:name', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) {
        const disabled = findDisabledSkillByName(PathResolver.getSkillsPath(), req.params.name);
        if (disabled) {
          const management = getSkillManagementInfo(disabled);
          if (!management.canDelete) {
            return res.status(403).json({ error: formatSkillDeleteBlockedMessage(management) });
          }
          fs.rmSync(path.dirname(disabled), { recursive: true, force: true });
          return res.json({ ok: true });
        }
        return res.status(404).json({ error: 'Skill not found' });
      }
      const management = getSkillManagementInfo(skill.filePath);
      if (!management.canDelete) {
        return res.status(403).json({ error: formatSkillDeleteBlockedMessage(management) });
      }
      fs.rmSync(path.dirname(skill.filePath), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/skills/:name/disable', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      const management = getSkillManagementInfo(skill.filePath);
      if (!management.canDisable) {
        return res.status(403).json({ error: '系统 Skill 不能禁用。' });
      }
      fs.renameSync(skill.filePath, skill.filePath + '.disabled');
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/skills/:name/enable', async (req, res) => {
    try {
      const f = findDisabledSkillByName(PathResolver.getSkillsPath(), req.params.name);
      if (!f) return res.status(404).json({ error: 'Disabled skill not found' });
      fs.renameSync(f, f.replace('.disabled', ''));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== Local Skill Management ====================

  // GET /api/store - local installed and disabled skills only
  router.get('/store', async (_req, res) => {
    try {
      const localSkillManager = new SkillManager();
      await localSkillManager.loadSkills();
      const activeSkills = localSkillManager.getAllSkills().map(skillToDashboardPayload);
      const disabledSkills = findAllDisabledSkills(PathResolver.getSkillsPath());
      res.json([...activeSkills, ...disabledSkills]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/store/install - remote skill install is offline
  router.post('/store/install', async (_req, res) => {
    try {
      res.status(410).json({ error: 'Remote skill install has been disabled. Manage installed skills locally.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/store/install-github - remote skill install is offline
  router.post('/store/install-github', async (_req, res) => {
    try {
      res.status(410).json({ error: 'GitHub skill install has been disabled. Manage installed skills locally.' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== 微信 Token 获取 ====================

  router.get('/weixin/qrcode', async (_req, res) => {
    try {
      const response = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/weixin/qrcode-status', async (req, res) => {
    try {
      const qrcode = req.query.qrcode as string;
      if (!qrcode) return res.status(400).json({ error: 'qrcode required' });
      const response = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${qrcode}`);
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== CatsCo webapp 本地连接器 ====================

  router.get('/cats/status', async (_req, res) => {
    const state = getCatsAuthState();
    const service = serviceManager.getService('catscompany');
    const tokenPresent = Boolean(state.token);
    let connected = false;
    let authStatus: 'missing' | 'valid' | 'invalid' | 'unchecked' = tokenPresent ? 'unchecked' : 'missing';
    let authError = '';
    let user = state.uid ? {
      uid: state.uid,
      username: state.username || '',
      display_name: state.displayName || state.username || '',
    } : null;

    if (state.token) {
      try {
        const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token, {
          timeoutMs: 4000,
        });
        const uid = String(me.uid || state.uid || '').trim();
        connected = Boolean(uid);
        authStatus = connected ? 'valid' : 'invalid';
        user = connected ? {
          uid,
          username: me.username || state.username || '',
          display_name: me.display_name || me.username || state.displayName || state.username || '',
        } : null;
        if (!connected) authError = 'CatsCo 账号验证失败，请重新登录';
      } catch (error: any) {
        const status = Number(error?.status || 0);
        if (status === 401 || status === 403) {
          connected = false;
          authStatus = 'invalid';
          authError = '本地登录态已失效，请使用 CatsCo webapp 同一账号重新登录';
          user = null;
        } else {
          connected = Boolean(state.uid);
          authStatus = 'unchecked';
          authError = status === 408
            ? 'CatsCo 账号验证超时，暂时保留本地登录态'
            : '暂时无法验证 CatsCo 登录态，已保留本地登录态';
        }
      }
    }

    res.json({
      connected,
      configured: connected && Boolean(state.apiKey && state.serverUrl),
      tokenPresent,
      authStatus,
      authError,
      user,
      botUid: state.botUid || null,
      topicId: connected && user?.uid && state.botUid ? p2pTopicId(user.uid, state.botUid) : '',
      httpBaseUrl: state.httpBaseUrl,
      serverUrl: state.serverUrl,
      service: service || null,
    });
  });

  router.post('/cats/auth/send-code', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      const email = String(req.body?.email || '').trim();
      if (!email) return res.status(400).json({ error: 'email required' });
      const data = await catsRequest('POST', state.httpBaseUrl, '/api/auth/send-code', { email });
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/auth/register', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      const email = String(req.body?.email || '').trim();
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      const code = String(req.body?.code || '').trim();
      if (!email || !username || !password || !code) {
        return res.status(400).json({ error: 'email, username, password and code are required' });
      }

      await catsRequest('POST', state.httpBaseUrl, '/api/auth/register', {
        email,
        username,
        password,
        code,
      });
      const login = await catsRequest('POST', state.httpBaseUrl, '/api/auth/login', {
        account: email,
        password,
      });
      persistCatsUserSession(state, login);
      res.json({
        ok: true,
        user: {
          uid: login.uid,
          username: login.username,
          display_name: login.display_name || login.username,
        },
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/auth/login', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      const account = String(req.body?.account || '').trim();
      const password = String(req.body?.password || '');
      if (!account || !password) return res.status(400).json({ error: 'account and password are required' });

      const login = await catsRequest('POST', state.httpBaseUrl, '/api/auth/login', { account, password });
      persistCatsUserSession(state, login);
      res.json({
        ok: true,
        user: {
          uid: login.uid,
          username: login.username,
          display_name: login.display_name || login.username,
        },
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/auth/logout', (_req, res) => {
    const removed = removeEnvKeys([
      'CATSCO_USER_TOKEN',
      'CATSCO_USER_UID',
      'CATSCO_USER_NAME',
      'CATSCO_USER_DISPLAY_NAME',
      'CATSCOMPANY_USER_TOKEN',
      'CATSCOMPANY_USER_UID',
      'CATSCOMPANY_USER_NAME',
      'CATSCOMPANY_USER_DISPLAY_NAME',
    ]);
    res.json({ ok: true, removed });
  });

  router.post('/cats/setup', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token);
      const userUid = String(me.uid || state.uid || '');
      if (!userUid) return res.status(500).json({ error: 'CatsCo user uid missing' });

      const botsResponse = await catsRequest('GET', state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = Array.isArray(botsResponse?.bots) ? botsResponse.bots : [];
      const preferredUsername = String(req.body?.botUsername || `catsco_${userUid}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const preferredName = String(req.body?.botDisplayName || 'CatsCo').trim() || 'CatsCo';
      const legacyUsername = `xiaoba_${userUid}`;
      const legacyName = 'XiaoBa';
      let bot = bots.find((item: any) => String(item.id || item.uid) === String(state.botUid || ''))
        || bots.find((item: any) => String(item.username || '') === preferredUsername)
        || bots.find((item: any) => String(item.display_name || '') === preferredName)
        || bots.find((item: any) => String(item.username || '') === legacyUsername)
        || bots.find((item: any) => String(item.display_name || '') === legacyName);

      if (!bot) {
        const created = await catsRequest('POST', state.httpBaseUrl, '/api/bots', {
          username: preferredUsername,
          display_name: preferredName,
        }, state.token);
        bot = {
          id: created.uid,
          uid: created.uid,
          username: created.username || preferredUsername,
          display_name: preferredName,
          api_key: created.api_key,
        };
      }

      const botUid = String(bot.id || bot.uid || '');
      if (!botUid) return res.status(500).json({ error: 'CatsCo bot uid missing' });

      let apiKey = String(bot.api_key || '');
      if (!apiKey) {
        const keyResponse = await catsRequest('GET', state.httpBaseUrl, `/api/bots/api-key?uid=${encodeURIComponent(botUid)}`, undefined, state.token);
        apiKey = String(keyResponse.api_key || '');
      }
      if (!apiKey) return res.status(500).json({ error: 'CatsCo bot api key missing' });

      const warnings: string[] = [];
      try {
        await catsRequest('POST', state.httpBaseUrl, '/api/friends/request', {
          user_id: Number(botUid),
          message: 'Connect CatsCo desktop agent',
        }, state.token);
      } catch (friendRequestError: any) {
        const msg = String(friendRequestError?.message || '');
        if (!/duplicate|already|exists/i.test(msg)) {
          warnings.push(`friend request: ${msg}`);
        }
      }
      try {
        await catsApiKeyRequest('POST', state.httpBaseUrl, '/api/friends/accept', apiKey, {
          user_id: Number(userUid),
        });
      } catch (friendAcceptError: any) {
        const msg = String(friendAcceptError?.message || '');
        if (!/duplicate|already|exists/i.test(msg)) {
          warnings.push(`friend accept: ${msg}`);
        }
      }

      const updated = writeEnvUpdates({
        CATSCO_HTTP_BASE_URL: state.httpBaseUrl,
        CATSCO_SERVER_URL: state.serverUrl,
        CATSCO_USER_TOKEN: state.token,
        CATSCO_USER_UID: userUid,
        CATSCO_USER_NAME: me.username || state.username || '',
        CATSCO_USER_DISPLAY_NAME: me.display_name || me.username || state.displayName || '',
        CATSCO_BOT_UID: botUid,
        CATSCO_API_KEY: apiKey,
        CATSCOMPANY_HTTP_BASE_URL: state.httpBaseUrl,
        CATSCOMPANY_SERVER_URL: state.serverUrl,
        CATSCOMPANY_USER_TOKEN: state.token,
        CATSCOMPANY_USER_UID: userUid,
        CATSCOMPANY_USER_NAME: me.username || state.username || '',
        CATSCOMPANY_USER_DISPLAY_NAME: me.display_name || me.username || state.displayName || '',
        CATSCOMPANY_BOT_UID: botUid,
        CATSCOMPANY_API_KEY: apiKey,
      });

      let service = serviceManager.getService('catscompany');
      let preflight;
      if (service && service.status !== 'running') {
        preflight = getServicePreflight(serviceManager, 'catscompany', {
          runtimeRoot: process.cwd(),
          config: ConfigManager.getConfigReadonly(),
        });
        if (preflight.status !== 'blocked') {
          service = serviceManager.start('catscompany');
        }
      }

      res.json({
        ok: true,
        updated,
        user: {
          uid: userUid,
          username: me.username || state.username || '',
          display_name: me.display_name || me.username || state.displayName || '',
        },
        bot: {
          uid: botUid,
          username: bot.username || preferredUsername,
          display_name: bot.display_name || preferredName,
        },
        topicId: p2pTopicId(userUid, botUid),
        service,
        preflight,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.get('/cats/relay/model-config', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const protocol = normalizeRelayModelProtocol(req.query.protocol);
      const config = await fetchCatsRelayConfig(state);
      const keyResponse = config?.self_service_enabled ? await fetchCatsRelayKey(state) : { key: null };
      const apiBase = relayEndpointForProtocol(config, protocol);
      const provider = relayProviderForProtocol(protocol);
      const model = String(config?.default_model || 'MiniMax-M2.7').trim() || 'MiniMax-M2.7';
      const currentConfig = ConfigManager.getConfigReadonly();
      const currentApiBase = String(currentConfig.apiUrl || '').replace(/\/+$/, '');

      res.json({
        ok: true,
        protocol,
        provider,
        apiBase,
        model,
        configured: Boolean(
          currentConfig.apiKey
          && currentConfig.provider === provider
          && currentApiBase === apiBase
          && currentConfig.model === model
        ),
        relay: {
          baseUrl: config?.base_url,
          docsUrl: config?.docs_url,
          selfServiceEnabled: Boolean(config?.self_service_enabled),
        },
        key: sanitizeRelayKeyInfo(keyResponse?.key),
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.post('/cats/relay/model-config/apply', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const protocol = normalizeRelayModelProtocol(req.body?.protocol);
      const config = await fetchCatsRelayConfig(state);
      if (config?.self_service_enabled === false) {
        return res.status(503).json({ error: 'CatsCo 中转自助 Key 尚未启用' });
      }

      let ensured;
      try {
        ensured = await ensureCatsRelayPlainKey(state, {
          rotateExisting: req.body?.rotateExisting === true,
        });
      } catch (error: any) {
        if (error?.status === 409) {
          return res.status(409).json({
            error: error.message,
            action: 'rotate_required',
            protocol,
            key: sanitizeRelayKeyInfo((await fetchCatsRelayKey(state))?.key),
          });
        }
        throw error;
      }

      const apiBase = relayEndpointForProtocol(config, protocol);
      const provider = relayProviderForProtocol(protocol);
      const model = String(config?.default_model || 'MiniMax-M2.7').trim() || 'MiniMax-M2.7';
      const settingsResult = updateDashboardSettings({
        settings: {
          'model.provider': provider,
          'model.apiBase': apiBase,
          'model.model': model,
          'model.apiKey': { action: 'replace', value: ensured.plainKey },
        },
      }, { runtimeRoot: process.cwd() });
      const restartInfo = restartCatsCompanyIfRunning(serviceManager);

      res.json({
        ok: true,
        protocol,
        provider,
        apiBase,
        model,
        updated: settingsResult.updated,
        key: sanitizeRelayKeyInfo(ensured.response?.key),
        createdKey: ensured.created,
        rotatedKey: ensured.rotated,
        restartRequired: restartInfo.wasRunning && !restartInfo.restartRequested,
        connectorRestarted: restartInfo.restartRequested,
        restartError: restartInfo.restartError,
        message: restartInfo.restartRequested
          ? '已启用 CatsCo 中转模型，并已请求重启 CatsCo agent 以使用新配置。'
          : restartInfo.wasRunning
          ? '已启用 CatsCo 中转模型；但 CatsCo agent 自动重启失败，请手动重启后使用新配置。'
          : '已启用 CatsCo 中转模型；下次启动 connector 会使用新配置。',
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.get('/cats/conversations', async (_req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const data = await catsRequest('GET', state.httpBaseUrl, '/api/conversations', undefined, state.token);
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.get('/cats/messages', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const topic = String(req.query.topic || '').trim();
      if (!topic) return res.status(400).json({ error: 'topic required' });
      assertCurrentCatsTopic(state, topic);
      const limit = String(req.query.limit || '50');
      const offset = String(req.query.offset || '0');
      const data = await catsRequest('GET', state.httpBaseUrl, `/api/messages?topic_id=${encodeURIComponent(topic)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}&latest=1`, undefined, state.token);
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/messages/send', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      const topicId = String(req.body?.topic_id || '').trim();
      const content = String(req.body?.content || '').trim();
      if (!topicId || !content) return res.status(400).json({ error: 'topic_id and content are required' });
      assertCurrentCatsTopic(state, topicId);
      const data = await catsRequest('POST', state.httpBaseUrl, '/api/messages/send', {
        topic_id: topicId,
        type: 'text',
        content,
      }, state.token);
      res.json(data);
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  router.post('/cats/messages/send-file', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const topicId = String(req.body?.topic_id || '').trim();
      const fileToken = String(req.body?.file_token || '').trim();
      if (!topicId || !fileToken) return res.status(400).json({ error: 'topic_id and file_token are required' });
      assertCurrentCatsTopic(state, topicId);

      const grant = consumeLocalFileGrant(fileToken);
      const stat = validateLocalFileGrant(grant);

      const fileName = grant.name;
      const uploadType = inferCatsUploadType(fileName);
      const upload = await uploadCatsLocalFile({
        httpBaseUrl: state.httpBaseUrl,
        filePath: grant.filePath,
        type: uploadType,
        authHeader: `Bearer ${state.token}`,
      });

      const content = {
        type: uploadType,
        payload: {
          url: upload.url,
          name: upload.name || fileName,
          size: upload.size || stat.size,
        },
      };
      const data = await catsRequest('POST', state.httpBaseUrl, '/api/messages/send', {
        topic_id: topicId,
        type: uploadType,
        content,
      }, state.token);

      res.json({
        ok: true,
        type: uploadType,
        file: {
          name: fileName,
          size: stat.size,
        },
        upload,
        message: data,
      });
    } catch (e: any) {
      res.status(e.status || 500).json({ error: e.message, data: e.data });
    }
  });

  // ==================== 日志和报告 ====================
  // 注释：以下功能需要 report-generator 和 log-uploader 模块，暂时禁用

  /*
  router.post('/logs/upload', async (req, res) => {
    try {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });

      const serverUrl = process.env.LOG_SERVER_URL;
      const apiKey = process.env.LOG_API_KEY;
      if (!serverUrl || !apiKey) {
        return res.status(500).json({ error: '未配置日志服务器' });
      }

      const uploader = new LogUploader(serverUrl, apiKey);
      await uploader.uploadLogs(path.resolve('logs/sessions'), date);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/reports/daily', (req, res) => {
    try {
      const date = req.query.date as string;
      if (!date) return res.status(400).json({ error: 'date required' });

      const generator = new ReportGenerator();
      const report = generator.generateDailyReport(date);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/reports/generate', (req, res) => {
    try {
      const { date, output } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });

      const generator = new ReportGenerator();
      const report = generator.generateDailyReport(date);

      const outputPath = output || path.resolve(`logs/reports/${date}.json`);
      generator.saveReport(report, outputPath);

      res.json({ ok: true, path: outputPath, report });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
  */

  return router;
}

function sanitizeRuntimeProfileEditResponse<T extends Record<string, any>>(payload: T): T {
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.profile?.model?.apiUrl) {
    copy.profile.model.apiUrl = sanitizeServerUrl(copy.profile.model.apiUrl);
  }
  if (copy.draft?.profile?.model?.apiUrl) {
    copy.draft.profile.model.apiUrl = sanitizeServerUrl(copy.draft.profile.model.apiUrl);
  }
  if (copy.draft?.profile?.model?.apiKey) {
    delete copy.draft.profile.model.apiKey;
  }
  return copy;
}

function sanitizeServerUrl(serverUrl?: string): string | undefined {
  const raw = (serverUrl || '').trim();
  if (!raw) return undefined;

  try {
    return new URL(raw).origin;
  } catch {
    return '[configured]';
  }
}

// ==================== Helpers ====================

function getSkillFiles(skillFilePath: string): string[] {
  try {
    const dir = path.dirname(skillFilePath);
    return fs.readdirSync(dir).filter(e => !e.startsWith('.') && e !== '__pycache__');
  } catch { return []; }
}

function skillToDashboardPayload(skill: Skill): any {
  const installInfo = getSkillHubInstallInfo(skill.filePath);
  return {
    name: skill.metadata.name,
    description: skill.metadata.description,
    argumentHint: skill.metadata.argumentHint || null,
    userInvocable: skill.metadata.userInvocable !== false,
    path: skill.filePath,
    files: getSkillFiles(skill.filePath),
    enabled: true,
    skillHub: installInfo,
    ...getSkillManagementInfo(skill.filePath),
  };
}

function getSkillHubInstallInfo(skillFilePath: string): any {
  try {
    const markerPath = path.join(path.dirname(skillFilePath), '.xiaoba-skillhub-install.json');
    if (!fs.existsSync(markerPath)) return null;
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch {
    return null;
  }
}

function getSkillManagementInfo(skillFilePath: string): SkillManagementInfo {
  const dir = path.dirname(skillFilePath);
  const skillsRoot = PathResolver.getSkillsPath();
  const relative = path.relative(skillsRoot, dir);
  const parts = relative.split(path.sep).filter(Boolean);
  const source: SkillSource = parts.some(part => SYSTEM_SKILL_DIRS.has(part))
    ? 'system'
    : fs.existsSync(path.join(dir, BUNDLED_SKILL_MARKER))
      ? 'bundled'
      : 'user';

  return {
    source,
    protected: source === 'system',
    canDisable: source !== 'system',
    canDelete: source === 'user',
  };
}

function formatSkillDeleteBlockedMessage(management: SkillManagementInfo): string {
  if (management.source === 'system') {
    return '系统 Skill 不能删除。';
  }
  if (management.source === 'bundled') {
    return '内置 Skill 不能删除，可在界面中禁用；这样升级后也不会被自动恢复成启用状态。';
  }
  return '该 Skill 当前不能删除。';
}

function findDisabledSkillByName(basePath: string, name: string): string | null {
  if (!fs.existsSync(basePath)) return null;
  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const disabledFile = path.join(basePath, entry.name, 'SKILL.md.disabled');
    if (fs.existsSync(disabledFile)) {
      const content = fs.readFileSync(disabledFile, 'utf-8');
      const m = content.match(/name:\s*(.+)/);
      if (m && m[1].trim() === name) return disabledFile;
    }
    const found = findDisabledSkillByName(path.join(basePath, entry.name), name);
    if (found) return found;
  }
  return null;
}

function findAllDisabledSkills(basePath: string): any[] {
  const results: any[] = [];
  if (!fs.existsSync(basePath)) return results;
  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(basePath, entry.name);
    const disabledFile = path.join(fullPath, 'SKILL.md.disabled');
    if (fs.existsSync(disabledFile)) {
      const content = fs.readFileSync(disabledFile, 'utf-8');
      const nm = content.match(/name:\s*(.+)/);
      const desc = content.match(/description:\s*(.+)/);
      const management = getSkillManagementInfo(disabledFile);
      results.push({
        name: nm ? nm[1].trim() : entry.name,
        description: desc ? desc[1].trim() : '',
        enabled: false,
        path: disabledFile,
        files: getSkillFiles(disabledFile),
        ...management,
      });
    }
    results.push(...findAllDisabledSkills(fullPath));
  }
  return results;
}

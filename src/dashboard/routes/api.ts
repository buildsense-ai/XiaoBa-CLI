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
import type { ChatConfig } from '../../types';
import { createRuntimeConfigSnapshot } from '../../runtime/runtime-config-snapshot';
import {
  CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  calculatePromptBudgetTokens,
  formatContextWindowTokens,
  parsePositiveInteger,
  resolveKnownModelContextWindowTokens,
  resolveModelContextWindow,
} from '../../utils/model-context-window';
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
  RELAY_MODEL_PROFILES,
  findRelayModelProfile,
  relayModelProviderBaseUrl,
  relayModelProviderProtocolLabel,
  relayModelProviderSdkLabel,
  type RelayModelProfile,
  type RelayModelProvider,
} from '../../utils/relay-model-profiles';
import {
  RuntimeProfileEditInput,
  hasRuntimeProfileRollback,
  previewRuntimeProfileEdit,
  rollbackRuntimeProfileEdit,
  saveRuntimeProfileEdit,
} from '../../runtime/runtime-profile-editor';
import { inferCatsUploadType, uploadCatsLocalFile } from '../../catscompany/upload';
import { createCatsCoLocalConfigService } from '../../catscompany/local-config';
import { resolveCatsCoRuntimeConfig } from '../../catscompany/runtime-config';
import { consumeLocalFileGrant, validateLocalFileGrant } from '../local-file-grants';
import { registerSkillHubRoutes } from './skillhub';
import { registerPetRoutes } from './pet';
import { SkillHubService } from '../../skillhub/service';
import {
  computeLocalSkillContentHash,
  readSkillHubLocalMetadata,
} from '../../skillhub/local-skill-metadata';
import {
  deletePromptOverride,
  getPromptBranchAgentsState,
  getPromptEditorFile,
  getPromptEditorState,
  writePromptOverride,
} from '../../utils/prompt-editor';
import {
  BRANCH_AGENTS_ENABLED_ENV,
  serializeBranchAgentsEnabled,
} from '../../core/branch-agent-settings';
import {
  BindWeixinChannelResult,
  WeixinChannelStatus,
  bindWeixinChannelToCurrentAgent,
  getWeixinChannelStatus,
} from '../weixin-channel-binding';
// import { ReportGenerator } from '../../utils/report-generator';
// import { LogUploader } from '../../utils/log-uploader';

const DEFAULT_CATSCO_HTTP_BASE_URL = 'https://app.catsco.cc';
const DEFAULT_CATSCO_WS_URL = 'wss://app.catsco.cc/v0/channels';
const TRUSTED_CATSCO_HTTP_ORIGINS = new Set([new URL(DEFAULT_CATSCO_HTTP_BASE_URL).origin]);
const TRUSTED_CATSCO_WS_URL = new URL(DEFAULT_CATSCO_WS_URL);
const BUNDLED_SKILL_MARKER = '.xiaoba-bundled-skill.json';
const SYSTEM_SKILL_DIRS = new Set<string>();
const PROMPT_EDITOR_SKILL_NAME = 'catsco-prompt-editor';

type SkillSource = 'system' | 'bundled' | 'user';

interface SkillManagementInfo {
  source: SkillSource;
  protected: boolean;
  canDisable: boolean;
  canDelete: boolean;
  canShare: boolean;
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

interface CatsBotBindingInput {
  userUid: string;
  username?: string;
  displayName?: string;
  botUid: string;
  botName?: string;
  botUsername?: string;
  apiKey: string;
  bindingSource?: string;
}

interface CatsRequestOptions {
  timeoutMs?: number;
}

interface CatsUploadedLocalAttachment {
  type: 'image' | 'file';
  file: {
    name: string;
    size: number;
  };
  upload: {
    url: string;
    name: string;
    size: number;
  };
  contentBlock: {
    type: 'image' | 'file';
    payload: {
      url: string;
      name: string;
      size: number;
    };
  };
}

const CATSCO_RUNTIME_ENV_KEYS = [
  'CATSCO_HTTP_BASE_URL',
  'CATSCO_SERVER_URL',
  'CATSCO_USER_TOKEN',
  'CATSCO_USER_UID',
  'CATSCO_USER_NAME',
  'CATSCO_USER_DISPLAY_NAME',
  'CATSCO_BOT_UID',
  'CATSCO_API_KEY',
  'CATSCO_DEVICE_ID',
  'CATSCO_BODY_ID',
  'CATSCO_INSTALLATION_ID',
  'CATSCOMPANY_HTTP_BASE_URL',
  'CATSCOMPANY_SERVER_URL',
  'CATSCOMPANY_USER_TOKEN',
  'CATSCOMPANY_USER_UID',
  'CATSCOMPANY_USER_NAME',
  'CATSCOMPANY_USER_DISPLAY_NAME',
  'CATSCOMPANY_BOT_UID',
  'CATSCOMPANY_API_KEY',
  'CATSCOMPANY_DEVICE_ID',
  'CATSCOMPANY_BODY_ID',
  'CATSCOMPANY_INSTALLATION_ID',
] as const;

type RelayModelProtocol = 'anthropic' | 'openai';

interface RelayModelConfig {
  id: string;
  label: string;
  model: string;
  family?: string;
  provider: RelayModelProvider;
  protocol: string;
  baseUrl: string;
  sdkLabel: string;
  enabled: boolean;
  default: boolean;
  quotaClass?: string;
  contextWindowTokens?: number;
  capabilities?: {
    tool_calling?: boolean;
    vision?: boolean;
    streaming?: boolean;
  };
}

const MODEL_SOURCE_ENV_KEY = 'CATSCO_MODEL_SOURCE';
const RELAY_MODEL_VISION_CAPABLE_ENV_KEY = 'CATSCO_RELAY_LLM_VISION_CAPABLE';
const RELAY_MODEL_TOOL_CALLING_CAPABLE_ENV_KEY = 'CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE';
const CUSTOM_MODEL_ENV_KEYS = {
  provider: 'CATSCO_CUSTOM_LLM_PROVIDER',
  apiBase: 'CATSCO_CUSTOM_LLM_API_BASE',
  model: 'CATSCO_CUSTOM_LLM_MODEL',
  apiKey: 'CATSCO_CUSTOM_LLM_API_KEY',
  contextWindowTokens: 'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS',
} as const;
const RELAY_MODEL_ENV_KEYS = {
  provider: 'CATSCO_RELAY_LLM_PROVIDER',
  apiBase: 'CATSCO_RELAY_LLM_API_BASE',
  model: 'CATSCO_RELAY_LLM_MODEL',
  apiKey: 'CATSCO_RELAY_LLM_API_KEY',
  contextWindowTokens: 'CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS',
} as const;
const EFFECTIVE_MODEL_ENV_KEYS = {
  provider: 'GAUZ_LLM_PROVIDER',
  apiBase: 'GAUZ_LLM_API_BASE',
  model: 'GAUZ_LLM_MODEL',
  apiKey: 'GAUZ_LLM_API_KEY',
  contextWindowTokens: 'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
} as const;

interface ModelLaunchProfile {
  provider?: 'anthropic' | 'openai';
  apiBase?: string;
  model?: string;
  apiKey?: string;
  contextWindowTokens?: number;
}

function normalizeBaseUrl(value: unknown, fallback: string): string {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return text || fallback;
}

function truthyEnv(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function canUseLocalCatsCoEndpoint(): boolean {
  return process.env.NODE_ENV === 'test'
    || truthyEnv(process.env.CATSCO_ALLOW_LOCAL_ENDPOINTS)
    || truthyEnv(process.env.CATSCOMPANY_ALLOW_LOCAL_ENDPOINTS);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function normalizeTrustedCatsHttpBaseUrl(value: unknown): string {
  const text = String(value || DEFAULT_CATSCO_HTTP_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw httpError('Untrusted CatsCo HTTP endpoint', 400);
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw httpError('Untrusted CatsCo HTTP endpoint', 400);
  }
  if (TRUSTED_CATSCO_HTTP_ORIGINS.has(url.origin)) {
    return url.origin;
  }
  if (canUseLocalCatsCoEndpoint() && isLoopbackHost(url.hostname)) {
    return url.origin;
  }
  throw httpError('Untrusted CatsCo HTTP endpoint', 400);
}

function normalizeTrustedCatsServerUrl(value: unknown): string {
  const text = String(value || DEFAULT_CATSCO_WS_URL).trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw httpError('Untrusted CatsCo websocket endpoint', 400);
  }

  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw httpError('Untrusted CatsCo websocket endpoint', 400);
  }

  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (url.origin === TRUSTED_CATSCO_WS_URL.origin && pathname === TRUSTED_CATSCO_WS_URL.pathname) {
    return `${url.protocol}//${url.host}${pathname}`;
  }
  if (canUseLocalCatsCoEndpoint() && isLoopbackHost(url.hostname)) {
    return `${url.protocol}//${url.host}${pathname}`;
  }
  throw httpError('Untrusted CatsCo websocket endpoint', 400);
}

function trustCatsAuthStateEndpoints(state: CatsAuthState): CatsAuthState {
  return {
    ...state,
    httpBaseUrl: normalizeTrustedCatsHttpBaseUrl(state.httpBaseUrl),
    serverUrl: normalizeTrustedCatsServerUrl(state.serverUrl),
  };
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

function sanitizeWeixinChannelStatus(status: WeixinChannelStatus): Record<string, any> {
  const binding = status.binding
    ? {
      channel: status.binding.channel,
      agentUid: status.binding.agentUid,
      agentName: status.binding.agentName,
      agentUsername: status.binding.agentUsername,
      bodyId: status.binding.bodyId,
      boundByUserUid: status.binding.boundByUserUid,
      tokenLast4: status.binding.tokenLast4,
      legacyEnvKey: status.binding.legacyEnvKey,
      createdAt: status.binding.createdAt,
      updatedAt: status.binding.updatedAt,
    }
    : undefined;
  return {
    configured: status.configured,
    currentAgent: status.currentAgent,
    binding,
    mismatch: status.mismatch,
    reason: status.reason,
  };
}

function sanitizeWeixinBindingResult(result: BindWeixinChannelResult): Record<string, any> {
  return {
    binding: sanitizeWeixinChannelStatus({
      configured: true,
      currentAgent: {
        uid: result.binding.agentUid,
        name: result.binding.agentName,
        username: result.binding.agentUsername,
        bodyId: result.binding.bodyId,
        ownerUid: result.binding.boundByUserUid,
        ownerUsername: result.binding.boundByUsername,
      },
      binding: result.binding,
    }).binding,
    updatedEnv: result.updatedEnv,
  };
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

  fs.writeFileSync(envPath, content, { encoding: 'utf-8', mode: 0o600 });
  chmodOwnerOnly(envPath);
  return updatedKeys;
}

function removeEnvKeys(keys: string[]): string[] {
  const envPath = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const removed: string[] = [];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      delete process.env[key];
      removed.push(key);
    }
    const regex = new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, '');
      if (!removed.includes(key)) removed.push(key);
    }
  }

  if (fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, content, { encoding: 'utf-8', mode: 0o600 });
    chmodOwnerOnly(envPath);
  }
  return removed;
}

export function getCatsAuthState(overrides: Record<string, unknown> = {}): CatsAuthState {
  return createCatsCoLocalConfigService({ runtimeRoot: process.cwd() }).getAuthState(overrides);
}

function getModelConfigReadonly(): Pick<ChatConfig, 'apiKey' | 'apiUrl' | 'model' | 'provider'> {
  const config = ConfigManager.getConfigReadonly();
  const env = readEnvFile();
  const provider = firstNonEmpty(process.env.GAUZ_LLM_PROVIDER, env.GAUZ_LLM_PROVIDER, config.provider);
  const apiUrl = firstNonEmpty(process.env.GAUZ_LLM_API_BASE, env.GAUZ_LLM_API_BASE, config.apiUrl);
  const apiKey = firstNonEmpty(process.env.GAUZ_LLM_API_KEY, env.GAUZ_LLM_API_KEY, config.apiKey);
  const model = firstNonEmpty(process.env.GAUZ_LLM_MODEL, env.GAUZ_LLM_MODEL, config.model);

  return {
    apiKey,
    apiUrl,
    model,
    provider: provider === 'anthropic' || provider === 'openai' ? provider : config.provider,
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

async function uploadCatsGrantedAttachment(state: CatsAuthState, fileToken: string): Promise<CatsUploadedLocalAttachment> {
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
  const payload = {
    url: upload.url,
    name: upload.name || fileName,
    size: upload.size || stat.size,
  };
  return {
    type: uploadType,
    file: {
      name: fileName,
      size: stat.size,
    },
    upload,
    contentBlock: {
      type: uploadType,
      payload,
    },
  };
}

function summarizeCatsAttachments(attachments: CatsUploadedLocalAttachment[]): string {
  if (attachments.length === 0) return '';
  if (attachments.length === 1) {
    const item = attachments[0];
    return `[${item.type === 'image' ? '图片' : '文件'}] ${item.file.name}`;
  }
  return `[附件] ${attachments.map(item => item.file.name).join(', ')}`;
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

function sanitizeCatsUsernamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function ensureCatsDeviceId(): string {
  return createCatsCoLocalConfigService({ runtimeRoot: process.cwd() }).ensureDeviceId();
}

function chmodOwnerOnly(filePath: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission hardening only.
  }
}

function snapshotFile(filePath: string): { exists: boolean; content?: string } {
  return fs.existsSync(filePath)
    ? { exists: true, content: fs.readFileSync(filePath, 'utf-8') }
    : { exists: false };
}

function restoreFile(filePath: string, snapshot: { exists: boolean; content?: string }): void {
  if (!snapshot.exists) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, snapshot.content || '', { encoding: 'utf-8', mode: 0o600 });
  chmodOwnerOnly(filePath);
}

function createCatsCoLocalConfigRollback(): () => void {
  const runtimeRoot = process.cwd();
  const service = createCatsCoLocalConfigService({ runtimeRoot });
  const configPath = service.getConfigPath();
  const envPath = path.join(runtimeRoot, '.env');
  const configSnapshot = snapshotFile(configPath);
  const envSnapshot = snapshotFile(envPath);
  const processEnvSnapshot = new Map<string, string | undefined>(
    CATSCO_RUNTIME_ENV_KEYS.map(key => [key, process.env[key]]),
  );

  return () => {
    restoreFile(configPath, configSnapshot);
    restoreFile(envPath, envSnapshot);
    for (const [key, value] of processEnvSnapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function getCatsBotApiKey(state: CatsAuthState, botUid: string, bot?: any): Promise<string> {
  let apiKey = String(bot?.api_key || '');
  if (!apiKey) {
    const keyResponse = await catsRequest('GET', state.httpBaseUrl, `/api/bots/api-key?uid=${encodeURIComponent(botUid)}`, undefined, state.token);
    apiKey = String(keyResponse.api_key || '');
  }
  if (!apiKey) throw httpError('CatsCo bot api key missing', 500);
  return apiKey;
}

async function ensureCatsFriendBinding(
  state: CatsAuthState,
  userUid: string,
  botUid: string,
  apiKey: string,
): Promise<string[]> {
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
  return warnings;
}

async function getCatsBotBodyStatus(
  state: CatsAuthState,
  botUid: string | undefined,
  localBodyId: string | undefined,
): Promise<Record<string, unknown>> {
  const normalizedBotUid = String(botUid || '').trim();
  const normalizedLocalBodyId = String(localBodyId || '').trim();
  if (!state.token || !normalizedBotUid || !normalizedLocalBodyId) {
    return {
      state: 'not_configured',
      active: false,
      localBodyId: normalizedLocalBodyId || undefined,
    };
  }

  try {
    const data = await catsRequest(
      'GET',
      state.httpBaseUrl,
      `/api/bots/body-status?uid=${encodeURIComponent(normalizedBotUid)}`,
      undefined,
      state.token,
      { timeoutMs: 2500 },
    );
    const platformBodyId = String(data?.body_id || data?.bodyId || '').trim();
    const active = Boolean(data?.active);
    const bodyMismatch = platformBodyId && platformBodyId !== normalizedLocalBodyId;
    return {
      state: bodyMismatch ? 'conflict' : active ? 'online' : 'offline',
      active,
      localBodyId: normalizedLocalBodyId,
      platformBodyId: platformBodyId || undefined,
      connectedAt: typeof data?.connected_at === 'string' ? data.connected_at : undefined,
      checkedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    const status = Number(error?.status || 0);
    if (status === 401 || status === 403) {
      return {
        state: 'auth_error',
        active: false,
        localBodyId: normalizedLocalBodyId,
        checkedAt: new Date().toISOString(),
        error: status === 403
          ? '当前 CatsCo 账号不是这个 bot 的 owner，请重新选择或绑定 agent'
          : 'CatsCo 登录态无法查询这个 bot 的 body 状态，请重新登录',
      };
    }
    return {
      state: 'unknown',
      active: false,
      localBodyId: normalizedLocalBodyId,
      checkedAt: new Date().toISOString(),
      error: String(error?.message || 'unable to query CatsCo body status'),
    };
  }
}

function getCatsCompanyBindingPreflight(
  serviceManager: ServiceManager,
  state: CatsAuthState,
  input: CatsBotBindingInput,
): any {
  const service = serviceManager.getService('catscompany');
  if (!service) return undefined;
  return getServicePreflight(serviceManager, 'catscompany', {
    runtimeRoot: process.cwd(),
    config: ConfigManager.getConfigReadonly(),
    catsCoOverrides: {
      token: state.token,
      uid: input.userUid,
      username: input.username || state.username,
      displayName: input.displayName || state.displayName,
      httpBaseUrl: state.httpBaseUrl,
      serverUrl: state.serverUrl,
      botUid: input.botUid,
      apiKey: input.apiKey,
    },
  });
}

function assertCatsCompanyPreflightCanStart(preflight: any): void {
  if (!preflight || preflight.status !== 'blocked') return;
  const error = httpError('CatsCo connector preflight blocked', 400) as any;
  error.data = { preflight };
  throw error;
}

async function startCatsCompanyConnectorIfReady(
  serviceManager: ServiceManager,
  options: { restartIfRunning?: boolean; preflight?: any } = {},
): Promise<{ service: any; preflight: any; connectorStarted: boolean; connectorRestarted: boolean }> {
  let service = serviceManager.getService('catscompany');
  let preflight = options.preflight;
  if (service) {
    preflight = preflight || getServicePreflight(serviceManager, 'catscompany', {
      runtimeRoot: process.cwd(),
      config: ConfigManager.getConfigReadonly(),
    });
    if (preflight.status === 'blocked') {
      return { service, preflight, connectorStarted: false, connectorRestarted: false };
    }
  }
  if (service && service.status === 'running' && options.restartIfRunning) {
    service = serviceManager.restart('catscompany');
    return { service, preflight, connectorStarted: false, connectorRestarted: true };
  }
  if (service && service.status !== 'running') {
    service = serviceManager.start('catscompany');
    return { service, preflight, connectorStarted: true, connectorRestarted: false };
  }
  return { service, preflight, connectorStarted: false, connectorRestarted: false };
}

function writeCatsBotBinding(state: CatsAuthState, input: CatsBotBindingInput): string[] {
  return createCatsCoLocalConfigService({ runtimeRoot: process.cwd() }).writeBotBinding(state, input);
}

async function commitCatsBotBindingAndStartConnector(
  serviceManager: ServiceManager,
  state: CatsAuthState,
  input: CatsBotBindingInput,
): Promise<{ updated: string[]; warnings: string[]; service: any; preflight: any; connectorStarted: boolean; connectorRestarted: boolean }> {
  ensureCatsDeviceId();
  const preflight = getCatsCompanyBindingPreflight(serviceManager, state, input);
  assertCatsCompanyPreflightCanStart(preflight);
  const rollback = createCatsCoLocalConfigRollback();
  try {
    const warnings = await ensureCatsFriendBinding(state, input.userUid, input.botUid, input.apiKey);
    const updated = writeCatsBotBinding(state, input);
    const {
      service,
      preflight: startPreflight,
      connectorStarted,
      connectorRestarted,
    } = await startCatsCompanyConnectorIfReady(serviceManager, {
      restartIfRunning: true,
      preflight,
    });
    return {
      updated,
      warnings,
      service,
      preflight: startPreflight,
      connectorStarted,
      connectorRestarted,
    };
  } catch (error) {
    rollback();
    throw error;
  }
}

function normalizeRelayModelProtocol(value: unknown): RelayModelProtocol {
  const text = String(value || '').trim().toLowerCase();
  return text.includes('openai') ? 'openai' : 'anthropic';
}

function normalizeRelayProvider(value: unknown): RelayModelProvider {
  return String(value || '').trim().toLowerCase().includes('openai') ? 'openai' : 'anthropic';
}

function explicitRelayProvider(item: any): RelayModelProvider | undefined {
  if (!item || typeof item !== 'object') return undefined;
  if (item.provider == null && item.protocol == null) return undefined;
  return normalizeRelayProvider(item.provider ?? item.protocol);
}

function relayEndpointForProtocol(config: any, protocol: RelayModelProtocol): string {
  const endpoints = Array.isArray(config?.endpoints) ? config.endpoints : [];
  const endpoint = endpoints.find((item: any) => {
    const label = String(item?.protocol || '').toLowerCase();
    return protocol === 'openai' ? label.includes('openai') : label.includes('anthropic');
  });
  const baseUrl = normalizeBaseUrl(config?.base_url, 'https://relay.catsco.cc');
  const fallback = baseUrl === 'https://relay.catsco.cc'
    ? relayModelProviderBaseUrl(protocol)
    : protocol === 'openai' ? `${baseUrl}/v1` : `${baseUrl}/anthropic`;
  return normalizeBaseUrl(endpoint?.base_url, fallback);
}

function canonicalRelayModelName(value: unknown): string {
  const model = String(value || '').trim();
  const key = model.toLowerCase();
  if (key === 'deepseek-v4-flash') return 'deepseek-v4-flash';
  if (key === 'glm-5.1') return 'glm-5.1';
  return model;
}

function relayModelCapabilitiesPayload(item: any, profile?: RelayModelProfile): RelayModelConfig['capabilities'] {
  const capabilities = item?.capabilities;
  const payload: RelayModelConfig['capabilities'] = profile
    ? {
      tool_calling: profile.capabilities.toolCalling,
      vision: profile.capabilities.vision,
      streaming: profile.capabilities.streaming,
    }
    : {};
  if (!capabilities || typeof capabilities !== 'object') {
    return Object.keys(payload).length > 0 ? payload : undefined;
  }

  const toolCalling = optionalBoolean(capabilities.tool_calling ?? capabilities.toolCalling);
  const vision = optionalBoolean(capabilities.vision);
  const streaming = optionalBoolean(capabilities.streaming);
  if (toolCalling !== undefined) payload.tool_calling = toolCalling;
  if (vision !== undefined) payload.vision = vision;
  if (streaming !== undefined) payload.streaming = streaming;
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  }
  return undefined;
}

function normalizeRelayModelConfig(item: any, config: any, index: number): RelayModelConfig | null {
  const rawModel = canonicalRelayModelName(item?.model);
  if (!rawModel) return null;
  const profile = findRelayModelProfile(rawModel);
  const model = profile?.model || rawModel;
  const provider = explicitRelayProvider(item)
    ?? profile?.preferredProvider
    ?? normalizeRelayProvider(item?.provider ?? item?.protocol);
  const protocol = relayModelProviderProtocolLabel(provider);
  const baseUrl = relayEndpointForProtocol(config, provider);
  const contextWindowTokens = parsePositiveInteger(item?.context_window_tokens)
    ?? parsePositiveInteger(item?.contextWindowTokens)
    ?? profile?.contextWindowTokens
    ?? resolveKnownModelContextWindowTokens(model);
  return {
    id: String(item?.id || profile?.id || model || `relay-model-${index}`).trim(),
    label: String(item?.label || profile?.label || model).trim(),
    model,
    family: String(item?.family || profile?.family || '').trim() || undefined,
    provider,
    protocol,
    baseUrl,
    sdkLabel: relayModelProviderSdkLabel(provider),
    enabled: item?.enabled !== false,
    default: item?.default === true,
    quotaClass: String(item?.quota_class || item?.quotaClass || profile?.quotaClass || '').trim() || undefined,
    contextWindowTokens,
    capabilities: relayModelCapabilitiesPayload(item, profile),
  };
}

function fallbackRelayModelCatalog(config: any): RelayModelConfig[] {
  return RELAY_MODEL_PROFILES.map((profile, index) => ({
    id: profile.id,
    label: profile.label,
    model: profile.model,
    family: profile.family,
    provider: profile.preferredProvider,
    protocol: relayModelProviderProtocolLabel(profile.preferredProvider),
    baseUrl: relayEndpointForProtocol(config, profile.preferredProvider),
    sdkLabel: relayModelProviderSdkLabel(profile.preferredProvider),
    enabled: true,
    default: index === 0,
    quotaClass: profile.quotaClass,
    contextWindowTokens: profile.contextWindowTokens,
    capabilities: {
      tool_calling: profile.capabilities.toolCalling,
      vision: profile.capabilities.vision,
      streaming: profile.capabilities.streaming,
    },
  }));
}

function relayModelCatalog(config: any): RelayModelConfig[] {
  const hasModelCatalog = Array.isArray(config?.models);
  const rawModels = hasModelCatalog ? config.models : [];
  const models = rawModels
    .map((item: any, index: number) => normalizeRelayModelConfig(item, config, index))
    .filter((item: RelayModelConfig | null): item is RelayModelConfig => Boolean(item && item.enabled));
  if (models.length > 0) return markRelayDefaultModel(models, config);
  if (hasModelCatalog) return [];
  return markRelayDefaultModel(fallbackRelayModelCatalog(config), config);
}

function markRelayDefaultModel(models: RelayModelConfig[], config: any): RelayModelConfig[] {
  const defaultModel = String(config?.default_model || '').trim().toLowerCase();
  let defaultIndex = models.findIndex(model => model.default);
  if (defaultModel) {
    const matched = models.findIndex(model => (
      model.model.toLowerCase() === defaultModel || model.id.toLowerCase() === defaultModel
    ));
    if (matched >= 0) defaultIndex = matched;
  }
  if (defaultIndex < 0) defaultIndex = 0;
  return models.map((model, index) => ({ ...model, default: index === defaultIndex }));
}

function selectRelayModel(
  config: any,
  requested: unknown,
  options: { strict?: boolean } = {},
): RelayModelConfig {
  const models = relayModelCatalog(config);
  if (models.length === 0) {
    throw httpError('CatsCo 中转暂未提供可用模型', 503);
  }
  const needle = String(requested || '').trim().toLowerCase();
  if (needle) {
    const matched = models.find(model => (
      model.id.toLowerCase() === needle || model.model.toLowerCase() === needle
    ));
    if (matched) return matched;
    if (options.strict) {
      throw httpError(`未知 CatsCo 中转模型: ${requested}`, 400);
    }
  }
  return models.find(model => model.default) || models[0];
}

function preferredRelayModelRequest(requested: unknown): unknown {
  const explicit = String(requested || '').trim();
  if (explicit) return explicit;
  const fileEnv = readEnvFile();
  return firstNonEmpty(
    process.env.CATSCO_RELAY_LLM_MODEL,
    fileEnv.CATSCO_RELAY_LLM_MODEL,
    isCatsRelayApiBase(firstNonEmpty(process.env.GAUZ_LLM_API_BASE, fileEnv.GAUZ_LLM_API_BASE))
      ? firstNonEmpty(process.env.GAUZ_LLM_MODEL, fileEnv.GAUZ_LLM_MODEL)
      : undefined,
  );
}

function relayModelPayload(model: RelayModelConfig): Record<string, unknown> {
  const promptBudget = model.contextWindowTokens
    ? calculatePromptBudgetTokens(model.contextWindowTokens, 32_768).promptBudgetTokens
    : undefined;
  return {
    id: model.id,
    label: model.label,
    model: model.model,
    family: model.family,
    provider: model.provider,
    protocol: model.protocol,
    base_url: model.baseUrl,
    sdk_label: model.sdkLabel,
    enabled: model.enabled,
    default: model.default,
    quota_class: model.quotaClass,
    context_window_tokens: model.contextWindowTokens,
    prompt_budget_tokens: promptBudget,
    context_label: model.contextWindowTokens ? formatContextWindowTokens(model.contextWindowTokens) : undefined,
    capabilities: model.capabilities,
  };
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

function writeDashboardEnvAndProcess(updates: Record<string, string | undefined>): { updated: string[]; cleared: string[] } {
  const result = writeDashboardEnvUpdates(process.cwd(), updates);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return result;
}

function modelProfileFromCurrentConfig(): ModelLaunchProfile {
  const config = getModelConfigReadonly();
  const fileEnv = readEnvFile();
  return {
    provider: config.provider,
    apiBase: config.apiUrl,
    model: config.model,
    apiKey: config.apiKey,
    contextWindowTokens: parsePositiveInteger(firstNonEmpty(process.env.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, fileEnv.GAUZ_LLM_CONTEXT_WINDOW_TOKENS)),
  };
}

function modelProfileFromStoredEnv(
  keys: typeof CUSTOM_MODEL_ENV_KEYS | typeof RELAY_MODEL_ENV_KEYS | typeof EFFECTIVE_MODEL_ENV_KEYS,
): ModelLaunchProfile {
  const fileEnv = readEnvFile();
  const provider = firstNonEmpty(process.env[keys.provider], fileEnv[keys.provider]);
  return {
    provider: provider === 'anthropic' || provider === 'openai' ? provider : undefined,
    apiBase: firstNonEmpty(process.env[keys.apiBase], fileEnv[keys.apiBase]),
    model: firstNonEmpty(process.env[keys.model], fileEnv[keys.model]),
    apiKey: firstNonEmpty(process.env[keys.apiKey], fileEnv[keys.apiKey]),
    contextWindowTokens: parsePositiveInteger(firstNonEmpty(process.env[keys.contextWindowTokens], fileEnv[keys.contextWindowTokens])),
  };
}

function storedModelSource(): 'relay' | 'custom' {
  const fileEnv = readEnvFile();
  const source = firstNonEmpty(process.env[MODEL_SOURCE_ENV_KEY], fileEnv[MODEL_SOURCE_ENV_KEY]);
  return source === 'relay' ? 'relay' : 'custom';
}

function isCompleteModelProfile(profile: ModelLaunchProfile): boolean {
  return Boolean(profile.provider && profile.apiBase && profile.model && profile.apiKey);
}

function modelProfileUpdates(
  keys: typeof CUSTOM_MODEL_ENV_KEYS | typeof RELAY_MODEL_ENV_KEYS | typeof EFFECTIVE_MODEL_ENV_KEYS,
  profile: ModelLaunchProfile,
): Record<string, string | undefined> {
  return {
    [keys.provider]: profile.provider,
    [keys.apiBase]: profile.apiBase,
    [keys.model]: profile.model,
    [keys.apiKey]: profile.apiKey,
    [keys.contextWindowTokens]: profile.contextWindowTokens ? String(profile.contextWindowTokens) : undefined,
  };
}

function preserveCurrentCustomModelBeforeRelay(): string[] {
  const current = {
    ...modelProfileFromCurrentConfig(),
  };
  if (isCatsRelayApiBase(current.apiBase)) return [];
  if (!current.provider && !current.apiBase && !current.model && !current.apiKey) return [];
  current.contextWindowTokens = current.contextWindowTokens ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS;

  return writeDashboardEnvAndProcess(modelProfileUpdates(CUSTOM_MODEL_ENV_KEYS, current)).updated;
}

function requestedSecretAction(input: any): 'keep' | 'replace' | 'clear' {
  const raw = input?.settings?.['model.apiKey'];
  if (raw && typeof raw === 'object') {
    const action = String(raw.action || '').trim();
    if (action === 'replace' || action === 'clear' || action === 'keep') return action;
  }
  return 'keep';
}

function requestedCustomContextWindowTokens(input: any): number | undefined {
  if (!input?.settings || typeof input.settings !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(input.settings, 'model.contextWindowTokens')) return undefined;
  return parsePositiveInteger(input.settings['model.contextWindowTokens']);
}

function sanitizePublicUrl(value: unknown): string | undefined {
  const text = String(value || '').trim();
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function mirrorCurrentModelAsCustomStartup(input: any, previous: ModelLaunchProfile, previousSource: 'relay' | 'custom'): void {
  const current = modelProfileFromCurrentConfig();
  const secretAction = requestedSecretAction(input);
  const storedCustom = modelProfileFromStoredEnv(CUSTOM_MODEL_ENV_KEYS);
  const apiKey = secretAction === 'clear'
    ? undefined
    : secretAction === 'keep'
      ? storedCustom.apiKey || (isCatsRelayApiBase(previous.apiBase) ? undefined : previous.apiKey)
      : current.apiKey;
  const custom: ModelLaunchProfile = {
    ...current,
    apiKey,
    contextWindowTokens: requestedCustomContextWindowTokens(input)
      ?? storedCustom.contextWindowTokens
      ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  };

  if (!isCompleteModelProfile(custom) && (previousSource === 'relay' || isCatsRelayApiBase(previous.apiBase))) {
    writeDashboardEnvAndProcess({
      ...modelProfileUpdates(CUSTOM_MODEL_ENV_KEYS, custom),
      ...modelProfileUpdates(EFFECTIVE_MODEL_ENV_KEYS, previous),
      [MODEL_SOURCE_ENV_KEY]: 'relay',
    });
    return;
  }

  writeDashboardEnvAndProcess({
    ...modelProfileUpdates(CUSTOM_MODEL_ENV_KEYS, custom),
    ...modelProfileUpdates(EFFECTIVE_MODEL_ENV_KEYS, custom),
    [MODEL_SOURCE_ENV_KEY]: isCompleteModelProfile(custom) || previousSource === 'custom' ? 'custom' : previousSource,
  });
}

function writeCustomModelStartupConfig(): { profile: ModelLaunchProfile; updated: string[]; cleared: string[] } {
  const profile = {
    ...modelProfileFromStoredEnv(CUSTOM_MODEL_ENV_KEYS),
  };
  if (!isCompleteModelProfile(profile)) {
    const error: any = new Error('请先在设置里保存完整的自定义模型地址、模型名称和访问凭证。');
    error.status = 400;
    error.reason = 'CUSTOM_MODEL_NOT_CONFIGURED';
    throw error;
  }
  profile.contextWindowTokens = profile.contextWindowTokens ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS;
  const result = writeDashboardEnvAndProcess({
    ...modelProfileUpdates(CUSTOM_MODEL_ENV_KEYS, profile),
    ...modelProfileUpdates(EFFECTIVE_MODEL_ENV_KEYS, profile),
    [MODEL_SOURCE_ENV_KEY]: 'custom',
    [RELAY_MODEL_VISION_CAPABLE_ENV_KEY]: undefined,
    [RELAY_MODEL_TOOL_CALLING_CAPABLE_ENV_KEY]: undefined,
  });
  return { profile, ...result };
}

function writeRelayModelStartupConfig(model: RelayModelConfig, apiKey: string): { updated: string[]; cleared: string[] } {
  const preserved = preserveCurrentCustomModelBeforeRelay();
  const profile: ModelLaunchProfile = {
    provider: model.provider,
    apiBase: model.baseUrl,
    model: model.model,
    apiKey,
    contextWindowTokens: model.contextWindowTokens ?? resolveKnownModelContextWindowTokens(model.model),
  };
  const result = writeDashboardEnvAndProcess({
    ...modelProfileUpdates(RELAY_MODEL_ENV_KEYS, profile),
    ...modelProfileUpdates(EFFECTIVE_MODEL_ENV_KEYS, profile),
    [MODEL_SOURCE_ENV_KEY]: 'relay',
    [RELAY_MODEL_VISION_CAPABLE_ENV_KEY]: model.capabilities?.vision === undefined ? undefined : String(model.capabilities.vision),
    [RELAY_MODEL_TOOL_CALLING_CAPABLE_ENV_KEY]: model.capabilities?.tool_calling === undefined ? undefined : String(model.capabilities.tool_calling),
  });
  return {
    updated: [...preserved, ...result.updated],
    cleared: result.cleared,
  };
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
    if (field === 'prefix' && typeof value === 'string') {
      safe[field] = sanitizeRelayKeyPrefix(value);
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      safe[field] = value;
    }
  }
  return safe;
}

function sanitizeRelayKeyPrefix(value: string): string {
  const prefix = value.trim();
  if (!prefix) return '';
  if (prefix.includes('...')) return sanitizeCatsErrorMessage(prefix);
  if (/^sk-[A-Za-z0-9_-]{12,}$/.test(prefix)) {
    return `${prefix.slice(0, 8)}...${prefix.slice(-4)}`;
  }
  return sanitizeCatsErrorMessage(prefix);
}

async function fetchCatsRelayConfig(state: CatsAuthState): Promise<any> {
  return catsRequest('GET', state.httpBaseUrl, '/api/relay/config', undefined, state.token);
}

async function fetchCatsRelayKey(state: CatsAuthState): Promise<any> {
  return catsRequest('GET', state.httpBaseUrl, '/api/relay/key', undefined, state.token);
}

async function revealCatsRelayKey(state: CatsAuthState): Promise<any> {
  return catsRequest('POST', state.httpBaseUrl, '/api/relay/key/reveal', {}, state.token);
}

async function ensureCatsRelayPlainKey(
  state: CatsAuthState,
  options: { rotateExisting?: boolean } = {},
): Promise<{ response: any; plainKey: string; created: boolean; rotated: boolean; revealed: boolean }> {
  const current = await fetchCatsRelayKey(state);
  const currentKey = current?.key;
  const active = currentKey && String(currentKey.state || 'active') === 'active';
  const currentPlainKey = String(currentKey?.key || '').trim();

  if (active && currentPlainKey) {
    return { response: current, plainKey: currentPlainKey, created: false, rotated: false, revealed: false };
  }

  const reusableLocalKey = active ? findReusableLocalRelayKey(currentKey) : undefined;
  if (reusableLocalKey) {
    return { response: current, plainKey: reusableLocalKey, created: false, rotated: false, revealed: false };
  }

  if (active && !options.rotateExisting) {
    try {
      const revealed = await revealCatsRelayKey(state);
      const revealedPlainKey = String(revealed?.key?.key || '').trim();
      if (revealedPlainKey) {
        return { response: revealed, plainKey: revealedPlainKey, created: false, rotated: false, revealed: true };
      }
    } catch {
      // Older CatsCompany / relay deployments may not expose reveal yet. Fall
      // through to the explicit rotation prompt instead of failing silently.
    }
    throw httpError(
      '已有 CatsCo 中转 Key，但当前无法读取明文。请确认是否重新生成后再启用中转模型。',
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
    revealed: false,
  };
}

function findReusableLocalRelayKey(currentKey: any): string | undefined {
  const fileEnv = readEnvFile();
  const currentConfig = ConfigManager.getConfigReadonly();
  const apiKey = firstNonEmpty(
    process.env.CATSCO_RELAY_LLM_API_KEY,
    fileEnv.CATSCO_RELAY_LLM_API_KEY,
    process.env.GAUZ_LLM_API_KEY,
    fileEnv.GAUZ_LLM_API_KEY,
    currentConfig.apiKey,
  );
  const apiBase = firstNonEmpty(
    process.env.CATSCO_RELAY_LLM_API_BASE,
    fileEnv.CATSCO_RELAY_LLM_API_BASE,
    process.env.GAUZ_LLM_API_BASE,
    fileEnv.GAUZ_LLM_API_BASE,
    currentConfig.apiUrl,
  );
  if (!apiKey || !isCatsRelayApiBase(apiBase)) {
    return undefined;
  }
  if (!isLocalRelayPlainKeyCandidate(apiKey)) {
    return undefined;
  }

  const prefix = String(currentKey?.prefix || '').trim();
  if (!isReusableRelayKeyPrefix(prefix) || !matchesRelayKeyPrefix(apiKey, prefix)) {
    return undefined;
  }

  return apiKey;
}

function isReusableRelayKeyPrefix(prefix: string): boolean {
  if (!prefix || /\s/.test(prefix)) return false;
  const marker = '...';
  const markerIndex = prefix.indexOf(marker);
  if (markerIndex < 0 || markerIndex !== prefix.lastIndexOf(marker)) return false;
  const start = prefix.slice(0, markerIndex);
  const end = prefix.slice(markerIndex + marker.length);
  return /^sk-[A-Za-z0-9_-]+$/.test(start) && start.length >= 8 && /^[A-Za-z0-9_-]{4,}$/.test(end);
}

function isLocalRelayPlainKeyCandidate(apiKey: string): boolean {
  return /^sk-[A-Za-z0-9_-]{12,}$/.test(apiKey) && !apiKey.includes('...');
}

function matchesRelayKeyPrefix(apiKey: string, prefix: string): boolean {
  const marker = '...';
  const markerIndex = prefix.indexOf(marker);
  if (markerIndex < 0 || markerIndex !== prefix.lastIndexOf(marker)) return false;
  const start = prefix.slice(0, markerIndex);
  const end = prefix.slice(markerIndex + marker.length);
  return Boolean(start && end && apiKey.startsWith(start) && apiKey.endsWith(end));
}

async function setupCatsRelayModelForDesktop(
  state: CatsAuthState,
  requestedModel: unknown,
  options: { rotateExisting?: boolean } = {},
): Promise<Record<string, unknown>> {
  const config = await fetchCatsRelayConfig(state);
  if (config?.self_service_enabled === false) {
    return {
      ok: false,
      skipped: true,
      reason: 'CatsCo 中转自助 Key 尚未启用',
    };
  }

  const preferredModel = preferredRelayModelRequest(requestedModel);
  const selectedModel = selectRelayModel(config, preferredModel, { strict: Boolean(String(requestedModel || '').trim()) });
  const ensured = await ensureCatsRelayPlainKey(state, {
    rotateExisting: options.rotateExisting,
  });
  const settingsResult = writeRelayModelStartupConfig(selectedModel, ensured.plainKey);

  return {
    ok: true,
    protocol: normalizeRelayModelProtocol(selectedModel.provider),
    provider: selectedModel.provider,
    apiBase: selectedModel.baseUrl,
    model: selectedModel.model,
    selectedModel: relayModelPayload(selectedModel),
    updated: settingsResult.updated,
    key: sanitizeRelayKeyInfo(ensured.response?.key),
    createdKey: ensured.created,
    rotatedKey: ensured.rotated,
    revealedKey: ensured.revealed,
  };
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
    if (typeof value === 'string') {
      safe[key] = sanitizeCatsErrorMessage(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function sanitizeCatsErrorMessage(value: unknown): string {
  return String(value || '请求失败')
    .replace(/cats_svc_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\bAuthorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9+.-]*\s+)?[^\s,;'"`<>]+/gi, 'Authorization: [redacted-token]')
    .replace(/\b(?:Bearer|ApiKey|Token)\s+[A-Za-z0-9._~+/=-]+/gi, match => `${match.split(/\s+/)[0]} [redacted-token]`)
    .replace(/(["']?)([A-Za-z0-9_.-]*(?:token|api[_-]?key|secret|password)[A-Za-z0-9_.-]*)\1\s*[:=]\s*["']?[^&\s,'"`<>}]+["']?/gi, '$1$2$1=[redacted-token]');
}

function catsErrorResponse(error: any): { status: number; body: Record<string, unknown> } {
  const body: Record<string, unknown> = { error: sanitizeCatsErrorMessage(error.message) };
  const data = sanitizeCatsErrorData(error.data);
  if (data) body.data = data;
  return { status: error.status || 500, body };
}

function relayKeyErrorResponse(error: any): { status: number; body: Record<string, unknown> } {
  const message = sanitizeCatsErrorMessage(error?.message || error);
  const body: Record<string, unknown> = {
    error: `CatsCo 中转 Key 重新生成失败：${message}。请在 CatsCo 中转站点击“撤销”删除当前 Key，然后回到 Dashboard 重新选择模型；系统会自动创建并写入新的 Key。`,
    action: 'relay_key_reset_required',
  };
  const data = sanitizeCatsErrorData(error?.data);
  if (data) body.data = data;
  return { status: error?.status || 502, body };
}

function activateCatsCompanyConnector(
  serviceManager: ServiceManager,
  options: { startIfStopped?: boolean } = {},
): {
  wasRunning: boolean;
  restartRequested: boolean;
  startRequested: boolean;
  startBlocked: boolean;
  restartError?: string;
  startError?: string;
} {
  const getService = typeof (serviceManager as any).getService === 'function'
    ? serviceManager.getService.bind(serviceManager)
    : undefined;
  const restart = typeof (serviceManager as any).restart === 'function'
    ? serviceManager.restart.bind(serviceManager)
    : undefined;
  const start = typeof (serviceManager as any).start === 'function'
    ? serviceManager.start.bind(serviceManager)
    : undefined;
  if (!getService) {
    return { wasRunning: false, restartRequested: false, startRequested: false, startBlocked: false };
  }

  const service = getService('catscompany');
  if (service?.status === 'running') {
    if (!restart) {
      return {
        wasRunning: true,
        restartRequested: false,
        startRequested: false,
        startBlocked: false,
        restartError: 'CatsCompany connector restart is unavailable',
      };
    }
    try {
      restart('catscompany');
      return { wasRunning: true, restartRequested: true, startRequested: false, startBlocked: false };
    } catch (error: any) {
      return {
        wasRunning: true,
        restartRequested: false,
        startRequested: false,
        startBlocked: false,
        restartError: error?.message || String(error),
      };
    }
  }

  if (!options.startIfStopped || !start || !service) {
    return { wasRunning: false, restartRequested: false, startRequested: false, startBlocked: false };
  }

  try {
    const preflight = getServicePreflight(serviceManager, 'catscompany', {
      runtimeRoot: process.cwd(),
      config: ConfigManager.getConfigReadonly(),
    });
    if (preflight.status === 'blocked') {
      return { wasRunning: false, restartRequested: false, startRequested: false, startBlocked: true };
    }
    start('catscompany');
    return { wasRunning: false, restartRequested: false, startRequested: true, startBlocked: false };
  } catch (error: any) {
    return {
      wasRunning: false,
      restartRequested: false,
      startRequested: false,
      startBlocked: false,
      startError: error?.message || String(error),
    };
  }
}

function persistCatsUserSession(state: CatsAuthState, login: any): void {
  createCatsCoLocalConfigService({ runtimeRoot: process.cwd() }).persistAccountSession(state, login);
}

async function getCatsCoAuthForSkillHub(): Promise<{
  token: string;
  baseUrl: string;
  user: {
    uid?: string;
    username?: string;
    displayName?: string;
  };
}> {
  const state = getCatsAuthState();
  if (!state.token) {
    const error = httpError('CatsCo login is required before connecting SkillHub', 401);
    (error as any).code = 'skillhub.catsco_login_required';
    throw error;
  }
  const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token, { timeoutMs: 6000 });
  return {
    token: state.token,
    baseUrl: state.httpBaseUrl,
    user: {
      uid: String(me.uid || state.uid || '').trim() || undefined,
      username: String(me.username || state.username || '').trim() || undefined,
      displayName: String(me.display_name || me.displayName || state.displayName || me.username || '').trim() || undefined,
    },
  };
}

export function createApiRouter(serviceManager: ServiceManager, updateController?: UpdateController): Router {
  const router = Router();
  registerSkillHubRoutes(router, { getCatsCoAuth: getCatsCoAuthForSkillHub });
  registerPetRoutes(router);

  // ==================== 总览 ====================

  
  router.get('/status', (_req, res) => {
    const config = ConfigManager.getConfigReadonly();
    const contextWindow = resolveModelContextWindow(config);
    const services = serviceManager.getAll();
    res.json({
      version: APP_VERSION,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      model: config.model,
      provider: config.provider,
      contextWindow,
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

  router.get('/prompts', async (_req, res) => {
    try {
      res.json(await getPromptEditorState());
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/prompts/branch-agents', (_req, res) => {
    try {
      res.json(getPromptBranchAgentsState());
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.put('/prompts/branch-agents', (req, res) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const value = serializeBranchAgentsEnabled(req.body.enabled);
      const result = writeDashboardEnvUpdates(process.cwd(), {
        [BRANCH_AGENTS_ENABLED_ENV]: value,
      });
      process.env[BRANCH_AGENTS_ENABLED_ENV] = value;
      res.json({
        ok: true,
        ...getPromptBranchAgentsState(),
        updated: result.updated,
        cleared: result.cleared,
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.get('/prompts/file', (req, res) => {
    try {
      res.json(getPromptEditorFile(String(req.query.path || '')));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.put('/prompts/file', (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(writePromptOverride(String(req.body?.path || ''), String(req.body?.content ?? '')));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.delete('/prompts/file', (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(deletePromptOverride(String(req.body?.path || req.query.path || '')));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  router.post('/prompts/editor-skill/install', (req, res) => {
    try {
      if (!requireJsonWrite(req, res)) return;
      res.json(installPromptEditorSeedSkill({
        overwrite: req.body?.overwrite === true,
      }));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || String(e) });
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
      const previousModel = modelProfileFromCurrentConfig();
      const previousSource = storedModelSource();
      const result = updateDashboardSettings(req.body, { runtimeRoot: process.cwd() });
      const changedModelSettings = result.updated.some(key => key.startsWith('GAUZ_LLM_'))
        || result.cleared.some(key => key.startsWith('GAUZ_LLM_'));
      if (changedModelSettings) {
        mirrorCurrentModelAsCustomStartup(req.body, previousModel, previousSource);
      }
      const restartInfo = req.body?.restartConnector === true && changedModelSettings
        ? activateCatsCompanyConnector(serviceManager)
        : { wasRunning: false, restartRequested: false, startRequested: false, startBlocked: false };
      res.json({
        ...result,
        connectorRestarted: restartInfo.restartRequested,
        restartError: restartInfo.restartError ? sanitizeCatsErrorMessage(restartInfo.restartError) : undefined,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/model-source/custom/apply', (req, res) => {
    try {
      const result = writeCustomModelStartupConfig();
      const activation = activateCatsCompanyConnector(serviceManager, {
        startIfStopped: req.body?.activateConnector === true || req.body?.startConnector === true,
      });
      res.json({
        ok: true,
        source: 'custom',
        provider: result.profile.provider,
        apiBase: sanitizePublicUrl(result.profile.apiBase),
        model: result.profile.model,
        contextWindowTokens: result.profile.contextWindowTokens,
        contextLabel: result.profile.contextWindowTokens ? formatContextWindowTokens(result.profile.contextWindowTokens) : undefined,
        updated: result.updated,
        cleared: result.cleared,
        restartRequired: activation.wasRunning && !activation.restartRequested,
        connectorRestarted: activation.restartRequested,
        connectorStarted: activation.startRequested,
        connectorStartBlocked: activation.startBlocked,
        restartError: activation.restartError ? sanitizeCatsErrorMessage(activation.restartError) : undefined,
        startError: activation.startError ? sanitizeCatsErrorMessage(activation.startError) : undefined,
        message: activation.restartRequested
          ? '已切换为自定义模型，并已请求重启 CatsCo agent。'
          : activation.startRequested
          ? '已切换为自定义模型，并已启动 CatsCompany connector。'
          : activation.wasRunning
          ? '已切换为自定义模型；但 CatsCo agent 自动重启失败，请手动重启后使用新配置。'
          : activation.startBlocked
          ? '已切换为自定义模型；完成 CatsCo 连接后点击“检查并启动”即可使用新配置。'
          : '已切换为自定义模型；下次启动 connector 会使用新配置。',
      });
    } catch (e: any) {
      res.status(e.status || 400).json({
        error: sanitizeCatsErrorMessage(e.message),
        reason: e.reason,
      });
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
          masked[key] = masked[key]
            ? masked[key].length > 4
              ? `****${masked[key].slice(-4)}`
              : '****'
            : '';
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
        'WEIXIN_BOUND_AGENT_UID',
        'WEIXIN_BOUND_AGENT_NAME',
        'WEIXIN_BOUND_BODY_ID',
        'WEIXIN_BOUND_BY_USER_UID',
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
      const active = await Promise.all(manager.getAllSkills().map(skillToDashboardPayload));
      const disabled = await findAllDisabledSkills(PathResolver.getSkillsPath());
      res.json([...active, ...disabled]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      res.json(await Promise.all(manager.getAllSkills().map(skillToDashboardPayload)));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills-root', async (_req, res) => {
    try {
      const skillsRoot = PathResolver.getSkillsPath();
      PathResolver.ensureDir(skillsRoot);
      res.json({ ok: true, path: skillsRoot });
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

  router.get('/weixin/channel-binding', (_req, res) => {
    try {
      res.json(sanitizeWeixinChannelStatus(getWeixinChannelStatus({
        runtimeRoot: process.cwd(),
        env: process.env,
      })));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/weixin/qrcode', async (_req, res) => {
    try {
      const status = getWeixinChannelStatus({
        runtimeRoot: process.cwd(),
        env: process.env,
      });
      if (!status.currentAgent) {
        return res.status(409).json({
          error: status.reason || '请先在 CatsCo Chat 中选择并绑定 agent，再绑定微信通道',
          channelStatus: sanitizeWeixinChannelStatus(status),
        });
      }
      const response = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
      const data = await response.json() as Record<string, any>;
      if (!response.ok) {
        return res.status(response.status).json({
          error: String(data?.error || data?.message || '获取微信二维码失败'),
        });
      }
      res.json({
        ...data,
        agent_uid: status.currentAgent.uid,
        agent: status.currentAgent,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/weixin/qrcode-status', async (req, res) => {
    try {
      const qrcode = req.query.qrcode as string;
      const expectedAgentUid = String(req.query.agent_uid || '').trim();
      if (!qrcode) return res.status(400).json({ error: 'qrcode required' });
      const status = getWeixinChannelStatus({
        runtimeRoot: process.cwd(),
        env: process.env,
      });
      if (!status.currentAgent) {
        return res.status(409).json({
          error: status.reason || '请先在 CatsCo Chat 中选择并绑定 agent，再绑定微信通道',
          channelStatus: sanitizeWeixinChannelStatus(status),
        });
      }
      if (expectedAgentUid && expectedAgentUid !== status.currentAgent.uid) {
        return res.status(409).json({
          error: `扫码开始时的 agent 是 ${expectedAgentUid}，当前 agent 是 ${status.currentAgent.uid}，请重新扫码`,
          channelStatus: sanitizeWeixinChannelStatus(status),
        });
      }
      const response = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
      const data = await response.json() as Record<string, any>;
      if (!response.ok) {
        return res.status(response.status).json({
          error: String(data?.error || data?.message || '微信授权状态检查失败'),
        });
      }
      const safeData = { ...data };
      delete safeData.bot_token;
      const botToken = String(data?.bot_token || '').trim();
      if (data?.status === 'confirmed' && botToken) {
        const result = bindWeixinChannelToCurrentAgent({
          token: botToken,
          runtimeRoot: process.cwd(),
          env: process.env,
          expectedAgentUid: expectedAgentUid || status.currentAgent.uid,
        });
        return res.json({
          ...safeData,
          token_saved: true,
          ...sanitizeWeixinBindingResult(result),
        });
      }
      res.json(safeData);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== CatsCo webapp 本地连接器 ====================

  router.get('/cats/status', async (_req, res) => {
    const runtime = resolveCatsCoRuntimeConfig({
      runtimeRoot: process.cwd(),
      config: ConfigManager.getConfigReadonly(),
    });
    const state = runtime.auth;
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

    const localBodyId = runtime.localConfig.device?.bodyId;
    const bodyStatus = await getCatsBotBodyStatus(state, state.botUid, localBodyId);
    const bodyBlocking = bodyStatus.state === 'conflict' || bodyStatus.state === 'auth_error';
    const chatReady = connected && runtime.bodyConfigured && !bodyBlocking;

    res.json({
      connected,
      configured: chatReady,
      bodyConfigured: runtime.bodyConfigured,
      connectorReady: runtime.connectorReady,
      chatReady,
      unconfirmedBotBinding: runtime.unconfirmedBotBinding,
      tokenPresent,
      authStatus,
      authError,
      user,
      botUid: state.botUid || null,
      bot: runtime.localConfig.currentBot ? {
        uid: runtime.localConfig.currentBot.uid,
        name: runtime.localConfig.currentBot.name || '',
        username: runtime.localConfig.currentBot.username || '',
      } : null,
      device: runtime.localConfig.device || null,
      bodyStatus,
      conflicts: runtime.conflicts,
      topicId: chatReady && user?.uid && state.botUid ? p2pTopicId(user.uid, state.botUid) : '',
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
      }, undefined, { timeoutMs: 10000 });
      const login = await catsRequest('POST', state.httpBaseUrl, '/api/auth/login', {
        account: email,
        password,
      }, undefined, { timeoutMs: 10000 });
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

      const login = await catsRequest('POST', state.httpBaseUrl, '/api/auth/login', { account, password }, undefined, { timeoutMs: 10000 });
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
    const removed = createCatsCoLocalConfigService({ runtimeRoot: process.cwd() }).clearAccount();
    res.json({ ok: true, removed });
  });

  router.post('/cats/desktop-connect', async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim();
      if (!code) return res.status(400).json({ error: 'code is required' });

      const state = trustCatsAuthStateEndpoints(getCatsAuthState(req.body || {}));
      const login = await catsRequest('POST', state.httpBaseUrl, '/api/desktop-connect/exchange', { code }, undefined, { timeoutMs: 8000 });
      const httpBaseUrl = normalizeTrustedCatsHttpBaseUrl(login.http_base_url || login.httpBaseUrl || state.httpBaseUrl || DEFAULT_CATSCO_HTTP_BASE_URL);
      const serverUrl = normalizeTrustedCatsServerUrl(login.server_url || login.serverUrl || state.serverUrl || DEFAULT_CATSCO_WS_URL);
      const nextState: CatsAuthState = {
        ...state,
        token: String(login.token || '').trim(),
        uid: String(login.uid || '').trim(),
        username: String(login.username || '').trim(),
        displayName: String(login.display_name || login.displayName || login.username || '').trim(),
        httpBaseUrl,
        serverUrl,
      };
      persistCatsUserSession(nextState, login);
      res.json({
        ok: true,
        user: {
          uid: nextState.uid,
          username: nextState.username,
          display_name: nextState.displayName,
        },
        httpBaseUrl: nextState.httpBaseUrl,
        serverUrl: nextState.serverUrl,
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.post('/cats/setup', async (req, res) => {
    try {
      const state = trustCatsAuthStateEndpoints(getCatsAuthState(req.body || {}));
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });
      if (req.body?.botUid) {
        return res.status(409).json({ error: 'Legacy setup no longer accepts botUid; use /api/cats/bind-bot' });
      }

      const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token);
      const userUid = String(me.uid || state.uid || '');
      if (!userUid) return res.status(500).json({ error: 'CatsCo user uid missing' });

      const botsResponse = await catsRequest('GET', state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = Array.isArray(botsResponse?.bots) ? botsResponse.bots : [];
      const deviceId = ensureCatsDeviceId();
      const deviceName = String(req.body?.deviceName || os.hostname() || 'current-device').trim();
      const preferredUsername = sanitizeCatsUsernamePart(String(req.body?.botUsername || `catsco_${userUid}_${deviceId}`))
        || `catsco_${userUid}_${deviceId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      const preferredName = String(req.body?.botDisplayName || `CatsCo (${deviceName})`).trim() || `CatsCo (${deviceName})`;
      let botSelectionSource: 'last-used' | 'first-owned-bot' | 'created-default' = 'first-owned-bot';
      let bot = state.botUid
        ? bots.find((item: any) => String(item.id || item.uid || '') === String(state.botUid))
        : undefined;
      if (bot) {
        botSelectionSource = 'last-used';
      } else if (bots.length > 0) {
        bot = bots[0];
        botSelectionSource = 'first-owned-bot';
      }

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
        botSelectionSource = 'created-default';
      }

      const botUid = String(bot.id || bot.uid || '');
      if (!botUid) return res.status(500).json({ error: 'CatsCo bot uid missing' });

      const apiKey = await getCatsBotApiKey(state, botUid, bot);

      const relayState: CatsAuthState = {
        ...state,
        uid: userUid,
        username: me.username || state.username || '',
        displayName: me.display_name || me.username || state.displayName || '',
      };
      let relayModelSetup: Record<string, unknown> | undefined;
      if (req.body?.setupRelayModel !== false) {
        try {
          relayModelSetup = await setupCatsRelayModelForDesktop(
            relayState,
            req.body?.relayModelId || req.body?.modelId || req.body?.model,
            {
              rotateExisting: req.body?.rotateRelayKey === true || req.body?.rotateExisting === true,
            },
          );
        } catch (relayError: any) {
          const message = sanitizeCatsErrorMessage(relayError?.message || relayError);
          const status = relayError?.status || 500;
          relayModelSetup = {
            ok: false,
            error: message,
            status,
            action: status === 409 ? 'rotate_required' : undefined,
          };
          return res.status(status).json({
            ok: false,
            error: message,
            action: status === 409 ? 'rotate_required' : undefined,
            relayModelSetup,
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
          });
        }
      }

      const result = await commitCatsBotBindingAndStartConnector(serviceManager, state, {
        userUid,
        username: me.username || state.username || '',
        displayName: me.display_name || me.username || state.displayName || '',
        botUid,
        botName: bot.display_name || preferredName,
        botUsername: bot.username || preferredUsername,
        apiKey,
        bindingSource: 'legacy-setup',
      });

      res.json({
        ok: true,
        updated: result.updated,
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
        service: result.service,
        preflight: result.preflight,
        connectorStarted: result.connectorStarted,
        connectorRestarted: result.connectorRestarted,
        relayModelSetup,
        botSelectionSource,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.get('/cats/bots', async (_req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const data = await catsRequest('GET', state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = Array.isArray(data?.bots) ? data.bots : [];
      const currentBotUid = state.botUid || '';
      const formattedBots = bots.map((bot: any) => ({
        uid: String(bot.id || bot.uid || ''),
        username: String(bot.username || ''),
        display_name: String(bot.display_name || bot.username || ''),
        api_key: '',
        isCurrent: String(bot.id || bot.uid || '') === currentBotUid,
      }));

      res.json({ ok: true, bots: formattedBots, currentBotUid });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.post('/cats/create-bot', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token);
      const userUid = String(me.uid || state.uid || '');
      if (!userUid) return res.status(500).json({ error: 'CatsCo user uid missing' });

      const deviceId = ensureCatsDeviceId();
      const deviceName = String(req.body?.deviceName || os.hostname() || 'current-device').trim();
      const displayName = String(req.body?.botDisplayName || `CatsCo (${deviceName})`).trim() || `CatsCo (${deviceName})`;
      const usernameBase = String(req.body?.botUsername || `catsco_${userUid}_${deviceId}`).trim();
      const username = sanitizeCatsUsernamePart(usernameBase) || `catsco_${userUid}_${deviceId.replace(/[^a-zA-Z0-9_]/g, '_')}`;

      const created = await catsRequest('POST', state.httpBaseUrl, '/api/bots', {
        username,
        display_name: displayName,
      }, state.token);

      res.json({
        ok: true,
        deviceId,
        bot: {
          uid: String(created.uid || created.id || ''),
          username: created.username || username,
          display_name: created.display_name || displayName,
          hasApiKey: Boolean(created.api_key),
        },
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.post('/cats/bind-bot', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const botUid = String(req.body?.botUid || '').trim();
      if (!botUid) return res.status(400).json({ error: 'botUid is required' });

      const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token);
      const userUid = String(me.uid || state.uid || '');
      if (!userUid) return res.status(500).json({ error: 'CatsCo user uid missing' });

      const data = await catsRequest('GET', state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = Array.isArray(data?.bots) ? data.bots : [];
      const targetBot = bots.find((bot: any) => String(bot.id || bot.uid || '') === botUid);
      if (!targetBot) return res.status(404).json({ error: 'Bot not found' });

      const apiKey = await getCatsBotApiKey(state, botUid, targetBot);
      const relayState: CatsAuthState = {
        ...state,
        uid: userUid,
        username: me.username || state.username || '',
        displayName: me.display_name || me.username || state.displayName || '',
      };
      let relayModelSetup: Record<string, unknown> | undefined;
      if (req.body?.setupRelayModel !== false) {
        try {
          relayModelSetup = await setupCatsRelayModelForDesktop(
            relayState,
            req.body?.relayModelId || req.body?.modelId || req.body?.model,
            {
              rotateExisting: req.body?.rotateRelayKey === true || req.body?.rotateExisting === true,
            },
          );
        } catch (relayError: any) {
          const message = sanitizeCatsErrorMessage(relayError?.message || relayError);
          const status = relayError?.status || 500;
          relayModelSetup = {
            ok: false,
            error: message,
            status,
            action: status === 409 ? 'rotate_required' : undefined,
          };
          return res.status(status).json({
            ok: false,
            error: message,
            action: status === 409 ? 'rotate_required' : undefined,
            relayModelSetup,
            user: {
              uid: userUid,
              username: me.username || state.username || '',
              display_name: me.display_name || me.username || state.displayName || '',
            },
            bot: {
              uid: botUid,
              username: targetBot.username || '',
              display_name: targetBot.display_name || targetBot.username || 'Bot',
            },
            topicId: p2pTopicId(userUid, botUid),
          });
        }
      }
      const result = await commitCatsBotBindingAndStartConnector(serviceManager, state, {
        userUid,
        username: me.username || state.username || '',
        displayName: me.display_name || me.username || state.displayName || '',
        botUid,
        botName: targetBot.display_name || targetBot.username || 'Bot',
        botUsername: targetBot.username || '',
        apiKey,
        bindingSource: 'explicit-bind',
      });
      const botName = String(targetBot.display_name || targetBot.username || 'Bot');

      res.json({
        ok: true,
        updated: result.updated,
        user: {
          uid: userUid,
          username: me.username || state.username || '',
          display_name: me.display_name || me.username || state.displayName || '',
        },
        bot: { uid: botUid, username: targetBot.username || '', display_name: botName },
        topicId: p2pTopicId(userUid, botUid),
        service: result.service,
        preflight: result.preflight,
        connectorStarted: result.connectorStarted,
        connectorRestarted: result.connectorRestarted,
        relayModelSetup,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
        message: `已绑定机器人 "${botName}"`,
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.post('/cats/switch-bot', async (req, res) => {
    try {
      const state = getCatsAuthState(req.body || {});
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const botUid = String(req.body?.botUid || '').trim();
      if (!botUid) return res.status(400).json({ error: 'botUid is required' });

      const me = await catsRequest('GET', state.httpBaseUrl, '/api/me', undefined, state.token);
      const userUid = String(me.uid || state.uid || '');
      if (!userUid) return res.status(500).json({ error: 'CatsCo user uid missing' });

      const data = await catsRequest('GET', state.httpBaseUrl, '/api/bots', undefined, state.token);
      const bots = Array.isArray(data?.bots) ? data.bots : [];
      const targetBot = bots.find((bot: any) => String(bot.id || bot.uid || '') === botUid);
      if (!targetBot) return res.status(404).json({ error: 'Bot not found' });

      const apiKey = await getCatsBotApiKey(state, botUid, targetBot);
      const result = await commitCatsBotBindingAndStartConnector(serviceManager, state, {
        userUid,
        username: me.username || state.username || '',
        displayName: me.display_name || me.username || state.displayName || '',
        botUid,
        botName: targetBot.display_name || targetBot.username || 'Bot',
        botUsername: targetBot.username || '',
        apiKey,
        bindingSource: 'explicit-switch',
      });
      const botName = String(targetBot.display_name || targetBot.username || 'Bot');

      res.json({
        ok: true,
        updated: result.updated,
        user: {
          uid: userUid,
          username: me.username || state.username || '',
          display_name: me.display_name || me.username || state.displayName || '',
        },
        bot: { uid: botUid, username: targetBot.username || '', display_name: botName },
        topicId: p2pTopicId(userUid, botUid),
        service: result.service || null,
        preflight: result.preflight,
        connectorStarted: result.connectorStarted,
        connectorRestarted: result.connectorRestarted,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
        message: `已切换到机器人 "${botName}"`,
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
    }
  });

  router.get('/cats/config', async (_req, res) => {
    try {
      res.json(createCatsCoLocalConfigService({ runtimeRoot: process.cwd() }).toDashboardConfigPayload());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/cats/config/preferences', async (req, res) => {
    try {
      const preferences = createCatsCoLocalConfigService({ runtimeRoot: process.cwd() }).updatePreferences(req.body || {});
      res.json({ ok: true, preferences });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/cats/relay/model-config', async (req, res) => {
    try {
      const state = getCatsAuthState();
      if (!state.token) return res.status(401).json({ error: 'CatsCo user token is missing' });

      const config = await fetchCatsRelayConfig(state);
      const currentConfig = getModelConfigReadonly();
      const requestedModel = req.query.modelId || req.query.model;
      const selectedModel = selectRelayModel(
        config,
        requestedModel || currentConfig.model,
        { strict: Boolean(requestedModel) },
      );
      const keyResponse = config?.self_service_enabled ? await fetchCatsRelayKey(state) : { key: null };
      const apiBase = selectedModel.baseUrl;
      const provider = selectedModel.provider;
      const model = selectedModel.model;
      const currentApiBase = String(currentConfig.apiUrl || '').replace(/\/+$/, '');

      res.json({
        ok: true,
        protocol: normalizeRelayModelProtocol(selectedModel.provider),
        provider,
        apiBase,
        model,
        selectedModel: relayModelPayload(selectedModel),
        models: relayModelCatalog(config).map(relayModelPayload),
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

      const config = await fetchCatsRelayConfig(state);
      const requestedModel = req.body?.modelId || req.body?.model;
      const selectedModel = selectRelayModel(config, requestedModel, { strict: Boolean(requestedModel) });
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
            error: sanitizeCatsErrorMessage(error.message),
            action: 'rotate_required',
            protocol: normalizeRelayModelProtocol(selectedModel.provider),
            model: relayModelPayload(selectedModel),
            key: sanitizeRelayKeyInfo((await fetchCatsRelayKey(state))?.key),
          });
        }
        const payload = relayKeyErrorResponse(error);
        return res.status(payload.status).json(payload.body);
      }

      const apiBase = selectedModel.baseUrl;
      const provider = selectedModel.provider;
      const model = selectedModel.model;
      const settingsResult = writeRelayModelStartupConfig(selectedModel, ensured.plainKey);
      const restartInfo = activateCatsCompanyConnector(serviceManager, {
        startIfStopped: req.body?.activateConnector === true || req.body?.startConnector === true,
      });

      res.json({
        ok: true,
        protocol: normalizeRelayModelProtocol(selectedModel.provider),
        provider,
        apiBase,
        model,
        selectedModel: relayModelPayload(selectedModel),
        models: relayModelCatalog(config).map(relayModelPayload),
        updated: settingsResult.updated,
        key: sanitizeRelayKeyInfo(ensured.response?.key),
        createdKey: ensured.created,
        rotatedKey: ensured.rotated,
        revealedKey: ensured.revealed,
        restartRequired: restartInfo.wasRunning && !restartInfo.restartRequested,
        connectorRestarted: restartInfo.restartRequested,
        connectorStarted: restartInfo.startRequested,
        connectorStartBlocked: restartInfo.startBlocked,
        restartError: restartInfo.restartError ? sanitizeCatsErrorMessage(restartInfo.restartError) : undefined,
        startError: restartInfo.startError ? sanitizeCatsErrorMessage(restartInfo.startError) : undefined,
        message: restartInfo.restartRequested
          ? '已启用 CatsCo 中转模型，并已请求重启 CatsCo agent 以使用新配置。'
          : restartInfo.startRequested
          ? '已启用 CatsCo 中转模型，并已启动 CatsCompany connector 使用新配置。'
          : restartInfo.wasRunning
          ? '已启用 CatsCo 中转模型；但 CatsCo agent 自动重启失败，请手动重启后使用新配置。'
          : restartInfo.startBlocked
          ? '已启用 CatsCo 中转模型；完成 CatsCo 连接后点击“检查并启动”即可使用新配置。'
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
      const fileTokens = Array.isArray(req.body?.file_tokens)
        ? req.body.file_tokens.map((token: unknown) => String(token || '').trim()).filter(Boolean)
        : [];
      if (!topicId || (!content && fileTokens.length === 0)) {
        return res.status(400).json({ error: 'topic_id and content/file_tokens are required' });
      }
      assertCurrentCatsTopic(state, topicId);
      const attachments: CatsUploadedLocalAttachment[] = [];
      for (const fileToken of fileTokens) {
        attachments.push(await uploadCatsGrantedAttachment(state, fileToken));
      }
      const contentBlocks = attachments.length > 0
        ? [
            ...(content ? [{ type: 'text', text: content }] : []),
            ...attachments.map(item => item.contentBlock),
          ]
        : [];
      const displayContent = content || summarizeCatsAttachments(attachments);
      const data = await catsRequest('POST', state.httpBaseUrl, '/api/messages/send', {
        topic_id: topicId,
        type: 'text',
        content: displayContent,
        ...(contentBlocks.length > 0 ? { content_blocks: contentBlocks } : {}),
      }, state.token);
      res.json({
        ...data,
        ok: true,
        files: attachments.map(item => ({
          type: item.type,
          file: item.file,
          upload: item.upload,
        })),
      });
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

      const attachment = await uploadCatsGrantedAttachment(state, fileToken);
      const data = await catsRequest('POST', state.httpBaseUrl, '/api/messages/send', {
        topic_id: topicId,
        type: attachment.type,
        content: attachment.contentBlock,
      }, state.token);

      res.json({
        ok: true,
        type: attachment.type,
        file: attachment.file,
        upload: attachment.upload,
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

function installPromptEditorSeedSkill(options: { overwrite?: boolean } = {}): any {
  const sourceDir = resolvePromptEditorSeedSkillDir();
  const sourceSkillFile = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(sourceSkillFile)) {
    throw new Error('Prompt editor seed skill is missing from this build.');
  }

  const skillsRoot = PathResolver.getSkillsPath();
  PathResolver.ensureDir(skillsRoot);
  const targetDir = resolveChildDirectory(skillsRoot, PROMPT_EDITOR_SKILL_NAME);
  const targetSkillFile = path.join(targetDir, 'SKILL.md');
  const disabledSkillFile = targetSkillFile + '.disabled';
  const targetDirExists = fs.existsSync(targetDir);
  const existing = targetDirExists || fs.existsSync(targetSkillFile) || fs.existsSync(disabledSkillFile);

  if (existing && !options.overwrite) {
    return {
      ok: true,
      installed: false,
      existing: true,
      name: PROMPT_EDITOR_SKILL_NAME,
      path: fs.existsSync(targetSkillFile)
        ? targetSkillFile
        : (fs.existsSync(disabledSkillFile) ? disabledSkillFile : targetDir),
      disabled: !fs.existsSync(targetSkillFile),
    };
  }

  if (targetDirExists) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(targetSkillFile), { recursive: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: source => {
      const name = path.basename(source).toLowerCase();
      return name !== '.git' && name !== 'node_modules' && name !== '__pycache__';
    },
  });

  return {
    ok: true,
    installed: true,
    existing: false,
    name: PROMPT_EDITOR_SKILL_NAME,
    path: targetSkillFile,
  };
}

function requireJsonWrite(req: any, res: any): boolean {
  if (req.is('application/json')) return true;
  res.status(415).json({ error: 'application/json required' });
  return false;
}

function resolvePromptEditorSeedSkillDir(): string {
  const candidates = [
    process.env.XIAOBA_APP_ROOT,
    process.cwd(),
    path.resolve(__dirname, '../../..'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const skillDir = path.join(path.resolve(candidate), 'skills', PROMPT_EDITOR_SKILL_NAME);
    if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
      return skillDir;
    }
  }

  return path.join(path.resolve(candidates[0] || process.cwd()), 'skills', PROMPT_EDITOR_SKILL_NAME);
}

function resolveChildDirectory(rootDir: string, childName: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, childName);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe target path: ${childName}`);
  }
  return target;
}

// ==================== Helpers ====================

function getSkillFiles(skillFilePath: string): string[] {
  try {
    const dir = path.dirname(skillFilePath);
    return fs.readdirSync(dir).filter(e => !e.startsWith('.') && e !== '__pycache__');
  } catch { return []; }
}

async function skillToDashboardPayload(skill: Skill): Promise<any> {
  const installInfo = await getSkillHubInstallInfo(skill);
  const skillDir = path.dirname(skill.filePath);
  const skillsRoot = PathResolver.getSkillsPath();
  return {
    name: skill.metadata.name,
    description: skill.metadata.description,
    argumentHint: skill.metadata.argumentHint || null,
    userInvocable: skill.metadata.userInvocable !== false,
    path: skill.filePath,
    folder: path.basename(skillDir),
    relativePath: path.relative(skillsRoot, skillDir),
    files: getSkillFiles(skill.filePath),
    enabled: true,
    skillHub: installInfo,
    ...getSkillManagementInfo(skill.filePath),
  };
}

async function getSkillHubInstallInfo(skill: Skill): Promise<any> {
  const metadata = readSkillHubLocalMetadata(skill.filePath);
  if (!metadata?.author || !metadata.version || !metadata.uploadedAt) return null;
  const skillId = `${metadata.author}/${skill.metadata.name}`;
  const info: any = {
    author: metadata.author,
    version: metadata.version,
    uploadedAt: metadata.uploadedAt,
    modified: 'unknown',
    syncStatus: 'check_failed',
    syncLabel: '未校验',
  };
  try {
    const version = await new SkillHubService().getPublishedVersion(skillId, metadata.version);
    if (version?.contentHash) {
      const localHash = computeLocalSkillContentHash(path.dirname(skill.filePath));
      const modified = localHash !== version.contentHash;
      info.modified = modified;
      info.syncStatus = modified ? 'local_changes' : 'synced';
      info.syncLabel = modified ? '本地有改动' : '已同步';
    } else {
      info.modified = 'unknown';
      info.syncStatus = 'check_failed';
      info.syncLabel = '未校验';
    }
  } catch (error: any) {
    info.modified = 'unknown';
    if (Number(error?.status) === 404) {
      info.syncStatus = 'source_removed';
      info.syncLabel = '云端版本不可用';
    } else {
      info.syncStatus = 'check_failed';
      info.syncLabel = '校验失败';
      info.syncError = error?.message || String(error);
    }
  }
  return info;
}

function getSkillManagementInfo(skillFilePath: string): SkillManagementInfo {
  const dir = path.dirname(skillFilePath);
  const skillsRoot = PathResolver.getSkillsPath();
  const relative = path.relative(skillsRoot, dir);
  const parts = relative.split(path.sep).filter(Boolean);
  const source: SkillSource = parts.some(part => SYSTEM_SKILL_DIRS.has(part)) ? 'system' : 'user';

  return {
    source,
    protected: source === 'system',
    canDisable: source !== 'system',
    canDelete: source === 'user',
    canShare: source === 'user',
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
  for (const disabledFile of findStructuredDisabledSkillFiles(basePath)) {
    const content = fs.readFileSync(disabledFile, 'utf-8');
    const m = content.match(/name:\s*(.+)/);
    if (m && m[1].trim() === name) {
      return disabledFile;
    }
  }
  return null;
}

function findAllDisabledSkills(basePath: string): any[] {
  const results: any[] = [];
  for (const disabledFile of findStructuredDisabledSkillFiles(basePath)) {
    const content = fs.readFileSync(disabledFile, 'utf-8');
    const nm = content.match(/name:\s*(.+)/);
    const desc = content.match(/description:\s*(.+)/);
    const management = getSkillManagementInfo(disabledFile);
    results.push({
      name: nm ? nm[1].trim() : path.basename(path.dirname(disabledFile)),
      description: desc ? desc[1].trim() : '',
      enabled: false,
      path: disabledFile,
      folder: path.basename(path.dirname(disabledFile)),
      relativePath: path.relative(PathResolver.getSkillsPath(), path.dirname(disabledFile)),
      files: getSkillFiles(disabledFile),
      ...management,
    });
  }
  return results;
}

function findStructuredDisabledSkillFiles(basePath: string): string[] {
  if (!fs.existsSync(basePath)) return [];
  return findDisabledSkillFilesRecursive(path.resolve(basePath));
}

function findDisabledSkillFilesRecursive(basePath: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(basePath, entry.name);
    const disabledFile = path.join(fullPath, 'SKILL.md.disabled');
    if (fs.existsSync(disabledFile)) results.push(disabledFile);
    results.push(...findDisabledSkillFilesRecursive(fullPath));
  }
  return results;
}

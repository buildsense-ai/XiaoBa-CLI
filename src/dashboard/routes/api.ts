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
import { SkillHubService } from '../../skillhub/service';
import {
  computeLocalSkillContentHash,
  readSkillHubLocalMetadata,
} from '../../skillhub/local-skill-metadata';
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

interface CatsRequestOptions {
  timeoutMs?: number;
}

type RelayModelProtocol = 'anthropic' | 'openai';

interface RelayModelConfig {
  id: string;
  label: string;
  model: string;
  family?: string;
  provider: 'anthropic' | 'openai';
  protocol: string;
  baseUrl: string;
  enabled: boolean;
  default: boolean;
  quotaClass?: string;
}

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

function normalizeRelayProvider(value: unknown): 'anthropic' | 'openai' {
  return String(value || '').trim().toLowerCase() === 'openai' ? 'openai' : 'anthropic';
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

function canonicalRelayModelName(value: unknown): string {
  const model = String(value || '').trim();
  const key = model.toLowerCase();
  if (key === 'deepseek-v4-flash') return 'deepseek-v4-flash';
  if (key === 'glm-5.1') return 'glm-5.1';
  return model;
}

function normalizeRelayModelConfig(item: any, config: any, index: number): RelayModelConfig | null {
  const model = canonicalRelayModelName(item?.model);
  if (!model) return null;
  const provider: 'anthropic' = 'anthropic';
  const protocol = 'Anthropic-compatible';
  const baseUrl = relayEndpointForProtocol(config, 'anthropic');
  return {
    id: String(item?.id || model || `relay-model-${index}`).trim(),
    label: String(item?.label || model).trim(),
    model,
    family: String(item?.family || '').trim() || undefined,
    provider,
    protocol,
    baseUrl,
    enabled: item?.enabled !== false,
    default: item?.default === true,
    quotaClass: String(item?.quota_class || item?.quotaClass || '').trim() || undefined,
  };
}

function fallbackRelayModelCatalog(config: any): RelayModelConfig[] {
  const baseUrl = relayEndpointForProtocol(config, 'anthropic');
  return [
    {
      id: 'minimax-m2.7',
      label: 'MiniMax M2.7',
      model: 'MiniMax-M2.7',
      family: 'minimax',
      provider: 'anthropic',
      protocol: 'Anthropic-compatible',
      baseUrl,
      enabled: true,
      default: true,
      quotaClass: 'standard',
    },
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      model: 'deepseek-v4-flash',
      family: 'deepseek',
      provider: 'anthropic',
      protocol: 'Anthropic-compatible',
      baseUrl,
      enabled: true,
      default: false,
      quotaClass: 'flash-low',
    },
    {
      id: 'glm-5.1',
      label: 'GLM 5.1',
      model: 'glm-5.1',
      family: 'glm',
      provider: 'anthropic',
      protocol: 'Anthropic-compatible',
      baseUrl,
      enabled: true,
      default: false,
      quotaClass: 'standard',
    },
  ];
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

function relayModelPayload(model: RelayModelConfig): Record<string, unknown> {
  return {
    id: model.id,
    label: model.label,
    model: model.model,
    family: model.family,
    provider: model.provider,
    protocol: model.protocol,
    base_url: model.baseUrl,
    enabled: model.enabled,
    default: model.default,
    quota_class: model.quotaClass,
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

  const selectedModel = selectRelayModel(config, requestedModel, { strict: Boolean(requestedModel) });
  const ensured = await ensureCatsRelayPlainKey(state, {
    rotateExisting: options.rotateExisting,
  });
  const settingsResult = updateDashboardSettings({
    settings: {
      'model.provider': selectedModel.provider,
      'model.apiBase': selectedModel.baseUrl,
      'model.model': selectedModel.model,
      'model.apiKey': { action: 'replace', value: ensured.plainKey },
    },
  }, { runtimeRoot: process.cwd() });

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
          });
        }
      }

      const activation = activateCatsCompanyConnector(serviceManager, { startIfStopped: true });
      const service = serviceManager.getService('catscompany');
      let preflight;
      if (activation.startBlocked) {
        preflight = getServicePreflight(serviceManager, 'catscompany', {
          runtimeRoot: process.cwd(),
          config: ConfigManager.getConfigReadonly(),
        });
      }
      if (activation.restartError || activation.startError) {
        return res.status(500).json({
          ok: false,
          error: sanitizeCatsErrorMessage(activation.restartError || activation.startError || 'CatsCompany connector restart failed'),
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
          relayModelSetup,
          connectorRestarted: activation.restartRequested,
          connectorStarted: activation.startRequested,
          connectorStartBlocked: activation.startBlocked,
          restartError: activation.restartError ? sanitizeCatsErrorMessage(activation.restartError) : undefined,
          startError: activation.startError ? sanitizeCatsErrorMessage(activation.startError) : undefined,
        });
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
        relayModelSetup,
        connectorRestarted: activation.restartRequested,
        connectorStarted: activation.startRequested,
        connectorStartBlocked: activation.startBlocked,
        restartRequired: activation.wasRunning && !activation.restartRequested,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e: any) {
      const payload = catsErrorResponse(e);
      res.status(payload.status).json(payload.body);
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
        throw error;
      }

      const apiBase = selectedModel.baseUrl;
      const provider = selectedModel.provider;
      const model = selectedModel.model;
      const settingsResult = updateDashboardSettings({
        settings: {
          'model.provider': provider,
          'model.apiBase': apiBase,
          'model.model': model,
          'model.apiKey': { action: 'replace', value: ensured.plainKey },
        },
      }, { runtimeRoot: process.cwd() });
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
  };
  try {
    const version = await new SkillHubService().getPublishedVersion(skillId, metadata.version);
    if (version?.contentHash) {
      const localHash = computeLocalSkillContentHash(path.dirname(skill.filePath));
      info.modified = localHash === version.contentHash ? false : true;
    }
  } catch {
    info.modified = 'unknown';
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

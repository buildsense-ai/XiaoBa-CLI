import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';

export type DashboardSettingType = 'enum' | 'string' | 'url' | 'secret';
export type SecretSettingAction = 'keep' | 'replace' | 'clear';

export interface DashboardSettingDefinition {
  id: string;
  group: 'model' | 'catsco';
  label: string;
  description: string;
  envKey: string;
  type: DashboardSettingType;
  required?: boolean;
  options?: string[];
  protocols?: string[];
}

export interface DashboardSettingField {
  id: string;
  group: DashboardSettingDefinition['group'];
  label: string;
  description: string;
  type: DashboardSettingType;
  required: boolean;
  options?: string[];
  value?: string;
  present?: boolean;
  canReplace?: boolean;
  canClear?: boolean;
}

export interface DashboardSettingsSnapshot {
  runtimeRoot: string;
  generatedAt: string;
  fields: DashboardSettingField[];
}

export interface DashboardSettingsUpdateResult {
  ok: true;
  updated: string[];
  cleared: string[];
  kept: string[];
}

export interface DashboardSettingsOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

interface NormalizedSettingUpdate {
  envKey: string;
  value?: string;
  secretAction?: SecretSettingAction;
}

export const DASHBOARD_SETTING_DEFINITIONS: DashboardSettingDefinition[] = [
  {
    id: 'model.provider',
    group: 'model',
    label: '模型服务',
    description: '选择主模型使用的兼容 API 类型。',
    envKey: 'GAUZ_LLM_PROVIDER',
    type: 'enum',
    required: true,
    options: ['anthropic', 'openai'],
  },
  {
    id: 'model.apiBase',
    group: 'model',
    label: 'API 地址',
    description: '主模型 API Base URL，兼容 OpenAI SDK 风格，也可填写 chat/completions 完整地址。',
    envKey: 'GAUZ_LLM_API_BASE',
    type: 'url',
    required: true,
    protocols: ['http:', 'https:'],
  },
  {
    id: 'model.model',
    group: 'model',
    label: '模型',
    description: '主模型名称。',
    envKey: 'GAUZ_LLM_MODEL',
    type: 'string',
    required: true,
  },
  {
    id: 'model.apiKey',
    group: 'model',
    label: 'API Key',
    description: '主模型 API key。Dashboard 只保存和显示是否已配置。',
    envKey: 'GAUZ_LLM_API_KEY',
    type: 'secret',
    required: true,
  },
  {
    id: 'catsco.httpBaseUrl',
    group: 'catsco',
    label: 'CatsCo API 地址',
    description: 'CatsCo webapp HTTP API 地址。',
    envKey: 'CATSCO_HTTP_BASE_URL',
    type: 'url',
    required: false,
    protocols: ['http:', 'https:'],
  },
  {
    id: 'catsco.wsUrl',
    group: 'catsco',
    label: 'CatsCo 服务器 WebSocket 地址',
    description: 'CatsCo 桌面端 connector 连接服务器时使用的 WebSocket 地址。',
    envKey: 'CATSCO_SERVER_URL',
    type: 'url',
    required: false,
    protocols: ['ws:', 'wss:'],
  },
];

const DEFINITION_BY_ID = new Map(DASHBOARD_SETTING_DEFINITIONS.map(definition => [
  definition.id,
  definition,
]));

export function getDashboardSettings(
  options: DashboardSettingsOptions = {},
): DashboardSettingsSnapshot {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const fileEnv = readDashboardEnvFile(runtimeRoot);
  const catsCoRuntime = resolveCatsCoRuntimeConfig({
    runtimeRoot,
    env: { ...env, ...fileEnv },
  });

  return {
    runtimeRoot,
    generatedAt: (options.now ?? new Date()).toISOString(),
    fields: DASHBOARD_SETTING_DEFINITIONS.map(definition => {
      const value = resolveDashboardSettingValue(definition, fileEnv, env, catsCoRuntime.auth);
      const common = {
        id: definition.id,
        group: definition.group,
        label: definition.label,
        description: definition.description,
        type: definition.type,
        required: Boolean(definition.required),
        ...(definition.options ? { options: [...definition.options] } : {}),
      };

      if (definition.type === 'secret') {
        return {
          ...common,
          present: Boolean(value),
          canReplace: true,
          canClear: true,
        };
      }

      return {
        ...common,
        value: definition.type === 'url' ? sanitizeUrlSettingValue(value ?? '') : value ?? '',
      };
    }),
  };
}

export function updateDashboardSettings(
  input: unknown,
  options: DashboardSettingsOptions = {},
): DashboardSettingsUpdateResult {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const updates = normalizeSettingsUpdatePayload(input);
  const envUpdates: Record<string, string | undefined> = {};
  const catsCoEndpointUpdates: { httpBaseUrl?: string; serverUrl?: string } = {};
  const kept: string[] = [];

  for (const [id, rawValue] of Object.entries(updates)) {
    const definition = DEFINITION_BY_ID.get(id);
    if (!definition) {
      throw new Error(`Unknown dashboard setting: ${id}`);
    }

    const normalized = normalizeSettingUpdate(definition, rawValue);
    if (normalized.secretAction === 'keep') {
      kept.push(id);
      continue;
    }

    if (definition.id === 'catsco.httpBaseUrl') {
      catsCoEndpointUpdates.httpBaseUrl = normalized.value || '';
      continue;
    }
    if (definition.id === 'catsco.wsUrl') {
      catsCoEndpointUpdates.serverUrl = normalized.value || '';
      continue;
    }

    envUpdates[normalized.envKey] = normalized.value;
  }

  const result = writeDashboardEnvUpdates(runtimeRoot, envUpdates);
  const catsCoUpdated = Object.keys(catsCoEndpointUpdates).length > 0
    ? createCatsCoLocalConfigService({ runtimeRoot, env }).updateEndpoints(catsCoEndpointUpdates)
    : [];
  for (const [key, value] of Object.entries(envUpdates)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return {
    ok: true,
    updated: [...result.updated, ...catsCoUpdated],
    cleared: result.cleared,
    kept,
  };
}

function resolveDashboardSettingValue(
  definition: DashboardSettingDefinition,
  fileEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
  catsCoAuth: { httpBaseUrl?: string; serverUrl?: string },
): string | undefined {
  if (definition.id === 'catsco.httpBaseUrl') {
    return firstNonEmpty(catsCoAuth.httpBaseUrl, fileEnv[definition.envKey], env[definition.envKey]);
  }
  if (definition.id === 'catsco.wsUrl') {
    return firstNonEmpty(catsCoAuth.serverUrl, fileEnv[definition.envKey], env[definition.envKey]);
  }
  return firstNonEmpty(fileEnv[definition.envKey], env[definition.envKey]);
}

export function readDashboardEnvFile(runtimeRoot: string = process.cwd()): Record<string, string> {
  const envPath = path.join(runtimeRoot, '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
}

export function writeDashboardEnvUpdates(
  runtimeRoot: string,
  updates: Record<string, string | undefined>,
): { updated: string[]; cleared: string[] } {
  const envPath = path.join(runtimeRoot, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const lines = existing.length > 0 ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  const updated: string[] = [];
  const cleared: string[] = [];
  const seen = new Set<string>();
  const nextLines: string[] = [];

  for (const line of lines) {
    const key = getEnvLineKey(line);
    if (!key || !(key in updates)) {
      nextLines.push(line);
      continue;
    }

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const value = updates[key];
    if (value === undefined) {
      cleared.push(key);
      continue;
    }

    nextLines.push(`${key}=${serializeEnvValue(value)}`);
    updated.push(key);
  }

  for (const [key, value] of Object.entries(updates)) {
    assertSafeEnvKey(key);
    if (seen.has(key)) continue;

    if (value === undefined) {
      cleared.push(key);
      continue;
    }

    nextLines.push(`${key}=${serializeEnvValue(value)}`);
    updated.push(key);
  }

  const content = nextLines
    .filter((line, index, list) => !(line === '' && index === list.length - 1))
    .join('\n');
  fs.writeFileSync(envPath, content ? `${content}\n` : '', { encoding: 'utf-8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // Best-effort permission hardening for existing files.
    }
  }

  return { updated, cleared };
}

export function isSensitiveEnvKey(key: string): boolean {
  return /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE_?KEY|DSN|DATABASE_URL|REDIS_URL|MONGO(?:DB)?_URL|PROXY_URL|WEBHOOK_URL)/i.test(key);
}

function normalizeSettingsUpdatePayload(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Dashboard settings payload must be an object');
  }

  const payload = input as { settings?: unknown };
  const settings = payload.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Dashboard settings payload must include a settings object');
  }

  return settings as Record<string, unknown>;
}

function normalizeSettingUpdate(
  definition: DashboardSettingDefinition,
  rawValue: unknown,
): NormalizedSettingUpdate {
  if (definition.type === 'secret') {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new Error(`${definition.id} must be a secret update object`);
    }

    const action = (rawValue as { action?: unknown }).action;
    if (action !== 'keep' && action !== 'replace' && action !== 'clear') {
      throw new Error(`${definition.id} action must be keep, replace, or clear`);
    }

    if (action === 'keep') {
      return {
        envKey: definition.envKey,
        secretAction: 'keep',
      };
    }

    if (action === 'clear') {
      return {
        envKey: definition.envKey,
        value: undefined,
        secretAction: 'clear',
      };
    }

    const value = (rawValue as { value?: unknown }).value;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${definition.id} replacement value must be a non-empty string`);
    }

    return {
      envKey: definition.envKey,
      value: normalizeEnvValue(definition.id, value),
      secretAction: 'replace',
    };
  }

  if (typeof rawValue !== 'string') {
    throw new Error(`${definition.id} must be a string`);
  }
  const value = normalizeEnvValue(definition.id, rawValue.trim());
  if (definition.required && value.length === 0) {
    throw new Error(`${definition.id} is required`);
  }
  if (definition.options && !definition.options.includes(value)) {
    throw new Error(`${definition.id} must be one of: ${definition.options.join(', ')}`);
  }
  if (definition.type === 'url' && value.length > 0) {
    validateUrlValue(definition, value);
  }

  return {
    envKey: definition.envKey,
    value,
  };
}

function normalizeEnvValue(id: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${id} must not contain newlines`);
  }
  return value;
}

function validateUrlValue(definition: DashboardSettingDefinition, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${definition.id} must be a valid URL`);
  }

  if (definition.protocols && !definition.protocols.includes(parsed.protocol)) {
    throw new Error(`${definition.id} must use one of: ${definition.protocols.join(', ')}`);
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${definition.id} must not include credentials, query, or fragment`);
  }
}

function sanitizeUrlSettingValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function serializeEnvValue(value: string): string {
  normalizeEnvValue('env value', value);
  return JSON.stringify(value);
}

function getEnvLineKey(line: string): string | undefined {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (!match) return undefined;
  return match[1];
}

function assertSafeEnvKey(key: string): void {
  if (!/^[A-Z0-9_]+$/.test(key)) {
    throw new Error(`Unsafe env key: ${key}`);
  }
}

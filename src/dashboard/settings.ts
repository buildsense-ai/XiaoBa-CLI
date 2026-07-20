import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import type { ChatConfig, OpenAIApiMode, ReasoningEffort } from '../types';
import { REASONING_EFFORT_OPTIONS, normalizeReasoningEffort, reasoningEffortOrDefault } from '../utils/reasoning-effort';
import { OPENAI_API_MODE_OPTIONS, openAIApiModeOrDefault } from '../utils/openai-api-mode';

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
  modelStartup: DashboardModelStartupSnapshot;
  fields: DashboardSettingField[];
}

export interface DashboardModelProfileSnapshot {
  provider?: string;
  apiBase?: string;
  model?: string;
  contextWindowTokens?: number;
  reasoningEffort?: ReasoningEffort;
  openaiApiMode?: OpenAIApiMode;
  apiKeyPresent: boolean;
  configured: boolean;
}

export interface DashboardModelStartupSnapshot {
  source: 'relay' | 'custom';
  effective: DashboardModelProfileSnapshot;
  custom: DashboardModelProfileSnapshot;
  relay: DashboardModelProfileSnapshot;
}

export interface DashboardSettingsUpdateResult {
  ok: true;
  updated: string[];
  cleared: string[];
  kept: string[];
}

export type DashboardModelConfig = Pick<
  ChatConfig,
  | 'provider'
  | 'apiUrl'
  | 'apiKey'
  | 'model'
  | 'contextWindowTokens'
  | 'maxTokens'
  | 'temperature'
  | 'reasoningEffort'
  | 'openaiApiMode'
>;

export interface DashboardSettingsOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** The bound bot's resolved Definition config, when one is active. */
  modelConfig?: DashboardModelConfig;
  /** Whether the bound bot config came from a custom Definition or catalog runtime. */
  modelConfigSource?: DashboardModelStartupSnapshot['source'];
  /** Saved per-bot custom profile, even when a catalog model is active. */
  customModelConfig?: DashboardModelConfig;
  /** Saved per-bot catalog runtime, even when a custom model is active. */
  relayModelConfig?: DashboardModelConfig;
  /** The Runtime's effective model when legacy env is not its source of truth. */
  effectiveModelConfig?: DashboardModelConfig;
}

interface NormalizedSettingUpdate {
  envKey: string;
  value?: string;
  secretAction?: SecretSettingAction;
}

export const CUSTOM_MODEL_CONTEXT_WINDOW_OPTIONS = [
  '128000',
  '200000',
  '256000',
  '512000',
  '1000000',
];

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
    id: 'model.openaiApiMode',
    group: 'model',
    label: 'OpenAI 接口模式',
    description: 'Chat Completions 兼容旧中转；Responses API 支持新版工具事件和稳定提示词缓存。',
    envKey: 'GAUZ_LLM_OPENAI_API_MODE',
    type: 'enum',
    required: false,
    options: OPENAI_API_MODE_OPTIONS,
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
    id: 'model.contextWindowTokens',
    group: 'model',
    label: '上下文窗口',
    description: '自定义模型可用上下文窗口。若模型真实窗口更小，请选择更小档位避免超限。',
    envKey: 'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
    type: 'enum',
    required: true,
    options: CUSTOM_MODEL_CONTEXT_WINDOW_OPTIONS,
  },
  {
    id: 'model.reasoningEffort',
    group: 'model',
    label: '推理强度',
    description: 'DeepSeek 官方参数：high/max 写入 reasoning_effort，disabled 写入 thinking.disabled；旧 default 仅作为兼容值读取。',
    envKey: 'GAUZ_LLM_REASONING_EFFORT',
    type: 'enum',
    required: false,
    options: REASONING_EFFORT_OPTIONS,
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

const CUSTOM_MODEL_ENV_KEYS: Record<string, string> = {
  'model.provider': 'CATSCO_CUSTOM_LLM_PROVIDER',
  'model.apiBase': 'CATSCO_CUSTOM_LLM_API_BASE',
  'model.model': 'CATSCO_CUSTOM_LLM_MODEL',
  'model.contextWindowTokens': 'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS',
  'model.reasoningEffort': 'CATSCO_CUSTOM_LLM_REASONING_EFFORT',
  'model.openaiApiMode': 'CATSCO_CUSTOM_LLM_OPENAI_API_MODE',
  'model.apiKey': 'CATSCO_CUSTOM_LLM_API_KEY',
};

const EFFECTIVE_MODEL_ENV_KEYS = {
  provider: 'GAUZ_LLM_PROVIDER',
  apiBase: 'GAUZ_LLM_API_BASE',
  model: 'GAUZ_LLM_MODEL',
  apiKey: 'GAUZ_LLM_API_KEY',
  contextWindowTokens: 'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
  reasoningEffort: 'GAUZ_LLM_REASONING_EFFORT',
  openaiApiMode: 'GAUZ_LLM_OPENAI_API_MODE',
} as const;

const RELAY_MODEL_ENV_KEYS = {
  provider: 'CATSCO_RELAY_LLM_PROVIDER',
  apiBase: 'CATSCO_RELAY_LLM_API_BASE',
  model: 'CATSCO_RELAY_LLM_MODEL',
  apiKey: 'CATSCO_RELAY_LLM_API_KEY',
  contextWindowTokens: 'CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS',
  reasoningEffort: 'CATSCO_RELAY_LLM_REASONING_EFFORT',
  openaiApiMode: 'CATSCO_RELAY_LLM_OPENAI_API_MODE',
} as const;

const MODEL_SOURCE_ENV_KEY = 'CATSCO_MODEL_SOURCE';

function isModelSetting(id: string): boolean {
  return id.startsWith('model.');
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

function modelSettingDisplayValue(
  definition: DashboardSettingDefinition,
  fileEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const legacyApiBase = firstNonEmpty(fileEnv.GAUZ_LLM_API_BASE, env.GAUZ_LLM_API_BASE);
  const customEnvKey = CUSTOM_MODEL_ENV_KEYS[definition.id];
  const customValue = customEnvKey ? firstNonEmpty(fileEnv[customEnvKey], env[customEnvKey]) : undefined;

  if (customEnvKey && isCatsRelayApiBase(legacyApiBase)) {
    return customValue;
  }

  return firstNonEmpty(fileEnv[definition.envKey], env[definition.envKey]);
}

function readModelProfile(
  keys: typeof EFFECTIVE_MODEL_ENV_KEYS | typeof RELAY_MODEL_ENV_KEYS,
  fileEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
): DashboardModelProfileSnapshot {
  const provider = firstNonEmpty(fileEnv[keys.provider], env[keys.provider]);
  const apiBase = firstNonEmpty(fileEnv[keys.apiBase], env[keys.apiBase]);
  const model = firstNonEmpty(fileEnv[keys.model], env[keys.model]);
  const apiKey = firstNonEmpty(fileEnv[keys.apiKey], env[keys.apiKey]);
  const contextWindowTokens = parsePositiveInteger(firstNonEmpty(fileEnv[keys.contextWindowTokens], env[keys.contextWindowTokens]));
  const reasoningEffort = normalizeReasoningEffort(firstNonEmpty(fileEnv[keys.reasoningEffort], env[keys.reasoningEffort]));
  const openaiApiMode = openAIApiModeOrDefault(firstNonEmpty(fileEnv[keys.openaiApiMode], env[keys.openaiApiMode]));
  return {
    provider,
    apiBase: sanitizeUrlSettingValue(apiBase ?? ''),
    model,
    contextWindowTokens,
    reasoningEffort: reasoningEffort ?? 'default',
    openaiApiMode,
    apiKeyPresent: Boolean(apiKey),
    configured: Boolean(provider && apiBase && model && apiKey),
  };
}

function readCustomModelProfile(
  fileEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
): DashboardModelProfileSnapshot {
  const provider = firstNonEmpty(fileEnv.CATSCO_CUSTOM_LLM_PROVIDER, env.CATSCO_CUSTOM_LLM_PROVIDER);
  const apiBase = firstNonEmpty(fileEnv.CATSCO_CUSTOM_LLM_API_BASE, env.CATSCO_CUSTOM_LLM_API_BASE);
  const model = firstNonEmpty(fileEnv.CATSCO_CUSTOM_LLM_MODEL, env.CATSCO_CUSTOM_LLM_MODEL);
  const apiKey = firstNonEmpty(fileEnv.CATSCO_CUSTOM_LLM_API_KEY, env.CATSCO_CUSTOM_LLM_API_KEY);
  const contextWindowTokens = parsePositiveInteger(firstNonEmpty(
    fileEnv.CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS,
    env.CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS,
  ));
  const reasoningEffort = normalizeReasoningEffort(firstNonEmpty(
    fileEnv.CATSCO_CUSTOM_LLM_REASONING_EFFORT,
    env.CATSCO_CUSTOM_LLM_REASONING_EFFORT,
  ));
  const openaiApiMode = openAIApiModeOrDefault(firstNonEmpty(
    fileEnv.CATSCO_CUSTOM_LLM_OPENAI_API_MODE,
    env.CATSCO_CUSTOM_LLM_OPENAI_API_MODE,
  ));
  return {
    provider,
    apiBase: sanitizeUrlSettingValue(apiBase ?? ''),
    model,
    contextWindowTokens,
    reasoningEffort: reasoningEffort ?? 'default',
    openaiApiMode,
    apiKeyPresent: Boolean(apiKey),
    configured: Boolean(provider && apiBase && model && apiKey),
  };
}

function buildModelStartupSnapshot(
  fileEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
  effectiveModelConfig?: NonNullable<DashboardSettingsOptions['effectiveModelConfig']>,
): DashboardModelStartupSnapshot {
  const storedEffective = readModelProfile(EFFECTIVE_MODEL_ENV_KEYS, fileEnv, env);
  const runtimeEffective = effectiveModelConfig && modelProfileSnapshot(effectiveModelConfig);
  const effective = storedEffective.configured ? storedEffective : runtimeEffective ?? storedEffective;
  const storedCustom = readCustomModelProfile(fileEnv, env);
  const custom = storedCustom.configured
    ? storedCustom
    : effective.configured && !isCatsRelayApiBase(effective.apiBase)
      ? effective
      : storedCustom;
  const storedRelay = readModelProfile(RELAY_MODEL_ENV_KEYS, fileEnv, env);
  const requestedSource = firstNonEmpty(fileEnv[MODEL_SOURCE_ENV_KEY], env[MODEL_SOURCE_ENV_KEY]);
  const effectiveIsRelay = isCatsRelayApiBase(effective.apiBase);
  const relayBase = storedRelay.configured
    ? storedRelay
    : {
      ...storedRelay,
      provider: storedRelay.provider || (effectiveIsRelay ? effective.provider : storedRelay.provider),
      apiBase: storedRelay.apiBase || (effectiveIsRelay ? effective.apiBase : storedRelay.apiBase),
      model: storedRelay.model || (effectiveIsRelay ? effective.model : storedRelay.model),
      reasoningEffort: storedRelay.reasoningEffort && storedRelay.reasoningEffort !== 'default'
        ? storedRelay.reasoningEffort
        : effectiveIsRelay ? effective.reasoningEffort : storedRelay.reasoningEffort,
      apiKeyPresent: storedRelay.apiKeyPresent || (effectiveIsRelay && effective.apiKeyPresent),
      configured: effectiveIsRelay && effective.configured,
    };
  const relay = {
    ...relayBase,
    reasoningEffort: relayBase.reasoningEffort && relayBase.reasoningEffort !== 'default'
      ? relayBase.reasoningEffort
      : 'high' as const,
  };
  const source = requestedSource === 'custom' && custom.configured
    ? 'custom'
    : requestedSource === 'relay' && relay.configured && effectiveIsRelay
    ? 'relay'
    : effectiveIsRelay ? 'relay' : 'custom';

  return { source, effective, custom, relay };
}

function modelConfigValue(
  definition: DashboardSettingDefinition,
  config: NonNullable<DashboardSettingsOptions['modelConfig']>,
): string | undefined {
  switch (definition.id) {
    case 'model.provider': return config.provider;
    case 'model.apiBase': return config.apiUrl;
    case 'model.model': return config.model;
    case 'model.contextWindowTokens': return config.contextWindowTokens ? String(config.contextWindowTokens) : undefined;
    case 'model.reasoningEffort': return config.reasoningEffort;
    case 'model.openaiApiMode': return config.openaiApiMode;
    case 'model.apiKey': return config.apiKey;
    default: return undefined;
  }
}

function modelProfileSnapshot(
  config: NonNullable<DashboardSettingsOptions['modelConfig']>,
): DashboardModelProfileSnapshot {
  return {
    provider: config.provider,
    apiBase: sanitizeUrlSettingValue(config.apiUrl ?? ''),
    model: config.model,
    contextWindowTokens: config.contextWindowTokens,
    reasoningEffort: config.reasoningEffort ?? 'default',
    openaiApiMode: config.openaiApiMode ?? 'chat_completions',
    apiKeyPresent: Boolean(config.apiKey),
    configured: Boolean(config.provider && config.apiUrl && config.model && config.apiKey),
  };
}

function modelConfigSnapshot(
  config: NonNullable<DashboardSettingsOptions['modelConfig']>,
  source: NonNullable<DashboardSettingsOptions['modelConfigSource']>,
  customConfig?: DashboardSettingsOptions['customModelConfig'],
  relayConfig?: DashboardSettingsOptions['relayModelConfig'],
): DashboardModelStartupSnapshot {
  const effective = modelProfileSnapshot(config);
  const relayBase = relayConfig
    ? modelProfileSnapshot(relayConfig)
    : source === 'relay' ? effective : { apiKeyPresent: false, configured: false };
  const relay = {
    ...relayBase,
    reasoningEffort: relayBase.reasoningEffort === 'default' ? 'high' as const : relayBase.reasoningEffort,
  };
  const custom = customConfig
    ? modelProfileSnapshot(customConfig)
    : source === 'custom' ? effective : { apiKeyPresent: false, configured: false };
  return { source, effective, custom, relay };
}

export function getDashboardSettings(
  options: DashboardSettingsOptions = {},
): DashboardSettingsSnapshot {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const fileEnv = readDashboardEnvFile(runtimeRoot);
  const modelConfigSource = options.modelConfig
    ? options.modelConfigSource ?? (isCatsRelayApiBase(options.modelConfig.apiUrl) ? 'relay' : 'custom')
    : undefined;
  const customFieldConfig = options.customModelConfig
    ?? (modelConfigSource === 'custom' ? options.modelConfig : undefined);

  return {
    runtimeRoot,
    generatedAt: (options.now ?? new Date()).toISOString(),
    modelStartup: options.modelConfig
      ? modelConfigSnapshot(
        options.modelConfig,
        modelConfigSource!,
        options.customModelConfig,
        options.relayModelConfig,
      )
      : buildModelStartupSnapshot(fileEnv, env, options.effectiveModelConfig),
    fields: DASHBOARD_SETTING_DEFINITIONS.map(definition => {
      const value = isModelSetting(definition.id)
        ? customFieldConfig
          ? modelConfigValue(definition, customFieldConfig)
          : modelSettingDisplayValue(definition, fileEnv, env)
        : firstNonEmpty(fileEnv[definition.envKey], env[definition.envKey]);
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
        value: definition.type === 'url'
          ? sanitizeUrlSettingValue(value ?? '')
          : definition.id === 'model.openaiApiMode'
            ? openAIApiModeOrDefault(value)
            : value ?? '',
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

    envUpdates[normalized.envKey] = normalized.value;
  }

  const result = writeDashboardEnvUpdates(runtimeRoot, envUpdates);
  for (const [key, value] of Object.entries(envUpdates)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return {
    ok: true,
    updated: result.updated,
    cleared: result.cleared,
    kept,
  };
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
  fs.writeFileSync(envPath, content ? `${content}\n` : '', 'utf-8');

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
  if (definition.id === 'model.reasoningEffort') {
    const normalized = normalizeReasoningEffort(value);
    if (!normalized) {
      throw new Error(`${definition.id} must be one of: ${REASONING_EFFORT_OPTIONS.join(', ')}`);
    }
    return {
      envKey: definition.envKey,
      value: reasoningEffortOrDefault(normalized),
    };
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

function parsePositiveInteger(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { normalizeOpenAIApiMode } from '../utils/openai-api-mode';
import { normalizeReasoningEffort } from '../utils/reasoning-effort';
import {
  BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
  BOT_DEFINITION_SCHEMA,
  type BotCatalogModelRuntime,
  type BotDefinition,
  type BotDefinitionSyncResult,
  type BotModelDefinition,
  type LocalModelProfile,
} from './types';
import {
  FileBotCatalogModelRuntimeRepository,
  FileBotDefinitionRepository,
  type BotCatalogModelRuntimeRepository,
  type BotDefinitionRepository,
  type FileBotDefinitionRepositoryOptions,
} from './repository';

const CUSTOM_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * These keys belonged to the pre-BotDefinition model configuration. They are
 * deliberately separate from CatsCo account/device keys: migration removes
 * only model settings and leaves connector identity untouched.
 */
export const LEGACY_MODEL_ENV_KEYS = [
  'GAUZ_LLM_PROVIDER',
  'GAUZ_LLM_API_BASE',
  'GAUZ_LLM_API_KEY',
  'GAUZ_LLM_MODEL',
  'GAUZ_LLM_MAX_OUTPUT_TOKENS',
  'GAUZ_LLM_MAX_TOKENS',
  'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
  'GAUZ_LLM_CONTEXT_TOKENS',
  'GAUZ_LLM_MAX_PROMPT_TOKENS',
  'GAUZ_LLM_TEMPERATURE',
  'GAUZ_LLM_REASONING_EFFORT',
  'GAUZ_LLM_OPENAI_API_MODE',
  'CATSCO_MODEL_SOURCE',
  'CATSCO_RELAY_LLM_PROVIDER',
  'CATSCO_RELAY_LLM_API_BASE',
  'CATSCO_RELAY_LLM_API_KEY',
  'CATSCO_RELAY_LLM_MODEL',
  'CATSCO_RELAY_LLM_MAX_OUTPUT_TOKENS',
  'CATSCO_RELAY_LLM_MAX_TOKENS',
  'CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS',
  'CATSCO_RELAY_LLM_TEMPERATURE',
  'CATSCO_RELAY_LLM_REASONING_EFFORT',
  'CATSCO_RELAY_LLM_OPENAI_API_MODE',
  'CATSCO_RELAY_LLM_VISION_CAPABLE',
  'CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE',
  'CATSCO_CUSTOM_LLM_PROVIDER',
  'CATSCO_CUSTOM_LLM_API_BASE',
  'CATSCO_CUSTOM_LLM_API_KEY',
  'CATSCO_CUSTOM_LLM_MODEL',
  'CATSCO_CUSTOM_LLM_MAX_OUTPUT_TOKENS',
  'CATSCO_CUSTOM_LLM_MAX_TOKENS',
  'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS',
  'CATSCO_CUSTOM_LLM_TEMPERATURE',
  'CATSCO_CUSTOM_LLM_REASONING_EFFORT',
  'CATSCO_CUSTOM_LLM_OPENAI_API_MODE',
] as const;

const LEGACY_CONFIG_MODEL_KEYS = [
  'apiKey',
  'apiUrl',
  'model',
  'provider',
  'temperature',
  'maxTokens',
  'contextWindowTokens',
  'reasoningEffort',
  'openaiApiMode',
] as const;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseTemperature(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function readRuntimeEnv(runtimeRoot: string, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const envPath = path.join(runtimeRoot, '.env');
  const fileEnv = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf-8')) : {};
  return { ...fileEnv, ...env };
}

function isRelayProfile(profile: Record<string, string | undefined>): boolean {
  if (profile.CATSCO_MODEL_SOURCE === 'relay') return true;
  if (profile.CATSCO_MODEL_SOURCE === 'custom') return false;
  const apiBase = firstNonEmpty(profile.CATSCO_RELAY_LLM_API_BASE, profile.GAUZ_LLM_API_BASE) || '';
  return apiBase.toLowerCase().includes('relay.catsco.cc');
}

/**
 * Reads only pre-Definition configuration. This is a migration input, never a
 * normal runtime source for a bound bot.
 */
export function readLegacyLocalModelProfile(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalModelProfile | undefined {
  const values = readRuntimeEnv(runtimeRoot, env);
  const relay = isRelayProfile(values);
  const prefix = relay ? 'CATSCO_RELAY_LLM_' : 'CATSCO_CUSTOM_LLM_';
  const provider = firstNonEmpty(values[`${prefix}PROVIDER`], values.GAUZ_LLM_PROVIDER);
  const apiBase = firstNonEmpty(values[`${prefix}API_BASE`], values.GAUZ_LLM_API_BASE);
  const model = firstNonEmpty(values[`${prefix}MODEL`], values.GAUZ_LLM_MODEL);
  const apiKey = firstNonEmpty(values[`${prefix}API_KEY`], values.GAUZ_LLM_API_KEY);
  const contextWindowTokens = parsePositiveInteger(firstNonEmpty(
    values[`${prefix}CONTEXT_WINDOW_TOKENS`],
    values.GAUZ_LLM_CONTEXT_WINDOW_TOKENS,
    values.GAUZ_LLM_CONTEXT_TOKENS,
  ));
  const maxTokens = parsePositiveInteger(firstNonEmpty(
    values[`${prefix}MAX_OUTPUT_TOKENS`],
    values[`${prefix}MAX_TOKENS`],
    values.GAUZ_LLM_MAX_OUTPUT_TOKENS,
    values.GAUZ_LLM_MAX_TOKENS,
  ));
  const temperature = parseTemperature(firstNonEmpty(
    values[`${prefix}TEMPERATURE`],
    values.GAUZ_LLM_TEMPERATURE,
  ));
  const reasoningEffort = normalizeReasoningEffort(firstNonEmpty(
    values[`${prefix}REASONING_EFFORT`],
    values.GAUZ_LLM_REASONING_EFFORT,
  ));
  const openaiApiMode = normalizeOpenAIApiMode(firstNonEmpty(
    values[`${prefix}OPENAI_API_MODE`],
    values.GAUZ_LLM_OPENAI_API_MODE,
  ));
  const vision = relay ? parseOptionalBoolean(values.CATSCO_RELAY_LLM_VISION_CAPABLE) : undefined;
  const toolCalling = relay ? parseOptionalBoolean(values.CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE) : undefined;

  if (relay) {
    return model ? {
      source: 'catalog',
      modelId: model,
      provider: provider === 'anthropic' || provider === 'openai' ? provider : undefined,
      apiBase,
      model,
      apiKey,
      contextWindowTokens,
      maxTokens,
      temperature,
      reasoningEffort,
      openaiApiMode,
      ...((vision !== undefined || toolCalling !== undefined) ? {
        capabilities: {
          ...(vision !== undefined ? { vision } : {}),
          ...(toolCalling !== undefined ? { toolCalling } : {}),
        },
      } : {}),
    } : undefined;
  }
  if (!provider || !apiBase || !model || !apiKey) return undefined;
  if (provider !== 'anthropic' && provider !== 'openai') return undefined;
  return {
    source: 'custom',
    provider,
    apiBase,
    model,
    apiKey,
    contextWindowTokens: contextWindowTokens ?? CUSTOM_DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxTokens,
    temperature,
    reasoningEffort,
    openaiApiMode: openaiApiMode ?? 'chat_completions',
  };
}

/** @deprecated Use readLegacyLocalModelProfile. */
export const readLocalModelProfile = readLegacyLocalModelProfile;

/**
 * The catalog definition identifies a model; this separately captures the
 * device-local relay material needed to call it. It is intentionally never
 * written into BotDefinition.
 */
export function catalogRuntimeFromLocalProfile(
  botId: string,
  modelId: string,
  profile: LocalModelProfile,
): BotCatalogModelRuntime | undefined {
  if (profile.source !== 'catalog') return undefined;
  if (!profile.provider || !profile.apiBase || !profile.apiKey || !profile.model) return undefined;
  return {
    schema: BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
    botId,
    modelId,
    provider: profile.provider,
    apiBase: profile.apiBase,
    apiKey: profile.apiKey,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens ?? CUSTOM_DEFAULT_CONTEXT_WINDOW_TOKENS,
    ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.openaiApiMode ? { openaiApiMode: profile.openaiApiMode } : {}),
    ...(profile.capabilities ? { capabilities: profile.capabilities } : {}),
  };
}

export function botModelDefinitionFromLocalProfile(profile: LocalModelProfile): BotModelDefinition {
  if (profile.source === 'catalog') {
    if (!profile.modelId) throw new Error('catalog modelId is required');
    return { kind: 'catalog', modelId: profile.modelId };
  }
  if (!profile.provider || !profile.apiBase || !profile.model || !profile.apiKey || !profile.contextWindowTokens) {
    throw new Error('custom model profile is incomplete');
  }
  return {
    kind: 'custom',
    protocol: profile.provider === 'anthropic'
      ? 'anthropic'
      : profile.openaiApiMode === 'responses'
        ? 'openai-responses'
        : 'openai-chat-completions',
    apiBase: profile.apiBase,
    model: profile.model,
    apiKey: profile.apiKey,
    contextWindowTokens: profile.contextWindowTokens,
    ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  };
}

export interface BotDefinitionSyncServiceOptions extends FileBotDefinitionRepositoryOptions {
  repository?: BotDefinitionRepository;
  catalogRuntimeRepository?: BotCatalogModelRuntimeRepository;
  env?: NodeJS.ProcessEnv;
}

/**
 * This service owns direction only. The file repository is a local stand-in
 * for the future CatsCompany BotDefinition API and can be swapped unchanged.
 */
export class BotDefinitionSyncService {
  private readonly runtimeRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly repository: BotDefinitionRepository;
  private readonly catalogRuntimeRepository: BotCatalogModelRuntimeRepository;

  constructor(options: BotDefinitionSyncServiceOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
    this.env = options.env ?? process.env;
    this.repository = options.repository ?? new FileBotDefinitionRepository(options);
    this.catalogRuntimeRepository = options.catalogRuntimeRepository
      ?? new FileBotCatalogModelRuntimeRepository({ runtimeRoot: this.runtimeRoot });
  }

  pull(botId: string): BotDefinition | undefined {
    const definition = this.repository.readCanonical(botId);
    if (definition) {
      this.repository.writeCache(definition);
    }
    return definition;
  }

  publish(botId: string, model: BotModelDefinition): BotDefinitionSyncResult {
    const definition: BotDefinition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId,
      model,
    };
    this.repository.writeCanonical(definition);
    this.repository.writeCache(definition);
    this.clearLegacyModelConfiguration();
    return {
      botId,
      direction: 'local_to_simulated_cloud',
      definition,
    };
  }

  storeCatalogRuntime(runtime: BotCatalogModelRuntime): void {
    this.catalogRuntimeRepository.write(runtime);
  }

  readCatalogRuntime(botId: string): BotCatalogModelRuntime | undefined {
    return this.catalogRuntimeRepository.read(botId);
  }

  pullOrBootstrap(botId: string): BotDefinitionSyncResult | undefined {
    const existing = this.pull(botId);
    if (existing) {
      this.migrateLegacyCatalogRuntime(existing);
      // The canonical Definition is already authoritative. Any legacy model
      // fields left on disk can only be stale pre-Definition input.
      this.clearLegacyModelConfiguration();
      return {
        botId,
        direction: 'simulated_cloud_to_local',
        definition: existing,
      };
    }
    const profile = readLegacyLocalModelProfile(this.runtimeRoot, this.env);
    if (!profile) return undefined;
    const definition = this.publish(botId, botModelDefinitionFromLocalProfile(profile)).definition;
    this.bootstrapCatalogRuntimeFromLocalProfile(definition, profile);
    this.clearLegacyModelConfiguration();
    return {
      botId,
      direction: 'bootstrap_to_simulated_cloud',
      definition,
    };
  }

  /**
   * Compatibility helper for callers which have not yet been converted to
   * explicit Definition writes. It only bootstraps an empty Definition from
   * legacy material; it never overwrites an existing bot from .env.
   */
  publishCurrentBoundBot(): BotDefinitionSyncResult | undefined {
    const localConfig = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot, env: this.env }).load();
    const botId = String(localConfig.currentBot?.uid || '').trim();
    if (!botId) return undefined;
    return this.pullOrBootstrap(botId);
  }

  pullOrBootstrapCurrentBoundBot(): BotDefinitionSyncResult | undefined {
    const localConfig = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot, env: this.env }).load();
    const botId = String(localConfig.currentBot?.uid || '').trim();
    return botId ? this.pullOrBootstrap(botId) : undefined;
  }

  private bootstrapCatalogRuntimeFromLocalProfile(
    definition: BotDefinition,
    knownProfile?: LocalModelProfile,
  ): void {
    if (definition.model.kind !== 'catalog') return;
    const existing = this.catalogRuntimeRepository.read(definition.botId);
    if (existing?.modelId === definition.model.modelId) return;
    const profile = knownProfile;
    const runtime = profile && catalogRuntimeFromLocalProfile(
      definition.botId,
      definition.model.modelId,
      profile,
    );
    if (runtime) this.catalogRuntimeRepository.write(runtime);
  }

  private migrateLegacyCatalogRuntime(definition: BotDefinition): void {
    if (definition.model.kind !== 'catalog') return;
    if (this.catalogRuntimeRepository.read(definition.botId)?.modelId === definition.model.modelId) return;
    const profile = readLegacyLocalModelProfile(this.runtimeRoot, this.env);
    // A legacy relay key belongs to this catalog model only when both ids
    // agree. Never attach whatever happens to be in .env to a different bot.
    if (profile?.source !== 'catalog' || profile.modelId !== definition.model.modelId) return;
    const runtime = catalogRuntimeFromLocalProfile(definition.botId, definition.model.modelId, profile);
    if (!runtime) return;
    this.catalogRuntimeRepository.write(runtime);
    this.clearLegacyModelConfiguration();
  }

  /**
   * Removes model-only legacy state after it has been captured by the
   * Definition. CatsCo login, binding, and device fields are intentionally not
   * touched here.
   */
  private clearLegacyModelConfiguration(): void {
    const envPath = path.join(this.runtimeRoot, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').replace(/\r\n/g, '\n').split('\n');
      const legacy = new Set<string>(LEGACY_MODEL_ENV_KEYS);
      const next = lines.filter(line => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        return !match || !legacy.has(match[1]);
      });
      fs.writeFileSync(envPath, `${next.filter((line, index, all) => line || index < all.length - 1).join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
    }
    for (const key of LEGACY_MODEL_ENV_KEYS) {
      delete this.env[key];
    }

    const explicit = String(this.env.XIAOBA_CONFIG_PATH || '').trim();
    const configPath = explicit
      ? path.resolve(explicit)
      : path.join(os.homedir(), '.xiaoba', 'config.json');
    if (!fs.existsSync(configPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      let changed = false;
      for (const key of LEGACY_CONFIG_MODEL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          delete parsed[key];
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch {
      // A malformed legacy config must not block a successfully created Definition.
    }
  }
}

export function createBotDefinitionSyncService(
  options: BotDefinitionSyncServiceOptions = {},
): BotDefinitionSyncService {
  return new BotDefinitionSyncService(options);
}

/** Returns the active bot's cache without reading or overwriting the canonical side. */
export function readCachedDefinitionForCurrentBot(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): BotDefinition | undefined {
  const localConfig = createCatsCoLocalConfigService({ runtimeRoot, env }).load();
  const botId = String(localConfig.currentBot?.uid || '').trim();
  if (!botId) return undefined;
  return new FileBotDefinitionRepository({ runtimeRoot }).readCache(botId);
}

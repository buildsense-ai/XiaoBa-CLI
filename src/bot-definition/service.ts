import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { normalizeOpenAIApiMode } from '../utils/openai-api-mode';
import { normalizeReasoningEffort } from '../utils/reasoning-effort';
import {
  canonicalRelayModelId,
  findRelayModelProfile,
  relayModelIdsMatch,
} from '../utils/relay-model-profiles';
import {
  BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
  BOT_CUSTOM_MODEL_PROFILE_SCHEMA,
  BOT_DEFINITION_SCHEMA,
  type BotCatalogModelRuntime,
  type BotDefinition,
  type BotDefinitionSyncResult,
  type BotModelDefinition,
  type CustomBotModelDefinition,
  type LocalModelProfile,
} from './types';
import {
  FileBotCatalogModelRuntimeRepository,
  FileBotCustomModelProfileRepository,
  FileBotDefinitionRepository,
  type BotCatalogModelRuntimeRepository,
  type BotCustomModelProfileRepository,
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
  if (!profile.modelId || !relayModelIdsMatch(profile.modelId, modelId)) return undefined;
  const catalogProfile = findRelayModelProfile(modelId);
  return {
    schema: BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
    botId,
    modelId: catalogProfile?.id ?? modelId,
    provider: profile.provider,
    apiBase: profile.apiBase,
    apiKey: profile.apiKey,
    model: catalogProfile?.model ?? profile.model,
    contextWindowTokens: catalogProfile?.contextWindowTokens
      ?? profile.contextWindowTokens
      ?? CUSTOM_DEFAULT_CONTEXT_WINDOW_TOKENS,
    ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.openaiApiMode ? { openaiApiMode: profile.openaiApiMode } : {}),
    ...(catalogProfile
      ? { capabilities: catalogProfile.capabilities }
      : profile.capabilities ? { capabilities: profile.capabilities } : {}),
  };
}

export function catalogRuntimeMatchesModelId(
  runtime: Pick<BotCatalogModelRuntime, 'modelId' | 'model'>,
  modelId: string,
): boolean {
  if (!relayModelIdsMatch(runtime.modelId, modelId)) return false;
  const profile = findRelayModelProfile(modelId);
  return !profile || relayModelIdsMatch(runtime.model, profile.id);
}

function normalizeBotModelDefinition(model: BotModelDefinition): BotModelDefinition {
  if (model.kind !== 'catalog') return model;
  const modelId = canonicalRelayModelId(model.modelId);
  return modelId && modelId !== model.modelId ? { ...model, modelId } : model;
}

function normalizeBotDefinition(definition: BotDefinition): BotDefinition {
  const model = normalizeBotModelDefinition(definition.model);
  return model === definition.model ? definition : { ...definition, model };
}

function normalizeCatalogRuntime(runtime: BotCatalogModelRuntime): BotCatalogModelRuntime {
  const profile = findRelayModelProfile(runtime.modelId) ?? findRelayModelProfile(runtime.model);
  if (!profile) return runtime;
  return {
    ...runtime,
    modelId: profile.id,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    capabilities: profile.capabilities,
  };
}

export function botModelDefinitionFromLocalProfile(profile: LocalModelProfile): BotModelDefinition {
  if (profile.source === 'catalog') {
    if (!profile.modelId) throw new Error('catalog modelId is required');
    return { kind: 'catalog', modelId: canonicalRelayModelId(profile.modelId) ?? profile.modelId };
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
  customModelProfileRepository?: BotCustomModelProfileRepository;
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
  private readonly customModelProfileRepository: BotCustomModelProfileRepository;

  constructor(options: BotDefinitionSyncServiceOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
    this.env = options.env ?? process.env;
    this.repository = options.repository ?? new FileBotDefinitionRepository(options);
    this.catalogRuntimeRepository = options.catalogRuntimeRepository
      ?? new FileBotCatalogModelRuntimeRepository({ runtimeRoot: this.runtimeRoot });
    this.customModelProfileRepository = options.customModelProfileRepository
      ?? new FileBotCustomModelProfileRepository({ runtimeRoot: this.runtimeRoot });
  }

  pull(botId: string): BotDefinition | undefined {
    const previousCache = this.repository.readCache(botId);
    const rawDefinition = this.repository.readCanonical(botId);
    const definition = rawDefinition && normalizeBotDefinition(rawDefinition);
    if (definition) {
      if (previousCache?.model.kind === 'custom') {
        this.storeCustomModelProfile(botId, previousCache.model);
      }
      if (definition !== rawDefinition) this.repository.writeCanonical(definition);
      this.repository.writeCache(definition);
      if (definition.model.kind === 'custom') {
        this.storeCustomModelProfile(definition.botId, definition.model);
      }
    }
    return definition;
  }

  publish(botId: string, model: BotModelDefinition): BotDefinitionSyncResult {
    const previous = this.repository.readCache(botId) ?? this.repository.readCanonical(botId);
    if (previous?.model.kind === 'custom') {
      this.storeCustomModelProfile(botId, previous.model);
    }
    const normalizedModel = normalizeBotModelDefinition(model);
    if (normalizedModel.kind === 'custom') {
      this.storeCustomModelProfile(botId, normalizedModel);
    }
    const definition: BotDefinition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId,
      model: normalizedModel,
    };
    this.repository.writeCanonical(definition);
    this.repository.writeCache(definition);
    this.clearLegacyModelConfigurationWhenReady(definition);
    return {
      botId,
      direction: 'local_to_simulated_cloud',
      definition,
    };
  }

  storeCatalogRuntime(runtime: BotCatalogModelRuntime): void {
    this.catalogRuntimeRepository.write(normalizeCatalogRuntime(runtime));
  }

  readCatalogRuntime(botId: string): BotCatalogModelRuntime | undefined {
    const runtime = this.catalogRuntimeRepository.read(botId);
    if (!runtime) return undefined;
    const normalized = normalizeCatalogRuntime(runtime);
    if (JSON.stringify(normalized) !== JSON.stringify(runtime)) {
      this.catalogRuntimeRepository.write(normalized);
    }
    return normalized;
  }

  storeCustomModelProfile(botId: string, model: CustomBotModelDefinition): void {
    const normalized = normalizeBotModelDefinition(model);
    if (normalized.kind !== 'custom') throw new Error('Custom model profile must use a custom model definition');
    this.customModelProfileRepository.write({
      schema: BOT_CUSTOM_MODEL_PROFILE_SCHEMA,
      botId,
      model: normalized,
    });
  }

  readCustomModelProfile(botId: string): CustomBotModelDefinition | undefined {
    const profile = this.customModelProfileRepository.read(botId);
    if (!profile) return undefined;
    const normalized = normalizeBotModelDefinition(profile.model);
    if (normalized.kind !== 'custom') return undefined;
    if (JSON.stringify(normalized) !== JSON.stringify(profile.model)) {
      this.storeCustomModelProfile(botId, normalized);
    }
    return normalized;
  }

  pullOrBootstrap(botId: string): BotDefinitionSyncResult | undefined {
    const existing = this.pull(botId);
    if (existing) {
      this.migrateLegacyCatalogRuntime(existing);
      this.clearLegacyModelConfigurationWhenReady(existing);
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
    this.clearLegacyModelConfigurationWhenReady(definition);
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
    const existing = this.readCatalogRuntime(definition.botId);
    if (existing && catalogRuntimeMatchesModelId(existing, definition.model.modelId)) return;
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
    const existing = this.readCatalogRuntime(definition.botId);
    if (existing && catalogRuntimeMatchesModelId(existing, definition.model.modelId)) return;
    const profile = readLegacyLocalModelProfile(this.runtimeRoot, this.env);
    // A legacy relay key belongs to this catalog model only when both ids
    // agree. Never attach whatever happens to be in .env to a different bot.
    if (profile?.source !== 'catalog' || !relayModelIdsMatch(profile.modelId, definition.model.modelId)) return;
    const runtime = catalogRuntimeFromLocalProfile(definition.botId, definition.model.modelId, profile);
    if (!runtime) return;
    this.storeCatalogRuntime(runtime);
    this.clearLegacyModelConfiguration();
  }

  /** Clears old model fields only after the selected Definition is runnable. */
  clearLegacyModelConfigurationWhenReady(definition: BotDefinition): void {
    if (definition.model.kind === 'custom') {
      this.clearLegacyModelConfiguration();
      return;
    }
    const runtime = this.readCatalogRuntime(definition.botId);
    if (runtime && catalogRuntimeMatchesModelId(runtime, definition.model.modelId)) {
      this.clearLegacyModelConfiguration();
    }
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

import * as fs from 'fs';
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

export function readLocalModelProfile(
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
  const reasoningEffort = normalizeReasoningEffort(firstNonEmpty(
    values[`${prefix}REASONING_EFFORT`],
    values.GAUZ_LLM_REASONING_EFFORT,
  ));
  const openaiApiMode = normalizeOpenAIApiMode(firstNonEmpty(
    values[`${prefix}OPENAI_API_MODE`],
    values.GAUZ_LLM_OPENAI_API_MODE,
  ));

  if (relay) {
    return model ? {
      source: 'catalog',
      modelId: model,
      provider: provider === 'anthropic' || provider === 'openai' ? provider : undefined,
      apiBase,
      model,
      apiKey,
      contextWindowTokens,
      reasoningEffort,
      openaiApiMode,
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
    reasoningEffort,
    openaiApiMode: openaiApiMode ?? 'chat_completions',
  };
}

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
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.openaiApiMode ? { openaiApiMode: profile.openaiApiMode } : {}),
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
      this.bootstrapCatalogRuntimeFromLocalProfile(definition);
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
      return {
        botId,
        direction: 'simulated_cloud_to_local',
        definition: existing,
      };
    }
    const profile = readLocalModelProfile(this.runtimeRoot, this.env);
    if (!profile) return undefined;
    const definition = this.publish(botId, botModelDefinitionFromLocalProfile(profile)).definition;
    this.bootstrapCatalogRuntimeFromLocalProfile(definition, profile);
    return {
      botId,
      direction: 'bootstrap_to_simulated_cloud',
      definition,
    };
  }

  publishCurrentBoundBot(): BotDefinitionSyncResult | undefined {
    const localConfig = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot, env: this.env }).load();
    const botId = String(localConfig.currentBot?.uid || '').trim();
    if (!botId) return undefined;
    const profile = readLocalModelProfile(this.runtimeRoot, this.env);
    if (!profile) return undefined;
    const result = this.publish(botId, botModelDefinitionFromLocalProfile(profile));
    this.bootstrapCatalogRuntimeFromLocalProfile(result.definition, profile);
    return result;
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
    const profile = knownProfile ?? readLocalModelProfile(this.runtimeRoot, this.env);
    const runtime = profile && catalogRuntimeFromLocalProfile(
      definition.botId,
      definition.model.modelId,
      profile,
    );
    if (runtime) this.catalogRuntimeRepository.write(runtime);
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

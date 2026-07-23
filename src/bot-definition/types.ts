import type { OpenAIApiMode, ReasoningEffort } from '../types';

export const BOT_DEFINITION_SCHEMA = 'xiaoba.bot-definition.v1';
export const BOT_CATALOG_MODEL_RUNTIME_SCHEMA = 'xiaoba.bot-catalog-model-runtime.v1';
export const BOT_CUSTOM_MODEL_PROFILE_SCHEMA = 'xiaoba.bot-custom-model-profile.v1';

/**
 * A catalog model is identified by the CatsCo model catalog. Its endpoint and
 * relay credential are materialized when the bot is activated on a device.
 */
export interface CatalogBotModelDefinition {
  kind: 'catalog';
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * A custom model has no shared catalog entry, so its complete runtime profile
 * is part of the bot definition.
 */
export interface CustomBotModelDefinition {
  kind: 'custom';
  protocol: 'anthropic' | 'openai-chat-completions' | 'openai-responses';
  apiBase: string;
  model: string;
  apiKey: string;
  contextWindowTokens: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}

export type BotModelDefinition = CatalogBotModelDefinition | CustomBotModelDefinition;

/**
 * The deliberately small, portable part of a bot. Prompt and skill fields are
 * intentionally deferred until their source/version contracts are settled.
 */
export interface BotDefinition {
  schema: typeof BOT_DEFINITION_SCHEMA;
  botId: string;
  model: BotModelDefinition;
}

export interface LocalModelProfile {
  source: 'catalog' | 'custom';
  modelId?: string;
  provider?: 'anthropic' | 'openai';
  apiBase?: string;
  model?: string;
  apiKey?: string;
  contextWindowTokens?: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  openaiApiMode?: OpenAIApiMode;
  capabilities?: {
    vision?: boolean;
    toolCalling?: boolean;
    streaming?: boolean;
  };
}

/**
 * Device-local runtime material for a catalog model. It is deliberately kept
 * separate from BotDefinition: the portable definition contains only the
 * catalog model id, while this record contains the current device's relay
 * endpoint and credential.
 */
export interface BotCatalogModelRuntime {
  schema: typeof BOT_CATALOG_MODEL_RUNTIME_SCHEMA;
  botId: string;
  modelId: string;
  provider: 'anthropic' | 'openai';
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindowTokens: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  openaiApiMode?: OpenAIApiMode;
  capabilities?: {
    vision?: boolean;
    toolCalling?: boolean;
    streaming?: boolean;
  };
  capabilitiesSource?: 'relay-models' | 'models-dev' | 'static' | 'probe';
  capabilitiesCheckedAt?: string;
}

/**
 * Device-local alternate custom profile for a bot. The active BotDefinition
 * still selects exactly one source, while this record lets a user switch to a
 * catalog model and later return to the previous custom configuration.
 */
export interface BotCustomModelProfile {
  schema: typeof BOT_CUSTOM_MODEL_PROFILE_SCHEMA;
  botId: string;
  model: CustomBotModelDefinition;
}

export interface BotDefinitionSyncResult {
  botId: string;
  direction: 'local_to_simulated_cloud' | 'simulated_cloud_to_local' | 'bootstrap_to_simulated_cloud' | 'cloud_to_local';
  definition: BotDefinition;
}

import * as path from 'path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import type { ChatConfig } from '../types';
import { PathResolver } from '../utils/path-resolver';
import { FileBotCatalogModelRuntimeRepository, FileBotDefinitionRepository } from './repository';

export type BotLLMConfigSource = 'custom_definition' | 'catalog_runtime';

export interface ResolvedBotLLMConfig {
  botId: string;
  source: BotLLMConfigSource;
  config: Pick<ChatConfig, 'provider' | 'apiUrl' | 'apiKey' | 'model' | 'contextWindowTokens' | 'maxTokens' | 'temperature' | 'reasoningEffort' | 'openaiApiMode' | 'modelCapabilities'>;
}

export interface ResolveBotLLMConfigOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
}

function runtimeToConfig(runtime: {
  provider: 'anthropic' | 'openai';
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindowTokens: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ChatConfig['reasoningEffort'];
  openaiApiMode?: ChatConfig['openaiApiMode'];
  capabilities?: ChatConfig['modelCapabilities'];
}): ResolvedBotLLMConfig['config'] {
  return {
    provider: runtime.provider,
    apiUrl: runtime.apiBase,
    apiKey: runtime.apiKey,
    model: runtime.model,
    contextWindowTokens: runtime.contextWindowTokens,
    ...(runtime.maxTokens ? { maxTokens: runtime.maxTokens } : {}),
    temperature: runtime.temperature ?? 0.7,
    ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
    ...(runtime.openaiApiMode ? { openaiApiMode: runtime.openaiApiMode } : {}),
    ...(runtime.capabilities ? { modelCapabilities: runtime.capabilities } : {}),
  };
}

/**
 * Resolves the effective model for a bound bot without consulting legacy .env
 * as the decision source. Legacy values are used once only to migrate missing
 * catalog runtime material from an older installation.
 */
export function resolveActiveBotLLMConfig(
  options: ResolveBotLLMConfigOptions = {},
): ResolvedBotLLMConfig | undefined {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
  const env = options.env ?? process.env;
  const localConfig = createCatsCoLocalConfigService({ runtimeRoot, env }).load();
  const botId = String(localConfig.currentBot?.uid || '').trim();
  if (!botId) return undefined;

  const definitions = new FileBotDefinitionRepository({ runtimeRoot });
  const definition = definitions.readCache(botId);
  if (!definition) return undefined;

  if (definition.model.kind === 'custom') {
    const model = definition.model;
    return {
      botId,
      source: 'custom_definition',
      config: {
        provider: model.protocol === 'anthropic' ? 'anthropic' : 'openai',
        apiUrl: model.apiBase,
        apiKey: model.apiKey,
        model: model.model,
        contextWindowTokens: model.contextWindowTokens,
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        temperature: model.temperature ?? 0.7,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        openaiApiMode: model.protocol === 'openai-responses' ? 'responses' : 'chat_completions',
      },
    };
  }

  const catalogRuntime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot });
  const runtime = catalogRuntime.read(botId);
  if (!runtime || runtime.modelId !== definition.model.modelId) return undefined;
  return {
    botId,
    source: 'catalog_runtime',
    config: runtimeToConfig(runtime),
  };
}

import * as path from 'path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import type { ChatConfig } from '../types';
import { PathResolver } from '../utils/path-resolver';
import { FileBotCatalogModelRuntimeRepository, FileBotDefinitionRepository } from './repository';
import { catalogRuntimeFromLocalProfile, readLocalModelProfile } from './service';

export type BotLLMConfigSource = 'custom_definition' | 'catalog_runtime';

export interface ResolvedBotLLMConfig {
  botId: string;
  source: BotLLMConfigSource;
  config: Pick<ChatConfig, 'provider' | 'apiUrl' | 'apiKey' | 'model' | 'contextWindowTokens' | 'reasoningEffort' | 'openaiApiMode'>;
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
  reasoningEffort?: ChatConfig['reasoningEffort'];
  openaiApiMode?: ChatConfig['openaiApiMode'];
}): ResolvedBotLLMConfig['config'] {
  return {
    provider: runtime.provider,
    apiUrl: runtime.apiBase,
    apiKey: runtime.apiKey,
    model: runtime.model,
    contextWindowTokens: runtime.contextWindowTokens,
    ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
    ...(runtime.openaiApiMode ? { openaiApiMode: runtime.openaiApiMode } : {}),
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
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        openaiApiMode: model.protocol === 'openai-responses' ? 'responses' : 'chat_completions',
      },
    };
  }

  const catalogRuntime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot });
  let runtime = catalogRuntime.read(botId);
  if (!runtime || runtime.modelId !== definition.model.modelId) {
    const profile = readLocalModelProfile(runtimeRoot, env);
    const migrated = profile && catalogRuntimeFromLocalProfile(botId, definition.model.modelId, profile);
    if (migrated) {
      catalogRuntime.write(migrated);
      runtime = migrated;
    }
  }
  if (!runtime || runtime.modelId !== definition.model.modelId) return undefined;
  return {
    botId,
    source: 'catalog_runtime',
    config: runtimeToConfig(runtime),
  };
}

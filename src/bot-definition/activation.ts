import { createCatsCoLocalConfigService, type CatsCoAuthSnapshot } from '../catscompany/local-config';
import { provisionCatsRelayCatalogRuntime } from '../catscompany/relay-model-bootstrap';
import { DEFAULT_CATSCO_RELAY_MODEL_ID } from '../utils/relay-model-profiles';
import {
  catalogRuntimeMatchesModelId,
  createBotDefinitionSyncService,
  type BotDefinitionSyncServiceOptions,
} from './service';
import type { BotCatalogModelRuntime, BotDefinition, BotDefinitionSyncResult } from './types';

export interface PrepareBoundBotDefinitionOptions extends BotDefinitionSyncServiceOptions {
  runtimeRoot: string;
  botId?: string;
  selectedCatalogRuntime?: BotCatalogModelRuntime;
  auth?: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
}

export interface PreparedBoundBotDefinition {
  botId: string;
  definition: BotDefinition;
  sync?: BotDefinitionSyncResult;
  initializedDefault: boolean;
  materializedCatalogRuntime: boolean;
}

/**
 * Makes the selected bot runnable on this machine before connector preflight.
 * Definition sync is portable; catalog runtime material is deliberately local.
 */
export async function prepareBoundBotDefinition(
  options: PrepareBoundBotDefinitionOptions,
): Promise<PreparedBoundBotDefinition | undefined> {
  const localConfig = createCatsCoLocalConfigService({ runtimeRoot: options.runtimeRoot }).load();
  const botId = String(options.botId || localConfig.currentBot?.uid || '').trim();
  if (!botId) return undefined;

  const definitionService = createBotDefinitionSyncService(options);
  const selectedCatalogRuntime = options.selectedCatalogRuntime;
  if (selectedCatalogRuntime && selectedCatalogRuntime.botId !== botId) {
    throw new Error('Selected catalog runtime does not belong to the bound bot.');
  }
  let sync = selectedCatalogRuntime
    ? undefined
    : definitionService.pullOrBootstrap(botId);
  let definition = sync?.definition;
  const auth = options.auth ?? createCatsCoLocalConfigService({ runtimeRoot: options.runtimeRoot }).getAuthState();
  let initializedDefault = false;
  let materializedCatalogRuntime = false;

  if (selectedCatalogRuntime) {
    definitionService.storeCatalogRuntime(selectedCatalogRuntime);
    sync = definitionService.publish(botId, {
      kind: 'catalog',
      modelId: selectedCatalogRuntime.modelId,
    });
    definition = sync.definition;
    materializedCatalogRuntime = true;
  }

  if (!definition) {
    const runtime = await provisionCatsRelayCatalogRuntime({
      botId,
      modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
      auth,
      fetchImpl: options.fetchImpl,
    });
    definitionService.storeCatalogRuntime(runtime);
    sync = definitionService.publish(botId, {
      kind: 'catalog',
      modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
    });
    definition = sync.definition;
    initializedDefault = true;
    materializedCatalogRuntime = true;
  }

  if (definition.model.kind === 'catalog') {
    const runtime = definitionService.readCatalogRuntime(botId);
    if (!runtime || !catalogRuntimeMatchesModelId(runtime, definition.model.modelId)) {
      const materialized = await provisionCatsRelayCatalogRuntime({
        botId,
        modelId: definition.model.modelId,
        auth,
        fetchImpl: options.fetchImpl,
      });
      definitionService.storeCatalogRuntime(materialized);
      materializedCatalogRuntime = true;
    }
  }

  definitionService.clearLegacyModelConfigurationWhenReady(definition);
  return { botId, definition, sync, initializedDefault, materializedCatalogRuntime };
}

import { createCatsCoLocalConfigService, type CatsCoAuthSnapshot } from '../catscompany/local-config';
import {
  provisionCatsRelayCatalogRuntime,
  refreshCatsRelayCatalogRuntimeCapabilities,
} from '../catscompany/relay-model-bootstrap';
import { DEFAULT_CATSCO_RELAY_MODEL_ID } from '../utils/relay-model-profiles';
import { Logger } from '../utils/logger';
import {
  catalogRuntimeMatchesModelId,
  createBotDefinitionSyncService,
  type BotDefinitionSyncServiceOptions,
} from './service';
import type { BotCatalogModelRuntime, BotDefinition, BotDefinitionSyncResult } from './types';
import { getPromptReconcileCoordinator } from './prompt-sync';
import {
  acknowledgeCloudBotDefinition,
  acknowledgeCloudBotModelSelection,
  pullLegacyCloudBotModelSelection,
  pullCloudBotModelSelection,
  redactCloudBotModelError,
  type CloudBotModelSelection,
} from './cloud-client';
import { createBotDefinitionCloudSyncService } from './cloud-sync';

export interface PrepareBoundBotDefinitionOptions extends BotDefinitionSyncServiceOptions {
  runtimeRoot: string;
  botId?: string;
  selectedCatalogRuntime?: BotCatalogModelRuntime;
  auth?: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
  cloudSelection?: CloudBotModelSelection;
  acknowledgeCloudSelection?: boolean;
}

export interface PreparedBoundBotDefinition {
  botId: string;
  definition: BotDefinition;
  sync?: BotDefinitionSyncResult;
  initializedDefault: boolean;
  materializedCatalogRuntime: boolean;
  cloudRevision?: number;
  cloudSelection?: CloudBotModelSelection;
  cloudApplyError?: string;
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
  let sync = definitionService.pullOrBootstrap(botId);
  let localDefinition = sync?.definition;
  let initializedDefaultFromEmpty = false;
  const auth = options.auth ?? createCatsCoLocalConfigService({ runtimeRoot: options.runtimeRoot }).getAuthState();
  const cloudDefinitionSync = createBotDefinitionCloudSyncService({
    runtimeRoot: options.runtimeRoot,
    env: options.env,
    definitionService,
    fetchImpl: options.fetchImpl,
  });

  if (!options.cloudSelection) {
    try {
      let cloudSnapshot = await cloudDefinitionSync.reconcileStartup(botId, auth);
      if (cloudSnapshot) {
        if (selectedCatalogRuntime) {
          definitionService.storeCatalogRuntime(selectedCatalogRuntime);
          sync = definitionService.updateModel(botId, {
            kind: 'catalog',
            modelId: selectedCatalogRuntime.modelId,
          });
          cloudDefinitionSync.markModelPending(botId);
          cloudSnapshot = await cloudDefinitionSync.pushModel(botId, auth, sync.definition.model)
            ?? cloudSnapshot;
        }

        if (!cloudSnapshot.configured) {
          localDefinition = definitionService.read(botId) ?? definitionService.pullOrBootstrap(botId)?.definition;
          if (!localDefinition) {
            const runtime = await provisionCatsRelayCatalogRuntime({
              botId,
              modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
              auth,
              fetchImpl: options.fetchImpl,
            });
            definitionService.storeCatalogRuntime(runtime);
            sync = definitionService.updateModel(botId, {
              kind: 'catalog',
              modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
            });
            localDefinition = sync.definition;
            initializedDefaultFromEmpty = true;
          }
          await getPromptReconcileCoordinator({
            runtimeRoot: options.runtimeRoot,
            env: options.env,
            definitionService,
          }).activateBot(botId);
          const migrated = definitionService.read(botId)!;
          cloudDefinitionSync.markModelPending(botId);
          await cloudDefinitionSync.pushModel(botId, auth, migrated.model);
          if (migrated.prompt) {
            cloudDefinitionSync.markPromptPending(botId);
            cloudSnapshot = await cloudDefinitionSync.pushPrompt(botId, auth, migrated.prompt)
              ?? cloudSnapshot;
          }
          cloudSnapshot = await cloudDefinitionSync.pull(botId, auth) ?? cloudSnapshot;
        }

        let definition = definitionService.read(botId);
        if (!definition) throw new Error('CatsCo cloud BotDefinition did not produce a local cache.');
        definitionService.clearCloudModelOverride(botId);
        let materializedCatalogRuntime = false;
        if (definition.model.kind === 'catalog') {
          const runtime = definitionService.readCatalogRuntime(botId);
          if (!runtime || !catalogRuntimeMatchesModelId(runtime, definition.model.modelId)) {
            const materialized = await provisionCatsRelayCatalogRuntime({
              botId,
              modelId: definition.model.modelId,
              reasoningEffort: definition.model.reasoningEffort,
              auth,
              fetchImpl: options.fetchImpl,
            });
            definitionService.storeCatalogRuntime(materialized);
            materializedCatalogRuntime = true;
          } else if (catalogCapabilitiesNeedRefresh(runtime)) {
            const refreshed = await refreshCatsRelayCatalogRuntimeCapabilities(runtime, options.fetchImpl ?? fetch);
            if (refreshed !== runtime) definitionService.storeCatalogRuntime(refreshed);
          }
        }
        const promptCoordinator = getPromptReconcileCoordinator({
          runtimeRoot: options.runtimeRoot,
          env: options.env,
          definitionService,
        });
        await promptCoordinator.activateBot(botId, { preferDefinition: true });
        definition = definitionService.read(botId)!;
        if (!cloudSnapshot.definition?.prompt && definition.prompt) {
          cloudDefinitionSync.markPromptPending(botId);
          cloudSnapshot = await cloudDefinitionSync.pushPrompt(botId, auth, definition.prompt)
            ?? cloudSnapshot;
        }
        definitionService.clearLegacyModelConfigurationWhenReady(definition);
        if (options.acknowledgeCloudSelection !== false && cloudSnapshot.configured) {
          try {
            await acknowledgeCloudBotDefinition(
              { botId, auth, fetchImpl: options.fetchImpl },
              cloudSnapshot.revision,
            );
          } catch (error) {
            Logger.warning(`CatsCo BotDefinition apply acknowledgement failed: ${errorMessage(error)}`);
          }
        }
        return {
          botId,
          definition,
          sync,
          initializedDefault: initializedDefaultFromEmpty,
          materializedCatalogRuntime,
          cloudRevision: cloudSnapshot.revision,
          cloudSelection: definition.model.kind === 'custom'
            ? {
              kind: 'custom',
              modelId: definition.model.model,
              customModel: definition.model,
              revision: cloudSnapshot.revision,
              definition,
            }
            : {
              kind: 'catalog',
              modelId: definition.model.modelId,
              ...(definition.model.reasoningEffort
                ? { reasoningEffort: definition.model.reasoningEffort }
                : {}),
              revision: cloudSnapshot.revision,
              definition,
            },
        };
      }
    } catch (error) {
      Logger.warning(`CatsCo BotDefinition cloud sync is temporarily unavailable; using local cache: ${errorMessage(error)}`);
    }
  }

  const previousCloudDefinition = definitionService.readCloudModelOverride(botId);
  const previousCloudRuntime = definitionService.readCloudCatalogRuntime(botId);
  let definition = previousCloudDefinition ?? localDefinition;
  let initializedDefault = false;
  let materializedCatalogRuntime = false;
  let cloudSelection = options.cloudSelection;
  let cloudApplyError: string | undefined;
  let cloudSelectionApplied = false;
  let selectedCatalogRuntimeApplied = false;
  const shouldAcknowledgeCloudSelection = options.acknowledgeCloudSelection !== false;

  if (!cloudSelection) {
    try {
      cloudSelection = await pullLegacyCloudBotModelSelection({
        botId,
        auth,
        fetchImpl: options.fetchImpl,
      });
    } catch (error) {
      Logger.warning(`CatsCo 云端模型配置暂时不可用，继续使用本地配置: ${errorMessage(error)}`);
    }
  }

  if (cloudSelection) {
    try {
      if (cloudSelection.kind === 'local') {
        if (selectedCatalogRuntime) {
          definitionService.storeCatalogRuntime(selectedCatalogRuntime);
          sync = definitionService.publish(botId, {
            kind: 'catalog',
            modelId: selectedCatalogRuntime.modelId,
          });
          localDefinition = sync.definition;
          materializedCatalogRuntime = true;
          selectedCatalogRuntimeApplied = true;
        }
        if (!localDefinition) {
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
          localDefinition = sync.definition;
          initializedDefault = true;
          materializedCatalogRuntime = true;
        }
        if (localDefinition.model.kind === 'catalog') {
          const runtime = definitionService.readCatalogRuntime(botId);
          if (!runtime || !catalogRuntimeMatchesModelId(runtime, localDefinition.model.modelId)) {
            const materialized = await provisionCatsRelayCatalogRuntime({
              botId,
              modelId: localDefinition.model.modelId,
              auth,
              fetchImpl: options.fetchImpl,
            });
            definitionService.storeCatalogRuntime(materialized);
            materializedCatalogRuntime = true;
          }
        }
        definitionService.clearCloudModelOverride(botId);
        definition = localDefinition;
      } else if (cloudSelection.kind === 'custom') {
        if (!cloudSelection.customModel) {
          throw new Error('CatsCo cloud custom model configuration is missing.');
        }
        sync = definitionService.acceptCloud(botId, cloudSelection.customModel);
        definition = sync.definition;
      } else {
        const cloudModel = {
          kind: 'catalog' as const,
          modelId: cloudSelection.modelId,
          ...(cloudSelection.reasoningEffort ? { reasoningEffort: cloudSelection.reasoningEffort } : {}),
        };
        const runtime = definitionService.readCloudCatalogRuntime(botId);
        if (!runtime || !catalogRuntimeMatchesModelId(runtime, cloudSelection.modelId)) {
          const materialized = await provisionCatsRelayCatalogRuntime({
            botId,
            modelId: cloudSelection.modelId,
            reasoningEffort: cloudSelection.reasoningEffort,
            auth,
            fetchImpl: options.fetchImpl,
          });
          definitionService.storeCloudCatalogRuntime(materialized);
          materializedCatalogRuntime = true;
        } else if (
          cloudSelection.reasoningEffort
          && runtime.reasoningEffort !== cloudSelection.reasoningEffort
        ) {
          definitionService.storeCloudCatalogRuntime({
            ...runtime,
            reasoningEffort: cloudSelection.reasoningEffort,
          });
        }
        sync = definitionService.acceptCloud(botId, cloudModel);
        definition = sync.definition;
      }
      cloudSelectionApplied = true;
      if (shouldAcknowledgeCloudSelection) {
        try {
          await acknowledgeCloudBotModelSelection({
            botId,
            auth,
            fetchImpl: options.fetchImpl,
          }, cloudSelection);
        } catch (error) {
          Logger.warning(`CatsCo 云端模型应用状态回报失败，不影响本次启动: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      try {
        if (previousCloudDefinition) {
          definitionService.acceptCloud(botId, previousCloudDefinition.model);
          definition = previousCloudDefinition;
        } else {
          definitionService.clearCloudModelOverride(botId);
          definition = localDefinition;
        }
        if (previousCloudRuntime) {
          definitionService.storeCloudCatalogRuntime(previousCloudRuntime);
        }
      } catch (restoreError) {
        Logger.warning(`CatsCo 云端模型覆盖恢复失败: ${errorMessage(restoreError)}`);
      }
      const message = redactCloudBotModelError(error, cloudSelection);
      cloudApplyError = message;
      Logger.warning(`CatsCo 云端模型 ${cloudSelection.modelId} 应用失败，保留上一份本地配置: ${message}`);
      if (shouldAcknowledgeCloudSelection) {
        try {
          await acknowledgeCloudBotModelSelection({
            botId,
            auth,
            fetchImpl: options.fetchImpl,
          }, cloudSelection, message);
        } catch (ackError) {
          Logger.warning(`CatsCo 云端模型失败状态回报失败: ${errorMessage(ackError)}`);
        }
      }
    }
  }

  if (
    selectedCatalogRuntime
    && !selectedCatalogRuntimeApplied
    && (!cloudSelectionApplied || cloudSelection?.kind === 'local')
  ) {
    definitionService.storeCatalogRuntime(selectedCatalogRuntime);
    sync = definitionService.publish(botId, {
      kind: 'catalog',
      modelId: selectedCatalogRuntime.modelId,
    });
    localDefinition = sync.definition;
    definition = definitionService.readCloudModelOverride(botId) ?? sync.definition;
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

  const activeCloudOverride = definitionService.readCloudModelOverride(botId);
  if (activeCloudOverride) definition = activeCloudOverride;
  if (definition.model.kind === 'catalog') {
    const runtime = activeCloudOverride
      ? definitionService.readCloudCatalogRuntime(botId)
      : definitionService.readCatalogRuntime(botId);
    if (!runtime || !catalogRuntimeMatchesModelId(runtime, definition.model.modelId)) {
      const materialized = await provisionCatsRelayCatalogRuntime({
        botId,
        modelId: definition.model.modelId,
        auth,
        fetchImpl: options.fetchImpl,
      });
      if (activeCloudOverride) definitionService.storeCloudCatalogRuntime(materialized);
      else definitionService.storeCatalogRuntime(materialized);
      materializedCatalogRuntime = true;
    } else if (catalogCapabilitiesNeedRefresh(runtime)) {
      const refreshed = await refreshCatsRelayCatalogRuntimeCapabilities(runtime, options.fetchImpl ?? fetch);
      if (refreshed !== runtime) {
        if (activeCloudOverride) definitionService.storeCloudCatalogRuntime(refreshed);
        else definitionService.storeCatalogRuntime(refreshed);
      }
    }
  }

  definitionService.clearLegacyModelConfigurationWhenReady(definition);
  if (!definitionService.read(botId)) {
    definitionService.publish(botId, {
      kind: 'catalog',
      modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
    });
  }
  await getPromptReconcileCoordinator({
    runtimeRoot: options.runtimeRoot,
    env: options.env,
    definitionService,
  }).activateBot(botId);
  return {
    botId,
    definition,
    sync,
    initializedDefault,
    materializedCatalogRuntime,
    ...(cloudSelection ? { cloudSelection } : {}),
    ...(cloudApplyError ? { cloudApplyError } : {}),
    ...(cloudSelectionApplied && cloudSelection ? { cloudRevision: cloudSelection.revision } : {}),
  };
}

function catalogCapabilitiesNeedRefresh(runtime: BotCatalogModelRuntime): boolean {
  if (!['relay-models', 'models-dev'].includes(runtime.capabilitiesSource || '') || !runtime.capabilitiesCheckedAt) return true;
  const checkedAt = Date.parse(runtime.capabilitiesCheckedAt);
  return !Number.isFinite(checkedAt) || Date.now() - checkedAt >= 24 * 60 * 60 * 1000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

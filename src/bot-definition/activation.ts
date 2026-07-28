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
  acknowledgeCloudBotModelSelection,
  pullCloudBotModelSelection,
  redactCloudBotModelError,
  type CloudBotModelSelection,
} from './cloud-client';
import {
  BotDefinitionRevisionConflictError,
  pullCloudBotDefinition,
  redactBotDefinitionError,
} from './definition-client';
import type { CloudBotDefinitionSnapshot } from './types';

export interface PrepareBoundBotDefinitionOptions extends BotDefinitionSyncServiceOptions {
  runtimeRoot: string;
  botId?: string;
  selectedCatalogRuntime?: BotCatalogModelRuntime;
  auth?: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
  cloudSelection?: CloudBotModelSelection;
  acknowledgeCloudSelection?: boolean;
  stageCloudDefinition?: boolean;
}

export interface PreparedBoundBotDefinition {
  botId: string;
  definition: BotDefinition;
  sync?: BotDefinitionSyncResult;
  initializedDefault: boolean;
  materializedCatalogRuntime: boolean;
  cloudRevision?: number;
  cloudDefinitionSnapshot?: CloudBotDefinitionSnapshot;
  cloudDefinitionApplyError?: string;
  cloudDefinitionHasPendingLocal?: boolean;
  cloudDefinitionManaged?: boolean;
  stagedCatalogRuntime?: BotCatalogModelRuntime;
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
  const previousCloudDefinition = definitionService.readCloudModelOverride(botId);
  const previousCloudRuntime = definitionService.readCloudCatalogRuntime(botId);
  let definition = previousCloudDefinition ?? localDefinition;
  const auth = options.auth ?? createCatsCoLocalConfigService({ runtimeRoot: options.runtimeRoot }).getAuthState();
  let cloudDefinitionSnapshot: CloudBotDefinitionSnapshot | undefined;
  let fullDefinitionActive = false;
  let usingPendingDefinition = false;
  let initializedDefault = false;
  let materializedCatalogRuntime = false;
  let stagedCatalogRuntime: BotCatalogModelRuntime | undefined;
  let cloudSelection = options.cloudSelection;
  let cloudApplyError: string | undefined;
  let cloudSelectionApplied = false;
  let selectedCatalogRuntimeApplied = false;
  const shouldAcknowledgeCloudSelection = options.acknowledgeCloudSelection !== false;

  try {
    await definitionService.retryPendingCloudAck(botId, auth, options.fetchImpl);
  } catch (error) {
    Logger.warning(`CatsCo BotDefinition ACK 暂时无法重试，继续使用本地配置: ${errorMessage(error)}`);
  }

  const cloudState = definitionService.readCloudState(botId);
  const previousAppliedSnapshot = cloudState.appliedSnapshot;
  const previousLocalDefinition = localDefinition;
  if (cloudState.definitionProtocolSeen || cloudState.snapshot || cloudState.appliedSnapshot) {
    fullDefinitionActive = true;
  }
  if (previousAppliedSnapshot) {
    const effective = cloudState.pendingPatch
      ? definitionService.applyPendingChanges(
        previousAppliedSnapshot.definition,
        cloudState.pendingPatch.changes,
      )
      : previousAppliedSnapshot.definition;
    if (cloudState.pendingPatch) {
      definitionService.restoreLocalDefinitionCache(effective);
      usingPendingDefinition = true;
    } else {
      definitionService.promoteCloudDefinition(previousAppliedSnapshot);
    }
    cloudDefinitionSnapshot = previousAppliedSnapshot;
    definition = effective;
    localDefinition = definition;
    fullDefinitionActive = true;
  }
  if (cloudState.pendingPatch?.status === 'conflicted') {
    Logger.warning(
      `CatsCo BotDefinition 本地修改与云端 revision=${cloudState.pendingPatch.conflictRevision ?? 'unknown'} 冲突，`
      + '已保留本地修改并停止自动覆盖。',
    );
  } else {
    try {
      if (cloudState.pendingPatch) {
        cloudDefinitionSnapshot = await definitionService.flushPendingCloudPatch(
          botId,
          auth,
          options.fetchImpl,
        );
      } else {
        const remote = await pullCloudBotDefinition({ botId, auth, fetchImpl: options.fetchImpl });
        if (remote.kind === 'found') {
          cloudDefinitionSnapshot = remote.snapshot;
          definitionService.acceptCloudDefinition(remote.snapshot);
        } else if (remote.kind === 'migration_required') {
          definitionService.markCloudDefinitionProtocolSeen(botId);
          fullDefinitionActive = true;
          if (remote.legacyModel) {
            if (localDefinition) {
              localDefinition = definitionService.updateModel(botId, remote.legacyModel).definition;
            } else {
              localDefinition = definitionService.publish(botId, remote.legacyModel).definition;
            }
          }
          if (!localDefinition) {
            localDefinition = definitionService.publish(botId, {
              kind: 'catalog',
              modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
            }).definition;
            initializedDefault = true;
          }
          if (!localDefinition.prompt) {
            localDefinition = definitionService.updatePrompt(botId, { selected: 'default' }).definition;
          }
          definitionService.updateModel(botId, localDefinition.model);
          definitionService.updatePrompt(botId, localDefinition.prompt!);
          cloudDefinitionSnapshot = await definitionService.flushPendingCloudPatch(
            botId,
            auth,
            options.fetchImpl,
          );
        }
      }
      if (cloudDefinitionSnapshot) {
        fullDefinitionActive = true;
        const latestPending = definitionService.readCloudState(botId).pendingPatch;
        definition = latestPending
          ? definitionService.applyPendingChanges(cloudDefinitionSnapshot.definition, latestPending.changes)
          : cloudDefinitionSnapshot.definition;
        usingPendingDefinition = Boolean(latestPending);
        localDefinition = definition;
      }
    } catch (error) {
      if (error instanceof BotDefinitionRevisionConflictError) {
        fullDefinitionActive = true;
        Logger.warning(
          `CatsCo BotDefinition revision 冲突（云端 ${error.currentRevision ?? 'unknown'}），`
          + '已保留本地 pending 修改，未用云端值覆盖。',
        );
      } else {
        Logger.warning(
          `CatsCo BotDefinition 暂时不可用，继续使用上次本地缓存: `
          + redactBotDefinitionError(error, definition),
        );
      }
    }
  }

  if (!fullDefinitionActive && !cloudSelection) {
    try {
      cloudSelection = await pullCloudBotModelSelection({
        botId,
        auth,
        fetchImpl: options.fetchImpl,
      });
    } catch (error) {
      Logger.warning(`CatsCo 云端模型配置暂时不可用，继续使用本地配置: ${errorMessage(error)}`);
    }
  }

  if (!fullDefinitionActive && cloudSelection) {
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

  let cloudDefinitionApplyError: string | undefined;
  try {
    const activeCloudOverride = fullDefinitionActive
      ? undefined
      : definitionService.readCloudModelOverride(botId);
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
        if (options.stageCloudDefinition && fullDefinitionActive) {
          stagedCatalogRuntime = materialized;
        } else if (activeCloudOverride) {
          definitionService.storeCloudCatalogRuntime(materialized);
        } else {
          definitionService.storeCatalogRuntime(materialized);
        }
        materializedCatalogRuntime = true;
      } else if (catalogCapabilitiesNeedRefresh(runtime)) {
        const refreshed = await refreshCatsRelayCatalogRuntimeCapabilities(runtime, options.fetchImpl ?? fetch);
        if (refreshed !== runtime) {
          if (options.stageCloudDefinition && fullDefinitionActive) {
            stagedCatalogRuntime = refreshed;
          } else if (activeCloudOverride) {
            definitionService.storeCloudCatalogRuntime(refreshed);
          } else {
            definitionService.storeCatalogRuntime(refreshed);
          }
        }
      }
    }

    if (!fullDefinitionActive) {
      definitionService.clearLegacyModelConfigurationWhenReady(definition);
    }
    if (!definitionService.read(botId)) {
      definitionService.publish(botId, {
        kind: 'catalog',
        modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
      });
    }
    if (fullDefinitionActive && cloudDefinitionSnapshot && !options.stageCloudDefinition) {
      if (usingPendingDefinition) {
        definitionService.restoreLocalDefinitionCache(definition);
      } else {
        definitionService.promoteCloudDefinition(cloudDefinitionSnapshot);
        definition = cloudDefinitionSnapshot.definition;
      }
    }
    if (!options.stageCloudDefinition) {
      await getPromptReconcileCoordinator({
        runtimeRoot: options.runtimeRoot,
        env: options.env,
        definitionService,
      }).activateBot(botId);
    }
  } catch (error) {
    if (!fullDefinitionActive || !cloudDefinitionSnapshot) throw error;
    cloudDefinitionApplyError = redactBotDefinitionError(error, cloudDefinitionSnapshot.definition);
    if (previousAppliedSnapshot) {
      definitionService.promoteCloudDefinition(previousAppliedSnapshot);
      definition = previousAppliedSnapshot.definition;
    } else if (previousLocalDefinition) {
      definitionService.restoreLocalDefinitionCache(previousLocalDefinition);
      definition = previousLocalDefinition;
    } else {
      throw error;
    }
    try {
      await definitionService.acknowledgeCloudDefinition(
        botId,
        cloudDefinitionSnapshot.revision,
        auth,
        cloudDefinitionApplyError,
        options.fetchImpl,
      );
    } catch {
      // The failed ACK remains durable and is retried after reconnect.
    }
    await getPromptReconcileCoordinator({
      runtimeRoot: options.runtimeRoot,
      env: options.env,
      definitionService,
    }).activateBot(botId);
    Logger.warning(
      `CatsCo BotDefinition revision=${cloudDefinitionSnapshot.revision} 应用失败，`
      + `已恢复上一份本地配置: ${cloudDefinitionApplyError}`,
    );
  }
  return {
    botId,
    definition,
    sync,
    initializedDefault,
    materializedCatalogRuntime,
    ...(cloudSelection ? { cloudSelection } : {}),
    ...(cloudDefinitionSnapshot ? { cloudDefinitionSnapshot } : {}),
    ...(cloudDefinitionApplyError ? { cloudDefinitionApplyError } : {}),
    ...(usingPendingDefinition ? { cloudDefinitionHasPendingLocal: true } : {}),
    ...(fullDefinitionActive ? { cloudDefinitionManaged: true } : {}),
    ...(stagedCatalogRuntime ? { stagedCatalogRuntime } : {}),
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

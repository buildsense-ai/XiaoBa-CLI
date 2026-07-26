import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { ChatConfig } from '../types';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { CatsCoConnectorLock, acquireCatsCoConnectorLock, isProcessAlive } from '../catscompany/connector-lock';
import { PathResolver } from '../utils/path-resolver';
import { prepareBoundBotDefinition } from '../bot-definition/activation';
import { isRuntimeShutdownMessage } from '../utils/runtime-shutdown-message';
import { createCatsCoLocalConfigService, type CatsCoAuthSnapshot } from '../catscompany/local-config';
import {
  acknowledgeCloudBotModelSelection,
  pullCloudBotModelSelection,
  redactCloudBotModelError,
  type CloudBotModelSelection,
} from '../bot-definition/cloud-client';
import { CloudBotModelRuntimeReloadController } from '../bot-definition/runtime-reload';
import { createBotDefinitionSyncService } from '../bot-definition/service';

const CONNECTOR_OWNER_POLL_MS = 2000;
const CLOUD_MODEL_POLL_MS = 5000;

export interface CatsCoCommandConfigResolution {
  config?: CatsCompanyConfig;
  missing: Array<'serverUrl' | 'apiKey' | 'bodyId'>;
}
export function resolveCatsCoCommandConfig(
  config: ChatConfig,
  env: NodeJS.ProcessEnv = process.env,
): CatsCoCommandConfigResolution {
  const resolved = resolveCatsCoRuntimeConfig({ runtimeRoot: PathResolver.getRuntimeDataRoot(), env, config });
  return {
    missing: resolved.missing,
    config: resolved.connector,
  };
}

/**
 * CLI 命令：catsco connect / catsco catscompany / xiaoba catscompany
 * 启动 CatsCompany WebSocket connector
 */
export async function catscompanyCommand(): Promise<void> {
  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  const preparedBot = await prepareBoundBotDefinition({
    runtimeRoot,
    acknowledgeCloudSelection: false,
  });
  if (preparedBot?.cloudRevision !== undefined) {
    Logger.info(`CatsCo bot ${preparedBot.botId} 已准备云端模型配置 revision=${preparedBot.cloudRevision}。`);
  } else if (preparedBot?.initializedDefault) {
    Logger.info(`CatsCo bot ${preparedBot.botId} 已自动初始化默认模型 MiniMax M3。`);
  } else if (preparedBot?.materializedCatalogRuntime) {
    Logger.info(`CatsCo bot ${preparedBot.botId} 已在当前设备准备 ${preparedBot.definition.model.kind === 'catalog' ? preparedBot.definition.model.modelId : '模型'} 的运行材料。`);
  }
  const config = ConfigManager.getConfig();
  const resolvedRuntime = resolveCatsCoRuntimeConfig({ runtimeRoot, env: process.env, config });
  Object.assign(process.env, resolvedRuntime.envOverlay);
  const resolved: CatsCoCommandConfigResolution = {
    missing: resolvedRuntime.missing,
    config: resolvedRuntime.connector,
  };

  const connectorConfig = resolved.config;
  if (!connectorConfig) {
    Logger.error(`CatsCo 配置缺失：${resolved.missing.join(', ') || 'unknown'}。`);
    Logger.error('请先在 Dashboard 登录 CatsCo 并选择/绑定机器人，或设置兼容环境变量。');
    process.exit(1);
  }

  const bodyId = connectorConfig.bodyId;
  if (!bodyId) {
    Logger.error('CatsCo connector missing bodyId; cannot start.');
    process.exit(1);
  }

  const configuredOwnerPid = Number(process.env.CATSCO_CONNECTOR_OWNER_PID);
  const ownerPid = Number.isInteger(configuredOwnerPid) && configuredOwnerPid > 0 && configuredOwnerPid !== process.pid
    ? configuredOwnerPid
    : undefined;
  const connectorLock = acquireCatsCoConnectorLock({
    runtimeRoot,
    bodyId,
    command: process.argv.join(' '),
    ownerPid,
  });
  if (!connectorLock.acquired) {
    Logger.error(
      `CatsCo connector 已由另一个进程运行，无法重复启动。bodyId=${bodyId}, pid=${connectorLock.existing.pid}`,
    );
    Logger.warning('已跳过第二条 CatsCo WebSocket 连接，避免同一设备重复连接互相挤下线。');
    process.exitCode = 2;
    return;
  }

  let bot = new CatsCompanyBot(connectorConfig);
  let lock: CatsCoConnectorLock | null = connectorLock;
  let ownerWatchTimer: NodeJS.Timeout | null = null;
  let cloudModelWatchTimer: NodeJS.Timeout | null = null;
  let cloudModelReloadPromise: Promise<void> | null = null;
  let pendingCloudModelAck: PendingCloudModelAck | null = null;
  let shuttingDown = false;

  // 优雅退出
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (ownerWatchTimer) {
      clearInterval(ownerWatchTimer);
      ownerWatchTimer = null;
    }
    if (cloudModelWatchTimer) {
      clearInterval(cloudModelWatchTimer);
      cloudModelWatchTimer = null;
    }
    try {
      await cloudModelReloadPromise;
      await stopRuntimeCommandSupport();
      await bot.destroy();
    } finally {
      lock?.release();
      lock = null;
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', message => {
    if (isRuntimeShutdownMessage(message)) void shutdown();
  });
  process.on('disconnect', () => { void shutdown(); });
  process.on('exit', () => {
    lock?.release();
    lock = null;
  });

  if (ownerPid) {
    ownerWatchTimer = setInterval(() => {
      if (isProcessAlive(ownerPid)) return;
      Logger.warning(`CatsCo Dashboard owner process 已退出，正在关闭孤儿 connector。ownerPid=${ownerPid}`);
      void shutdown();
    }, CONNECTOR_OWNER_POLL_MS);
  }

  try {
    await bot.start();
    await startRuntimeCommandSupport();
    const auth = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();
    const modelBotId = String(preparedBot?.botId || connectorConfig.botUid || '').trim();
    if (preparedBot?.cloudSelection) {
      const initialApplyError = preparedBot.cloudApplyError || '';
      try {
        await acknowledgeCloudBotModelSelection(
          { botId: modelBotId, auth },
          preparedBot.cloudSelection,
          initialApplyError,
        );
      } catch (error) {
        pendingCloudModelAck = {
          selection: preparedBot.cloudSelection,
          applyError: initialApplyError,
          attempts: 0,
        };
        Logger.warning(`CatsCo 启动模型状态回报失败，将自动重试: ${errorMessage(error)}`);
      }
    }
    let lastCloudPollWarningAt = 0;
    const reloadController = new CloudBotModelRuntimeReloadController({
      initialRevision: preparedBot?.cloudSelection?.revision,
      pullSelection: async () => {
        const selection = await pullCloudBotModelSelection({ botId: modelBotId, auth });
        if (
          pendingCloudModelAck
          && (!selection || selection.revision > pendingCloudModelAck.selection.revision)
        ) {
          pendingCloudModelAck = null;
        }
        return selection;
      },
      isIdle: () => !shuttingDown && bot.isIdleForRuntimeReload(),
      applySelection: async selection => applyCloudModelRuntimeSelection({
        runtimeRoot,
        connectorConfig,
        currentBot: () => bot,
        replaceBot: next => { bot = next; },
        botId: modelBotId,
        canApply: () => !shuttingDown,
        scheduleAckRetry: (selection, applyError) => {
          pendingCloudModelAck = { selection, applyError, attempts: 0 };
        },
        clearAckRetry: selection => {
          if (pendingCloudModelAck?.selection.revision === selection.revision) {
            pendingCloudModelAck = null;
          }
        },
        selection,
        auth,
      }),
      onError: (error, selection) => {
        const now = Date.now();
        if (selection || now - lastCloudPollWarningAt >= 60_000) {
          lastCloudPollWarningAt = now;
          Logger.warning(
            selection
              ? `CatsCo 云端模型 revision=${selection.revision} 运行时切换失败: ${errorMessage(error)}`
              : `CatsCo 云端模型轮询失败，继续使用当前模型: ${errorMessage(error)}`,
          );
        }
      },
    });
    cloudModelWatchTimer = setInterval(() => {
      if (cloudModelReloadPromise) return;
      const run = (async () => {
        if (pendingCloudModelAck) {
          const pending = pendingCloudModelAck;
          try {
            await acknowledgeCloudBotModelSelection({ botId: modelBotId, auth }, pending.selection, pending.applyError);
            if (pendingCloudModelAck === pending) pendingCloudModelAck = null;
          } catch (error) {
            pending.attempts += 1;
            if (pending.attempts % 12 === 0 && pendingCloudModelAck === pending) {
              Logger.warning(
                `CatsCo 云端模型 revision=${pending.selection.revision} 状态回报仍在重试: ${errorMessage(error)}`,
              );
            }
          }
        }
        await reloadController.pollOnce();
      })();
      cloudModelReloadPromise = run;
      void run.finally(() => {
        if (cloudModelReloadPromise === run) cloudModelReloadPromise = null;
      });
    }, CLOUD_MODEL_POLL_MS);
  } catch (error) {
    if (ownerWatchTimer) {
      clearInterval(ownerWatchTimer);
      ownerWatchTimer = null;
    }
    lock?.release();
    lock = null;
    throw error;
  }
}

interface ApplyCloudModelRuntimeSelectionOptions {
  runtimeRoot: string;
  connectorConfig: CatsCompanyConfig;
  currentBot(): CatsCompanyBot;
  replaceBot(bot: CatsCompanyBot): void;
  botId: string;
  canApply(): boolean;
  scheduleAckRetry(selection: CloudBotModelSelection, applyError: string): void;
  clearAckRetry(selection: CloudBotModelSelection): void;
  selection: CloudBotModelSelection;
  auth: CatsCoAuthSnapshot;
}

interface PendingCloudModelAck {
  selection: CloudBotModelSelection;
  applyError: string;
  attempts: number;
}

async function applyCloudModelRuntimeSelection(
  options: ApplyCloudModelRuntimeSelectionOptions,
): Promise<'applied' | 'deferred'> {
  const botId = options.botId;
  if (!botId || !options.canApply()) return 'deferred';
  const definitionService = createBotDefinitionSyncService({ runtimeRoot: options.runtimeRoot });
  definitionService.pullOrBootstrap(botId);
  const previousCloudDefinition = definitionService.readCloudModelOverride(botId);
  const previousCloudRuntime = definitionService.readCloudCatalogRuntime(botId);
  const restorePreviousModelFiles = () => {
    if (previousCloudDefinition) definitionService.acceptCloud(botId, previousCloudDefinition.model);
    else definitionService.clearCloudModelOverride(botId);
    if (previousCloudRuntime) definitionService.storeCloudCatalogRuntime(previousCloudRuntime);
  };

  let prepared: Awaited<ReturnType<typeof prepareBoundBotDefinition>>;
  try {
    prepared = await prepareBoundBotDefinition({
      runtimeRoot: options.runtimeRoot,
      botId,
      auth: options.auth,
      cloudSelection: options.selection,
      acknowledgeCloudSelection: false,
    });
  } catch (error) {
    restorePreviousModelFiles();
    const message = redactCloudBotModelError(error, options.selection);
    await acknowledgeCloudModelApply(options, message);
    throw new Error(message);
  }
  if (!prepared || prepared.cloudRevision !== options.selection.revision || prepared.cloudApplyError) {
    const message = prepared?.cloudApplyError || '云端模型运行材料未能完成准备。';
    restorePreviousModelFiles();
    await acknowledgeCloudModelApply(options, message);
    throw new Error(message);
  }

  let latestSelection: CloudBotModelSelection | undefined;
  try {
    latestSelection = await pullCloudBotModelSelection({ botId, auth: options.auth });
  } catch (error) {
    restorePreviousModelFiles();
    Logger.warning(`CatsCo 模型切换复核失败，已延后本次切换: ${errorMessage(error)}`);
    return 'deferred';
  }
  if (!cloudSelectionsMatch(latestSelection, options.selection)) {
    restorePreviousModelFiles();
    return 'deferred';
  }

  if (options.selection.kind === 'local' && !previousCloudDefinition) {
    await acknowledgeCloudModelApply(options);
    return 'applied';
  }

  const previousBot = options.currentBot();
  if (!options.canApply() || !previousBot.isIdleForRuntimeReload()) {
    restorePreviousModelFiles();
    return 'deferred';
  }

  let nextBot: CatsCompanyBot | undefined;
  try {
    await previousBot.destroy();
    nextBot = new CatsCompanyBot(options.connectorConfig);
    await nextBot.start();
    await nextBot.waitUntilReady();
    options.replaceBot(nextBot);
  } catch (error) {
    if (nextBot) {
      await nextBot.destroy().catch(cleanupError => {
        Logger.warning(`CatsCo 未启动的新 connector 清理失败: ${errorMessage(cleanupError)}`);
      });
    }
    restorePreviousModelFiles();
    const safeMessage = redactCloudBotModelError(error, options.selection);
    await acknowledgeCloudModelApply(options, safeMessage);
    await recoverCloudModelFallbackConnector({
      canApply: options.canApply,
      createBot: () => new CatsCompanyBot(options.connectorConfig),
      replaceBot: options.replaceBot,
    });
    throw new Error(safeMessage);
  }

  await acknowledgeCloudModelApply(options);
  Logger.success(
    `CatsCo 已在线切换模型到 ${options.selection.modelId}`
      + `${options.selection.reasoningEffort ? ` (${options.selection.reasoningEffort})` : ''}`
      + `，revision=${options.selection.revision}。`,
  );
  return 'applied';
}

interface RecoverCloudModelFallbackConnectorOptions {
  canApply(): boolean;
  createBot(): CatsCompanyBot;
  replaceBot(bot: CatsCompanyBot): void;
  retryDelayMs?: number;
}

export async function recoverCloudModelFallbackConnector(
  options: RecoverCloudModelFallbackConnectorOptions,
): Promise<void> {
  let attempt = 0;
  while (options.canApply()) {
    attempt += 1;
    let fallbackBot: CatsCompanyBot | undefined;
    try {
      fallbackBot = options.createBot();
      await fallbackBot.start();
      options.replaceBot(fallbackBot);
      try {
        await fallbackBot.waitUntilReady();
      } catch (error) {
        Logger.error(`CatsCo 模型切换回滚后握手仍未恢复，connector 将继续自动重连: ${errorMessage(error)}`);
      }
      return;
    } catch (error) {
      if (fallbackBot) await fallbackBot.destroy().catch(() => undefined);
      Logger.error(`CatsCo 模型切换回滚后 connector 第 ${attempt} 次启动失败，将自动重试: ${errorMessage(error)}`);
      if (!options.canApply()) break;
      await delay(options.retryDelayMs ?? Math.min(30_000, attempt * 5_000));
    }
  }
  throw new Error('CatsCo connector fallback recovery was cancelled.');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function acknowledgeCloudModelApply(
  options: ApplyCloudModelRuntimeSelectionOptions,
  applyError = '',
): Promise<void> {
  try {
    await acknowledgeCloudBotModelSelection({
      botId: options.botId,
      auth: options.auth,
    }, options.selection, applyError);
    options.clearAckRetry(options.selection);
  } catch (error) {
    options.scheduleAckRetry(options.selection, applyError);
    Logger.warning(`CatsCo 云端模型应用状态回报失败: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloudSelectionsMatch(
  current: CloudBotModelSelection | undefined,
  expected: CloudBotModelSelection,
): boolean {
  return current?.revision === expected.revision
    && (current.kind || 'catalog') === (expected.kind || 'catalog')
    && current.modelId === expected.modelId
    && (current.reasoningEffort || '') === (expected.reasoningEffort || '');
}

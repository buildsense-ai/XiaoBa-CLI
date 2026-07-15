import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { ChatConfig } from '../types';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { CatsCoConnectorLock, acquireCatsCoConnectorLock, isProcessAlive } from '../catscompany/connector-lock';
import { createBotDefinitionSyncService } from '../bot-definition/service';
import { PathResolver } from '../utils/path-resolver';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { provisionCatsRelayCatalogRuntime } from '../catscompany/relay-model-bootstrap';
import { DEFAULT_CATSCO_RELAY_MODEL_ID } from '../utils/relay-model-profiles';

const CONNECTOR_OWNER_POLL_MS = 2000;

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
  await ensureBoundBotModelDefinition(runtimeRoot);
  const config = ConfigManager.getConfig();
  const resolved = resolveCatsCoCommandConfig(config);

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

  const bot = new CatsCompanyBot(connectorConfig);
  let lock: CatsCoConnectorLock | null = connectorLock;
  let ownerWatchTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  // 优雅退出
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (ownerWatchTimer) {
      clearInterval(ownerWatchTimer);
      ownerWatchTimer = null;
    }
    try {
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

/**
 * Connector startup is also the device-switch boundary. It first pulls the
 * selected Definition and materializes its catalog runtime locally. A bot
 * with no Definition or legacy model is initialized to the product default,
 * MiniMax M3, only after its relay material is ready.
 */
async function ensureBoundBotModelDefinition(runtimeRoot: string): Promise<void> {
  const localConfig = createCatsCoLocalConfigService({ runtimeRoot }).load();
  const botId = String(localConfig.currentBot?.uid || '').trim();
  if (!botId) return;

  const definitionService = createBotDefinitionSyncService({ runtimeRoot });
  let result = definitionService.pullOrBootstrap(botId);
  let definition = result?.definition;
  const auth = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();

  if (!definition) {
    const runtime = await provisionCatsRelayCatalogRuntime({
      botId,
      modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
      auth,
    });
    definitionService.storeCatalogRuntime(runtime);
    result = definitionService.publish(botId, {
      kind: 'catalog',
      modelId: DEFAULT_CATSCO_RELAY_MODEL_ID,
    });
    definition = result.definition;
    Logger.info(`CatsCo bot ${botId} 已自动初始化默认模型 MiniMax M3。`);
  }

  if (definition.model.kind !== 'catalog') return;
  const runtime = definitionService.readCatalogRuntime(botId);
  if (runtime?.modelId === definition.model.modelId) return;

  const materialized = await provisionCatsRelayCatalogRuntime({
    botId,
    modelId: definition.model.modelId,
    auth,
  });
  definitionService.storeCatalogRuntime(materialized);
  Logger.info(`CatsCo bot ${botId} 已在当前设备准备 ${definition.model.modelId} 的运行材料。`);
}

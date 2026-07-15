import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { ChatConfig } from '../types';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { CatsCoConnectorLock, acquireCatsCoConnectorLock } from '../catscompany/connector-lock';
import { isRuntimeShutdownMessage } from '../utils/runtime-shutdown-message';

export interface CatsCoCommandConfigResolution {
  config?: CatsCompanyConfig;
  missing: Array<'serverUrl' | 'apiKey' | 'bodyId'>;
}

export function resolveCatsCoCommandConfig(
  config: ChatConfig,
  env: NodeJS.ProcessEnv = process.env,
): CatsCoCommandConfigResolution {
  const resolved = resolveCatsCoRuntimeConfig({ runtimeRoot: process.cwd(), env, config });
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

  const connectorLock = acquireCatsCoConnectorLock({
    runtimeRoot: process.cwd(),
    bodyId,
    command: process.argv.join(' '),
  });
  if (!connectorLock.acquired) {
    Logger.warning(
      `CatsCo connector already running for this device; skip duplicate startup. bodyId=${bodyId}, pid=${connectorLock.existing.pid}`,
    );
    Logger.warning('已跳过第二条 CatsCo WebSocket 连接，避免同一设备重复连接互相挤下线。');
    return;
  }

  const bot = new CatsCompanyBot(connectorConfig);
  let lock: CatsCoConnectorLock | null = connectorLock;
  let shuttingDown = false;

  // 优雅退出
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopRuntimeCommandSupport();
    await bot.destroy();
    lock?.release();
    lock = null;
    process.exit(0);
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

  try {
    await bot.start();
    await startRuntimeCommandSupport();
  } catch (error) {
    lock?.release();
    lock = null;
    throw error;
  }
}

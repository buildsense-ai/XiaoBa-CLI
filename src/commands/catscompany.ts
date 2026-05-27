import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { ChatConfig } from '../types';

export interface CatsCoCommandConfigResolution {
  config?: CatsCompanyConfig;
  missing: Array<'serverUrl' | 'apiKey' | 'bodyId'>;
}

export function resolveCatsCoCommandConfig(
  config: ChatConfig,
  env: NodeJS.ProcessEnv = process.env,
): CatsCoCommandConfigResolution {
  const resolved = resolveCatsCoRuntimeConfig({
    runtimeRoot: env.XIAOBA_RUNTIME_ROOT || process.cwd(),
    env,
    config,
  });
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

  if (!resolved.config) {
    Logger.error('CatsCo 配置缺失。请设置环境变量 CATSCO_SERVER_URL 和 CATSCO_API_KEY，');
    Logger.error('或继续使用兼容变量 CATSCOMPANY_SERVER_URL / CATSCOMPANY_API_KEY。');
    Logger.error('也可以在 ~/.xiaoba/config.json 中配置 catscompany.serverUrl 和 catscompany.apiKey。');
    process.exit(1);
  }

  const bot = new CatsCompanyBot(resolved.config);

  // 优雅退出
  const shutdown = async () => {
    await stopRuntimeCommandSupport();
    await bot.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
  await startRuntimeCommandSupport();
}

import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { ChatConfig } from '../types';

export interface CatsCoCommandConfigResolution {
  config?: CatsCompanyConfig;
  missing: Array<'serverUrl' | 'apiKey'>;
}

function firstEnv(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function resolveCatsCoCommandConfig(
  config: ChatConfig,
  env: NodeJS.ProcessEnv = process.env,
): CatsCoCommandConfigResolution {
  const serverUrl = firstEnv(env, 'CATSCO_SERVER_URL', 'CATSCOMPANY_SERVER_URL')
    || config.catscompany?.serverUrl;
  const apiKey = firstEnv(env, 'CATSCO_API_KEY', 'CATSCOMPANY_API_KEY')
    || config.catscompany?.apiKey;
  const httpBaseUrl = firstEnv(env, 'CATSCO_HTTP_BASE_URL', 'CATSCOMPANY_HTTP_BASE_URL')
    || config.catscompany?.httpBaseUrl;

  const missing: CatsCoCommandConfigResolution['missing'] = [];
  if (!serverUrl) missing.push('serverUrl');
  if (!apiKey) missing.push('apiKey');

  if (!serverUrl || !apiKey) {
    return { missing };
  }

  return {
    missing: [],
    config: {
      serverUrl,
      apiKey,
      httpBaseUrl,
      sessionTTL: config.catscompany?.sessionTTL,
    },
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

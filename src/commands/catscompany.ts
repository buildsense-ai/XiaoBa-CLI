import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { ChatConfig } from '../types';
import { resolveRuntimeProfileFromConfig } from '../runtime/runtime-profile-config';

export interface CatsCompanyCommandOptions {
  profile?: string;
}

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
export async function catscompanyCommand(options: CatsCompanyCommandOptions = {}): Promise<void> {
  const config = ConfigManager.getConfig();
  const resolved = resolveCatsCoCommandConfig(config);
  const runtimeProfile = resolveRuntimeProfileFromConfig({
    configPath: options.profile,
    surface: 'catscompany',
    workingDirectory: process.cwd(),
  }).profile;
  const runtimeSupportEnabled = runtimeProfile.logging.uploadEnabled !== false;
  let runtimeSupportStarted = false;

  if (!resolved.config) {
    Logger.error('CatsCo 配置缺失。请设置环境变量 CATSCO_SERVER_URL 和 CATSCO_API_KEY，');
    Logger.error('或继续使用兼容变量 CATSCOMPANY_SERVER_URL / CATSCOMPANY_API_KEY。');
    Logger.error('也可以在 ~/.xiaoba/config.json 中配置 catscompany.serverUrl 和 catscompany.apiKey。');
    process.exit(1);
  }

  const botConfig: CatsCompanyConfig = {
    ...resolved.config,
    runtimeProfilePath: options.profile,
  };
  const bot = new CatsCompanyBot(botConfig);

  // 优雅退出
  const shutdown = async () => {
    if (runtimeSupportStarted) {
      await stopRuntimeCommandSupport();
    }
    await bot.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
  if (runtimeSupportEnabled) {
    await startRuntimeCommandSupport();
    runtimeSupportStarted = true;
  }
}

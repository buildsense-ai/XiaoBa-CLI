import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';

/**
 * CLI 命令：xiaoba catscompany
 * 启动 Cats Company 机器人 WebSocket 长连接服务
 */
export async function catscompanyCommand(): Promise<void> {
  const config = ConfigManager.getConfig();

  const serverUrl = process.env.CATSCOMPANY_SERVER_URL || config.catscompany?.serverUrl;
  const apiKey = process.env.CATSCOMPANY_API_KEY || config.catscompany?.apiKey;
  const httpBaseUrl = process.env.CATSCOMPANY_HTTP_BASE_URL || config.catscompany?.httpBaseUrl;

  if (!serverUrl || !apiKey) {
    Logger.error('CatsCompany 配置缺失。请设置环境变量 CATSCOMPANY_SERVER_URL 和 CATSCOMPANY_API_KEY，');
    Logger.error('或在 ~/.xiaoba/config.json 中配置 catscompany.serverUrl 和 catscompany.apiKey。');
    process.exit(1);
  }

  const botConfig: CatsCompanyConfig = {
    serverUrl,
    apiKey,
    httpBaseUrl,
    sessionTTL: config.catscompany?.sessionTTL,
  };

  const bot = new CatsCompanyBot(botConfig);

  // 优雅退出
  const shutdown = () => {
    bot.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

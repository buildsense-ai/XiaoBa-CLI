import { Logger } from '../utils/logger';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';

/**
 * CLI 命令：xiaoba catscompany
 * 启动 Cats Company 机器人 WebSocket 长连接服务
 */
export async function catscompanyCommand(): Promise<void> {
  const serverUrl = process.env.CATSCOMPANY_SERVER_URL;
  const apiKey = process.env.CATSCOMPANY_API_KEY;
  const httpBaseUrl = process.env.CATSCOMPANY_HTTP_BASE_URL;

  if (!serverUrl || !apiKey) {
    Logger.error('CatsCompany 配置缺失。请在 .env 中设置：');
    Logger.error('  CATSCOMPANY_SERVER_URL=ws://your-server/v0/channels');
    Logger.error('  CATSCOMPANY_API_KEY=your-api-key');
    process.exit(1);
  }

  const botConfig: CatsCompanyConfig = {
    serverUrl,
    apiKey,
    httpBaseUrl,
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

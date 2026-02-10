import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { FeishuBot } from '../feishu';
import { FeishuConfig } from '../feishu/types';

/**
 * CLI 命令：xiaoba feishu
 * 启动飞书机器人长连接服务
 */
export async function feishuCommand(): Promise<void> {
  const config = ConfigManager.getConfig();

  // 从环境变量或配置文件读取飞书凭据
  const appId = process.env.FEISHU_APP_ID || config.feishu?.appId;
  const appSecret = process.env.FEISHU_APP_SECRET || config.feishu?.appSecret;

  if (!appId || !appSecret) {
    Logger.error('飞书配置缺失。请设置环境变量 FEISHU_APP_ID 和 FEISHU_APP_SECRET，');
    Logger.error('或在 ~/.xiaoba/config.json 中配置 feishu.appId 和 feishu.appSecret。');
    process.exit(1);
  }

  const feishuConfig: FeishuConfig = {
    appId,
    appSecret,
    sessionTTL: config.feishu?.sessionTTL,
  };

  const bot = new FeishuBot(feishuConfig);

  // 优雅退出
  const shutdown = () => {
    bot.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

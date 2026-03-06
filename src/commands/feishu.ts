import { Logger } from '../utils/logger';
import { FeishuBot } from '../feishu';
import { FeishuConfig } from '../feishu/types';

/**
 * CLI 命令：xiaoba feishu
 * 启动飞书机器人长连接服务
 */
export async function feishuCommand(): Promise<void> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const botOpenId = process.env.FEISHU_BOT_OPEN_ID;
  const botAliases = (process.env.FEISHU_BOT_ALIASES || '小八,xiaoba')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (!appId || !appSecret) {
    Logger.error('飞书配置缺失。请在 .env 中设置：');
    Logger.error('  FEISHU_APP_ID=your-app-id');
    Logger.error('  FEISHU_APP_SECRET=your-app-secret');
    process.exit(1);
  }

  const feishuConfig: FeishuConfig = {
    appId,
    appSecret,
    botOpenId,
    botAliases,
  };

  // Bot Bridge 配置
  const bridgePort = parseInt(process.env.BOT_BRIDGE_PORT || '0', 10);
  const bridgeName = process.env.BOT_BRIDGE_NAME || '';
  const peersRaw = process.env.BOT_PEERS || '';
  if (bridgePort && bridgeName) {
    const peers = peersRaw
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => {
        const [name, url] = p.split(':http');
        return { name, url: `http${url}` };
      });
    feishuConfig.bridge = { port: bridgePort, name: bridgeName, peers };
    Logger.info(`Bot Bridge 配置: ${bridgeName} :${bridgePort}, peers: ${peers.map(p => p.name).join(', ')}`);
  }

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

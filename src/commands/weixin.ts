import { Logger } from '../utils/logger';
import { WeixinBot } from '../weixin';
import { WeixinConfig } from '../weixin/types';

export async function weixinCommand(): Promise<void> {
  const token = process.env.WEIXIN_TOKEN;
  const baseUrl = process.env.WEIXIN_BASE_URL || 'https://ilinkai.weixin.qq.com';
  const cdnBaseUrl = process.env.WEIXIN_CDN_BASE_URL || 'https://novac2c.cdn.weixin.qq.com/c2c';

  if (!token) {
    Logger.error('微信配置缺失。请设置环境变量 WEIXIN_TOKEN');
    process.exit(1);
  }

  process.env.CURRENT_PLATFORM = '微信';

  const config: WeixinConfig = { token, baseUrl, cdnBaseUrl };
  const bot = new WeixinBot(config);

  const shutdown = () => {
    bot.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

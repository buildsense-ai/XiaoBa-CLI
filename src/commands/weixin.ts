import { Logger } from '../utils/logger';
import { WeixinBot } from '../weixin';
import { WeixinConfig } from '../weixin/types';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { isRuntimeShutdownMessage } from '../utils/runtime-shutdown-message';

const WEIXIN_SESSION_EXPIRED_EXIT_CODE = 78;

export async function weixinCommand(): Promise<void> {
  const token = process.env.WEIXIN_TOKEN;
  const baseUrl = process.env.WEIXIN_BASE_URL || 'https://ilinkai.weixin.qq.com';
  const cdnBaseUrl = process.env.WEIXIN_CDN_BASE_URL || 'https://novac2c.cdn.weixin.qq.com/c2c';

  if (!token) {
    Logger.error('微信配置缺失。请设置环境变量 WEIXIN_TOKEN');
    process.exit(1);
  }

  process.env.CURRENT_PLATFORM = '微信';

  let bot: WeixinBot | undefined;
  let exiting = false;

  const shutdown = (exitCode = 0) => {
    if (exiting) return;
    exiting = true;
    Promise.resolve(stopRuntimeCommandSupport())
      .catch(() => undefined)
      .finally(() => {
        bot?.destroy();
        Logger.closeLogFile();
        process.exit(exitCode);
      });
  };

  const config: WeixinConfig = {
    token,
    baseUrl,
    cdnBaseUrl,
    onSessionExpired: () => shutdown(WEIXIN_SESSION_EXPIRED_EXIT_CODE),
  };
  bot = new WeixinBot(config);

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('message', message => {
    if (isRuntimeShutdownMessage(message)) shutdown(0);
  });
  process.on('disconnect', () => shutdown(0));

  await bot.start();
  await startRuntimeCommandSupport();
}

import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { FeishuBot } from '../feishu';
import { FeishuConfig } from '../feishu/types';
import { CatsCompanyBot } from '../catscompany';
import { CatsCompanyConfig } from '../catscompany/types';

/**
 * CLI 命令：xiaoba start
 * 同时启动所有已配置的平台机器人
 */
export async function startCommand(): Promise<void> {
  const config = ConfigManager.getConfig();
  const bots: { name: string; destroy: () => void }[] = [];

  // ── Feishu ──
  const feishuAppId = process.env.FEISHU_APP_ID || config.feishu?.appId;
  const feishuAppSecret = process.env.FEISHU_APP_SECRET || config.feishu?.appSecret;
  const hasFeishu = !!(feishuAppId && feishuAppSecret);

  // ── CatsCompany ──
  const ccServerUrl = process.env.CATSCOMPANY_SERVER_URL || config.catscompany?.serverUrl;
  const ccApiKey = process.env.CATSCOMPANY_API_KEY || config.catscompany?.apiKey;
  const hasCatsCompany = !!(ccServerUrl && ccApiKey);

  if (!hasFeishu && !hasCatsCompany) {
    Logger.error('没有找到任何平台配置。请至少配置一个平台：');
    Logger.error('  飞书: FEISHU_APP_ID + FEISHU_APP_SECRET');
    Logger.error('  CatsCompany: CATSCOMPANY_SERVER_URL + CATSCOMPANY_API_KEY');
    process.exit(1);
  }

  // 优雅退出
  const shutdown = () => {
    Logger.info('正在停止所有机器人...');
    for (const bot of bots) {
      bot.destroy();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 并行启动所有已配置的平台
  const startTasks: Promise<void>[] = [];

  if (hasFeishu) {
    const botOpenId = process.env.FEISHU_BOT_OPEN_ID || config.feishu?.botOpenId;
    const botAliases = (
      process.env.FEISHU_BOT_ALIASES
      || (config.feishu?.botAliases ? config.feishu.botAliases.join(',') : '小八,xiaoba')
    )
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    const feishuConfig: FeishuConfig = {
      appId: feishuAppId!,
      appSecret: feishuAppSecret!,
      sessionTTL: config.feishu?.sessionTTL,
      botOpenId,
      botAliases,
    };

    const feishuBot = new FeishuBot(feishuConfig);
    bots.push({ name: 'feishu', destroy: () => feishuBot.destroy() });
    startTasks.push(
      feishuBot.start().catch(err => {
        Logger.error(`飞书机器人启动失败: ${err.message}`);
      })
    );
  } else {
    Logger.info('飞书未配置，跳过');
  }

  if (hasCatsCompany) {
    const ccHttpBaseUrl = process.env.CATSCOMPANY_HTTP_BASE_URL || config.catscompany?.httpBaseUrl;
    const ccConfig: CatsCompanyConfig = {
      serverUrl: ccServerUrl!,
      apiKey: ccApiKey!,
      httpBaseUrl: ccHttpBaseUrl,
      sessionTTL: config.catscompany?.sessionTTL,
    };

    const ccBot = new CatsCompanyBot(ccConfig);
    bots.push({ name: 'catscompany', destroy: () => ccBot.destroy() });
    startTasks.push(
      ccBot.start().catch(err => {
        Logger.error(`CatsCompany 机器人启动失败: ${err.message}`);
      })
    );
  } else {
    Logger.info('CatsCompany 未配置，跳过');
  }

  await Promise.all(startTasks);
  Logger.success(`已启动 ${bots.length} 个平台机器人: ${bots.map(b => b.name).join(', ')}`);
}

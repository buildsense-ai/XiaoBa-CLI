import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { FeishuBot } from '../feishu';
import { FeishuConfig } from '../feishu/types';

function lockFilePath(appId: string): string {
  return path.join(os.tmpdir(), `xiaoba-feishu-${appId}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(appId: string): string {
  const lockFile = lockFilePath(appId);
  if (fs.existsSync(lockFile)) {
    const oldPid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
    if (oldPid && isProcessAlive(oldPid)) {
      Logger.error(`飞书应用 ${appId} 已在运行 (PID: ${oldPid})，请先停止旧进程再启动。`);
      process.exit(1);
    }
    Logger.warning(`发现残留 lock 文件 (PID: ${oldPid} 已不存在)，清理后继续启动。`);
  }
  fs.writeFileSync(lockFile, String(process.pid));
  return lockFile;
}

function releaseLock(lockFile: string): void {
  try { fs.unlinkSync(lockFile); } catch {}
}

/**
 * CLI 命令：xiaoba feishu
 * 启动飞书机器人长连接服务
 */
export async function feishuCommand(): Promise<void> {
  const config = ConfigManager.getConfig();

  // 从环境变量或配置文件读取飞书凭据
  const appId = process.env.FEISHU_APP_ID || config.feishu?.appId;
  const appSecret = process.env.FEISHU_APP_SECRET || config.feishu?.appSecret;
  const botOpenId = process.env.FEISHU_BOT_OPEN_ID || config.feishu?.botOpenId;
  const botAliases = (
    process.env.FEISHU_BOT_ALIASES
    || (config.feishu?.botAliases ? config.feishu.botAliases.join(',') : '小八,xiaoba')
  )
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (!appId || !appSecret) {
    Logger.error('飞书配置缺失。请设置环境变量 FEISHU_APP_ID 和 FEISHU_APP_SECRET，');
    Logger.error('或在 ~/.xiaoba/config.json 中配置 feishu.appId 和 feishu.appSecret。');
    process.exit(1);
  }

  const feishuConfig: FeishuConfig = {
    appId,
    appSecret,
    sessionTTL: config.feishu?.sessionTTL,
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

  const lockFile = acquireLock(appId);

  const bot = new FeishuBot(feishuConfig);

  // 优雅退出
  const shutdown = () => {
    bot.destroy();
    releaseLock(lockFile);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

import * as http from 'http';
import { Logger } from '../utils/logger';
import { BridgeMessage } from './bridge-server';

export interface BotPeer {
  name: string;
  url: string;
}

/**
 * Bot-to-Bot HTTP Bridge Client
 * 向其他 bot 发送任务请求
 */
export class BridgeClient {
  private peers: Map<string, string>;

  /**
   * @param peers 已知的 bot 列表，如 [{ name: 'ErGoz', url: 'http://localhost:9200' }]
   */
  constructor(peers: BotPeer[]) {
    this.peers = new Map(peers.map(p => [p.name, p.url]));
  }

  /** 获取所有已知 bot 名称 */
  getPeerNames(): string[] {
    return Array.from(this.peers.keys());
  }

  /** 向指定 bot 发送任务 */
  async send(botName: string, msg: Omit<BridgeMessage, 'from'>, fromName: string): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = this.peers.get(botName);
    if (!baseUrl) {
      return { ok: false, error: `未知的 bot: ${botName}，已知: ${this.getPeerNames().join(', ')}` };
    }

    const payload = JSON.stringify({ ...msg, from: fromName });
    const url = new URL('/bot-message', baseUrl);

    return new Promise((resolve) => {
      const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            Logger.info(`[Bridge] 已发送任务给 ${botName}: ${msg.message.slice(0, 50)}...`);
            resolve(result);
          } catch {
            resolve({ ok: false, error: `响应解析失败: ${body}` });
          }
        });
      });

      req.on('error', (err) => {
        Logger.error(`[Bridge] 发送给 ${botName} 失败: ${err.message}`);
        resolve({ ok: false, error: `连接失败: ${err.message}` });
      });

      req.setTimeout(5000, () => {
        req.destroy();
        resolve({ ok: false, error: '请求超时(5s)' });
      });

      req.write(payload);
      req.end();
    });
  }
}

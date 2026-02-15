import * as http from 'http';
import { Logger } from '../utils/logger';

export interface BridgeMessage {
  /** 发送方 bot 名称 */
  from: string;
  /** 目标群聊 chat_id，bot 处理完后往这个群发结果 */
  chat_id: string;
  /** 任务内容 */
  message: string;
}

export type BridgeMessageHandler = (msg: BridgeMessage) => Promise<void>;

/**
 * Bot-to-Bot HTTP Bridge Server
 * 接收其他 bot 发来的任务请求
 */
export class BridgeServer {
  private server: http.Server | null = null;
  private handler: BridgeMessageHandler | null = null;

  constructor(private port: number) {}

  /** 注册消息处理回调 */
  onMessage(handler: BridgeMessageHandler): void {
    this.handler = handler;
  }

  /** 启动 HTTP 服务 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/bot-message') {
          await this.handleRequest(req, res);
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.on('error', (err) => {
        Logger.error(`[Bridge] 服务启动失败: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.port, () => {
        Logger.info(`[Bridge] 已启动，监听端口 ${this.port}`);
        resolve();
      });
    });
  }

  /** 停止服务 */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      Logger.info('[Bridge] 已停止');
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const msg: BridgeMessage = JSON.parse(body);

        if (!msg.from || !msg.chat_id || !msg.message) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: '缺少必填字段: from, chat_id, message' }));
          return;
        }

        Logger.info(`[Bridge] 收到来自 ${msg.from} 的任务: ${msg.message.slice(0, 80)}...`);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: '任务已接收' }));

        // 异步处理，不阻塞响应
        if (this.handler) {
          this.handler(msg).catch((err) => {
            Logger.error(`[Bridge] 处理任务失败: ${err.message}`);
          });
        }
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: '无效的 JSON' }));
      }
    });
  }
}

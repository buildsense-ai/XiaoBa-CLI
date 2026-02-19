import * as http from 'http';
import { Logger } from '../utils/logger';

export interface BridgeMessage {
  /** 发送方 bot 名称 */
  from: string;
  /** 目标群聊 chat_id，bot 处理完后往这个群发结果 */
  chat_id: string;
  /** 任务内容 */
  message: string;
  /** 任务 ID（用于结果回传） */
  task_id?: string;
  /** 回调地址（Bot A 的 /bot-result 端点） */
  callback_url?: string;
  /** 会话 ID，多轮 bridge 交互共享同一个 session */
  conversation_id?: string;
}

/** 群聊广播消息 */
export interface GroupMessage {
  from: string;
  chat_id: string;
  content: string;
}

export type GroupMessageHandler = (msg: GroupMessage) => Promise<void>;

export interface BridgeResult {
  task_id: string;
  from: string;
  result: string;
}

export type BridgeMessageHandler = (msg: BridgeMessage) => Promise<void>;

export interface AsyncTaskMeta {
  sessionKey: string;
  chatId: string;
  botName: string;
}

export type BridgeResultHandler = (result: BridgeResult, meta: AsyncTaskMeta) => Promise<void>;

/**
 * Bot-to-Bot HTTP Bridge Server
 * 接收其他 bot 发来的任务请求
 */
export class BridgeServer {
  private server: http.Server | null = null;
  private handler: BridgeMessageHandler | null = null;
  private resultHandler: BridgeResultHandler | null = null;
  private groupMessageHandler: GroupMessageHandler | null = null;
  /** 同步等待模式：pending Promise */
  private pendingTasks = new Map<string, { resolve: (result: string) => void; timer: ReturnType<typeof setTimeout> }>();
  /** 异步模式：task 元数据，结果到达时触发 resultHandler */
  private asyncTasks = new Map<string, AsyncTaskMeta>();

  constructor(private port: number) {}

  /** 注册消息处理回调 */
  onMessage(handler: BridgeMessageHandler): void {
    this.handler = handler;
  }

  /** 注册群聊广播消息处理回调 */
  onGroupMessage(handler: GroupMessageHandler): void {
    this.groupMessageHandler = handler;
  }

  /** 注册异步结果处理回调 */
  onResult(handler: BridgeResultHandler): void {
    this.resultHandler = handler;
  }

  /** 注册异步任务，结果到达时触发 resultHandler */
  registerAsyncTask(taskId: string, meta: AsyncTaskMeta): void {
    this.asyncTasks.set(taskId, meta);
  }

  /** 启动 HTTP 服务 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/bot-message') {
          await this.handleRequest(req, res);
        } else if (req.method === 'POST' && req.url === '/bot-result') {
          await this.handleResultRequest(req, res);
        } else if (req.method === 'POST' && req.url === '/group-message') {
          await this.handleGroupMessage(req, res);
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

  private async handleResultRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const result: BridgeResult = JSON.parse(body);

        if (!result.task_id || !result.result) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: '缺少必填字段: task_id, result' }));
          return;
        }

        Logger.info(`[Bridge] 收到任务结果: task_id=${result.task_id}, from=${result.from}`);
        this.resolvePendingTask(result.task_id, result);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: '无效的 JSON' }));
      }
    });
  }

  private async handleGroupMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const msg: GroupMessage = JSON.parse(body);
        if (!msg.from || !msg.chat_id || !msg.content) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: '缺少必填字段: from, chat_id, content' }));
          return;
        }
        Logger.info(`[Bridge] 收到群聊广播: from=${msg.from}, chat_id=${msg.chat_id}`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        if (this.groupMessageHandler) {
          this.groupMessageHandler(msg).catch((err) => {
            Logger.error(`[Bridge] 处理群聊广播失败: ${err.message}`);
          });
        }
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: '无效的 JSON' }));
      }
    });
  }

  /** 注册 pending task，等待结果回传 */
  waitForResult(taskId: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        Logger.warning(`[Bridge] 任务 ${taskId} 等待结果超时 (${timeoutMs}ms)`);
        resolve(null);
      }, timeoutMs);

      this.pendingTasks.set(taskId, { resolve, timer });
    });
  }

  private resolvePendingTask(taskId: string, result: BridgeResult): void {
    // 优先检查同步等待
    const pending = this.pendingTasks.get(taskId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingTasks.delete(taskId);
      pending.resolve(result.result);
      return;
    }

    // 其次检查异步任务
    const asyncMeta = this.asyncTasks.get(taskId);
    if (asyncMeta) {
      this.asyncTasks.delete(taskId);
      if (this.resultHandler) {
        this.resultHandler(result, asyncMeta).catch((err) => {
          Logger.error(`[Bridge] 异步结果处理失败: ${err.message}`);
        });
      }
      return;
    }

    Logger.warning(`[Bridge] 收到未知 task_id 的结果: ${taskId}`);
  }
}

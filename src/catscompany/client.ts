// 内部CatsCompany WebSocket客户端
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface CatsClientConfig {
  serverUrl: string;
  apiKey: string;
  httpBaseUrl?: string;
}

export interface MessageContext {
  topic: string;
  senderId: string;
  text: string;
  content?: any;
  isGroup: boolean;
  from?: string;  // 兼容旧代码
  seq?: number;   // 兼容旧代码
}

export interface UploadResult {
  url: string;
  name: string;
  size: number;
}

export interface CatsOutgoingMessage {
  topic_id?: string;
  topic?: string;
  type?: string;
  msg_type?: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
  content_blocks?: unknown[];
  mode?: string;
  role?: string;
  reply_to?: number;
}

interface PendingAck {
  resolve: (seq: number) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export type CatsSendErrorKind = 'transport' | 'ack' | 'timeout';

export class CatsSendError extends Error {
  constructor(
    public readonly kind: CatsSendErrorKind,
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = 'CatsSendError';
  }
}

function describeReadyState(ws: WebSocket | null): string {
  switch (ws?.readyState) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
      return 'CLOSED';
    default:
      return 'NO_SOCKET';
  }
}

export class CatsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private closed = false;
  private pendingAcks = new Map<string, PendingAck>();
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private subscribedTopics = new Set<string>();

  public uid = '';
  public name = '';

  constructor(private config: CatsClientConfig) {
    super();
  }

  connect(): void {
    if (this.ws) return;

    console.log('[DEBUG] 连接到:', this.config.serverUrl);
    console.log('[DEBUG] API Key:', this.config.apiKey.slice(0, 20) + '...');
    this.ws = new WebSocket(this.config.serverUrl, {
      headers: { 'X-API-Key': this.config.apiKey }
    });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.send({ hi: { id: '1', ver: '0.1.0', ua: 'XiaoBa/1.0' } });
      this.startHeartbeat();
    });

    this.ws.on('message', (data: Buffer) => {
      this.resetPongTimer();
      const msg = JSON.parse(data.toString());
      this.handleMessage(msg);
    });

    this.ws.on('pong', () => {
      this.resetPongTimer();
    });

    this.ws.on('error', (err: Error) => this.emit('error', err));
    this.ws.on('close', () => {
      this.stopHeartbeat();
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private handleMessage(msg: any): void {
    if (msg.ctrl) {
      if (msg.ctrl.code === 200 && msg.ctrl.params?.build === 'catscompany') {
        console.log('[DEBUG] 握手响应:', JSON.stringify(msg.ctrl.params));
        this.uid = String(msg.ctrl.params?.uid || 'bot');
        this.name = String(msg.ctrl.params?.name || 'XiaoBa');
        this.emit('ready', { uid: this.uid, name: this.name });
        this.autoAcceptFriendRequests().catch(console.error);
        this.resubscribeTopics();
      } else if (msg.ctrl.id) {
        const pending = this.pendingAcks.get(msg.ctrl.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(msg.ctrl.id);
          if (msg.ctrl.code >= 200 && msg.ctrl.code < 300) {
            pending.resolve(Number(msg.ctrl.params?.seq || 0));
          } else {
            pending.reject(new CatsSendError(
              'ack',
              `CatsCompany ack ${msg.ctrl.code}: ${msg.ctrl.text || 'request failed'}`,
              msg.ctrl.code
            ));
          }
        }
      }
    } else if (msg.data) {
      console.log('[DEBUG] 收到消息数据:', JSON.stringify(msg.data));
      this.subscribedTopics.add(msg.data.topic);
      const ctx: MessageContext = {
        topic: msg.data.topic || '',
        senderId: msg.data.from || '',
        text: typeof msg.data.content === 'string' ? msg.data.content : '',
        content: msg.data.content,
        isGroup: msg.data.topic?.startsWith('grp_') ?? false,
      };
      this.emit('message', ctx);
    } else if (msg.pres) {
      console.log('[DEBUG] 收到presence:', JSON.stringify(msg.pres));
      if (msg.pres.what === 'friend_request') {
        const fromUserId = msg.pres.src;
        if (fromUserId) {
          this.acceptFriendRequest(fromUserId).catch(console.error);
        }
      }
    }
  }

  async sendMessage(topic: string, text: string): Promise<number> {
    return this.sendStructuredMessage({ topic_id: topic, type: 'text', content: text });
  }

  private buildPubMessage(msgId: string, payload: CatsOutgoingMessage): Record<string, unknown> {
    const topic = payload.topic_id || payload.topic;
    if (!topic) {
      throw new Error('CatsCompany topic is required');
    }

    const pub: Record<string, unknown> = {
      id: msgId,
      topic,
    };

    if (payload.content !== undefined) pub.content = payload.content;
    if (payload.content_blocks !== undefined) pub.content_blocks = payload.content_blocks;
    if (payload.metadata !== undefined) pub.metadata = payload.metadata;
    if (payload.type !== undefined) pub.type = payload.type;
    if (payload.msg_type !== undefined) pub.msg_type = payload.msg_type;
    if (payload.mode !== undefined) pub.mode = payload.mode;
    if (payload.role !== undefined) pub.role = payload.role;
    if (payload.reply_to !== undefined) pub.reply_to = payload.reply_to;

    return pub;
  }

  async sendStructuredMessage(payload: CatsOutgoingMessage): Promise<number> {
    const msgId = `${++this.msgId}`;
    const pub = this.buildPubMessage(msgId, payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        reject(new CatsSendError(
          'timeout',
          'WebSocket 已发送消息，但 10 秒内没有收到 CatsCompany 服务器确认'
        ));
      }, 10000);

      this.pendingAcks.set(msgId, { resolve, reject, timer });
      try {
        this.sendOrThrow({ pub });
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingAcks.delete(msgId);
        reject(err);
      }
    });
  }

  sendTyping(topic: string): void {
    this.send({ note: { topic, what: 'kp' } });
  }

  sendInfo(topic: string, what: string, payload?: any): void {
    const msg = { note: { topic, what, payload } };
    console.log('[WS SEND]', JSON.stringify(msg));
    this.send(msg);
  }

  private async acceptFriendRequest(userId: number): Promise<void> {
    const httpBaseUrl = this.config.httpBaseUrl || 'https://app.catsco.cc';
    const res = await fetch(`${httpBaseUrl}/api/friends/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `ApiKey ${this.config.apiKey}`
      },
      body: JSON.stringify({ user_id: userId })
    });
    if (res.ok) {
      console.log(`[DEBUG] 已接受用户 ${userId} 的好友请求`);
    }
  }

  private async autoAcceptFriendRequests(): Promise<void> {
    // Note: /api/friends only returns accepted friends, not pending requests
    // Pending requests need to be accepted via WebSocket notifications or manual API calls
    console.log('[DEBUG] 等待好友请求通知...');
  }

  async uploadFile(filePath: string, type: 'image' | 'file' = 'file'): Promise<UploadResult> {
    const httpBaseUrl = (this.config.httpBaseUrl || 'https://app.catsco.cc').replace(/\/$/, '');
    const url = `${httpBaseUrl}/api/upload?type=${type}`;

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);

    try {
      console.log(`[DEBUG] 开始上传文件到: ${url}, 大小: ${buffer.length} bytes`);

      const formData = new FormData();
      formData.append('file', new Blob([buffer]), filename);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `ApiKey ${this.config.apiKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(60000),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.log('[DEBUG] Upload failed:', res.status, errorText);
        throw new Error(`Upload failed: ${res.status} - ${errorText}`);
      }

      const result = await res.json() as UploadResult;
      console.log('[DEBUG] 上传成功:', result.url);
      return result;
    } catch (err: any) {
      console.log('[DEBUG] Upload error:', err.message, err.cause);
      throw new Error(`Upload failed: ${err.message}`);
    }
  }

  async sendImage(topic: string, upload: UploadResult): Promise<number> {
    const content = {
      type: 'image',
      payload: {
        url: upload.url,
        name: upload.name,
        size: upload.size,
      },
    };
    return this.sendStructuredMessage({ topic_id: topic, type: 'image', content });
  }

  async sendFile(topic: string, upload: UploadResult): Promise<number> {
    const content = {
      type: 'file',
      payload: {
        url: upload.url,
        name: upload.name,
        size: upload.size,
      },
    };
    return this.sendStructuredMessage({ topic_id: topic, type: 'file', content });
  }

  private send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private sendOrThrow(data: any): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new CatsSendError(
        'transport',
        `小八到 CatsCompany 的 WebSocket 未连接，当前状态: ${describeReadyState(this.ws)}`
      );
    }
    try {
      this.ws.send(JSON.stringify(data));
    } catch (err: any) {
      throw new CatsSendError(
        'transport',
        `WebSocket 写入失败: ${err?.message || 'unknown error'}`
      );
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 20000);
    this.resetPongTimer();
  }

  private resetPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      console.log('[DEBUG] 心跳超时，断开连接');
      this.ws?.terminate();
    }, 90000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[DEBUG] ${delay}ms后重连 (尝试 ${this.reconnectAttempts + 1})`);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  private resubscribeTopics(): void {
    if (this.subscribedTopics.size > 0) {
      console.log(`[DEBUG] 重新订阅 ${this.subscribedTopics.size} 个会话`);
      this.subscribedTopics.forEach(topic => {
        this.send({ sub: { topic } });
      });
    }
  }

  disconnect(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }
}

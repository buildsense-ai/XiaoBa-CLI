// CatsCo 服务器 WebSocket 客户端
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { Logger } from '../utils/logger';
import { uploadCatsLocalFile, type UploadResult } from './upload';

export type { UploadResult } from './upload';

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
  content_blocks?: unknown[];
  type?: string;
  msg_type?: string;
  metadata?: Record<string, unknown>;
  mode?: string;
  isGroup: boolean;
  from?: string;  // 原始 Cats 发送方字段，供兼容和排查使用
  seq?: number;   // Cats 服务端消息序号，用于排序和补充消息合并
}

export interface CatsOutgoingMessage {
  topic_id?: string;
  topic?: string;
  client_msg_id?: string;
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
  clientMsgID?: string;
}

export type CatsSendErrorKind = 'transport' | 'ack' | 'timeout';

// Cats 服务端握手协议版本，不是 CatsCo 客户端发布版本。
const CATSCOMPANY_PROTOCOL_VERSION = '0.1.0';
const CATSCOMPANY_CLIENT_UA = 'CatsCo/1.0';

function maskSecret(value: string): string {
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export class CatsSendError extends Error {
  public readonly clientMsgID?: string;
  public readonly retryableWithHttp: boolean;

  constructor(
    public readonly kind: CatsSendErrorKind,
    message: string,
    public readonly code?: number,
    options: { clientMsgID?: string; retryableWithHttp?: boolean } = {}
  ) {
    super(message);
    this.name = 'CatsSendError';
    this.clientMsgID = options.clientMsgID;
    this.retryableWithHttp = options.retryableWithHttp ?? false;
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
  private supportsClientMessageDedupe = false;

  public uid = '';
  public name = '';

  constructor(private config: CatsClientConfig) {
    super();
  }

  connect(): void {
    if (this.ws) return;

    Logger.info(`[CatsCompany] 正在连接: ${this.config.serverUrl}, apiKey=${maskSecret(this.config.apiKey)}`);
    this.supportsClientMessageDedupe = false;
    this.ws = new WebSocket(this.config.serverUrl, {
      headers: { 'X-API-Key': this.config.apiKey }
    });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.send({ hi: { id: '1', ver: CATSCOMPANY_PROTOCOL_VERSION, ua: CATSCOMPANY_CLIENT_UA } });
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
    this.ws.on('close', (code: number, reason: Buffer) => {
      Logger.warning(`[CatsCompany] WebSocket 已关闭: code=${code}, reason=${reason.toString() || '-'}`);
      this.stopHeartbeat();
      this.ws = null;
      this.rejectPendingAcks(new CatsSendError(
        'timeout',
        'WebSocket 在收到 CatsCompany 服务器确认前关闭',
        undefined,
        { retryableWithHttp: this.supportsClientMessageDedupe }
      ));
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private handleMessage(msg: any): void {
    if (msg.ctrl) {
      if (msg.ctrl.code === 200 && msg.ctrl.params?.build === 'catscompany') {
        this.uid = String(msg.ctrl.params?.uid || 'bot');
        this.name = String(msg.ctrl.params?.name || 'CatsCo');
        Logger.info(
          `[CatsCompany] 握手成功: uid=${this.uid}, name=${this.name}, ` +
          `protocol=${CATSCOMPANY_PROTOCOL_VERSION}, serverProtocol=${msg.ctrl.params?.ver || 'unknown'}`
        );
        this.supportsClientMessageDedupe = Array.isArray(msg.ctrl.params?.features)
          && msg.ctrl.params.features.includes('client_msg_id');
        if (this.supportsClientMessageDedupe) {
          Logger.info('[CatsCompany] 服务端支持 client_msg_id 幂等发送');
        }
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
      Logger.info(
        `[CatsCompany] 收到消息: topic=${msg.data.topic || '-'}, ` +
        `from=${msg.data.from || '-'}, seq=${msg.data.seq || '-'}, type=${msg.data.type || msg.data.msg_type || '-'}`
      );
      this.subscribedTopics.add(msg.data.topic);
      const ctx: MessageContext = {
        topic: msg.data.topic || '',
        senderId: msg.data.from || '',
        text: typeof msg.data.content === 'string' ? msg.data.content : '',
        content: msg.data.content,
        content_blocks: Array.isArray(msg.data.content_blocks) ? msg.data.content_blocks : undefined,
        type: typeof msg.data.type === 'string' ? msg.data.type : undefined,
        msg_type: typeof msg.data.msg_type === 'string' ? msg.data.msg_type : undefined,
        metadata: msg.data.metadata && typeof msg.data.metadata === 'object' ? msg.data.metadata : undefined,
        mode: typeof msg.data.mode === 'string' ? msg.data.mode : undefined,
        isGroup: msg.data.topic?.startsWith('grp_') ?? false,
        seq: Number(msg.data.seq || 0),
      };
      this.emit('message', ctx);
    } else if (msg.pres) {
      if (msg.pres.what === 'friend_request') {
        Logger.info(`[CatsCompany] 收到好友请求通知: src=${msg.pres.src || '-'}`);
        const fromUserId = msg.pres.src;
        if (fromUserId) {
          this.acceptFriendRequest(fromUserId).catch(console.error);
        }
      } else if (msg.pres.what && msg.pres.what !== 'on' && msg.pres.what !== 'off') {
        Logger.info(`[CatsCompany] 收到 presence: what=${msg.pres.what}, src=${msg.pres.src || '-'}`);
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

    if (payload.client_msg_id !== undefined) pub.client_msg_id = payload.client_msg_id;
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
    const clientMsgID = payload.client_msg_id || buildClientMessageID();
    const pub = this.buildPubMessage(msgId, {
      ...payload,
      client_msg_id: clientMsgID,
      metadata: {
        ...(payload.metadata || {}),
        client_msg_id: clientMsgID,
      },
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        this.forceReconnect('ack timeout');
        reject(new CatsSendError(
          'timeout',
          'WebSocket 已发送消息，但 10 秒内没有收到 CatsCompany 服务器确认',
          undefined,
          { clientMsgID, retryableWithHttp: this.supportsClientMessageDedupe }
        ));
      }, 10000);

      this.pendingAcks.set(msgId, { resolve, reject, timer, clientMsgID });
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
    Logger.info(`[CatsCompany] 发送前端通知: topic=${topic}, what=${what}`);
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
      Logger.info(`[CatsCompany] 已接受用户 ${userId} 的好友请求`);
    }
  }

  private async autoAcceptFriendRequests(): Promise<void> {
    // Note: /api/friends only returns accepted friends, not pending requests
    // Pending requests need to be accepted via WebSocket notifications or manual API calls
    Logger.info('[CatsCompany] 等待好友请求通知...');
  }

  async uploadFile(filePath: string, type: 'image' | 'file' = 'file'): Promise<UploadResult> {
    return uploadCatsLocalFile({
      httpBaseUrl: this.config.httpBaseUrl || 'https://app.catsco.cc',
      filePath,
      type,
      authHeader: `ApiKey ${this.config.apiKey}`,
    });
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
        `CatsCo 桌面端到 CatsCo 服务器的 WebSocket 未连接，当前状态: ${describeReadyState(this.ws)}`
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

  private rejectPendingAcks(err: CatsSendError): void {
    for (const [msgId, pending] of this.pendingAcks.entries()) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(msgId);
      pending.reject(new CatsSendError(
        err.kind,
        err.message,
        err.code,
        {
          clientMsgID: pending.clientMsgID,
          retryableWithHttp: err.retryableWithHttp,
        }
      ));
    }
  }

  private forceReconnect(reason: string): void {
    Logger.warning(`[CatsCompany] ${reason}，主动重建 WebSocket 连接`);
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
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
      Logger.warning('[CatsCompany] 心跳超时，断开连接');
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
    Logger.info(`[CatsCompany] ${delay}ms 后重连 (尝试 ${this.reconnectAttempts + 1})`);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  private resubscribeTopics(): void {
    if (this.subscribedTopics.size > 0) {
      Logger.info(`[CatsCompany] 重新订阅 ${this.subscribedTopics.size} 个会话`);
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

function buildClientMessageID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `catsco-${crypto.randomUUID()}`;
  }
  return `catsco-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

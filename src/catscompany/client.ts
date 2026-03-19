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

export class CatsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private closed = false;
  private pendingAcks = new Map<string, any>();

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
      this.send({ hi: { id: '1', ver: '0.1.0', ua: 'XiaoBa/1.0' } });
    });

    this.ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      this.handleMessage(msg);
    });

    this.ws.on('error', (err: Error) => this.emit('error', err));
    this.ws.on('close', () => {
      this.ws = null;
      if (!this.closed) setTimeout(() => this.connect(), 3000);
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
      } else if (msg.ctrl.id && msg.ctrl.code === 200) {
        const pending = this.pendingAcks.get(msg.ctrl.id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(msg.ctrl.params?.seq || 0);
          this.pendingAcks.delete(msg.ctrl.id);
        }
      }
    } else if (msg.data) {
      console.log('[DEBUG] 收到消息数据:', JSON.stringify(msg.data));
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
    const msgId = `${++this.msgId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        reject(new Error('Ack timeout'));
      }, 10000);

      this.pendingAcks.set(msgId, { resolve, reject, timer });
      this.send({ pub: { id: msgId, topic, content: text } });
    });
  }

  sendTyping(topic: string): void {
    this.send({ note: { topic, what: 'kp' } });
  }

  private async acceptFriendRequest(userId: number): Promise<void> {
    const httpBaseUrl = this.config.httpBaseUrl || 'https://api.catsco.cc';
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
    const httpBaseUrl = this.config.httpBaseUrl || 'https://api.catsco.cc';
    const url = `${httpBaseUrl}/api/upload?type=${type}`;

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);

    const boundary = `----CatsBotBoundary${crypto.randomBytes(16).toString('hex')}`;
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `ApiKey ${this.config.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.log('[DEBUG] Upload failed:', res.status, errorText);
      throw new Error(`Upload failed: ${res.status} - ${errorText}`);
    }

    return await res.json() as UploadResult;
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
    return this.sendRichContent(topic, content);
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
    return this.sendRichContent(topic, content);
  }

  private async sendRichContent(topic: string, content: any): Promise<number> {
    const msgId = `${++this.msgId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        reject(new Error('Ack timeout'));
      }, 10000);

      this.pendingAcks.set(msgId, { resolve, reject, timer });
      this.send({ pub: { id: msgId, topic, content } });
    });
  }

  private send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect(): void {
    this.closed = true;
    this.ws?.close();
  }
}

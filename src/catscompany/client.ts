// 内部CatsCompany WebSocket客户端
import WebSocket from 'ws';
import { EventEmitter } from 'events';

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

    const url = `${this.config.serverUrl}?api_key=${this.config.apiKey}`;
    this.ws = new WebSocket(url);

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
    // Tinode握手响应
    if (msg.ctrl) {
      if (msg.ctrl.code === 200 && msg.ctrl.params?.build === 'catscompany') {
        // 握手成功，发送登录
        this.send({ login: { id: '2', scheme: 'token', secret: this.config.apiKey } });
      } else if (msg.ctrl.code === 200 && msg.ctrl.params?.user) {
        // 登录成功
        this.uid = msg.ctrl.params.user;
        this.name = msg.ctrl.params.user;
        this.emit('ready', { uid: this.uid, name: this.name });
      }
    } else if (msg.data) {
      // 消息数据
      const ctx: MessageContext = {
        topic: msg.data.topic || '',
        senderId: msg.data.from || '',
        text: msg.data.content || '',
        content: msg.data.content,
        isGroup: false,
      };
      this.emit('message', ctx);
    } else if (msg.pres) {
      // 在线状态，忽略
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

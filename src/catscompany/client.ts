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

    // 在URL中添加apiKey作为查询参数
    const url = `${this.config.serverUrl}?apiKey=${this.config.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      // 连接后不需要再发送auth消息
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
    if (msg.type === 'ctrl') {
      if (msg.event === 'ready') {
        this.uid = msg.uid;
        this.name = msg.name;
        this.emit('ready', { uid: msg.uid, name: msg.name });
      }
    } else if (msg.type === 'data') {
      const ctx: MessageContext = {
        topic: msg.topic,
        senderId: msg.sender_id,
        text: msg.text || '',
        content: msg.content,
        isGroup: msg.is_group || false,
      };
      this.emit('message', ctx);
    } else if (msg.type === 'ack') {
      const pending = this.pendingAcks.get(msg.msg_id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(msg.seq);
        this.pendingAcks.delete(msg.msg_id);
      }
    }
  }

  async sendMessage(topic: string, text: string): Promise<number> {
    const msgId = `msg_${++this.msgId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        reject(new Error('Ack timeout'));
      }, 10000);

      this.pendingAcks.set(msgId, { resolve, reject, timer });
      this.send({ type: 'send', msg_id: msgId, topic, text });
    });
  }

  sendTyping(topic: string): void {
    this.send({ type: 'typing', topic });
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

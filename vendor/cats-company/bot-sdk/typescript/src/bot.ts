// CatsBot — main SDK class for connecting to Cats Company via WebSocket.

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  CatsBotConfig,
  BotEventMap,
  ClientMessage,
  ServerMessage,
  MsgServerCtrl,
  MsgServerData,
  MessageContent,
  RichContentImage,
  RichContentFile,
  RichContentLinkPreview,
  RichContentCard,
  UploadResult,
} from './types';
import { ConnectionError, HandshakeError, ProtocolError, RateLimitError } from './errors';
import { MessageContext } from './context';
import { FileUploader } from './uploader';

interface PendingAck {
  resolve: (seq: number) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConversationCursor {
  id: string;
  latest_seq?: number;
}

export class CatsBot {
  public uid = '';
  public name = '';

  private readonly config: Required<CatsBotConfig>;
  private readonly emitter = new EventEmitter();
  private readonly uploader: FileUploader;
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly topicLastSeq = new Map<string, number>();

  private ws: WebSocket | null = null;
  private msgId = 0;
  private reconnectAttempt = 0;
  private closed = false;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConversationBaseline = false;
  private recoveryPromise: Promise<void> | null = null;

  private closeSocket(reason = 'bot disconnect'): void {
    if (!this.ws) return;

    const ws = this.ws;
    this.ws = null;

    if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
      return;
    }

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
      ws.close(1000, reason);
    }
  }

  constructor(config: CatsBotConfig) {
    const httpBase = config.httpBaseUrl ?? deriveHttpBase(config.serverUrl);
    this.config = {
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      httpBaseUrl: httpBase,
      reconnectDelay: config.reconnectDelay ?? 3000,
      connectTimeout: config.connectTimeout ?? 15000,
      handshakeTimeout: config.handshakeTimeout ?? 10000,
      pingTimeout: config.pingTimeout ?? 70000,
    };
    this.uploader = new FileUploader(this.config.httpBaseUrl, this.config.apiKey);
  }

  // --- Typed event emitter ---

  on<K extends keyof BotEventMap>(event: K, listener: BotEventMap[K]): this {
    this.emitter.on(event, listener as (...args: any[]) => void);
    return this;
  }

  off<K extends keyof BotEventMap>(event: K, listener: BotEventMap[K]): this {
    this.emitter.off(event, listener as (...args: any[]) => void);
    return this;
  }

  once<K extends keyof BotEventMap>(event: K, listener: BotEventMap[K]): this {
    this.emitter.once(event, listener as (...args: any[]) => void);
    return this;
  }

  private emit<K extends keyof BotEventMap>(event: K, ...args: Parameters<BotEventMap[K]>): void {
    if (event === 'error' && this.emitter.listenerCount('error') === 0) {
      return;
    }
    this.emitter.emit(event, ...args);
  }

  // --- Connection lifecycle ---

  /**
   * Open the WebSocket connection and perform the handshake.
   * Resolves when the handshake ctrl 200 is received.
   */
  connect(): Promise<void> {
    this.closed = false;
    return this.doConnect();
  }

  /**
   * Connect and block until the process is interrupted or disconnect() is called.
   */
  async run(): Promise<void> {
    await this.connect();
    // Keep the process alive
    return new Promise<void>((resolve) => {
      this.once('disconnect', () => {
        if (this.closed) resolve();
      });
    });
  }

  /**
   * Gracefully close the connection. No automatic reconnect.
   */
  disconnect(): void {
    this.closed = true;
    this.clearPingTimer();
    this.rejectAllPending(new ConnectionError('Disconnected'));
    this.closeSocket('bot disconnect');
  }

  // --- Sending messages ---

  /**
   * Publish a message to a topic. Returns the server-assigned seq number.
   */
  sendMessage(topic: string, content: MessageContent, replyTo?: number): Promise<number> {
    const id = this.nextId();
    const pub: ClientMessage = {
      pub: { id, topic, content, reply_to: replyTo },
    };
    return this.sendWithAck(id, pub);
  }

  /** Send an image message (from an UploadResult). */
  sendImage(
    topic: string,
    upload: UploadResult,
    opts?: { width?: number; height?: number },
  ): Promise<number> {
    const content: RichContentImage = {
      type: 'image',
      payload: {
        url: upload.url,
        name: upload.name,
        size: upload.size,
        ...opts,
      },
    };
    return this.sendMessage(topic, content);
  }

  /** Send a file message (from an UploadResult). */
  sendFile(topic: string, upload: UploadResult, mimeType?: string): Promise<number> {
    const content: RichContentFile = {
      type: 'file',
      payload: {
        url: upload.url,
        name: upload.name,
        size: upload.size,
        mime_type: mimeType,
      },
    };
    return this.sendMessage(topic, content);
  }

  /** Send a link preview card. */
  sendLinkPreview(
    topic: string,
    payload: RichContentLinkPreview['payload'],
  ): Promise<number> {
    const content: RichContentLinkPreview = { type: 'link_preview', payload };
    return this.sendMessage(topic, content);
  }

  /** Send a rich card. */
  sendCard(topic: string, payload: RichContentCard['payload']): Promise<number> {
    const content: RichContentCard = { type: 'card', payload };
    return this.sendMessage(topic, content);
  }

  // --- Notifications ---

  /** Send a typing indicator. */
  sendTyping(topic: string): void {
    this.sendRaw({ note: { topic, what: 'kp' } });
  }

  /** Send a read receipt for messages up to seq. */
  sendReadReceipt(topic: string, seq: number): void {
    this.sendRaw({ note: { topic, what: 'read', seq } });
  }

  // --- History ---

  /** Fetch message history for a topic since a given seq. */
  getHistory(topic: string, sinceSeq = 0): Promise<MsgServerData[]> {
    const id = this.nextId();
    const messages: MsgServerData[] = [];

    return new Promise<MsgServerData[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new ProtocolError(0, 'History request timed out'));
      }, 15000);

      const onData = (ctx: MessageContext) => {
        if (ctx.topic === topic) {
          messages.push({
            topic: ctx.topic,
            from: ctx.from,
            seq: ctx.seq,
            content: ctx.content,
            reply_to: ctx.replyTo,
          });
        }
      };

      const onCtrl = (ctrl: MsgServerCtrl) => {
        if (ctrl.id === id && ctrl.code === 200) {
          cleanup();
          resolve(messages);
        } else if (ctrl.id === id) {
          cleanup();
          reject(new ProtocolError(ctrl.code, ctrl.text));
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('message', onData);
        this.off('ctrl', onCtrl);
      };

      // Temporarily listen for data messages that arrive as history
      this.on('message', onData);
      this.on('ctrl', onCtrl);

      this.sendRaw({ get: { id, topic, what: 'history', seq: sinceSeq } });
    });
  }

  // --- File upload ---

  /** Upload a file from disk path. */
  uploadFile(filePath: string, type: 'image' | 'file' = 'file'): Promise<UploadResult> {
    return this.uploader.upload(filePath, type);
  }

  /** Upload a buffer. */
  uploadBuffer(
    buffer: Buffer,
    filename: string,
    type: 'image' | 'file' = 'file',
  ): Promise<UploadResult> {
    return this.uploader.uploadBuffer(buffer, filename, type);
  }

  // --- Internal ---

  private nextId(): string {
    return String(++this.msgId);
  }

  private sendRaw(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  private sendWithAck(id: string, msg: ClientMessage): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new ProtocolError(0, 'Ack timeout'));
      }, 30000);

      this.pendingAcks.set(id, { resolve, reject, timer });
      try {
        this.sendRaw(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pendingAcks.delete(id);
        reject(err);
      }
    });
  }

  private resolveAck(ctrl: MsgServerCtrl): boolean {
    if (!ctrl.id) return false;
    const pending = this.pendingAcks.get(ctrl.id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingAcks.delete(ctrl.id);

    if (ctrl.code === 200) {
      const seq = (ctrl.params as any)?.seq ?? 0;
      if (ctrl.topic && typeof seq === 'number' && seq > 0) {
        this.noteTopicSeq(ctrl.topic, seq);
      }
      pending.resolve(typeof seq === 'number' ? seq : 0);
    } else if (ctrl.code === 429) {
      pending.reject(new RateLimitError(ctrl.text));
    } else {
      pending.reject(new ProtocolError(ctrl.code, ctrl.text));
    }
    return true;
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingAcks.clear();
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let handshakeDone = false;
      let socketOpen = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

      const clearConnectTimers = (): void => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
      };

      const failConnect = (err: Error): void => {
        if (handshakeDone) return;
        handshakeDone = true;
        clearConnectTimers();
        reject(err);
      };

      try {
        this.ws = new WebSocket(this.config.serverUrl, {
          headers: { 'X-API-Key': this.config.apiKey },
        });
      } catch (err: any) {
        reject(new ConnectionError(`Failed to create WebSocket: ${err.message}`));
        return;
      }

      connectTimer = setTimeout(() => {
        failConnect(new ConnectionError('WebSocket connection timed out'));
        this.closeSocket('connect timeout');
      }, this.config.connectTimeout);

      this.ws.on('open', () => {
        socketOpen = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        handshakeTimer = setTimeout(() => {
          failConnect(new HandshakeError('Handshake timed out'));
          this.closeSocket('handshake timeout');
        }, this.config.handshakeTimeout);

        // Send handshake
        const id = this.nextId();
        try {
          this.sendRaw({ hi: { id, ver: '0.1.0' } });
        } catch (err: any) {
          failConnect(new ConnectionError(err.message));
        }
      });

      this.ws.on('message', (raw: WebSocket.Data) => {
        this.resetPingTimer();

        let msg: ServerMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Handshake response
        if (!handshakeDone && msg.ctrl) {
          if (
            msg.ctrl.code === 200 &&
            (msg.ctrl.params as any)?.build === 'catscompany'
          ) {
            handshakeDone = true;
            clearConnectTimers();
            this.uid = String((msg.ctrl.params as any)?.uid ?? '');
            this.name = String((msg.ctrl.params as any)?.name ?? '');
            this.reconnectAttempt = 0;
            this.emit('ready', this.uid, this.name);
            resolve();
            void this.recoverMissedMessages();
            return;
          } else {
            failConnect(new HandshakeError(`Handshake failed: code ${msg.ctrl.code}`));
            return;
          }
        }

        this.dispatch(msg);
      });

      this.ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        failConnect(new HandshakeError(`WebSocket upgrade rejected with HTTP ${status}`, status));
        res.resume();
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        clearConnectTimers();
        this.clearPingTimer();
        this.rejectAllPending(new ConnectionError('Connection closed'));
        this.emit('disconnect', code, reason.toString());

        if (!handshakeDone) {
          const message = socketOpen
            ? 'Connection closed during handshake'
            : 'WebSocket was closed before the connection was established';
          failConnect(new ConnectionError(message));
        }

        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err: Error) => {
        if (this.closed && !handshakeDone) {
          return;
        }
        if (this.emitter.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        if (!handshakeDone) {
          failConnect(new ConnectionError(err.message));
        }
      });

      this.ws.on('ping', () => {
        this.resetPingTimer();
      });
    });
  }

  private dispatch(msg: ServerMessage): void {
    if (msg.ctrl) {
      // Try to resolve a pending ack first
      if (!this.resolveAck(msg.ctrl)) {
        this.emit('ctrl', msg.ctrl);
      }
    }

    if (msg.data) {
      this.noteTopicSeq(msg.data.topic, msg.data.seq);

      // Self-echo filter: skip messages from ourselves
      if (msg.data.from === this.uid) return;

      const ctx = new MessageContext(this, msg.data);
      this.emit('message', ctx);
    }

    if (msg.pres) {
      this.emit('presence', msg.pres);
    }

    if (msg.info) {
      if (msg.info.what === 'kp') {
        this.emit('typing', msg.info);
      } else if (msg.info.what === 'read') {
        this.emit('read', msg.info);
      }
    }
  }

  // --- Ping / heartbeat monitoring ---

  private resetPingTimer(): void {
    this.clearPingTimer();
    this.pingTimer = setTimeout(() => {
      // No ping received within timeout — force reconnect
      if (this.ws) {
        this.ws.close(4000, 'ping timeout');
      }
    }, this.config.pingTimeout);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private noteTopicSeq(topic: string | undefined, seq: number | undefined): void {
    if (!topic || typeof seq !== 'number' || seq <= 0) {
      return;
    }

    const prev = this.topicLastSeq.get(topic) ?? 0;
    if (seq > prev) {
      this.topicLastSeq.set(topic, seq);
    }
  }

  private async recoverMissedMessages(): Promise<void> {
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }

    this.recoveryPromise = (async () => {
      const conversations = await this.fetchConversationCursors();
      if (!this.hasConversationBaseline) {
        for (const convo of conversations) {
          this.noteTopicSeq(convo.id, convo.latest_seq ?? 0);
        }
        this.hasConversationBaseline = true;
        return;
      }

      for (const convo of conversations) {
        const latestSeq = convo.latest_seq ?? 0;
        const lastSeen = this.topicLastSeq.get(convo.id);
        if (latestSeq <= 0) {
          continue;
        }

        if (lastSeen == null) {
          await this.getHistory(convo.id, 0);
          this.noteTopicSeq(convo.id, latestSeq);
          continue;
        }

        if (latestSeq > lastSeen) {
          await this.getHistory(convo.id, lastSeen);
          this.noteTopicSeq(convo.id, latestSeq);
        }
      }
    })()
      .catch((err: any) => {
        this.emit('error', new ConnectionError(`Conversation recovery failed: ${err.message}`));
      })
      .finally(() => {
        this.recoveryPromise = null;
      });

    return this.recoveryPromise;
  }

  private async fetchConversationCursors(): Promise<ConversationCursor[]> {
    const url = `${this.config.httpBaseUrl}/api/conversations`;
    let res: Response;

    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `ApiKey ${this.config.apiKey}`,
        },
      });
    } catch (err: any) {
      throw new ConnectionError(`Conversation sync request failed: ${err.message}`);
    }

    if (!res.ok) {
      if (res.status === 401) {
        return [];
      }
      const text = await res.text().catch(() => '');
      throw new ConnectionError(`Conversation sync failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { conversations?: ConversationCursor[] };
    return Array.isArray(data.conversations) ? data.conversations : [];
  }

  // --- Auto-reconnect ---

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    this.emit('reconnecting', this.reconnectAttempt);

    setTimeout(async () => {
      if (this.closed) return;
      try {
        await this.doConnect();
      } catch {
        // doConnect failure will trigger ws close → scheduleReconnect again
      }
    }, this.config.reconnectDelay);
  }
}

// --- Helpers ---

/** Derive an HTTP base URL from a WebSocket URL. */
function deriveHttpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  return u.origin;
}

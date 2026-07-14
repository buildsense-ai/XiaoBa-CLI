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
  bodyId?: string;
  installationId?: string;
  deviceRegistration?: CatsDeviceRegistration;
  httpBaseUrl?: string;
  connectTimeoutMs?: number;
  readyTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export interface CatsDeviceRegistration {
  device_id: string;
  display_name?: string;
  body_id?: string;
  installation_id?: string;
  owner_user_id?: string;
  os?: 'windows' | 'macos' | 'linux' | 'unknown';
  status?: 'online' | 'offline';
  capabilities?: string[];
  model_status?: {
    source?: 'relay' | 'custom';
    model?: string;
    updated_at?: number;
  };
}

export interface CatsDeviceRpcError {
  code: string;
  message: string;
}

export interface CatsDeviceRpcMessage {
  id?: string;
  type: 'request' | 'result';
  request_id: string;
  grant_id?: string;
  session_key?: string;
  topic_id?: string;
  topic_type?: string;
  actor_user_id?: string;
  owner_user_id?: string;
  identity_source?: string;
  agent_id?: string;
  agent_body_id?: string;
  device_id?: string;
  device_display_name?: string;
  device_body_id?: string;
  device_installation_id?: string;
  operation?: string;
  tool_name?: string;
  payload?: Record<string, unknown>;
  result?: unknown;
  error?: CatsDeviceRpcError;
  created_at?: number;
  expires_at?: number;
}

export interface CatsThinToolRpcMessage {
  id?: string;
  type: 'request' | 'result';
  request_id: string;
  target_owner_user_id?: string;
  target_device_id?: string;
  device_id?: string;
  tool_name?: string;
  payload?: Record<string, unknown>;
  result?: unknown;
  error?: CatsDeviceRpcError;
  created_at?: number;
  expires_at?: number;
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
const DEFAULT_WS_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_WS_READY_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

function maskSecret(value: string): string {
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
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
  private pendingDeviceRpc = new Map<string, PendingDeviceRpc>();
  private pendingThinToolRpc = new Map<string, PendingThinToolRpc>();
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private subscribedTopics = new Set<string>();
  private supportsClientMessageDedupe = false;
  public supportsThinToolRpc = false;
  private awaitingReady = false;

  public uid = '';
  public name = '';

  constructor(private config: CatsClientConfig) {
    super();
  }

  connect(): void {
    if (this.ws) return;

    const bodyId = firstNonEmpty(
      this.config.bodyId,
      process.env.CATSCO_BODY_ID,
      process.env.CATSCOMPANY_BODY_ID,
      process.env.CATSCO_DEVICE_ID,
      process.env.CATSCOMPANY_DEVICE_ID,
    );
    if (!bodyId) {
      throw new Error('CatsCo bodyId missing; bind this runtime to a CatsCo agent body before starting the connector.');
    }
    const installationId = firstNonEmpty(
      this.config.installationId,
      process.env.CATSCO_INSTALLATION_ID,
      process.env.CATSCOMPANY_INSTALLATION_ID,
      bodyId,
    );

    Logger.info(`[CatsCompany] 正在连接: ${this.config.serverUrl}, apiKey=${maskSecret(this.config.apiKey)}, bodyId=${bodyId}`);
    this.supportsClientMessageDedupe = false;
    this.supportsThinToolRpc = false;
    this.ws = new WebSocket(this.config.serverUrl, {
      headers: {
        'X-API-Key': this.config.apiKey,
        'X-CatsCo-Body-ID': bodyId,
        'X-CatsCo-Installation-ID': installationId,
      },
    });
    this.startConnectTimeout(bodyId);

    this.ws.on('open', () => {
      this.clearConnectTimeout();
      this.awaitingReady = true;
      this.startReadyTimeout();
      this.send({
        hi: {
          id: '1',
          ver: CATSCOMPANY_PROTOCOL_VERSION,
          ua: CATSCOMPANY_CLIENT_UA,
          device: this.config.deviceRegistration,
        },
      });
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
      this.clearConnectTimeout();
      this.clearReadyTimeout();
      this.awaitingReady = false;
      this.stopHeartbeat();
      this.ws = null;
      this.rejectPendingAcks(new CatsSendError(
        'timeout',
        'WebSocket 在收到 CatsCompany 服务器确认前关闭',
        undefined,
        { retryableWithHttp: this.supportsClientMessageDedupe }
      ));
      this.rejectPendingDeviceRpc(new CatsSendError(
        'timeout',
        'WebSocket 在收到 Device RPC 结果前关闭'
      ));
      this.rejectPendingThinToolRpc(new CatsSendError(
        'timeout',
        'WebSocket closed before receiving Thin Tool RPC result'
      ));
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private handleMessage(msg: any): void {
    if (msg.ctrl) {
      if (msg.ctrl.code === 200 && msg.ctrl.params?.build === 'catscompany') {
        this.awaitingReady = false;
        this.clearReadyTimeout();
        this.reconnectAttempts = 0;
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
        if (Array.isArray(msg.ctrl.params?.features) && msg.ctrl.params.features.includes('device_rpc')) {
          Logger.info('[CatsCompany] 服务端支持 device_rpc 远程设备传输');
        }
        this.supportsThinToolRpc = Array.isArray(msg.ctrl.params?.features)
          && msg.ctrl.params.features.includes('thin_tool_rpc');
        if (this.supportsThinToolRpc) {
          Logger.info('[CatsCompany] 服务端支持 thin_tool_rpc 轻量工具传输');
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
    } else if (msg.device_rpc) {
      this.handleDeviceRpcMessage(msg.device_rpc);
    } else if (msg.thin_tool_rpc) {
      this.handleThinToolRpcMessage(msg.thin_tool_rpc);
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

  private handleDeviceRpcMessage(raw: any): void {
    const message = normalizeDeviceRpcMessage(raw);
    if (!message) {
      Logger.warning('[CatsCompany] 收到无效 device_rpc 消息，已忽略');
      return;
    }
    if (message.type === 'result') {
      const pending = this.pendingDeviceRpc.get(message.request_id);
      if (pending) {
        if (!deviceRpcResultMatchesPending(message, pending.request)) {
          clearTimeout(pending.timer);
          this.pendingDeviceRpc.delete(message.request_id);
          pending.reject(new CatsSendError(
            'ack',
            `Device RPC ${message.request_id} result scope does not match pending request`,
            409
          ));
        } else if (pending.acknowledged) {
          this.resolvePendingDeviceRpc(message.request_id, pending, message);
        } else {
          pending.result = message;
        }
      }
      this.emit('device_rpc_result', message);
      return;
    }
    this.emit('device_rpc_request', message);
  }

  private handleThinToolRpcMessage(raw: any): void {
    const message = normalizeThinToolRpcMessage(raw);
    if (message) {
      Logger.info(`[CatsCompany][thin_tool_rpc] received ${message.type}: request=${message.request_id}, tool=${message.tool_name || ''}, targetOwner=${message.target_owner_user_id || ''}, targetDevice=${message.target_device_id || ''}, device=${message.device_id || ''}, hasError=${Boolean(message.error)}, hasResult=${Boolean(message.result)}`);
    }
    if (!message) {
      Logger.warning('[CatsCompany] 收到无效 thin_tool_rpc 消息，已忽略');
      return;
    }
    if (message.type === 'result') {
      const pending = this.pendingThinToolRpc.get(message.request_id);
      if (pending) {
        if (!thinToolRpcResultMatchesPending(message, pending.request)) {
          clearTimeout(pending.timer);
          this.pendingThinToolRpc.delete(message.request_id);
          pending.reject(new CatsSendError(
            'ack',
            `Thin tool RPC ${message.request_id} result scope does not match pending request`,
            409
          ));
        } else if (pending.acknowledged) {
          this.resolvePendingThinToolRpc(message.request_id, pending, message);
        } else {
          pending.result = message;
        }
      }
      this.emit('thin_tool_rpc_result', message);
      return;
    }
    this.emit('thin_tool_rpc_request', message);
  }

  private resolvePendingDeviceRpc(
    requestID: string,
    pending: PendingDeviceRpc,
    result: CatsDeviceRpcMessage
  ): void {
    clearTimeout(pending.timer);
    this.pendingDeviceRpc.delete(requestID);
    pending.resolve(result);
  }

  private resolvePendingThinToolRpc(
    requestID: string,
    pending: PendingThinToolRpc,
    result: CatsThinToolRpcMessage
  ): void {
    clearTimeout(pending.timer);
    this.pendingThinToolRpc.delete(requestID);
    pending.resolve(result);
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

    return this.sendEnvelopeWithAck(msgId, { pub }, {
      clientMsgID,
      retryableWithHttp: this.supportsClientMessageDedupe,
      timeoutMessage: 'WebSocket 已发送消息，但 10 秒内没有收到 CatsCompany 服务器确认',
    });
  }

  async sendDeviceRpcRequest(
    request: Omit<CatsDeviceRpcMessage, 'id' | 'type'> & { request_id?: string },
    timeoutMs = 60000
  ): Promise<CatsDeviceRpcMessage> {
    const requestID = request.request_id || buildDeviceRpcRequestID();
    if (this.pendingDeviceRpc.has(requestID)) {
      throw new CatsSendError('ack', `Device RPC request_id already pending: ${requestID}`, 409);
    }
    const msgId = `${++this.msgId}`;
    const deviceRpc: CatsDeviceRpcMessage = {
      ...request,
      id: msgId,
      type: 'request',
      request_id: requestID,
    };

    const resultPromise = new Promise<CatsDeviceRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDeviceRpc.delete(requestID);
        reject(new CatsSendError(
          'timeout',
          `Device RPC ${requestID} 在 ${timeoutMs}ms 内没有收到设备结果`
        ));
      }, timeoutMs);
      this.pendingDeviceRpc.set(requestID, {
        request: deviceRpc,
        resolve,
        reject,
        timer,
        acknowledged: false,
      });
    });

    try {
      await this.sendEnvelopeWithAck(msgId, { device_rpc: deviceRpc }, {
        timeoutMessage: 'WebSocket 已发送 Device RPC 请求，但 10 秒内没有收到 CatsCompany 服务器确认',
      });
    } catch (err) {
      const pending = this.pendingDeviceRpc.get(requestID);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingDeviceRpc.delete(requestID);
        throw err;
      }
      throw err;
    }

    const pending = this.pendingDeviceRpc.get(requestID);
    if (pending) {
      pending.acknowledged = true;
      if (pending.result) {
        this.resolvePendingDeviceRpc(requestID, pending, pending.result);
      }
    }
    return resultPromise;
  }

  async sendDeviceRpcResult(result: Omit<CatsDeviceRpcMessage, 'id' | 'type'>): Promise<void> {
    const requestID = String(result.request_id || '').trim();
    if (!requestID) {
      throw new Error('Device RPC result request_id is required');
    }
    const msgId = `${++this.msgId}`;
    await this.sendEnvelopeWithAck(msgId, {
      device_rpc: {
        ...result,
        id: msgId,
        type: 'result',
        request_id: requestID,
      },
    }, {
      timeoutMessage: 'WebSocket 已发送 Device RPC 结果，但 10 秒内没有收到 CatsCompany 服务器确认',
    });
  }

  async sendThinToolRpcRequest(
    request: Omit<CatsThinToolRpcMessage, 'id' | 'type'> & { request_id?: string },
    timeoutMs = 60000
  ): Promise<CatsThinToolRpcMessage> {
    const requestID = request.request_id || buildThinToolRpcRequestID();
    if (this.pendingThinToolRpc.has(requestID)) {
      throw new CatsSendError('ack', `Thin tool RPC request_id already pending: ${requestID}`, 409);
    }
    const msgId = `${++this.msgId}`;
    const thinToolRpc: CatsThinToolRpcMessage = {
      ...request,
      id: msgId,
      type: 'request',
      request_id: requestID,
    };
    Logger.info(`[CatsCompany][thin_tool_rpc] send request: request=${requestID}, msg=${msgId}, tool=${thinToolRpc.tool_name || ''}, targetOwner=${thinToolRpc.target_owner_user_id || ''}, targetDevice=${thinToolRpc.target_device_id || ''}, timeoutMs=${timeoutMs}`);

    const resultPromise = new Promise<CatsThinToolRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingThinToolRpc.delete(requestID);
        Logger.warning(`[CatsCompany][thin_tool_rpc] request timeout waiting result: request=${requestID}, tool=${thinToolRpc.tool_name || ''}, targetOwner=${thinToolRpc.target_owner_user_id || ''}, targetDevice=${thinToolRpc.target_device_id || ''}, timeoutMs=${timeoutMs}`);
        reject(new CatsSendError(
          'timeout',
          `Thin tool RPC ${requestID} did not receive a tool result in ${timeoutMs}ms`
        ));
      }, timeoutMs);
      this.pendingThinToolRpc.set(requestID, {
        request: thinToolRpc,
        resolve,
        reject,
        timer,
        acknowledged: false,
      });
    });

    try {
      await this.sendEnvelopeWithAck(msgId, { thin_tool_rpc: thinToolRpc }, {
        timeoutMessage: 'WebSocket sent Thin Tool RPC request but CatsCompany did not acknowledge it within 10 seconds.',
      });
      Logger.info(`[CatsCompany][thin_tool_rpc] request acked by server: request=${requestID}, msg=${msgId}`);
    } catch (err) {
      const pending = this.pendingThinToolRpc.get(requestID);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingThinToolRpc.delete(requestID);
        throw err;
      }
      throw err;
    }

    const pending = this.pendingThinToolRpc.get(requestID);
    if (pending) {
      pending.acknowledged = true;
      if (pending.result) {
        this.resolvePendingThinToolRpc(requestID, pending, pending.result);
      }
    }
    return resultPromise;
  }

  async sendThinToolRpcResult(result: Omit<CatsThinToolRpcMessage, 'id' | 'type'>): Promise<void> {
    const requestID = String(result.request_id || '').trim();
    if (!requestID) {
      throw new Error('Thin tool RPC result request_id is required');
    }
    const msgId = `${++this.msgId}`;
    Logger.info(`[CatsCompany][thin_tool_rpc] send result: request=${requestID}, msg=${msgId}, tool=${result.tool_name || ''}, targetOwner=${result.target_owner_user_id || ''}, targetDevice=${result.target_device_id || ''}, device=${result.device_id || ''}, hasError=${Boolean(result.error)}, hasResult=${Boolean(result.result)}`);
    await this.sendEnvelopeWithAck(msgId, {
      thin_tool_rpc: {
        ...result,
        id: msgId,
        type: 'result',
        request_id: requestID,
      },
    }, {
      timeoutMessage: 'WebSocket sent Thin Tool RPC result but CatsCompany did not acknowledge it within 10 seconds.',
    });
    Logger.info(`[CatsCompany][thin_tool_rpc] result acked by server: request=${requestID}, msg=${msgId}`);
  }

  private sendEnvelopeWithAck(
    msgId: string,
    envelope: Record<string, unknown>,
    options: {
      clientMsgID?: string;
      retryableWithHttp?: boolean;
      timeoutMessage?: string;
    } = {}
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        this.forceReconnect('ack timeout');
        reject(new CatsSendError(
          'timeout',
          options.timeoutMessage || 'WebSocket 已发送消息，但 10 秒内没有收到 CatsCompany 服务器确认',
          undefined,
          { clientMsgID: options.clientMsgID, retryableWithHttp: options.retryableWithHttp ?? false }
        ));
      }, 10000);

      this.pendingAcks.set(msgId, { resolve, reject, timer, clientMsgID: options.clientMsgID });
      try {
        this.sendOrThrow(envelope);
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
      httpBaseUrl: this.httpBaseUrl(),
      filePath,
      type,
      authHeader: `ApiKey ${this.config.apiKey}`,
    });
  }

  async registerDevice(registration: CatsDeviceRegistration): Promise<unknown> {
    const res = await fetch(`${this.httpBaseUrl()}/api/devices/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `ApiKey ${this.config.apiKey}`,
      },
      body: JSON.stringify(registration),
    });
    if (!res.ok) {
      throw new Error(`CatsCompany device registration failed: ${res.status}`);
    }
    return res.json().catch(() => ({}));
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

  private rejectPendingDeviceRpc(err: Error): void {
    for (const [requestID, pending] of this.pendingDeviceRpc.entries()) {
      clearTimeout(pending.timer);
      this.pendingDeviceRpc.delete(requestID);
      pending.reject(err);
    }
  }

  private rejectPendingThinToolRpc(err: Error): void {
    for (const [requestID, pending] of this.pendingThinToolRpc.entries()) {
      clearTimeout(pending.timer);
      this.pendingThinToolRpc.delete(requestID);
      pending.reject(err);
    }
  }

  private forceReconnect(reason: string): void {
    Logger.warning(`[CatsCompany] ${reason}，主动重建 WebSocket 连接`);
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }

  private startConnectTimeout(bodyId: string): void {
    this.clearConnectTimeout();
    const timeoutMs = this.positiveTimeout(this.config.connectTimeoutMs, DEFAULT_WS_CONNECT_TIMEOUT_MS);
    this.connectTimer = setTimeout(() => {
      if (this.ws?.readyState !== WebSocket.CONNECTING) return;
      Logger.warning(`[CatsCompany] WebSocket 连接握手超时 ${timeoutMs}ms，主动重建连接: bodyId=${bodyId}`);
      this.ws.terminate();
    }, timeoutMs);
    (this.connectTimer as any).unref?.();
  }

  private clearConnectTimeout(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private startReadyTimeout(): void {
    this.clearReadyTimeout();
    const timeoutMs = this.positiveTimeout(this.config.readyTimeoutMs, DEFAULT_WS_READY_TIMEOUT_MS);
    this.readyTimer = setTimeout(() => {
      if (!this.awaitingReady || this.ws?.readyState !== WebSocket.OPEN) return;
      Logger.warning(`[CatsCompany] CatsCompany 握手确认超时 ${timeoutMs}ms，主动重建 WebSocket 连接`);
      this.ws.terminate();
    }, timeoutMs);
    (this.readyTimer as any).unref?.();
  }

  private clearReadyTimeout(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private positiveTimeout(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
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
    const baseDelay = this.positiveTimeout(this.config.reconnectBaseDelayMs, DEFAULT_RECONNECT_BASE_DELAY_MS);
    const maxDelay = this.positiveTimeout(this.config.reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS);
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    Logger.info(`[CatsCompany] ${delay}ms 后重连 (尝试 ${this.reconnectAttempts + 1})`);
    this.reconnectAttempts++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, delay);
  }

  private resubscribeTopics(): void {
    if (this.subscribedTopics.size > 0) {
      Logger.info(`[CatsCompany] 重新订阅 ${this.subscribedTopics.size} 个会话`);
      this.subscribedTopics.forEach(topic => {
        this.send({ sub: { topic } });
      });
    }
  }

  private httpBaseUrl(): string {
    return this.config.httpBaseUrl || inferHttpBaseUrl(this.config.serverUrl) || 'https://app.catsco.cc';
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectTimeout();
    this.clearReadyTimeout();
    this.awaitingReady = false;
    this.stopHeartbeat();
    this.ws?.close();
  }
}

interface PendingDeviceRpc {
  request: CatsDeviceRpcMessage;
  resolve: (message: CatsDeviceRpcMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  acknowledged: boolean;
  result?: CatsDeviceRpcMessage;
}

interface PendingThinToolRpc {
  request: CatsThinToolRpcMessage;
  resolve: (message: CatsThinToolRpcMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  acknowledged: boolean;
  result?: CatsThinToolRpcMessage;
}

function inferHttpBaseUrl(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function buildClientMessageID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `catsco-${crypto.randomUUID()}`;
  }
  return `catsco-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function buildDeviceRpcRequestID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `device_rpc_${crypto.randomUUID()}`;
  }
  return `device_rpc_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function buildThinToolRpcRequestID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `thin_tool_rpc_${crypto.randomUUID()}`;
  }
  return `thin_tool_rpc_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeDeviceRpcMessage(raw: any): CatsDeviceRpcMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = String(raw.type || '').trim();
  const requestID = String(raw.request_id || '').trim();
  if ((type !== 'request' && type !== 'result') || !requestID) return undefined;
  const message: CatsDeviceRpcMessage = {
    ...raw,
    type,
    request_id: requestID,
  };
  if (raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)) {
    message.payload = raw.payload;
  }
  return message;
}

function normalizeThinToolRpcMessage(raw: any): CatsThinToolRpcMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = String(raw.type || '').trim();
  const requestID = String(raw.request_id || '').trim();
  if ((type !== 'request' && type !== 'result') || !requestID) return undefined;
  const message: CatsThinToolRpcMessage = {
    ...raw,
    type,
    request_id: requestID,
  };
  if (raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)) {
    message.payload = raw.payload;
  }
  return message;
}

function deviceRpcResultMatchesPending(result: CatsDeviceRpcMessage, request: CatsDeviceRpcMessage): boolean {
  return deviceRpcOptionalFieldMatches(result.grant_id, request.grant_id)
    && deviceRpcOptionalFieldMatches(result.session_key, request.session_key)
    && deviceRpcOptionalFieldMatches(result.topic_id, request.topic_id)
    && deviceRpcOptionalFieldMatches(result.topic_type, request.topic_type)
    && deviceRpcOptionalFieldMatches(result.actor_user_id, request.actor_user_id)
    && deviceRpcOptionalFieldMatches(result.agent_id, request.agent_id)
    && deviceRpcOptionalFieldMatches(result.agent_body_id, request.agent_body_id)
    && deviceRpcOptionalFieldMatches(result.device_id, request.device_id)
    && deviceRpcOptionalFieldMatches(result.device_body_id, request.device_body_id)
    && deviceRpcOptionalFieldMatches(result.device_installation_id, request.device_installation_id)
    && deviceRpcOptionalFieldMatches(result.operation, request.operation)
    && deviceRpcOptionalFieldMatches(result.tool_name, request.tool_name);
}

function thinToolRpcResultMatchesPending(result: CatsThinToolRpcMessage, request: CatsThinToolRpcMessage): boolean {
  return deviceRpcPresentFieldMatches(result.target_owner_user_id, request.target_owner_user_id)
    && deviceRpcPresentFieldMatches(result.target_device_id, request.target_device_id)
    && deviceRpcPresentFieldMatches(result.device_id, request.target_device_id)
    && deviceRpcPresentFieldMatches(result.tool_name, request.tool_name);
}

function deviceRpcOptionalFieldMatches(actual: unknown, expected: unknown): boolean {
  const actualText = typeof actual === 'string' ? actual.trim() : '';
  const expectedText = typeof expected === 'string' ? expected.trim() : '';
  return !actualText || !expectedText || actualText === expectedText;
}

function deviceRpcPresentFieldMatches(actual: unknown, expected: unknown): boolean {
  const expectedText = typeof expected === 'string' ? expected.trim() : '';
  if (!expectedText) return true;
  const actualText = typeof actual === 'string' ? actual.trim() : '';
  return actualText === expectedText;
}

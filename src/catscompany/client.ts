// CatsCo 服务器 WebSocket 客户端
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { Logger } from '../utils/logger';
import { uploadCatsLocalFile, type UploadResult } from './upload';

export type { UploadResult } from './upload';

export interface CatsClientConfig {
  serverUrl: string;
  apiKey?: string;
  connectorToken?: string;
  authMode?: 'bot' | 'device_connector';
  bodyId?: string;
  installationId?: string;
  deviceRegistration?: CatsDeviceRegistration;
  httpBaseUrl?: string;
}

export interface CatsDeviceRegistration {
  device_id: string;
  display_name?: string;
  body_id?: string;
  installation_id?: string;
  status?: 'online' | 'offline';
  capabilities?: string[];
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
  agent_id?: string;
  agent_body_id?: string;
  device_id?: string;
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

export interface CatsBodyLeaseStatus {
  state?: string;
  active?: boolean;
  bodyId?: string;
  runtimeMode?: string;
  routeState?: string;
  connectedAt?: string;
  leaseExpiresAt?: string;
  leaseTtlMs?: number;
  observedAt?: string;
  source?: 'server' | 'local_transport';
  stale?: boolean;
}

export interface CatsDeviceRpcEvent {
  phase: 'sent' | 'acked' | 'result' | 'timeout' | 'failed' | 'inbound_request' | 'inbound_result_sent';
  requestId: string;
  operation?: string;
  toolName?: string;
  deviceId?: string;
  createdAt: string;
  durationMs?: number;
  error?: string;
}

export interface CatsClientStatusSnapshot {
  connected: boolean;
  ready: boolean;
  uid: string;
  name: string;
  bodyId?: string;
  installationId?: string;
  bodyLease?: CatsBodyLeaseStatus;
  supportsDeviceRpc: boolean;
  deviceRegistration?: CatsDeviceRegistration;
  deviceRpc: {
    pendingCount: number;
    pending: Array<{
      requestId: string;
      operation?: string;
      toolName?: string;
      deviceId?: string;
      startedAt: string;
      acknowledged: boolean;
    }>;
    recent: CatsDeviceRpcEvent[];
    counters: {
      sent: number;
      acked: number;
      result: number;
      timeout: number;
      failed: number;
      inboundRequest: number;
      inboundResultSent: number;
    };
  };
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
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private subscribedTopics = new Set<string>();
  private supportsClientMessageDedupe = false;
  private supportsDeviceRpc = false;
  private ready = false;
  private activeBodyId = '';
  private activeInstallationId = '';
  private bodyLease: CatsBodyLeaseStatus | undefined;
  private deviceRpcRecent: CatsDeviceRpcEvent[] = [];
  private deviceRpcCounters = {
    sent: 0,
    acked: 0,
    result: 0,
    timeout: 0,
    failed: 0,
    inboundRequest: 0,
    inboundResultSent: 0,
  };

  public uid = '';
  public name = '';

  constructor(private config: CatsClientConfig) {
    super();
  }

  connect(): void {
    if (this.ws) return;
    const connectorMode = this.isDeviceConnectorAuth();

    const bodyId = firstNonEmpty(
      this.config.bodyId,
      this.config.deviceRegistration?.body_id,
      this.config.deviceRegistration?.device_id,
      process.env.CATSCO_BODY_ID,
      process.env.CATSCOMPANY_BODY_ID,
      process.env.CATSCO_DEVICE_ID,
      process.env.CATSCOMPANY_DEVICE_ID,
    );
    if (!bodyId) {
      throw new Error(connectorMode
        ? 'CatsCo deviceId missing; pair this device connector before starting it.'
        : 'CatsCo bodyId missing; bind this runtime to a CatsCo agent body before starting the connector.');
    }
    if (!connectorMode && !firstNonEmpty(this.config.apiKey)) {
      throw new Error('CatsCo apiKey missing; bind this runtime to a CatsCo agent body before starting the connector.');
    }
    if (connectorMode && !firstNonEmpty(this.config.connectorToken)) {
      throw new Error('CatsCo connectorToken missing; pair this device connector before starting it.');
    }
    const installationId = firstNonEmpty(
      this.config.installationId,
      this.config.deviceRegistration?.installation_id,
      process.env.CATSCO_INSTALLATION_ID,
      process.env.CATSCOMPANY_INSTALLATION_ID,
      bodyId,
    );
    this.activeBodyId = bodyId;
    this.activeInstallationId = installationId;

    Logger.info(`[CatsCompany] 正在连接: ${this.config.serverUrl}, auth=${connectorMode ? 'device_connector' : 'bot_api_key'}, bodyId=${bodyId}`);
    this.supportsClientMessageDedupe = false;
    this.supportsDeviceRpc = false;
    this.ready = false;
    this.bodyLease = undefined;
    const headers: Record<string, string> = {
      'X-CatsCo-Body-ID': bodyId,
      'X-CatsCo-Installation-ID': installationId,
    };
    if (connectorMode) {
      headers['X-CatsCo-Connector-Token'] = firstNonEmpty(this.config.connectorToken) || '';
    } else {
      headers['X-API-Key'] = firstNonEmpty(this.config.apiKey) || '';
    }
    this.ws = new WebSocket(this.config.serverUrl, {
      headers,
    });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
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
      this.stopHeartbeat();
      this.ws = null;
      this.ready = false;
      this.supportsDeviceRpc = false;
      this.bodyLease = {
        ...(this.bodyLease || {}),
        state: 'offline',
        active: false,
        bodyId: this.bodyLease?.bodyId || this.activeBodyId || undefined,
        source: 'local_transport',
        stale: true,
        observedAt: new Date().toISOString(),
      };
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
        if (Array.isArray(msg.ctrl.params?.features) && msg.ctrl.params.features.includes('device_rpc')) {
          this.supportsDeviceRpc = true;
          Logger.info('[CatsCompany] 服务端支持 device_rpc 远程设备传输');
        }
        this.bodyLease = normalizeBodyLeaseStatus(msg.ctrl.params?.body_lease || msg.ctrl.params?.bodyLease);
        this.ready = true;
        this.emit('ready', { uid: this.uid, name: this.name, bodyLease: this.bodyLease });
        if (!this.isDeviceConnectorAuth()) {
          this.autoAcceptFriendRequests().catch(console.error);
          this.resubscribeTopics();
        }
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
          this.recordDeviceRpcEvent('failed', pending.request, {
            startedAt: pending.startedAt,
            error: 'result scope mismatch',
          });
          pending.reject(new CatsSendError(
            'ack',
            `Device RPC ${message.request_id} result scope does not match pending request`,
            409
          ));
          this.emit('device_rpc_result', message);
          return;
        } else if (pending.acknowledged) {
          this.resolvePendingDeviceRpc(message.request_id, pending, message);
        } else {
          pending.result = message;
        }
      }
      if (pending) {
        this.recordDeviceRpcEvent('result', message, { startedAt: pending.startedAt });
      }
      this.emit('device_rpc_result', message);
      return;
    }
    this.recordDeviceRpcEvent('inbound_request', message);
    this.emit('device_rpc_request', message);
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
    if (this.ready && !this.supportsDeviceRpc) {
      throw new CatsSendError('ack', 'CatsCompany server does not support device_rpc', 501);
    }
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

    const startedAt = Date.now();
    this.recordDeviceRpcEvent('sent', deviceRpc, { startedAt });
    const resultPromise = new Promise<CatsDeviceRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDeviceRpc.delete(requestID);
        this.recordDeviceRpcEvent('timeout', deviceRpc, { startedAt });
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
        startedAt,
      });
    });

    try {
      await this.sendEnvelopeWithAck(msgId, { device_rpc: deviceRpc }, {
        timeoutMessage: 'WebSocket 已发送 Device RPC 请求，但 10 秒内没有收到 CatsCompany 服务器确认',
      });
    } catch (err: any) {
      const pending = this.pendingDeviceRpc.get(requestID);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingDeviceRpc.delete(requestID);
        this.recordDeviceRpcEvent('failed', deviceRpc, {
          startedAt,
          error: err?.message || String(err),
        });
        throw err;
      }
      this.recordDeviceRpcEvent('failed', deviceRpc, {
        startedAt,
        error: err?.message || String(err),
      });
      throw err;
    }

    const pending = this.pendingDeviceRpc.get(requestID);
    if (pending) {
      pending.acknowledged = true;
      this.recordDeviceRpcEvent('acked', deviceRpc, { startedAt });
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
    const message: CatsDeviceRpcMessage = {
      ...result,
      id: msgId,
      type: 'result',
      request_id: requestID,
    };
    const startedAt = Date.now();
    try {
      await this.sendEnvelopeWithAck(msgId, {
        device_rpc: message,
      }, {
        timeoutMessage: 'WebSocket 已发送 Device RPC 结果，但 10 秒内没有收到 CatsCompany 服务器确认',
      });
      this.recordDeviceRpcEvent('inbound_result_sent', message, { startedAt });
    } catch (err: any) {
      this.recordDeviceRpcEvent('failed', message, {
        startedAt,
        error: err?.message || String(err),
      });
      throw err;
    }
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
    if (this.isDeviceConnectorAuth()) return;
    const httpBaseUrl = this.config.httpBaseUrl || 'https://app.catsco.cc';
    const res = await fetch(`${httpBaseUrl}/api/friends/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader()
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
      authHeader: this.authHeader(),
    });
  }

  async registerDevice(registration: CatsDeviceRegistration): Promise<unknown> {
    const path = this.isDeviceConnectorAuth()
      ? '/api/device-connectors/register'
      : '/api/devices/register';
    const res = await fetch(`${this.httpBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader(),
      },
      body: JSON.stringify(registration),
    });
    if (!res.ok) {
      throw new Error(`CatsCompany device registration failed: ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  getStatusSnapshot(): CatsClientStatusSnapshot {
    const pending = Array.from(this.pendingDeviceRpc.values()).map(item => ({
      requestId: item.request.request_id,
      operation: item.request.operation,
      toolName: item.request.tool_name,
      deviceId: item.request.device_id,
      startedAt: new Date(item.startedAt).toISOString(),
      acknowledged: item.acknowledged,
    }));
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      ready: this.ready,
      uid: this.uid,
      name: this.name,
      bodyId: this.activeBodyId || undefined,
      installationId: this.activeInstallationId || undefined,
      bodyLease: this.bodyLease ? { ...this.bodyLease } : undefined,
      supportsDeviceRpc: this.supportsDeviceRpc,
      deviceRegistration: this.config.deviceRegistration ? {
        ...this.config.deviceRegistration,
        capabilities: this.config.deviceRegistration.capabilities
          ? [...this.config.deviceRegistration.capabilities]
          : undefined,
      } : undefined,
      deviceRpc: {
        pendingCount: pending.length,
        pending,
        recent: [...this.deviceRpcRecent],
        counters: { ...this.deviceRpcCounters },
      },
    };
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
      this.recordDeviceRpcEvent('failed', pending.request, {
        startedAt: pending.startedAt,
        error: err.message,
      });
      pending.reject(err);
    }
  }

  private recordDeviceRpcEvent(
    phase: CatsDeviceRpcEvent['phase'],
    message: CatsDeviceRpcMessage,
    options: { startedAt?: number; error?: string } = {}
  ): void {
    const requestId = String(message.request_id || '').trim();
    if (!requestId) return;
    const startedAt = options.startedAt;
    const event: CatsDeviceRpcEvent = {
      phase,
      requestId,
      operation: message.operation,
      toolName: message.tool_name,
      deviceId: message.device_id,
      createdAt: new Date().toISOString(),
      durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : undefined,
      error: options.error,
    };
    this.deviceRpcRecent.push(event);
    if (this.deviceRpcRecent.length > 30) {
      this.deviceRpcRecent = this.deviceRpcRecent.slice(-30);
    }
    switch (phase) {
      case 'sent':
        this.deviceRpcCounters.sent++;
        break;
      case 'acked':
        this.deviceRpcCounters.acked++;
        break;
      case 'result':
        this.deviceRpcCounters.result++;
        break;
      case 'timeout':
        this.deviceRpcCounters.timeout++;
        break;
      case 'failed':
        this.deviceRpcCounters.failed++;
        break;
      case 'inbound_request':
        this.deviceRpcCounters.inboundRequest++;
        break;
      case 'inbound_result_sent':
        this.deviceRpcCounters.inboundResultSent++;
        break;
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
    if (this.closed) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    Logger.info(`[CatsCompany] ${delay}ms 后重连 (尝试 ${this.reconnectAttempts + 1})`);
    this.reconnectAttempts++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
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

  private isDeviceConnectorAuth(): boolean {
    return this.config.authMode === 'device_connector' || Boolean(firstNonEmpty(this.config.connectorToken));
  }

  private authHeader(): string {
    if (this.isDeviceConnectorAuth()) {
      const token = firstNonEmpty(this.config.connectorToken);
      if (!token) throw new Error('CatsCo connector token is required');
      return `DeviceConnector ${token}`;
    }
    const apiKey = firstNonEmpty(this.config.apiKey);
    if (!apiKey) throw new Error('CatsCo API key is required');
    return `ApiKey ${apiKey}`;
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
  startedAt: number;
  result?: CatsDeviceRpcMessage;
}

function normalizeBodyLeaseStatus(raw: any): CatsBodyLeaseStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    state: stringField(raw, 'state'),
    active: Boolean(raw.active),
    bodyId: stringField(raw, 'body_id') || stringField(raw, 'bodyId'),
    runtimeMode: stringField(raw, 'runtime_mode') || stringField(raw, 'runtimeMode'),
    routeState: stringField(raw, 'route_state') || stringField(raw, 'routeState'),
    connectedAt: stringField(raw, 'connected_at') || stringField(raw, 'connectedAt'),
    leaseExpiresAt: stringField(raw, 'lease_expires_at') || stringField(raw, 'leaseExpiresAt'),
    leaseTtlMs: numberField(raw, 'lease_ttl_ms') ?? numberField(raw, 'leaseTtlMs'),
    observedAt: new Date().toISOString(),
    source: 'server',
    stale: false,
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const text = String(record[key] || '').trim();
  return text || undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : undefined;
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

function deviceRpcOptionalFieldMatches(actual: unknown, expected: unknown): boolean {
  const actualText = typeof actual === 'string' ? actual.trim() : '';
  const expectedText = typeof expected === 'string' ? expected.trim() : '';
  return !actualText || !expectedText || actualText === expectedText;
}

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
  botUid?: string;
  bodyId?: string;
  installationId?: string;
  runtimeCredential?: string;
  runtimeCredentialExpiresAt?: number;
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
  runtime_role?: 'desktop' | 'server';
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

export interface CatsSkillMutationGrantMessage {
  id?: string;
  type: 'request' | 'result';
  request_id: string;
  client_request_id?: string;
  source_topic_id?: string;
  source_message_id?: number;
  local_skill_id?: string;
  operation?: 'create' | 'replace';
  candidate_content_hash?: string;
  candidate_size_bytes?: number;
  expected_definition_revision?: number;
  expected_previous_content_hash?: string;
  before_reference?: Record<string, unknown>;
  grant?: string;
  expires_at?: number;
  actor_user_id?: string;
  agent_id?: string;
  runtime_body_id?: string;
  error?: CatsDeviceRpcError;
}

export interface CatsSkillMutationGrantRequest {
  request_id?: string;
  client_request_id: string;
  source_topic_id: string;
  source_message_id: number;
  local_skill_id: string;
  operation: 'create' | 'replace';
  candidate_content_hash: string;
  candidate_size_bytes: number;
  expected_definition_revision: number;
  expected_previous_content_hash?: string;
  before_reference?: Record<string, unknown>;
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
  mentions?: string[]; // 服务端确认的结构化 @mention 目标
  memberCount?: number; // 群成员数；用于运行时在创建 session 前兜底门控
}

export interface CatsAgentContextMessage {
  id: number;
  seq_id: number;
  topic_id: string;
  from_uid: number;
  content?: unknown;
  content_blocks?: unknown[];
  type?: string;
  msg_type?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  agent_uid: number;
  agent_id: string;
  context_role: 'user' | 'assistant' | 'other_agent';
  context_eligible: boolean;
  context_reason?: string;
  mentions?: string[];
}

export interface CatsAgentContextPage {
  messages: CatsAgentContextMessage[];
  topic_id: string;
  agent_uid: number;
  has_more: boolean;
  next_before_id: number;
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

function oneLine(value: unknown, fallback = '-'): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 240) : fallback;
}

function classifyDisconnectCause(forcedCause: string, transportError: string, closeCode: number): string {
  if (forcedCause) return forcedCause;
  const httpStatus = transportError.match(/Unexpected server response:\s*(\d{3})/i)?.[1];
  if (httpStatus) return `upgrade_http_${httpStatus}`;
  const networkCode = transportError.match(/\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/i)?.[1];
  if (networkCode) return networkCode.toLowerCase();
  if (transportError) return 'transport_error';
  return closeCode === 1000 ? 'normal_close' : 'abnormal_close';
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
  private pendingSkillMutationGrants = new Map<string, PendingSkillMutationGrant>();
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private connectionOpenedAt = 0;
  private readyAt = 0;
  private lastActivityAt = 0;
  private disconnectCause = '';
  private lastTransportError = '';
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
    const configuredCredentialExpiresAt = Number(this.config.runtimeCredentialExpiresAt);
    const configuredRuntimeCredential = !Number.isFinite(configuredCredentialExpiresAt)
      || configuredCredentialExpiresAt > Date.now()
      ? this.config.runtimeCredential
      : undefined;
    const runtimeCredential = firstNonEmpty(
      configuredRuntimeCredential,
      process.env.CATSCO_RUNTIME_CREDENTIAL,
      process.env.CATSCOMPANY_RUNTIME_CREDENTIAL,
    );

    Logger.info(`[CatsCompany] 正在连接: ${this.config.serverUrl}, apiKey=${maskSecret(this.config.apiKey)}, bodyId=${bodyId}`);
    this.supportsClientMessageDedupe = false;
    this.supportsThinToolRpc = false;
    this.connectionOpenedAt = 0;
    this.readyAt = 0;
    this.lastActivityAt = 0;
    this.disconnectCause = '';
    this.lastTransportError = '';
    this.ws = new WebSocket(this.config.serverUrl, {
      headers: {
        'X-API-Key': this.config.apiKey,
        'X-CatsCo-Body-ID': bodyId,
        'X-CatsCo-Installation-ID': installationId,
        ...(runtimeCredential ? { 'X-CatsCo-Runtime-Credential': runtimeCredential } : {}),
      },
    });
    this.startConnectTimeout(bodyId);

    this.ws.on('open', () => {
      this.connectionOpenedAt = Date.now();
      this.lastActivityAt = this.connectionOpenedAt;
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
      this.lastActivityAt = Date.now();
      this.resetPongTimer();
      const msg = JSON.parse(data.toString());
      this.handleMessage(msg);
    });

    this.ws.on('pong', () => {
      this.lastActivityAt = Date.now();
      this.resetPongTimer();
    });

    this.ws.on('error', (err: Error) => {
      const errorCode = String((err as any)?.code || (err as any)?.cause?.code || '').trim();
      this.lastTransportError = oneLine(errorCode ? `${errorCode}: ${err.message}` : err.message);
      this.emit('error', err);
    });
    this.ws.on('close', (code: number, reason: Buffer) => {
      const closedAt = Date.now();
      const connectedAt = this.readyAt || this.connectionOpenedAt;
      const connectedForMs = connectedAt ? Math.max(0, closedAt - connectedAt) : 0;
      const lastActivityAgoMs = this.lastActivityAt ? Math.max(0, closedAt - this.lastActivityAt) : 0;
      const cause = classifyDisconnectCause(this.disconnectCause, this.lastTransportError, code);
      Logger.warning(
        `[CatsCompany] WebSocket 已关闭: code=${code}, reason=${oneLine(reason.toString())}, ` +
        `cause=${cause}, connectedForMs=${connectedForMs}, lastActivityAgoMs=${lastActivityAgoMs}, ` +
        `error=${oneLine(this.lastTransportError)}`,
      );
      this.clearConnectTimeout();
      this.clearReadyTimeout();
      this.awaitingReady = false;
      this.stopHeartbeat();
      this.ws = null;
      this.connectionOpenedAt = 0;
      this.readyAt = 0;
      this.lastActivityAt = 0;
      this.disconnectCause = '';
      this.lastTransportError = '';
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
      this.rejectPendingSkillMutationGrants(new CatsSendError(
        'timeout',
        'WebSocket closed before receiving a Skill mutation grant result'
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
        this.readyAt = Date.now();
        this.lastActivityAt = this.readyAt;
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
    } else if (msg.skill_mutation_grant) {
      this.handleSkillMutationGrantMessage(msg.skill_mutation_grant);
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
        mentions: Array.isArray(msg.data.mentions)
          ? msg.data.mentions.filter((value: unknown): value is string => typeof value === 'string')
          : undefined,
        memberCount: typeof msg.data.member_count === 'number'
          && Number.isSafeInteger(msg.data.member_count)
          && msg.data.member_count > 0
          ? msg.data.member_count
          : undefined,
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

  private handleSkillMutationGrantMessage(raw: any): void {
    const message = normalizeSkillMutationGrantMessage(raw);
    if (!message) {
      Logger.warning('[CatsCompany] Received an invalid Skill mutation grant message; ignored');
      return;
    }
    if (message.type !== 'result') return;
    const pending = this.pendingSkillMutationGrants.get(message.request_id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSkillMutationGrants.delete(message.request_id);
      if (
        !message.error
        && (
          message.client_request_id !== pending.request.client_request_id
          || !this.skillMutationGrantResultMatchesRuntime(message)
        )
      ) {
        pending.reject(new CatsSendError(
          'ack',
          `Skill mutation grant ${message.request_id} result does not match the pending candidate`,
          409,
        ));
      } else {
        pending.resolve(message);
      }
    }
    this.emit('skill_mutation_grant_result', message);
  }

  private skillMutationGrantResultMatchesRuntime(message: CatsSkillMutationGrantMessage): boolean {
    const expectedAgentID = normalizeCatsUID(this.config.botUid);
    const expectedBodyID = firstNonEmpty(
      this.config.bodyId,
      process.env.CATSCO_BODY_ID,
      process.env.CATSCOMPANY_BODY_ID,
      process.env.CATSCO_DEVICE_ID,
      process.env.CATSCOMPANY_DEVICE_ID,
    );
    return (!expectedAgentID || normalizeCatsUID(message.agent_id) === expectedAgentID)
      && (!expectedBodyID || message.runtime_body_id === expectedBodyID);
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

  async getAgentContextHistory(
    topic: string,
    options: { beforeId?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<CatsAgentContextPage> {
    const url = new URL(`${this.httpBaseUrl()}/api/messages`);
    url.searchParams.set('topic_id', topic);
    url.searchParams.set('agent_context', '1');
    url.searchParams.set('latest', '1');
    url.searchParams.set('limit', String(options.limit || 100));
    if (options.beforeId && options.beforeId > 0) {
      url.searchParams.set('before_id', String(options.beforeId));
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `ApiKey ${this.config.apiKey}`,
        'User-Agent': CATSCOMPANY_CLIENT_UA,
      },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CatsCompany agent context history failed: ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
    }

    const payload = await res.json() as Partial<CatsAgentContextPage>;
    if (
      !Array.isArray(payload.messages)
      || typeof payload.topic_id !== 'string'
      || typeof payload.agent_uid !== 'number'
      || typeof payload.has_more !== 'boolean'
      || typeof payload.next_before_id !== 'number'
    ) {
      throw new Error('CatsCompany server does not support safe agent context history');
    }
    return {
      messages: payload.messages,
      topic_id: payload.topic_id,
      agent_uid: payload.agent_uid,
      has_more: payload.has_more,
      next_before_id: payload.next_before_id,
    };
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

  async requestSkillMutationGrant(
    request: CatsSkillMutationGrantRequest,
    timeoutMs = 15_000,
  ): Promise<CatsSkillMutationGrantMessage> {
    const requestID = String(request.request_id || buildSkillMutationGrantRequestID()).trim();
    const clientRequestID = String(request.client_request_id || '').trim();
    const sourceTopicID = String(request.source_topic_id || '').trim();
    const localSkillID = String(request.local_skill_id || '').trim();
    const candidateHash = String(request.candidate_content_hash || '').trim().toLowerCase();
    const expectedPreviousHash = String(request.expected_previous_content_hash || '').trim().toLowerCase();
    if (
      !requestID
      || !clientRequestID
      || !sourceTopicID
      || !Number.isSafeInteger(request.source_message_id)
      || request.source_message_id <= 0
      || !localSkillID
      || (request.operation !== 'create' && request.operation !== 'replace')
      || !/^[a-f0-9]{64}$/.test(candidateHash)
      || !Number.isSafeInteger(request.candidate_size_bytes)
      || request.candidate_size_bytes <= 0
      || !Number.isSafeInteger(request.expected_definition_revision)
      || request.expected_definition_revision < 0
      || (expectedPreviousHash !== '' && !/^[a-f0-9]{64}$/.test(expectedPreviousHash))
    ) {
      throw new Error('Skill mutation grant request is invalid');
    }
    if (this.pendingSkillMutationGrants.has(requestID)) {
      throw new CatsSendError('ack', `Skill mutation grant request_id already pending: ${requestID}`, 409);
    }
    const msgId = `${++this.msgId}`;
    // Keep the client request boundary explicit. Runtime identity and grant
    // fields are server-issued result fields and must never be injectable by
    // callers through an `as any` or plain JavaScript object.
    const message: CatsSkillMutationGrantMessage = {
      request_id: requestID,
      client_request_id: clientRequestID,
      source_topic_id: sourceTopicID,
      source_message_id: request.source_message_id,
      local_skill_id: localSkillID,
      operation: request.operation,
      candidate_content_hash: candidateHash,
      candidate_size_bytes: request.candidate_size_bytes,
      expected_definition_revision: request.expected_definition_revision,
      ...(expectedPreviousHash ? { expected_previous_content_hash: expectedPreviousHash } : {}),
      ...(request.before_reference ? { before_reference: request.before_reference } : {}),
      id: msgId,
      type: 'request',
    };
    const resultPromise = new Promise<CatsSkillMutationGrantMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSkillMutationGrants.delete(requestID);
        reject(new CatsSendError(
          'timeout',
          `Skill mutation grant ${requestID} did not receive a result in ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      this.pendingSkillMutationGrants.set(requestID, { request: message, resolve, reject, timer });
    });
    try {
      // CatsCo returns a direct skill_mutation_grant result rather than a
      // separate ctrl ack, so this path intentionally waits only for that
      // candidate-bound response.
      this.sendOrThrow({ skill_mutation_grant: message });
    } catch (error) {
      const pending = this.pendingSkillMutationGrants.get(requestID);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSkillMutationGrants.delete(requestID);
      }
      throw error;
    }
    return resultPromise;
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

  private rejectPendingSkillMutationGrants(err: Error): void {
    for (const [requestID, pending] of this.pendingSkillMutationGrants.entries()) {
      clearTimeout(pending.timer);
      this.pendingSkillMutationGrants.delete(requestID);
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
      this.disconnectCause = 'connect_timeout';
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
      this.disconnectCause = 'ready_timeout';
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
      this.disconnectCause = 'heartbeat_timeout';
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
    this.disconnectCause = 'client_shutdown';
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

interface PendingSkillMutationGrant {
  request: CatsSkillMutationGrantMessage;
  resolve: (message: CatsSkillMutationGrantMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function normalizeSkillMutationGrantMessage(raw: any): CatsSkillMutationGrantMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = String(raw.type || '').trim();
  const requestID = String(raw.request_id || '').trim();
  if (type !== 'result' || !requestID) return undefined;
  const message = { ...raw, type, request_id: requestID } as CatsSkillMutationGrantMessage;
  if (message.error) {
    const code = String(message.error.code || '').trim();
    const text = String(message.error.message || '').trim();
    if (!code || !text) return undefined;
    message.error = { code, message: text };
  } else {
    const grant = String(message.grant || '').trim();
    const clientRequestID = String(message.client_request_id || '').trim();
    const actorUserID = String(message.actor_user_id || '').trim();
    const agentID = String(message.agent_id || '').trim();
    const runtimeBodyID = String(message.runtime_body_id || '').trim();
    const expiresAt = Number(message.expires_at);
    if (
      !grant
      || !clientRequestID
      || !actorUserID
      || !agentID
      || !runtimeBodyID
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()
    ) {
      return undefined;
    }
    message.grant = grant;
    message.client_request_id = clientRequestID;
    message.actor_user_id = actorUserID;
    message.agent_id = agentID;
    message.runtime_body_id = runtimeBodyID;
    message.expires_at = expiresAt;
  }
  return message;
}

function buildSkillMutationGrantRequestID(): string {
  return `skill_mutation_grant_${crypto.randomUUID()}`;
}

function normalizeCatsUID(value: unknown): string {
  return String(value || '').trim().replace(/^usr(?=\d+$)/i, '');
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

import type { ExecutionScope, MessageEnvelope, ScopedDeviceGrant, ScopedDeviceSelection } from '../types/session-identity';
import type { TargetRoutes } from '../types/tool';

/**
 * CatsCo agent 连接配置
 */
export interface CatsCompanyConfig {
  /** WebSocket 服务器地址，如 "ws://localhost:6061/v0/channels" */
  serverUrl: string;
  /** Bot API Key，如 "cc_8_abc123..." */
  apiKey: string;
  /** Stable bot identity used to isolate persisted chat context. */
  botUid?: string;
  /** 当前本地运行体 ID，用于防止同一个 bot 被多个本地 body 混用 */
  bodyId?: string;
  /** 当前安装/设备 ID，默认与 bodyId 相同 */
  installationId?: string;
  /** 当前本机设备归属的 CatsCo 用户 uid，用于区分本地自用与外部委托 */
  ownerUserId?: string;
  /** 用户可见设备名，用于 Dashboard 展示和服务端设备选择 */
  deviceName?: string;
  /** HTTP 基础地址（用于文件上传），默认从 serverUrl 推导 */
  httpBaseUrl?: string;
  /** 会话过期时间（毫秒），默认 30 分钟 */
  sessionTTL?: number;
}

/**
 * 解析后的 CatsCo 消息
 */
export interface ParsedCatsMessage {
  /** topic（如 p2p_6_7 或 grp_1） */
  topic: string;
  /** 会话类型 */
  chatType: 'p2p' | 'group';
  /** 发送者 uid（如 "usr7"） */
  senderId: string;
  /** 消息序号 */
  seq: number;
  /** 提取后的纯文本 */
  text: string;
  /** 原始 content（可能是 string 或 RichContent） */
  rawContent: unknown;
  /** 原始 metadata，由 CatsCo 服务端透传/注入 */
  metadata?: Record<string, unknown>;
  /** 标准化后的消息信封 */
  envelope: MessageEnvelope;
  /** 当前 turn 的执行身份 */
  executionScope: ExecutionScope;
  /** 服务端签发的当前 turn 用户设备授权 */
  deviceGrants?: ScopedDeviceGrant[];
  /** 服务端为当前 turn 选择的用户设备，或要求先选择设备 */
  deviceSelection?: ScopedDeviceSelection;
  targetRoutes?: TargetRoutes;
  /** 文件附件信息（rich content file/image 时存在） */
  file?: CatsFileInfo;
  /** 同一条消息里的全部附件（content_blocks 或 rich content） */
  files?: CatsFileInfo[];
}

/**
 * CatsCo 文件信息
 */
export interface CatsFileInfo {
  /** 文件 URL */
  url: string;
  /** 文件名 */
  fileName: string;
  /** 文件类型 */
  type: 'file' | 'image';
}

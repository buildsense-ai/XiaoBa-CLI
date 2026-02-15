/**
 * Cats Company 机器人配置
 */
export interface CatsCompanyConfig {
  /** WebSocket 服务器地址，如 "ws://localhost:6061/v0/channels" */
  serverUrl: string;
  /** Bot API Key，如 "cc_8_abc123..." */
  apiKey: string;
  /** HTTP 基础地址（用于文件上传），默认从 serverUrl 推导 */
  httpBaseUrl?: string;
  /** 会话过期时间（毫秒），默认 30 分钟 */
  sessionTTL?: number;
}

/**
 * 解析后的 Cats Company 消息
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
  /** 文件附件信息（rich content file/image 时存在） */
  file?: CatsFileInfo;
}

/**
 * Cats Company 文件信息
 */
export interface CatsFileInfo {
  /** 文件 URL */
  url: string;
  /** 文件名 */
  fileName: string;
  /** 文件类型 */
  type: 'file' | 'image';
}

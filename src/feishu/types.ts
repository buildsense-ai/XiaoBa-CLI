/**
 * 飞书机器人配置
 */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** 会话过期时间（毫秒），默认 30 分钟 */
  sessionTTL?: number;
  /** 机器人 open_id（推荐配置，群聊 @ 精确匹配） */
  botOpenId?: string;
  /** 机器人别名（当未配置 botOpenId 时用于兜底匹配） */
  botAliases?: string[];
}

/**
 * 解析后的飞书消息
 */
export interface ParsedFeishuMessage {
  /** 消息 ID */
  messageId: string;
  /** 会话 ID */
  chatId: string;
  /** 会话类型：p2p 或 group */
  chatType: 'p2p' | 'group';
  /** 发送者 open_id */
  senderId: string;
  /** 提取后的纯文本 */
  text: string;
  /** 是否 @了机器人 */
  mentionBot: boolean;
  /** 原始消息类型 */
  msgType: string;
  /** 文件附件信息（file/image 消息时存在） */
  file?: FeishuFileInfo;
  /** 合并转发子消息 ID 列表（merge_forward 消息时存在） */
  mergeForwardIds?: string[];
}

/**
 * 飞书文件信息
 */
export interface FeishuFileInfo {
  /** 文件 key（用于下载） */
  fileKey: string;
  /** 文件名 */
  fileName: string;
  /** 文件类型：file 或 image */
  type: 'file' | 'image';
}

import { ParsedFeishuMessage, FeishuFileInfo } from './types';

/**
 * 飞书消息解析器
 * 从 im.message.receive_v1 事件中提取文本和元信息
 */
export class MessageHandler {
  private botOpenId: string | null = null;
  private mentionAliases: string[] = [];

  setBotOpenId(openId: string): void {
    this.botOpenId = openId;
  }

  setMentionAliases(aliases: string[]): void {
    this.mentionAliases = aliases
      .map(alias => this.normalizeMentionText(alias))
      .filter(Boolean);
  }

  private static SUPPORTED_TYPES = new Set(['text', 'file', 'image', 'merge_forward']);

  /**
   * 解析飞书事件数据，提取结构化消息
   * 支持 text / file / image 三种消息类型
   */
  parse(data: any): ParsedFeishuMessage | null {
    const message = data?.message;
    if (!message) return null;

    const msgType: string = message.message_type || '';
    if (!MessageHandler.SUPPORTED_TYPES.has(msgType)) return null;

    let content: any;
    try {
      content = JSON.parse(message.content || '{}');
    } catch {
      return null;
    }

    // 提取文本和文件信息
    const { text, file, mergeForwardIds } = this.extractContent(msgType, content);

    // 文本和文件都为空则忽略（合并转发有 mergeForwardIds 也算有内容）
    if (!text && !file && (!mergeForwardIds || mergeForwardIds.length === 0)) return null;

    // 检测 @mention 并清理文本中的 @标记
    let cleanText = text;
    let mentionBot = false;
    const mentions: any[] = message.mentions || [];
    for (const m of mentions) {
      const mentionOpenId = m?.id?.open_id;
      const matchedByOpenId = Boolean(this.botOpenId && mentionOpenId === this.botOpenId);
      const matchedByAlias = !this.botOpenId && this.matchesBotAlias(m);
      if (matchedByOpenId || matchedByAlias) {
        mentionBot = true;
      }
      if (m.key) {
        cleanText = cleanText.replace(m.key, '').trim();
      }
    }

    const chatType = message.chat_type === 'group' ? 'group' : 'p2p';
    const senderId: string = data.sender?.sender_id?.open_id || '';

    return {
      messageId: message.message_id || '',
      chatId: message.chat_id || '',
      chatType,
      senderId,
      text: cleanText,
      mentionBot,
      msgType,
      file,
      mergeForwardIds,
      createTime: message.create_time ? Number(message.create_time) : undefined,
    };
  }

  /**
   * 根据消息类型提取文本和文件信息
   */
  private extractContent(
    msgType: string,
    content: any,
  ): { text: string; file?: FeishuFileInfo; mergeForwardIds?: string[] } {
    switch (msgType) {
      case 'text':
        return { text: (content.text || '').trim() };

      case 'file':
        return {
          text: `[文件] ${content.file_name || '未知文件'}`,
          file: {
            fileKey: content.file_key || '',
            fileName: content.file_name || 'unknown',
            type: 'file',
          },
        };

      case 'image':
        return {
          text: '[图片]',
          file: {
            fileKey: content.image_key || '',
            fileName: 'image.png',
            type: 'image',
          },
        };

      case 'merge_forward':
        return {
          text: '[合并转发消息]',
          mergeForwardIds: content.message_id_list || [],
        };

      default:
        return { text: '' };
    }
  }

  private matchesBotAlias(mention: any): boolean {
    if (this.mentionAliases.length === 0) {
      return false;
    }

    const candidates = [
      mention?.name,
      mention?.id?.name,
      mention?.key,
    ]
      .filter((item: unknown) => typeof item === 'string')
      .map((item: string) => this.normalizeMentionText(item));

    return candidates.some(candidate =>
      this.mentionAliases.some(alias => candidate === alias || candidate.includes(alias))
    );
  }

  private normalizeMentionText(input: string): string {
    return input
      .trim()
      .toLowerCase()
      .replace(/^@+/, '')
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  }
}

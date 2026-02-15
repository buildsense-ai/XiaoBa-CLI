import * as Lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../utils/logger';

/** 飞书单条消息最大字符数 */
const MAX_MSG_LENGTH = 4000;

/** 飞书文件上传 API 支持的 file_type */
const SUPPORTED_FILE_TYPES = new Set(['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream']);

export interface ResearchProgressCardPayload {
  runId: string;
  phase: string;
  status: string;
  summary?: string;
  coverageRate?: number;
}

/**
 * 飞书消息发送器
 * 支持回复消息和长文本自动分段
 */
export class MessageSender {
  constructor(private client: Lark.Client) {}

  /**
   * 回复一条消息，长文本自动分段发送
   */
  async reply(chatId: string, text: string): Promise<void> {
    const segments = this.splitText(text, MAX_MSG_LENGTH);
    for (const seg of segments) {
      await this.sendText(chatId, seg);
    }
  }

  /**
   * 发送单条文本消息
   */
  private async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (err: any) {
      Logger.error(`飞书消息发送失败: ${err.message || err}`);
    }
  }

  /**
   * 发送飞书卡片消息（interactive）
   */
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
    } catch (err: any) {
      Logger.error(`飞书卡片发送失败: ${err.message || err}`);
    }
  }

  /**
   * 发送 research 阶段进度卡片
   */
  async sendResearchProgressCard(chatId: string, payload: ResearchProgressCardPayload): Promise<void> {
    const coverageText = typeof payload.coverageRate === 'number'
      ? `${(payload.coverageRate * 100).toFixed(1)}%`
      : 'N/A';

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `Research Run ${payload.runId}`,
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**Phase**: ${payload.phase}\n**Status**: ${payload.status}\n**Evidence Coverage**: ${coverageText}`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: payload.summary || 'No summary',
          },
        },
      ],
    } as Record<string, unknown>;
 
    await this.sendCard(chatId, card);
  }

  /**
   * 发送进度消息（fire-and-forget，不抛异常）
   */
  sendProgress(chatId: string, text: string): void {
    this.sendText(chatId, text).catch((err) => {
      Logger.warning(`进度消息发送失败（已忽略）: ${err.message || err}`);
    });
  }

  /**
   * 下载飞书文件到项目目录下 files/feishu/
   */
  async downloadFile(messageId: string, fileKey: string, fileName: string): Promise<string | null> {
    try {
      const fileDir = path.join(process.cwd(), 'files', 'feishu');
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }

      const filePath = path.join(fileDir, `${Date.now()}_${fileName}`);
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      await (resp as any).writeFile(filePath);
      Logger.info(`文件已下载: ${filePath}`);
      return filePath;
    } catch (err: any) {
      Logger.error(`文件下载失败: ${err.message || err}`);
      return null;
    }
  }

  /**
   * 上传并发送文件
   */
  async sendFile(chatId: string, filePath: string, fileName: string): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(fileName).slice(1).toLowerCase() || 'stream';
    const fileType = SUPPORTED_FILE_TYPES.has(ext) ? ext : 'stream';

    const uploadRes = await this.client.im.v1.file.create({
      data: {
        file_type: fileType as any,
        file_name: fileName,
        file: fileBuffer,
      },
    });

    const fileKey = (uploadRes as any)?.file_key;
    if (!fileKey) {
      throw new Error('文件上传成功但未返回 file_key');
    }

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: 'file',
      },
    });
  }

  /**
   * 拉取单条消息的详情（用于合并转发子消息）
   */
  async getMessage(messageId: string): Promise<{ msgType: string; content: string; body?: string } | null> {
    try {
      const resp = await this.client.im.v1.message.get({
        path: { message_id: messageId },
      });
      const items = (resp as any)?.data?.items;
      if (!items || items.length === 0) return null;
      const msg = items[0];
      return {
        msgType: msg.msg_type || '',
        content: msg.body?.content || msg.content || '',
        body: msg.body?.content || '',
      };
    } catch (err: any) {
      Logger.error(`拉取消息详情失败 [${messageId}]: ${err.message || err}`);
      return null;
    }
  }

  /**
   * 拉取合并转发的所有子消息，拼接为纯文本
   */
  async fetchMergeForwardTexts(messageIds: string[]): Promise<string> {
    const texts: string[] = [];
    for (const msgId of messageIds) {
      const detail = await this.getMessage(msgId);
      if (!detail) {
        texts.push(`[消息拉取失败: ${msgId}]`);
        continue;
      }
      try {
        const parsed = JSON.parse(detail.content);
        if (detail.msgType === 'text') {
          texts.push(parsed.text || '');
        } else if (detail.msgType === 'image') {
          texts.push('[图片]');
        } else if (detail.msgType === 'file') {
          texts.push(`[文件] ${parsed.file_name || '未知文件'}`);
        } else if (detail.msgType === 'post') {
          // 富文本消息，提取纯文本
          const postText = this.extractPostText(parsed);
          texts.push(postText || '[富文本消息]');
        } else {
          texts.push(`[${detail.msgType}消息]`);
        }
      } catch {
        texts.push(detail.content || `[无法解析: ${detail.msgType}]`);
      }
    }
    return texts.filter(Boolean).join('\n');
  }

  /**
   * 从飞书 post（富文本）消息中提取纯文本
   */
  private extractPostText(parsed: any): string {
    const lines: string[] = [];
    // post 的 title
    const title = parsed.title;
    if (title) lines.push(title);
    // post 的 content 是二维数组 [[{tag, text}, ...], ...]
    const content = parsed.content;
    if (Array.isArray(content)) {
      for (const line of content) {
        if (!Array.isArray(line)) continue;
        const lineText = line
          .map((el: any) => {
            if (el.tag === 'text') return el.text || '';
            if (el.tag === 'a') return el.text || el.href || '';
            if (el.tag === 'at') return el.user_name ? `@${el.user_name}` : '';
            if (el.tag === 'img') return '[图片]';
            return '';
          })
          .join('');
        lines.push(lineText);
      }
    }
    return lines.join('\n');
  }

  /**
   * 将长文本按最大长度拆分，尽量在换行处断开
   */
  private splitText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const segments: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        segments.push(remaining);
        break;
      }

      // 在 maxLen 范围内找最后一个换行符
      let cutAt = remaining.lastIndexOf('\n', maxLen);
      if (cutAt <= 0) {
        cutAt = maxLen;
      }

      segments.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt).replace(/^\n/, '');
    }

    return segments;
  }
}

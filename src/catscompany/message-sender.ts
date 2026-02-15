import { CatsBot } from '@catscompany/bot-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

/** 单条消息最大字符数（与飞书保持一致） */
const MAX_MSG_LENGTH = 4000;

/**
 * Cats Company 消息发送器
 * 封装 CatsBot 的发送能力，支持长文本分段和文件上传
 */
export class MessageSender {
  constructor(private bot: CatsBot) {}

  /**
   * 回复一条消息，长文本自动分段发送
   */
  async reply(topic: string, text: string): Promise<void> {
    const segments = this.splitText(text, MAX_MSG_LENGTH);
    for (const seg of segments) {
      await this.sendText(topic, seg);
    }
  }

  /**
   * 发送单条文本消息
   */
  private async sendText(topic: string, text: string): Promise<void> {
    try {
      await this.bot.sendMessage(topic, text);
    } catch (err: any) {
      Logger.error(`CatsCompany 消息发送失败: ${err.message || err}`);
    }
  }

  /**
   * 上传并发送文件
   */
  async sendFile(topic: string, filePath: string, fileName: string): Promise<void> {
    try {
      const ext = path.extname(fileName).slice(1).toLowerCase();
      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
      const uploadType = isImage ? 'image' as const : 'file' as const;

      const uploadResult = await this.bot.uploadFile(filePath, uploadType);

      if (isImage) {
        await this.bot.sendImage(topic, uploadResult);
      } else {
        await this.bot.sendFile(topic, uploadResult);
      }

      Logger.info(`CatsCompany 文件已发送: ${fileName}`);
    } catch (err: any) {
      Logger.error(`CatsCompany 文件发送失败: ${err.message || err}`);
      throw err;
    }
  }

  /**
   * 下载文件到本地 files/catscompany/ 目录
   */
  async downloadFile(url: string, fileName: string): Promise<string | null> {
    try {
      const fileDir = path.join(process.cwd(), 'files', 'catscompany');
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }

      const localPath = path.join(fileDir, `${Date.now()}_${fileName}`);

      // 使用 bot 的 httpBaseUrl 拼接完整 URL（如果是相对路径）
      const fullUrl = url.startsWith('http') ? url : `${(this.bot as any).config.httpBaseUrl}${url}`;
      const resp = await fetch(fullUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      Logger.info(`文件已下载: ${localPath}`);
      return localPath;
    } catch (err: any) {
      Logger.error(`文件下载失败: ${err.message || err}`);
      return null;
    }
  }

  /**
   * 发送 typing 指示
   */
  sendTyping(topic: string): void {
    try {
      this.bot.sendTyping(topic);
    } catch {
      // fire-and-forget
    }
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

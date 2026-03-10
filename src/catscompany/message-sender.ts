import { CatsClient } from './client';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

const MAX_MSG_LENGTH = 4000;

export class MessageSender {
  constructor(private bot: CatsClient) {}

  async reply(topic: string, text: string): Promise<void> {
    const segments = this.splitText(text, MAX_MSG_LENGTH);
    for (const seg of segments) {
      await this.sendText(topic, seg);
    }
  }

  private async sendText(topic: string, text: string): Promise<void> {
    try {
      await this.bot.sendMessage(topic, text);
    } catch (err: any) {
      Logger.error(`CatsCompany 消息发送失败: ${err.message || err}`);
    }
  }

  sendTyping(topic: string): void {
    try {
      this.bot.sendTyping(topic);
    } catch {}
  }

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
      if (cutAt <= 0) cutAt = maxLen;

      segments.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt).replace(/^\n/, '');
    }

    return segments;
  }

  async sendFile(topic: string, filePath: string, fileName: string): Promise<void> {
    try {
      if (!fs.existsSync(filePath)) {
        Logger.error(`文件不存在: ${filePath}`);
        return;
      }

      const ext = path.extname(fileName).toLowerCase();
      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext.slice(1));
      const uploadType = isImage ? 'image' as const : 'file' as const;

      const uploadResult = await this.bot.uploadFile(filePath, uploadType);

      if (isImage) {
        await this.bot.sendImage(topic, uploadResult);
      } else {
        await this.bot.sendFile(topic, uploadResult);
      }

      Logger.info(`CatsCompany 文件已发送: ${fileName}`);
    } catch (err: any) {
      Logger.error(`文件发送失败: ${err.message}`);
      throw err;
    }
  }

  async downloadFile(url: string, fileName: string): Promise<string | null> {
    Logger.warning('文件下载功能暂未实现');
    return null;
  }
}

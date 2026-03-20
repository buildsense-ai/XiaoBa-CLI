import { CatsClient } from './client';
import { CatsContentBlock } from './content-blocks';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

const MAX_MSG_LENGTH = 4000;

export class MessageSender {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private bot: CatsClient, baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || 'https://api.catsco.cc';
    this.apiKey = apiKey || '';
  }

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
    try {
      const tmpDir = path.join(process.cwd(), 'tmp', 'downloads');
      fs.mkdirSync(tmpDir, { recursive: true });

      // 处理相对路径，拼接完整 URL
      const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;

      const localPath = path.join(tmpDir, `${Date.now()}_${fileName}`);
      const res = await fetch(fullUrl);
      if (!res.ok) {
        Logger.error(`文件下载失败: HTTP ${res.status} - ${url}`);
        return null;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      Logger.info(`文件已下载: ${fileName} → ${localPath} (${buffer.length} bytes)`);
      return localPath;
    } catch (err: any) {
      Logger.error(`文件下载失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 通过 REST API 发送带 content_blocks 的 code mode 消息。
   * content_blocks 包含 thinking / tool_use / tool_result 过程数据。
   */
  async sendWithBlocks(
    topic: string,
    text: string,
    contentBlocks: CatsContentBlock[],
  ): Promise<void> {
    try {
      const url = `${this.baseUrl}/api/messages/send`;
      const body: Record<string, unknown> = {
        topic_id: topic,
        content: text,
        content_blocks: contentBlocks,
        mode: 'code',
        role: 'assistant',
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `ApiKey ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        Logger.error(`content_blocks 发送失败: HTTP ${res.status} - ${errText}`);
        return;
      }

      Logger.info(`content_blocks 已发送 (${contentBlocks.length} blocks, topic=${topic})`);
    } catch (err: any) {
      Logger.error(`content_blocks 发送失败: ${err.message}`);
    }
  }
}

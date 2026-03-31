import { WeixinMessage } from './types';
import { downloadAndDecryptCDN } from './cdn';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export class MessageHandler {
  constructor(private cdnBaseUrl: string) {}

  parseMessage(msg: any): WeixinMessage | null {
    if (!msg) return null;

    let text = '';
    if (msg.item_list && msg.item_list.length > 0) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item?.text) {
          text += item.text_item.text;
        }
      }
    }

    return {
      message_id: String(msg.message_id || 0),
      from: { id: msg.from_user_id },
      chat: { id: msg.to_user_id },
      text: text || undefined,
      context_token: msg.context_token,
      item_list: msg.item_list,
    };
  }

  shouldIgnoreMessage(msg: WeixinMessage): boolean {
    return !msg.text && (!msg.item_list || msg.item_list.length === 0);
  }

  async downloadMedia(msg: WeixinMessage): Promise<string[]> {
    const files: string[] = [];
    if (!msg.item_list) return files;

    for (const item of msg.item_list) {
      try {
        // 处理图片 (type === 2)
        if (item.type === 2 && item.image_item?.media) {
          const { encrypt_query_param, aes_key } = item.image_item.media;
          if (encrypt_query_param && aes_key) {
            const data = await downloadAndDecryptCDN(this.cdnBaseUrl, encrypt_query_param, aes_key);
            const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
            const fileDir = path.join(process.cwd(), 'files', 'weixin');
            await fs.mkdir(fileDir, { recursive: true });
            const filepath = path.join(fileDir, filename);
            await fs.writeFile(filepath, data);
            files.push(filepath);
          }
        }

        // 处理文件 (type === 4)
        if (item.type === 4 && item.file_item?.media) {
          const { encrypt_query_param, aes_key } = item.file_item.media;
          const fileName = item.file_item.file_name || 'unknown';
          if (encrypt_query_param && aes_key) {
            const data = await downloadAndDecryptCDN(this.cdnBaseUrl, encrypt_query_param, aes_key);
            const fileDir = path.join(process.cwd(), 'files', 'weixin');
            await fs.mkdir(fileDir, { recursive: true });
            const filepath = path.join(fileDir, `${Date.now()}_${fileName}`);
            await fs.writeFile(filepath, data);
            files.push(filepath);
          }
        }
      } catch (err) {
        console.error('下载媒体失败:', err);
      }
    }
    return files;
  }
}

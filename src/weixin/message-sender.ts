import axios from 'axios';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { uploadBufferToCDN, aesECBPaddedSize } from './cdn';

const CHANNEL_VERSION = 'xiaoba-weixin/1.0';

function randomWechatUIN(): string {
  const buf = crypto.randomBytes(4);
  return Buffer.from(buf.readUInt32BE(0).toString()).toString('base64');
}

function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

export class MessageSender {
  constructor(
    private token: string,
    private baseUrl: string,
    private cdnBaseUrl: string
  ) {}

  async sendText(to: string, text: string, contextToken?: string): Promise<void> {
    if (!contextToken) {
      throw new Error('context_token is required for sending messages');
    }

    await axios.post(
      `${this.baseUrl}/ilink/bot/sendmessage`,
      {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: 'xiaoba-' + crypto.randomBytes(3).toString('hex'),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
      {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'AuthorizationType': 'ilink_bot_token',
          'Content-Type': 'application/json',
          'X-WECHAT-UIN': randomWechatUIN(),
        },
      }
    );
  }

  async sendFile(to: string, filePath: string, fileName: string, contextToken?: string): Promise<void> {
    if (!contextToken) {
      throw new Error('context_token is required for sending messages');
    }

    const plaintext = await fs.readFile(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
    const mediaType = isImage ? 1 : 3;

    const aeskey = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString('hex');
    const rawsize = plaintext.length;
    const filesize = aesECBPaddedSize(rawsize);

    const uploadResp = await axios.post(
      `${this.baseUrl}/ilink/bot/getuploadurl`,
      {
        filekey,
        media_type: mediaType,
        to_user_id: to,
        rawsize,
        rawfilemd5: md5Hex(plaintext),
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
        base_info: { channel_version: CHANNEL_VERSION },
      },
      {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'AuthorizationType': 'ilink_bot_token',
          'Content-Type': 'application/json',
          'X-WECHAT-UIN': randomWechatUIN(),
        },
      }
    );

    const downloadParam = await uploadBufferToCDN(
      this.cdnBaseUrl,
      uploadResp.data.upload_param,
      filekey,
      plaintext,
      aeskey
    );

    const messageItem = isImage
      ? {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
              encrypt_type: 1,
            },
            mid_size: filesize,
          },
        }
      : {
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(rawsize),
          },
        };

    await axios.post(
      `${this.baseUrl}/ilink/bot/sendmessage`,
      {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: 'xiaoba-' + crypto.randomBytes(3).toString('hex'),
          message_type: 2,
          message_state: 2,
          item_list: [messageItem],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
      {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'AuthorizationType': 'ilink_bot_token',
          'Content-Type': 'application/json',
          'X-WECHAT-UIN': randomWechatUIN(),
        },
      }
    );
  }
}

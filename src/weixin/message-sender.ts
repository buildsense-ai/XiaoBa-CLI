import axios from 'axios';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { uploadBufferToCDN, aesECBPaddedSize } from './cdn';
import { Logger } from '../utils/logger';

const CHANNEL_VERSION = 'xiaoba-weixin/1.0';

function randomWechatUIN(): string {
  const buf = crypto.randomBytes(4);
  return Buffer.from(buf.readUInt32BE(0).toString()).toString('base64');
}

function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function maskUserId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getResponseField(data: unknown, field: string): unknown {
  if (!isRecord(data)) return undefined;
  if (Object.prototype.hasOwnProperty.call(data, field)) return data[field];

  for (const nestedKey of ['data', 'result', 'response']) {
    const nested = data[nestedKey];
    if (isRecord(nested) && Object.prototype.hasOwnProperty.call(nested, field)) {
      return nested[field];
    }
  }

  return undefined;
}

function isSuccessCode(value: unknown): boolean {
  if (typeof value === 'number') return value === 0 || value === 200;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '0' || normalized === '200' || normalized === 'ok' || normalized === 'success';
  }
  return true;
}

function summarizeResponse(data: unknown): string {
  if (!isRecord(data)) return JSON.stringify(data) ?? String(data);

  const summary: Record<string, unknown> = {};
  for (const field of ['ret', 'errcode', 'errmsg', 'error_code', 'error_msg', 'code', 'message', 'msgid', 'request_id']) {
    const value = getResponseField(data, field);
    if (value !== undefined) summary[field] = value;
  }

  const safeBody = Object.keys(summary).length > 0
    ? summary
    : { keys: Object.keys(data).sort() };
  const text = JSON.stringify(safeBody);
  return text.length > 800 ? `${text.slice(0, 800)}...` : text;
}

function hasBusinessAcknowledgement(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const fields = ['ret', 'errcode', 'error_code', 'code', 'status_code', 'success', 'status', 'msgid', 'message_id', 'request_id'];
  return fields.some(field => getResponseField(data, field) !== undefined);
}

function assertWeixinBusinessOk(operation: string, data: unknown, options: { requireAck?: boolean } = {}): void {
  if (data == null) {
    if (options.requireAck) {
      throw new Error(`微信 ${operation} 响应为空，缺少业务确认字段`);
    }
    Logger.warning(`[微信] ${operation} 响应为空，按 HTTP 成功处理`);
    return;
  }

  if (options.requireAck && !hasBusinessAcknowledgement(data)) {
    throw new Error(`微信 ${operation} 响应缺少业务确认字段: response=${summarizeResponse(data)}`);
  }

  if (!options.requireAck && !hasBusinessAcknowledgement(data)) {
    Logger.warning(`[微信] ${operation} 响应缺少业务确认字段，已按 HTTP 成功处理: ${summarizeResponse(data)}`);
    return;
  }

  const success = getResponseField(data, 'success');
  if (success === false || success === 'false') {
    throw new Error(`微信 ${operation} 业务失败: success=false, response=${summarizeResponse(data)}`);
  }

  for (const field of ['ret', 'errcode', 'error_code', 'code', 'status_code']) {
    const value = getResponseField(data, field);
    if (value !== undefined && !isSuccessCode(value)) {
      throw new Error(`微信 ${operation} 业务失败: ${field}=${String(value)}, response=${summarizeResponse(data)}`);
    }
  }

  const status = getResponseField(data, 'status');
  if (typeof status === 'string') {
    const normalized = status.trim().toLowerCase();
    if (['fail', 'failed', 'failure', 'error', 'err'].includes(normalized)) {
      throw new Error(`微信 ${operation} 业务失败: status=${status}, response=${summarizeResponse(data)}`);
    }
  }

  Logger.info(`[微信] ${operation} 响应: ${summarizeResponse(data)}`);
}

export class MessageSender {
  constructor(
    private token: string,
    private baseUrl: string,
    private cdnBaseUrl: string
  ) {}

  async sendText(to: string, text: string, contextToken?: string, fromUserId?: string): Promise<void> {
    if (!contextToken) {
      throw new Error('context_token is required for sending messages');
    }

    const clientId = 'xiaoba-' + crypto.randomBytes(3).toString('hex');
    Logger.info(`[微信] sendmessage:text 请求: from=${fromUserId ? maskUserId(fromUserId) : '-'}, to=${maskUserId(to)}, context=${shortHash(contextToken)}, client=${clientId}, chars=${text.length}`);
    const response = await axios.post(
      `${this.baseUrl}/ilink/bot/sendmessage`,
      {
        msg: {
          from_user_id: fromUserId || '',
          to_user_id: to,
          client_id: clientId,
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
    assertWeixinBusinessOk('sendmessage:text', response.data);
  }

  async sendFile(to: string, filePath: string, fileName: string, contextToken?: string, fromUserId?: string): Promise<void> {
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

    assertWeixinBusinessOk('getuploadurl', uploadResp.data);

    let uploadParam: string;
    if (uploadResp.data.upload_param) {
      uploadParam = uploadResp.data.upload_param;
    } else if (uploadResp.data.upload_full_url) {
      const url = new URL(uploadResp.data.upload_full_url);
      uploadParam = url.searchParams.get('encrypted_query_param') || '';
      if (!uploadParam) {
        throw new Error('无法从 upload_full_url 提取 encrypted_query_param');
      }
    } else {
      throw new Error('微信 API 未返回 upload_param 或 upload_full_url');
    }

    const downloadParam = await uploadBufferToCDN(
      this.cdnBaseUrl,
      uploadParam,
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

    const clientId = 'xiaoba-' + crypto.randomBytes(3).toString('hex');
    Logger.info(`[微信] sendmessage:${isImage ? 'image' : 'file'} 请求: from=${fromUserId ? maskUserId(fromUserId) : '-'}, to=${maskUserId(to)}, context=${shortHash(contextToken)}, client=${clientId}, file=${fileName}, bytes=${rawsize}`);
    const sendResp = await axios.post(
      `${this.baseUrl}/ilink/bot/sendmessage`,
      {
        msg: {
          from_user_id: fromUserId || '',
          to_user_id: to,
          client_id: clientId,
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
    assertWeixinBusinessOk(`sendmessage:${isImage ? 'image' : 'file'}`, sendResp.data);
  }
}

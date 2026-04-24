import { CatsClient, CatsSendError } from './client';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

const MAX_MSG_LENGTH = 4000;

type CatsMessageType = 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'image' | 'file';

interface CatsSendBody {
  topic_id: string;
  type: CatsMessageType;
  content: unknown;
  metadata?: any;
}

function describeMessage(body: CatsSendBody): string {
  return `topic=${body.topic_id}, type=${body.type}`;
}

function describeAckFailure(err: CatsSendError): string {
  switch (err.code) {
    case 400:
      return `服务器拒绝消息：请求格式或消息协议不符合要求。${err.message}`;
    case 401:
      return `服务器拒绝消息：API Key 无效或未登录。请检查 Cats Company 配置里的 API Key。${err.message}`;
    case 403:
      return `服务器拒绝消息：权限不足，可能是不在该会话/群组、已被禁言，或机器人没有发送权限。${err.message}`;
    case 404:
      return `服务器拒绝消息：目标会话不存在或已经被删除。${err.message}`;
    case 429:
      return `服务器拒绝消息：触发限流或机器人循环保护，请稍后再试。${err.message}`;
    default:
      if (err.code && err.code >= 500) {
        return `服务器处理消息失败：Cats Company 服务端异常。${err.message}`;
      }
      return `服务器拒绝消息：${err.message}`;
  }
}

function describeCatsSendFailure(err: unknown): string {
  if (err instanceof CatsSendError) {
    if (err.kind === 'transport') {
      return `小八本机到 Cats Company 的 WebSocket 链路不可用，可能是本机网络、代理、防火墙、服务器地址或连接重连中的问题。${err.message}`;
    }
    if (err.kind === 'timeout') {
      return `WebSocket 消息已写出，但服务器确认超时。可能是服务器处理慢、网络抖动或连接半断开；为避免重复消息，不会自动改用 HTTP 重发。${err.message}`;
    }
    if (err.kind === 'ack') {
      return describeAckFailure(err);
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return `未知发送错误：${message}`;
}

function describeHttpFailure(status: number, body: string): string {
  const trimmed = body.trim();
  const detail = trimmed ? ` 响应: ${trimmed.slice(0, 500)}` : '';
  switch (status) {
    case 400:
      return `HTTP 兜底失败：请求格式不符合服务器要求。${detail}`;
    case 401:
      return `HTTP 兜底失败：API Key 无效或未授权，请检查 Cats Company 配置。${detail}`;
    case 403:
      return `HTTP 兜底失败：权限不足，可能是不在会话/群组、被禁言或机器人没有发送权限。${detail}`;
    case 404:
      return `HTTP 兜底失败：目标会话或接口不存在，请检查 HTTP Base URL 和 topic。${detail}`;
    case 429:
      return `HTTP 兜底失败：服务端限流，请稍后重试。${detail}`;
    default:
      if (status >= 500) {
        return `HTTP 兜底失败：Cats Company 服务端异常，状态码 ${status}。${detail}`;
      }
      return `HTTP 兜底失败：状态码 ${status}。${detail}`;
  }
}

function describeHttpException(err: any): string {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return `HTTP 请求超时：小八到 Cats Company 服务器的 HTTP 链路不可用或服务器响应过慢。${err.message || ''}`;
  }
  if (err?.cause?.code) {
    return `HTTP 网络连接失败：${err.cause.code}。可能是本机网络、DNS、代理、防火墙或服务器不可达。`;
  }
  return err?.message || String(err);
}

export class MessageSender {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private bot: CatsClient, baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || 'https://app.catsco.cc';
    this.apiKey = apiKey || '';
  }

  private async send(
    topic: string,
    type: CatsMessageType,
    content: unknown,
    metadata?: any
  ): Promise<{ seq_id: number }> {
    const body: CatsSendBody = {
      topic_id: topic,
      type,
      content,
    };
    if (metadata !== undefined) {
      body.metadata = metadata;
    }

    try {
      const seq = await this.bot.sendStructuredMessage(body);
      return { seq_id: seq };
    } catch (err: any) {
      if (err instanceof CatsSendError && err.kind === 'transport') {
        Logger.warning(`WebSocket 链路不可用，准备使用 HTTP 兜底发送（${describeMessage(body)}）：${describeCatsSendFailure(err)}`);
        const result = await this.sendViaHttp(body);
        Logger.info(`HTTP 兜底发送成功（${describeMessage(body)}, seq_id=${result.seq_id}）`);
        return result;
      }
      Logger.error(`WebSocket 消息发送失败，未使用 HTTP 兜底（${describeMessage(body)}）：${describeCatsSendFailure(err)}`);
      throw err;
    }
  }

  private async sendViaHttp(body: CatsSendBody): Promise<{ seq_id: number }> {
    try {
      const url = `${this.baseUrl}/api/messages/send`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `ApiKey ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(describeHttpFailure(res.status, errText));
      }

      const result = await res.json() as { seq_id: number };
      return result;
    } catch (err: any) {
      Logger.error(`HTTP 兜底发送失败（${describeMessage(body)}）：${describeHttpException(err)}`);
      throw err;
    }
  }

  async sendThinking(topic: string, thinking: string): Promise<void> {
    await this.send(topic, 'thinking', thinking);
    Logger.info(`Thinking 已发送: ${thinking.slice(0, 50)}...`);
  }

  async sendToolUse(topic: string, toolUseId: string, name: string, input: any): Promise<void> {
    await this.send(topic, 'tool_use', name, { id: toolUseId, input });
    Logger.info(`Tool use 已发送: ${name}, id=${toolUseId}`);
  }

  async sendToolResult(
    topic: string,
    toolUseId: string,
    content: string,
    isError = false
  ): Promise<void> {
    await this.send(topic, 'tool_result', content, {
      tool_use_id: toolUseId,
      is_error: isError,
    });
    Logger.info(`Tool result 已发送: tool_use_id=${toolUseId}`);
  }

  async sendText(topic: string, text: string): Promise<void> {
    await this.send(topic, 'text', text);
    Logger.info(`Text 已发送: ${text.slice(0, 50)}...`);
  }

  async reply(topic: string, text: string): Promise<void> {
    const segments = this.splitText(text, MAX_MSG_LENGTH);
    for (const seg of segments) {
      await this.sendText(topic, seg);
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
        throw new Error(`文件不存在: ${filePath}`);
      }

      const ext = path.extname(fileName).toLowerCase();
      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext.slice(1));
      const uploadType = isImage ? 'image' as const : 'file' as const;

      const fileSize = fs.statSync(filePath).size;
      Logger.info(`开始上传文件: ${fileName} (${fileSize} bytes, type: ${uploadType})`);

      const uploadResult = await this.bot.uploadFile(filePath, uploadType);
      Logger.info(`文件上传成功: ${uploadResult.url}`);

      await this.send(topic, uploadType, {
        type: uploadType,
        payload: {
          url: uploadResult.url,
          name: uploadResult.name,
          size: uploadResult.size,
        },
      });

      Logger.info(`CatsCompany 文件已发送: ${fileName}`);
    } catch (err: any) {
      Logger.error(`文件发送失败 (${fileName}): ${err.message}`);
      Logger.error(`错误堆栈: ${err.stack}`);
      throw err;
    }
  }

  async downloadFile(url: string, fileName: string): Promise<string | null> {
    try {
      const tmpDir = path.join(process.cwd(), 'tmp', 'downloads');
      fs.mkdirSync(tmpDir, { recursive: true });

      const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
      const localPath = path.join(tmpDir, `${Date.now()}_${fileName}`);
      const res = await fetch(fullUrl);
      if (!res.ok) {
        Logger.error(`文件下载失败: HTTP ${res.status} - ${url}`);
        return null;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      Logger.info(`文件已下载: ${fileName} -> ${localPath} (${buffer.length} bytes)`);
      return localPath;
    } catch (err: any) {
      Logger.error(`文件下载失败: ${err.message}`);
      return null;
    }
  }
}

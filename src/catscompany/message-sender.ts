import { CatsClient, CatsSendError } from './client';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { RuntimePlanSnapshot } from '../core/plan-runtime';

const MAX_MSG_LENGTH = 4000;
const IDEAL_REPLY_SEGMENT_LENGTH = 520;
const MAX_REPLY_SEGMENT_LENGTH = 1200;

type CatsMessageType = 'thinking' | 'tool_use' | 'tool_result' | 'runtime_plan' | 'text' | 'image' | 'file';

interface CatsSendBody {
  topic_id: string;
  client_msg_id?: string;
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
      return `CatsCo 服务器拒绝消息：API Key 无效或未登录。请检查 CatsCo 连接配置里的 API Key。${err.message}`;
    case 403:
      return `服务器拒绝消息：权限不足，可能是不在该会话/群组、已被禁言，或机器人没有发送权限。${err.message}`;
    case 404:
      return `服务器拒绝消息：目标会话不存在或已经被删除。${err.message}`;
    case 429:
      return `服务器拒绝消息：触发限流或机器人循环保护，请稍后再试。${err.message}`;
    default:
      if (err.code && err.code >= 500) {
        return `CatsCo 服务器处理消息失败。${err.message}`;
      }
      return `服务器拒绝消息：${err.message}`;
  }
}

function describeCatsSendFailure(err: unknown): string {
  if (err instanceof CatsSendError) {
    if (err.kind === 'transport') {
      return `CatsCo 桌面端到 CatsCo 服务器的 WebSocket 链路不可用，可能是本机网络、代理、防火墙、服务器地址或连接重连中的问题。${err.message}`;
    }
    if (err.kind === 'timeout') {
      const retryNote = err.retryableWithHttp
        ? '本次消息带有 client_msg_id，可安全使用 HTTP 兜底重试。'
        : '当前服务端未确认支持消息去重，为避免重复消息，不会自动改用 HTTP 重发。';
      return `WebSocket 消息已写出，但服务器确认超时。可能是服务器处理慢、网络抖动或连接半断开；${retryNote}${err.message}`;
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
      return `HTTP 兜底失败：API Key 无效或未授权，请检查 CatsCo 连接配置。${detail}`;
    case 403:
      return `HTTP 兜底失败：权限不足，可能是不在会话/群组、被禁言或机器人没有发送权限。${detail}`;
    case 404:
      return `HTTP 兜底失败：目标会话或接口不存在，请检查 HTTP Base URL 和 topic。${detail}`;
    case 429:
      return `HTTP 兜底失败：服务端限流，请稍后重试。${detail}`;
    default:
      if (status >= 500) {
        return `HTTP 兜底失败：CatsCo 服务器异常，状态码 ${status}。${detail}`;
      }
      return `HTTP 兜底失败：状态码 ${status}。${detail}`;
  }
}

function describeHttpException(err: any): string {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return `HTTP 请求超时：CatsCo 桌面端到 CatsCo 服务器的 HTTP 链路不可用或服务器响应过慢。${err.message || ''}`;
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
      client_msg_id: buildClientMessageID(),
      type,
      content,
    };
    body.metadata = {
      ...(metadata || {}),
      client_msg_id: body.client_msg_id,
    };

    try {
      const seq = await this.bot.sendStructuredMessage(body);
      return { seq_id: seq };
    } catch (err: any) {
      if (err instanceof CatsSendError && (err.kind === 'transport' || err.retryableWithHttp)) {
        if (err.clientMsgID) {
          body.client_msg_id = err.clientMsgID;
          body.metadata = {
            ...(body.metadata || {}),
            client_msg_id: err.clientMsgID,
          };
        }
        Logger.warning(`WebSocket 链路不可用或确认超时，准备使用 HTTP 兜底发送（${describeMessage(body)}）：${describeCatsSendFailure(err)}`);
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

  async sendThinking(topic: string, thinking: string, metadata?: any): Promise<void> {
    await this.send(topic, 'thinking', thinking, metadata);
    Logger.info(`Thinking 已发送: ${thinking.slice(0, 50)}...`);
  }

  async sendToolUse(topic: string, toolUseId: string, name: string, input: any, metadata?: any): Promise<void> {
    await this.send(topic, 'tool_use', name, {
      id: toolUseId,
      input,
      ...(metadata || {}),
    });
    Logger.info(`Tool use 已发送: ${name}, id=${toolUseId}`);
  }

  async sendToolResult(
    topic: string,
    toolUseId: string,
    content: string,
    isError = false,
    metadata?: any
  ): Promise<void> {
    await this.send(topic, 'tool_result', content, {
      tool_use_id: toolUseId,
      is_error: isError,
      ...(metadata || {}),
    });
    Logger.info(`Tool result 已发送: tool_use_id=${toolUseId}`);
  }

  async sendRuntimePlan(topic: string, snapshot: RuntimePlanSnapshot): Promise<void> {
    await this.send(topic, 'runtime_plan', snapshot, {
      runtime_plan: true,
      revision: snapshot.revision,
      cleared: snapshot.steps.length === 0,
    });
    Logger.info(`Runtime plan 已发送: revision=${snapshot.revision}, steps=${snapshot.steps.length}`);
  }

  async sendText(topic: string, text: string): Promise<void> {
    await this.send(topic, 'text', text);
    Logger.info(`Text 已发送: ${text.slice(0, 50)}...`);
  }

  async reply(topic: string, text: string): Promise<void> {
    const segments = this.splitReplyText(text);
    for (const seg of segments) {
      await this.sendText(topic, seg);
    }
  }

  sendTyping(topic: string): void {
    try {
      this.bot.sendTyping(topic);
    } catch {}
  }

  private splitReplyText(text: string): string[] {
    const normalized = String(text || '').trim();
    if (!normalized) return [];
    if (this.isStructuredReplyBlock(normalized)) {
      return this.splitText(normalized, MAX_MSG_LENGTH);
    }
    const shortListSegments = this.splitShortListReply(normalized);
    if (shortListSegments) return shortListSegments;
    const inlineListSegments = this.splitInlineOrderedReply(normalized);
    if (inlineListSegments) return inlineListSegments;

    const rawBlocks = normalized.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
    if (
      normalized.length <= IDEAL_REPLY_SEGMENT_LENGTH
      && (rawBlocks.length <= 1 || normalized.length <= 260)
    ) {
      return [normalized];
    }

    const blocks = rawBlocks
      .map(block => this.formatReplyBlock(block))
      .filter(Boolean);
    if (blocks.length <= 1) {
      return this.splitReplyBlock(rawBlocks[0] || normalized);
    }

    if (blocks.length <= 6) {
      return rawBlocks.flatMap(block => this.splitReplyBlock(block));
    }

    const segments: string[] = [];
    let current = '';

    const pushCurrent = () => {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = '';
    };

    for (const block of blocks) {
      if (block.length > MAX_REPLY_SEGMENT_LENGTH) {
        pushCurrent();
        segments.push(...this.splitText(
          block,
          this.isStructuredReplyBlock(block) ? MAX_MSG_LENGTH : MAX_REPLY_SEGMENT_LENGTH,
        ));
        continue;
      }

      if (!current) {
        current = block;
        continue;
      }

      const candidate = `${current}\n\n${block}`;
      if (candidate.length > IDEAL_REPLY_SEGMENT_LENGTH && current.length >= 220) {
        pushCurrent();
        current = block;
      } else if (candidate.length > MAX_REPLY_SEGMENT_LENGTH) {
        pushCurrent();
        current = block;
      } else {
        current = candidate;
      }
    }

    pushCurrent();
    return segments.length > 0 ? segments : [normalized];
  }

  private splitReplyBlock(block: string): string[] {
    if (this.isStructuredReplyBlock(block)) {
      return this.splitText(String(block || '').trim(), MAX_MSG_LENGTH);
    }
    const naturalSegments = this.splitNaturalLanguageReply(block);
    if (naturalSegments) return naturalSegments;
    return this.splitText(this.formatReplyBlock(block), MAX_REPLY_SEGMENT_LENGTH);
  }

  private splitShortListReply(text: string): string[] | null {
    if (text.length > IDEAL_REPLY_SEGMENT_LENGTH) return null;
    if (/```|~~~/.test(text)) return null;

    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length < 2 || lines.length > 5) return null;
    if (!lines.every(line => line.length <= 160)) return null;
    if (!lines.every(line => /^(?:\d+[\.\)、）]\s?|[-*+•]\s+)/.test(line))) return null;

    return lines;
  }

  private splitInlineOrderedReply(text: string): string[] | null {
    if (text.length > IDEAL_REPLY_SEGMENT_LENGTH) return null;
    if (/```|~~~/.test(text)) return null;

    const trimmed = text.trim();
    if (/\r?\n/.test(trimmed)) return null;
    const parts = trimmed
      .split(/(?=(?:第一|第二|第三|第四|第五|首先|其次|最后)[，、:：])/)
      .map(part => part.trim())
      .filter(Boolean);

    if (parts.length < 2 || parts.length > 5) return null;
    if (!parts.every(part => /^(?:第一|第二|第三|第四|第五|首先|其次|最后)[，、:：]/.test(part))) return null;
    if (!parts.every(part => part.length <= 180)) return null;

    return parts;
  }

  private splitNaturalLanguageReply(block: string): string[] | null {
    const trimmed = String(block || '').trim();
    if (trimmed.length <= IDEAL_REPLY_SEGMENT_LENGTH) return null;
    if (/```|~~~/.test(trimmed)) return null;
    if (trimmed.split(/\r?\n/).length > 1) return null;
    if (!this.shouldIndentReplyBlock(trimmed)) return null;

    const segments: string[] = [];
    let remaining = trimmed;
    while (remaining.length > 0) {
      if (remaining.length <= IDEAL_REPLY_SEGMENT_LENGTH) {
        segments.push(remaining);
        break;
      }

      const cutAt = this.findNaturalLanguageCut(remaining, IDEAL_REPLY_SEGMENT_LENGTH);
      segments.push(remaining.slice(0, cutAt).trim());
      remaining = remaining.slice(cutAt).trim();
    }

    if (segments.length <= 1) return null;
    return segments.map(segment => this.formatReplyBlock(segment));
  }

  private findNaturalLanguageCut(text: string, maxLen: number): number {
    const minLen = 260;
    const hard = this.findLastMatchEnd(text, /[。！？；;!?]/g, minLen, maxLen);
    if (hard > 0) return hard;

    const soft = this.findLastMatchEnd(text, /[，,、]/g, Math.min(360, maxLen), maxLen);
    if (soft > 0) return soft;

    return Math.min(maxLen, text.length);
  }

  private findLastMatchEnd(text: string, pattern: RegExp, minLen: number, maxLen: number): number {
    const sample = text.slice(0, maxLen + 1);
    let best = -1;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(sample)) !== null) {
      const end = match.index + match[0].length;
      if (end >= minLen && end <= maxLen) best = end;
    }
    return best;
  }

  private formatReplyBlock(block: string): string {
    const trimmed = String(block || '').trim();
    if (!trimmed) return '';
    if (!this.shouldIndentReplyBlock(trimmed)) return trimmed;
    return trimmed.startsWith('　　') ? trimmed : `　　${trimmed}`;
  }

  private shouldIndentReplyBlock(block: string): boolean {
    const firstLine = block.split(/\r?\n/, 1)[0].trimStart();
    if (!firstLine) return false;
    if (firstLine.startsWith('　　')) return false;
    if (/^(```|~~~|>|#{1,6}\s|[-*+]\s|\d+[\.\)、]\s?|\|)/.test(firstLine)) return false;
    if (/^(?:[A-Za-z]:\\|\\\\|\/|[A-Za-z0-9_.-]+\.(?:js|ts|md|json|html|css|py)\b)/.test(firstLine)) return false;
    if (this.isStructuredReplyBlock(block)) return false;
    return true;
  }

  private isStructuredReplyBlock(block: string): boolean {
    const trimmed = String(block || '').trim();
    if (!trimmed) return false;
    if (/^```|^~~~/.test(trimmed)) return true;
    if (this.isJsonReplyBlock(trimmed)) return true;
    if (/^(?:select|with|insert|update|delete|create|alter|drop|explain)\b[\s\S]*\b(?:from|set|values|table|where|join|returning|select)\b/i.test(trimmed)) {
      return true;
    }
    if (/^<(?!!--)(?:!doctype\s+html|html\b|[a-z][\w:-]*(?:\s|>|\/>))[\s\S]*>$/i.test(trimmed)) {
      return true;
    }
    const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length >= 2 && lines.every(line => /^[A-Z_][A-Z0-9_]*=/.test(line))) return true;
    if (lines.length >= 3 && lines.every(line => /^[\w.-]+\s*:\s+.+/.test(line))) return true;
    if (lines.length >= 2 && lines.every(line => line.includes(',')) && new Set(lines.map(line => line.split(',').length)).size === 1) {
      return true;
    }
    return false;
  }

  private isJsonReplyBlock(text: string): boolean {
    if (!/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(text)) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
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

      Logger.info(`CatsCo 文件已发送: ${fileName}`);
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

function buildClientMessageID(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `catsco-${Date.now()}-${random}`;
}

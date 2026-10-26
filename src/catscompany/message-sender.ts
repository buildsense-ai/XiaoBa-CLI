import { CatsClient, CatsSendError } from './client';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { RuntimePlanSnapshot } from '../core/plan-runtime';

const MAX_MSG_LENGTH = 4000;

/**
 * A topic that rejects sends this many times in a row (without any successful
 * send in between) is treated as unwritable, and onTopicSendBlocked fires.
 * 403/404 are explicit server rejections (no longer in the group/session, or
 * the target was deleted), so retrying them is pointless.
 */
const TOPIC_SEND_FAILURE_THRESHOLD = 5;

function isPermanentTopicRejection(err: unknown): err is CatsSendError {
  return err instanceof CatsSendError
    && err.kind === 'ack'
    && (err.code === 403 || err.code === 404);
}

/**
 * HTTP fallback failures carry the HTTP status (see sendViaHttp). 403/404 are
 * the same permanent rejections as their WebSocket counterparts and must feed
 * the send circuit breaker too.
 */
function isPermanentHttpRejection(err: any): err is { status: number } {
  return err?.status === 403 || err?.status === 404;
}

/**
 * 平台内部的括号标注：为了让模型续聊而塞进工具结果里的提示，**不该出现在用户回复里**。
 *
 * 提示词里写了「不要在回复中提及本行」，但模型并不总听 —— 生产实测有 388 条消息
 * 把 `[续聊凭据 session_id=...]` 原样发到了群里（8 个 bot，从 3 月至今）。
 * 靠提示词约束不住的事，出口处兜底。
 *
 * 只剥「我们注入的固定句式」，不做泛化清洗：用户/模型自己写的方括号内容必须原样保留。
 */
const INTERNAL_ANNOTATIONS: RegExp[] = [
  /\s*\[续聊凭据[^\]]*\]/g,
];

export function stripInternalAnnotations(text: string): string {
  let out = text;
  for (const pattern of INTERNAL_ANNOTATIONS) out = out.replace(pattern, '');
  return out.trim();
}

type CatsMessageType = 'thinking' | 'tool_use' | 'tool_result' | 'runtime_plan' | 'task_status' | 'text' | 'image' | 'file';

export type ConversationTaskState = 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';

export interface ConversationTaskStatusInput {
  run_id: string;
  artifact_task_ref?: string;
  state: ConversationTaskState;
  summary: string;
  error?: string;
}

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

  /**
   * Optional hook for topics that keep rejecting sends (see
   * TOPIC_SEND_FAILURE_THRESHOLD). Callers use it to stop work loops bound to
   * the topic, e.g. a bot kicked from a group must not keep retrying sends on
   * every turn. Fires when a streak of consecutive 403/404 rejections reaches
   * the threshold; any successful send re-arms it.
   */
  onTopicSendBlocked: ((topic: string, code?: number) => void) | null = null;

  /**
   * 会被回填的持久消息类型，与服务端 durable 白名单的交集
   * （`server/message_visibility.go`：text / image / voice / file）。只有这些类型
   * 会出现在群历史回填里，也就只有它们的 seq 需要记住。
   *
   * 这里不含 `voice`：客户端不发送该类型（见 `CatsMessageType`）。服务端白名单
   * 里留着它是给别的上报方用的，与本客户端的记账无关。
   */
  private static readonly DURABLE_MESSAGE_TYPES: ReadonlySet<CatsMessageType> =
    new Set<CatsMessageType>(['text', 'image', 'file']);

  /**
   * 持久消息发送成功后回调（topic + 本次各分段的 seq）。
   *
   * 记账挂在 `send()` 而不是某个调用方：文本走 `reply`、附件走 `sendFile`，两条
   * 路径都经过 `send()`。只挂 `reply` 会漏掉附件——bot 自己发的图片和文件同样
   * 会进回填，认不出就会重复插入。以后新增持久类型也自动覆盖。
   */
  onDurableMessageSent: ((topic: string, seqs: number[]) => void) | null = null;

  private readonly topicFailureStreak = new Map<string, number>();

  constructor(private bot: CatsClient, baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || '';
    this.apiKey = apiKey || '';
  }

  /**
   * HTTP 兑底地址跟随客户端当前生效的域名族（cc/cn）；未显式配置时
   * 不再固定写死单一域名，避免 WS 已切到另一域名而 HTTP 仍打旧域名。
   */
  private resolveBaseUrl(): string {
    if (this.baseUrl) return this.baseUrl;
    return this.bot.getHttpBaseUrl?.() || 'https://app.catsco.cn';
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
      this.topicFailureStreak.delete(topic);
      this.notifyDurableMessageSent(topic, type, seq);
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
        try {
          const result = await this.sendViaHttp(body);
          this.topicFailureStreak.delete(topic);
          Logger.info(`HTTP 兜底发送成功（${describeMessage(body)}, seq_id=${result.seq_id}）`);
          this.notifyDurableMessageSent(topic, type, result.seq_id);
          return result;
        } catch (httpErr: any) {
          // WS 兜底到 HTTP 后仍被永久拒绝（例如 WS ack 超时窗口内被踢出群）
          // 也要计入熔断；HTTP 失败抛出的是携带 status 的普通 Error。
          if (isPermanentHttpRejection(httpErr)) this.recordTopicSendBlocked(topic, httpErr.status);
          throw httpErr;
        }
      }
      if (isPermanentTopicRejection(err)) this.recordTopicSendBlocked(topic, err.code);
      Logger.error(`WebSocket 消息发送失败，未使用 HTTP 兜底（${describeMessage(body)}）：${describeCatsSendFailure(err)}`);
      throw err;
    }
  }

  private recordTopicSendBlocked(topic: string, code?: number): void {
    const streak = (this.topicFailureStreak.get(topic) || 0) + 1;
    if (streak < TOPIC_SEND_FAILURE_THRESHOLD) {
      this.topicFailureStreak.set(topic, streak);
      return;
    }
    this.topicFailureStreak.delete(topic);
    Logger.warning(
      `消息发送连续 ${streak} 次被服务器拒绝（HTTP ${code ?? '-'}，topic=${topic}），触发发送熔断`
    );
    try {
      this.onTopicSendBlocked?.(topic, code);
    } catch (hookError: any) {
      Logger.warning(`发送熔断回调执行失败: ${hookError?.message || hookError}`);
    }
  }

  private async sendViaHttp(body: CatsSendBody): Promise<{ seq_id: number }> {
    try {
      const url = `${this.resolveBaseUrl()}/api/messages/send`;
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
        const failure = new Error(describeHttpFailure(res.status, errText)) as Error & { status?: number };
        failure.status = res.status;
        throw failure;
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

  /**
   * Publishes the latest task state for the conversation sidebar. The server
   * stores this independently from chat history, so it must stay lightweight.
   */
  async sendTaskStatus(topic: string, status: ConversationTaskStatusInput): Promise<void> {
    await this.send(topic, 'task_status', status);
    Logger.info(`Task status 已发送: topic=${topic}, state=${status.state}, run=${status.run_id}`);
  }

  async sendText(topic: string, text: string): Promise<number> {
    const { seq_id } = await this.send(topic, 'text', text);
    Logger.info(`Text 已发送: ${text.slice(0, 50)}...`);
    return seq_id;
  }

  /**
   * 发送回复，返回各分段在服务端的 seq。
   *
   * 记账不在这里做：每段经 `sendText` → `send`，`send` 成功即按持久类型回调，
   * 所以中途失败时已发出的分段也已经记过账。
   */
  async reply(topic: string, text: string): Promise<number[]> {
    const normalized = typeof text === 'string'
      ? stripInternalAnnotations(text.trim())
      : '';
    if (!normalized) {
      Logger.info(`Reply skipped: empty or whitespace-only text (topic=${topic})`);
      return [];
    }
    const segments = this.splitText(normalized, MAX_MSG_LENGTH);
    const seqs: number[] = [];
    for (const seg of segments) {
      const seq = await this.sendText(topic, seg);
      if (Number.isFinite(seq) && seq > 0) seqs.push(seq);
    }
    return seqs;
  }

  private notifyDurableMessageSent(topic: string, type: CatsMessageType, seq: number): void {
    if (!this.onDurableMessageSent) return;
    if (!Number.isFinite(seq) || seq <= 0) return;
    if (!MessageSender.DURABLE_MESSAGE_TYPES.has(type)) return;
    try {
      this.onDurableMessageSent(topic, [seq]);
    } catch (err: any) {
      // 回调只是记账，失败不该影响已经发出的消息。
      Logger.warning(`发送后回调失败 (topic=${topic}): ${err?.message || err}`);
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

      Logger.info(`CatsCo 文件已发送: ${fileName}`);
    } catch (err: any) {
      Logger.error(`文件发送失败 (${fileName}): ${err.message}`);
      Logger.error(`错误堆栈: ${err.stack}`);
      throw err;
    }
  }

  async downloadFile(url: string, fileName: string, options: { targetPath?: string } = {}): Promise<string | null> {
    let partPath: string | undefined;
    try {

      const fullUrl = url.startsWith('http') ? url : `${this.resolveBaseUrl()}${url}`;
      const localPath = options.targetPath
        ? path.resolve(options.targetPath)
        : path.join(process.cwd(), 'tmp', 'downloads', `${Date.now()}_${path.basename(fileName)}`);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      partPath = `${localPath}.part-${process.pid}-${Date.now()}`;
      const res = await fetch(fullUrl);
      if (!res.ok) {
        Logger.error(`文件下载失败: HTTP ${res.status} - ${url}`);
        return null;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(partPath, buffer);
      fs.renameSync(partPath, localPath);
      partPath = undefined;
      Logger.info(`文件已下载: ${fileName} -> ${localPath} (${buffer.length} bytes)`);
      return localPath;
    } catch (err: any) {
      if (partPath) {
        try {
          fs.unlinkSync(partPath);
        } catch {
          // ignore partial cleanup failure
        }
      }
      Logger.error(`文件下载失败: ${err.message}`);
      return null;
    }
  }
}

function buildClientMessageID(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `catsco-${Date.now()}-${random}`;
}


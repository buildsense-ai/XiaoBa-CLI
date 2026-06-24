import * as fs from 'fs';
import * as path from 'path';
import { ChatConfig, ChatResponse, ContentBlock, Message } from '../types';
import { ToolCall, ToolDefinition, ToolResult, ToolSurface } from '../types/tool';
import { Logger } from './logger';

const DEFAULT_TRACE_DIR = path.resolve('logs', 'prompt-trace');
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /cats_svc_[A-Za-z0-9_-]+/g,
  /\b(?:Bearer|ApiKey|Token)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bAuthorization\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9+.-]*\s+)?[^\s,;'"`<>]+/gi,
  /(["']?)([A-Za-z0-9_.-]*(?:token|api[_-]?key|secret|password)[A-Za-z0-9_.-]*)\1\s*[:=]\s*["']?[^&\s,'"`<>}]+["']?/gi,
];

export interface PromptTraceLoggerOptions {
  sessionId?: string;
  surface?: ToolSurface;
  modelConfig?: Pick<ChatConfig, 'provider' | 'apiUrl' | 'model' | 'maxTokens' | 'contextWindowTokens'>;
  env?: NodeJS.ProcessEnv;
}

export class PromptTraceLogger {
  readonly enabled: boolean;
  readonly runId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionId?: string;
  private readonly surface?: ToolSurface;
  private readonly modelConfig?: PromptTraceLoggerOptions['modelConfig'];

  constructor(options: PromptTraceLoggerOptions = {}) {
    this.env = options.env ?? process.env;
    this.enabled = isPromptTraceEnabled(this.env);
    this.runId = createRunId();
    this.sessionId = options.sessionId;
    this.surface = options.surface;
    this.modelConfig = options.modelConfig;
  }

  recordRequest(turn: number, messages: Message[], tools: ToolDefinition[]): void {
    if (!this.enabled) return;

    this.append({
      entry_type: 'prompt_trace_request',
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      session_id: this.sessionId,
      surface: this.surface,
      turn,
      model: sanitizeModelConfig(this.modelConfig),
      tools: {
        count: tools.length,
        names: tools.map(tool => tool.name),
      },
      prompt: summarizePrompt(messages),
      messages: messages.map((message, index) => summarizeMessage(message, index, this.env)),
    });
  }

  recordResponse(turn: number, response: ChatResponse, durationMs: number): void {
    if (!this.enabled) return;

    this.append({
      entry_type: 'prompt_trace_response',
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      session_id: this.sessionId,
      surface: this.surface,
      turn,
      duration_ms: durationMs,
      usage: response.usage,
      stop_reason: response.stopReason,
      content_length: typeof response.content === 'string' ? response.content.length : 0,
      content_preview: preview(response.content || '', responsePreviewLimit(this.env)),
      tool_calls: summarizeToolCalls(response.toolCalls || [], this.env),
    });
  }

  recordToolResult(
    turn: number,
    toolCall: ToolCall,
    result: ToolResult,
    durationMs: number,
  ): void {
    if (!this.enabled) return;

    const resultText = contentToString(result.content);
    this.append({
      entry_type: 'prompt_trace_tool_result',
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      session_id: this.sessionId,
      surface: this.surface,
      turn,
      duration_ms: durationMs,
      tool_call: summarizeToolCall(toolCall, this.env),
      result: {
        ok: result.ok,
        error_code: result.errorCode,
        retryable: result.retryable,
        control_signal: result.controlSignal,
        content_length: resultText.length,
        content_preview: preview(resultText, toolResultPreviewLimit(this.env)),
      },
    });
  }

  recordError(turn: number, error: unknown): void {
    if (!this.enabled) return;

    this.append({
      entry_type: 'prompt_trace_error',
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      session_id: this.sessionId,
      surface: this.surface,
      turn,
      error: preview(String((error as any)?.message || error || 'Unknown error'), 800),
    });
  }

  private append(entry: Record<string, unknown>): void {
    try {
      const filePath = this.resolveFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (error: any) {
      Logger.warning(`[PromptTrace] write failed: ${error?.message || error}`);
    }
  }

  private resolveFilePath(): string {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const root = this.env.XIAOBA_PROMPT_TRACE_DIR?.trim()
      ? path.resolve(this.env.XIAOBA_PROMPT_TRACE_DIR)
      : DEFAULT_TRACE_DIR;
    const safeSession = sanitizeFileSegment(this.sessionId || 'unknown');
    return path.join(root, dateStr, `${safeSession}.jsonl`);
  }
}

export function isPromptTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.XIAOBA_PROMPT_TRACE || '');
}

function summarizePrompt(messages: Message[]): Record<string, unknown> {
  const systemMessages = messages.filter(message => message.role === 'system');
  const transientMessages = messages.filter(message => {
    const content = contentToString(message.content);
    return message.__injected || content.startsWith('[transient_');
  });
  const prefixes = transientMessages
    .map(message => detectPrefix(contentToString(message.content)))
    .filter((prefix): prefix is string => Boolean(prefix));
  const prefixCounts: Record<string, number> = {};
  for (const prefix of prefixes) {
    prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
  }

  const systemText = systemMessages.map(message => contentToString(message.content)).join('\n');

  return {
    message_count: messages.length,
    system_message_count: systemMessages.length,
    system_chars: systemText.length,
    system_modes: [...systemText.matchAll(/\[mode:([^\]]+)\]/g)].map(match => match[1]),
    transient_count: transientMessages.length,
    transient_chars: transientMessages.reduce((sum, message) => sum + contentToString(message.content).length, 0),
    transient_prefixes: prefixCounts,
  };
}

function summarizeMessage(message: Message, index: number, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const content = contentToString(message.content);
  const prefix = detectPrefix(content);
  const isTransient = Boolean(message.__injected || content.startsWith('[transient_'));
  const includePreview = isTransient
    || message.role === 'user'
    || /^(1|true|yes|on)$/i.test(env.XIAOBA_PROMPT_TRACE_CONTENT || '');

  return {
    index,
    role: message.role,
    name: message.name,
    tool_call_id: message.tool_call_id,
    prefix,
    injected: message.__injected || undefined,
    runtime_feedback: message.__runtimeFeedback || undefined,
    runtime_observation: message.__runtimeObservation || undefined,
    content_length: content.length,
    content_preview: includePreview ? preview(content, messagePreviewLimit(env, isTransient)) : undefined,
    tool_calls: message.tool_calls ? summarizeToolCalls(message.tool_calls, env) : undefined,
  };
}

function summarizeToolCalls(toolCalls: ToolCall[], env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  return toolCalls.map(toolCall => summarizeToolCall(toolCall, env));
}

function summarizeToolCall(toolCall: ToolCall, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const args = toolCall.function.arguments || '';
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments_length: args.length,
    arguments_preview: preview(args, toolArgumentPreviewLimit(env)),
  };
}

function sanitizeModelConfig(config?: PromptTraceLoggerOptions['modelConfig']): Record<string, unknown> {
  if (!config) return {};
  return {
    provider: config.provider,
    model: config.model,
    api_url: sanitizeApiUrl(config.apiUrl),
    max_tokens: config.maxTokens,
    context_window_tokens: config.contextWindowTokens,
  };
}

function sanitizeApiUrl(apiUrl?: string): string | undefined {
  if (!apiUrl) return undefined;
  try {
    const parsed = new URL(apiUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return preview(apiUrl, 160);
  }
}

function contentToString(content: string | ContentBlock[] | null | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => block.type === 'text' ? block.text : '[图片]')
    .join('');
}

function detectPrefix(content: string): string | undefined {
  const match = content.match(/^\[[^\]\n]{1,80}\]/);
  return match?.[0];
}

function preview(text: string, maxChars: number): string {
  const sanitized = sanitizeSecrets(text).replace(/\s+/g, ' ').trim();
  if (sanitized.length <= maxChars) return sanitized;
  return `${sanitized.slice(0, maxChars)}... [truncated ${sanitized.length - maxChars} chars]`;
}

function sanitizeSecrets(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, match => {
      const token = match.split(/\s+/)[0];
      return token && /^(Bearer|ApiKey|Token)$/i.test(token)
        ? `${token} [redacted-token]`
        : '[redacted-secret]';
    });
  }
  return sanitized;
}

function messagePreviewLimit(env: NodeJS.ProcessEnv, isTransient: boolean): number {
  return parsePositiveInt(env.XIAOBA_PROMPT_TRACE_MESSAGE_CHARS)
    ?? (isTransient ? 900 : 240);
}

function responsePreviewLimit(env: NodeJS.ProcessEnv): number {
  return parsePositiveInt(env.XIAOBA_PROMPT_TRACE_RESPONSE_CHARS) ?? 500;
}

function toolArgumentPreviewLimit(env: NodeJS.ProcessEnv): number {
  return parsePositiveInt(env.XIAOBA_PROMPT_TRACE_ARGUMENT_CHARS) ?? 300;
}

function toolResultPreviewLimit(env: NodeJS.ProcessEnv): number {
  return parsePositiveInt(env.XIAOBA_PROMPT_TRACE_TOOL_RESULT_CHARS) ?? 500;
}

function parsePositiveInt(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[:<>"|?*\\\/]/g, '_').slice(0, 120) || 'unknown';
}

function createRunId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${random}`;
}

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ContentBlock, Message } from '../types';
import type {
  ModelAttemptEvent,
  ModelAttemptSink,
} from '../providers/provider';
import type { ToolDefinition, ToolSurface } from '../types/tool';
import { estimateMessagesTokens, estimateToolsTokens } from '../core/token-estimator';
import { PathResolver } from '../utils/path-resolver';
import {
  classifyProviderErrorForLog,
  sanitizeProviderErrorMessageForLog,
} from '../utils/provider-error-log-sanitizer';

export const CACHE_TRACE_SCHEMA = 'xiaoba.cache_trace.v4';

export type CacheTraceApiType = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';

export interface CacheTraceEntryV4 {
  schema: typeof CACHE_TRACE_SCHEMA;
  session: {
    session_id: string;
    session_type: string;
    surface: string;
  };
  episode: {
    episode_number: number;
    run_id: string;
    episode_id?: string;
  };
  lifecycle: {
    call_id: string;
    attempt_id: string;
    attempt_number: number;
    outcome: ModelAttemptEvent['outcome'];
    event_timestamp: string;
    duration_ms?: number;
    retry_number?: number;
    max_retries?: number;
    retry_delay_ms?: number;
    retry_elapsed_ms?: number;
    retry_max_elapsed_ms?: number;
    retry_stop_reason?: string;
  };
  request: {
    timestamp: string;
    provider: string;
    model: string;
    api_type: CacheTraceApiType;
    cache_strategy: 'anthropic-explicit-prefix' | 'openai-automatic-prefix' | 'openai-prompt-cache-key';
    system_prompt: {
      stable_sha256: string;
      stable_blocks: number;
      stable_chars: number;
      dynamic_sha256: string;
      dynamic_blocks: number;
      dynamic_chars: number;
    };
    message_count: number;
    message_sha256s: string[];
    message_roles: Message['role'][];
    estimated_tokens: number;
    tools_count: number;
    tools_sha256: string;
    request_sha256: string;
    preflight?: {
      repaired: true;
      issue_codes: string[];
      dropped_messages: number;
      dropped_tool_calls: number;
      dropped_tool_results: number;
      provider_replay_fallbacks: number;
    };
    request_snapshot?: {
      kind: 'wire-input';
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
  };
  response?: {
    timestamp: string;
    duration_ms: number;
    stop_reason?: string;
  };
  response_usage?: {
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    fresh_input_tokens: number;
    output_tokens: number;
    cache_hit_ratio: number;
    cache_write_ratio: number;
  };
  failure?: {
    category: string;
    summary: string;
    http_status?: number;
    code?: string;
    type?: string;
  };
}

export interface CacheTraceSink extends ModelAttemptSink {}

export interface CacheTraceObserverOptions {
  sessionId?: string;
  sessionType?: string;
  surface?: ToolSurface | string;
  episodeId?: string;
  env?: NodeJS.ProcessEnv;
  traceDir?: string;
  onError?: (error: unknown) => void;
  writeEntry?: (filePath: string, entry: CacheTraceEntryV4) => Promise<void>;
}

/**
 * Best-effort dev sidecar for exact provider-attempt lifecycles.
 *
 * Each attempt owns one JSONL file. The first line records started and the
 * second records its terminal outcome. A process crash can therefore be seen
 * as an incomplete started attempt instead of silently losing the request.
 */
export class CacheTraceObserver implements CacheTraceSink {
  readonly enabled: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionId: string;
  private readonly sessionType: string;
  private readonly surface: string;
  private readonly episodeId?: string;
  private readonly traceDir?: string;
  private readonly onError?: (error: unknown) => void;
  private readonly writeEntry: (filePath: string, entry: CacheTraceEntryV4) => Promise<void>;
  private readonly fileByAttemptId = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: CacheTraceObserverOptions = {}) {
    this.env = options.env ?? process.env;
    this.sessionId = options.sessionId || 'unknown';
    this.enabled = isCacheTraceEnabledForSession(this.sessionId, this.env);
    this.sessionType = options.sessionType || inferSessionType(this.sessionId);
    this.surface = String(options.surface || 'unknown');
    this.episodeId = options.episodeId;
    this.traceDir = options.traceDir;
    this.onError = options.onError;
    this.writeEntry = options.writeEntry ?? appendEntry;
  }

  observe(event: ModelAttemptEvent): void {
    if (!this.enabled) return;

    try {
      const entry = this.buildEntry(event);
      const filePath = this.fileByAttemptId.get(event.attemptId) || this.resolveFilePath(entry);
      if (event.outcome === 'started') this.fileByAttemptId.set(event.attemptId, filePath);
      else this.fileByAttemptId.delete(event.attemptId);
      this.writeChain = this.writeChain
        .then(() => this.writeEntry(filePath, entry))
        .catch(error => {
          this.reportError(error);
        });
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Test and shutdown seam. ConversationRunner never awaits this. */
  async drain(): Promise<void> {
    try {
      await this.writeChain;
    } catch (error) {
      this.reportError(error);
    }
  }

  private buildEntry(event: ModelAttemptEvent): CacheTraceEntryV4 {
    const system = summarizeSystemPrompt(event.request.messages as Message[]);
    const messageSha256s = event.request.messages.map(message => hashMessage(message));
    const toolsCanonical = event.request.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const toolsSha256 = sha256(stableSerialize(toolsCanonical));
    const requestSha256 = sha256(stableSerialize({
      provider: event.provider,
      model: event.model,
      apiType: event.apiType,
      system,
      messageSha256s,
      toolsSha256,
    }));
    const usage = event.response?.usage;
    const inputTokens = finiteNonNegative(usage?.promptTokens);
    const cacheReadTokens = finiteNonNegative(usage?.cachedReadTokens);
    const cacheWriteTokens = finiteNonNegative(usage?.cachedWriteTokens);
    const outputTokens = finiteNonNegative(usage?.completionTokens);
    const freshInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    const includeContent = event.outcome === 'started'
      && /^(1|true|yes|on)$/i.test(this.env.XIAOBA_CACHE_TRACE_CONTENT || '');
    const retry = event.retry;
    const context = event.context;
    const episodeNumber = finiteInteger(context?.episodeNumber);
    const failure = event.error === undefined ? undefined : summarizeFailure(event.error);

    return {
      schema: CACHE_TRACE_SCHEMA,
      session: {
        session_id: context?.sessionId || this.sessionId,
        session_type: context?.sessionType || this.sessionType,
        surface: context?.surface || this.surface,
      },
      episode: {
        episode_number: episodeNumber,
        run_id: event.callId,
        ...((context?.episodeId || this.episodeId) ? { episode_id: context?.episodeId || this.episodeId } : {}),
      },
      lifecycle: {
        call_id: event.callId,
        attempt_id: event.attemptId,
        attempt_number: event.attemptNumber,
        outcome: event.outcome,
        event_timestamp: event.timestamp,
        ...(event.durationMs === undefined ? {} : { duration_ms: finiteNonNegative(event.durationMs) }),
        ...(retry ? {
          retry_number: retry.retryNumber,
          max_retries: retry.maxRetries,
          ...(retry.delayMs === undefined ? {} : { retry_delay_ms: retry.delayMs }),
          retry_elapsed_ms: retry.elapsedMs,
          retry_max_elapsed_ms: retry.maxElapsedMs,
          ...(retry.stopReason ? { retry_stop_reason: retry.stopReason } : {}),
        } : {}),
      },
      request: {
        timestamp: event.timestamp,
        provider: event.provider,
        model: event.model,
        api_type: event.apiType,
        cache_strategy: resolveCacheStrategy(event.apiType),
        system_prompt: system,
        message_count: event.request.messages.length,
        message_sha256s: messageSha256s,
        message_roles: event.request.messages.map(message => message.role),
        estimated_tokens: estimateMessagesTokens(event.request.messages as Message[])
          + estimateToolsTokens(event.request.tools as ToolDefinition[]),
        tools_count: event.request.tools.length,
        tools_sha256: toolsSha256,
        request_sha256: requestSha256,
        ...(event.request.preflight ? {
          preflight: {
            repaired: true as const,
            issue_codes: [...event.request.preflight.issueCodes],
            dropped_messages: event.request.preflight.droppedMessages,
            dropped_tool_calls: event.request.preflight.droppedToolCalls,
            dropped_tool_results: event.request.preflight.droppedToolResults,
            provider_replay_fallbacks: event.request.preflight.providerReplayFallbacks,
          },
        } : {}),
        ...(includeContent ? {
          request_snapshot: {
            kind: 'wire-input' as const,
            messages: event.request.messages.map(snapshotMessage),
            tools: toolsCanonical.map(tool => sanitizeForSnapshot(tool) as Record<string, unknown>),
          },
        } : {}),
      },
      ...(event.outcome === 'started' ? {} : {
        response: {
          timestamp: event.timestamp,
          duration_ms: finiteNonNegative(event.durationMs),
          ...(event.response?.stopReason ? { stop_reason: event.response.stopReason } : {}),
        },
        response_usage: {
          input_tokens: inputTokens,
          cache_read_tokens: cacheReadTokens,
          cache_write_tokens: cacheWriteTokens,
          fresh_input_tokens: freshInputTokens,
          output_tokens: outputTokens,
          cache_hit_ratio: ratio(cacheReadTokens, inputTokens),
          cache_write_ratio: ratio(cacheWriteTokens, inputTokens),
        },
      }),
      ...(failure ? { failure } : {}),
    };
  }

  private resolveFilePath(entry: CacheTraceEntryV4): string {
    const root = this.traceDir
      || String(this.env.XIAOBA_CACHE_TRACE_DIR || '').trim()
      || path.join(PathResolver.getRuntimeDataRoot(this.env), 'logs', 'cache-trace');
    const timestamp = new Date(entry.lifecycle.event_timestamp);
    const date = Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
    const dateSegment = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const safeSession = sanitizeFileSegment(entry.session.session_id);
    const episode = String(entry.episode.episode_number).padStart(3, '0');
    const attempt = String(entry.lifecycle.attempt_number).padStart(3, '0');
    const call = sanitizeFileSegment(entry.lifecycle.call_id);
    return path.join(path.resolve(root), dateSegment, safeSession, `E${episode}_${call}_A${attempt}.jsonl`);
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics about diagnostics are deliberately discarded.
    }
  }
}

export function isCacheTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.XIAOBA_CACHE_TRACE || '');
}

export function isCacheTraceEnabledForSession(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isCacheTraceEnabled(env)) return false;
  const sessions = String(env.XIAOBA_CACHE_TRACE_SESSIONS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return sessions.length === 0 || sessions.includes(sessionId || 'unknown');
}

export function resolveCacheTraceDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.XIAOBA_CACHE_TRACE_DIR || '').trim();
  return path.resolve(explicit || path.join(PathResolver.getRuntimeDataRoot(env), 'logs', 'cache-trace'));
}

function summarizeSystemPrompt(messages: readonly Message[]): CacheTraceEntryV4['request']['system_prompt'] {
  const stable: string[] = [];
  const dynamic: string[] = [];

  for (const message of messages) {
    if (message.role !== 'system') continue;
    const text = contentToString(message.content);
    if (!text) continue;
    if (isDynamicSystemMessage(message, text)) dynamic.push(text);
    else stable.push(text);
  }

  const stableText = stable.join('\n\n');
  const dynamicText = dynamic.join('\n\n');
  return {
    stable_sha256: sha256(stableText),
    stable_blocks: stable.length,
    stable_chars: stable.reduce((sum, value) => sum + value.length, 0),
    dynamic_sha256: sha256(dynamicText),
    dynamic_blocks: dynamic.length,
    dynamic_chars: dynamic.reduce((sum, value) => sum + value.length, 0),
  };
}

function isDynamicSystemMessage(message: Message, text: string): boolean {
  if (message.__cacheScope === 'dynamic') return true;
  if (message.__cacheScope === 'stable') return false;
  return /^\[(?:transient_[^\]]+|compact_boundary)\]/.test(text);
}

function resolveCacheStrategy(apiType: CacheTraceApiType): CacheTraceEntryV4['request']['cache_strategy'] {
  if (apiType === 'anthropic-messages') return 'anthropic-explicit-prefix';
  if (apiType === 'openai-responses') return 'openai-prompt-cache-key';
  return 'openai-automatic-prefix';
}

function hashMessage(message: Message): string {
  return sha256(stableSerialize({
    role: message.role,
    content: contentToHashable(message.content),
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
    cache_scope: message.__cacheScope,
    provider_content: message.providerContent,
  }));
}

function snapshotMessage(message: Message): Record<string, unknown> {
  return sanitizeForSnapshot({
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
    cache_scope: message.__cacheScope,
  }) as Record<string, unknown>;
}

function sanitizeForSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map(item => sanitizeForSnapshot(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:authorization|api[_-]?key|token|secret|password)$/i.test(key)) {
      output[key] = '[redacted-secret]';
    } else {
      output[key] = sanitizeForSnapshot(item, seen);
    }
  }
  return output;
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-secret]')
    .replace(/cats_svc_[A-Za-z0-9_-]+/g, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted-token]');
}

function contentToHashable(content: Message['content']): unknown {
  if (!Array.isArray(content)) return content ?? '';
  return content.map(block => block.type === 'text'
    ? { type: 'text', text: block.text }
    : {
      type: 'image',
      media_type: block.source.media_type,
      bytes_sha256: sha256(block.source.data),
      bytes_chars: block.source.data.length,
    });
}

function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map(block => block.type === 'text' ? block.text : '[image]').join('');
}

function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === 'number' || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current !== 'object') return String(current);
    if (seen.has(current as object)) return '[circular]';
    seen.add(current as object);
    if (Array.isArray(current)) return current.map(visit);
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, visit(item)]),
    );
  };
  return JSON.stringify(visit(value));
}

function summarizeFailure(error: unknown): NonNullable<CacheTraceEntryV4['failure']> {
  const raw = error as any;
  const status = finiteInteger(raw?.response?.status ?? raw?.status ?? raw?.statusCode);
  const code = text(raw?.response?.data?.error?.code ?? raw?.error?.code ?? raw?.code);
  const type = text(raw?.response?.data?.error?.type ?? raw?.error?.type ?? raw?.type);
  return {
    category: classifyProviderErrorForLog(error),
    summary: sanitizeProviderErrorMessageForLog(
      raw?.response?.data?.error?.message
      ?? raw?.response?.data?.message
      ?? raw?.error?.message
      ?? error,
    ),
    ...(status > 0 ? { http_status: status } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finiteInteger(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim().slice(0, 160);
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[:<>"|?*\\/]/g, '_').slice(0, 160) || 'unknown';
}

function inferSessionType(sessionId: string): string {
  if (sessionId.startsWith('subagent:')) return 'subagent';
  if (sessionId.startsWith('branch:')) return 'branch';
  return 'agent';
}

async function appendEntry(filePath: string, entry: CacheTraceEntryV4): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

import { Message, ChatResponse } from '../types';
import { ToolDefinition } from '../types/tool';
import type { ProviderRequestPreflightSummary } from './request-preflight';

/**
 * Streaming 回调
 */
export interface StreamCallbacks {
  /** 收到文本片段 */
  onText?: (text: string) => void;
  /** 收到完整响应 */
  onComplete?: (response: ChatResponse) => void;
  /** 发生错误 */
  onError?: (error: Error) => void;
  /** 重试通知 */
  onRetry?: (attempt: number, maxRetries: number, info?: StreamRetryInfo) => void | Promise<void>;
}

export interface StreamRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  elapsedMs: number;
  maxElapsedMs: number;
  status?: string | number;
  message?: string;
}

export type ModelAttemptApiType = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';
export type ModelAttemptOutcome = 'started' | 'succeeded' | 'retrying' | 'failed' | 'cancelled';
export type ModelAttemptStopReason =
  | 'non_retryable'
  | 'retry_limit_exhausted'
  | 'retry_window_exhausted'
  | 'stream_output_started'
  | 'aborted';

export interface ModelAttemptContext {
  sessionId?: string;
  sessionType?: string;
  surface?: string;
  episodeId?: string;
  episodeNumber?: number;
}

export interface ModelAttemptRetry {
  retryNumber: number;
  maxRetries: number;
  elapsedMs: number;
  maxElapsedMs: number;
  delayMs?: number;
  stopReason?: ModelAttemptStopReason;
}

/**
 * One event in the lifecycle of an actual provider invocation.
 *
 * A started event is followed by exactly one terminal event for the same
 * attemptId: succeeded, retrying, failed, or cancelled. Request values are
 * live in-memory references; sinks that persist them must snapshot and redact
 * synchronously inside observe().
 */
export interface ModelAttemptEvent {
  schema: 'xiaoba.model_attempt.v1';
  callId: string;
  attemptId: string;
  attemptNumber: number;
  timestamp: string;
  outcome: ModelAttemptOutcome;
  provider: 'openai' | 'anthropic';
  model: string;
  apiType: ModelAttemptApiType;
  stream: boolean;
  context?: ModelAttemptContext;
  request: {
    messages: readonly Message[];
    tools: readonly ToolDefinition[];
    preflight?: ProviderRequestPreflightSummary;
  };
  durationMs?: number;
  response?: ChatResponse;
  error?: unknown;
  retry?: ModelAttemptRetry;
}

export interface ModelAttemptSink {
  observe(event: ModelAttemptEvent): void | Promise<void>;
}

export interface AIRequestOptions {
  signal?: AbortSignal;
  /** Optional best-effort observer; it can never alter request control flow. */
  modelAttemptSink?: ModelAttemptSink;
  modelAttemptContext?: ModelAttemptContext;
  promptCacheContext?: PromptCacheContext;
}

export interface PromptCacheContext {
  sessionKey: string;
  currentEpisodeId?: string;
  phase: 'normal' | 'pre_turn' | 'mid_turn' | 'restore';
  explicitCaching: boolean;
}

/**
 * AI Provider 统一接口
 * 抽象不同 AI 服务商的调用差异
 */
export interface AIProvider {
  /** 普通（非流式）调用 */
  chat(messages: Message[], tools?: ToolDefinition[], options?: AIRequestOptions): Promise<ChatResponse>;
  /** 流式调用 */
  chatStream(messages: Message[], tools?: ToolDefinition[], callbacks?: StreamCallbacks, options?: AIRequestOptions): Promise<ChatResponse>;
}

import { Message, ChatResponse } from '../types';
import { ToolDefinition } from '../types/tool';
import type { ProviderRequestPreflightSummary } from './request-preflight';
import type { OpenAIReasoningReplayMode } from '../utils/reasoning-effort';
import type { ReasoningReplayRecoveryAction } from './deepseek-reasoning-recovery';
import type { ProviderCachePlanSummary } from './provider-cache-policy';
import type { ProviderCacheMode } from './provider-cache-policy';
import type { ContextLifecycleSummary } from '../core/context-lifecycle';

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
  recoveryAction?: ReasoningReplayRecoveryAction;
}

export type ModelAttemptApiType = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';
export type ModelAttemptOutcome = 'started' | 'succeeded' | 'retrying' | 'failed' | 'cancelled';
export type ModelAttemptStopReason =
  | 'non_retryable'
  | 'retry_limit_exhausted'
  | 'retry_window_exhausted'
  | 'stream_output_started'
  | 'aborted';

/** Semantic purpose of one physical provider request. */
export type ModelRequestKind =
  | 'main_inference'
  | 'checkpoint_compaction'
  | 'memory_branch_inference'
  | 'subagent_inference';

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
  recoveryAction?: ReasoningReplayRecoveryAction;
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
  requestKind: ModelRequestKind;
  context?: ModelAttemptContext;
  request: {
    messages: readonly Message[];
    tools: readonly ToolDefinition[];
    preflight?: ProviderRequestPreflightSummary;
    cache?: ProviderCachePlanSummary;
    contextLifecycle?: ContextLifecycleSummary;
  };
  durationMs?: number;
  response?: ChatResponse;
  error?: unknown;
  retry?: ModelAttemptRetry;
}

export interface ModelAttemptSink {
  /** Critical sinks are synchronous and may abort a provider request on persistence failure. */
  critical?: boolean;
  observe(event: ModelAttemptEvent): void | Promise<void>;
}

export interface AIRequestOptions {
  signal?: AbortSignal;
  /** Semantic purpose of this physical provider request. */
  requestKind?: ModelRequestKind;
  /** Bypass provider cache routing and explicit markers for one-off internal calls. */
  cacheMode?: ProviderCacheMode;
  /** Stable, non-secret identity used to shard provider cache routing keys. */
  cachePartitionKey?: string;
  /** Internal one-attempt override used by evidence-driven DeepSeek recovery. */
  reasoningReplayMode?: OpenAIReasoningReplayMode;
  /** Attempt observer; only an explicitly critical synchronous sink may abort before invocation. */
  modelAttemptSink?: ModelAttemptSink;
  modelAttemptContext?: ModelAttemptContext;
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

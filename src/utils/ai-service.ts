import { Message, ChatConfig, ChatResponse } from '../types';
import { ConfigManager } from './config';
import { ToolDefinition } from '../types/tool';
import {
  AIProvider,
  AIRequestOptions,
  ModelAttemptEvent,
  ModelAttemptSink,
  ModelAttemptStopReason,
  StreamCallbacks,
  StreamRetryInfo,
} from '../providers/provider';
import { AnthropicProvider } from '../providers/anthropic-provider';
import { OpenAIProvider } from '../providers/openai-provider';
import {
  prepareProviderRequestMessages,
  type ProviderRequestPreflightSummary,
} from '../providers/request-preflight';
import { Logger } from './logger';
import { isPrimaryModelToolCallingCapable } from './model-capabilities';
import { resolveModelContextWindow } from './model-context-window';
import {
  attachModelErrorDiagnostics,
  attachRetrySummary,
  captureModelErrorDiagnostics,
} from './model-error-observability';

/**
 * AI 服务 - 统一的 AI 调用入口
 * 内部委托给对应的 Provider 实现
 */
/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 520, 524, 529]);
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const DEFAULT_MAX_RETRY_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 14;
const MAX_CONFIGURABLE_RETRY_DURATION_MS = 10 * 60 * 1000;
const MAX_CONFIGURABLE_RETRIES = 30;
const SHORT_NETWORK_RETRY_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED']);
const SHORT_NETWORK_MAX_RETRIES = 3;
const SHORT_NETWORK_MAX_ELAPSED_MS = 30 * 1000;
const SHORT_NETWORK_MAX_DELAY_MS = 5000;
const EMPTY_RESPONSE_ERROR_CODE = 'EMPTY_MODEL_RESPONSE';
const EMPTY_RESPONSE_MAX_RETRIES = 2;
const EMPTY_RESPONSE_MAX_ELAPSED_MS = 2 * 60 * 1000;
const EMPTY_RESPONSE_MAX_DELAY_MS = 2000;
const TRANSIENT_PROVIDER_CODES = new Set([
  'internal_error',
  'internal_server_error',
  'stream_read_error',
  'upstream_error',
  'server_is_overloaded',
  'service_unavailable_error',
]);
const RESPONSES_TRANSIENT_MAX_RETRIES = 2;
const TRANSIENT_HTTP_MAX_RETRIES = 2;
const GATEWAY_TIMEOUT_MAX_RETRIES = 1;
const CHECKPOINT_SUMMARY_MAX_RETRIES = 3;
const CHECKPOINT_SUMMARY_GUARANTEED_RETRIES = 1;
let modelAttemptCallSequence = 0;

type ProviderKind = 'openai' | 'anthropic';

interface RetryPolicy {
  maxRetries: number;
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  guaranteedRetries: number;
}

interface ModelAttemptRun {
  callId: string;
  sink?: ModelAttemptSink;
  context?: AIRequestOptions['modelAttemptContext'];
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  stream: boolean;
  preflight?: ProviderRequestPreflightSummary;
}

export class AIService {
  private config: ChatConfig;
  private provider: AIProvider;

  constructor(overrides?: Partial<ChatConfig>) {
    this.config = this.withResolvedContextWindow(this.withResolvedProvider({
      ...ConfigManager.getConfig(),
      ...(overrides || {})
    }));
    this.provider = this.createProvider(this.config);
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  /**
   * 根据配置创建对应的 Provider
   */
  private createProvider(config: ChatConfig): AIProvider {
    if (config.provider === 'anthropic') {
      return new AnthropicProvider(config);
    } else {
      return new OpenAIProvider(config);
    }
  }

  isToolCallingSupported(): boolean {
    return isPrimaryModelToolCallingCapable(this.config);
  }

  /**
   * 自动补全 provider
   */
  private withResolvedProvider(config: ChatConfig): ChatConfig {
    return {
      ...config,
      provider: this.resolveProvider(config),
    };
  }

  private withResolvedContextWindow(config: ChatConfig): ChatConfig {
    const contextWindowTokens = config.contextWindowTokens
      ?? resolveModelContextWindow(config).contextWindowTokens;
    return {
      ...config,
      contextWindowTokens,
    };
  }

  private resolveProvider(config: Partial<ChatConfig>): ProviderKind {
    if (config.provider === 'openai' || config.provider === 'anthropic') {
      return config.provider;
    }

    const apiUrl = (config.apiUrl || '').toLowerCase();
    const model = (config.model || '').toLowerCase();

    if (apiUrl.includes('anthropic') || apiUrl.includes('claude') || model.includes('claude')) {
      return 'anthropic';
    }

    return 'openai';
  }

  /**
   * 普通调用（非流式），带自动重试
   */
  async chat(messages: Message[], tools?: ToolDefinition[], options: AIRequestOptions = {}): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error('API密钥未配置。请先运行: catsco config');
    }

    const prepared = this.prepareProviderRequest(messages);
    try {
      return await this.withRetry(
        async () => this.requireUsableResponse(await this.provider.chat(prepared.messages, tools, options)),
        undefined,
        options.signal,
        undefined,
        this.createModelAttemptRun(prepared.messages, tools, false, options, prepared.summary),
        options.retryProfile,
      );
    } catch (error: any) {
      throw this.wrapError(error);
    }
  }

  /**
   * 流式调用。
   * 默认只在没有任何文本输出前重试，避免用户看到重复片段。
   * 如需强制开启完整流式重试，可设置 GAUZ_STREAM_RETRY=true（需自行保证幂等）。
   */
  async chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    callbacks?: StreamCallbacks,
    options: AIRequestOptions = {},
  ): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error('API密钥未配置。请先运行: catsco config');
    }

    const allowStreamRetry = process.env.GAUZ_STREAM_RETRY === 'true';
    const prepared = this.prepareProviderRequest(messages);
    const supportsBufferedRecovery = this.isResponsesMode();
    const streamOutputMode = supportsBufferedRecovery
      ? options.streamOutputMode ?? (callbacks?.onText ? 'live' : 'buffered')
      : 'live';
    let hasObservedText = false;
    let hasDeliveredText = false;

    try {
      const result = await this.withRetry(
        async () => {
          const bufferedChunks: string[] = [];
          const providerCallbacks = this.createProviderStreamCallbacks(text => {
            hasObservedText = true;
            if (streamOutputMode === 'buffered') {
              bufferedChunks.push(text);
              return;
            }
            if (callbacks?.onText) {
              callbacks.onText(text);
              hasDeliveredText = true;
            }
          });
          const response = this.requireUsableResponse(
            await this.provider.chatStream(prepared.messages, tools, providerCallbacks, options),
          );
          if (streamOutputMode === 'buffered' && bufferedChunks.length > 0) {
            callbacks?.onText?.(bufferedChunks.join(''));
          }
          return response;
        },
        callbacks,
        options.signal,
        () => allowStreamRetry || (supportsBufferedRecovery ? !hasDeliveredText : !hasObservedText),
        this.createModelAttemptRun(prepared.messages, tools, true, options, prepared.summary),
        options.retryProfile,
      );
      callbacks?.onComplete?.(result);
      return result;
    } catch (error: any) {
      const wrapped = this.wrapError(error);
      callbacks?.onError?.(wrapped);
      throw wrapped;
    }
  }

  private createProviderStreamCallbacks(onText?: (text: string) => void): StreamCallbacks | undefined {
    if (!onText) {
      return undefined;
    }

    return {
      onText: (text: string) => {
        if (text) onText(text);
      },
    };
  }

  private prepareProviderRequest(messages: Message[]): ReturnType<typeof prepareProviderRequestMessages> {
    const prepared = prepareProviderRequestMessages(messages);
    if (prepared.summary) {
      Logger.warning(
        `Provider request preflight repaired message structure: issues=${prepared.summary.issueCodes.join(',')}`
        + ` dropped_messages=${prepared.summary.droppedMessages}`
        + ` dropped_tool_calls=${prepared.summary.droppedToolCalls}`
        + ` dropped_tool_results=${prepared.summary.droppedToolResults}`
        + ` replay_fallbacks=${prepared.summary.providerReplayFallbacks}`,
      );
    }
    return prepared;
  }

  private requireUsableResponse(response: ChatResponse): ChatResponse {
    const content = typeof response?.content === 'string' ? response.content.trim() : '';
    if (content || (response?.toolCalls?.length ?? 0) > 0 || this.isTokenLimitResponse(response)) {
      return response;
    }

    const error = new Error('模型未返回有效内容（没有正文或工具调用）');
    error.name = 'EmptyModelResponseError';
    (error as Error & { code?: string }).code = EMPTY_RESPONSE_ERROR_CODE;
    throw error;
  }

  private isTokenLimitResponse(response: ChatResponse): boolean {
    const stopReason = String(response?.stopReason || '').toLowerCase();
    return stopReason === 'max_tokens'
      || stopReason === 'max_output_tokens'
      || stopReason === 'length';
  }

  /**
   * 统一错误处理
   */
  private wrapError(error: any): Error {
    if (this.isAbortError(error)) {
      return this.createAbortError();
    }

    const provider = this.config.provider;
    const model = this.config.model;

    Logger.error(
      `API调用失败 | Provider: ${provider} | Model: ${model}`
    );

    const status = this.extractStatus(error);
    const errorMessage = this.extractErrorMessage(error);
    const diagnostics = captureModelErrorDiagnostics(error, {
      provider,
      model,
      phase: 'model_request',
    });

    const wrapped = status
      ? new Error(`API错误 (${status}): ${errorMessage}`)
      : new Error(`请求失败: ${errorMessage}`);
    if (status) {
      (wrapped as Error & { status?: number }).status = status;
    }
    const code = this.extractErrorCode(error);
    if (code) {
      (wrapped as Error & { code?: string }).code = code;
    }
    try {
      Object.defineProperty(wrapped, 'cause', {
        value: error,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // Older runtimes may expose a non-configurable cause property.
    }
    attachModelErrorDiagnostics(wrapped, diagnostics);
    return wrapped;
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryable(error: any): boolean {
    if (this.isAbortError(error)) {
      return false;
    }

    if (this.isResponsesMode() && this.isSemanticTransientProviderError(error)) {
      return true;
    }

    if (this.isKnownNonRetryableProviderError(error)) {
      return false;
    }

    if (this.isEmptyModelResponseError(error)) {
      return true;
    }

    // HTTP 状态码可重试
    const status = this.extractStatus(error);
    if (status && RETRYABLE_STATUS_CODES.has(status)) {
      return true;
    }

    // 网络错误可重试
    const code = this.extractErrorCode(error);
    if ([
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNABORTED',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code)) {
      return true;
    }

    const message = String(error?.message || '');
    const hasRetryableStatusText =
      /(?:API错误|HTTP|status(?:\s*code)?|response status)\s*[\(:= ]\s*(?:408|429|500|502|503|504|520|524|529)\b/i.test(message)
      || /^\s*(?:408|429|500|502|503|504|520|524|529)\b/.test(message);
    if (
      hasRetryableStatusText
      || /timeout|timed out|socket hang up|network error|fetch failed|premature close|ECONNREFUSED|bad gateway|gateway timeout|service unavailable|unknown error,\s*520/i.test(message)
    ) {
      return true;
    }

    // Anthropic SDK overloaded_error
    if (error?.error?.type === 'overloaded_error') {
      return true;
    }

    return false;
  }

  private isKnownNonRetryableProviderError(error: any): boolean {
    const status = this.extractStatus(error);
    if (status && [400, 401, 403, 404, 413, 422].includes(status)) {
      return true;
    }

    const message = [
      error?.response?.data?.error?.code,
      error?.response?.data?.error?.type,
      error?.response?.data?.error?.message,
      error?.response?.data?.message,
      error?.error?.code,
      error?.error?.type,
      error?.error?.message,
      error?.message,
    ].filter(Boolean).join(' ');

    return /insufficient[_\s-]?quota|quota[_\s-]?exceeded|billing|(?:insufficient|low|exhausted)[_\s-]?(?:credit|balance)|(?:credit|balance)[_\s-]?(?:exhausted|insufficient|too low)|账户余额|余额不足|额度不足|额度已用尽|context length|maximum context|max(?:imum)? tokens?|prompt too long|invalid[_\s-]?request|invalid[_\s-]?api[_\s-]?key|unauthorized|forbidden|permission denied|model .*not found|model_not_found|tool schema|schema is invalid|content policy|safety/i
      .test(message);
  }

  private isSemanticTransientProviderError(error: any): boolean {
    return this.extractProviderSemanticCodes(error)
      .some(code => TRANSIENT_PROVIDER_CODES.has(code));
  }

  private extractProviderSemanticCodes(error: any): string[] {
    return [
      error?.providerCode,
      error?.providerType,
      error?.response?.data?.error?.code,
      error?.response?.data?.error?.type,
      error?.response?.data?.code,
      error?.response?.data?.type,
      error?.error?.code,
      error?.error?.type,
      error?.code,
      error?.type,
    ]
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => String(value).trim().toLowerCase());
  }

  /**
   * 从错误中提取 HTTP 状态码
   */
  private extractStatus(error: any): number | null {
    const status = error?.response?.status || error?.status;
    if (typeof status === 'number') {
      return status;
    }
    if (typeof status === 'string' && /^\d{3}$/.test(status.trim())) {
      const parsed = Number(status);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const text = String(error?.message || error || '');
    const match = text.match(/(?:API错误|HTTP|status(?:\s*code)?)\s*[\(:= ]\s*(\d{3})\b/i);
    if (match) {
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  /**
   * 从错误中提取 Retry-After 头（秒）
   */
  private getRetryAfter(error: any): number | null {
    const retryAfter = error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds;

      const dateMs = Date.parse(String(retryAfter));
      if (Number.isFinite(dateMs)) {
        return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
      }
    }
    return null;
  }

  /**
   * 带指数退避的重试包装器
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    callbacks?: StreamCallbacks,
    signal?: AbortSignal,
    shouldRetry?: (error: any, attempt: number) => boolean,
    attemptRun?: ModelAttemptRun,
    retryProfile?: AIRequestOptions['retryProfile'],
  ): Promise<T> {
    const startedAt = Date.now();

    for (let attempt = 0; ; attempt++) {
      this.throwIfAborted(signal);
      const attemptStartedAt = Date.now();
      const attemptNumber = attempt + 1;
      this.emitModelAttempt(attemptRun, attemptNumber, {
        outcome: 'started',
      });
      try {
        const result = await fn();
        this.emitModelAttempt(attemptRun, attemptNumber, {
          outcome: 'succeeded',
          durationMs: Date.now() - attemptStartedAt,
          response: result as ChatResponse,
        });
        return result;
      } catch (error: any) {
        if (this.isAbortError(error) || signal?.aborted) {
          const policy = this.resolveRetryPolicy(error, retryProfile);
          this.emitModelAttempt(attemptRun, attemptNumber, {
            outcome: 'cancelled',
            durationMs: Date.now() - attemptStartedAt,
            error,
            retry: {
              retryNumber: attempt,
              maxRetries: policy.maxRetries,
              elapsedMs: Date.now() - startedAt,
              maxElapsedMs: policy.maxElapsedMs,
              stopReason: 'aborted',
            },
          });
          throw this.createAbortError();
        }

        const policy = this.resolveRetryPolicy(error, retryProfile);
        const retryAttempt = attempt + 1;
        const elapsedMs = Date.now() - startedAt;
        const stopReason = this.resolveRetryStopReason(
          error,
          retryAttempt,
          policy,
          elapsedMs,
          shouldRetry,
        );
        if (stopReason) {
          attachRetrySummary(error, {
            attempt_count: attemptNumber,
            retry_count: attempt,
            max_retries: policy.maxRetries,
            elapsed_ms: elapsedMs,
            max_elapsed_ms: policy.maxElapsedMs,
            stop_reason: stopReason,
          }, {
            call_id: attemptRun?.callId,
            attempt_id: attemptRun ? `${attemptRun.callId}:${attemptNumber}` : undefined,
            attempt_number: attemptRun ? attemptNumber : undefined,
            episode_id: attemptRun?.context?.episodeId,
          });
          this.emitModelAttempt(attemptRun, attemptNumber, {
            outcome: 'failed',
            durationMs: Date.now() - attemptStartedAt,
            error,
            retry: {
              retryNumber: attempt,
              maxRetries: policy.maxRetries,
              elapsedMs,
              maxElapsedMs: policy.maxElapsedMs,
              stopReason,
            },
          });
          throw error;
        }

        // 计算等待时间：优先用 Retry-After，否则指数退避
        const delay = this.resolveRetryDelayMs(error, retryAttempt, policy, elapsedMs);
        this.emitModelAttempt(attemptRun, attemptNumber, {
          outcome: 'retrying',
          durationMs: Date.now() - attemptStartedAt,
          error,
          retry: {
            retryNumber: retryAttempt,
            maxRetries: policy.maxRetries,
            delayMs: delay,
            elapsedMs,
            maxElapsedMs: policy.maxElapsedMs,
          },
        });

        const status = this.extractStatus(error)
          || this.extractErrorCode(error)
          || this.extractProviderSemanticCodes(error)[0]
          || 'unknown';
        const retryInfo: StreamRetryInfo = {
          attempt: retryAttempt,
          maxRetries: policy.maxRetries,
          delayMs: delay,
          elapsedMs,
          maxElapsedMs: policy.maxElapsedMs,
          status,
          message: this.extractErrorMessage(error),
        };
        await this.notifyRetry(callbacks, retryAttempt, policy.maxRetries, retryInfo);

        Logger.warning(
          `API 调用失败 (${status})，${delay.toFixed(0)}ms 后重试 (${retryAttempt}/${policy.maxRetries})... `
          + `[${this.config.provider}/${this.config.model || 'default'}]`
        );

        await this.sleepWithAbort(delay, signal);
      }
    }
  }

  private resolveRetryStopReason(
    error: any,
    retryAttempt: number,
    policy: RetryPolicy,
    elapsedMs: number,
    shouldRetry?: (error: any, attempt: number) => boolean,
  ): ModelAttemptStopReason | undefined {
    if (!this.isRetryable(error)) return 'non_retryable';
    if (shouldRetry?.(error, retryAttempt) === false) return 'stream_output_started';
    if (retryAttempt > policy.maxRetries) return 'retry_limit_exhausted';
    if (elapsedMs >= policy.maxElapsedMs && retryAttempt > policy.guaranteedRetries) {
      return 'retry_window_exhausted';
    }
    return undefined;
  }

  private createModelAttemptRun(
    messages: readonly Message[],
    tools: readonly ToolDefinition[] | undefined,
    stream: boolean,
    options: AIRequestOptions,
    preflight?: ProviderRequestPreflightSummary,
  ): ModelAttemptRun | undefined {
    if (!options.modelAttemptSink) return undefined;
    modelAttemptCallSequence = (modelAttemptCallSequence + 1) % Number.MAX_SAFE_INTEGER;
    return {
      callId: `${Date.now().toString(36)}-${process.pid.toString(36)}-${modelAttemptCallSequence.toString(36)}`,
      sink: options.modelAttemptSink,
      context: options.modelAttemptContext ? { ...options.modelAttemptContext } : undefined,
      messages,
      tools: tools || [],
      stream,
      ...(preflight ? { preflight } : {}),
    };
  }

  private emitModelAttempt(
    run: ModelAttemptRun | undefined,
    attemptNumber: number,
    fields: Pick<ModelAttemptEvent, 'outcome'>
      & Partial<Pick<ModelAttemptEvent, 'durationMs' | 'response' | 'error' | 'retry'>>,
  ): void {
    if (!run?.sink) return;
    const event: ModelAttemptEvent = {
      schema: 'xiaoba.model_attempt.v1',
      callId: run.callId,
      attemptId: `${run.callId}:${attemptNumber}`,
      attemptNumber,
      timestamp: new Date().toISOString(),
      outcome: fields.outcome,
      provider: this.config.provider as ProviderKind,
      model: this.config.model || 'unknown',
      apiType: this.config.provider === 'anthropic'
        ? 'anthropic-messages'
        : this.config.openaiApiMode === 'responses'
          ? 'openai-responses'
          : 'openai-chat-completions',
      stream: run.stream,
      ...(run.context ? { context: run.context } : {}),
      request: {
        messages: run.messages,
        tools: run.tools,
        ...(run.preflight ? { preflight: run.preflight } : {}),
      },
      ...(fields.durationMs === undefined ? {} : { durationMs: fields.durationMs }),
      ...(fields.response === undefined ? {} : { response: fields.response }),
      ...(fields.error === undefined ? {} : { error: fields.error }),
      ...(fields.retry === undefined ? {} : { retry: fields.retry }),
    };

    try {
      const result = run.sink.observe(event);
      if (result && typeof (result as Promise<void>).then === 'function') {
        Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Diagnostics about diagnostics must never affect the provider request.
    }
  }

  private resolveRetryPolicy(
    error?: any,
    retryProfile?: AIRequestOptions['retryProfile'],
  ): RetryPolicy {
    const policy: RetryPolicy = {
      maxElapsedMs: this.readNumberEnv(
        ['CATSCO_MODEL_RETRY_MAX_MS', 'GAUZ_MODEL_RETRY_MAX_MS'],
        DEFAULT_MAX_RETRY_DURATION_MS,
        0,
        MAX_CONFIGURABLE_RETRY_DURATION_MS,
      ),
      maxRetries: this.readNumberEnv(
        ['CATSCO_MODEL_RETRY_MAX_RETRIES', 'GAUZ_MODEL_RETRY_MAX_RETRIES'],
        DEFAULT_MAX_RETRIES,
        0,
        MAX_CONFIGURABLE_RETRIES,
      ),
      maxDelayMs: this.readNumberEnv(
        ['CATSCO_MODEL_RETRY_MAX_DELAY_MS', 'GAUZ_MODEL_RETRY_MAX_DELAY_MS'],
        MAX_DELAY_MS,
        BASE_DELAY_MS,
        MAX_CONFIGURABLE_RETRY_DURATION_MS,
      ),
      baseDelayMs: BASE_DELAY_MS,
      guaranteedRetries: 0,
    };

    if (retryProfile === 'checkpoint_summary') {
      const maxRetries = Math.min(policy.maxRetries, CHECKPOINT_SUMMARY_MAX_RETRIES);
      return {
        ...policy,
        maxRetries,
        // A slow first stream may consume the ordinary elapsed-time window.
        // Checkpoints still receive one recovery attempt, while later retries
        // remain bounded by the shared wall-clock policy.
        guaranteedRetries: Math.min(maxRetries, CHECKPOINT_SUMMARY_GUARANTEED_RETRIES),
      };
    }

    if (this.isEmptyModelResponseError(error)) {
      return {
        ...policy,
        maxRetries: Math.min(policy.maxRetries, EMPTY_RESPONSE_MAX_RETRIES),
        maxElapsedMs: Math.min(policy.maxElapsedMs, EMPTY_RESPONSE_MAX_ELAPSED_MS),
        maxDelayMs: Math.min(policy.maxDelayMs, EMPTY_RESPONSE_MAX_DELAY_MS),
      };
    }

    if (this.isResponsesMode() && this.isGatewayTimeoutError(error)) {
      return {
        ...policy,
        maxRetries: Math.min(policy.maxRetries, GATEWAY_TIMEOUT_MAX_RETRIES),
        guaranteedRetries: Math.min(policy.maxRetries, GATEWAY_TIMEOUT_MAX_RETRIES),
      };
    }

    if (this.isResponsesMode() && this.isSemanticTransientProviderError(error)) {
      return {
        ...policy,
        maxRetries: Math.min(policy.maxRetries, RESPONSES_TRANSIENT_MAX_RETRIES),
      };
    }

    if (this.isResponsesMode() && [502, 503, 529].includes(this.extractStatus(error) ?? 0)) {
      return {
        ...policy,
        maxRetries: Math.min(policy.maxRetries, TRANSIENT_HTTP_MAX_RETRIES),
      };
    }

    if (!this.isShortNetworkRetryError(error)) {
      return policy;
    }

    return {
      ...policy,
      maxRetries: Math.min(policy.maxRetries, SHORT_NETWORK_MAX_RETRIES),
      maxElapsedMs: Math.min(policy.maxElapsedMs, SHORT_NETWORK_MAX_ELAPSED_MS),
      maxDelayMs: Math.min(policy.maxDelayMs, SHORT_NETWORK_MAX_DELAY_MS),
    };
  }

  private resolveRetryDelayMs(error: any, retryAttempt: number, policy: RetryPolicy, elapsedMs: number): number {
    const retryAfter = this.getRetryAfter(error);
    const rawDelay = retryAfter !== null
      ? retryAfter * 1000
      : Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, retryAttempt - 1)) + Math.random() * 500;
    const remainingMs = elapsedMs >= policy.maxElapsedMs && retryAttempt <= policy.guaranteedRetries
      ? policy.maxDelayMs
      : Math.max(0, policy.maxElapsedMs - elapsedMs);
    return Math.max(0, Math.min(rawDelay, remainingMs));
  }

  private readNumberEnv(names: string[], fallback: number, min: number, max: number): number {
    for (const name of names) {
      const raw = process.env[name];
      if (raw === undefined || raw.trim() === '') continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.min(max, Math.max(min, Math.floor(parsed)));
      }
    }
    return fallback;
  }

  private extractErrorMessage(error: any): string {
    return error?.response?.data?.error?.message
      || error?.response?.data?.message
      || error?.error?.message
      || error?.message
      || String(error);
  }

  private extractErrorCode(error: any): string {
    return String(error?.code || error?.cause?.code || '').toUpperCase();
  }

  private isEmptyModelResponseError(error: any): boolean {
    return this.extractErrorCode(error) === EMPTY_RESPONSE_ERROR_CODE;
  }

  private isShortNetworkRetryError(error: any): boolean {
    return SHORT_NETWORK_RETRY_CODES.has(this.extractErrorCode(error));
  }

  private isGatewayTimeoutError(error: any): boolean {
    const code = this.extractErrorCode(error);
    return this.extractStatus(error) === 504
      || code === 'XIAOBA_RESPONSES_HEADERS_TIMEOUT'
      || code === 'UND_ERR_HEADERS_TIMEOUT';
  }

  private isResponsesMode(): boolean {
    return this.config.provider === 'openai'
      && this.config.openaiApiMode === 'responses';
  }

  private async notifyRetry(
    callbacks: StreamCallbacks | undefined,
    attempt: number,
    maxRetries: number,
    info: StreamRetryInfo,
  ): Promise<void> {
    try {
      await callbacks?.onRetry?.(attempt, maxRetries, info);
    } catch (error: any) {
      Logger.warning(`重试提示回调失败: ${error?.message || error}`);
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw this.createAbortError();
    }
  }

  private sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    this.throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private isAbortError(error: any): boolean {
    return error?.name === 'AbortError'
      || error?.code === 'ERR_CANCELED'
      || /aborted|aborterror|canceled|cancelled/i.test(String(error?.message || ''));
  }

  private createAbortError(): Error {
    const err = new Error('请求已取消');
    err.name = 'AbortError';
    return err;
  }
}

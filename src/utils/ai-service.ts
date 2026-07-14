import { Message, ChatConfig, ChatResponse } from '../types';
import { ConfigManager } from './config';
import { ToolDefinition } from '../types/tool';
import { AIProvider, AIRequestOptions, StreamCallbacks, StreamRetryInfo } from '../providers/provider';
import { AnthropicProvider } from '../providers/anthropic-provider';
import { OpenAIProvider } from '../providers/openai-provider';
import { Logger } from './logger';
import { isPrimaryModelToolCallingCapable } from './model-capabilities';
import { resolveModelContextWindow } from './model-context-window';

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

type ProviderKind = 'openai' | 'anthropic';

interface RetryPolicy {
  maxRetries: number;
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
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

    try {
      return await this.withRetry(() => this.provider.chat(messages, tools, options), undefined, options.signal);
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
    let hasStreamedText = false;
    const providerCallbacks = this.createProviderStreamCallbacks(callbacks, () => {
      hasStreamedText = true;
    });

    try {
      return await this.withRetry(
        () => this.provider.chatStream(messages, tools, providerCallbacks, options),
        callbacks,
        options.signal,
        () => allowStreamRetry || !hasStreamedText,
      );
    } catch (error: any) {
      const wrapped = this.wrapError(error);
      callbacks?.onError?.(wrapped);
      throw wrapped;
    }
  }

  private createProviderStreamCallbacks(callbacks?: StreamCallbacks, onTextObserved?: () => void): StreamCallbacks | undefined {
    if (!callbacks) {
      return undefined;
    }

    return {
      onText: (text: string) => {
        if (text) onTextObserved?.();
        callbacks.onText?.(text);
      },
      onComplete: callbacks.onComplete,
    };
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

    if (status) {
      return new Error(`API错误 (${status}): ${errorMessage}`);
    }

    return new Error(`请求失败: ${errorMessage}`);
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryable(error: any): boolean {
    if (this.isAbortError(error)) {
      return false;
    }

    if (this.isKnownNonRetryableProviderError(error)) {
      return false;
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

  /**
   * 从错误中提取 HTTP 状态码
   */
  private extractStatus(error: any): number | null {
    const status = error?.response?.status || error?.status;
    if (typeof status === 'number') {
      return status;
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
  ): Promise<T> {
    let lastError: any;
    const policy = this.resolveRetryPolicy();
    const startedAt = Date.now();

    for (let attempt = 0; ; attempt++) {
      try {
        this.throwIfAborted(signal);
        return await fn();
      } catch (error: any) {
        lastError = error;

        if (this.isAbortError(error) || signal?.aborted) {
          throw this.createAbortError();
        }

        const policy = this.resolveRetryPolicy(error);
        const retryAttempt = attempt + 1;
        if (
          retryAttempt > policy.maxRetries
          || !this.isRetryable(error)
          || shouldRetry?.(error, retryAttempt) === false
        ) {
          throw error;
        }

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= policy.maxElapsedMs) {
          throw error;
        }

        // 计算等待时间：优先用 Retry-After，否则指数退避
        const delay = this.resolveRetryDelayMs(error, retryAttempt, policy, elapsedMs);

        const status = this.extractStatus(error) || this.extractErrorCode(error) || 'unknown';
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

    throw lastError;
  }

  private resolveRetryPolicy(error?: any): RetryPolicy {
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
    };

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
    const remainingMs = Math.max(0, policy.maxElapsedMs - elapsedMs);
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

  private isShortNetworkRetryError(error: any): boolean {
    return SHORT_NETWORK_RETRY_CODES.has(this.extractErrorCode(error));
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

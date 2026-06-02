import { Message, ChatConfig, ChatResponse } from '../types';
import { ConfigManager } from './config';
import { ToolDefinition } from '../types/tool';
import { AIProvider, AIRequestOptions, StreamCallbacks } from '../providers/provider';
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
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

type ProviderKind = 'openai' | 'anthropic';

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
   * 流式调用
   * 默认不重试，避免部分 token 已输出后出现重复文本。
   * 如需强制开启重试，可设置 GAUZ_STREAM_RETRY=true（需自行保证幂等）。
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
    const providerCallbacks = this.createProviderStreamCallbacks(callbacks);

    try {
      if (allowStreamRetry) {
        return await this.withRetry(
          () => this.provider.chatStream(messages, tools, providerCallbacks, options),
          callbacks,
          options.signal,
        );
      }
      this.throwIfAborted(options.signal);
      return await this.provider.chatStream(messages, tools, providerCallbacks, options);
    } catch (error: any) {
      const wrapped = this.wrapError(error);
      callbacks?.onError?.(wrapped);
      throw wrapped;
    }
  }

  private createProviderStreamCallbacks(callbacks?: StreamCallbacks): StreamCallbacks | undefined {
    if (!callbacks) {
      return undefined;
    }

    return {
      onText: callbacks.onText,
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
    const errorMessage = error?.response?.data?.error?.message
      || error?.response?.data?.message
      || error?.error?.message
      || error?.message
      || String(error);

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

    // HTTP 状态码可重试
    const status = this.extractStatus(error);
    if (status && RETRYABLE_STATUS_CODES.has(status)) {
      return true;
    }

    // 网络错误可重试
    const code = String(error?.code || '').toUpperCase();
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
      return true;
    }

    const message = String(error?.message || '');
    if (/timeout|timed out|socket hang up|network error|fetch failed|premature close|ECONNREFUSED/i.test(message)) {
      return true;
    }

    // Anthropic SDK overloaded_error
    if (error?.error?.type === 'overloaded_error') {
      return true;
    }

    return false;
  }

  /**
   * 从错误中提取 HTTP 状态码
   */
  private extractStatus(error: any): number | null {
    const status = error?.response?.status || error?.status;
    if (typeof status === 'number') {
      return status;
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
    }
    return null;
  }

  /**
   * 带指数退避的重试包装器
   */
  private async withRetry<T>(fn: () => Promise<T>, callbacks?: StreamCallbacks, signal?: AbortSignal): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.throwIfAborted(signal);
        return await fn();
      } catch (error: any) {
        lastError = error;

        if (this.isAbortError(error) || signal?.aborted) {
          throw this.createAbortError();
        }

        if (attempt >= MAX_RETRIES || !this.isRetryable(error)) {
          throw error;
        }

        // 通知用户正在重试
        if (attempt === 0 && callbacks?.onRetry) {
          callbacks.onRetry(attempt + 1, MAX_RETRIES);
        }

        // 计算等待时间：优先用 Retry-After，否则指数退避
        const retryAfter = this.getRetryAfter(error);
        const delay = retryAfter
          ? retryAfter * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;

        const status = this.extractStatus(error) || error?.code || 'unknown';
        Logger.warning(
          `API 调用失败 (${status})，${delay.toFixed(0)}ms 后重试 (${attempt + 1}/${MAX_RETRIES})... `
          + `[${this.config.provider}/${this.config.model || 'default'}]`
        );

        await this.sleepWithAbort(delay, signal);
      }
    }

    throw lastError;
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

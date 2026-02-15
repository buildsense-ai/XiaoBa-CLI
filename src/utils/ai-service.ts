import { Message, ChatConfig, ChatResponse } from '../types';
import { ConfigManager } from './config';
import { ToolDefinition } from '../types/tool';
import { AIProvider, StreamCallbacks } from '../providers/provider';
import { AnthropicProvider } from '../providers/anthropic-provider';
import { OpenAIProvider } from '../providers/openai-provider';
import { Logger } from './logger';

/**
 * AI 服务 - 统一的 AI 调用入口
 * 内部委托给对应的 Provider 实现
 */
/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class AIService {
  private config: ChatConfig;
  private provider: AIProvider;

  constructor(overrides?: Partial<ChatConfig>) {
    this.config = {
      ...ConfigManager.getConfig(),
      ...(overrides || {})
    };
    this.provider = this.createProvider();
  }

  /**
   * 根据配置创建对应的 Provider
   */
  private createProvider(): AIProvider {
    if (this.config.provider === 'anthropic') {
      return new AnthropicProvider(this.config);
    } else {
      return new OpenAIProvider(this.config);
    }
  }

  /**
   * 普通调用（非流式），带自动重试
   */
  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error('API密钥未配置。请先运行: xiaoba config');
    }

    return this.withRetry(() => this.provider.chat(messages, tools));
  }

  /**
   * 流式调用
   * 默认不重试，避免部分 token 已输出后出现重复文本。
   * 如需强制开启重试，可设置 GAUZ_STREAM_RETRY=true（需自行保证幂等）。
   */
  async chatStream(messages: Message[], tools?: ToolDefinition[], callbacks?: StreamCallbacks): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error('API密钥未配置。请先运行: xiaoba config');
    }

    try {
      if (process.env.GAUZ_STREAM_RETRY === 'true') {
        return this.withRetry(() => this.provider.chatStream(messages, tools, callbacks));
      }
      return await this.provider.chatStream(messages, tools, callbacks);
    } catch (error: any) {
      // 连接级别错误（Premature close 等）对流式调用也安全重试
      if (this.isConnectionError(error)) {
        Logger.warning('流式调用遇到连接错误，自动重试...');
        return this.withRetry(() => this.provider.chatStream(messages, tools, callbacks));
      }
      throw this.wrapError(error);
    }
  }

  /**
   * 统一错误处理
   */
  private wrapError(error: any): Error {
    Logger.error(`API调用失败 | Provider: ${this.config.provider} | Model: ${this.config.model}`);

    if (error.response) {
      const status = error.response.status;
      const errorMessage = error.response.data?.error?.message
        || error.response.data?.message
        || JSON.stringify(error.response.data);
      return new Error(`API错误 (${status}): ${errorMessage}`);
    }

    if (error.message) {
      return new Error(`请求失败: ${error.message}`);
    }

    return new Error(`请求失败: ${String(error)}`);
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryable(error: any): boolean {
    // HTTP 状态码可重试
    const status = error?.response?.status || error?.status;
    if (status && RETRYABLE_STATUS_CODES.has(status)) {
      return true;
    }
    // 网络错误可重试
    const code = error?.code;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      return true;
    }
    // 连接提前关闭（代理超时、网络中断等）
    const msg = error?.message || error?.cause?.message || '';
    if (/premature close|socket hang up|ECONNREFUSED|network/i.test(msg)) {
      return true;
    }
    // Anthropic SDK overloaded_error
    if (error?.error?.type === 'overloaded_error') {
      return true;
    }
    return false;
  }

  /**
   * 判断是否为连接级别错误（Premature close、socket hang up 等）
   * 这类错误在流式调用中也可以安全重试，因为连接断开意味着没有完整输出
   */
  private isConnectionError(error: any): boolean {
    const msg = error?.message || error?.cause?.message || '';
    const code = error?.code;
    return (
      code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' ||
      /premature close|socket hang up/i.test(msg)
    );
  }

  /**
   * 从错误中提取 Retry-After 头（秒）
   */
  private getRetryAfter(error: any): number | null {
    const retryAfter = error?.response?.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds;
    }
    return null;
  }

  /**
   * 带指数退避的重试包装器
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;

        if (attempt >= MAX_RETRIES || !this.isRetryable(error)) {
          throw this.wrapError(error);
        }

        // 计算等待时间：优先用 Retry-After，否则指数退避
        const retryAfter = this.getRetryAfter(error);
        const delay = retryAfter
          ? retryAfter * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;

        const status = error?.response?.status || error?.code || 'unknown';
        Logger.warning(
          `API 调用失败 (${status})，${delay.toFixed(0)}ms 后重试 (${attempt + 1}/${MAX_RETRIES})...`
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw this.wrapError(lastError);
  }
}

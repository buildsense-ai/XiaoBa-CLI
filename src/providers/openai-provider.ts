import axios from 'axios';
import { Message, ChatConfig, ChatResponse, ContentBlock } from '../types';
import { ToolDefinition } from '../types/tool';
import { AIProvider, AIRequestOptions, StreamCallbacks } from './provider';
import { ContextDebugLogger } from '../utils/context-debug-logger';
import { normalizeOpenAIChatCompletionsUrl } from './openai-url';
import { resolveMaxTokens } from './output-limits';
import { applyOpenAIReasoningOptions, supportsOpenAIReasoningReplay } from '../utils/reasoning-effort';

/**
 * OpenAI Provider
 * 兼容所有 OpenAI API 格式的服务（OpenAI、本地 LLM 等）
 * 支持 SSE streaming
 */
export class OpenAIProvider implements AIProvider {
  private apiUrl: string;
  private chatCompletionsUrl: string;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private reasoningEffort: ChatConfig['reasoningEffort'];

  constructor(config: ChatConfig) {
    this.apiUrl = config.apiUrl!;
    this.chatCompletionsUrl = normalizeOpenAIChatCompletionsUrl(this.apiUrl);
    this.apiKey = config.apiKey!;
    this.model = config.model || 'gpt-4o';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = resolveMaxTokens(config);
    this.reasoningEffort = config.reasoningEffort;
  }

  /**
   * 构建请求体
   */
  private buildRequestBody(messages: Message[], tools?: ToolDefinition[], stream = false): any {
    const sanitizedMessages = messages.map(message => this.sanitizeMessage(message));

    const body: any = {
      model: this.model,
      messages: sanitizedMessages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream,
    };

    if (stream) {
      body.stream_options = { include_usage: true };
    }

    applyOpenAIReasoningOptions(body, {
      apiUrl: this.apiUrl,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    });

    if (tools && tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    }

    return body;
  }

  private sanitizeMessage(message: Message): any {
    const sanitized: any = {
      role: message.role,
      content: this.sanitizeContent(message.content),
    };

    if (message.name) {
      sanitized.name = message.name;
    }
    if (message.role === 'assistant' && message.tool_calls) {
      sanitized.tool_calls = message.tool_calls.map(toolCall => ({
        id: toolCall.id,
        type: toolCall.type,
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      }));
      const reasoningContent = this.extractOpenAIReasoningContent(message);
      if (reasoningContent) {
        sanitized.reasoning_content = reasoningContent;
      }
    }
    if (message.role === 'tool' && message.tool_call_id) {
      sanitized.tool_call_id = message.tool_call_id;
    }

    return sanitized;
  }

  private extractOpenAIReasoningContent(message: Message): string | undefined {
    if (!this.shouldReplayOpenAIReasoningContent()) return undefined;
    if (!Array.isArray(message.providerContent) || !message.tool_calls?.length) return undefined;
    const block = message.providerContent.find(item =>
      item
      && typeof item === 'object'
      && item.type === 'openai_reasoning'
      && typeof (item as any).reasoning_content === 'string'
    );
    const reasoning = typeof (block as any)?.reasoning_content === 'string'
      ? (block as any).reasoning_content.trim()
      : '';
    return reasoning || undefined;
  }

  private shouldReplayOpenAIReasoningContent(): boolean {
    return supportsOpenAIReasoningReplay({
      apiUrl: this.apiUrl,
      model: this.model,
    });
  }

  private sanitizeContent(content: Message['content']): any {
    if (!Array.isArray(content)) return content ?? '';
    return content.map(block =>
      block.type === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
    );
  }

  private visibleMessageContent(message: any): string | null {
    const content = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .map((item: any) => typeof item?.text === 'string' ? item.text : '')
            .join('')
        : '';
    const visible = stripOpenAIThinkingText(content).trim();
    return visible || null;
  }

  /**
   * 构建请求头
   */
  private get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  /**
   * 普通调用
   */
  async chat(messages: Message[], tools?: ToolDefinition[], options?: AIRequestOptions): Promise<ChatResponse> {
    const body = this.buildRequestBody(messages, tools, false);
    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.chatCompletionsUrl,
      body,
    });
    const response = await axios.post(this.chatCompletionsUrl, body, {
      headers: this.headers,
      signal: options?.signal,
    });
    const choice = response.data.choices[0];
    const message = choice.message;
    const usage = response.data.usage;

    ContextDebugLogger.dumpSdkBoundary('after', undefined, {
      response: response.data,
    });

    return {
      content: this.visibleMessageContent(message),
      toolCalls: message.tool_calls,
      stopReason: choice.finish_reason || undefined,
      usage: usage ? {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      } : undefined,
      ...this.buildOpenAIProviderContent(message),
    };
  }

  /**
   * 流式调用（SSE）
   */
  async chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    callbacks?: StreamCallbacks,
    options?: AIRequestOptions,
  ): Promise<ChatResponse> {
    const body = this.buildRequestBody(messages, tools, true);

    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.chatCompletionsUrl,
      body,
    });

    const response = await axios.post(this.chatCompletionsUrl, body, {
      headers: this.headers,
      responseType: 'stream',
      signal: options?.signal,
    });

    return new Promise<ChatResponse>((resolve, reject) => {
      let fullContent = '';
      let fullReasoningContent = '';
      let contentStripper = new OpenAIThinkingStripper();
      const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
      let buffer = '';
      let streamUsage: ChatResponse['usage'] = undefined;
      let finishReason: string | undefined;

      const stream = response.data;
      const onAbort = () => {
        stream.destroy(createAbortError());
      };
      if (options?.signal?.aborted) {
        onAbort();
      } else {
        options?.signal?.addEventListener('abort', onAbort, { once: true });
      }

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // 提取 usage（stream_options.include_usage 时在最后一个 chunk 返回）
            if (parsed.usage) {
              streamUsage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
              };
            }

            const delta = choice?.delta;
            if (!delta) continue;

            // OpenAI-compatible providers may stream hidden reasoning fields
            // (reasoning_content/thinking/etc.). CatsCo treats them as private
            // provider-side work: never render them and never send them back as
            // conversation content.
            const reasoningDelta = extractOpenAIReasoningDelta(delta);
            if (reasoningDelta) fullReasoningContent += reasoningDelta;

            // 文本内容
            if (delta.content) {
              const visibleContent = contentStripper.push(delta.content);
              if (visibleContent) {
                fullContent += visibleContent;
                callbacks?.onText?.(visibleContent);
              }
            }

            // 工具调用（增量拼接）
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsMap.has(idx)) {
                  toolCallsMap.set(idx, {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' }
                  });
                }
                const existing = toolCallsMap.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name += tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      });

      stream.on('end', () => {
        options?.signal?.removeEventListener('abort', onAbort);
        const tail = contentStripper.flush();
        if (tail) {
          fullContent += tail;
          callbacks?.onText?.(tail);
        }
        const toolCalls = toolCallsMap.size > 0
          ? Array.from(toolCallsMap.values())
          : undefined;

        const result: ChatResponse = {
          content: fullContent || null,
          toolCalls,
          usage: streamUsage,
          stopReason: finishReason,
          ...(toolCalls && fullReasoningContent.trim()
            ? { providerContent: buildOpenAIProviderContentFromToolCalls(toolCalls, fullReasoningContent.trim()) }
            : {}),
        };

        ContextDebugLogger.dumpSdkBoundary('after', undefined, {
          response: result,
        });

        callbacks?.onComplete?.(result);
        resolve(result);
      });

      stream.on('error', (err: Error) => {
        options?.signal?.removeEventListener('abort', onAbort);
        callbacks?.onError?.(err);
        reject(err);
      });
    });
  }

  private buildOpenAIProviderContent(message: any): Pick<ChatResponse, 'providerContent'> {
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const reasoningContent = typeof message?.reasoning_content === 'string'
      ? message.reasoning_content.trim()
      : '';
    if (!toolCalls.length || !reasoningContent) return {};
    return {
      providerContent: buildOpenAIProviderContentFromToolCalls(toolCalls, reasoningContent),
    };
  }
}

function extractOpenAIReasoningDelta(delta: any): string {
  if (typeof delta?.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta?.reasoning === 'string') return '';
  if (typeof delta?.thinking === 'string') return '';
  return '';
}

function buildOpenAIProviderContentFromToolCalls(
  toolCalls: NonNullable<ChatResponse['toolCalls']>,
  reasoningContent: string,
): NonNullable<ChatResponse['providerContent']> {
  return [
    { type: 'openai_reasoning', reasoning_content: reasoningContent },
    ...toolCalls.map(toolCall => ({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseOpenAIToolArguments(toolCall.function.arguments),
    })),
  ];
}

function parseOpenAIToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson || '{}');
  } catch {
    return argumentsJson || '';
  }
}

function stripOpenAIThinkingText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/^\s*<think\b[^>]*>[\s\S]*$/i, '');
}

function longestThinkTagPrefixSuffix(value: string, tag: string): number {
  const lower = value.toLowerCase();
  const max = Math.min(lower.length, tag.length - 1);
  for (let length = max; length > 0; length--) {
    if (lower.slice(-length) === tag.slice(0, length)) return length;
  }
  return 0;
}

class OpenAIThinkingStripper {
  private buffer = '';
  private inThinking = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let output = '';

    while (this.buffer) {
      const lower = this.buffer.toLowerCase();

      if (this.inThinking) {
        const closeIndex = lower.indexOf('</think>');
        if (closeIndex < 0) {
          const keep = longestThinkTagPrefixSuffix(this.buffer, '</think>');
          this.buffer = keep > 0 ? this.buffer.slice(-keep) : '';
          break;
        }
        this.buffer = this.buffer.slice(closeIndex + '</think>'.length);
        this.inThinking = false;
        continue;
      }

      const openIndex = lower.indexOf('<think');
      if (openIndex < 0) {
        const keep = longestThinkTagPrefixSuffix(this.buffer, '<think');
        output += keep > 0 ? this.buffer.slice(0, -keep) : this.buffer;
        this.buffer = keep > 0 ? this.buffer.slice(-keep) : '';
        break;
      }

      output += this.buffer.slice(0, openIndex);
      const openEndIndex = this.buffer.indexOf('>', openIndex);
      if (openEndIndex < 0) {
        this.buffer = this.buffer.slice(openIndex);
        break;
      }
      this.buffer = this.buffer.slice(openEndIndex + 1);
      this.inThinking = true;
    }

    return output;
  }

  flush(): string {
    if (this.inThinking) {
      this.buffer = '';
      this.inThinking = false;
      return '';
    }
    const output = this.buffer;
    this.buffer = '';
    return output;
  }
}

function createAbortError(): Error {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

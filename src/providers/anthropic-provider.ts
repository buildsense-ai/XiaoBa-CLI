import Anthropic from '@anthropic-ai/sdk';
import { Message, ChatConfig, ChatResponse, ContentBlock } from '../types';
import { ToolDefinition } from '../types/tool';
import { AIProvider, AIRequestOptions, StreamCallbacks } from './provider';
import { ContextDebugLogger } from '../utils/context-debug-logger';
import { resolveMaxTokens } from './output-limits';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Anthropic Provider
 * 使用官方 SDK 替代 axios 手动调用，支持 streaming
 */
export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: ChatConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey!,
      baseURL: this.normalizeBaseURL(config.apiUrl!),
      timeout: 10 * 60 * 1000, // 10 分钟，Opus 长输出需要足够时间
      defaultHeaders: {
        'User-Agent': 'CatsCo',
        'x-stainless-lang': undefined as any,
        'x-stainless-package-version': undefined as any,
        'x-stainless-os': undefined as any,
        'x-stainless-arch': undefined as any,
        'x-stainless-runtime': undefined as any,
        'x-stainless-runtime-version': undefined as any,
      },
    });
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = resolveMaxTokens(config);
  }

  /**
   * 标准化 base URL（去掉末尾的 /v1/messages 等路径）
   */
  private normalizeBaseURL(url: string): string {
    return url.replace(/\/v1\/messages\/?$/, '').replace(/\/v1\/?$/, '');
  }

  /**
   * 转换消息为 Anthropic 格式
   */
  private transformMessages(messages: Message[]): { system?: string; messages: Anthropic.MessageParam[] } {
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const systemPrompt = systemMessages.map(msg => typeof msg.content === 'string' ? msg.content : '').join('\n\n');

    const nonSystemMessages = messages.filter(msg => msg.role !== 'system');
    const transformedMessages: Anthropic.MessageParam[] = [];
    let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

    const flushToolResults = () => {
      if (pendingToolResults.length === 0) return;
      
      // 先收集所有 tool_result blocks，再收集所有 image blocks
      // Anthropic API 要求 tool_result 必须在前面
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      const imageBlocks: Anthropic.ImageBlockParam[] = [];
      
      for (const toolResult of pendingToolResults) {
        if (Array.isArray(toolResult.content)) {
          // 分离 text 和 image blocks
          const textBlocks = toolResult.content.filter((b: any) => b.type === 'text') as Anthropic.TextBlockParam[];
          const images = toolResult.content.filter((b: any) => b.type === 'image') as Anthropic.ImageBlockParam[];
          
          // tool_result 只保留 text
          if (textBlocks.length > 0) {
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolResult.tool_use_id,
              content: textBlocks.length === 1 && typeof textBlocks[0].text === 'string' 
                ? textBlocks[0].text 
                : textBlocks as any
            });
          } else {
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolResult.tool_use_id,
              content: ''
            });
          }
          
          // 收集图片，稍后统一添加
          imageBlocks.push(...images);
        } else {
          toolResultBlocks.push(toolResult);
        }
      }
      
      // 关键修复：先添加所有 tool_result，再添加所有 image
      const contentBlocks: (Anthropic.ToolResultBlockParam | Anthropic.ImageBlockParam)[] = [
        ...toolResultBlocks,
        ...imageBlocks
      ];
      
      transformedMessages.push({
        role: 'user',
        content: contentBlocks
      });
      pendingToolResults = [];
    };

    for (const msg of nonSystemMessages) {
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) continue;
        
        const content = Array.isArray(msg.content)
          ? msg.content.map(block =>
              block.type === 'text'
                ? { type: 'text' as const, text: block.text }
                : { type: 'image' as const, source: block.source }
            )
          : msg.content || '';
        
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content
        });
        continue;
      }

      flushToolResults();

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const blocks = this.transformAssistantContentBlocks(msg)
            || this.transformAssistantToolCallBlocks(msg);
          transformedMessages.push({ role: 'assistant', content: blocks });
        } else {
          // 处理纯文本或 ContentBlock[] 的情况
          if (typeof msg.content === 'string' && msg.content.trim()) {
            transformedMessages.push({ role: 'assistant', content: msg.content });
          } else if (Array.isArray(msg.content) && msg.content.length > 0) {
            // 处理 ContentBlock[] 的情况（包含图片）
            const blocks = msg.content.map(block =>
              block.type === 'text'
                ? { type: 'text' as const, text: block.text }
                : { type: 'image' as const, source: block.source }
            );
            transformedMessages.push({ role: 'assistant', content: blocks });
          }
        }
      } else if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const blocks = msg.content.map(block =>
            block.type === 'text'
              ? { type: 'text' as const, text: block.text }
              : { type: 'image' as const, source: block.source }
          );
          transformedMessages.push({ role: 'user', content: blocks });
        } else {
          transformedMessages.push({ role: 'user', content: msg.content || '' });
        }
      }
    }

    flushToolResults();

    return {
      system: systemPrompt || undefined,
      messages: this.coalesceAdjacentUserMessages(transformedMessages)
    };
  }

  private coalesceAdjacentUserMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const message of messages) {
      const previous = result[result.length - 1];
      if (previous?.role === 'user' && message.role === 'user') {
        previous.content = this.mergeUserContent(previous.content, message.content) as any;
        continue;
      }
      result.push(message);
    }

    return result;
  }

  private mergeUserContent(left: unknown, right: unknown): unknown {
    if (typeof left === 'string' && typeof right === 'string') {
      return [left, right].filter(Boolean).join('\n\n');
    }

    const blocks = [
      ...this.userContentToBlocks(left),
      ...this.userContentToBlocks(right),
    ];
    if (blocks.length === 0) return '';

    return this.orderUserBlocks(blocks);
  }

  private userContentToBlocks(content: unknown): any[] {
    if (Array.isArray(content)) return content;
    if (typeof content === 'string') {
      return content ? [{ type: 'text', text: content }] : [];
    }
    return [];
  }

  private orderUserBlocks(blocks: any[]): any[] {
    if (!blocks.some(block => block?.type === 'tool_result')) {
      return blocks;
    }

    const toolResults: any[] = [];
    const others: any[] = [];
    for (const block of blocks) {
      if (block?.type === 'tool_result') {
        toolResults.push(block);
      } else {
        others.push(block);
      }
    }
    return [...toolResults, ...others];
  }

  /**
   * 转换工具定义为 Anthropic 格式
   */
  private transformTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema
    }));
  }

  private transformAssistantToolCallBlocks(msg: Message): (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] {
    const blocks: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = [];
    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
      blocks.push({ type: 'text', text: msg.content });
    }
    for (const toolCall of msg.tool_calls || []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        input = {};
      }
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input
      });
    }
    return blocks;
  }

  private transformAssistantContentBlocks(msg: Message): any[] | undefined {
    if (!Array.isArray(msg.providerContent) || msg.providerContent.length === 0) {
      return undefined;
    }

    const retainedToolCallIds = new Set((msg.tool_calls || []).map(toolCall => toolCall.id));
    const blocks: any[] = [];
    let hasRetainedToolUse = false;

    for (const block of msg.providerContent) {
      if (!block || typeof block !== 'object') continue;
      const type = String((block as any).type || '');
      if (type === 'text' && typeof (block as any).text === 'string') {
        blocks.push({ type: 'text', text: (block as any).text });
        continue;
      }
      if (type === 'thinking' && typeof (block as any).thinking === 'string') {
        const thinkingBlock: Record<string, unknown> = {
          type: 'thinking',
          thinking: (block as any).thinking,
        };
        if (typeof (block as any).signature === 'string') {
          thinkingBlock.signature = (block as any).signature;
        }
        blocks.push(thinkingBlock);
        continue;
      }
      if (type === 'redacted_thinking') {
        const redactedBlock: Record<string, unknown> = { type: 'redacted_thinking' };
        if (typeof (block as any).data === 'string') {
          redactedBlock.data = (block as any).data;
        }
        blocks.push(redactedBlock);
        continue;
      }
      if (
        type === 'tool_use'
        && typeof (block as any).id === 'string'
        && retainedToolCallIds.has((block as any).id)
      ) {
        hasRetainedToolUse = true;
        blocks.push({
          type: 'tool_use',
          id: (block as any).id,
          name: String((block as any).name || ''),
          input: isRecord((block as any).input) ? (block as any).input : {},
        });
      }
    }

    return hasRetainedToolUse ? blocks : undefined;
  }

  /**
   * 从 Anthropic 响应中提取统一格式
   */
  private parseResponse(response: Anthropic.Message): ChatResponse {
    const textParts: string[] = [];
    let toolCalls: ChatResponse['toolCalls'] = undefined;
    const providerContent = this.preserveAssistantProviderContent(response.content as any[]);

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        });
      }
    }

    // 提取 token 用量
    const usage = response.usage ? {
      promptTokens: response.usage.input_tokens ?? 0,
      completionTokens: response.usage.output_tokens ?? 0,
      totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
    } : undefined;

    return {
      content: textParts.length > 0 ? textParts.join('') : null,
      toolCalls,
      usage,
      stopReason: response.stop_reason || undefined,
      ...(providerContent.length > 0 ? { providerContent } : {}),
    };
  }

  private preserveAssistantProviderContent(content: any[]): NonNullable<ChatResponse['providerContent']> {
    if (!Array.isArray(content) || !content.some(block => block?.type === 'tool_use')) {
      return [];
    }

    const blocks: NonNullable<ChatResponse['providerContent']> = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = String(block.type || '');
      if (type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
        continue;
      }
      if (type === 'thinking' && typeof block.thinking === 'string') {
        const thinkingBlock: Record<string, unknown> & { type: string } = {
          type: 'thinking',
          thinking: block.thinking,
        };
        if (typeof block.signature === 'string') {
          thinkingBlock.signature = block.signature;
        }
        blocks.push(thinkingBlock);
        continue;
      }
      if (type === 'redacted_thinking') {
        const redactedBlock: Record<string, unknown> & { type: string } = { type: 'redacted_thinking' };
        if (typeof block.data === 'string') {
          redactedBlock.data = block.data;
        }
        blocks.push(redactedBlock);
        continue;
      }
      if (type === 'tool_use' && typeof block.id === 'string') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: String(block.name || ''),
          input: isRecord(block.input) ? block.input : {},
        });
      }
    }
    return blocks;
  }

  /**
   * 普通调用
   */
  async chat(messages: Message[], tools?: ToolDefinition[], options?: AIRequestOptions): Promise<ChatResponse> {
    const { system, messages: transformed } = this.transformMessages(messages);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      messages: transformed,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };

    if (system) params.system = system;
    if (tools && tools.length > 0) params.tools = this.transformTools(tools);

    // [CONTEXT_DEBUG] SDK 调用前：记录完整的请求参数
    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      baseURL: this.client.baseURL,
      params
    });

    const response = await this.client.messages.create(params, { signal: options?.signal } as any);

    // [CONTEXT_DEBUG] SDK 调用后：记录完整的响应
    ContextDebugLogger.dumpSdkBoundary('after', undefined, { response });

    return this.parseResponse(response);
  }

  /**
   * 流式调用
   */
  async chatStream(
    messages: Message[],
    tools?: ToolDefinition[],
    callbacks?: StreamCallbacks,
    options?: AIRequestOptions,
  ): Promise<ChatResponse> {
    const { system, messages: transformed } = this.transformMessages(messages);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      messages: transformed,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
    };

    if (system) params.system = system;
    if (tools && tools.length > 0) params.tools = this.transformTools(tools);

    try {
      // [CONTEXT_DEBUG] SDK 调用前：记录完整的请求参数
      ContextDebugLogger.dumpSdkBoundary('before', undefined, {
        baseURL: this.client.baseURL,
        params
      });

      const stream = this.client.messages.stream(params, { signal: options?.signal } as any);

      // 逐 token 回调文本
      stream.on('text', (text) => {
        callbacks?.onText?.(text);
      });

      // 等待完整响应
      const finalMessage = await stream.finalMessage();

      // [CONTEXT_DEBUG] SDK 调用后：记录完整的响应
      ContextDebugLogger.dumpSdkBoundary('after', undefined, { response: finalMessage });

      const result = this.parseResponse(finalMessage);
      callbacks?.onComplete?.(result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    }
  }
}

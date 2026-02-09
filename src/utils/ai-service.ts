import axios from 'axios';
import { Message, ChatConfig, ChatResponse } from '../types';
import { ConfigManager } from './config';
import { ToolDefinition } from '../types/tool';

export class AIService {
  private config: ChatConfig;

  constructor(overrides?: Partial<ChatConfig>) {
    this.config = {
      ...ConfigManager.getConfig(),
      ...(overrides || {})
    };
  }

  /**
   * 转换工具定义为 Anthropic 格式
   */
  private transformToolsForAnthropic(tools: ToolDefinition[]) {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }

  /**
   * 转换消息为 Anthropic 格式
   * Anthropic API 要求：
   * 1. system 消息需要单独提取作为 system 参数
   * 2. messages 数组中只能有 user 和 assistant
   * 3. 消息必须交替出现，且第一条必须是 user
   */
  private transformMessagesForAnthropic(messages: Message[]): { system?: string; messages: any[] } {
    // 提取 system 消息
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const systemPrompt = systemMessages.map(msg => msg.content).join('\n\n');

    // 过滤出非 system 消息
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system');

    const transformedMessages: any[] = [];
    let pendingToolResults: any[] = [];

    const flushToolResults = () => {
      if (pendingToolResults.length === 0) return;
      transformedMessages.push({
        role: 'user',
        content: pendingToolResults
      });
      pendingToolResults = [];
    };

    for (const msg of nonSystemMessages) {
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) {
          continue;
        }
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content || ''
        });
        continue;
      }

      flushToolResults();

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const blocks: any[] = [];
          if (msg.content) {
            blocks.push({ type: 'text', text: msg.content });
          }
          for (const toolCall of msg.tool_calls) {
            let input: any = {};
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
          transformedMessages.push({
            role: 'assistant',
            content: blocks
          });
        } else {
          transformedMessages.push({
            role: 'assistant',
            content: msg.content || ''
          });
        }
      } else if (msg.role === 'user') {
        transformedMessages.push({
          role: 'user',
          content: msg.content || ''
        });
      }
    }

    flushToolResults();

    return {
      system: systemPrompt || undefined,
      messages: transformedMessages
    };
  }

  /**
   * 使用 Anthropic API 进行聊天
   */
  private async chatWithAnthropic(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const { system, messages: transformedMessages } = this.transformMessagesForAnthropic(messages);

    const requestBody: any = {
      model: this.config.model,
      messages: transformedMessages,
      max_tokens: 4096,
      temperature: this.config.temperature,
    };

    // 添加 system 参数（如果存在）
    if (system) {
      requestBody.system = system;
    }

    // 如果提供了工具定义，添加到请求中
    if (tools && tools.length > 0) {
      requestBody.tools = this.transformToolsForAnthropic(tools);
    }

    // 构建完整的 API URL（添加 /v1/messages 路径）
    const apiUrl = this.config.apiUrl!.endsWith('/v1/messages')
      ? this.config.apiUrl!
      : `${this.config.apiUrl!}/v1/messages`;

    const response = await axios.post(
      apiUrl,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey!,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    // 解析 Anthropic 响应格式
    const content = response.data.content;
    let textContent: string | null = null;
    let toolCalls: any[] | undefined = undefined;

    if (Array.isArray(content)) {
      // 提取文本内容
      const textBlock = content.find((block: any) => block.type === 'text');
      if (textBlock) {
        textContent = textBlock.text;
      }

      // 提取工具调用
      const toolBlocks = content.filter((block: any) => block.type === 'tool_use');
      if (toolBlocks.length > 0) {
        toolCalls = toolBlocks.map((block: any) => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        }));
      }
    }

    return {
      content: textContent,
      toolCalls
    };
  }

  /**
   * 使用 OpenAI API 进行聊天
   */
  private async chatWithOpenAI(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const sanitizedMessages = messages.map(message => ({
      ...message,
      content: message.content ?? ''
    }));

    const requestBody: any = {
      model: this.config.model,
      messages: sanitizedMessages,
      temperature: this.config.temperature,
    };

    // 如果提供了工具定义，添加到请求中
    if (tools && tools.length > 0) {
      requestBody.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    }

    const response = await axios.post(
      this.config.apiUrl!,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
      }
    );

    const message = response.data.choices[0].message;

    return {
      content: message.content || null,
      toolCalls: message.tool_calls
    };
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error('API密钥未配置。请先运行: xiaoba config');
    }

    try {
      // 根据 provider 选择对应的 API 调用方法
      if (this.config.provider === 'anthropic') {
        return await this.chatWithAnthropic(messages, tools);
      } else {
        return await this.chatWithOpenAI(messages, tools);
      }
    } catch (error: any) {
      // 详细的错误日志
      console.error('API调用失败，详细信息：');
      console.error('Provider:', this.config.provider);
      console.error('API URL:', this.config.apiUrl);
      console.error('Model:', this.config.model);

      if (error.response) {
        console.error('响应状态:', error.response.status);
        console.error('响应数据:', JSON.stringify(error.response.data, null, 2));

        const errorMessage = error.response.data.error?.message ||
                           error.response.data.message ||
                           JSON.stringify(error.response.data);
        throw new Error(`API错误 (${error.response.status}): ${errorMessage}`);
      }

      console.error('错误详情:', error.message);
      console.error('错误堆栈:', error.stack);
      throw new Error(`请求失败: ${error.message}`);
    }
  }
}

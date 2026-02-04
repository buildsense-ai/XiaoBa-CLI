import axios from 'axios';
import { Message, ChatConfig, ChatResponse } from '../types';
import { ConfigManager } from './config';
import { ToolDefinition } from '../types/tool';

export class AIService {
  private config: ChatConfig;

  constructor() {
    this.config = ConfigManager.getConfig();
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    if (!this.config.apiKey) {
      throw new Error('API密钥未配置。请先运行: xiaoba config');
    }

    try {
      const requestBody: any = {
        model: this.config.model,
        messages: messages,
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
    } catch (error: any) {
      if (error.response) {
        throw new Error(`API错误: ${error.response.data.error?.message || error.message}`);
      }
      throw new Error(`请求失败: ${error.message}`);
    }
  }
}

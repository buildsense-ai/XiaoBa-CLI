import { Message, ChatResponse } from '../types';
import { ToolDefinition } from '../types/tool';

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
}

/**
 * AI Provider 统一接口
 * 抽象不同 AI 服务商的调用差异
 */
export interface AIProvider {
  /** 普通（非流式）调用 */
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse>;
  /** 流式调用 */
  chatStream(messages: Message[], tools?: ToolDefinition[], callbacks?: StreamCallbacks): Promise<ChatResponse>;
}

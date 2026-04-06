export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } };

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
  /** 标记由 injectContext 注入的消息，用于滑动窗口清理 */
  __injected?: boolean;
}

export interface ChatConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  provider?: 'openai' | 'anthropic';
  feishu?: {
    appId?: string;
    appSecret?: string;
    sessionTTL?: number;
    botOpenId?: string;
    botAliases?: string[];
  };
  catscompany?: {
    serverUrl?: string;
    apiKey?: string;
    httpBaseUrl?: string;
    sessionTTL?: number;
  };
  weixin?: {
    token?: string;
    baseUrl?: string;
    cdnBaseUrl?: string;
    allowFrom?: string[];
    sessionTTL?: number;
    longPollTimeout?: number;
  };
  logUpload?: {
    enabled?: boolean;
    serverUrl?: string;
    intervalMinutes?: number;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  usage?: TokenUsage;
}

export interface CommandOptions {
  interactive?: boolean;
  message?: string;
  config?: string;
  skill?: string;
}

// 导出 Agent 相关类型
export * from './agent';
export * from './tool';
export * from './skill';

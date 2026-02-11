export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
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
}

export interface ChatConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  provider?: 'openai' | 'anthropic';
  memory?: {
    enabled?: boolean;
    baseUrl?: string;
    projectId?: string;
    userId?: string;
    agentId?: string;
  };
  feishu?: {
    appId?: string;
    appSecret?: string;
    sessionTTL?: number;
    botOpenId?: string;
    botAliases?: string[];
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

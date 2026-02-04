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
  memory?: {
    enabled?: boolean;
    baseUrl?: string;
    projectId?: string;
    userId?: string;
    agentId?: string;
  };
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
}

export interface CommandOptions {
  interactive?: boolean;
  message?: string;
  config?: string;
}

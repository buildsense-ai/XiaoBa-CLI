export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } };

export type ProviderContentBlock = Record<string, unknown> & { type: string };

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
  /** 标记注入给 agent 看的运行时反馈，仅供内部清理和日志记录使用 */
  __runtimeFeedback?: boolean;
  /** 标记内部 runtime observation，例如子 agent 完成结果；对模型仍以 user role 承载 */
  __runtimeObservation?: boolean;
  runtimeObservationSource?: string;
  /** 标记内部错误占位，仅用于本地恢复/继续，不应进入模型上下文或持久历史。 */
  __internalErrorArtifact?: boolean;
  /** Synthetic tool-call/tool-result pair used as transient runtime context. */
  __syntheticObservation?: boolean;
  syntheticObservationId?: string;
  /** Internal episode marker used for local compaction grouping. Never sent to providers. */
  __episodeId?: string;
  /** Distinguishes the initial user input from user messages merged while a turn is running. */
  __episodeInputKind?: 'root' | 'pending';
  /** Provider 原始 assistant content blocks，仅用于下次请求回放，不展示给用户。 */
  providerContent?: ProviderContentBlock[];
}

export interface ChatConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindowTokens?: number;
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
  catscoLogUpload?: {
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
  /** Provider stop/finish reason, e.g. max_tokens/length/tool_use/stop. */
  stopReason?: string;
  /** Provider 原始 assistant content blocks，仅用于下次请求回放，不展示给用户。 */
  providerContent?: ProviderContentBlock[];
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
export * from './session-identity';

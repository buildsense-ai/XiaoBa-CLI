/**
 * 工具参数定义
 */
export interface ToolParameter {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: ToolParameter | {
    type: string;
    properties?: Record<string, ToolParameter>;
    required?: string[];
  };
  properties?: Record<string, ToolParameter>;
  default?: any;
}

/**
 * 工具定义
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

/**
 * 工具调用请求
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON字符串
  };
}

/**
 * 工具调用结果
 */
export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  name: string;
  content: string;
  ok?: boolean;
  errorCode?: string;
  retryable?: boolean;
}

export type ToolSurface = 'cli' | 'feishu' | 'catscompany' | 'agent' | 'research' | 'unknown';
export type ToolPermissionProfile = 'strict' | 'default' | 'relaxed';

/**
 * 平台通道回调（通过 ToolExecutionContext 传递给工具，替代 bind/unbind 模式）
 * 飞书、CatsCompany 等平台共用此接口，chatId 对应各平台的会话标识。
 */
export interface ChannelCallbacks {
  /** 当前会话的 chatId（飞书 chatId / CatsCompany topic） */
  chatId: string;
  /** 发送文本消息 */
  reply: (chatId: string, text: string) => Promise<void>;
  /** 发送文件 */
  sendFile: (chatId: string, filePath: string, fileName: string) => Promise<void>;
  /** 向用户提问并等待回复（ask_user_question 用） */
  askUser?: {
    send: (text: string) => Promise<void>;
    wait: () => Promise<string>;
  };
}

/** @deprecated Use ChannelCallbacks instead */
export type FeishuChannelCallbacks = ChannelCallbacks;

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  workingDirectory: string;
  conversationHistory: any[];
  sessionId?: string;
  surface?: ToolSurface;
  permissionProfile?: ToolPermissionProfile;
  runId?: string;
  abortSignal?: AbortSignal;
  activeSkillName?: string;
  allowedToolNames?: string[];
  blockedToolNames?: string[];
  /** 平台通道回调（飞书/CatsCompany 等聊天会话时由平台层注入） */
  channel?: ChannelCallbacks;
}

/**
 * 工具接口
 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: any, context: ToolExecutionContext): Promise<string>;
}

/**
 * 工具执行器接口 — ConversationRunner 依赖此抽象
 * ToolManager 和 AgentToolExecutor 均实现此接口
 */
export interface ToolExecutor {
  getToolDefinitions(allowedNames?: string[]): ToolDefinition[];
  executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>
  ): Promise<ToolResult>;
}

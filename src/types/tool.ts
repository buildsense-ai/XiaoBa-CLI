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

export type ToolSurface = 'cli' | 'feishu' | 'agent' | 'research' | 'unknown';
export type ToolPermissionProfile = 'strict' | 'default' | 'relaxed';

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

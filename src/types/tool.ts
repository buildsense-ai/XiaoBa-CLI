/**
 * 工具参数定义
 */
export interface ToolParameter {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
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
}

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  workingDirectory: string;
  conversationHistory: any[];
}

/**
 * 工具接口
 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: any, context: ToolExecutionContext): Promise<string>;
}

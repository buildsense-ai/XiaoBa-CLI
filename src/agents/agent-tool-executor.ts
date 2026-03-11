import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from '../types/tool';

const TOOL_NAME_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  shell: 'execute_shell',
  execute_bash: 'execute_shell',
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

/**
 * AgentToolExecutor - 轻量适配器
 * 将 Tool[] 包装为 ToolExecutor 接口，供 ConversationRunner 在 Agent/SubAgent 内部使用
 */
export class AgentToolExecutor implements ToolExecutor {
  constructor(
    private tools: Tool[],
    private workingDirectory: string,
    private contextDefaults: Partial<ToolExecutionContext> = {},
  ) {}

  getToolDefinitions(): ToolDefinition[] {
    return this.tools.map(t => t.definition);
  }

  async executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const requestedName = toolCall.function.name;
    const name = normalizeToolName(requestedName);
    const tool = this.tools.find(t => t.definition.name === name);

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: requestedName,
        content: `错误：未找到工具 "${requestedName}"`,
        ok: false,
        errorCode: 'TOOL_NOT_FOUND',
        retryable: false,
      };
    }

    try {
      const context: ToolExecutionContext = {
        workingDirectory: this.workingDirectory,
        conversationHistory: conversationHistory || [],
        ...this.contextDefaults,
        ...contextOverrides,
      };

      let args: unknown;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (error: any) {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: requestedName,
          content: `工具参数解析错误: ${error.message}`,
          ok: false,
          errorCode: 'INVALID_TOOL_ARGUMENTS',
          retryable: false,
        };
      }

      const output = await tool.execute(args, context);

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: requestedName,
        content: output,
        ok: true,
        controlSignal: tool.definition.controlMode,
      };
    } catch (error: any) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: requestedName,
        content: `工具执行错误: ${error.message}`,
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        retryable: false,
      };
    }
  }
}

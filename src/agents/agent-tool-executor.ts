import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from '../types/tool';

/**
 * AgentToolExecutor - 轻量适配器
 * 将 AgentContext.tools (Tool[]) 包装为 ToolExecutor 接口
 * 供 ConversationRunner 在 Agent 内部使用
 */
export class AgentToolExecutor implements ToolExecutor {
  constructor(
    private tools: Tool[],
    private workingDirectory: string,
    private contextDefaults: Partial<ToolExecutionContext> = {},
  ) {}

  getToolDefinitions(allowedNames?: string[]): ToolDefinition[] {
    if (!allowedNames || allowedNames.length === 0) {
      return this.tools.map(t => t.definition);
    }
    const allowed = new Set(allowedNames);
    return this.tools
      .filter(t => allowed.has(t.definition.name))
      .map(t => t.definition);
  }

  async executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const name = toolCall.function.name;

    const allowedSet = contextOverrides?.allowedToolNames
      ? new Set(contextOverrides.allowedToolNames)
      : null;
    const blockedSet = contextOverrides?.blockedToolNames
      ? new Set(contextOverrides.blockedToolNames)
      : null;

    if (allowedSet && !allowedSet.has(name)) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name,
        content: `执行被阻止：工具 "${name}" 不在当前 skill 允许列表中`,
        ok: false,
        errorCode: 'TOOL_NOT_ALLOWED_BY_SKILL_POLICY',
        retryable: false,
      };
    }

    if (blockedSet && blockedSet.has(name)) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name,
        content: `执行被阻止：工具 "${name}" 被当前 skill 明确禁止`,
        ok: false,
        errorCode: 'TOOL_BLOCKED_BY_SKILL_POLICY',
        retryable: false,
      };
    }

    const tool = this.tools.find(t => t.definition.name === name);

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name,
        content: `错误：未找到工具 "${name}"`,
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
          name,
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
        name,
        content: output,
        ok: true,
      };
    } catch (error: any) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name,
        content: `工具执行错误: ${error.message}`,
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        retryable: false,
      };
    }
  }
}

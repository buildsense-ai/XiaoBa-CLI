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

  async executeTool(toolCall: ToolCall, conversationHistory?: any[]): Promise<ToolResult> {
    const name = toolCall.function.name;
    const tool = this.tools.find(t => t.definition.name === name);

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name,
        content: `错误：未找到工具 "${name}"`,
      };
    }

    try {
      const context: ToolExecutionContext = {
        workingDirectory: this.workingDirectory,
        conversationHistory: conversationHistory || [],
      };
      const args = JSON.parse(toolCall.function.arguments);
      const output = await tool.execute(args, context);

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name,
        content: output,
      };
    } catch (error: any) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name,
        content: `工具执行错误: ${error.message}`,
      };
    }
  }
}

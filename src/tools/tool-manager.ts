import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from '../types/tool';
import { Logger } from '../utils/logger';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { ShellTool } from './bash-tool';
import { EditTool } from './edit-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { SkillTool } from './skill-tool';
import { SendFileTool } from './send-file-tool';
import { ThinkingTool } from './thinking-tool';
import { SendTextTool } from './send-text-tool';
import { SpawnSubagentTool } from './spawn-subagent-tool';
import { CheckSubagentTool } from './check-subagent-tool';
import { StopSubagentTool } from './stop-subagent-tool';
import { ResumeSubagentTool } from './resume-subagent-tool';

/**
 * 工具名别名映射（Claude Code 工具名 → XiaoBa 内部注册名）
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  execute_bash: 'execute_shell',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
};

function resolveToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

/**
 * 工具管理器 - 管理所有可用的工具
 */
export class ToolManager implements ToolExecutor {
  private tools: Map<string, Tool> = new Map();
  private workingDirectory: string;
  private contextDefaults: Partial<ToolExecutionContext>;

  constructor(
    workingDirectory: string = process.cwd(),
    contextDefaults: Partial<ToolExecutionContext> = {},
  ) {
    this.workingDirectory = workingDirectory;
    this.contextDefaults = contextDefaults;
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    // 基础文件工具 (6)
    this.registerTool(new ReadTool());
    this.registerTool(new WriteTool());
    this.registerTool(new EditTool());
    this.registerTool(new GlobTool());
    this.registerTool(new GrepTool());
    this.registerTool(new ShellTool());

    // 通信工具 (2)
    this.registerTool(new SendTextTool());
    this.registerTool(new SendFileTool());

    // 元工具 (2)
    this.registerTool(new ThinkingTool());
    this.registerTool(new SpawnSubagentTool());

    // Sub-Agent 管理 (2)
    this.registerTool(new CheckSubagentTool());
    this.registerTool(new StopSubagentTool());
    this.registerTool(new ResumeSubagentTool());

    // Skill 调用 (1)
    this.registerTool(new SkillTool());
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  setContextDefaults(contextDefaults: Partial<ToolExecutionContext>): void {
    this.contextDefaults = {
      ...this.contextDefaults,
      ...contextDefaults,
    };
  }

  /**
   * 获取所有工具定义（直接返回全部，不再过滤）
   */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.definition);
  }

  /**
   * 执行工具调用
   */
  async executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const toolName = resolveToolName(toolCall.function.name);
    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolName,
        content: `错误：未找到工具 "${toolName}"`,
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
          name: toolCall.function.name,
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
        name: toolCall.function.name,
        content: output,
        ok: true,
        controlSignal: tool.definition.controlMode,
      };
    } catch (error: any) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: `工具执行错误: ${error.message}`,
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        retryable: false,
      };
    }
  }

  getToolCount(): number {
    return this.tools.size;
  }

  getTool<T extends Tool = Tool>(name: string): T | undefined {
    return this.tools.get(name) as T | undefined;
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }
}

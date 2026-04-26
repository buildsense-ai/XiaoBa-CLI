import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { ShellTool } from './bash-tool';
import { EditTool } from './edit-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { SkillTool } from './skill-tool';
import { SendFileTool } from './send-file-tool';
import { SendTextTool } from './send-text-tool';
import { SendToInspectorTool } from './send-to-inspector-tool';
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

function isRateLimitLikeMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('rate limit')
    || lower.includes('too many requests')
    || lower.includes('频率受限')
    || lower.includes('限流')
    || /(status(?:\s*code)?|http(?:\s*status)?|错误码|code)\s*[:=]?\s*429\b/i.test(message)
    || /\b429\b.{0,24}(too many requests|rate limit|频率受限|限流)/i.test(message)
    || /(too many requests|rate limit|频率受限|限流).{0,24}\b429\b/i.test(message);
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
    this.registerTool(new SendToInspectorTool());

    // 元工具
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

      // 失败结果：统一走 ok=false 分支
      if (!output.ok) {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: output.message,
          ok: false,
          errorCode: output.errorCode,
          retryable: output.retryable ?? isRateLimitLikeMessage(output.message),
        };
      }

      // 成功结果：处理特殊返回格式（如图片需要额外消息）
      if (typeof output.content === 'object') {
        const contentObj = output.content as Record<string, any>;
        if ('_imageForNewMessage' in contentObj && contentObj._imageForNewMessage === true) {
          // 图片读取结果：从内部结构提取 imageBlock，生成额外消息
          return {
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolCall.function.name,
            content: contentObj.filePath
              ? `文件: ${contentObj.filePath}\n类型: 图片\n[图片内容已附加]`
              : '[图片内容已附加]',
            ok: true,
            controlSignal: tool.definition.controlMode,
            newMessages: contentObj.imageBlock ? [contentObj.imageBlock] : [],
          };
        }
      }

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: output.content,
        ok: true,
        controlSignal: tool.definition.controlMode,
      };
    } catch (error: any) {
      const message = String(error?.message || error || '');
      const isRateLimit = isRateLimitLikeMessage(message);
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: `工具执行错误: ${message}`,
        ok: false,
        errorCode: isRateLimit ? 'RATE_LIMIT' : 'TOOL_EXECUTION_ERROR',
        retryable: isRateLimit,
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

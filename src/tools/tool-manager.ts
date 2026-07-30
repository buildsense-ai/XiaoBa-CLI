import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor, ToolExecutionResult } from '../types/tool';
import { Logger } from '../utils/logger';
import { getStructuredRateLimitErrorCode } from '../utils/rate-limit-error';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { ShellTool } from './bash-tool';
import { EditTool } from './edit-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { CommonDirectoryTool } from './common-directory-tool';
import { SkillTool } from './skill-tool';
import { SendFileTool } from './send-file-tool';
import { ImportFileTool } from './import-file-tool';
import { SendTextTool } from './send-text-tool';
import { SpawnSubagentTool } from './spawn-subagent-tool';
import { CheckSubagentTool } from './check-subagent-tool';
import { WaitSubagentsTool } from './wait-subagents-tool';
import { StopSubagentTool } from './stop-subagent-tool';
import { ResumeSubagentTool } from './resume-subagent-tool';
import { UpdatePlanTool } from './update-plan-tool';
import { RecordDecisionTool } from './record-decision-tool';
import { ShareSkillHubSkillTool } from './share-skillhub-skill-tool';
import { SkillHubTool } from './skillhub-tool';
import { AskParentTool } from './ask-parent-tool';
import { DEFAULT_TOOL_NAMES } from './default-tool-names';
import { mergeToolExecutionContext } from '../utils/tool-context';
import { confirmLocalToolExecution } from './local-tool-risk';
import { buildToolTargetContext, operationForToolTargetContext } from './tool-target-context';

const INTERNAL_TOOL_NAMES = ['ask_parent'] as const;
const LEGACY_DISABLED_TOOL_NAMES = ['prompt_mode'] as const;

/**
 * 工具名别名映射（Claude Code 工具名 → CatsCo 内部注册名）
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
export interface ToolManagerOptions {
  enabledToolNames?: readonly string[];
}

export class ToolManager implements ToolExecutor {
  private tools: Map<string, Tool> = new Map();
  private workingDirectory: string;
  private contextDefaults: Partial<ToolExecutionContext>;

  constructor(
    workingDirectory: string = process.cwd(),
    contextDefaults: Partial<ToolExecutionContext> = {},
    options: ToolManagerOptions = {},
  ) {
    this.workingDirectory = workingDirectory;
    this.contextDefaults = contextDefaults;
    this.registerDefaultTools(options.enabledToolNames);
  }

  private registerDefaultTools(enabledToolNames?: readonly string[]): void {
    const enabled = enabledToolNames ? new Set(enabledToolNames) : undefined;
    const defaultTools: Tool[] = [
      new ReadTool(),
      new WriteTool(),
      new EditTool(),
      new GlobTool(),
      new GrepTool(),
      new CommonDirectoryTool(),
      new ShellTool(),
      new SendTextTool(),
      new SendFileTool(),
      new ImportFileTool(),
      new SpawnSubagentTool(),
      new CheckSubagentTool(),
      new WaitSubagentsTool(),
      new StopSubagentTool(),
      new ResumeSubagentTool(),
      new UpdatePlanTool(),
      new RecordDecisionTool(),
      new ShareSkillHubSkillTool(),
      new SkillHubTool(),
      new SkillTool(),
    ];

    for (const tool of defaultTools) {
      if (enabled && !enabled.has(tool.definition.name)) continue;
      this.registerTool(tool);
    }

    if (enabled) {
      if (enabled.has('ask_parent')) {
        this.registerTool(new AskParentTool());
      }
      const knownTools = new Set<string>([
        ...(DEFAULT_TOOL_NAMES as readonly string[]),
        ...(INTERNAL_TOOL_NAMES as readonly string[]),
        ...(LEGACY_DISABLED_TOOL_NAMES as readonly string[]),
      ]);
      for (const toolName of enabled) {
        if (!knownTools.has(toolName)) {
          Logger.warning(`未知工具已被忽略: ${toolName}`);
        }
      }
    }
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

  getWorkspaceRoot(): string {
    return this.workingDirectory;
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
      const mergedContext = mergeToolExecutionContext({
        workingDirectory: this.workingDirectory,
        workspaceRoot: this.workingDirectory,
        conversationHistory: conversationHistory || [],
        ...this.contextDefaults,
      }, contextOverrides);
      const context: ToolExecutionContext = {
        ...mergedContext,
        workingDirectory: mergedContext.getCurrentDirectory?.() || mergedContext.workingDirectory || this.workingDirectory,
        workspaceRoot: mergedContext.workspaceRoot || this.workingDirectory,
        conversationHistory: mergedContext.conversationHistory || conversationHistory || [],
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

      const confirmation = await confirmLocalToolExecution(toolName, args, context);
      if (confirmation) {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: confirmation.ok ? confirmation.content : confirmation.message,
          ok: confirmation.ok,
          errorCode: confirmation.ok ? undefined : confirmation.errorCode,
          retryable: confirmation.ok ? undefined : confirmation.retryable,
        };
      }

      const output = await tool.execute(args, context);
      const targetContext = output.targetContext || buildToolTargetContext(context, {
        toolName,
        operation: operationForToolTargetContext(toolName),
        cwd: resolveTargetContextCwd(toolName, args, context.workingDirectory),
      });

      // 失败结果：统一走 ok=false 分支
      if (!output.ok) {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: output.message,
          targetContext,
          ok: false,
          errorCode: output.errorCode,
          retryable: output.retryable ?? false,
        };
      }

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: output.content,
        targetContext,
        ok: true,
        controlSignal: tool.definition.controlMode,
      };
    } catch (error: any) {
      const message = String(error?.message || error || '');
      const rateLimitErrorCode = getStructuredRateLimitErrorCode(error);
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: `工具执行错误: ${message}`,
        ok: false,
        errorCode: rateLimitErrorCode || 'TOOL_EXECUTION_ERROR',
        retryable: Boolean(rateLimitErrorCode),
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

function resolveTargetContextCwd(toolName: string, args: unknown, currentDirectory: string): string {
  if (toolName !== 'execute_shell' || !args || typeof args !== 'object') {
    return currentDirectory;
  }
  const cwd = (args as Record<string, unknown>).cwd;
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : currentDirectory;
}

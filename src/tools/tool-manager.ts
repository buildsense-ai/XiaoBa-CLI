import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from '../types/tool';
import { Logger } from '../utils/logger';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { ShellTool } from './bash-tool';
import { EditTool } from './edit-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { TaskPlannerTool } from './task-planner-tool';
import { TodoWriteTool } from './todo-write-tool';
import { EnterPlanModeTool } from './enter-plan-mode-tool';
import { ExitPlanModeTool } from './exit-plan-mode-tool';
import { AskUserQuestionTool } from './ask-user-question-tool';
import { TaskTool } from './task-tool';
import { TaskOutputTool } from './task-output-tool';
import { TaskStopTool } from './task-stop-tool';
import { SkillTool } from './skill-tool';
import { WebSearchTool } from './web-search-tool';
import { WebFetchTool } from './web-fetch-tool';

import { SpawnSubagentTool } from './spawn-subagent-tool';
import { CheckSubagentTool } from './check-subagent-tool';
import { StopSubagentTool } from './stop-subagent-tool';
import { ResumeSubagentTool } from './resume-subagent-tool';

import * as path from 'path';
import { loadGlobalPythonTools } from './python-tool-loader';

/**
 * Claude Code → XiaoBa 工具名映射
 * 让引用 Claude Code 工具名的 skill 能在 XiaoBa 中正常运行
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  'Bash': 'execute_bash',
  'Read': 'read_file',
  'Write': 'write_file',
  'Edit': 'edit_file',
  'Glob': 'glob',
  'Grep': 'grep',
  'TodoWrite': 'todo_write',
  'Task': 'task',
  'WebFetch': 'web_fetch',
  'WebSearch': 'web_search',
};

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

  /**
   * 注册默认工具
   */
  private registerDefaultTools(): void {
    // 注册基础工具
    this.registerTool(new ReadTool());
    this.registerTool(new WriteTool());
    this.registerTool(new EditTool());
    this.registerTool(new GlobTool());
    this.registerTool(new GrepTool());
    this.registerTool(new ShellTool());

    // 注册任务管理工具
    this.registerTool(new TaskPlannerTool());
    this.registerTool(new TodoWriteTool());

    // 注册工作流工具
    this.registerTool(new EnterPlanModeTool());
    this.registerTool(new ExitPlanModeTool());
    this.registerTool(new AskUserQuestionTool());

    // 注册网络工具
    this.registerTool(new WebSearchTool());
    this.registerTool(new WebFetchTool());

    // 注册 Skill 工具
    this.registerTool(new SkillTool());


    // 注册子智能体工具
    this.registerTool(new SpawnSubagentTool());
    this.registerTool(new CheckSubagentTool());
    this.registerTool(new StopSubagentTool());
    this.registerTool(new ResumeSubagentTool());

    // 注册多智能体系统工具
    this.registerTool(new TaskTool());
    this.registerTool(new TaskOutputTool());
    this.registerTool(new TaskStopTool());

    // 注册全局 Python 工具（tools/global/*_tool.py）
    this.registerGlobalPythonTools();
  }

  /**
   * 扫描 tools/global/ 并注册所有 Python 工具
   */
  private registerGlobalPythonTools(): void {
    try {
      // 项目根目录：从 src/tools/ 向上两级
      const projectRoot = path.resolve(__dirname, '..', '..');
      const pythonTools = loadGlobalPythonTools(projectRoot);
      for (const tool of pythonTools) {
        this.registerTool(tool);
      }
    } catch (err: any) {
      // 加载失败不阻塞启动
      Logger.warning(`[ToolManager] 全局 Python 工具加载失败: ${err.message}`);
    }
  }

  /**
   * 注册工具
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  /**
   * 更新默认执行上下文（session/surface/run 等）
   */
  setContextDefaults(contextDefaults: Partial<ToolExecutionContext>): void {
    this.contextDefaults = {
      ...this.contextDefaults,
      ...contextDefaults,
    };
  }

  /**
   * 将工具名解析为 XiaoBa 内部注册名（兼容 Claude Code 别名）
   */
  static resolveToolName(name: string): string {
    return TOOL_NAME_ALIASES[name] ?? name;
  }

  /**
   * 批量解析工具名列表
   */
  private static resolveToolNames(names: string[]): string[] {
    return names.map(n => ToolManager.resolveToolName(n));
  }

  /**
   * 获取所有工具定义（用于传递给 AI）
   */
  getToolDefinitions(allowedNames?: string[]): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    if (!allowedNames || allowedNames.length === 0) {
      return all.map(tool => tool.definition);
    }
    const allowed = new Set(ToolManager.resolveToolNames(allowedNames));
    return all.filter(t => allowed.has(t.definition.name)).map(t => t.definition);
  }

  /**
   * 执行工具调用
   * @param toolCall 工具调用请求
   * @param conversationHistory 可选的对话历史，传递给工具作为上下文
   */
  async executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    // 解析别名：Claude Code 工具名 → XiaoBa 内部名
    const toolName = ToolManager.resolveToolName(toolCall.function.name);

    // 先做 skill 策略层的强制校验，避免仅靠提示词约束
    // 策略列表也做别名解析，兼容 Claude Code 格式的 allowed-tools / disallowed-tools
    const allowedSet = contextOverrides?.allowedToolNames
      ? new Set(ToolManager.resolveToolNames(contextOverrides.allowedToolNames))
      : null;
    const blockedSet = contextOverrides?.blockedToolNames
      ? new Set(ToolManager.resolveToolNames(contextOverrides.blockedToolNames))
      : null;

    if (allowedSet && !allowedSet.has(toolName)) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolName,
        content: `执行被阻止：工具 "${toolName}" 不在当前 skill 允许列表中`,
        ok: false,
        errorCode: 'TOOL_NOT_ALLOWED_BY_SKILL_POLICY',
        retryable: false,
      };
    }

    if (blockedSet && blockedSet.has(toolName)) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolName,
        content: `执行被阻止：工具 "${toolName}" 被当前 skill 明确禁止`,
        ok: false,
        errorCode: 'TOOL_BLOCKED_BY_SKILL_POLICY',
        retryable: false,
      };
    }

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

  /**
   * 批量执行工具调用
   */
  async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      const result = await this.executeTool(toolCall);
      results.push(result);
    }

    return results;
  }

  /**
   * 获取工具数量
   */
  getToolCount(): number {
    return this.tools.size;
  }

  /**
   * 获取工具实例
   */
  getTool<T extends Tool = Tool>(name: string): T | undefined {
    return this.tools.get(name) as T | undefined;
  }

  /**
   * 检查工具是否存在
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取所有工具实例
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }
}

import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from '../types/tool';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { BashTool } from './bash-tool';
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
import { CreateSkillTool } from './create-skill-tool';
import { PythonToolLoader } from './python-tool-loader';

/**
 * 工具管理器 - 管理所有可用的工具
 */
export class ToolManager implements ToolExecutor {
  private tools: Map<string, Tool> = new Map();
  private workingDirectory: string;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
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
    this.registerTool(new BashTool());

    // 注册任务管理工具
    this.registerTool(new TaskPlannerTool());
    this.registerTool(new TodoWriteTool());

    // 注册工作流工具
    this.registerTool(new EnterPlanModeTool());
    this.registerTool(new ExitPlanModeTool());
    this.registerTool(new AskUserQuestionTool());

    // 注册 Skill 工具
    this.registerTool(new SkillTool());
    this.registerTool(new CreateSkillTool());

    // 注册多智能体系统工具
    this.registerTool(new TaskTool());
    this.registerTool(new TaskOutputTool());
    this.registerTool(new TaskStopTool());

    // 加载并注册 Python 工具
    this.loadPythonTools();
  }

  /**
   * 加载 Python 工具
   */
  private loadPythonTools(): void {
    try {
      const loader = new PythonToolLoader(this.workingDirectory);
      const pythonTools = loader.loadTools();

      for (const tool of pythonTools) {
        this.registerTool(tool);
      }

      if (pythonTools.length > 0) {
        console.log(`已加载 ${pythonTools.length} 个 Python 工具`);
      }
    } catch (error: any) {
      console.warn(`加载 Python 工具失败: ${error.message}`);
    }
  }

  /**
   * 注册工具
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  /**
   * 获取所有工具定义（用于传递给 AI）
   */
  getToolDefinitions(allowedNames?: string[]): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    if (!allowedNames || allowedNames.length === 0) {
      return all.map(tool => tool.definition);
    }
    const allowed = new Set(allowedNames);
    return all.filter(t => allowed.has(t.definition.name)).map(t => t.definition);
  }

  /**
   * 执行工具调用
   * @param toolCall 工具调用请求
   * @param conversationHistory 可选的对话历史，传递给工具作为上下文
   */
  async executeTool(toolCall: ToolCall, conversationHistory?: any[]): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.function.name);

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: `错误：未找到工具 "${toolCall.function.name}"`
      };
    }

    try {
      const context: ToolExecutionContext = {
        workingDirectory: this.workingDirectory,
        conversationHistory: conversationHistory || []
      };

      const args = JSON.parse(toolCall.function.arguments);
      const output = await tool.execute(args, context);

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: output
      };
    } catch (error: any) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: `工具执行错误: ${error.message}`
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

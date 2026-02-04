import { Tool, ToolDefinition, ToolCall, ToolResult, ToolExecutionContext } from '../types/tool';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { BashTool } from './bash-tool';
import { PythonToolLoader } from './python-tool-loader';

/**
 * 工具管理器 - 管理所有可用的工具
 */
export class ToolManager {
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
    // 注册 TypeScript 工具
    this.registerTool(new ReadTool());
    this.registerTool(new WriteTool());
    this.registerTool(new BashTool());

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
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.definition);
  }

  /**
   * 执行工具调用
   */
  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
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
        conversationHistory: []
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
   * 检查工具是否存在
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}

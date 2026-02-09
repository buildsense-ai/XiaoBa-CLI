import { Agent, AgentConfig, AgentContext, AgentResult, AgentStatus, AgentType } from '../types/agent';
import { Logger } from '../utils/logger';
import { AIService } from '../utils/ai-service';
import { ConfigManager } from '../utils/config';
import { ChatConfig } from '../types';
import { ToolDefinition } from '../types/tool';

/**
 * Agent 基类
 * 提供 Agent 的基础功能实现
 */
export abstract class BaseAgent implements Agent {
  public readonly id: string;
  public readonly type: AgentType;
  public status: AgentStatus = 'idle';
  public readonly config: AgentConfig;

  protected output: string = '';
  protected startTime?: number;
  protected aiService?: AIService;

  constructor(id: string, config: AgentConfig) {
    this.id = id;
    this.type = config.type;
    this.config = config;
  }

  /**
   * 执行 Agent 任务
   */
  async execute(context: AgentContext): Promise<AgentResult> {
    this.status = 'running';
    this.startTime = Date.now();
    this.output = '';

    try {
      // 初始化 AI 服务（继承全局配置）
      const overrides = this.buildModelOverride();
      this.aiService = new AIService(overrides);

      // 执行具体的 Agent 逻辑
      const result = await this.executeTask(context);

      this.status = 'completed';
      return {
        agentId: this.id,
        status: this.status,
        output: result,
        executionTime: Date.now() - this.startTime,
      };
    } catch (error) {
      this.status = 'failed';
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`Agent ${this.id} 执行失败: ${errorMessage}`);

      return {
        agentId: this.id,
        status: this.status,
        output: this.output,
        error: errorMessage,
        executionTime: Date.now() - (this.startTime || Date.now()),
      };
    }
  }

  /**
   * 停止 Agent 执行
   */
  async stop(): Promise<void> {
    if (this.status === 'running') {
      this.status = 'stopped';
      Logger.info(`Agent ${this.id} 已停止`);
    }
  }

  /**
   * 获取 Agent 输出
   */
  getOutput(): string {
    return this.output;
  }

  /**
   * 子类需要实现的具体任务执行逻辑
   */
  protected abstract executeTask(context: AgentContext): Promise<string>;

  /**
   * 构建模型覆盖配置（仅在 Anthropic 模式下应用）
   */
  protected buildModelOverride(): Partial<ChatConfig> {
    const config = ConfigManager.getConfig();
    if (config.provider !== 'anthropic' || !this.config.model) {
      return {};
    }

    const modelMap: Record<string, string> = {
      sonnet: 'claude-sonnet-4-5-20250929',
      opus: 'claude-opus-4-5-20251101',
      haiku: 'claude-3-5-haiku-20241022'
    };

    const mapped = modelMap[this.config.model];
    if (!mapped) {
      return {};
    }

    return { model: mapped };
  }

  /**
   * 构建工具定义列表
   */
  protected buildToolDefinitions(context: AgentContext, allowedToolNames?: string[]): ToolDefinition[] {
    if (!allowedToolNames || allowedToolNames.length === 0) {
      return context.tools.map(tool => tool.definition);
    }

    const allowedSet = new Set(allowedToolNames);
    return context.tools
      .filter(tool => allowedSet.has(tool.definition.name))
      .map(tool => tool.definition);
  }

  /**
   * 添加输出内容
   */
  protected appendOutput(content: string): void {
    this.output += content;
  }

  /**
   * 执行工具调用
   * 从 AgentContext 中查找并执行对应的工具
   */
  protected async executeToolCall(toolCall: any, context: AgentContext): Promise<string> {
    const name = toolCall?.function?.name || toolCall?.name;
    let input: any = {};
    if (toolCall?.function?.arguments) {
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = {};
      }
    } else if (toolCall?.input) {
      input = toolCall.input;
    }

    try {
      if (!name) {
        return '错误：无效的工具调用（缺少工具名称）';
      }

      // 从 context.tools 中找到对应的工具
      const tool = context.tools.find(t => t.definition.name === name);

      if (!tool) {
        Logger.error(`Agent ${this.id}: 未找到工具 ${name}`);
        return `错误：未找到工具 "${name}"`;
      }

      Logger.info(`Agent ${this.id}: 执行工具 ${name}`);

      // 执行工具
      const result = await tool.execute(input, {
        workingDirectory: context.workingDirectory,
        conversationHistory: context.conversationHistory
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`Agent ${this.id}: 工具 ${name} 执行失败: ${errorMessage}`);
      return `工具执行失败: ${errorMessage}`;
    }
  }
}

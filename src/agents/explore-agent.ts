import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';

/**
 * Explore Agent - 快速代码库探索智能体
 * 专门用于搜索文件、理解代码结构、回答关于代码库的问题
 */
export class ExploreAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    Logger.info(`Explore Agent ${this.id} 开始执行任务`);

    const systemPrompt = this.buildSystemPrompt(context);
    const toolExecutor = this.createToolExecutor(context, ['glob', 'grep', 'read_file']);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    const result = await this.runConversation(messages, toolExecutor, {
      maxTurns: this.config.maxTurns ?? 10,
    });

    this.appendOutput(result.response);
    Logger.info(`Explore Agent ${this.id} 完成任务`);
    return this.output;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `你是一个代码库探索专家智能体。你的任务是快速探索代码库，搜索文件和代码，理解代码结构。

工作目录: ${context.workingDirectory}

你可以使用以下工具：
- Glob: 使用 glob 模式搜索文件（如 "**/*.ts"）
- Grep: 搜索代码内容（支持正则表达式）
- Read: 读取文件内容

工作原则：
1. 使用 Glob 快速定位文件
2. 使用 Grep 搜索代码模式
3. 使用 Read 深入理解代码
4. 提供清晰、结构化的探索结果
5. 专注于回答用户的问题，不要执行修改操作

请高效地完成探索任务，并提供有价值的洞察。`;
  }}

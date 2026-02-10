import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';

/**
 * Plan Agent - 规划制定智能体
 * 专门用于设计实现方案、制定执行计划
 */
export class PlanAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    Logger.info(`Plan Agent ${this.id} 开始执行任务`);

    const systemPrompt = this.buildSystemPrompt(context);
    const toolExecutor = this.createToolExecutor(context, ['glob', 'grep', 'read_file']);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    const result = await this.runConversation(messages, toolExecutor, {
      maxTurns: this.config.maxTurns ?? 15,
    });

    this.appendOutput(result.response);
    Logger.info(`Plan Agent ${this.id} 完成任务`);
    return this.output;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `你是一个软件架构和规划专家智能体。你的任务是设计实现方案、制定详细的执行计划。

工作目录: ${context.workingDirectory}

你可以使用以下工具：
- Glob: 搜索文件以了解项目结构
- Grep: 搜索代码以理解现有实现
- Read: 读取文件以深入理解代码

工作原则：
1. 充分探索代码库，理解现有架构
2. 识别关键文件和依赖关系
3. 考虑架构权衡和最佳实践
4. 制定清晰、可执行的步骤计划
5. 标识潜在风险和注意事项
6. 只做规划，不执行实际的代码修改

输出格式：
- 提供结构化的实现计划
- 列出需要修改的关键文件
- 说明每个步骤的目的和方法
- 标注潜在的技术难点

请制定详细、可行的实现计划。`;
  }
}

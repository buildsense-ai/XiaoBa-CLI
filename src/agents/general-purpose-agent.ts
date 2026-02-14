import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';

/**
 * General Purpose Agent - 通用智能体
 * 可以处理各种复杂的多步骤任务
 */
export class GeneralPurposeAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    Logger.info(`General Purpose Agent ${this.id} 开始执行任务`);

    const systemPrompt = this.buildSystemPrompt(context);
    const toolExecutor = this.createToolExecutor(context, [
      'glob', 'grep', 'read_file', 'edit_file', 'write_file', 'execute_shell'
    ]);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    const result = await this.runConversation(messages, toolExecutor, {
      maxTurns: this.config.maxTurns ?? 30,
    });

    this.appendOutput(result.response);
    Logger.info(`General Purpose Agent ${this.id} 完成任务`);
    return this.output;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `你是一个通用智能体，可以处理各种复杂的多步骤任务。

工作目录: ${context.workingDirectory}

你可以使用以下工具：
- Glob: 搜索文件
- Grep: 搜索代码内容
- Read: 读取文件
- Edit: 编辑文件
- Write: 写入文件
- Shell: 执行命令

工作原则：
1. 充分理解任务需求
2. 制定清晰的执行计划
3. 使用合适的工具完成任务
4. 提供详细的执行反馈
5. 处理错误并进行适当的重试
6. 确保代码质量和安全性

请高效、专业地完成任务。`;
  }
}

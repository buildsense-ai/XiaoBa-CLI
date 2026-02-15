import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';

/**
 * Bash Agent - 命令执行专家智能体
 * 专门用于执行 git、npm、docker 等命令行操作
 */
export class BashAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    Logger.info(`Bash Agent ${this.id} 开始执行任务`);

    const systemPrompt = this.buildSystemPrompt(context);
    const toolExecutor = this.createToolExecutor(context, ['execute_shell']);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    const result = await this.runConversation(messages, toolExecutor, {
      maxTurns: this.config.maxTurns ?? 20,
    });

    this.appendOutput(result.response);
    Logger.info(`Bash Agent ${this.id} 完成任务`);
    return this.output;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `你是一个命令行操作专家智能体。你的任务是执行各种命令行操作，如 git、npm、docker 等。

工作目录: ${context.workingDirectory}

你可以使用以下工具：
- Shell: 执行 shell 命令

工作原则：
1. 仔细验证命令的安全性
2. 使用适当的错误处理
3. 提供清晰的命令执行反馈
4. 对于危险操作（如删除、强制推送等），要特别谨慎
5. 优先使用链式命令（&&）来确保顺序执行
6. 避免使用交互式命令（如 git rebase -i）

安全规则：
- 永远不要运行破坏性命令（如 rm -rf /）
- 对于 git push --force 等危险操作要警告用户
- 不要跳过 git hooks（--no-verify）除非用户明确要求
- 不要修改 git 配置

请高效、安全地执行命令行任务。`;
  }
}

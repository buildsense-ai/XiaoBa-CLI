import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';
import { ToolDefinition } from '../types/tool';

/**
 * Bash Agent - 命令执行专家智能体
 * 专门用于执行 git、npm、docker 等命令行操作
 */
export class BashAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    if (!this.aiService) {
      throw new Error('AIService 未初始化');
    }

    Logger.info(`Bash Agent ${this.id} 开始执行任务`);

    // 构建系统提示
    const systemPrompt = this.buildSystemPrompt(context);

    // 构建工具列表
    const tools = this.buildTools(context);

    // 执行对话循环
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    let turnCount = 0;
    const maxTurns = this.config.maxTurns || 20;

    while (turnCount < maxTurns && this.status === 'running') {
      turnCount++;

      try {
        const response = await this.aiService.chat(messages, tools);

        if (response.toolCalls && response.toolCalls.length > 0) {
          if (response.content) {
            this.appendOutput(response.content + '\n');
          }

          messages.push({
            role: 'assistant',
            content: response.content,
            tool_calls: response.toolCalls
          });

          for (const toolCall of response.toolCalls) {
            const toolResult = await this.executeToolCall(toolCall, context);

            messages.push({
              role: 'tool',
              content: toolResult,
              tool_call_id: toolCall.id,
              name: toolCall.function.name
            });
          }

          continue;
        }

        if (response.content) {
          this.appendOutput(response.content + '\n');
        }
        break;
      } catch (error) {
        Logger.error(`Bash Agent ${this.id} 执行出错: ${error}`);
        throw error;
      }
    }

    Logger.info(`Bash Agent ${this.id} 完成任务，执行了 ${turnCount} 轮`);
    return this.output;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `你是一个命令行操作专家智能体。你的任务是执行各种命令行操作，如 git、npm、docker 等。

工作目录: ${context.workingDirectory}

你可以使用以下工具：
- Bash: 执行 bash 命令

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

  /**
   * 构建工具列表
   */
  private buildTools(context: AgentContext): ToolDefinition[] {
    return this.buildToolDefinitions(context, ['execute_bash']);
  }
}

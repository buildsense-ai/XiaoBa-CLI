import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';
import { ToolDefinition } from '../types/tool';

/**
 * General Purpose Agent - 通用智能体
 * 可以处理各种复杂的多步骤任务
 */
export class GeneralPurposeAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    if (!this.aiService) {
      throw new Error('AIService 未初始化');
    }

    Logger.info(`General Purpose Agent ${this.id} 开始执行任务`);

    // 构建系统提示
    const systemPrompt = this.buildSystemPrompt(context);

    // 构建工具列表（通用智能体可以使用所有工具）
    const tools = this.buildTools(context);

    // 执行对话循环
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    let turnCount = 0;
    const maxTurns = this.config.maxTurns || 30;

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
        Logger.error(`General Purpose Agent ${this.id} 执行出错: ${error}`);
        throw error;
      }
    }

    Logger.info(`General Purpose Agent ${this.id} 完成任务，执行了 ${turnCount} 轮`);
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
- Bash: 执行命令

工作原则：
1. 充分理解任务需求
2. 制定清晰的执行计划
3. 使用合适的工具完成任务
4. 提供详细的执行反馈
5. 处理错误并进行适当的重试
6. 确保代码质量和安全性

请高效、专业地完成任务。`;
  }

  /**
   * 构建工具列表
   */
  private buildTools(context: AgentContext): ToolDefinition[] {
    return this.buildToolDefinitions(context, [
      'glob',
      'grep',
      'read_file',
      'edit_file',
      'write_file',
      'execute_bash'
    ]);
  }
}

import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';
import { ToolDefinition } from '../types/tool';

/**
 * Code Reviewer Agent - 代码审查智能体
 * 专门用于审查代码质量、发现问题、提供改进建议
 */
export class CodeReviewerAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    if (!this.aiService) {
      throw new Error('AIService 未初始化');
    }

    Logger.info(`Code Reviewer Agent ${this.id} 开始执行任务`);

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
    const maxTurns = this.config.maxTurns || 15;

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
        Logger.error(`Code Reviewer Agent ${this.id} 执行出错: ${error}`);
        throw error;
      }
    }

    Logger.info(`Code Reviewer Agent ${this.id} 完成任务，执行了 ${turnCount} 轮`);
    return this.output;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `你是一个代码审查专家智能体。你的任务是审查代码质量、发现潜在问题、提供改进建议。

工作目录: ${context.workingDirectory}

你可以使用以下工具：
- Glob: 搜索需要审查的文件
- Grep: 搜索特定的代码模式
- Read: 读取代码文件
- Bash: 运行测试和检查工具

审查重点：
1. 代码质量和可读性
2. 潜在的 bug 和错误处理
3. 性能问题
4. 安全漏洞（SQL注入、XSS、命令注入等）
5. 最佳实践和设计模式
6. 测试覆盖率
7. 文档完整性

审查原则：
- 提供建设性的反馈
- 指出具体的问题位置
- 给出改进建议和示例
- 区分严重问题和优化建议
- 认可好的代码实践

输出格式：
- 总体评价
- 发现的问题列表（按严重程度分类）
- 具体的改进建议
- 代码示例（如果需要）

请进行专业、全面的代码审查。`;
  }

  /**
   * 构建工具列表
   */
  private buildTools(context: AgentContext): ToolDefinition[] {
    return this.buildToolDefinitions(context, ['glob', 'grep', 'read_file', 'execute_bash']);
  }
}

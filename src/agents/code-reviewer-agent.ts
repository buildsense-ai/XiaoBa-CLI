import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';

/**
 * Code Reviewer Agent - 代码审查智能体
 * 专门用于审查代码质量、发现问题、提供改进建议
 */
export class CodeReviewerAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    Logger.info(`Code Reviewer Agent ${this.id} 开始执行任务`);

    const systemPrompt = this.buildSystemPrompt(context);
    const toolExecutor = this.createToolExecutor(context, ['glob', 'grep', 'read_file', 'execute_bash']);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    const result = await this.runConversation(messages, toolExecutor, {
      maxTurns: this.config.maxTurns ?? 15,
    });

    this.appendOutput(result.response);
    Logger.info(`Code Reviewer Agent ${this.id} 完成任务`);
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
}

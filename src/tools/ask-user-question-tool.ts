import * as readline from 'readline';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { styles } from '../theme/colors';

/**
 * AskUserQuestion 工具 - 向用户提问
 *
 * 统一使用纯文本消息形式提问，用户自由回复。
 * 支持 CLI（readline）和飞书（消息收发）两种输入通道。
 */
export class AskUserQuestionTool implements Tool {
  /** 飞书模式会话通道（按 sessionId 隔离） */
  private feishuChannels = new Map<string, {
    sendFn: (text: string) => Promise<void>;
    waitFn: () => Promise<string>;
  }>();

  /** 绑定飞书通道 */
  bindFeishuSession(
    sessionId: string,
    sendFn: (text: string) => Promise<void>,
    waitFn: () => Promise<string>,
  ): void {
    this.feishuChannels.set(sessionId, { sendFn, waitFn });
  }

  /** 兼容旧调用 */
  bindFeishu(
    sendFn: (text: string) => Promise<void>,
    waitFn: () => Promise<string>,
  ): void {
    this.bindFeishuSession('default', sendFn, waitFn);
  }

  /** 解绑飞书通道 */
  unbindFeishuSession(sessionId: string): void {
    this.feishuChannels.delete(sessionId);
  }

  /** 兼容旧调用 */
  unbindFeishu(): void {
    this.unbindFeishuSession('default');
  }

  private isFeishuMode(sessionId: string): boolean {
    return this.feishuChannels.has(sessionId);
  }

  definition: ToolDefinition = {
    name: 'ask_user_question',
    description: '向用户提问并获取回复。用于需要用户提供信息、确认方向或做决策时。直接用自然语言提问，用户自由回复。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题，用自然语言表述，清晰具体'
        }
      },
      required: ['question']
    }
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { question } = args;
    const sessionId = _context.sessionId || 'default';

    if (!question || typeof question !== 'string') {
      return '错误：question 必须是非空字符串';
    }

    try {
      const answer = await this.getAnswer(question, sessionId);
      return `用户回复: ${answer}`;
    } catch (error: any) {
      return `提问失败: ${error.message}`;
    }
  }

  /**
   * 获取用户回复（自动选择通道）
   */
  private async getAnswer(question: string, sessionId: string): Promise<string> {
    if (this.isFeishuMode(sessionId)) {
      const channel = this.feishuChannels.get(sessionId)!;
      await channel.sendFn(question);
      return await channel.waitFn();
    }

    // CLI 模式：打印问题，readline 等待输入
    console.log('\n' + styles.title('❓ 提问') + '\n');
    console.log(styles.text(question) + '\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise<string>((resolve) => {
      rl.question(styles.highlight('请回复: '), (input) => {
        rl.close();
        resolve(input.trim());
      });
    });
  }
}

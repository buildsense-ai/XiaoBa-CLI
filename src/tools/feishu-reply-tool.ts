import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * 飞书回复工具
 * 允许 AI 在处理过程中主动给用户发消息（如确认、进度、结果）
 *
 * chatId 和 sender 由 FeishuBot 在每次消息处理前动态注入
 */
export class FeishuReplyTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_reply',
    description: '给老师发一条飞书消息。用于回复确认、发送中间结果等。',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '要发送的消息内容',
        },
      },
      required: ['message'],
    },
  };

  private chatId: string | null = null;
  private sendFn: ((chatId: string, text: string) => Promise<void>) | null = null;

  /**
   * 绑定当前会话的 chatId 和发送函数
   */
  bind(chatId: string, sendFn: (chatId: string, text: string) => Promise<void>): void {
    this.chatId = chatId;
    this.sendFn = sendFn;
  }

  /**
   * 解绑（消息处理完毕后调用）
   */
  unbind(): void {
    this.chatId = null;
    this.sendFn = null;
  }

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { message } = args;

    if (!this.chatId || !this.sendFn) {
      return '当前不在飞书会话中，无法发送消息';
    }

    if (!message || typeof message !== 'string') {
      return '消息内容不能为空';
    }

    try {
      await this.sendFn(this.chatId, message);
      Logger.info(`[feishu_reply] 已发送: ${message.slice(0, 50)}...`);
      return '消息已发送';
    } catch (err: any) {
      Logger.error(`[feishu_reply] 发送失败: ${err.message}`);
      return `发送失败: ${err.message}`;
    }
  }
}

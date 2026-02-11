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

  private sessions = new Map<string, {
    chatId: string;
    sendFn: (chatId: string, text: string) => Promise<void>;
  }>();

  /**
   * 绑定当前会话的 chatId 和发送函数
   */
  bindSession(sessionId: string, chatId: string, sendFn: (chatId: string, text: string) => Promise<void>): void {
    this.sessions.set(sessionId, { chatId, sendFn });
  }

  /**
   * 兼容旧调用
   */
  bind(chatId: string, sendFn: (chatId: string, text: string) => Promise<void>): void {
    this.bindSession('default', chatId, sendFn);
  }

  /**
   * 解绑（消息处理完毕后调用）
   */
  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 兼容旧调用
   */
  unbind(): void {
    this.unbindSession('default');
  }

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { message } = args;
    const sessionId = _context.sessionId || 'default';
    const session = this.sessions.get(sessionId);

    if (!session) {
      return '当前不在飞书会话中，无法发送消息';
    }

    if (!message || typeof message !== 'string') {
      return '消息内容不能为空';
    }

    try {
      await session.sendFn(session.chatId, message);
      Logger.info(`[feishu_reply] 已发送: ${message.slice(0, 50)}...`);
      return '消息已发送';
    } catch (err: any) {
      Logger.error(`[feishu_reply] 发送失败: ${err.message}`);
      return `发送失败: ${err.message}`;
    }
  }
}

import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * 消息发送工具
 * 允许 AI 在处理过程中主动给用户发消息（如确认、进度、结果）
 *
 * chatId 和 sender 由适配层在每次消息处理前动态注入
 */
export class SendMessageTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_message',
    description: '给用户发一条消息。这是聊天会话中用户唯一能看到的文本通道。每轮对话最多调用一次，发完后直接结束本轮推理。',
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
      return '当前不在聊天会话中，无法发送消息';
    }

    if (!message || typeof message !== 'string') {
      return '消息内容不能为空';
    }

    try {
      await session.sendFn(session.chatId, message);
      Logger.info(`[send_message] 已发送: ${message.slice(0, 50)}...`);
      return '消息已发送给用户。如果你的消息包含提问或需要用户确认，应该停止执行，等待用户回复。';
    } catch (err: any) {
      Logger.error(`[send_message] 发送失败: ${err.message}`);
      return `发送失败: ${err.message}`;
    }
  }
}

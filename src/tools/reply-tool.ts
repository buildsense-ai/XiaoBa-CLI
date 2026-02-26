import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * 回复工具（平台通用）
 * 允许 AI 在处理过程中主动给用户发消息（如确认、进度、结果）
 *
 * 发送能力通过 ToolExecutionContext.channel 注入，无需 bind/unbind。
 */
export class ReplyTool implements Tool {
  definition: ToolDefinition = {
    name: 'reply',
    description: '给用户发一条消息。用于回复确认、发送中间结果等。',
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

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { message } = args;
    const channel = context.channel;

    if (!channel) {
      return '当前不在聊天会话中，无法发送消息';
    }

    if (!message || typeof message !== 'string') {
      return '消息内容不能为空';
    }

    try {
      await channel.reply(channel.chatId, message);
      Logger.info(`[reply] 已发送: ${message.slice(0, 50)}...`);
      return '消息已发送';
    } catch (err: any) {
      Logger.error(`[reply] 发送失败: ${err.message}`);
      return `发送失败: ${err.message}`;
    }
  }
}

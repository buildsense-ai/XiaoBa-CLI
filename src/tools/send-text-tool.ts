import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * send_text 工具
 * 发送一条文本消息给用户
 */
export class SendTextTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_text',
    description: '发送一条文本消息给用户。如果内容较长（超过 150 字），应该分成多段，多次调用此工具发送，每段 50-150 字。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发送的文本内容。建议每条 50-150 字，保持语义完整。',
        },
      },
      required: ['text'],
    },
  };

  async execute(args: { text: string }, context: ToolExecutionContext): Promise<string> {
    const { text } = args;

    if (!context.channel) {
      throw new Error('send_text 需要 channel 上下文');
    }

    if (!text || !text.trim()) {
      throw new Error('text 不能为空');
    }

    const chatId = context.channel.chatId;
    await context.channel.reply(chatId, text.trim());

    return `已发送`;
  }
}

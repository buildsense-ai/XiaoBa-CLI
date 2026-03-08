import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * send_by_segments 工具
 * 用于分段发送长消息，避免一次性输出超长文本
 */
export class SendSegmentsTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_by_segments',
    description: '分段发送长消息。当回复内容超过 200 字时使用此工具，将内容拆成多个语义完整的段落逐条发送，提升用户阅读体验。',
    parameters: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: { type: 'string' },
          description: '消息段落数组。每段应为 50-200 字的完整段落，保持语义独立可读。总共 2-5 段为宜。',
        },
      },
      required: ['segments'],
    },
  };

  async execute(args: { segments: string[] }, context: ToolExecutionContext): Promise<string> {
    const { segments } = args;

    if (!context.channel) {
      throw new Error('send_by_segments 需要 channel 上下文');
    }

    if (!segments || segments.length === 0) {
      throw new Error('segments 不能为空');
    }

    const chatId = context.channel.chatId;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i].trim();
      if (!segment) continue;

      await context.channel.reply(chatId, segment);

      // 段间间隔，避免消息过快
      if (i < segments.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    return `已分 ${segments.length} 段发送完成`;
  }
}

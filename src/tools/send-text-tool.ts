import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { resolveOutboundTarget } from './outbound-gateway';

/**
 * send_text 工具
 * 发送一条文本消息给用户
 */
export class SendTextTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_text',
    description: '发送一条文本消息给用户。如果内容较长（超过 150 字），应该分成多段，多次调用此工具发送，每段 50-150 字。',
    transcriptMode: 'outbound_message',
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

  async execute(args: { text: string }, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { text } = args;

    if (!text || !text.trim()) {
      throw new Error('text 不能为空');
    }

    const target = resolveOutboundTarget(context, {
      operation: 'send_text',
      missingChannelMessage: 'send_text 需要 channel 上下文',
    });
    if (!target.ok) {
      return {
        ok: false,
        errorCode: target.errorCode,
        message: target.message,
      };
    }

    await context.channel!.reply(target.chatId, text.trim());

    return { ok: true, content: '已发送' };
  }
}

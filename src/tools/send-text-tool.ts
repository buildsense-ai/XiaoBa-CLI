import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { resolveOutboundTarget } from './outbound-gateway';

/**
 * send_text 工具
 * 发送一条文本消息给用户
 */
export class SendTextTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_text',
    description: [
      '发送一条简短文本消息给用户。',
      '优先用于结论、确认、进度说明和一句话交付提示。',
      '不要把完整报告、长表格、长代码或长篇分析拆成多条 send_text 刷屏；这类内容应先用 write_file 生成 HTML/Markdown/CSV 等文件，再用 send_file 发给用户。',
    ].join('\n'),
    transcriptMode: 'outbound_message',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发送的简短文本内容。保持语义完整，适合在聊天气泡中快速扫读。',
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

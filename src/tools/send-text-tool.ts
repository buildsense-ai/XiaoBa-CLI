import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { resolveOutboundTarget } from './outbound-gateway';

const SHIMO_AUTHORIZATION_PATH = /\/connect\/shimo\/[^/?#\s]+\/?$/i;
const TRAILING_URL_PUNCTUATION = /[\u3001\u3002\uFF0C\uFF01\uFF1F\uFF1B\uFF1A\u300D\u300B\u3009\u300B\u3005\u0029\u005D\u007D.,!?;:]+$/u;

function containsShimoAuthorizationUrl(text: string): boolean {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  return candidates.some(candidate => {
    const trimmed = candidate.replace(TRAILING_URL_PUNCTUATION, '');
    try {
      return SHIMO_AUTHORIZATION_PATH.test(new URL(trimmed).pathname);
    } catch {
      return false;
    }
  });
}

/**
 * send_text 工具
 * 发送一条文本消息给用户
 */
export class SendTextTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_text',
    description: [
      '向当前聊天会话发送一条用户可见的文本消息。',
      '只用于需要通过平台通道主动外发消息的 runtime；普通最终回复可以直接作为 assistant 内容返回。',
      '传入完整文本即可；聊天通道只会在超过平台单条消息长度限制时切分，不要为了分条而重复调用。',
      '只代表普通文本已发送；不要用它声称文件、附件、预览、HTML 报告或其他富媒体产物已经生成或交付。',
      '不要用它记录内部笔记、计划或工具结果。',
    ].join('\n'),
    transcriptMode: 'outbound_message',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发送给当前聊天会话的完整文本内容。',
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

    // A Shimo authorization URL is a handoff to the user. End this model turn
    // immediately after delivery so a follow-up status check cannot overwrite
    // or hide the link in clients that merge consecutive assistant messages.
    const controlSignal = containsShimoAuthorizationUrl(text.trim())
      ? 'pause_turn' as const
      : undefined;

    return controlSignal
      ? { ok: true, content: '已发送', controlSignal }
      : { ok: true, content: '已发送' };
  }
}

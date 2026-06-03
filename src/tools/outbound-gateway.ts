import type { ToolErrorCode, ToolExecutionContext } from '../types/tool';

export type OutboundOperation = 'send_text' | 'send_file';

export type OutboundTargetDecision =
  | { ok: true; chatId: string }
  | { ok: false; errorCode: ToolErrorCode; message: string };

interface ResolveOutboundTargetOptions {
  operation: OutboundOperation;
  missingChannelMessage: string;
}

const UNKNOWN_TOPIC_ID = 'unknown_topic';

export function resolveOutboundTarget(
  context: ToolExecutionContext,
  options: ResolveOutboundTargetOptions,
): OutboundTargetDecision {
  const channel = context.channel;
  if (!channel) {
    return {
      ok: false,
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: options.missingChannelMessage,
    };
  }

  const channelChatId = normalizeId(channel.chatId);
  const scope = context.executionScope;
  if (!scope) {
    if (!channelChatId) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '当前聊天会话缺少目标 chatId，无法发送消息',
      };
    }
    return { ok: true, chatId: channelChatId };
  }

  const scopeTopicId = normalizeId(scope.topicId);
  const scopeSessionKey = normalizeId(scope.sessionKey);
  const contextSessionId = normalizeId(context.sessionId);
  if (context.surface === 'catscompany'
    && scopeSessionKey
    && contextSessionId
    && scopeSessionKey !== contextSessionId) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: [
        '执行会话与当前执行身份不一致，已停止发送以避免串线。',
        `Scope session: ${scopeSessionKey}`,
        `Context session: ${contextSessionId}`,
      ].join('\n'),
    };
  }

  const hasKnownScopeTopic = Boolean(scopeTopicId && scopeTopicId !== UNKNOWN_TOPIC_ID);
  if (hasKnownScopeTopic && channelChatId && channelChatId !== scopeTopicId) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: [
        '外发目标与当前执行身份不一致，已停止发送以避免串线。',
        `Scope topic: ${scopeTopicId}`,
        `Channel chatId: ${channelChatId}`,
      ].join('\n'),
    };
  }

  if (options.operation === 'send_file' && scope.identityTrust === 'untrusted') {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: '当前消息身份未通过服务端一致性校验，暂不允许发送文件。',
    };
  }

  const targetChatId = hasKnownScopeTopic ? scopeTopicId : channelChatId;
  if (!targetChatId) {
    return {
      ok: false,
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: '当前执行身份和聊天通道都缺少目标 topic，无法发送消息',
    };
  }

  return { ok: true, chatId: targetChatId };
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

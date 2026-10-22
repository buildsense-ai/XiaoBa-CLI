import { ContentBlock } from '../types';

/**
 * 出队时把多条排队消息拼成一次注入的内容。
 *
 * 每条消息入队前已经由 `prefixCatsUserMessage` 加上 `[发言人: 名字（人/bot）]`
 * 前缀——和当前回合的消息格式完全一致。所以这里只负责拼接，不再另加
 * `序号. usr42:` 这类编号：编号既重复了前缀，又用原始 uid 顶替了可读身份，
 * 与历史回填、云端恢复等路径的格式不统一，模型看到的同一群消息会有两种长相。
 */
export interface QueuedMessageContent {
  userMessage: string | ContentBlock[];
}

export function mergeQueuedMessageContents(
  messages: QueuedMessageContent[],
): string | ContentBlock[] {
  if (messages.length === 1) {
    return messages[0].userMessage;
  }

  const header = [
    `在你处理上一轮时，又有 ${messages.length} 条消息到达。`,
    '请把它们与当前任务一并考虑；如果前后要求冲突，以最后一条为准。',
  ].join('\n');

  const hasRichContent = messages.some(item => Array.isArray(item.userMessage));
  if (!hasRichContent) {
    const body = messages
      .map(item => String(item.userMessage))
      .join('\n\n');
    return `${header}\n\n${body}`;
  }

  const blocks: ContentBlock[] = [{ type: 'text', text: `${header}\n` }];
  for (const item of messages) {
    if (Array.isArray(item.userMessage)) {
      blocks.push(...item.userMessage);
    } else {
      blocks.push({ type: 'text', text: `\n${item.userMessage}` });
    }
  }

  return blocks;
}

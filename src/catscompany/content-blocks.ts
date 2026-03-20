/**
 * 从 conversation runner 的 newMessages 中提取 ContentBlock 数组，
 * 用于 code mode 的 working process 展示。
 *
 * 映射规则：
 * - assistant.content（有 tool_calls 时）→ thinking block
 * - assistant.tool_calls[i]              → tool_use block
 * - tool message                         → tool_result block
 * - thinking 工具调用                     → thinking block（提取 content 参数）
 * - 最终 assistant.content（无 tool_calls）不提取（属于最终回复）
 */

import { Message } from '../types';

/** 与后端 types.ContentBlock 对齐 */
export interface CatsContentBlock {
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const TOOL_RESULT_MAX_LEN = 2000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `...(${s.length} chars)`;
}

export function extractContentBlocks(newMessages: Message[]): CatsContentBlock[] {
  const blocks: CatsContentBlock[] = [];

  for (const msg of newMessages) {
    if (msg.role === 'assistant') {
      const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

      // assistant 的文本内容（有 tool_calls 时视为 thinking）
      if (hasToolCalls && msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        blocks.push({ type: 'thinking', thinking: msg.content.trim() });
      }

      // tool_calls → tool_use blocks
      if (hasToolCalls) {
        for (const tc of msg.tool_calls!) {
          const name = tc.function.name;

          // thinking 工具特殊处理：提取为 thinking block
          if (name === 'thinking') {
            try {
              const args = JSON.parse(tc.function.arguments);
              blocks.push({ type: 'thinking', thinking: args.content || args.text || '' });
            } catch {
              blocks.push({ type: 'thinking', thinking: tc.function.arguments });
            }
            continue;
          }

          // 普通工具 → tool_use block
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = { raw: tc.function.arguments };
          }
          blocks.push({ type: 'tool_use', id: tc.id, name, input });
        }
      }

      // 最终回复（无 tool_calls）不提取，属于 message content
    } else if (msg.role === 'tool') {
      // 跳过 thinking 工具的 result（无意义）
      if (msg.name === 'thinking') continue;

      const content = typeof msg.content === 'string'
        ? truncate(msg.content, TOOL_RESULT_MAX_LEN)
        : msg.content;

      blocks.push({
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content,
      });
    }
  }

  return blocks;
}

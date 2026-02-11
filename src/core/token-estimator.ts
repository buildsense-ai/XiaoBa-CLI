import { Message } from '../types';
import { ToolDefinition } from '../types/tool';

/**
 * Token 估算器
 *
 * 不追求精确（精确需要 tiktoken 等库，增加依赖），
 * 只需要量级正确，用于判断"是否该压缩了"。
 *
 * 估算规则（基于 cl100k_base tokenizer 实测）：
 * - 英文/代码：~4 chars/token
 * - CJK（中日韩）：~1.5 chars/token（一个汉字通常独占 1 token）
 * - 分开统计，避免中文场景下严重低估
 */

/** 匹配 CJK 统一表意文字 + 常用标点 */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;

const ENGLISH_CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.5;
const JSON_CHARS_PER_TOKEN = 3.5;

/**
 * 估算单段文本的 token 数
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 统计 CJK 字符数
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = text.length - cjkCount;

  return Math.ceil(
    cjkCount / CJK_CHARS_PER_TOKEN + nonCjkCount / ENGLISH_CHARS_PER_TOKEN
  );
}

/**
 * 估算单条消息的 token 数（含 role、content、tool_calls）
 */
export function estimateMessageTokens(message: Message): number {
  let tokens = 4; // 每条消息的固定开销（role 标记等）

  if (message.content) {
    tokens += estimateTokens(message.content);
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      tokens += estimateTokens(tc.function.name);
      tokens += estimateTokens(tc.function.arguments);
      tokens += 4; // tool_call 结构开销
    }
  }

  if (message.name) {
    tokens += estimateTokens(message.name);
  }

  return tokens;
}

/**
 * 估算整个消息数组的 token 数
 */
export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * 估算 JSON 结构的 token 数
 */
export function estimateJsonTokens(value: unknown): number {
  try {
    const json = JSON.stringify(value ?? {});
    if (!json) return 0;
    return Math.ceil(json.length / JSON_CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

/**
 * 估算单个工具定义的 token 数
 */
export function estimateToolTokens(tool: ToolDefinition): number {
  const nameTokens = estimateTokens(tool.name || '');
  const descriptionTokens = estimateTokens(tool.description || '');
  const schemaTokens = estimateJsonTokens(tool.parameters);

  // 工具定义在不同 provider 有额外结构化开销，留 10% 安全余量
  const raw = nameTokens + descriptionTokens + schemaTokens + 12;
  return Math.ceil(raw * 1.1);
}

/**
 * 估算所有工具定义的 token 数
 */
export function estimateToolsTokens(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
}

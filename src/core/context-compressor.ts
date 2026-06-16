import { Message, ContentBlock } from '../types';
import { AIService } from '../utils/ai-service';
import { estimateMessagesTokens, estimateTokens } from './token-estimator';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';
import { DEFAULT_PROMPTS_DIR, readPromptFile, renderPromptTemplate } from '../utils/prompt-template';

const COMPACT_BOUNDARY_PREFIX = '[compact_boundary]';

/** 摘要内容的 token 预算（给 LLM 留足够空间） */
const SUMMARY_CONTENT_BUDGET = 50000;

/**
 * 将消息内容转为可读字符串
 */
export function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '[图片]';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

/**
 * 将 session 消息列表转换为用于压缩的文本表示
 */
export function messagesToConversationText(messages: Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = contentToString(msg.content);
      lines.push(`[用户] ${text}`);
    } else if (msg.role === 'assistant') {
      const text = contentToString(msg.content);
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCalls = msg.tool_calls.map(tc => {
          let argsObj: Record<string, unknown> = {};
          try {
            argsObj = JSON.parse(tc.function.arguments || '{}');
          } catch {}
          return `工具调用: ${tc.function.name}(${JSON.stringify(argsObj)})`;
        }).join(', ');
        lines.push(`[AI] ${text || '(无文本输出)'}。${toolCalls}`);
      } else if (text) {
        lines.push(`[AI] ${text}`);
      }
    } else if (msg.role === 'tool') {
      const text = contentToString(msg.content);
      const name = msg.name || 'unknown';
      lines.push(`[工具 ${name}] ${text}`);
    }
  }

  return lines.join('\n\n');
}

/**
 * 将单条消息转换为摘要文本（智能截断）
 */
function messageToSummaryText(msg: Message): { text: string; tokens: number } {
  if (msg.role === 'user') {
    // user 消息：完整保留（一般较短）
    const text = contentToString(msg.content);
    return { text: `[用户] ${text}`, tokens: estimateTokens(text) + 10 };
  }

  if (msg.role === 'assistant') {
    const text = contentToString(msg.content);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // assistant + tool_calls：保留文字 + 工具签名
      const toolCalls = msg.tool_calls.map(tc => {
        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = JSON.parse(tc.function.arguments || '{}');
        } catch {}
        return `工具调用: ${tc.function.name}(${JSON.stringify(argsObj)})`;
      }).join(', ');
      const fullText = `[AI] ${text || '(无文本输出)'}。${toolCalls}`;
      return { text: fullText, tokens: estimateTokens(fullText) + 10 };
    }
    return { text: `[AI] ${text}`, tokens: estimateTokens(text) + 10 };
  }

  if (msg.role === 'tool') {
    // tool 消息：智能截断长文本，保留关键信息
    const text = contentToString(msg.content);
    const name = msg.name || 'unknown';
    const tokens = estimateTokens(text);

    if (tokens <= 300) {
      // 短文本：完整保留
      return { text: `[工具 ${name}] ${text}`, tokens: tokens + 10 };
    }

    // 长文本：保留关键部分
    const truncated = truncateLongText(text, 600);
    return { text: `[工具 ${name}] ${truncated}`, tokens: estimateTokens(truncated) + 10 };
  }

  return { text: '', tokens: 0 };
}

/**
 * 截断长文本，优先保留文件路径、行号等关键信息
 */
function truncateLongText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  // 尝试提取文件路径
  const filePathMatch = text.match(/\/[\w\-\.\/]+\.\w+/);
  const lineMatch = text.match(/行?\s*[:：]?\s*(\d+)/);

  let prefix = '';
  if (filePathMatch) {
    prefix = `[文件: ${filePathMatch[0]}] `;
  }
  if (lineMatch) {
    prefix += `[行号: ${lineMatch[1]}] `;
  }

  // 保留前缀 + 截断的正文
  const availableChars = maxChars - prefix.length - 30; // 留空间给省略号
  if (availableChars > 100) {
    return prefix + text.slice(0, availableChars) + `\n...[共 ${text.length} 字符]`;
  }

  // 空间不够，只保留前缀
  return prefix + text.slice(0, maxChars - 30) + `\n...[共 ${text.length} 字符]`;
}

function fitTextPrefixToTokenBudget(text: string, budget: number): string {
  const safeBudget = Math.max(0, Math.floor(budget));
  if (safeBudget <= 0 || !text) return '';
  if (estimateTokens(text) <= safeBudget) return text;

  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (estimateTokens(candidate) <= safeBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function truncateTextToTokenBudget(text: string, budget: number): string {
  const safeBudget = Math.max(0, Math.floor(budget));
  if (safeBudget <= 0 || !text) return '';
  if (estimateTokens(text) <= safeBudget) return text;

  const suffix = `\n...[共 ${text.length} 字符]`;
  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid) + suffix;
    if (estimateTokens(candidate) <= safeBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best || fitTextPrefixToTokenBudget(text, safeBudget);
}

/**
 * 按 token 预算从最新消息往前构建摘要文本
 *
 * @param messages 消息数组（已过滤掉 system 消息）
 * @param budget token 预算
 * @returns 摘要文本
 */
export function truncateForSummary(messages: Message[], budget: number = SUMMARY_CONTENT_BUDGET): string {
  const safeBudget = Math.max(0, Math.floor(budget));
  if (safeBudget <= 0) return '';

  // 反序遍历：从最新到最早
  const reversed = [...messages].reverse();
  const result: string[] = [];
  let usedTokens = 0;

  for (const msg of reversed) {
    const { text, tokens } = messageToSummaryText(msg);

    if (usedTokens + tokens > safeBudget) {
      const remainingBudget = safeBudget - usedTokens;
      if (remainingBudget > 0) {
        const truncated = truncateTextToTokenBudget(text, remainingBudget);
        if (truncated) {
          result.push(truncated);
          usedTokens += estimateTokens(truncated);
        }
      }
      break;
    } else {
      result.push(text);
      usedTokens += tokens;
    }
  }

  // 构建最终文本（需要正序）
  const truncatedText = result.reverse().join('\n\n');

  // 如果有跳过的消息，添加标记
  const totalSkipped = messages.length - result.length;
  if (totalSkipped > 0) {
    const marked = `[早期 ${totalSkipped} 条消息已截断，共 ${messages.length} 条消息]\n\n${truncatedText}`;
    return truncateTextToTokenBudget(marked, safeBudget);
  }

  return truncateTextToTokenBudget(truncatedText, safeBudget);
}

/**
 * 生成压缩用的 system prompt
 */
export function buildCompactSystemPrompt(customInstructions?: string): string {
  const template = readPromptFile(DEFAULT_PROMPTS_DIR, 'compact-system.md');
  return renderPromptTemplate(template, {
    customInstructions: customInstructions?.trim(),
  });
}

/**
 * 从 LLM 输出中解析出 <summary> 内容，丢弃 <analysis>
 */
export function parseCompactSummary(raw: string): string {
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  return match ? match[1].trim() : raw.trim();
}

export interface CompactOptions {
  customInstructions?: string;
  signal?: AbortSignal;
}

// ─── ContextCompressor ──────────────────────────────────────

/**
 * ContextCompressor - 上下文压缩器
 *
 * 设计：到达门槛 → 一次 AI 调用整体摘要所有 session 消息 → 替换为一条摘要消息
 *
 * 压缩前: [system: base, user, assistant tu, tool result, ...]
 * 压缩后: [system: base, {boundary}, {summary}, current_input]
 */
export class ContextCompressor {
  private maxContextTokens: number;
  private compactionThreshold: number;
  private summaryContentBudget: number;
  private aiService: AIService;

  constructor(aiService: AIService, options?: {
    maxContextTokens?: number;
    compactionThreshold?: number;
    summaryContentBudget?: number;
  }) {
    this.aiService = aiService;
    this.maxContextTokens = options?.maxContextTokens ?? 128000;
    this.compactionThreshold = options?.compactionThreshold ?? 0.7;
    this.summaryContentBudget = options?.summaryContentBudget ?? SUMMARY_CONTENT_BUDGET;
  }

  /**
   * 检查是否需要压缩
   */
  needsCompaction(messages: Message[]): boolean {
    const used = estimateMessagesTokens(messages);
    const threshold = this.maxContextTokens * this.compactionThreshold;
    return used > threshold;
  }

  /**
   * 获取当前 token 使用情况
   */
  getUsageInfo(messages: Message[]): {
    usedTokens: number;
    maxTokens: number;
    usagePercent: number;
  } {
    const used = estimateMessagesTokens(messages);
    return {
      usedTokens: used,
      maxTokens: this.maxContextTokens,
      usagePercent: Math.round((used / this.maxContextTokens) * 100),
    };
  }

  /**
   * 执行全量压缩
   *
   * 1. 分离 system 消息（不参与压缩）
   * 2. 对全部 session 消息生成摘要
   * 3. 组装: [system..., boundary, summary, current_input]
   *
   * 注意：压缩发生在 handleMessage() 将用户输入 push 之前，
   * 所以 current_input 在 messages 里不存在。
   * 调用方负责在压缩后追加 current_input。
   */
  async compact(
    messages: Message[],
    optionsOrCustomInstructions?: string | CompactOptions,
  ): Promise<Message[]> {
    const options: CompactOptions = typeof optionsOrCustomInstructions === 'string'
      ? { customInstructions: optionsOrCustomInstructions }
      : (optionsOrCustomInstructions || {});
    const before = estimateMessagesTokens(messages);

    const system = messages.filter(m => m.role === 'system');
    const session = messages.filter(m => m.role !== 'system');

    if (session.length === 0) {
      return messages;
    }

    // 按 token 预算从最新消息往前构建摘要文本
    const truncated = truncateForSummary(session, this.summaryContentBudget);

    try {
      const summaryMessages: Message[] = [
        {
          role: 'system',
          content: buildCompactSystemPrompt(options.customInstructions),
        },
        {
          role: 'user',
          content: `Please summarize the following ${session.length} messages:\n\n${truncated}`,
        },
      ];

      // 用流式调用（和正常聊天一致），避免非流式请求在某些 baseURL 下 503
      let fullContent = '';
      const resp = await this.aiService.chatStream(
        summaryMessages,
        undefined, // 不需要 tools
        {
          onText: (text) => { fullContent += text; },
        },
        { signal: options.signal },
      );
      const rawSummary = fullContent;

      if (resp.usage) {
        Metrics.recordAICall('stream', resp.usage);
      }

      const summaryText = parseCompactSummary(rawSummary);

      // 构建压缩边界标记（role: system，标记这是压缩点）
      const boundaryMessage: Message = {
        role: 'system',
        content: `${COMPACT_BOUNDARY_PREFIX} ${session.length} messages summarized. Pre-compact tokens: ${before}`,
      };

      const summaryMessage: Message = {
        role: 'user',
        content: `[以下是之前 ${session.length} 条对话的 AI 摘要]\n\n${summaryText}`,
      };

      // 组装：system + boundary + summary（session 历史已被全量摘要，不再保留）
      const result: Message[] = [
        ...system,
        boundaryMessage,
        summaryMessage,
      ];

      const after = estimateMessagesTokens(result);

      Logger.info(
        `[压缩] ${messages.length} 条 → ${result.length} 条，` +
        `${before} tokens → ${after} tokens（节省 ${Math.round((1 - after / before) * 100)}%）`
      );

      return result;
    } catch (err: any) {
      Logger.error(`[压缩] AI 摘要失败: ${err.message}`);
      throw err;
    }
  }
}

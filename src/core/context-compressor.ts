import { Message, ContentBlock } from '../types';
import { AIService } from '../utils/ai-service';
import { estimateMessagesTokens, estimateTokens } from './token-estimator';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';

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

/**
 * 按 token 预算从最新消息往前构建摘要文本
 *
 * @param messages 消息数组（已过滤掉 system 消息）
 * @param budget token 预算
 * @returns 摘要文本
 */
export function truncateForSummary(messages: Message[], budget: number = SUMMARY_CONTENT_BUDGET): string {
  // 反序遍历：从最新到最早
  const reversed = [...messages].reverse();
  const result: string[] = [];
  let usedTokens = 0;
  let skippedCount = 0;

  for (const msg of reversed) {
    const { text, tokens } = messageToSummaryText(msg);

    if (usedTokens + tokens > budget) {
      // 超出预算
      if (skippedCount === 0) {
        // 只有一条消息就超预算了，强制截断
        const truncated = truncateLongText(text, 500);
        result.push(truncated);
      } else {
        // 多条消息，停止添加
        break;
      }
    } else {
      result.push(text);
      usedTokens += tokens;
    }
    skippedCount++;
  }

  // 构建最终文本（需要正序）
  const truncatedText = result.reverse().join('\n\n');

  // 如果有跳过的消息，添加标记
  const totalSkipped = messages.length - result.length;
  if (totalSkipped > 0) {
    return `[早期 ${totalSkipped} 条消息已截断，共 ${messages.length} 条消息]\n\n${truncatedText}`;
  }

  return truncatedText;
}

// ─── 压缩 Prompt ──────────────────────────────────────────

const COMPACT_NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.`;

/**
 * 生成压缩用的 system prompt
 */
export function buildCompactSystemPrompt(customInstructions?: string): string {
  let prompt = COMPACT_NO_TOOLS_PREAMBLE + '\n\n' + BASE_COMPACT_PROMPT;

  if (customInstructions && customInstructions.trim()) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }

  prompt += `\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block.`;
  return prompt;
}

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages (not tool results) from the conversation.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

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
 * 压缩前: [system: base, system: surface, user, assistant tu, tool result, ...]
 * 压缩后: [system: base, system: surface, {boundary}, {summary}, current_input]
 */
export class ContextCompressor {
  private maxContextTokens: number;
  private compactionThreshold: number;
  private aiService: AIService;

  constructor(aiService: AIService, options?: {
    maxContextTokens?: number;
    compactionThreshold?: number;
  }) {
    this.aiService = aiService;
    this.maxContextTokens = options?.maxContextTokens ?? 128000;
    this.compactionThreshold = options?.compactionThreshold ?? 0.7;
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
    const truncated = truncateForSummary(session, SUMMARY_CONTENT_BUDGET);

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

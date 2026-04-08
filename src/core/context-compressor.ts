import { Message, ContentBlock } from '../types';
import { AIService } from '../utils/ai-service';
import { estimateMessagesTokens } from './token-estimator';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';

const COMPACT_BOUNDARY_PREFIX = '[compact_boundary]';

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
  let pendingToolUses: Array<{ name: string; args: string }> = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = contentToString(msg.content);
      lines.push(`[用户] ${text}`);
      pendingToolUses = [];
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
        pendingToolUses = msg.tool_calls.map(tc => ({
          name: tc.function.name,
          args: tc.function.arguments,
        }));
      } else if (text) {
        lines.push(`[AI] ${text}`);
        pendingToolUses = [];
      }
    } else if (msg.role === 'tool') {
      const text = contentToString(msg.content);
      const name = msg.name || 'unknown';
      // 截断过长的工具输出
      const truncated = text.length > 800
        ? text.slice(0, 800) + `...[共${text.length}字符]`
        : text;
      lines.push(`[工具 ${name}] ${truncated}`);
    }
  }

  return lines.join('\n\n');
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
    customInstructions?: string,
  ): Promise<Message[]> {
    const before = estimateMessagesTokens(messages);

    const system = messages.filter(m => m.role === 'system');
    const session = messages.filter(m => m.role !== 'system');

    if (session.length === 0) {
      return messages;
    }

    // 构造待摘要的对话文本
    const conversationText = messagesToConversationText(session);

    // 单条消息限制 2000 字符，避免摘要 prompt 本身过大
    const truncated = conversationText.length > 2000
      ? conversationText.slice(0, 2000) + `\n...[共${conversationText.length}字符]`
      : conversationText;

    try {
      const summaryMessages: Message[] = [
        {
          role: 'system',
          content: buildCompactSystemPrompt(customInstructions),
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
        }
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

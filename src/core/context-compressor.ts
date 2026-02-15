import { Message } from '../types';
import { AIService } from '../utils/ai-service';
import { estimateMessagesTokens } from './token-estimator';
import { Logger } from '../utils/logger';
import { Metrics } from '../utils/metrics';

/**
 * ContextCompressor - 上下文压缩器
 *
 * 设计：到达门槛 → 一次 AI 调用整体摘要旧对话 → 替换为一条摘要消息
 *
 * 压缩前: [system, user1, asst1, tool1, user2, asst2, tool2, ...]
 * 压缩后: [system, {summary}, ...recent]
 */
export class ContextCompressor {
  private maxContextTokens: number;
  private compactionThreshold: number;
  private aiService: AIService;
  /** 保留最近多少条非 system 消息不压缩 */
  private keepRecentCount: number;

  constructor(aiService: AIService, options?: {
    maxContextTokens?: number;
    compactionThreshold?: number;
    keepRecentCount?: number;
  }) {
    this.aiService = aiService;
    this.maxContextTokens = options?.maxContextTokens ?? 128000;
    this.compactionThreshold = options?.compactionThreshold ?? 0.7;
    this.keepRecentCount = options?.keepRecentCount ?? 6;
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
   * 执行压缩 — 一次 AI 调用，整体摘要旧对话
   *
   * 1. system 消息不动
   * 2. 最近 N 条消息保持原样（AI 当前工作上下文）
   * 3. 中间的旧消息 → 送给 AI 生成一段摘要 → 替换为一条 user 消息
   */
  async compact(messages: Message[]): Promise<Message[]> {
    const before = estimateMessagesTokens(messages);

    const system = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    if (nonSystem.length <= this.keepRecentCount) {
      Logger.info('[压缩] 消息太少，跳过');
      return messages;
    }

    const old = nonSystem.slice(0, -this.keepRecentCount);
    const recent = nonSystem.slice(-this.keepRecentCount);

    if (old.length === 0) {
      return messages;
    }

    // 构造待摘要的对话文本
    const conversationText = old.map(m => {
      const role = m.role === 'user' ? '用户'
        : m.role === 'assistant' ? 'AI'
        : `工具(${m.name || 'unknown'})`;
      const content = m.content || '';
      // 单条消息限制 1500 字符，避免摘要 prompt 本身过大
      const trimmed = content.length > 1500
        ? content.slice(0, 1500) + `...[共${content.length}字符]`
        : content;
      return `[${role}] ${trimmed}`;
    }).join('\n\n');

    try {
      const summaryMessages: Message[] = [
        {
          role: 'system',
          content: '你是一个对话压缩助手。将对话历史压缩为简洁摘要，保留所有关键信息：任务目标、重要发现、关键数据（名称、数字、URL）、已完成的操作、待办事项。去掉冗余的工具调用细节。输出纯文本摘要，不要用 markdown 标题。',
        },
        {
          role: 'user',
          content: `请压缩以下 ${old.length} 条对话消息为简洁摘要：\n\n${conversationText}`,
        },
      ];

      const resp = await this.aiService.chat(summaryMessages);
      const summaryText = resp.content || '';

      if (resp.usage) {
        Metrics.recordAICall('chat', resp.usage);
      }

      const summaryMessage: Message = {
        role: 'user',
        content: `[以下是之前 ${old.length} 条对话的 AI 摘要]\n\n${summaryText}`,
      };

      const result = [...system, summaryMessage, ...recent];
      const after = estimateMessagesTokens(result);

      Logger.info(
        `[压缩] ${messages.length} 条 → ${result.length} 条，` +
        `${before} tokens → ${after} tokens（节省 ${Math.round((1 - after / before) * 100)}%）`
      );

      return result;
    } catch (err: any) {
      // AI 摘要失败，降级为机械截断
      Logger.warning(`[压缩] AI 摘要失败: ${err.message}，降级为机械截断`);
      return this.fallbackTrim(system, old, recent, before);
    }
  }

  /**
   * 降级方案：机械截断（AI 不可用时的兜底）
   */
  private fallbackTrim(
    system: Message[],
    old: Message[],
    recent: Message[],
    beforeTokens: number,
  ): Message[] {
    const trimmed: Message[] = [];
    for (const msg of old) {
      if (msg.role === 'tool') {
        trimmed.push({ ...msg, content: `[工具 ${msg.name || 'unknown'} 的输出已省略]` });
      } else if (msg.role === 'assistant') {
        const content = msg.content || '';
        trimmed.push({
          ...msg,
          content: content.length > 300 ? content.slice(0, 300) + '...' : content,
          tool_calls: undefined,
        });
      } else {
        trimmed.push(msg);
      }
    }

    const result = [...system, ...trimmed, ...recent];
    const after = estimateMessagesTokens(result);
    Logger.info(
      `[压缩-降级] ${system.length + old.length + recent.length} 条 → ${result.length} 条，` +
      `${beforeTokens} tokens → ${after} tokens`
    );
    return result;
  }
}

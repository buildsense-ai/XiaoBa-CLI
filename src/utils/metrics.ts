import { TokenUsage } from '../types';

/** 单次 AI 调用记录 */
interface AICallRecord {
  model: string;
  usage: TokenUsage;
  timestamp: number;
}

/** 单次工具调用记录 */
interface ToolCallRecord {
  name: string;
  durationMs: number;
  timestamp: number;
}

/** Session 级别的汇总 */
export interface MetricsSummary {
  aiCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolDurationMs: number;
  /** 按工具名分组的调用次数和总耗时 */
  toolBreakdown: Record<string, { count: number; totalMs: number }>;
}

/**
 * Metrics - 轻量 metrics 收集器（静态单例）
 *
 * 三层数据：Provider 层（token）→ 工具层（耗时）→ 会话层（汇总）
 */
export class Metrics {
  private static aiCalls: AICallRecord[] = [];
  private static toolCalls: ToolCallRecord[] = [];

  /** 记录一次 AI 调用 */
  static recordAICall(model: string, usage: TokenUsage): void {
    this.aiCalls.push({ model, usage, timestamp: Date.now() });
  }

  /** 记录一次工具执行 */
  static recordToolCall(name: string, durationMs: number): void {
    this.toolCalls.push({ name, durationMs, timestamp: Date.now() });
  }

  /** 获取当前 session 汇总 */
  static getSummary(): MetricsSummary {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;

    for (const call of this.aiCalls) {
      totalPromptTokens += call.usage.promptTokens;
      totalCompletionTokens += call.usage.completionTokens;
      totalTokens += call.usage.totalTokens;
    }

    let toolDurationMs = 0;
    const toolBreakdown: Record<string, { count: number; totalMs: number }> = {};

    for (const call of this.toolCalls) {
      toolDurationMs += call.durationMs;
      if (!toolBreakdown[call.name]) {
        toolBreakdown[call.name] = { count: 0, totalMs: 0 };
      }
      toolBreakdown[call.name].count++;
      toolBreakdown[call.name].totalMs += call.durationMs;
    }

    return {
      aiCalls: this.aiCalls.length,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      toolCalls: this.toolCalls.length,
      toolDurationMs,
      toolBreakdown,
    };
  }

  /** 重置（session 结束时） */
  static reset(): void {
    this.aiCalls = [];
    this.toolCalls = [];
  }
}

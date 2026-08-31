import { TokenUsage } from '../types';

export interface MetricsRecordContext {
  sessionKey?: string;
  candidateId?: string;
  episodeId?: string;
  phase?: string;
  attempt?: number;
  providerRequest?: number;
}

export interface MetricsAICallRecord { model: string; usage: TokenUsage; timestamp: number; context?: MetricsRecordContext; }
export interface MetricsToolCallRecord { name: string; durationMs: number; timestamp: number; }
export type MetricsRecord = MetricsAICallRecord | MetricsToolCallRecord;

interface AICallRecord extends MetricsAICallRecord {}
interface ToolCallRecord extends MetricsToolCallRecord {}

export interface MetricsSummary {
  aiCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCachedReadTokens: number;
  totalCachedWriteTokens: number;
  cacheReadRatio?: number;
  toolCalls: number;
  toolDurationMs: number;
  toolBreakdown: Record<string, { count: number; totalMs: number }>;
}

function summarizeMetrics(aiCalls: AICallRecord[], toolCalls: ToolCallRecord[]): MetricsSummary {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCachedReadTokens = 0;
  let totalCachedWriteTokens = 0;
  for (const call of aiCalls) {
    totalPromptTokens += call.usage.promptTokens;
    totalCompletionTokens += call.usage.completionTokens;
    totalTokens += call.usage.totalTokens;
    totalCachedReadTokens += call.usage.cachedReadTokens ?? 0;
    totalCachedWriteTokens += call.usage.cachedWriteTokens ?? 0;
  }
  let toolDurationMs = 0;
  const toolBreakdown: Record<string, { count: number; totalMs: number }> = {};
  for (const call of toolCalls) {
    toolDurationMs += call.durationMs;
    toolBreakdown[call.name] ??= { count: 0, totalMs: 0 };
    toolBreakdown[call.name].count++;
    toolBreakdown[call.name].totalMs += call.durationMs;
  }
  return {
    aiCalls: aiCalls.length,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalCachedReadTokens,
    totalCachedWriteTokens,
    cacheReadRatio: totalPromptTokens > 0 ? totalCachedReadTokens / totalPromptTokens : undefined,
    toolCalls: toolCalls.length,
    toolDurationMs,
    toolBreakdown,
  };
}

/** Per-session collector: turn reset never removes background usage. */
export class MetricsCollector {
  private aiCalls: AICallRecord[] = [];
  private backgroundAICalls: AICallRecord[] = [];
  private toolCalls: ToolCallRecord[] = [];
  recordAICall(model: string, usage: TokenUsage): void { this.aiCalls.push({ model, usage, timestamp: Date.now() }); }
  recordBackgroundAICall(model: string, usage: TokenUsage, context?: MetricsRecordContext): void { this.backgroundAICalls.push({ model, usage, timestamp: Date.now(), context }); }
  getBackgroundRecords(): ReadonlyArray<Readonly<AICallRecord>> { return this.backgroundAICalls.map(record => ({ ...record, context: record.context && { ...record.context } })); }
  recordToolCall(name: string, durationMs: number): void { this.toolCalls.push({ name, durationMs, timestamp: Date.now() }); }
  getSummary(): MetricsSummary { return summarizeMetrics(this.aiCalls, this.toolCalls); }
  getBackgroundSummary(): MetricsSummary { return summarizeMetrics(this.backgroundAICalls, []); }
  getTotalSummary(): MetricsSummary {
    return summarizeMetrics([...this.aiCalls, ...this.backgroundAICalls], this.toolCalls);
  }
  /** Clear the active turn while preserving background usage already emitted as checkpoint_summary events. */
  reset(): void { this.aiCalls = []; this.toolCalls = []; }
}

/** Backwards-compatible process collector. New code should use MetricsCollector. */
export class Metrics {
  private static collector = new MetricsCollector();
  static recordAICall(model: string, usage: TokenUsage): void { this.collector.recordAICall(model, usage); }
  static recordBackgroundAICall(model: string, usage: TokenUsage, context?: MetricsRecordContext): void { this.collector.recordBackgroundAICall(model, usage, context); }
  static recordToolCall(name: string, durationMs: number): void { this.collector.recordToolCall(name, durationMs); }
  static getSummary(): MetricsSummary { return this.collector.getSummary(); }
  static getBackgroundSummary(): MetricsSummary { return this.collector.getBackgroundSummary(); }
  static getTotalSummary(): MetricsSummary { return this.collector.getTotalSummary(); }
  static reset(): void { this.collector.reset(); }
}

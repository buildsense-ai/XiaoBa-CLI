import { Message } from '../types';
import { estimateTokens } from './token-estimator';

export interface ToolResultContextReportOptions {
  enabled: boolean;
  topTools: number;
  topMessages: number;
}

export interface ToolResultToolSummary {
  name: string;
  count: number;
  chars: number;
  tokens_est: number;
  max_chars: number;
}

export interface ToolResultMessageSummary {
  index: number;
  name: string;
  chars: number;
  tokens_est: number;
}

export interface ToolResultContextSummary {
  tool_result_count: number;
  total_chars: number;
  total_tokens_est: number;
  by_tool: ToolResultToolSummary[];
  largest_messages: ToolResultMessageSummary[];
}

const DEFAULT_OPTIONS: ToolResultContextReportOptions = {
  enabled: true,
  topTools: 5,
  topMessages: 5,
};

export function resolveToolResultContextReportOptions(
  env: NodeJS.ProcessEnv = process.env,
): ToolResultContextReportOptions {
  return {
    enabled: readBooleanEnv(env.XIAOBA_TOOL_RESULT_CONTEXT_REPORT, DEFAULT_OPTIONS.enabled),
    topTools: readPositiveIntegerEnv(
      env.XIAOBA_TOOL_RESULT_CONTEXT_REPORT_TOP_TOOLS,
      DEFAULT_OPTIONS.topTools,
    ),
    topMessages: readPositiveIntegerEnv(
      env.XIAOBA_TOOL_RESULT_CONTEXT_REPORT_TOP_MESSAGES,
      DEFAULT_OPTIONS.topMessages,
    ),
  };
}

export function summarizeToolResultContext(
  messages: Message[],
  options: Partial<Pick<ToolResultContextReportOptions, 'topTools' | 'topMessages'>> = {},
): ToolResultContextSummary {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const tools = new Map<string, ToolResultToolSummary>();
  const largestCandidates: ToolResultMessageSummary[] = [];
  let toolResultCount = 0;
  let totalChars = 0;
  let totalTokens = 0;

  messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    const text = contentForMeasurement(message.content);
    const chars = text.length;
    const tokens = estimateTokens(text);
    const name = normalizeToolName(message.name || 'unknown');
    toolResultCount++;
    totalChars += chars;
    totalTokens += tokens;

    const existing = tools.get(name) || {
      name,
      count: 0,
      chars: 0,
      tokens_est: 0,
      max_chars: 0,
    };
    existing.count++;
    existing.chars += chars;
    existing.tokens_est += tokens;
    existing.max_chars = Math.max(existing.max_chars, chars);
    tools.set(name, existing);

    largestCandidates.push({
      index,
      name,
      chars,
      tokens_est: tokens,
    });
  });

  return {
    tool_result_count: toolResultCount,
    total_chars: totalChars,
    total_tokens_est: totalTokens,
    by_tool: Array.from(tools.values())
      .sort((a, b) => b.chars - a.chars)
      .slice(0, resolved.topTools),
    largest_messages: largestCandidates
      .sort((a, b) => b.chars - a.chars)
      .slice(0, resolved.topMessages),
  };
}

export function formatToolResultContextReport(
  before: ToolResultContextSummary,
  after: ToolResultContextSummary,
): string[] {
  const savedChars = Math.max(0, before.total_chars - after.total_chars);
  const savedTokens = Math.max(0, before.total_tokens_est - after.total_tokens_est);
  return [
    `tool_result context: before=${before.tool_result_count} results/${before.total_chars} chars/${before.total_tokens_est} tokens_est; `
      + `after=${after.tool_result_count} results/${after.total_chars} chars/${after.total_tokens_est} tokens_est; `
      + `saved=${savedChars} chars/${savedTokens} tokens_est`,
    `tool_result top_tools_before: ${formatToolSummaries(before.by_tool)}`,
    `tool_result largest_before: ${formatMessageSummaries(before.largest_messages)}`,
  ];
}

function formatToolSummaries(items: ToolResultToolSummary[]): string {
  if (items.length === 0) return '(none)';
  return items
    .map(item => `${item.name} count=${item.count} chars=${item.chars} max=${item.max_chars}`)
    .join('; ');
}

function formatMessageSummaries(items: ToolResultMessageSummary[]): string {
  if (items.length === 0) return '(none)';
  return items
    .map(item => `#${item.index} ${item.name} chars=${item.chars} tokens_est=${item.tokens_est}`)
    .join('; ');
}

function contentForMeasurement(content: Message['content']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function normalizeToolName(name: string): string {
  const normalized = String(name || '').trim();
  if (['Bash', 'bash', 'Shell', 'shell', 'execute_bash'].includes(normalized)) {
    return 'execute_shell';
  }
  if (normalized === 'Read') return 'read_file';
  return normalized || 'unknown';
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

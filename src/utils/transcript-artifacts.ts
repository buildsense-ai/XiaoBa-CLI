import type { Message } from '../types';

type ToolCall = NonNullable<Message['tool_calls']>[number];

const PROVIDER_REPLAY_PLACEHOLDER_LINE =
  /^\[历史工具调用已完成；provider replay 隐藏内容未写入本地会话。.*\]$/;
const PROVIDER_REPLAY_SUMMARY_PREFIX = '[历史工具调用已转为摘要：';
const PROVIDER_REPLAY_SUMMARY_MARKER =
  /(?:provider replay|thinking replay|缓存缺失)/;
const PROVIDER_REPLAY_TOOL_MARKER = '工具=';
const PROVIDER_REPLAY_ID_MARKER = '，id=';
const PROVIDER_REPLAY_ARGS_MARKER = '，参数=';
const PROVIDER_REPLAY_RESULT_SUMMARY_HEADER = '[历史工具结果摘要]';
const GENERIC_INTERNAL_FAILURE_LINE = /^\[处理失败: .+\]$/;
const MODEL_TIMEOUT_INTERNAL_LINE = /^\[处理中断: 模型中转请求超时。.+\]$/;
const KNOWN_RUNTIME_ERROR_MARKERS =
  /API错误\s*\(\d+\).*[{"]|MaxRetriesExceededError|HTTPSConnectionPool|ConnectTimeoutError|request[_ ]timed[_ ]out|default_request_timeout_in_seconds|upstream request timeout|gateway timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed|bifrost request failed|API密钥未配置|当前模型不支持图片识别/i;

export function contentToText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '[图片]').join('');
}

export function stripAssistantTranscriptArtifacts(text: string): string {
  const lines = text.split(/\r?\n/);
  const nonBlankLines = lines.map(line => line.trim()).filter(Boolean);
  if (nonBlankLines.length === 1 && isInternalRuntimeErrorLine(nonBlankLines[0], true)) {
    return '';
  }

  const keptLines: string[] = [];
  let sawProviderReplayArtifact = false;
  let skippingProviderReplaySummary = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skippingProviderReplaySummary) {
      if (isProviderReplaySummaryEnd(trimmed)) {
        skippingProviderReplaySummary = false;
      }
      continue;
    }
    if (PROVIDER_REPLAY_PLACEHOLDER_LINE.test(trimmed)) {
      sawProviderReplayArtifact = true;
      continue;
    }
    if (
      trimmed.startsWith(PROVIDER_REPLAY_SUMMARY_PREFIX)
      && PROVIDER_REPLAY_SUMMARY_MARKER.test(trimmed)
    ) {
      sawProviderReplayArtifact = true;
      if (!isProviderReplaySummaryEnd(trimmed)) {
        skippingProviderReplaySummary = true;
      }
      continue;
    }
    if (
      trimmed === PROVIDER_REPLAY_RESULT_SUMMARY_HEADER
      && sawProviderReplayArtifact
    ) {
      break;
    }
    keptLines.push(line);
  }

  return keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface RestoredReplayToolCalls {
  visibleText: string;
  toolCalls: ToolCall[];
}

export function restoreProviderReplayToolCalls(
  text: string,
  allowedToolNames: Set<string>,
): RestoredReplayToolCalls {
  const toolCalls: ToolCall[] = [];
  for (const summary of collectProviderReplaySummaries(text)) {
    const toolCall = parseProviderReplaySummaryToolCall(summary);
    if (!toolCall) continue;
    if (!allowedToolNames.has(toolCall.function.name)) continue;
    toolCalls.push(toolCall);
  }

  return {
    visibleText: stripAssistantTranscriptArtifacts(text),
    toolCalls,
  };
}

function collectProviderReplaySummaries(text: string): string[] {
  const summaries: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting) {
      if (
        trimmed.startsWith(PROVIDER_REPLAY_SUMMARY_PREFIX)
        && PROVIDER_REPLAY_SUMMARY_MARKER.test(trimmed)
      ) {
        current = [trimmed];
        if (isProviderReplaySummaryEnd(trimmed)) {
          summaries.push(current.join('\n'));
          current = [];
        } else {
          collecting = true;
        }
      }
      continue;
    }

    current.push(line);
    if (isProviderReplaySummaryEnd(trimmed)) {
      summaries.push(current.join('\n'));
      current = [];
      collecting = false;
    }
  }

  // 未闭合的 replay 摘要不恢复，fail-safe 地当普通文本剥离。
  return summaries;
}

function parseProviderReplaySummaryToolCall(summary: string): ToolCall | null {
  if (!summary.startsWith(PROVIDER_REPLAY_SUMMARY_PREFIX)) return null;
  // Expected: [历史工具调用已转为摘要：... 工具=<name>，id=<id>，参数=<json>]
  const toolMarkerIndex = summary.indexOf(PROVIDER_REPLAY_TOOL_MARKER);
  const idMarkerIndex = summary.indexOf(PROVIDER_REPLAY_ID_MARKER, toolMarkerIndex);
  const argsMarkerIndex = summary.indexOf(PROVIDER_REPLAY_ARGS_MARKER, idMarkerIndex);
  if (toolMarkerIndex < 0 || idMarkerIndex < 0 || argsMarkerIndex < 0) return null;

  const name = summary
    .slice(toolMarkerIndex + PROVIDER_REPLAY_TOOL_MARKER.length, idMarkerIndex)
    .trim();
  const id = summary
    .slice(idMarkerIndex + PROVIDER_REPLAY_ID_MARKER.length, argsMarkerIndex)
    .trim();
  if (!name || !id) return null;

  const argsRaw = summary.slice(argsMarkerIndex + PROVIDER_REPLAY_ARGS_MARKER.length);
  const jsonStart = argsRaw.indexOf('{');
  const jsonEnd = argsRaw.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;

  let args: unknown;
  try {
    args = JSON.parse(argsRaw.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function isProviderReplaySummaryEnd(line: string): boolean {
  if (!line.includes('{')) return line.endsWith(']');
  return /\}\]$/.test(line);
}

function isInternalRuntimeErrorLine(line: string, allowGenericFailure: boolean): boolean {
  if (MODEL_TIMEOUT_INTERNAL_LINE.test(line)) return true;
  if (!GENERIC_INTERNAL_FAILURE_LINE.test(line)) return false;
  return allowGenericFailure || KNOWN_RUNTIME_ERROR_MARKERS.test(line);
}

export function stripAssistantArtifactsFromMessages(messages: Message[]): Message[] {
  const cleaned: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.__internalErrorArtifact) {
      continue;
    }

    if (message.role !== 'assistant' || typeof message.content !== 'string') {
      cleaned.push(message);
      continue;
    }

    const content = stripAssistantTranscriptArtifacts(message.content);
    if (content) {
      cleaned.push({ ...message, content });
      continue;
    }

    if (message.tool_calls?.length) {
      cleaned.push({ ...message, content: null });
    }
  }
  return cleaned;
}

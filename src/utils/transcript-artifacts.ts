import type { Message } from '../types';

const PROVIDER_REPLAY_PLACEHOLDER_LINE =
  /^\[历史工具调用已完成；provider replay 隐藏内容未写入本地会话。.*\]$/;
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
  for (const line of lines) {
    const trimmed = line.trim();
    if (PROVIDER_REPLAY_PLACEHOLDER_LINE.test(trimmed)) {
      sawProviderReplayArtifact = true;
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

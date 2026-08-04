import type { Message } from '../types';

type ToolCall = NonNullable<Message['tool_calls']>[number];

export type ProviderRequestPreflightIssueCode =
  | 'empty_tool_calls'
  | 'invalid_tool_call'
  | 'duplicate_tool_call_id'
  | 'missing_tool_result'
  | 'orphan_tool_result'
  | 'duplicate_tool_result'
  | 'normalized_tool_exchange_id'
  | 'provider_replay_mismatch';

export interface ProviderRequestPreflightSummary {
  repaired: true;
  issueCodes: ProviderRequestPreflightIssueCode[];
  droppedMessages: number;
  droppedToolCalls: number;
  droppedToolResults: number;
  providerReplayFallbacks: number;
}

export interface ProviderRequestPreflightResult {
  messages: Message[];
  summary?: ProviderRequestPreflightSummary;
}

/**
 * Repairs only provider-invalid tool exchange structure. Ordinary conversation
 * messages and valid requests retain their original references.
 */
export function prepareProviderRequestMessages(
  messages: Message[],
): ProviderRequestPreflightResult {
  const issues = new Set<ProviderRequestPreflightIssueCode>();
  const output: Message[] = [];
  const seenToolCallIds = new Set<string>();
  let droppedMessages = 0;
  let droppedToolCalls = 0;
  let droppedToolResults = 0;
  let providerReplayFallbacks = 0;

  const recordIssue = (code: ProviderRequestPreflightIssueCode): void => {
    issues.add(code);
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message.role === 'tool') {
      droppedMessages++;
      droppedToolResults++;
      recordIssue('orphan_tool_result');
      continue;
    }

    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        recordIssue('empty_tool_calls');
        const hasProviderReplay = Boolean(message.providerContent?.length || message.providerState);
        if (hasProviderReplay) {
          providerReplayFallbacks++;
          recordIssue('provider_replay_mismatch');
        }
        output.push({
          ...message,
          tool_calls: undefined,
          ...(hasProviderReplay ? { providerContent: undefined, providerState: undefined } : {}),
        });
      } else {
        output.push(message);
      }
      continue;
    }

    const validCalls: ToolCall[] = [];
    const candidateCallIds = new Set<string>();
    for (const toolCall of message.tool_calls) {
      if (!isValidToolCall(toolCall)) {
        droppedToolCalls++;
        recordIssue('invalid_tool_call');
        continue;
      }
      const id = toolCall.id.trim();
      if (seenToolCallIds.has(id) || candidateCallIds.has(id)) {
        droppedToolCalls++;
        recordIssue('duplicate_tool_call_id');
        continue;
      }
      candidateCallIds.add(id);
      if (id !== toolCall.id) recordIssue('normalized_tool_exchange_id');
      validCalls.push(id === toolCall.id ? toolCall : { ...toolCall, id });
    }

    const validCallIds = new Set(validCalls.map(toolCall => toolCall.id));
    const retainedResults: Message[] = [];
    const resultIds = new Set<string>();
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
      const toolResult = messages[nextIndex];
      const resultId = String(toolResult.tool_call_id || '').trim();
      if (!resultId || !validCallIds.has(resultId)) {
        droppedMessages++;
        droppedToolResults++;
        recordIssue('orphan_tool_result');
      } else if (resultIds.has(resultId)) {
        droppedMessages++;
        droppedToolResults++;
        recordIssue('duplicate_tool_result');
      } else {
        resultIds.add(resultId);
        if (resultId !== toolResult.tool_call_id) recordIssue('normalized_tool_exchange_id');
        retainedResults.push(
          resultId === toolResult.tool_call_id
            ? toolResult
            : { ...toolResult, tool_call_id: resultId },
        );
      }
      nextIndex++;
    }

    const retainedCalls = validCalls.filter(toolCall => resultIds.has(toolCall.id));
    for (const toolCall of retainedCalls) seenToolCallIds.add(toolCall.id);
    const missingResultCount = validCalls.length - retainedCalls.length;
    if (missingResultCount > 0) {
      droppedToolCalls += missingResultCount;
      recordIssue('missing_tool_result');
    }

    let retainedAssistant: Message | undefined;
    if (retainedCalls.length > 0) {
      const callsChanged = retainedCalls.length !== message.tool_calls.length
        || retainedCalls.some((toolCall, callIndex) => toolCall !== message.tool_calls?.[callIndex]);
      const replayMismatch = Boolean(
        message.providerContent?.length
        && !providerReplayMatchesToolCalls(message.providerContent, retainedCalls),
      );
      if (callsChanged || replayMismatch) {
        if (message.providerContent?.length || message.providerState) {
          providerReplayFallbacks++;
          recordIssue('provider_replay_mismatch');
        }
        retainedAssistant = {
          ...message,
          tool_calls: retainedCalls,
          providerContent: undefined,
          providerState: undefined,
        };
      } else {
        retainedAssistant = message;
      }
    } else if (hasVisibleContent(message)) {
      if (message.providerContent?.length || message.providerState) {
        providerReplayFallbacks++;
        recordIssue('provider_replay_mismatch');
      }
      retainedAssistant = {
        ...message,
        tool_calls: undefined,
        providerContent: undefined,
        providerState: undefined,
      };
    } else {
      droppedMessages++;
    }

    if (retainedAssistant) output.push(retainedAssistant);
    output.push(...retainedResults);
    index = nextIndex - 1;
  }

  if (issues.size === 0) {
    return { messages };
  }

  return {
    messages: output,
    summary: {
      repaired: true,
      issueCodes: Array.from(issues).sort(),
      droppedMessages,
      droppedToolCalls,
      droppedToolResults,
      providerReplayFallbacks,
    },
  };
}

function isValidToolCall(value: ToolCall): boolean {
  return Boolean(
    value
    && value.type === 'function'
    && typeof value.id === 'string'
    && value.id.trim()
    && value.function
    && typeof value.function.name === 'string'
    && value.function.name.trim()
    && typeof value.function.arguments === 'string',
  );
}

function hasVisibleContent(message: Message): boolean {
  if (typeof message.content === 'string') return Boolean(message.content.trim());
  return Array.isArray(message.content) && message.content.length > 0;
}

function providerReplayMatchesToolCalls(
  blocks: NonNullable<Message['providerContent']>,
  toolCalls: ToolCall[],
): boolean {
  const canonical = new Map(toolCalls.map(toolCall => [toolCall.id, {
    name: toolCall.function.name,
    arguments: stableArguments(toolCall.function.arguments),
  }]));
  const replay = new Map<string, { name: string; arguments: string }>();

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type || '');
    const id = type === 'tool_use'
      ? safeString(block.id)
      : type === 'function_call'
        ? safeString(block.call_id)
        : '';
    if (!id) continue;
    if (replay.has(id)) return false;
    replay.set(id, {
      name: safeString(block.name),
      arguments: type === 'tool_use'
        ? stableValue(block.input)
        : stableArguments(safeString(block.arguments)),
    });
  }

  if (replay.size !== canonical.size) return false;
  for (const [id, call] of canonical) {
    const item = replay.get(id);
    if (!item || item.name !== call.name || item.arguments !== call.arguments) return false;
  }
  return true;
}

function stableArguments(value: string): string {
  try {
    return stableValue(JSON.parse(value || '{}'));
  } catch {
    return `raw:${value}`;
  }
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableValue(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

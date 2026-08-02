import type { ChatConfig, Message } from '../types';
import {
  resolveOpenAIReasoningReplayMode,
  type OpenAIReasoningReplayMode,
} from '../utils/reasoning-effort';
import { normalizeOpenAIChatCompletionsUrl } from './openai-url';
import { createProviderStateReference, isProviderStateCompatible } from './provider-state';
import { annotateContextMessage } from '../core/context-lifecycle';

/**
 * DeepSeek thinking/tool-call dialects cannot replay a synthetic assistant
 * tool call because no provider reasoning state exists for that local event.
 * Preserve the same transient observation as a user-context message before
 * structural preflight so the provider sees no fabricated reasoning history.
 */
export function prepareDeepSeekSyntheticObservations(input: {
  config: Pick<ChatConfig, 'provider' | 'model' | 'apiUrl' | 'openaiApiMode'>;
  messages: Message[];
}): Message[] {
  if (
    input.config.provider !== 'openai'
    || input.config.openaiApiMode === 'responses'
    || resolveOpenAIReasoningReplayMode(input.config) !== 'include'
  ) return input.messages;

  const output: Message[] = [];
  let changed = false;
  for (let index = 0; index < input.messages.length; index += 1) {
    const assistant = input.messages[index];
    const tool = input.messages[index + 1];
    const toolCallId = assistant?.tool_calls?.[0]?.id;
    if (
      !assistant?.__syntheticObservation
      || assistant.role !== 'assistant'
      || assistant.tool_calls?.length !== 1
      || !tool?.__syntheticObservation
      || tool.role !== 'tool'
      || !toolCallId
      || tool.tool_call_id !== toolCallId
      || assistant.syntheticObservationId !== tool.syntheticObservationId
    ) {
      output.push(assistant);
      continue;
    }
    const content = contentAsText(tool.content);
    const lifecycle = parseSyntheticLifecycleMetadata(
      assistant.tool_calls[0].function.arguments,
    );
    const envelope = {
      type: 'runtime_observation',
      lifecycle,
      observation: parseObservationContent(content),
    };
    output.push({
      role: 'user',
      content: `[runtime_observation]\n${JSON.stringify(envelope)}`,
      __syntheticObservation: true,
      syntheticObservationId: tool.syntheticObservationId,
      syntheticObservationProvenance: tool.syntheticObservationProvenance,
      __context: tool.__context,
    });
    changed = true;
    index += 1;
  }
  return changed ? output : input.messages;
}

function parseSyntheticLifecycleMetadata(argumentsJson: string): {
  source: string;
  status: string;
  relevance: string;
  timing: 'current_turn' | 'late_previous_turn';
  confidence?: number;
} {
  let value: any;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    value = {};
  }
  const source = ['memory', 'web', 'runtime', 'subagent', 'skill_context'].includes(value?.source)
    ? value.source
    : 'runtime';
  const status = ['completed', 'partial', 'failed', 'cancelled'].includes(value?.status)
    ? value.status
    : 'partial';
  const relevance = ['high', 'medium', 'low'].includes(value?.relevance)
    ? value.relevance
    : 'low';
  const timing = value?.timing === 'current_turn'
    ? 'current_turn'
    : 'late_previous_turn';
  const confidence = typeof value?.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : undefined;
  return {
    source,
    status,
    relevance,
    timing,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function parseObservationContent(content: string): unknown {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Preserve explicit content when a branch uses a human-readable format.
  }
  return { content };
}

export type ReasoningReplayRecoveryAction =
  | 'reasoning_replay_include'
  | 'reasoning_replay_omit'
  | 'reasoning_history_degrade';

export interface ReasoningReplayRecoveryPlan {
  action: ReasoningReplayRecoveryAction;
  replayMode: OpenAIReasoningReplayMode;
  messages: Message[];
  degradedExchanges: number;
}

export function planDeepSeekReasoningRecovery(input: {
  error: unknown;
  config: Pick<ChatConfig, 'provider' | 'model' | 'apiUrl' | 'openaiApiMode'>;
  messages: Message[];
  currentMode: OpenAIReasoningReplayMode | undefined;
}): ReasoningReplayRecoveryPlan | undefined {
  if (input.config.provider !== 'openai' || input.config.openaiApiMode === 'responses') {
    return undefined;
  }
  const defaultMode = resolveOpenAIReasoningReplayMode(input.config);
  if (!defaultMode) return undefined;

  const desiredMode = inferDesiredReplayMode(input.error);
  if (!desiredMode) return undefined;
  const currentMode = input.currentMode ?? defaultMode;

  if (desiredMode === 'omit') {
    if (currentMode !== 'include') return undefined;
    const expectedState = expectedProviderState(input.config);
    if (!input.messages.some(message => hasCompatibleReasoning(message, expectedState))) {
      return undefined;
    }
    return {
      action: 'reasoning_replay_omit',
      replayMode: 'omit',
      messages: input.messages,
      degradedExchanges: 0,
    };
  }

  const degraded = degradeToolHistoryWithoutReasoning(input.messages, input.config);
  if (degraded.degradedExchanges > 0) {
    return {
      action: 'reasoning_history_degrade',
      replayMode: 'include',
      messages: degraded.messages,
      degradedExchanges: degraded.degradedExchanges,
    };
  }
  if (currentMode === 'include') return undefined;
  return {
    action: 'reasoning_replay_include',
    replayMode: 'include',
    messages: input.messages,
    degradedExchanges: 0,
  };
}

function inferDesiredReplayMode(error: unknown): OpenAIReasoningReplayMode | undefined {
  const status = extractStatus(error);
  if (status !== undefined && status !== 400 && status !== 422) return undefined;
  const evidence = extractEvidence(error);
  if (!/reasoning[_\s-]?content/i.test(evidence)) return undefined;

  const include = [
    /reasoning[_\s-]?content.{0,120}(?:must|should|needs? to) be (?:passed back|echoed|included|provided)/i,
    /reasoning[_\s-]?content.{0,80}(?:is|was) (?:missing|required|expected)/i,
    /(?:missing|required|expected).{0,80}reasoning[_\s-]?content/i,
  ].some(pattern => pattern.test(evidence));
  if (include) return 'include';

  const omit = [
    /reasoning[_\s-]?content.{0,120}(?:unknown|unrecognized|unsupported|unexpected|not allowed|not permitted)/i,
    /reasoning[_\s-]?content.{0,120}(?:must|should) not be (?:passed|included|provided|sent)/i,
    /(?:unknown|unrecognized|unsupported|unexpected|extra) (?:field|parameter).{0,80}reasoning[_\s-]?content/i,
  ].some(pattern => pattern.test(evidence));
  return omit ? 'omit' : undefined;
}

function degradeToolHistoryWithoutReasoning(
  messages: Message[],
  config: Pick<ChatConfig, 'model' | 'apiUrl'>,
): { messages: Message[]; degradedExchanges: number } {
  const expectedState = expectedProviderState(config);
  const output: Message[] = [];
  let degradedExchanges = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      output.push(message);
      continue;
    }
    if (hasCompatibleReasoning(message, expectedState)) {
      output.push(message);
      continue;
    }

    const results: Message[] = [];
    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
      results.push(messages[nextIndex]);
      nextIndex++;
    }
    if (results.length === 0) {
      output.push(message);
      continue;
    }

    degradedExchanges++;
    if (hasVisibleContent(message)) {
      output.push({
        ...message,
        tool_calls: undefined,
        providerContent: undefined,
        providerState: undefined,
      });
    }
    output.push(annotateContextMessage({
      role: 'user',
      content: buildDegradedHistoryNote(results),
      __runtimeFeedback: true,
    }, {
      source: 'provider_recovery',
      lifecycle: 'call',
      cacheScope: 'volatile',
    }));
    index = nextIndex - 1;
  }

  return degradedExchanges > 0
    ? { messages: output, degradedExchanges }
    : { messages, degradedExchanges: 0 };
}

function expectedProviderState(config: Pick<ChatConfig, 'model' | 'apiUrl'>) {
  return createProviderStateReference({
    apiType: 'openai-chat-completions',
    endpoint: normalizeOpenAIChatCompletionsUrl(config.apiUrl || ''),
    model: String(config.model || ''),
  });
}

function hasCompatibleReasoning(
  message: Message,
  expectedState: ReturnType<typeof createProviderStateReference>,
): boolean {
  if (!isProviderStateCompatible(message.providerState, expectedState)) return false;
  return Boolean(message.providerContent?.some(block => (
    block?.type === 'openai_reasoning'
    && typeof block.reasoning_content === 'string'
    && block.reasoning_content.trim()
  )));
}

function buildDegradedHistoryNote(results: Message[]): string {
  const lines = results.map((result, index) => {
    const name = String(result.name || 'tool').trim() || 'tool';
    const content = contentAsText(result.content).slice(0, 1200);
    return `${index + 1}. ${name}: ${content || '[empty result]'}`;
  });
  return '[provider_recovery]\n'
    + 'A completed historical tool exchange was converted to plain context because its opaque reasoning state is unavailable. '
    + 'Treat the following as historical results; do not repeat the tools unless current state must be re-verified.\n'
    + lines.join('\n');
}

function hasVisibleContent(message: Message): boolean {
  if (typeof message.content === 'string') return Boolean(message.content.trim());
  return Array.isArray(message.content) && message.content.length > 0;
}

function contentAsText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '[image omitted]').join('\n');
}

function extractEvidence(error: any): string {
  return [
    error?.response?.data?.error?.code,
    error?.response?.data?.error?.type,
    error?.response?.data?.error?.message,
    error?.response?.data?.message,
    error?.error?.code,
    error?.error?.type,
    error?.error?.message,
    error?.message,
  ].filter(Boolean).join(' ');
}

function extractStatus(error: any): number | undefined {
  const value = error?.response?.status ?? error?.status;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

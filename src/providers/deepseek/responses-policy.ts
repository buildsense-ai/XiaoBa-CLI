import type { ChatConfig } from '../../types';

/**
 * XiaoBa's version boundary for DeepSeek Responses.
 *
 * The public catalog model remains stable. Provider-specific request and
 * replay rules live here so future DeepSeek versions do not accumulate
 * branches in the generic OpenAI provider.
 */
export const DEEPSEEK_RESPONSES_PROFILE = Object.freeze({
  publicModelId: 'deepseek-v4-flash',
  apiMode: 'responses' as const,
  reasoningEfforts: ['none', 'low', 'high', 'max'] as const,
});

export function isDeepSeekResponses(
  apiMode: ChatConfig['openaiApiMode'],
  model: unknown,
): boolean {
  return apiMode === DEEPSEEK_RESPONSES_PROFILE.apiMode
    && String(model || '').trim().toLowerCase() === DEEPSEEK_RESPONSES_PROFILE.publicModelId;
}

export function normalizeDeepSeekReasoningEffort(
  effort: ChatConfig['reasoningEffort'],
): typeof DEEPSEEK_RESPONSES_PROFILE.reasoningEfforts[number] | undefined {
  if (!effort || effort === 'default') return undefined;
  if (effort === 'disabled' || effort === 'none') return 'none';
  if (effort === 'max') return 'max';
  if (effort === 'low') return 'low';
  return 'high';
}

export function applyDeepSeekResponsesRequestPolicy(
  body: any,
  effort: ChatConfig['reasoningEffort'],
): void {
  // DeepSeek Responses is stateless and manages context caching upstream.
  // OpenAI encrypted reasoning and stored-response controls are unsupported.
  delete body.store;
  delete body.include;
  delete body.prompt_cache_key;
  delete body.prompt_cache_retention;
  delete body.previous_response_id;
  delete body.conversation;

  const normalizedEffort = normalizeDeepSeekReasoningEffort(effort);
  if (normalizedEffort) body.reasoning = { effort: normalizedEffort };
  else delete body.reasoning;

  if (Array.isArray(body.tools)) {
    const toolChoice = body.tool_choice;
    if (toolChoice !== undefined && !['auto', 'none'].includes(toolChoice)) {
      body.tool_choice = 'auto';
    }
  }
}

export function isDeepSeekResponsesReplayItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  if (item.type === 'function_call') return true;
  if (item.type !== 'reasoning' || !Array.isArray(item.content)) return false;
  return item.content.some((block: any) => (
    block && typeof block === 'object' && typeof block.text === 'string'
  ));
}

export function sanitizeDeepSeekResponsesReplayItem(item: any): any | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const clone = JSON.parse(JSON.stringify(item));
  if (clone.type === 'reasoning') {
    delete clone.encrypted_content;
    delete clone.summary;
  }
  return isDeepSeekResponsesReplayItem(clone) ? clone : undefined;
}

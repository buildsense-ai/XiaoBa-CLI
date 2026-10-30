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

// Protocol recognition only: these remain distinct model/catalog identities.
export const DEEPSEEK_FLASH_MODEL_IDS = new Set([
  'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
]);

// Users copy whatever id the provider console shows, so an installed profile
// can address the same model by a versioned or upstream build id
// (`deepseek-v4.1-flash`, `deepseek-v4.1-flash-1017`, or a
// `provider/model` path). An exact-name check silently skipped every DeepSeek
// rule for those profiles, and the gateway answered
// "reasoning parts must use summary_text or reasoning_text" on the next turn
// (production 2026-10-29). Match the family instead of one literal id.
const DEEPSEEK_FLASH_FAMILY_PATTERN = /^deepseek(?:-v4(?:\.\d+)*)?-flash(?:-[a-z0-9]+)*$/;

function deepSeekModelKey(model: unknown): string {
  return String(model || '').trim().toLowerCase().split('/').pop() || '';
}

export function isDeepSeekResponses(
  apiMode: ChatConfig['openaiApiMode'],
  model: unknown,
): boolean {
  if (apiMode !== DEEPSEEK_RESPONSES_PROFILE.apiMode) return false;
  const key = deepSeekModelKey(model);
  return DEEPSEEK_FLASH_MODEL_IDS.has(key) || DEEPSEEK_FLASH_FAMILY_PATTERN.test(key);
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

  // Native thinking mode still rejects required/named tool_choice in live API.
  const nativeNonThinking = String(body.model || '').toLowerCase() === 'deepseek-flash'
    && normalizedEffort === 'none';
  if (!nativeNonThinking && Array.isArray(body.tools)) {
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

// Part types the gateway emits inside `reasoning.content` but refuses to accept
// back on the next turn. Verified against the live gateway 2026-10-29:
// it returns reasoning items as `content: [{type: 'summary_text', ...}]` with no
// `summary` array, then answers a replay of that exact shape with
// "The parameter `input.reasoning` specified in the request are not valid:
//  reasoning parts must use summary_text or reasoning_text in the corresponding
//  array". `content` only ever carries reasoning parts, so a summary part is
// renamed instead of dropped and the trace survives verbatim.
const REASONING_CONTENT_PART_REMAP: Record<string, string> = {
  summary_text: 'reasoning_text',
};

function normalizeReasoningContentParts(item: any): void {
  if (!Array.isArray(item.content)) return;
  for (const block of item.content) {
    if (!block || typeof block !== 'object') continue;
    const replacement = REASONING_CONTENT_PART_REMAP[block.type];
    if (replacement) block.type = replacement;
  }
}

export function sanitizeDeepSeekResponsesReplayItem(item: any): any | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const clone = JSON.parse(JSON.stringify(item));
  if (clone.type === 'reasoning') {
    delete clone.encrypted_content;
    delete clone.summary;
    normalizeReasoningContentParts(clone);
  }
  return isDeepSeekResponsesReplayItem(clone) ? clone : undefined;
}

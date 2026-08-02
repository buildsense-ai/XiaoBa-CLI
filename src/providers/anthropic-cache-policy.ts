import { estimateMessagesTokens, estimateToolsTokens } from '../core/token-estimator';
import type { Message } from '../types';
import type { ToolDefinition } from '../types/tool';
import type { ProviderCachePlanSummary } from './provider-cache-policy';

export type AnthropicCacheStrategy =
  | 'anthropic-compatible-no-markers'
  | 'anthropic-explicit-stable-prefix';

export interface AnthropicCachePlanSummary extends ProviderCachePlanSummary {
  strategy: AnthropicCacheStrategy;
}

export interface AnthropicCachePlan extends AnthropicCachePlanSummary {
  toolBreakpointIndex?: number;
  stableSystemEnd: number;
}

export interface AnthropicCachePlanInput {
  apiUrl: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
}

/**
 * Keep breakpoints on prefixes that are identical across calls.
 *
 * We intentionally do not enable top-level automatic caching yet. XiaoBa's
 * current per-call system suffix changes ahead of message history, which would
 * otherwise create a paid cache write on each request without a reusable hit.
 */
export function resolveAnthropicCachePlan(input: AnthropicCachePlanInput): AnthropicCachePlan {
  const systemMessages = input.messages.filter(message => (
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.length > 0
  ));
  const firstDynamicIndex = systemMessages.findIndex(isDynamicSystemMessage);
  const stableSystemEnd = firstDynamicIndex < 0 ? systemMessages.length : firstDynamicIndex;
  const stableMessages = systemMessages.slice(0, stableSystemEnd);
  const official = isCanonicalAnthropicEndpoint(input.apiUrl);
  const hasStableSystemText = stableMessages.some(message => (
    typeof message.content === 'string' && Boolean(message.content.trim())
  ));
  const toolBreakpointIndex = official && input.tools.length > 0
    ? input.tools.length - 1
    : undefined;
  const explicitBreakpoints = official
    ? Number(toolBreakpointIndex !== undefined) + Number(hasStableSystemText)
    : 0;

  return {
    strategy: official
      ? 'anthropic-explicit-stable-prefix'
      : 'anthropic-compatible-no-markers',
    stablePrefixEstimatedTokens: estimateToolsTokens([...input.tools])
      + estimateMessagesTokens(stableMessages),
    stableSystemMessages: stableMessages.length,
    explicitBreakpoints,
    stableSystemEnd,
    ...(toolBreakpointIndex === undefined ? {} : { toolBreakpointIndex }),
  };
}

export function summarizeAnthropicCachePlan(plan: AnthropicCachePlan): AnthropicCachePlanSummary {
  return {
    strategy: plan.strategy,
    stablePrefixEstimatedTokens: plan.stablePrefixEstimatedTokens,
    stableSystemMessages: plan.stableSystemMessages,
    explicitBreakpoints: plan.explicitBreakpoints,
  };
}

export function isCanonicalAnthropicEndpoint(apiUrl: string): boolean {
  try {
    const url = new URL(apiUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.anthropic.com'
      && (url.port === '' || url.port === '443')
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && ['/', '/v1', '/v1/messages'].includes(normalizedPath);
  } catch {
    return false;
  }
}

function isDynamicSystemMessage(message: Message): boolean {
  if (message.__cacheScope === 'dynamic') return true;
  if (message.__cacheScope === 'stable') return false;
  return typeof message.content === 'string'
    && /^\[(?:transient_[^\]]+|compact_boundary)\]/.test(message.content);
}

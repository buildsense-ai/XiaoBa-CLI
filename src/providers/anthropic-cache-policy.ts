import { estimateMessagesTokens, estimateToolsTokens } from '../core/token-estimator';
import type { Message } from '../types';
import type { ToolDefinition } from '../types/tool';
import type { ProviderCacheMode, ProviderCachePlanSummary } from './provider-cache-policy';
import { resolveContextCacheScope } from '../core/context-lifecycle';

export type AnthropicCacheStrategy =
  | 'anthropic-cache-bypassed'
  | 'anthropic-compatible-no-markers'
  | 'anthropic-explicit-stable-prefix';

export interface AnthropicCachePlanSummary extends ProviderCachePlanSummary {
  strategy: AnthropicCacheStrategy;
}

export interface AnthropicCachePlan extends AnthropicCachePlanSummary {
  toolBreakpointIndex?: number;
  stableSystemEnd: number;
  conversationBreakpoint: boolean;
}

export interface AnthropicCachePlanInput {
  apiUrl: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  cacheMode?: ProviderCacheMode;
}

/**
 * Keep explicit breakpoints on stable tools/system plus the latest growing
 * conversation boundary. We intentionally do not enable top-level automatic
 * caching yet: a per-call system suffix ahead of history can otherwise create
 * paid writes that a subsequent request cannot reuse.
 */
export function resolveAnthropicCachePlan(input: AnthropicCachePlanInput): AnthropicCachePlan {
  if (input.cacheMode === 'bypass') {
    return {
      strategy: 'anthropic-cache-bypassed',
      stablePrefixEstimatedTokens: 0,
      stableSystemMessages: 0,
      explicitBreakpoints: 0,
      stableSystemEnd: 0,
      conversationBreakpoint: false,
    };
  }
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
  const lastEmittedMessage = [...input.messages].reverse().find(emitsAnthropicMessage);
  const conversationBreakpoint = Boolean(
    official
    && lastEmittedMessage
    && (lastEmittedMessage.role === 'user' || lastEmittedMessage.role === 'tool'),
  );
  const explicitBreakpoints = official
    ? Number(toolBreakpointIndex !== undefined)
      + Number(hasStableSystemText)
      + Number(conversationBreakpoint)
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
    conversationBreakpoint,
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
  const scope = resolveContextCacheScope(message);
  if (scope === 'epoch' || scope === 'volatile') return true;
  if (scope === 'stable') return false;
  return typeof message.content === 'string'
    && /^\[(?:transient_[^\]]+|compact_boundary)\]/.test(message.content);
}

function emitsAnthropicMessage(message: Message): boolean {
  if (message.role === 'system') return false;
  if (message.role === 'tool') return Boolean(message.tool_call_id);
  if (message.role === 'assistant' && (message.tool_calls?.length || 0) > 0) return true;
  if (typeof message.content === 'string') return Boolean(message.content.trim());
  return Array.isArray(message.content) && message.content.length > 0;
}

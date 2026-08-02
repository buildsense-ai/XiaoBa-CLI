import { createHash } from 'crypto';
import { estimateMessagesTokens, estimateToolsTokens } from '../core/token-estimator';
import type { Message } from '../types';
import type { ToolDefinition } from '../types/tool';
import {
  canonicalizeProviderCacheValue,
  type ProviderCacheMode,
  type ProviderCachePlanSummary,
} from './provider-cache-policy';
import { resolveContextCacheScope } from '../core/context-lifecycle';

export type OpenAICacheApiType = 'openai-chat-completions' | 'openai-responses';
export type OpenAICacheStrategy =
  | 'openai-cache-bypassed'
  | 'openai-compatible-automatic-prefix'
  | 'openai-prompt-cache-key'
  | 'openai-explicit-stable-prefix';

export interface OpenAICachePlanSummary extends ProviderCachePlanSummary {
  strategy: OpenAICacheStrategy;
}

export interface OpenAICachePlan extends OpenAICachePlanSummary {
  promptCacheKey?: string;
  /** Chat Completions message index whose final content block owns the marker. */
  chatBreakpointMessageIndex?: number;
}

export interface OpenAICachePlanInput {
  apiUrl: string;
  model: string;
  apiType: OpenAICacheApiType;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  /** A stable, non-secret identity used only to shard routing keys. */
  partitionKey?: string;
  cacheMode?: ProviderCacheMode;
  /** Explicitly declared by a compatible endpoint profile after a live canary. */
  compatiblePromptCaching?: 'key' | 'explicit';
}

const OPENAI_EXPLICIT_CACHE_MIN_TOKENS = 1024;
const PROMPT_CACHE_KEY_SHARDS = 16;

/**
 * Resolve cache behavior before serializing either OpenAI wire dialect.
 *
 * Compatible endpoints keep their own automatic caching behavior. OpenAI-only
 * request fields are deliberately restricted to api.openai.com because relays
 * frequently implement only a subset of the wire schema.
 */
export function resolveOpenAICachePlan(input: OpenAICachePlanInput): OpenAICachePlan {
  if (input.cacheMode === 'bypass') {
    return {
      strategy: 'openai-cache-bypassed',
      stablePrefixEstimatedTokens: 0,
      stableSystemMessages: 0,
      explicitBreakpoints: 0,
    };
  }
  const stable = input.apiType === 'openai-responses'
    ? collectResponsesStableSystemMessages(input.messages)
    : collectLeadingStableSystemMessages(input.messages);
  const stablePrefixEstimatedTokens = estimateMessagesTokens(stable.messages)
    + estimateToolsTokens([...input.tools]);
  const official = isOfficialOpenAIEndpoint(input.apiUrl);
  const supportsCacheKey = official || input.compatiblePromptCaching === 'key'
    || input.compatiblePromptCaching === 'explicit';
  const supportsExplicitFields = official || input.compatiblePromptCaching === 'explicit';
  const promptCacheKey = supportsCacheKey
    ? buildOpenAIPromptCacheKey({
        apiType: input.apiType,
        model: input.model,
        stableMessages: stable.messages,
        tools: input.tools,
        partitionKey: input.partitionKey,
      })
    : undefined;
  const explicit = Boolean(
    supportsExplicitFields
    && supportsOpenAIExplicitPromptCaching(input.model)
    && stable.hasText
    && stablePrefixEstimatedTokens >= OPENAI_EXPLICIT_CACHE_MIN_TOKENS,
  );

  const plan: OpenAICachePlan = {
    strategy: !supportsCacheKey
      ? 'openai-compatible-automatic-prefix'
      : explicit
        ? 'openai-explicit-stable-prefix'
        : 'openai-prompt-cache-key',
    stablePrefixEstimatedTokens,
    stableSystemMessages: stable.messages.length,
    explicitBreakpoints: explicit ? 1 : 0,
    ...(promptCacheKey ? {
      promptCacheKey,
      promptCacheKeyFingerprint: sha256(promptCacheKey).slice(0, 16),
    } : {}),
  };

  if (explicit && input.apiType === 'openai-chat-completions' && stable.lastMessageIndex !== undefined) {
    plan.chatBreakpointMessageIndex = stable.lastMessageIndex;
  }
  return plan;
}

export function summarizeOpenAICachePlan(plan: OpenAICachePlan): OpenAICachePlanSummary {
  return {
    strategy: plan.strategy,
    stablePrefixEstimatedTokens: plan.stablePrefixEstimatedTokens,
    stableSystemMessages: plan.stableSystemMessages,
    explicitBreakpoints: plan.explicitBreakpoints,
    ...(plan.promptCacheKeyFingerprint
      ? { promptCacheKeyFingerprint: plan.promptCacheKeyFingerprint }
      : {}),
  };
}

export function isOfficialOpenAIEndpoint(apiUrl: string): boolean {
  try {
    return new URL(apiUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

/** GPT-5.6 and later model families support explicit prompt cache markers. */
export function supportsOpenAIExplicitPromptCaching(model: string): boolean {
  const match = String(model || '').trim().toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?:[-_:]|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 5 || (major === 5 && minor >= 6);
}

export function canonicalizeOpenAICacheValue(value: unknown): unknown {
  return canonicalizeProviderCacheValue(value);
}

interface StableSystemMessages {
  messages: Message[];
  hasText: boolean;
  lastMessageIndex?: number;
}

function collectLeadingStableSystemMessages(messages: readonly Message[]): StableSystemMessages {
  const stable: Message[] = [];
  let lastMessageIndex: number | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'system' || isDynamicCacheMessage(message)) break;
    stable.push(message);
    if (contentAsText(message.content).trim()) lastMessageIndex = index;
  }
  return {
    messages: stable,
    hasText: lastMessageIndex !== undefined,
    ...(lastMessageIndex === undefined ? {} : { lastMessageIndex }),
  };
}

function collectResponsesStableSystemMessages(messages: readonly Message[]): StableSystemMessages {
  const stable = messages.filter(message => message.role === 'system' && !isDynamicCacheMessage(message));
  return {
    messages: stable,
    hasText: stable.some(message => Boolean(contentAsText(message.content).trim())),
  };
}

function isDynamicCacheMessage(message: Message): boolean {
  const scope = resolveContextCacheScope(message);
  if (scope === 'epoch' || scope === 'volatile') return true;
  if (scope === 'stable') return false;
  return message.role === 'system'
    && typeof message.content === 'string'
    && /^(?:\[(?:transient_[^\]]+|compact_boundary)\])/.test(message.content);
}

function contentAsText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n');
}

function buildOpenAIPromptCacheKey(input: {
  apiType: OpenAICacheApiType;
  model: string;
  stableMessages: readonly Message[];
  tools: readonly ToolDefinition[];
  partitionKey?: string;
}): string {
  const stableText = input.stableMessages.map(message => contentAsText(message.content)).join('\n\n');
  const tools = [...input.tools]
    .map(tool => canonicalizeOpenAICacheValue({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
    .sort((left: any, right: any) => String(left.name).localeCompare(String(right.name)));
  const digest = sha256(JSON.stringify({
    identityVersion: 'openai-cache-v3',
    apiType: input.apiType,
    model: String(input.model || '').trim().toLowerCase(),
    stableText,
    tools,
  })).slice(0, 36);
  const partitionHash = sha256(String(input.partitionKey || 'default'));
  const shard = (Number.parseInt(partitionHash.slice(0, 2), 16) % PROMPT_CACHE_KEY_SHARDS)
    .toString(16)
    .padStart(2, '0');
  const api = input.apiType === 'openai-responses' ? 'rsp' : 'chat';
  return `catsco-v3-${api}-${digest}-s${shard}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type ProviderCacheStrategy =
  | 'anthropic-compatible-no-markers'
  | 'anthropic-explicit-stable-prefix'
  | 'openai-compatible-automatic-prefix'
  | 'openai-prompt-cache-key'
  | 'openai-explicit-stable-prefix';

/** Safe, redacted cache plan attached to exact provider-attempt telemetry. */
export interface ProviderCachePlanSummary {
  strategy: ProviderCacheStrategy;
  stablePrefixEstimatedTokens: number;
  stableSystemMessages: number;
  explicitBreakpoints: number;
  promptCacheKeyFingerprint?: string;
}

export function canonicalizeProviderCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalizeProviderCacheValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => [
        key,
        canonicalizeProviderCacheValue((value as Record<string, unknown>)[key]),
      ]),
  );
}

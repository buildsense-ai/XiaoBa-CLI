export type RelayModelFamily = 'minimax' | 'deepseek' | 'gpt';
export type RelayModelProvider = 'anthropic' | 'openai';

export const RELAY_MODEL_BASE_URLS: Record<RelayModelProvider, string> = {
  anthropic: 'https://relay.catsco.cc/anthropic',
  openai: 'https://relay.catsco.cc/v1',
};

export const RELAY_MODEL_PROTOCOL_LABELS: Record<RelayModelProvider, string> = {
  anthropic: 'Anthropic-compatible',
  openai: 'OpenAI-compatible',
};

export const RELAY_MODEL_SDK_LABELS: Record<RelayModelProvider, string> = {
  anthropic: 'Anthropic SDK',
  openai: 'OpenAI SDK',
};

export interface RelayModelCapabilities {
  toolCalling: boolean;
  vision?: boolean;
  streaming: boolean;
}

export interface RelayModelProfile {
  id: string;
  label: string;
  model: string;
  family: RelayModelFamily;
  quotaClass: string;
  preferredProvider: RelayModelProvider;
  openaiApiMode?: 'chat_completions' | 'responses';
  contextWindowTokens: number;
  modelsDevProvider: string;
  modelsDevModel: string;
  capabilities: RelayModelCapabilities;
}

// Vision capabilities mirror the first-party provider entries in models.dev.
// Relay input modalities may override them at runtime.
export const RELAY_MODEL_PROFILES: RelayModelProfile[] = [
  {
    id: 'minimax-m2.7',
    label: 'MiniMax M2.7',
    model: 'MiniMax-M2.7',
    family: 'minimax',
    quotaClass: 'standard',
    preferredProvider: 'anthropic',
    contextWindowTokens: 204_800,
    modelsDevProvider: 'minimax',
    modelsDevModel: 'MiniMax-M2.7',
    capabilities: {
      toolCalling: true,
      vision: false,
      streaming: true,
    },
  },
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    model: 'MiniMax-M3',
    family: 'minimax',
    quotaClass: 'multimodal',
    preferredProvider: 'anthropic',
    contextWindowTokens: 1_000_000,
    modelsDevProvider: 'minimax',
    modelsDevModel: 'MiniMax-M3',
    capabilities: {
      toolCalling: true,
      vision: true,
      streaming: true,
    },
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    model: 'deepseek-v4-flash',
    family: 'deepseek',
    quotaClass: 'flash-low',
    preferredProvider: 'anthropic',
    contextWindowTokens: 1_000_000,
    modelsDevProvider: 'deepseek',
    modelsDevModel: 'deepseek-v4-flash',
    capabilities: {
      toolCalling: true,
      vision: false,
      streaming: true,
    },
  },
  ...(['terra', 'sol', 'luna'] as const).map(variant => ({
    id: `gpt-5.6-${variant}`,
    label: `GPT-5.6 ${variant[0].toUpperCase()}${variant.slice(1)}`,
    model: `gpt-5.6-${variant}`,
    family: 'gpt' as const,
    quotaClass: 'gpt-5.6',
    preferredProvider: 'openai' as const,
    openaiApiMode: 'responses' as const,
    contextWindowTokens: 1_000_000,
    modelsDevProvider: 'openai',
    modelsDevModel: `gpt-5.6-${variant}`,
    capabilities: {
      toolCalling: true,
      vision: true,
      streaming: true,
    },
  })),
];

/** The first-run CatsCo model when the user has not chosen one yet. */
export const DEFAULT_CATSCO_RELAY_MODEL_ID = 'minimax-m3';

function normalizeModelName(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export function findRelayModelProfile(model: unknown): RelayModelProfile | undefined {
  const normalized = normalizeModelName(model);
  if (!normalized) return undefined;
  return RELAY_MODEL_PROFILES.find(profile => (
    normalizeModelName(profile.model) === normalized || normalizeModelName(profile.id) === normalized
  ));
}

/**
 * Catalog records persist this stable ID only. The relay-facing model spelling
 * and the UI label are always derived from the profile at their use sites.
 */
export function canonicalRelayModelId(value: unknown): string | undefined {
  const profile = findRelayModelProfile(value);
  return profile?.id;
}

/**
 * Old installations stored either the catalog ID or the relay-facing model
 * name. Treat known aliases as one catalog model during migration.
 */
export function relayModelIdsMatch(left: unknown, right: unknown): boolean {
  const leftProfile = findRelayModelProfile(left);
  const rightProfile = findRelayModelProfile(right);
  if (leftProfile || rightProfile) return leftProfile?.id === rightProfile?.id;
  const normalizedLeft = normalizeModelName(left);
  const normalizedRight = normalizeModelName(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function relayModelProviderBaseUrl(provider: RelayModelProvider): string {
  return RELAY_MODEL_BASE_URLS[provider];
}

export function relayModelProviderProtocolLabel(provider: RelayModelProvider): string {
  return RELAY_MODEL_PROTOCOL_LABELS[provider];
}

export function relayModelProviderSdkLabel(provider: RelayModelProvider): string {
  return RELAY_MODEL_SDK_LABELS[provider];
}

import { DEEPSEEK_RELAY_MODEL_PROFILE } from '../providers/deepseek/catalog-profile';

export type RelayModelFamily = 'catalog' | 'minimax' | 'deepseek' | 'glm' | 'gpt';
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

/** Non-secret catalog metadata supplied by CatsCompany for dynamic models. */
export interface RelayModelRuntimeDescriptor {
  catalogModelId?: string;
  model: string;
  provider: RelayModelProvider;
  contextWindowTokens: number;
  openaiApiMode?: 'chat_completions' | 'responses';
  capabilities: RelayModelCapabilities;
}

/**
 * Converts cloud catalog metadata into a safe local profile. Endpoints and
 * credentials are intentionally absent: they are still selected by the
 * authenticated Relay config/key flow.
 */
export function relayModelProfileFromRuntimeDescriptor(
  modelId: unknown,
  descriptor: unknown,
): RelayModelProfile | undefined {
  const id = normalizeModelName(modelId);
  if (!id || !descriptor || typeof descriptor !== 'object') return undefined;
  const input = descriptor as Record<string, unknown>;
  const model = String(input.model || '').trim();
  const catalogModelId = String(input.catalogModelId || '').trim().toLowerCase();
  const provider = input.provider === 'anthropic' || input.provider === 'openai'
    ? input.provider
    : undefined;
  const contextWindowTokens = Number(input.contextWindowTokens);
  const capabilities = input.capabilities as Record<string, unknown> | undefined;
  const openaiApiMode = input.openaiApiMode === 'responses' || input.openaiApiMode === 'chat_completions'
    ? input.openaiApiMode
    : undefined;
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)
    || (catalogModelId && catalogModelId !== id)
    || !provider || !Number.isInteger(contextWindowTokens)
    || contextWindowTokens < 1_024 || contextWindowTokens > 4_000_000
    || !capabilities || typeof capabilities.toolCalling !== 'boolean'
    || typeof capabilities.streaming !== 'boolean'
    || typeof capabilities.vision !== 'boolean'
    || (provider === 'openai' && !openaiApiMode)) {
    return undefined;
  }
  return {
    id,
    ...(catalogModelId ? { catalogModelId } : {}),
    label: id,
    model,
    family: 'catalog',
    quotaClass: id,
    preferredProvider: provider,
    ...(provider === 'openai' ? { openaiApiMode } : {}),
    contextWindowTokens,
    modelsDevProvider: '',
    modelsDevModel: model,
    capabilities: {
      toolCalling: capabilities.toolCalling,
      vision: capabilities.vision,
      streaming: capabilities.streaming,
    },
  };
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
  DEEPSEEK_RELAY_MODEL_PROFILE,
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    model: 'glm-5.3-flash',
    family: 'glm',
    quotaClass: 'glm-5.3-flash',
    preferredProvider: 'anthropic',
    contextWindowTokens: 1_000_000,
    // models.dev uses the Zhipu provider slug for GLM metadata. Relay's
    // catalog remains authoritative when this capability fallback is absent.
    modelsDevProvider: 'zhipuai',
    modelsDevModel: 'glm-5.3-flash',
    capabilities: {
      toolCalling: true,
      vision: true,
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
    // Keep in sync with the cloud catalog (botModelCatalog). This is only a
    // device-local fallback: the cloud-authoritative value wins when the
    // server ships context_window_tokens for the selection.
    contextWindowTokens: 256_000,
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

export type RelayModelFamily = 'minimax' | 'deepseek' | 'glm';

export interface RelayModelCapabilities {
  toolCalling: boolean;
  vision: boolean;
  streaming: boolean;
}

export interface RelayModelProfile {
  id: string;
  label: string;
  model: string;
  family: RelayModelFamily;
  quotaClass: string;
  contextWindowTokens: number;
  capabilities: RelayModelCapabilities;
}

export const RELAY_MODEL_PROFILES: RelayModelProfile[] = [
  {
    id: 'minimax-m2.7',
    label: 'MiniMax M2.7',
    model: 'MiniMax-M2.7',
    family: 'minimax',
    quotaClass: 'standard',
    contextWindowTokens: 204_800,
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
    contextWindowTokens: 1_000_000,
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
    contextWindowTokens: 1_000_000,
    capabilities: {
      toolCalling: true,
      vision: false,
      streaming: true,
    },
  },
  {
    id: 'glm-5.1',
    label: 'GLM 5.1',
    model: 'glm-5.1',
    family: 'glm',
    quotaClass: 'standard',
    contextWindowTokens: 200_000,
    capabilities: {
      toolCalling: true,
      vision: false,
      streaming: true,
    },
  },
];

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

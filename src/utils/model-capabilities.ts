import { ChatConfig } from '../types';
import { findRelayModelProfile } from './relay-model-profiles';
import { probeVisionCapability, type VisionCapabilityState, type VisionProbeOptions } from './model-vision-probe';

const KNOWN_TEXT_ONLY_MODEL_PATTERNS = [
  /^deepseek-(?:chat|reasoner|v4-flash)$/i,
  /gpt-3\.5/i,
  /text-/i,
  /embedding/i,
  /minimax-m2/i,
  /m1-/i,
];

const KNOWN_VISION_MODEL_PATTERNS = [
  /claude/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /minimax-m3/i,
  /\bo3\b/i,
  /\bo4\b/i,
  /gemini/i,
  /qwen.*vl/i,
  /qwen.*vision/i,
  /glm.*v/i,
  /vision/i,
  /multimodal/i,
  /omni/i,
  /vl-/i,
];

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value));
}

export function isPrimaryModelVisionCapable(config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider' | 'modelCapabilities'>): boolean {
  if (config.modelCapabilities?.vision !== undefined) return config.modelCapabilities.vision;
  const apiUrl = (config.apiUrl || '').toLowerCase();
  const model = (config.model || '').trim();
  const modelKey = model.toLowerCase();
  const isRelay = apiUrl.includes('relay.catsco.cc');
  if (isRelay) {
    const relayProfile = findRelayModelProfile(model);
    if (relayProfile?.capabilities.vision !== undefined) {
      return relayProfile.capabilities.vision;
    }
  }

  // Anthropic-compatible endpoints from text-only providers often reject image blocks.
  if (apiUrl.includes('deepseek.com') || apiUrl.includes('minimaxi.com')) {
    return includesAny(modelKey, [/minimax-m3/i, /vision/i, /vl/i, /image/i, /multimodal/i, /omni/i]);
  }

  if (includesAny(modelKey, KNOWN_TEXT_ONLY_MODEL_PATTERNS)) {
    return false;
  }

  return includesAny(model, KNOWN_VISION_MODEL_PATTERNS);
}

/**
 * Resolves image-input support without turning transient network or auth
 * failures into permanent "text-only" facts. Catalog metadata wins; unknown
 * custom/relay models are actively probed and cached by endpoint + model + key.
 */
export async function resolvePrimaryModelVisionCapability(
  config: Pick<ChatConfig, 'apiUrl' | 'apiKey' | 'model' | 'provider' | 'openaiApiMode' | 'modelCapabilities'>,
  options: VisionProbeOptions = {},
): Promise<VisionCapabilityState> {
  if (config.modelCapabilities?.vision !== undefined) {
    return config.modelCapabilities.vision ? 'supported' : 'unsupported';
  }

  const apiUrl = (config.apiUrl || '').toLowerCase();
  const model = (config.model || '').trim();
  const modelKey = model.toLowerCase();
  if (apiUrl.includes('relay.catsco.cc')) {
    const relayProfile = findRelayModelProfile(model);
    if (relayProfile?.capabilities.vision !== undefined) {
      return relayProfile.capabilities.vision ? 'supported' : 'unsupported';
    }
  }

  if (apiUrl.includes('api.openai.com') && includesAny(modelKey, KNOWN_VISION_MODEL_PATTERNS)) {
    return 'supported';
  }
  if (apiUrl.includes('api.anthropic.com') && /claude/i.test(modelKey)) {
    return 'supported';
  }

  if (apiUrl.includes('deepseek.com') || apiUrl.includes('minimaxi.com')) {
    if (includesAny(modelKey, [/minimax-m3/i, /vision/i, /vl/i, /image/i, /multimodal/i, /omni/i])) {
      return 'supported';
    }
    if (includesAny(modelKey, KNOWN_TEXT_ONLY_MODEL_PATTERNS)) return 'unsupported';
  }

  if (includesAny(modelKey, KNOWN_TEXT_ONLY_MODEL_PATTERNS)) return 'unsupported';
  return probeVisionCapability(config, options);
}

export function isPrimaryModelToolCallingCapable(config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider' | 'modelCapabilities'>): boolean {
  if (config.modelCapabilities?.toolCalling !== undefined) return config.modelCapabilities.toolCalling;
  const apiUrl = (config.apiUrl || '').toLowerCase();
  if (apiUrl.includes('relay.catsco.cc')) {
    const relayProfile = findRelayModelProfile(config.model);
    if (relayProfile) {
      return relayProfile.capabilities.toolCalling;
    }
  }
  return true;
}

import { ChatConfig } from '../types';
import { findRelayModelProfile } from './relay-model-profiles';

const KNOWN_TEXT_ONLY_MODEL_PATTERNS = [
  /deepseek/i,
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

function optionalBooleanEnv(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return undefined;
}

export function isPrimaryModelVisionCapable(config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider'>): boolean {
  const apiUrl = (config.apiUrl || '').toLowerCase();
  const model = (config.model || '').trim();
  const modelKey = model.toLowerCase();
  const isRelay = apiUrl.includes('relay.catsco.cc');
  if (isRelay) {
    const explicitRelayVision = optionalBooleanEnv(process.env.CATSCO_RELAY_LLM_VISION_CAPABLE);
    if (explicitRelayVision !== undefined) return explicitRelayVision;
    const relayProfile = findRelayModelProfile(model);
    if (relayProfile) {
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

export function isPrimaryModelToolCallingCapable(config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider'>): boolean {
  const apiUrl = (config.apiUrl || '').toLowerCase();
  if (apiUrl.includes('relay.catsco.cc')) {
    const explicitToolCalling = optionalBooleanEnv(process.env.CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE);
    if (explicitToolCalling !== undefined) return explicitToolCalling;
    const relayProfile = findRelayModelProfile(config.model);
    if (relayProfile) {
      return relayProfile.capabilities.toolCalling;
    }
  }
  return true;
}

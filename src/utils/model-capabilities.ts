import { ChatConfig } from '../types';

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

export function isPrimaryModelVisionCapable(config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider'>): boolean {
  const apiUrl = (config.apiUrl || '').toLowerCase();
  const model = (config.model || '').trim();
  const modelKey = model.toLowerCase();

  // Anthropic-compatible endpoints from text-only providers often reject image blocks.
  if (apiUrl.includes('deepseek.com') || apiUrl.includes('minimaxi.com')) {
    return includesAny(modelKey, [/vision/i, /vl/i, /image/i, /multimodal/i, /omni/i]);
  }

  if (includesAny(modelKey, KNOWN_TEXT_ONLY_MODEL_PATTERNS)) {
    return false;
  }

  return includesAny(model, KNOWN_VISION_MODEL_PATTERNS);
}

export function isPrimaryModelToolCallingCapable(config: Pick<ChatConfig, 'apiUrl' | 'model' | 'provider'>): boolean {
  void config;
  return true;
}

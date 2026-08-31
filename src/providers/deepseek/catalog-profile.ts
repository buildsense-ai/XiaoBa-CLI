import type { RelayModelProfile } from '../../utils/relay-model-profiles';
import { DEEPSEEK_RESPONSES_PROFILE } from './responses-policy';

/** Stable XiaoBa catalog registration for the current DeepSeek integration. */
export const DEEPSEEK_RELAY_MODEL_PROFILE: RelayModelProfile = {
  id: DEEPSEEK_RESPONSES_PROFILE.publicModelId,
  label: 'DeepSeek V4 Flash',
  model: DEEPSEEK_RESPONSES_PROFILE.publicModelId,
  family: 'deepseek',
  quotaClass: 'flash-low',
  preferredProvider: 'openai',
  openaiApiMode: DEEPSEEK_RESPONSES_PROFILE.apiMode,
  contextWindowTokens: 1_000_000,
  modelsDevProvider: 'deepseek',
  modelsDevModel: DEEPSEEK_RESPONSES_PROFILE.publicModelId,
  capabilities: {
    toolCalling: true,
    // Relay maps this stable public ID to its current multimodal upstream.
    vision: true,
    streaming: true,
  },
};

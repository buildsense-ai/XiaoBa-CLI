import { ChatConfig } from '../types';

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_RELAY_MAX_TOKENS = 32768;

export function resolveMaxTokens(config: ChatConfig): number {
  if (Number.isFinite(config.maxTokens) && Number(config.maxTokens) > 0) {
    return Math.floor(Number(config.maxTokens));
  }

  const apiUrl = (config.apiUrl || '').toLowerCase();
  const model = (config.model || '').toLowerCase();
  if (apiUrl.includes('relay.catsco.cc') || model.includes('minimax-m2.7')) {
    return DEFAULT_RELAY_MAX_TOKENS;
  }

  return DEFAULT_MAX_TOKENS;
}

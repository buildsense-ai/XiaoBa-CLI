import { ChatConfig } from '../types';

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_RELAY_MAX_TOKENS = 32768;

export function resolveMaxTokens(config: ChatConfig): number {
  let maxTokens: number;
  if (Number.isFinite(config.maxTokens) && Number(config.maxTokens) > 0) {
    maxTokens = Math.floor(Number(config.maxTokens));
  } else {
    const apiUrl = (config.apiUrl || '').toLowerCase();
    const model = (config.model || '').toLowerCase();
    maxTokens = apiUrl.includes('relay.catsco.cc') || model.includes('minimax-m2.7') || model.includes('minimax-m3')
      ? DEFAULT_RELAY_MAX_TOKENS
      : DEFAULT_MAX_TOKENS;
  }

  const contextWindow = Number(config.contextWindowTokens);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    const contextBound = Math.max(1, Math.floor(contextWindow * 0.25));
    return Math.min(maxTokens, contextBound);
  }

  return maxTokens;
}

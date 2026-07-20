import { ConfigManager } from '../utils/config';

export interface CatsDeviceModelStatus {
  source: 'relay' | 'custom';
  model: string;
  updated_at: number;
}

interface ModelStatusOptions {
  env?: NodeJS.ProcessEnv;
  source?: 'relay' | 'custom';
  config?: {
    provider?: string;
    apiUrl?: string;
    apiKey?: string;
    model?: string;
  };
  now?: () => number;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function isCatsRelayApiBase(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === 'relay.catsco.cc';
  } catch {
    return value.toLowerCase().includes('relay.catsco.cc');
  }
}

export function resolveCatsDeviceModelStatus(options: ModelStatusOptions = {}): CatsDeviceModelStatus | undefined {
  const env = options.env || process.env;
  const config = options.config || ConfigManager.getConfigReadonly();
  const source = String(env.CATSCO_MODEL_SOURCE || '').trim().toLowerCase();
  const apiBase = firstNonEmpty(config.apiUrl, env.GAUZ_LLM_API_BASE);
  const apiKey = firstNonEmpty(config.apiKey, env.GAUZ_LLM_API_KEY);
  const model = firstNonEmpty(config.model, env.GAUZ_LLM_MODEL);
  const now = options.now || Date.now;

  if (options.source === 'relay') {
    if (!model) return undefined;
    return { source: 'relay', model, updated_at: now() };
  }

  if (options.source === 'custom') {
    const hasCustomSignal = Boolean(model || apiBase || apiKey);
    if (!hasCustomSignal) return undefined;
    return { source: 'custom', model: model || '鑷畾涔夋ā鍨?', updated_at: now() };
  }

  if (isCatsRelayApiBase(apiBase)) {
    if (!model) return undefined;
    return {
      source: 'relay',
      model,
      updated_at: now(),
    };
  }

  const hasCustomSignal = Boolean(model || apiBase || apiKey);
  if ((source === 'custom' && hasCustomSignal) || (apiKey && (model || apiBase))) {
    return {
      source: 'custom',
      model: model || '自定义模型',
      updated_at: now(),
    };
  }

  return undefined;
}

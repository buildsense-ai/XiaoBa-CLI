import { ConfigManager } from '../utils/config';

export interface CatsDeviceModelStatus {
  source: 'relay' | 'custom';
  model: string;
  updated_at: number;
}

interface ModelStatusOptions {
  env?: NodeJS.ProcessEnv;
  config?: {
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
  const apiBase = firstNonEmpty(env.GAUZ_LLM_API_BASE, config.apiUrl);
  const apiKey = firstNonEmpty(env.GAUZ_LLM_API_KEY, config.apiKey);
  const model = firstNonEmpty(env.GAUZ_LLM_MODEL, config.model);
  const now = options.now || Date.now;

  if (source === 'relay' || isCatsRelayApiBase(apiBase)) {
    if (!model) return undefined;
    return {
      source: 'relay',
      model,
      updated_at: now(),
    };
  }

  if (source === 'custom' || (apiKey && (model || apiBase))) {
    return {
      source: 'custom',
      model: model || '自定义模型',
      updated_at: now(),
    };
  }

  return undefined;
}

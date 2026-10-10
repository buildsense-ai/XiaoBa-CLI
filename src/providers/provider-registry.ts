import type {
  ChatConfig,
  ProviderIdentity,
  ProviderApiType,
} from '../types';
import { AnthropicProvider } from './anthropic-provider';
import { OpenAIProvider } from './openai-provider';
import type { AIProvider } from './provider';

export type ProviderConfig = Omit<ChatConfig, 'provider'> & {
  provider?: ProviderIdentity;
};

export interface ProviderRegistration {
  id: ProviderIdentity;
  create: (config: ProviderConfig) => AIProvider;
  apiType: ProviderApiType | ((config: ProviderConfig) => ProviderApiType);
  matches?: (config: ProviderConfig) => boolean;
}

export interface ProviderSelection {
  providerId: ProviderIdentity;
  apiType: ProviderApiType;
  provider: AIProvider;
}

export interface ProviderRegistryOptions {
  defaultProviderId?: ProviderIdentity;
}

/**
 * Owns provider identity resolution, wire-protocol selection, and runtime construction.
 * Registrations are intentionally injectable so AIService does not need provider-specific branches.
 */
export class ProviderRegistry {
  private readonly registrations = new Map<ProviderIdentity, ProviderRegistration>();
  private readonly defaultProviderId?: ProviderIdentity;

  constructor(options: ProviderRegistryOptions = {}) {
    this.defaultProviderId = options.defaultProviderId;
  }

  register(registration: ProviderRegistration): this {
    const id = normalizeIdentifier(registration.id, 'provider identity');
    if (this.registrations.has(id)) {
      throw new Error(`Provider "${id}" is already registered`);
    }
    if (typeof registration.create !== 'function') {
      throw new Error(`Provider "${id}" must define a factory`);
    }

    this.registrations.set(id, { ...registration, id });
    return this;
  }

  resolveProviderId(config: ProviderConfig): ProviderIdentity {
    if (config.provider !== undefined) {
      const explicit = normalizeIdentifier(config.provider, 'provider identity');
      this.requireRegistration(explicit);
      return explicit;
    }

    for (const registration of this.registrations.values()) {
      if (registration.matches?.(config)) return registration.id;
    }

    if (this.defaultProviderId !== undefined) {
      const fallback = normalizeIdentifier(this.defaultProviderId, 'default provider identity');
      this.requireRegistration(fallback);
      return fallback;
    }

    throw new Error('Unable to resolve provider: no provider was configured or matched');
  }

  resolveApiType(providerId: ProviderIdentity, config: ProviderConfig): ProviderApiType {
    const registration = this.requireRegistration(providerId);
    const apiType = typeof registration.apiType === 'function'
      ? registration.apiType(config)
      : registration.apiType;
    return normalizeIdentifier(apiType, `API protocol for provider "${providerId}"`) as ProviderApiType;
  }

  create(config: ProviderConfig): ProviderSelection {
    const providerId = this.resolveProviderId(config);
    const registration = this.requireRegistration(providerId);
    const resolvedConfig = config.provider === providerId ? config : { ...config, provider: providerId };
    const apiType = this.resolveApiType(providerId, resolvedConfig);
    return {
      providerId,
      apiType,
      provider: registration.create(resolvedConfig),
    };
  }

  private requireRegistration(providerId: ProviderIdentity): ProviderRegistration {
    const registration = this.registrations.get(providerId);
    if (!registration) {
      throw new Error(`Unknown provider "${providerId}"`);
    }
    return registration;
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry({ defaultProviderId: 'openai' })
    .register({
      id: 'anthropic',
      matches: config => looksLikeAnthropic(config),
      apiType: 'anthropic-messages',
      create: config => new AnthropicProvider(config as ChatConfig),
    })
    .register({
      id: 'openai',
      apiType: resolveOpenAIApiType,
      create: config => new OpenAIProvider(config as ChatConfig),
    });
}

function resolveOpenAIApiType(config: ProviderConfig): ProviderApiType {
  if (config.openaiApiMode === undefined || config.openaiApiMode === 'chat_completions') {
    return 'openai-chat-completions';
  }
  if (config.openaiApiMode === 'responses') {
    return 'openai-responses';
  }
  throw new Error(`Unknown API protocol "${String(config.openaiApiMode)}" for provider "openai"`);
}

function looksLikeAnthropic(config: ProviderConfig): boolean {
  const apiUrl = (config.apiUrl || '').toLowerCase();
  const model = (config.model || '').toLowerCase();
  return apiUrl.includes('anthropic') || apiUrl.includes('claude') || model.includes('claude');
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${label}: expected a non-empty string`);
  }
  return value.trim();
}

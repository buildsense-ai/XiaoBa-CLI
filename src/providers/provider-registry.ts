import type {
  BuiltInProviderId,
  ChatConfig,
  ProviderApiType,
  ProviderId,
  ProviderRuntimeConfig,
} from '../types';
import { AnthropicProvider } from './anthropic-provider';
import { OpenAIProvider } from './openai-provider';
import type { AIProvider } from './provider';

export interface ProviderFactoryContext {
  config: ProviderRuntimeConfig;
  providerId: ProviderId;
  apiType: ProviderApiType;
}

export interface ProviderAdapterRegistration {
  providerId: ProviderId;
  apiTypes: readonly ProviderApiType[];
  defaultApiType: ProviderApiType | ((config: ProviderRuntimeConfig) => ProviderApiType);
  create(context: ProviderFactoryContext): AIProvider;
}

export interface ProviderRegistryResult {
  provider: AIProvider;
  providerId: ProviderId;
  apiType: ProviderApiType;
}

/**
 * Separates provider identity from the wire protocol used for a request.
 * Registrations are instance-local so tests and embedders can inject adapters
 * without changing AIService or process-wide state.
 */
export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderAdapterRegistration>();

  register(registration: ProviderAdapterRegistration): this {
    const providerId = normalizeProviderId(registration.providerId);
    if (this.registrations.has(providerId)) {
      throw new Error(`Provider "${providerId}" is already registered`);
    }
    if (registration.apiTypes.length === 0) {
      throw new Error(`Provider "${providerId}" must declare at least one API protocol`);
    }

    const apiTypes = [...new Set(registration.apiTypes)];
    for (const apiType of apiTypes) assertKnownApiType(apiType, providerId);
    if (typeof registration.defaultApiType === 'string' && !apiTypes.includes(registration.defaultApiType)) {
      throw new Error(
        `Provider "${providerId}" default API protocol "${registration.defaultApiType}" is not supported`,
      );
    }

    this.registrations.set(providerId, { ...registration, providerId, apiTypes });
    return this;
  }

  create(config: ProviderRuntimeConfig): ProviderRegistryResult {
    const providerId = this.resolveProviderId(config);
    const registration = this.registrations.get(providerId);
    if (!registration) {
      const available = [...this.registrations.keys()].sort().join(', ') || '(none)';
      throw new Error(`Unknown provider "${providerId}". Registered providers: ${available}`);
    }

    const apiType = config.providerApiType
      ?? (typeof registration.defaultApiType === 'function'
        ? registration.defaultApiType(config)
        : registration.defaultApiType);
    assertKnownApiType(apiType, providerId);
    if (!registration.apiTypes.includes(apiType)) {
      throw new Error(`Provider "${providerId}" does not support API protocol "${apiType}"`);
    }

    const resolvedConfig: ProviderRuntimeConfig = { ...config, provider: providerId };
    return {
      provider: registration.create({ config: resolvedConfig, providerId, apiType }),
      providerId,
      apiType,
    };
  }

  private resolveProviderId(config: ProviderRuntimeConfig): string {
    if (config.provider !== undefined) return normalizeProviderId(config.provider);
    const apiUrl = (config.apiUrl || '').toLowerCase();
    const model = (config.model || '').toLowerCase();
    return apiUrl.includes('anthropic') || apiUrl.includes('claude') || model.includes('claude')
      ? 'anthropic'
      : 'openai';
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register({
      providerId: 'openai',
      apiTypes: ['openai-chat-completions', 'openai-responses'],
      defaultApiType: config => config.openaiApiMode === 'responses'
        ? 'openai-responses'
        : 'openai-chat-completions',
      create: ({ config, apiType }) => new OpenAIProvider({
        ...toBuiltInChatConfig(config, 'openai'),
        openaiApiMode: apiType === 'openai-responses' ? 'responses' : 'chat_completions',
      }),
    })
    .register({
      providerId: 'anthropic',
      apiTypes: ['anthropic-messages'],
      defaultApiType: 'anthropic-messages',
      create: ({ config }) => new AnthropicProvider(toBuiltInChatConfig(config, 'anthropic')),
    });
}

function toBuiltInChatConfig(config: ProviderRuntimeConfig, provider: BuiltInProviderId): ChatConfig {
  const { provider: _provider, providerApiType: _providerApiType, ...chatConfig } = config;
  return { ...chatConfig, provider };
}

function normalizeProviderId(providerId: ProviderId): string {
  if (typeof providerId !== 'string' || providerId.trim() === '') {
    throw new Error('Invalid provider configuration: provider must be a non-empty string');
  }
  return providerId.trim();
}

function assertKnownApiType(apiType: ProviderApiType, providerId: string): void {
  if (!['anthropic-messages', 'openai-chat-completions', 'openai-responses'].includes(apiType)) {
    throw new Error(`Provider "${providerId}" selected unknown API protocol "${String(apiType)}"`);
  }
}

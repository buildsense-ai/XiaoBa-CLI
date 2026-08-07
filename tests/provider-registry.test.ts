import { test } from 'node:test';
import * as assert from 'node:assert';
import type { ChatConfig, ChatResponse, ProviderApiType } from '../src/types';
import type { AIProvider, StreamCallbacks } from '../src/providers/provider';
import {
  createDefaultProviderRegistry,
  ProviderRegistry,
  type ProviderConfig,
} from '../src/providers/provider-registry';
import { AIService } from '../src/utils/ai-service';

test('default registry preserves built-in provider and wire protocol mappings', () => {
  const registry = createDefaultProviderRegistry();
  const openAIConfig: ChatConfig = {
    apiKey: 'test-key',
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  };

  assert.equal(registry.resolveProviderId(openAIConfig), 'openai');
  assert.equal(registry.resolveApiType('openai', openAIConfig), 'openai-chat-completions');
  assert.equal(
    registry.resolveApiType('openai', { ...openAIConfig, openaiApiMode: 'responses' }),
    'openai-responses',
  );

  const anthropicConfig: ChatConfig = {
    apiKey: 'test-key',
    apiUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
  };
  assert.equal(registry.resolveProviderId(anthropicConfig), 'anthropic');
  assert.equal(registry.resolveApiType('anthropic', anthropicConfig), 'anthropic-messages');
});

test('AIService selects an injected custom provider without provider-specific branches', async () => {
  const response: ChatResponse = { content: 'custom response' };
  let constructedWith: ProviderConfig | undefined;
  const customProvider: AIProvider = {
    chat: async () => response,
    chatStream: async (_messages, _tools, callbacks?: StreamCallbacks) => {
      callbacks?.onText?.('custom response');
      return response;
    },
  };
  const registry = new ProviderRegistry()
    .register({
      id: 'test-custom',
      apiType: 'openai-chat-completions',
      create: config => {
        constructedWith = config;
        return customProvider;
      },
    });
  const service = new AIService({
    provider: 'test-custom',
    apiKey: 'test-key',
    apiUrl: 'https://custom.example.test/v1',
    model: 'custom-model',
  }, registry);
  const attemptEvents: any[] = [];

  const result = await service.chat([{ role: 'user', content: 'hello' }], undefined, {
    modelAttemptSink: { observe: event => { attemptEvents.push(event); } },
  });

  assert.equal(result, response);
  assert.equal(constructedWith?.provider, 'test-custom');
  assert.equal(service.getConfig().provider, 'test-custom');
  assert.equal(attemptEvents[0].provider, 'test-custom');
  assert.equal(attemptEvents[0].apiType, 'openai-chat-completions');
  assert.equal(attemptEvents[attemptEvents.length - 1].outcome, 'succeeded');
});

test('registry rejects unknown provider configuration with a clear error', () => {
  assert.throws(
    () => new AIService({
      provider: 'missing-provider',
      apiKey: 'test-key',
      apiUrl: 'https://missing.example.test/v1',
      model: 'missing-model',
    }, createDefaultProviderRegistry()),
    /Unknown provider "missing-provider"/,
  );
});

test('registry rejects invalid built-in and custom protocol configuration', () => {
  const invalidOpenAIConfig = {
    provider: 'openai',
    apiKey: 'test-key',
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    openaiApiMode: 'legacy-completions',
  } as unknown as ChatConfig;

  assert.throws(
    () => createDefaultProviderRegistry().create(invalidOpenAIConfig),
    /Unknown API protocol "legacy-completions" for provider "openai"/,
  );

  const invalidCustomRegistry = new ProviderRegistry().register({
    id: 'invalid-custom',
    apiType: () => '   ' as ProviderApiType,
    create: () => ({
      chat: async () => ({ content: 'unused' }),
      chatStream: async () => ({ content: 'unused' }),
    }),
  });
  assert.throws(
    () => invalidCustomRegistry.create({ provider: 'invalid-custom' }),
    /Invalid API protocol for provider "invalid-custom": expected a non-empty string/,
  );
});

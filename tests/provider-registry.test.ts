import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ChatConfig, ChatResponse, ProviderRuntimeConfig } from '../src/types';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { OpenAIProvider } from '../src/providers/openai-provider';
import type { AIProvider } from '../src/providers/provider';
import { ProviderRegistry, createDefaultProviderRegistry } from '../src/providers/provider-registry';
import { AIService } from '../src/utils/ai-service';

const baseConfig: ChatConfig = {
  apiUrl: 'https://provider.example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

test('default registry maps provider identity to each built-in wire protocol', () => {
  const registry = createDefaultProviderRegistry();

  const chatCompletions = registry.create({ ...baseConfig, provider: 'openai' });
  assert.equal(chatCompletions.providerId, 'openai');
  assert.equal(chatCompletions.apiType, 'openai-chat-completions');
  assert.ok(chatCompletions.provider instanceof OpenAIProvider);

  const responses = registry.create({
    ...baseConfig,
    provider: 'openai',
    openaiApiMode: 'responses',
  });
  assert.equal(responses.providerId, 'openai');
  assert.equal(responses.apiType, 'openai-responses');
  assert.ok(responses.provider instanceof OpenAIProvider);

  const anthropic = registry.create({ ...baseConfig, provider: 'anthropic' });
  assert.equal(anthropic.providerId, 'anthropic');
  assert.equal(anthropic.apiType, 'anthropic-messages');
  assert.ok(anthropic.provider instanceof AnthropicProvider);
});

test('default registry preserves provider inference for omitted identity', () => {
  const registry = createDefaultProviderRegistry();
  assert.equal(registry.create({ ...baseConfig, apiUrl: 'https://api.anthropic.com' }).providerId, 'anthropic');
  assert.equal(registry.create({ ...baseConfig, model: 'claude-test' }).providerId, 'anthropic');
  assert.equal(registry.create(baseConfig).providerId, 'openai');
});

test('AIService selects an injected custom provider without changing AIService', async () => {
  const response: ChatResponse = { content: 'custom provider response' };
  const customProvider: AIProvider = {
    chat: async () => response,
    chatStream: async () => response,
  };
  const registry = new ProviderRegistry().register({
    providerId: 'test-custom',
    apiTypes: ['openai-chat-completions'],
    defaultApiType: 'openai-chat-completions',
    create: () => customProvider,
  });
  const service = new AIService({ ...baseConfig, provider: 'test-custom' }, { providerRegistry: registry });
  const events: any[] = [];

  const result = await service.chat([], undefined, {
    modelAttemptSink: { observe: event => events.push(event) },
  });

  assert.equal(result, response);
  assert.deepEqual(events.map(event => event.outcome), ['started', 'succeeded']);
  assert.ok(events.every(event => event.provider === 'test-custom'));
  assert.ok(events.every(event => event.apiType === 'openai-chat-completions'));
});

test('registry fails clearly for unknown providers and invalid protocol selections', () => {
  const registry = createDefaultProviderRegistry();
  assert.throws(
    () => registry.create({ ...baseConfig, provider: 'missing-provider' }),
    /Unknown provider "missing-provider"\. Registered providers: anthropic, openai/,
  );
  assert.throws(
    () => registry.create({ ...baseConfig, provider: 'anthropic', providerApiType: 'openai-responses' }),
    /Provider "anthropic" does not support API protocol "openai-responses"/,
  );
  assert.throws(
    () => registry.create({
      ...baseConfig,
      provider: 'openai',
      providerApiType: 'unknown-protocol' as ProviderRuntimeConfig['providerApiType'],
    }),
    /Provider "openai" selected unknown API protocol "unknown-protocol"/,
  );
});

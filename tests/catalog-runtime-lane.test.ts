import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogRuntimeMatchesModelId } from '../src/bot-definition/service';
import type { BotCatalogModelRuntime } from '../src/bot-definition/types';
import type { RelayModelRuntimeDescriptor } from '../src/utils/relay-model-profiles';

const MODEL_ID = 'deepseek-flash';

function runtime(overrides: Partial<BotCatalogModelRuntime> = {}): BotCatalogModelRuntime {
  return {
    schema: 'xiaoba.bot-catalog-model-runtime.v1',
    botId: '42',
    modelId: MODEL_ID,
    provider: 'openai',
    apiBase: 'https://relay.catsco.cc/v1',
    apiKey: 'relay-key',
    model: MODEL_ID,
    contextWindowTokens: 1_000_000,
    openaiApiMode: 'responses',
    ...overrides,
  };
}

function descriptor(provider: 'openai' | 'anthropic'): RelayModelRuntimeDescriptor {
  return {
    catalogModelId: MODEL_ID,
    model: MODEL_ID,
    provider,
    ...(provider === 'openai' ? { openaiApiMode: 'responses' as const } : {}),
    contextWindowTokens: 1_000_000,
    capabilities: { vision: false, toolCalling: true, streaming: true },
  };
}

test('a runtime persisted on the retired lane stops matching the cloud lane', () => {
  const stale = runtime({ provider: 'anthropic', apiBase: 'https://relay.catsco.cc/anthropic' });

  assert.equal(catalogRuntimeMatchesModelId(stale, MODEL_ID, descriptor('openai')), false);
  assert.equal(
    catalogRuntimeMatchesModelId(runtime({ provider: 'openai' }), MODEL_ID, descriptor('openai')),
    true,
  );
});

test('the lane check follows the descriptor instead of a hardcoded provider', () => {
  // Moving a bot the other way must heal exactly the same way; the descriptor
  // is the only authority, the client never guesses.
  const openaiRuntime = runtime({ provider: 'openai' });

  assert.equal(catalogRuntimeMatchesModelId(openaiRuntime, MODEL_ID, descriptor('anthropic')), false);
  assert.equal(
    catalogRuntimeMatchesModelId(
      runtime({ provider: 'anthropic', apiBase: 'https://relay.catsco.cc/anthropic' }),
      MODEL_ID,
      descriptor('anthropic'),
    ),
    true,
  );
});

test('local definitions without a cloud descriptor keep ignoring the provider', () => {
  // Offline/local activation has no authoritative descriptor. It must not
  // rewrite a working runtime just because the provider looks unexpected.
  assert.equal(
    catalogRuntimeMatchesModelId(runtime({ provider: 'anthropic' }), MODEL_ID),
    true,
  );
  assert.equal(
    catalogRuntimeMatchesModelId(runtime({ provider: 'anthropic' }), MODEL_ID, undefined),
    true,
  );
});

test('model id and relay-facing model name are still enforced', () => {
  assert.equal(catalogRuntimeMatchesModelId(runtime(), 'glm-5.3-flash', descriptor('openai')), false);
  assert.equal(
    catalogRuntimeMatchesModelId(runtime({ model: 'other-model' }), MODEL_ID, descriptor('openai')),
    false,
  );
});

test('a legacy runtime without a provider is re-materialized under a descriptor', () => {
  const legacy = runtime();
  delete (legacy as Partial<BotCatalogModelRuntime>).provider;

  assert.equal(catalogRuntimeMatchesModelId(legacy, MODEL_ID, descriptor('openai')), false);
});

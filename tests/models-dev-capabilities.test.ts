import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchModelsDevVision,
  resolveModelsDevVision,
} from '../src/utils/models-dev-capabilities';

test('models.dev vision lookup prefers the configured first-party provider', () => {
  const catalog = {
    minimax: {
      models: {
        'MiniMax-M3': {
          id: 'MiniMax-M3',
          modalities: { input: ['text', 'image', 'video'] },
        },
      },
    },
    hosted: {
      models: {
        'MiniMax-M3': {
          id: 'MiniMax-M3',
          modalities: { input: ['text'] },
        },
      },
    },
  };

  assert.equal(resolveModelsDevVision(catalog, { provider: 'minimax', model: 'MiniMax-M3' }), true);
  assert.equal(resolveModelsDevVision(catalog, { provider: 'hosted', model: 'MiniMax-M3' }), false);
});

test('models.dev vision lookup discovers an unknown relay model by leaf id', () => {
  const catalog = {
    provider: {
      models: {
        'vendor/new-model': {
          id: 'vendor/new-model',
          modalities: { input: ['text', 'image'] },
        },
      },
    },
  };

  assert.equal(resolveModelsDevVision(catalog, { model: 'new-model' }), true);
  assert.equal(resolveModelsDevVision(catalog, { model: 'missing-model' }), undefined);
});

test('models.dev leaf lookup returns undefined when providers disagree', () => {
  const catalog = {
    first: {
      models: {
        'a/shared-model': { modalities: { input: ['text'] } },
      },
    },
    second: {
      models: {
        'b/shared-model': { modalities: { input: ['text', 'image'] } },
      },
    },
  };

  assert.equal(resolveModelsDevVision(catalog, { model: 'shared-model' }), undefined);
});

test('models.dev fetch failures are negatively cached without blocking model setup', async () => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    return new Response('', { status: 503 });
  }) as typeof fetch;
  const first = await fetchModelsDevVision(
    { provider: 'openai', model: 'gpt-5.6-terra' },
    fetchImpl,
  );
  const second = await fetchModelsDevVision(
    { provider: 'openai', model: 'gpt-5.6-terra' },
    fetchImpl,
  );

  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(requests, 1);
});

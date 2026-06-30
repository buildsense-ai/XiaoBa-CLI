import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCatsDeviceModelStatus } from '../src/catscompany/model-status';

test('reports selected CatsCo relay model status', () => {
  const status = resolveCatsDeviceModelStatus({
    env: {
      CATSCO_MODEL_SOURCE: 'relay',
      GAUZ_LLM_MODEL: 'MiniMax-M3',
      GAUZ_LLM_API_BASE: 'https://relay.catsco.cc/anthropic',
    } as NodeJS.ProcessEnv,
    config: {},
    now: () => 1782790000000,
  });

  assert.deepEqual(status, {
    source: 'relay',
    model: 'MiniMax-M3',
    updated_at: 1782790000000,
  });
});

test('treats relay base URL as relay even when source is absent', () => {
  const status = resolveCatsDeviceModelStatus({
    env: {
      GAUZ_LLM_MODEL: 'deepseek-v4-flash',
      GAUZ_LLM_API_BASE: 'https://relay.catsco.cc/anthropic',
    } as NodeJS.ProcessEnv,
    config: {},
    now: () => 1782790000001,
  });

  assert.equal(status?.source, 'relay');
  assert.equal(status?.model, 'deepseek-v4-flash');
});

test('reports custom model status without exposing endpoint or key', () => {
  const status = resolveCatsDeviceModelStatus({
    env: {
      CATSCO_MODEL_SOURCE: 'custom',
      GAUZ_LLM_MODEL: 'gpt-5.5',
      GAUZ_LLM_API_BASE: 'https://example.test/v1',
      GAUZ_LLM_API_KEY: 'sk-secret',
    } as NodeJS.ProcessEnv,
    config: {},
    now: () => 1782790000002,
  });

  assert.deepEqual(status, {
    source: 'custom',
    model: 'gpt-5.5',
    updated_at: 1782790000002,
  });
});

test('falls back to custom label when a custom source has no model name', () => {
  const status = resolveCatsDeviceModelStatus({
    env: {
      CATSCO_MODEL_SOURCE: 'custom',
    } as NodeJS.ProcessEnv,
    config: {},
    now: () => 1782790000003,
  });

  assert.equal(status?.source, 'custom');
  assert.equal(status?.model, '自定义模型');
});

test('does not report default config when no model source is configured', () => {
  const status = resolveCatsDeviceModelStatus({
    env: {} as NodeJS.ProcessEnv,
    config: {
      apiUrl: 'https://api.openai.com/v1',
      model: 'gpt-3.5-turbo',
    },
    now: () => 1782790000004,
  });

  assert.equal(status, undefined);
});

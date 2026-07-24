import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDistillationHeartbeatModelConfig } from '../src/utils/distillation-heartbeat-model-config';

describe('Distillation Heartbeat model configuration', () => {
  test('inherits the primary model by default', () => {
    const config = getDistillationHeartbeatModelConfig({});
    assert.equal(config.mode, 'inherit');
    assert.equal(config.override, undefined);
  });

  test('resolves an independent provider without leaking undefined overrides', () => {
    const config = getDistillationHeartbeatModelConfig({
      DISTILLATION_HEARTBEAT_LLM_MODE: 'custom',
      DISTILLATION_HEARTBEAT_LLM_PROVIDER: 'openai',
      DISTILLATION_HEARTBEAT_LLM_API_BASE: 'https://models.example.test/v1',
      DISTILLATION_HEARTBEAT_LLM_API_KEY: 'heartbeat-secret',
      DISTILLATION_HEARTBEAT_LLM_MODEL: 'heartbeat-model',
      DISTILLATION_HEARTBEAT_LLM_CONTEXT_WINDOW_TOKENS: '256000',
      DISTILLATION_HEARTBEAT_LLM_REASONING_EFFORT: 'high',
      DISTILLATION_HEARTBEAT_LLM_OPENAI_API_MODE: 'responses',
    });
    assert.equal(config.mode, 'custom');
    assert.deepEqual(config.override, {
      provider: 'openai',
      apiUrl: 'https://models.example.test/v1',
      apiKey: 'heartbeat-secret',
      model: 'heartbeat-model',
      contextWindowTokens: 256000,
      reasoningEffort: 'high',
      openaiApiMode: 'responses',
    });
  });

  test('rejects an incomplete independent model', () => {
    assert.throws(
      () => getDistillationHeartbeatModelConfig({
        DISTILLATION_HEARTBEAT_LLM_MODE: 'custom',
        DISTILLATION_HEARTBEAT_LLM_PROVIDER: 'anthropic',
        DISTILLATION_HEARTBEAT_LLM_API_BASE: 'https://models.example.test',
        DISTILLATION_HEARTBEAT_LLM_MODEL: 'heartbeat-model',
      }),
      /requires provider, API base, API key, and model/,
    );
  });

  test('reads independent settings from a runtime .env file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-heartbeat-model-'));
    try {
      fs.writeFileSync(path.join(root, '.env'), [
        'DISTILLATION_HEARTBEAT_LLM_MODE=custom',
        'DISTILLATION_HEARTBEAT_LLM_PROVIDER=anthropic',
        'DISTILLATION_HEARTBEAT_LLM_API_BASE=https://models.example.test',
        'DISTILLATION_HEARTBEAT_LLM_API_KEY=secret',
        'DISTILLATION_HEARTBEAT_LLM_MODEL=heartbeat-model',
      ].join('\n'));
      const config = getDistillationHeartbeatModelConfig({}, root);
      assert.equal(config.override?.model, 'heartbeat-model');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

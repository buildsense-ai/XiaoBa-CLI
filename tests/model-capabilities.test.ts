import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { isPrimaryModelVisionCapable } from '../src/utils/model-capabilities';

describe('model capabilities', () => {
  test('treats Claude and GPT vision-capable models as multimodal', () => {
    assert.strictEqual(isPrimaryModelVisionCapable({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }), true);
    assert.strictEqual(isPrimaryModelVisionCapable({ provider: 'openai', model: 'gpt-4o' }), true);
  });

  test('treats DeepSeek and MiniMax text models as non-vision even through compatible endpoints', () => {
    assert.strictEqual(
      isPrimaryModelVisionCapable({
        provider: 'anthropic',
        apiUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-flash',
      }),
      false,
    );
    assert.strictEqual(
      isPrimaryModelVisionCapable({
        provider: 'anthropic',
        apiUrl: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M2.7',
      }),
      false,
    );
  });
});

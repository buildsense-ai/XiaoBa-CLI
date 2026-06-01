import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  isPrimaryModelToolCallingCapable,
  isPrimaryModelVisionCapable,
} from '../src/utils/model-capabilities';

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

  test('treats MiniMax M3 as vision-capable through MiniMax and relay endpoints', () => {
    assert.strictEqual(
      isPrimaryModelVisionCapable({
        provider: 'anthropic',
        apiUrl: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M3',
      }),
      true,
    );
    assert.strictEqual(
      isPrimaryModelVisionCapable({
        provider: 'anthropic',
        apiUrl: 'https://relay.catsco.cc/anthropic',
        model: 'MiniMax-M3',
      }),
      true,
    );
  });

  test('keeps relay tool calling enabled for MiniMax, DeepSeek, and GLM', () => {
    assert.strictEqual(
      isPrimaryModelToolCallingCapable({
        provider: 'anthropic',
        apiUrl: 'https://relay.catsco.cc/anthropic',
        model: 'deepseek-v4-flash',
      }),
      true,
    );
    assert.strictEqual(
      isPrimaryModelToolCallingCapable({
        provider: 'anthropic',
        apiUrl: 'https://relay.catsco.cc/anthropic',
        model: 'glm-5.1',
      }),
      true,
    );
    assert.strictEqual(
      isPrimaryModelToolCallingCapable({
        provider: 'anthropic',
        apiUrl: 'https://relay.catsco.cc/anthropic',
        model: 'MiniMax-M2.7',
      }),
      true,
    );
    assert.strictEqual(
      isPrimaryModelToolCallingCapable({
        provider: 'anthropic',
        apiUrl: 'https://relay.catsco.cc/anthropic',
        model: 'MiniMax-M3',
      }),
      true,
    );
  });
});

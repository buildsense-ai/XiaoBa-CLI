import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  isPrimaryModelToolCallingCapable,
  isPrimaryModelVisionCapable,
} from '../src/utils/model-capabilities';
import { RELAY_MODEL_PROFILES, findRelayModelProfile } from '../src/utils/relay-model-profiles';

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

  test('uses explicit relay model profiles for CatsCo relay vision capabilities', () => {
    assert.deepStrictEqual(
      RELAY_MODEL_PROFILES.map(profile => ({
        model: profile.model,
        provider: profile.preferredProvider,
        vision: profile.capabilities.vision,
        context: profile.contextWindowTokens,
      })),
      [
        { model: 'MiniMax-M2.7', provider: 'anthropic', vision: false, context: 204_800 },
        { model: 'MiniMax-M3', provider: 'anthropic', vision: true, context: 1_000_000 },
        { model: 'deepseek-v4-flash', provider: 'anthropic', vision: false, context: 1_000_000 },
        { model: 'gpt-5.6-terra', provider: 'openai', vision: true, context: 1_000_000 },
        { model: 'gpt-5.6-sol', provider: 'openai', vision: true, context: 1_000_000 },
        { model: 'gpt-5.6-luna', provider: 'openai', vision: true, context: 1_000_000 },
      ],
    );
    assert.strictEqual(findRelayModelProfile('minimax-m3')?.capabilities.vision, true);
    assert.strictEqual(findRelayModelProfile('MiniMax-M2.7')?.capabilities.vision, false);
    assert.strictEqual(findRelayModelProfile('gpt-5.6-terra')?.openaiApiMode, 'responses');
  });

  test('keeps relay tool calling enabled for public MiniMax and DeepSeek models', () => {
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

  test('respects capabilities carried by the active catalog runtime', () => {
    const config = {
      provider: 'anthropic' as const,
      apiUrl: 'https://relay.catsco.cc/anthropic',
      model: 'MiniMax-M3',
      modelCapabilities: { vision: false, toolCalling: false },
    };

    assert.strictEqual(isPrimaryModelVisionCapable(config), false);
    assert.strictEqual(isPrimaryModelToolCallingCapable(config), false);
  });
});

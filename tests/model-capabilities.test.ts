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
        { model: 'glm-5.1', provider: 'anthropic', vision: false, context: 200_000 },
      ],
    );
    assert.strictEqual(findRelayModelProfile('minimax-m3')?.capabilities.vision, true);
    assert.strictEqual(findRelayModelProfile('MiniMax-M2.7')?.capabilities.vision, false);
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

  test('respects persisted relay capability overrides from CatsCo model catalog', () => {
    const previousVision = process.env.CATSCO_RELAY_LLM_VISION_CAPABLE;
    const previousToolCalling = process.env.CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE;
    try {
      process.env.CATSCO_RELAY_LLM_VISION_CAPABLE = 'false';
      process.env.CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE = 'false';

      assert.strictEqual(
        isPrimaryModelVisionCapable({
          provider: 'anthropic',
          apiUrl: 'https://relay.catsco.cc/anthropic',
          model: 'MiniMax-M3',
        }),
        false,
      );
      assert.strictEqual(
        isPrimaryModelToolCallingCapable({
          provider: 'anthropic',
          apiUrl: 'https://relay.catsco.cc/anthropic',
          model: 'MiniMax-M3',
        }),
        false,
      );
    } finally {
      if (previousVision === undefined) delete process.env.CATSCO_RELAY_LLM_VISION_CAPABLE;
      else process.env.CATSCO_RELAY_LLM_VISION_CAPABLE = previousVision;
      if (previousToolCalling === undefined) delete process.env.CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE;
      else process.env.CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE = previousToolCalling;
    }
  });
});

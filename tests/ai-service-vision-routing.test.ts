import test from 'node:test';
import assert from 'node:assert/strict';
import { AIService } from '../src/utils/ai-service';

function withDirectImageOverride(value: string | undefined, fn: () => void): void {
  const previous = process.env.XIAOBA_DIRECT_IMAGE_INPUT;
  if (value === undefined) {
    delete process.env.XIAOBA_DIRECT_IMAGE_INPUT;
  } else {
    process.env.XIAOBA_DIRECT_IMAGE_INPUT = value;
  }

  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.XIAOBA_DIRECT_IMAGE_INPUT;
    } else {
      process.env.XIAOBA_DIRECT_IMAGE_INPUT = previous;
    }
  }
}

test('does not trust generic OpenAI-compatible endpoints as direct image models', () => {
  withDirectImageOverride(undefined, () => {
    const aiService = new AIService({
      provider: 'openai',
      apiUrl: 'https://example-proxy.local/v1',
      apiKey: 'test-key',
      model: 'gpt-4.1',
    });

    assert.equal(aiService.supportsDirectImageInput(), false);
  });
});

test('allows known OpenAI vision-capable models on official OpenAI endpoint', () => {
  withDirectImageOverride(undefined, () => {
    const aiService = new AIService({
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4.1',
    });

    assert.equal(aiService.supportsDirectImageInput(), true);
  });
});

test('allows custom endpoints only when the model name explicitly advertises vision', () => {
  withDirectImageOverride(undefined, () => {
    const aiService = new AIService({
      provider: 'openai',
      apiUrl: 'https://example-proxy.local/v1',
      apiKey: 'test-key',
      model: 'my-model-vl',
    });

    assert.equal(aiService.supportsDirectImageInput(), true);
  });
});

test('explicit false override forces reader fallback', () => {
  withDirectImageOverride('false', () => {
    const aiService = new AIService({
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
    });

    assert.equal(aiService.supportsDirectImageInput(), false);
  });
});

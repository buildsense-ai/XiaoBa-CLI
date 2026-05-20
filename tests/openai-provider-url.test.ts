import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { normalizeOpenAIChatCompletionsUrl } from '../src/providers/openai-url';
import { OpenAIProvider } from '../src/providers/openai-provider';

test('normalizeOpenAIChatCompletionsUrl accepts SDK-style base URLs', () => {
  assert.equal(
    normalizeOpenAIChatCompletionsUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions',
  );
  assert.equal(
    normalizeOpenAIChatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions',
  );
  assert.equal(
    normalizeOpenAIChatCompletionsUrl('https://api.deepseek.com/v1/'),
    'https://api.deepseek.com/v1/chat/completions',
  );
});

test('normalizeOpenAIChatCompletionsUrl keeps complete chat completions endpoints', () => {
  assert.equal(
    normalizeOpenAIChatCompletionsUrl('https://api.deepseek.com/chat/completions'),
    'https://api.deepseek.com/chat/completions',
  );
  assert.equal(
    normalizeOpenAIChatCompletionsUrl('https://example.test/openai/deployments/test/chat/completions?api-version=2024-06-01'),
    'https://example.test/openai/deployments/test/chat/completions?api-version=2024-06-01',
  );
});

test('OpenAIProvider posts to normalized endpoint while preserving configured apiUrl', async () => {
  const originalPost = axios.post;
  let seenUrl = '';

  (axios as any).post = async (url: string) => {
    seenUrl = url;
    return {
      data: {
        choices: [{ message: { content: 'ok' } }],
      },
    };
  };

  try {
    const provider = new OpenAIProvider({
      apiUrl: 'https://api.deepseek.com',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
    });

    assert.equal((provider as any).apiUrl, 'https://api.deepseek.com');
    await provider.chat([{ role: 'user', content: 'hello' }]);
    assert.equal(seenUrl, 'https://api.deepseek.com/chat/completions');
  } finally {
    (axios as any).post = originalPost;
  }
});

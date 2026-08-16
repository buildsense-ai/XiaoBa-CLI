import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { AnthropicProvider } from '../src/providers/anthropic-provider';

function createProvider(): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    apiUrl: 'https://anthropic-compatible.example.test/v1/messages',
    model: 'claude-sonnet-4-20250514',
  });
}

test('AnthropicProvider disables SDK retries for bounded requests', async () => {
  const provider = createProvider();
  let createOptions: any;
  let streamOptions: any;
  (provider as any).client = {
    messages: {
      create: async (_params: unknown, options: unknown) => {
        createOptions = options;
        return {};
      },
      stream: (_params: unknown, options: unknown) => {
        streamOptions = options;
        return {};
      },
    },
  };

  await (provider as any).createMessage({}, { retryMode: 'none' });
  (provider as any).createMessageStream({}, { retryMode: 'none' });

  assert.equal(createOptions.maxRetries, 0);
  assert.equal(streamOptions.maxRetries, 0);
});

test('AnthropicProvider preserves SDK default retries outside bounded requests', async () => {
  const provider = createProvider();
  let createOptions: any;
  (provider as any).client = {
    messages: {
      create: async (_params: unknown, options: unknown) => {
        createOptions = options;
        return {};
      },
    },
  };

  await (provider as any).createMessage({}, {});

  assert.equal(createOptions.maxRetries, undefined);
});

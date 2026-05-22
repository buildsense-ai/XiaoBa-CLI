import { afterEach, test } from 'node:test';
import * as assert from 'node:assert';
import { AIService } from '../src/utils/ai-service';
import type { ChatResponse } from '../src/types';
import type { StreamCallbacks } from '../src/providers/provider';

const originalStreamRetry = process.env.GAUZ_STREAM_RETRY;

afterEach(() => {
  if (originalStreamRetry === undefined) {
    delete process.env.GAUZ_STREAM_RETRY;
  } else {
    process.env.GAUZ_STREAM_RETRY = originalStreamRetry;
  }
});

test('AIService reports stream provider errors once', async () => {
  const service = createTestService();
  const rawError = new Error('provider stream failed');
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      callbacks?.onError?.(rawError);
      throw rawError;
    },
  };

  const errors: Error[] = [];
  await assert.rejects(
    () => service.chatStream([], undefined, { onError: error => errors.push(error) }),
    /请求失败: provider stream failed/,
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /请求失败: provider stream failed/);
});

test('AIService does not surface transient stream errors when retry succeeds', async () => {
  process.env.GAUZ_STREAM_RETRY = 'true';
  const service = createTestService();
  let attempts = 0;
  const finalResponse: ChatResponse = { content: 'ok' };
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      attempts += 1;
      if (attempts === 1) {
        const retryableError = Object.assign(new Error('temporary stream failure'), {
          response: { status: 503, data: { message: 'temporary stream failure' } },
        });
        callbacks?.onError?.(retryableError);
        throw retryableError;
      }

      callbacks?.onText?.('ok');
      callbacks?.onComplete?.(finalResponse);
      return finalResponse;
    },
  };

  const errors: Error[] = [];
  const retries: Array<[number, number]> = [];
  const chunks: string[] = [];
  const result = await service.chatStream([], undefined, {
    onError: error => errors.push(error),
    onRetry: (attempt, maxRetries) => retries.push([attempt, maxRetries]),
    onText: text => chunks.push(text),
  });

  assert.equal(result, finalResponse);
  assert.equal(attempts, 2);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(retries, [[1, 3]]);
  assert.deepStrictEqual(chunks, ['ok']);
});

test('AIService passes AbortSignal to chatStream provider calls', async () => {
  const service = createTestService();
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const finalResponse: ChatResponse = { content: 'ok' };
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, _callbacks?: StreamCallbacks, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return finalResponse;
    },
  };

  const result = await service.chatStream([], undefined, undefined, { signal: controller.signal });
  assert.equal(result, finalResponse);
  assert.equal(capturedSignal, controller.signal);
});

test('AIService cancels before provider call when signal is already aborted', async () => {
  const service = createTestService();
  const controller = new AbortController();
  let called = false;
  (service as any).provider = {
    chat: async () => {
      called = true;
      return { content: null };
    },
    chatStream: async () => {
      called = true;
      return { content: null };
    },
  };

  controller.abort();
  await assert.rejects(
    () => service.chat([], undefined, { signal: controller.signal }),
    /请求已取消/,
  );
  assert.equal(called, false);
});

function createTestService(): AIService {
  return new AIService({
    provider: 'openai',
    apiUrl: 'https://primary.example.test/v1',
    apiKey: 'primary-key',
    model: 'primary-model',
  });
}

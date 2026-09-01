import { afterEach, test } from 'node:test';
import * as assert from 'node:assert';
import { AIService } from '../src/utils/ai-service';
import type { ChatResponse } from '../src/types';
import type { StreamCallbacks } from '../src/providers/provider';
import { readModelErrorDiagnostics } from '../src/utils/model-error-observability';

const originalStreamRetry = process.env.GAUZ_STREAM_RETRY;
const originalRetryMaxRetries = process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
const originalRetryMaxMs = process.env.CATSCO_MODEL_RETRY_MAX_MS;
const originalRetryMaxDelayMs = process.env.CATSCO_MODEL_RETRY_MAX_DELAY_MS;

afterEach(() => {
  if (originalStreamRetry === undefined) {
    delete process.env.GAUZ_STREAM_RETRY;
  } else {
    process.env.GAUZ_STREAM_RETRY = originalStreamRetry;
  }
  restoreEnv('CATSCO_MODEL_RETRY_MAX_RETRIES', originalRetryMaxRetries);
  restoreEnv('CATSCO_MODEL_RETRY_MAX_MS', originalRetryMaxMs);
  restoreEnv('CATSCO_MODEL_RETRY_MAX_DELAY_MS', originalRetryMaxDelayMs);
});

test('AIService reports non-retryable stream provider errors once', async () => {
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

test('AIService retries transient stream errors before any text is emitted', async () => {
  const service = createTestService();
  let attempts = 0;
  const finalResponse: ChatResponse = { content: 'ok' };
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      attempts += 1;
      if (attempts === 1) {
        const retryableError = Object.assign(new Error('temporary stream failure'), {
          response: {
            status: 503,
            headers: { 'retry-after': '0' },
            data: { message: 'temporary stream failure' },
          },
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
  const retryInfos: any[] = [];
  const chunks: string[] = [];
  const result = await service.chatStream([], undefined, {
    onError: error => errors.push(error),
    onRetry: (attempt, maxRetries, info) => {
      retries.push([attempt, maxRetries]);
      retryInfos.push(info);
    },
    onText: text => chunks.push(text),
  });

  assert.equal(result, finalResponse);
  assert.equal(attempts, 2);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(retries, [[1, 14]]);
  assert.equal(retryInfos[0].status, 503);
  assert.equal(retryInfos[0].maxElapsedMs, 5 * 60 * 1000);
  assert.deepStrictEqual(chunks, ['ok']);
});

test('AIService can keep retrying transient stream failures beyond the old short cap', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '5';
  const service = createTestService();
  let attempts = 0;
  const finalResponse: ChatResponse = { content: 'eventually ok' };
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      attempts += 1;
      if (attempts <= 4) {
        throw Object.assign(new Error(`temporary stream failure ${attempts}`), {
          response: {
            status: 500,
            headers: { 'retry-after': '0' },
            data: { message: 'temporary stream failure' },
          },
        });
      }

      callbacks?.onText?.('eventually ok');
      callbacks?.onComplete?.(finalResponse);
      return finalResponse;
    },
  };

  const retries: Array<[number, number]> = [];
  const result = await service.chatStream([], undefined, {
    onRetry: (attempt, maxRetries) => retries.push([attempt, maxRetries]),
  });

  assert.equal(result, finalResponse);
  assert.equal(attempts, 5);
  assert.deepStrictEqual(retries, [[1, 5], [2, 5], [3, 5], [4, 5]]);
});

test('AIService does not retry stream errors after visible text is emitted', async () => {
  const service = createTestService();
  let attempts = 0;
  const retryableError = Object.assign(new Error('temporary stream failure after text'), {
    response: {
      status: 503,
      headers: { 'retry-after': '0' },
      data: { message: 'temporary stream failure after text' },
    },
  });
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      attempts += 1;
      callbacks?.onText?.('partial');
      throw retryableError;
    },
  };

  const errors: Error[] = [];
  const retries: Array<[number, number]> = [];
  const chunks: string[] = [];
  await assert.rejects(
    () => service.chatStream([], undefined, {
      onError: error => errors.push(error),
      onRetry: (attempt, maxRetries) => retries.push([attempt, maxRetries]),
      onText: text => chunks.push(text),
    }),
    /API错误 \(503\): temporary stream failure after text/,
  );

  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.deepStrictEqual(retries, []);
  assert.deepStrictEqual(chunks, ['partial']);
});

test('AIService retries buffered stream failures without publishing abandoned text', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';
  const service = createTestService();
  (service as any).config.openaiApiMode = 'responses';
  let attempts = 0;
  const finalResponse: ChatResponse = { content: 'recovered' };
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      attempts += 1;
      callbacks?.onText?.(attempts === 1 ? 'abandoned draft' : 'recovered');
      if (attempts === 1) {
        throw Object.assign(new Error('stream interrupted'), {
          code: 'stream_read_error',
          error: { code: 'stream_read_error', type: 'stream_error' },
        });
      }
      return finalResponse;
    },
  };
  (service as any).sleepWithAbort = async () => {};

  const chunks: string[] = [];
  const retries: number[] = [];
  const result = await service.chatStream([], undefined, {
    onText: text => chunks.push(text),
    onRetry: attempt => retries.push(attempt),
  }, {
    streamOutputMode: 'buffered',
  });

  assert.equal(result, finalResponse);
  assert.equal(attempts, 2);
  assert.deepStrictEqual(chunks, ['recovered']);
  assert.deepStrictEqual(retries, [1]);
});

test('AIService still honors explicit full stream retry opt-in', async () => {
  process.env.GAUZ_STREAM_RETRY = 'true';
  const service = createTestService();
  let attempts = 0;
  const finalResponse: ChatResponse = { content: 'ok' };
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      attempts += 1;
      callbacks?.onText?.(attempts === 1 ? 'partial' : 'ok');
      if (attempts === 1) {
        throw Object.assign(new Error('temporary stream failure'), {
          response: {
            status: 503,
            headers: { 'retry-after': '0' },
            data: { message: 'temporary stream failure' },
          },
        });
      }
      callbacks?.onComplete?.(finalResponse);
      return finalResponse;
    },
  };

  const chunks: string[] = [];
  const result = await service.chatStream([], undefined, {
    onText: text => chunks.push(text),
  });

  assert.equal(result, finalResponse);
  assert.equal(attempts, 2);
  assert.deepStrictEqual(chunks, ['partial', 'ok']);
});

test('AIService retries a successful response with no text or tool calls', async () => {
  const service = createTestService();
  let attempts = 0;
  (service as any).sleepWithAbort = async () => undefined;
  (service as any).provider = {
    chat: async () => {
      attempts += 1;
      if (attempts < 3) {
        return {
          content: null,
          stopReason: 'completed',
          usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
        };
      }
      return { content: 'recovered' };
    },
    chatStream: async () => ({ content: 'unused' }),
  };

  const result = await service.chat([]);

  assert.deepStrictEqual(result, { content: 'recovered' });
  assert.equal(attempts, 3);
});

test('AIService stops bounded empty-response retries with an explicit error', async () => {
  const service = createTestService();
  let attempts = 0;
  (service as any).sleepWithAbort = async () => undefined;
  (service as any).provider = {
    chat: async () => {
      attempts += 1;
      return { content: '', stopReason: 'stop' };
    },
    chatStream: async () => ({ content: 'unused' }),
  };

  await assert.rejects(
    () => service.chat([]),
    /请求失败: 模型未返回有效内容（没有正文或工具调用）/,
  );
  assert.equal(attempts, 3);
});

test('AIService accepts tool calls and token-limit recovery responses without semantic retries', async () => {
  const service = createTestService();
  let attempts = 0;
  (service as any).provider = {
    chat: async () => {
      attempts += 1;
      return attempts === 1
        ? {
            content: null,
            toolCalls: [{
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'read_file', arguments: '{}' },
            }],
          }
        : { content: null, stopReason: 'max_tokens' };
    },
    chatStream: async () => ({ content: 'unused' }),
  };

  const toolResponse = await service.chat([]);
  const tokenLimitResponse = await service.chat([]);

  assert.equal(toolResponse.toolCalls?.[0]?.function.name, 'read_file');
  assert.equal(tokenLimitResponse.stopReason, 'max_tokens');
  assert.equal(attempts, 2);
});

test('AIService emits stream completion only after an empty response has recovered', async () => {
  const service = createTestService();
  let attempts = 0;
  let completions = 0;
  const retries: Array<[number, number, string | number | undefined]> = [];
  (service as any).sleepWithAbort = async () => undefined;
  (service as any).provider = {
    chat: async () => ({ content: 'unused' }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      attempts += 1;
      const response: ChatResponse = attempts === 1
        ? { content: null, stopReason: 'completed' }
        : { content: 'recovered' };
      if (response.content) callbacks?.onText?.(response.content);
      callbacks?.onComplete?.(response);
      return response;
    },
  };

  const result = await service.chatStream([], undefined, {
    onComplete: () => { completions += 1; },
    onRetry: (attempt, maxRetries, info) => retries.push([attempt, maxRetries, info?.status]),
  });

  assert.equal(result.content, 'recovered');
  assert.equal(attempts, 2);
  assert.equal(completions, 1);
  assert.deepStrictEqual(retries, [[1, 2, 'EMPTY_MODEL_RESPONSE']]);
});

test('AIService does not treat bare token counts as retryable status codes', async () => {
  const service = createTestService();
  let attempts = 0;
  const rawError = new Error('requested 500 tokens but schema is invalid');
  (service as any).provider = {
    chat: async () => {
      attempts += 1;
      throw rawError;
    },
    chatStream: async () => ({ content: null }),
  };

  await assert.rejects(
    () => service.chat([]),
    /请求失败: requested 500 tokens but schema is invalid/,
  );
  assert.equal(attempts, 1);
});

test('AIService does not retry quota exhaustion even when provider uses HTTP 429', async () => {
  const service = createTestService();
  let attempts = 0;
  const quotaError = Object.assign(new Error('quota exceeded'), {
    response: {
      status: 429,
      headers: { 'retry-after': '0' },
      data: { error: { message: 'quota exceeded' } },
    },
  });
  (service as any).provider = {
    chat: async () => {
      attempts += 1;
      throw quotaError;
    },
    chatStream: async () => ({ content: null }),
  };

  await assert.rejects(
    () => service.chat([]),
    /API错误 \(429\): quota exceeded/,
  );
  assert.equal(attempts, 1);
});

test('AIService still retries transient load balancer failures', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';
  const service = createTestService();
  let attempts = 0;
  const transientError = Object.assign(new Error('load balancer returned 503'), {
    response: {
      status: 503,
      headers: { 'retry-after': '0' },
      data: { message: 'load balancer returned 503' },
    },
  });
  (service as any).provider = {
    chat: async () => {
      attempts += 1;
      if (attempts === 1) throw transientError;
      return { content: 'ok' };
    },
    chatStream: async () => ({ content: null }),
  };

  const result = await service.chat([]);

  assert.deepStrictEqual(result, { content: 'ok' });
  assert.equal(attempts, 2);
});

test('AIService retries Responses semantic transient codes and types', async () => {
  const semanticFailures = [
    { code: 'internal_error' },
    { code: 'internal_server_error' },
    { code: 'stream_read_error' },
    { code: 'upstream_error' },
    { type: 'server_is_overloaded' },
    { type: 'service_unavailable_error' },
  ];

  for (const semantic of semanticFailures) {
    process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';
    const service = createTestService();
    (service as any).config.openaiApiMode = 'responses';
    let attempts = 0;
    (service as any).provider = {
      chat: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('semantic provider failure'), {
            ...semantic,
            error: { ...semantic, message: 'semantic provider failure' },
          });
        }
        return { content: 'ok' };
      },
      chatStream: async () => ({ content: null }),
    };
    (service as any).sleepWithAbort = async () => {};

    const result = await service.chat([]);
    assert.equal(result.content, 'ok');
    assert.equal(attempts, 2, JSON.stringify(semantic));
  }
});

test('AIService guarantees one recovery attempt after a first 504 exhausts the retry window', () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '14';
  process.env.CATSCO_MODEL_RETRY_MAX_MS = '1000';
  const service = createTestService();
  (service as any).config.openaiApiMode = 'responses';
  const gatewayTimeout = Object.assign(new Error('gateway timeout'), { status: 504 });
  const policy = (service as any).resolveRetryPolicy(gatewayTimeout);

  assert.equal(policy.maxRetries, 1);
  assert.equal(policy.guaranteedRetries, 1);
  assert.equal(
    (service as any).resolveRetryStopReason(gatewayTimeout, 1, policy, 300_000),
    undefined,
  );
  assert.equal(
    (service as any).resolveRetryStopReason(gatewayTimeout, 2, policy, 301_000),
    'retry_limit_exhausted',
  );
  assert.ok((service as any).resolveRetryDelayMs(gatewayTimeout, 1, policy, 300_000) > 0);
});

test('AIService bounds Responses gateway retries without changing other API modes', () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '14';
  const responsesService = createTestService();
  (responsesService as any).config.openaiApiMode = 'responses';
  const chatCompletionsService = createTestService();
  const unavailable = Object.assign(new Error('service unavailable'), { status: 503 });

  assert.equal((responsesService as any).resolveRetryPolicy(unavailable).maxRetries, 2);
  assert.equal((chatCompletionsService as any).resolveRetryPolicy(unavailable).maxRetries, 14);
});

test('AIService uses a short retry policy for likely custom endpoint configuration errors', () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '10';
  process.env.CATSCO_MODEL_RETRY_MAX_MS = String(5 * 60 * 1000);
  process.env.CATSCO_MODEL_RETRY_MAX_DELAY_MS = '30000';
  const service = createTestService();

  const policy = (service as any).resolveRetryPolicy(Object.assign(new Error('connect refused'), {
    code: 'ECONNREFUSED',
  }));

  assert.equal(policy.maxRetries, 3);
  assert.equal(policy.maxElapsedMs, 30 * 1000);
  assert.equal(policy.maxDelayMs, 5000);
});

test('AIService enforces a shared provider request budget across internal retries', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '14';
  const service = createTestService();
  let providerCalls = 0;
  (service as any).sleepWithAbort = async () => {};
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async () => {
      providerCalls++;
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    },
  };
  const budget = { maxRequests: 2, usedRequests: 0 };

  await assert.rejects(
    () => service.chatStream([], undefined, undefined, {
      streamOutputMode: 'buffered',
      providerRequestBudget: budget,
    }),
    /Provider request budget exhausted/,
  );
  assert.equal(providerCalls, 2);
  assert.deepEqual(budget, { maxRequests: 2, usedRequests: 2 });
});

test('AIService waits for async retry callbacks before the next provider attempt', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';
  const service = createTestService();
  let attempts = 0;
  let retryCallbackFinished = false;
  (service as any).provider = {
    chat: async () => ({ content: null }),
    chatStream: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('temporary stream failure'), {
          response: {
            status: 503,
            headers: { 'retry-after': '0' },
            data: { message: 'temporary stream failure' },
          },
        });
      }
      assert.equal(retryCallbackFinished, true);
      return { content: 'ok' };
    },
  };

  const result = await service.chatStream([], undefined, {
    onRetry: async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      retryCallbackFinished = true;
    },
  });

  assert.deepStrictEqual(result, { content: 'ok' });
  assert.equal(attempts, 2);
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

test('AIService preserves provider fields and non-retryable stop reason on wrapped errors', async () => {
  const service = createTestService();
  const rawError = Object.assign(new Error('Request failed with status code 422'), {
    response: {
      status: 422,
      data: {
        request_id: 'req_schema_1',
        error: {
          code: 'invalid_tool_schema',
          type: 'invalid_request_error',
          message: 'tool schema is invalid',
        },
      },
    },
  });
  (service as any).provider = {
    chat: async () => { throw rawError; },
    chatStream: async () => ({ content: 'unused' }),
  };

  let wrapped: unknown;
  const attemptEvents: any[] = [];
  try {
    await service.chat([], undefined, {
      modelAttemptSink: { observe: event => { attemptEvents.push(event); } },
      modelAttemptContext: { episodeId: 'episode-ai-service' },
    });
  } catch (error) {
    wrapped = error;
  }

  const diagnostics = readModelErrorDiagnostics(wrapped);
  assert.equal((wrapped as any).status, 422);
  assert.equal(diagnostics?.provider, 'openai');
  assert.equal(diagnostics?.model, 'primary-model');
  assert.equal(diagnostics?.phase, 'model_request');
  assert.equal(diagnostics?.provider_code, 'invalid_tool_schema');
  assert.equal(diagnostics?.provider_type, 'invalid_request_error');
  assert.equal(diagnostics?.request_id, 'req_schema_1');
  assert.equal(diagnostics?.retry?.attempt_count, 1);
  assert.equal(diagnostics?.retry?.retry_count, 0);
  assert.equal(diagnostics?.retry?.stop_reason, 'non_retryable');
  assert.equal(diagnostics?.attempt?.call_id, attemptEvents[1].callId);
  assert.equal(diagnostics?.attempt?.attempt_id, attemptEvents[1].attemptId);
  assert.equal(diagnostics?.attempt?.attempt_number, 1);
  assert.equal(diagnostics?.attempt?.episode_id, 'episode-ai-service');
});

test('AIService records retry exhaustion on the final wrapped error', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';
  const service = createTestService();
  let attempts = 0;
  (service as any).sleepWithAbort = async () => undefined;
  (service as any).provider = {
    chat: async () => {
      attempts += 1;
      throw Object.assign(new Error('temporary upstream failure'), {
        response: {
          status: 503,
          headers: { 'retry-after': '0' },
          data: { error: { type: 'overloaded_error', message: 'temporary upstream failure' } },
        },
      });
    },
    chatStream: async () => ({ content: 'unused' }),
  };

  let wrapped: unknown;
  try {
    await service.chat([]);
  } catch (error) {
    wrapped = error;
  }

  const diagnostics = readModelErrorDiagnostics(wrapped);
  assert.equal(attempts, 2);
  assert.equal(diagnostics?.retry?.attempt_count, 2);
  assert.equal(diagnostics?.retry?.retry_count, 1);
  assert.equal(diagnostics?.retry?.max_retries, 1);
  assert.equal(diagnostics?.retry?.stop_reason, 'retry_limit_exhausted');
});

test('AIService records when stream output prevents an otherwise retryable request', async () => {
  const service = createTestService();
  (service as any).provider = {
    chat: async () => ({ content: 'unused' }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      callbacks?.onText?.('partial response');
      throw Object.assign(new Error('upstream disconnected'), {
        response: { status: 503, data: { message: 'upstream disconnected' } },
      });
    },
  };

  let wrapped: unknown;
  try {
    await service.chatStream([], undefined, { onText: () => undefined });
  } catch (error) {
    wrapped = error;
  }

  const diagnostics = readModelErrorDiagnostics(wrapped);
  assert.equal(diagnostics?.retry?.attempt_count, 1);
  assert.equal(diagnostics?.retry?.retry_count, 0);
  assert.equal(diagnostics?.retry?.stop_reason, 'stream_output_started');
});

function createTestService(): AIService {
  return new AIService({
    provider: 'openai',
    apiUrl: 'https://primary.example.test/v1',
    apiKey: 'primary-key',
    model: 'primary-model',
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AIService } from '../src/utils/ai-service';
import type {
  ModelAttemptEvent,
  ModelAttemptSink,
  StreamCallbacks,
} from '../src/providers/provider';
import type { ChatResponse, Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

const originalMaxRetries = process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;

afterEach(() => {
  restoreEnv('CATSCO_MODEL_RETRY_MAX_RETRIES', originalMaxRetries);
});

test('records every provider retry as a correlated attempt lifecycle', async () => {
  const service = createTestService({ openaiApiMode: 'responses' });
  const events: ModelAttemptEvent[] = [];
  let calls = 0;
  const response: ChatResponse = {
    content: 'recovered',
    usage: {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedReadTokens: 60,
    },
  };
  (service as any).sleepWithAbort = async () => undefined;
  (service as any).provider = {
    chat: async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('temporary outage'), {
          response: { status: 503, headers: { 'retry-after': '0' } },
        });
      }
      return response;
    },
    chatStream: async () => response,
  };
  const messages: Message[] = [{ role: 'user', content: 'hello' }];
  const tools: ToolDefinition[] = [{
    name: 'lookup',
    description: 'look something up',
    parameters: { type: 'object', properties: {} },
  }];

  const result = await service.chat(messages, tools, {
    modelAttemptSink: collectingSink(events),
    modelAttemptContext: {
      sessionId: 'session:test',
      surface: 'cli',
      episodeNumber: 4,
    },
  });

  assert.equal(result, response);
  assert.deepEqual(events.map(event => event.outcome), [
    'started',
    'retrying',
    'started',
    'succeeded',
  ]);
  assert.equal(new Set(events.map(event => event.callId)).size, 1);
  assert.deepEqual(events.map(event => event.attemptNumber), [1, 1, 2, 2]);
  assert.equal(events[0].attemptId, events[1].attemptId);
  assert.equal(events[2].attemptId, events[3].attemptId);
  assert.notEqual(events[0].attemptId, events[2].attemptId);
  assert.equal(events[0].apiType, 'openai-responses');
  assert.equal(events[0].request.messages, messages);
  assert.equal(events[0].request.tools, tools);
  assert.equal(events[0].context?.episodeNumber, 4);
  assert.equal(events[1].retry?.retryNumber, 1);
  assert.equal(events[1].retry?.delayMs, 0);
  assert.equal(events[3].response?.usage?.cachedReadTokens, 60);
});

test('attaches the provider cache plan to the exact observed attempt', async () => {
  const service = createTestService({
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    openaiApiMode: 'responses',
  });
  const events: ModelAttemptEvent[] = [];
  (service as any).provider = {
    chat: async () => ({ content: 'ok' }),
    chatStream: async () => ({ content: 'unused' }),
  };

  await service.chat([
    { role: 'system', content: 'Stable reusable policy. '.repeat(220) },
    { role: 'user', content: 'hello' },
  ], undefined, {
    cachePartitionKey: 'session:cache-plan',
    modelAttemptSink: collectingSink(events),
  });

  assert.deepEqual(events.map(event => event.outcome), ['started', 'succeeded']);
  assert.equal(events[0].request.cache?.strategy, 'openai-explicit-stable-prefix');
  assert.equal(events[0].request.cache?.explicitBreakpoints, 1);
  assert.equal(events[0].request.cache?.stableSystemMessages, 1);
  assert.match(events[0].request.cache?.promptCacheKeyFingerprint || '', /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(events[0].request.cache).includes('catsco-v3-'), false);
});

test('exact attempt telemetry distinguishes one-off cache bypass calls', async () => {
  const service = createTestService({
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    openaiApiMode: 'responses',
  });
  const events: ModelAttemptEvent[] = [];
  (service as any).provider = {
    chat: async () => ({ content: 'ok' }),
    chatStream: async () => ({ content: 'unused' }),
  };

  await service.chat([
    { role: 'system', content: 'One-off compaction instruction.' },
    { role: 'user', content: 'summarize once' },
  ], undefined, {
    cacheMode: 'bypass',
    cachePartitionKey: 'session:cache-plan',
    modelAttemptSink: collectingSink(events),
  });

  assert.equal(events[0].request.cache?.strategy, 'openai-cache-bypassed');
  assert.equal(events[0].request.cache?.explicitBreakpoints, 0);
  assert.equal(events[0].request.cache?.promptCacheKeyFingerprint, undefined);
});

test('attaches the Anthropic stable-prefix plan to the exact observed attempt', async () => {
  const service = createTestService({
    provider: 'anthropic',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-20250514',
  });
  const events: ModelAttemptEvent[] = [];
  (service as any).provider = {
    chat: async () => ({ content: 'ok' }),
    chatStream: async () => ({ content: 'unused' }),
  };

  await service.chat([
    { role: 'system', content: 'Stable reusable policy.' },
    { role: 'system', content: '[transient_plan_status]\nrunning', __cacheScope: 'dynamic' },
    { role: 'user', content: 'hello' },
  ], [{
    name: 'lookup',
    description: 'look something up',
    parameters: { type: 'object', properties: {} },
  }], {
    modelAttemptSink: collectingSink(events),
  });

  assert.deepEqual(events.map(event => event.outcome), ['started', 'succeeded']);
  assert.equal(events[0].request.cache?.strategy, 'anthropic-explicit-stable-prefix');
  assert.equal(events[0].request.cache?.explicitBreakpoints, 3);
  assert.equal(events[0].request.cache?.stableSystemMessages, 1);
  assert.equal(events[0].request.cache?.promptCacheKeyFingerprint, undefined);
});

test('attaches a redacted context lifecycle epoch to the exact observed attempt', async () => {
  const service = createTestService();
  const events: ModelAttemptEvent[] = [];
  (service as any).provider = {
    chat: async () => ({ content: 'ok' }),
    chatStream: async () => ({ content: 'unused' }),
  };

  await service.chat([
    {
      role: 'system',
      content: 'Episode plan.',
      __context: {
        schema: 'xiaoba.context_lifecycle.v1',
        source: 'plan_status',
        lifecycle: 'episode',
        cacheScope: 'epoch',
        persistence: 'transient',
        epoch: 'raw-episode-id-must-not-leak',
      },
    },
    { role: 'user', content: 'hello' },
  ], undefined, { modelAttemptSink: collectingSink(events) });

  const lifecycle = events[0].request.contextLifecycle;
  assert.equal(lifecycle?.annotatedMessages, 1);
  assert.deepEqual(lifecycle?.lifecycleCounts, { session: 0, episode: 1, call: 0 });
  assert.match(lifecycle?.epochFingerprint || '', /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(lifecycle).includes('raw-episode-id-must-not-leak'), false);
});

test('records a non-retryable provider rejection as the terminal attempt', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '0';
  const service = createTestService();
  const events: ModelAttemptEvent[] = [];
  (service as any).provider = {
    chat: async () => {
      throw Object.assign(new Error('invalid schema'), { response: { status: 400 } });
    },
    chatStream: async () => ({ content: 'unused' }),
  };

  await assert.rejects(
    () => service.chat([], undefined, { modelAttemptSink: collectingSink(events) }),
    /API错误 \(400\): invalid schema/,
  );

  assert.deepEqual(events.map(event => event.outcome), ['started', 'failed']);
  assert.equal(events[1].retry?.stopReason, 'non_retryable');
  assert.equal(events[1].retry?.retryNumber, 0);
  assert.equal(events[1].error instanceof Error, true);
});

test('repairs malformed tool exchanges before invocation and records the preflight summary', async () => {
  const service = createTestService();
  const events: ModelAttemptEvent[] = [];
  let providerMessages: Message[] | undefined;
  (service as any).provider = {
    chat: async (messages: Message[]) => {
      providerMessages = messages;
      return { content: 'recovered locally' };
    },
    chatStream: async () => ({ content: 'unused' }),
  };
  const messages: Message[] = [
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      content: 'tool attempt',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      }],
    },
    { role: 'user', content: 'continue without a result' },
    { role: 'tool', tool_call_id: 'call_1', content: 'late' },
  ];

  const result = await service.chat(messages, undefined, {
    modelAttemptSink: collectingSink(events),
  });

  assert.equal(result.content, 'recovered locally');
  assert.deepEqual(providerMessages?.map(message => message.role), ['user', 'assistant', 'user']);
  assert.equal(providerMessages?.[1].tool_calls, undefined);
  assert.deepEqual(events.map(event => event.outcome), ['started', 'succeeded']);
  assert.equal(events[0].request.messages, providerMessages);
  assert.deepEqual(events[0].request.preflight, {
    repaired: true,
    issueCodes: ['missing_tool_result', 'orphan_tool_result'],
    droppedMessages: 1,
    droppedToolCalls: 1,
    droppedToolResults: 1,
    providerReplayFallbacks: 0,
  });
});

test('recovers once when DeepSeek explicitly requires missing reasoning history', async () => {
  const service = createTestService({
    apiUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
  });
  const events: ModelAttemptEvent[] = [];
  const providerRequests: Array<{ messages: Message[]; options: any }> = [];
  let calls = 0;
  (service as any).provider = {
    chat: async (messages: Message[], _tools: unknown, options: unknown) => {
      calls++;
      providerRequests.push({ messages, options });
      if (calls === 1) {
        throw {
          response: {
            status: 400,
            data: { error: { message: 'reasoning_content is required and was missing' } },
          },
        };
      }
      return { content: 'recovered after local history repair' };
    },
    chatStream: async () => ({ content: 'unused' }),
  };
  const messages: Message[] = [
    { role: 'user', content: 'find cats' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: 'cats found' },
    { role: 'user', content: 'continue' },
  ];

  const result = await service.chat(messages, undefined, {
    modelAttemptSink: collectingSink(events),
  });

  assert.equal(result.content, 'recovered after local history repair');
  assert.equal(calls, 2);
  assert.equal(providerRequests[0].messages.some(message => message.tool_calls?.length), true);
  assert.equal(providerRequests[1].messages.some(message => message.tool_calls?.length), false);
  assert.equal(providerRequests[1].messages.some(message => message.role === 'tool'), false);
  assert.equal(providerRequests[1].options.reasoningReplayMode, 'include');
  assert.deepEqual(events.map(event => event.outcome), ['started', 'retrying', 'started', 'succeeded']);
  assert.equal(events[1].retry?.recoveryAction, 'reasoning_history_degrade');
  assert.equal(events[1].retry?.delayMs, 0);
  assert.equal(events[0].request.messages, providerRequests[0].messages);
  assert.equal(events[2].request.messages, providerRequests[1].messages);
});

test('DeepSeek reasoning recovery is evidence-driven and bounded to one retry', async () => {
  const service = createTestService({
    apiUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
  });
  const events: ModelAttemptEvent[] = [];
  let calls = 0;
  (service as any).provider = {
    chat: async () => {
      calls++;
      throw {
        response: {
          status: 400,
          data: { error: { message: 'reasoning_content is required and was missing' } },
        },
      };
    },
    chatStream: async () => ({ content: 'unused' }),
  };
  const messages: Message[] = [
    {
      role: 'assistant',
      content: 'historical attempt',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'old result' },
    { role: 'user', content: 'continue' },
  ];

  await assert.rejects(
    () => service.chat(messages, undefined, { modelAttemptSink: collectingSink(events) }),
    /API错误 \(400\): reasoning_content is required and was missing/,
  );

  assert.equal(calls, 2);
  assert.deepEqual(events.map(event => event.outcome), ['started', 'retrying', 'started', 'failed']);
  assert.equal(events[1].retry?.recoveryAction, 'reasoning_history_degrade');
  assert.equal(events[3].retry?.stopReason, 'non_retryable');
});

test('distinguishes a stream failure after visible output from a retryable failure', async () => {
  const service = createTestService();
  const events: ModelAttemptEvent[] = [];
  let calls = 0;
  (service as any).provider = {
    chat: async () => ({ content: 'unused' }),
    chatStream: async (_messages: unknown, _tools: unknown, callbacks?: StreamCallbacks) => {
      calls += 1;
      callbacks?.onText?.('partial');
      throw Object.assign(new Error('stream interrupted'), { response: { status: 503 } });
    },
  };

  await assert.rejects(
    () => service.chatStream([], undefined, { onText: () => undefined }, {
      modelAttemptSink: collectingSink(events),
    }),
    /API错误 \(503\): stream interrupted/,
  );

  assert.equal(calls, 1);
  assert.deepEqual(events.map(event => event.outcome), ['started', 'failed']);
  assert.equal(events[1].retry?.stopReason, 'stream_output_started');
  assert.equal(events[0].stream, true);
});

test('records an in-flight abort but does not invent a provider attempt before invocation', async () => {
  const service = createTestService();
  const events: ModelAttemptEvent[] = [];
  const controller = new AbortController();
  let calls = 0;
  (service as any).provider = {
    chat: async () => {
      calls += 1;
      const error = new Error('cancelled by caller');
      error.name = 'AbortError';
      throw error;
    },
    chatStream: async () => ({ content: 'unused' }),
  };

  await assert.rejects(
    () => service.chat([], undefined, {
      signal: controller.signal,
      modelAttemptSink: collectingSink(events),
    }),
    /请求已取消/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(events.map(event => event.outcome), ['started', 'cancelled']);
  assert.equal(events[1].retry?.stopReason, 'aborted');

  events.length = 0;
  controller.abort();
  await assert.rejects(
    () => service.chat([], undefined, {
      signal: controller.signal,
      modelAttemptSink: collectingSink(events),
    }),
    /请求已取消/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
});

test('sync throws and async rejections from a sink never alter the model result', async () => {
  const service = createTestService();
  (service as any).provider = {
    chat: async () => ({ content: 'ok' }),
    chatStream: async () => ({ content: 'unused' }),
  };
  let observations = 0;
  const sink: ModelAttemptSink = {
    observe(event) {
      observations += 1;
      if (event.outcome === 'started') return Promise.reject(new Error('async observer failure'));
      throw new Error('sync observer failure');
    },
  };

  const result = await service.chat([], undefined, { modelAttemptSink: sink });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result, { content: 'ok' });
  assert.equal(observations, 2);
});

function collectingSink(events: ModelAttemptEvent[]): ModelAttemptSink {
  return { observe: event => { events.push(event); } };
}

function createTestService(overrides: Record<string, unknown> = {}): AIService {
  return new AIService({
    provider: 'openai',
    apiUrl: 'https://primary.example.test/v1',
    apiKey: 'primary-key',
    model: 'primary-model',
    ...overrides,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

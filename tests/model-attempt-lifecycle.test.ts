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

test('isolates interleaved concurrent calls and retry recovery on a shared service', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';
  const service = createTestService({ openaiApiMode: 'responses' });
  const events: ModelAttemptEvent[] = [];
  const gates = new Map<string, Array<ReturnType<typeof deferred<ChatResponse>>>>();
  (service as any).sleepWithAbort = async () => undefined;
  (service as any).provider = {
    chat: async (messages: Message[]) => {
      const marker = String(messages[0]?.content || '');
      const gate = deferred<ChatResponse>();
      const markerGates = gates.get(marker) || [];
      markerGates.push(gate);
      gates.set(marker, markerGates);
      return gate.promise;
    },
    chatStream: async () => ({ content: 'unused' }),
  };
  const sink = collectingSink(events);

  const callA = service.chat([{ role: 'user', content: 'marker-A' }], undefined, {
    modelAttemptSink: sink,
    modelAttemptContext: { episodeId: 'episode-A', episodeNumber: 1 },
  });
  const callB = service.chat([{ role: 'user', content: 'marker-B' }], undefined, {
    modelAttemptSink: sink,
    modelAttemptContext: { episodeId: 'episode-B', episodeNumber: 2 },
  });

  await waitUntil(() => (gates.get('marker-A')?.length ?? 0) === 1 && (gates.get('marker-B')?.length ?? 0) === 1);
  gates.get('marker-A')![0].reject(Object.assign(new Error('temporary outage'), {
    response: { status: 503, headers: { 'retry-after': '0' } },
  }));
  await waitUntil(() => (gates.get('marker-A')?.length ?? 0) === 2);
  gates.get('marker-B')![0].resolve({
    content: 'response-B',
    usage: { promptTokens: 202, completionTokens: 2, totalTokens: 204, cachedReadTokens: 22 },
  });
  await new Promise(resolve => setImmediate(resolve));
  gates.get('marker-A')![1].resolve({
    content: 'response-A',
    usage: { promptTokens: 101, completionTokens: 1, totalTokens: 102, cachedReadTokens: 11 },
  });

  const [responseA, responseB] = await Promise.all([callA, callB]);
  assert.equal(responseA.content, 'response-A');
  assert.equal(responseB.content, 'response-B');
  assert.deepEqual(events.map(event => `${event.outcome}:${event.request.messages[0]?.content}`), [
    'started:marker-A',
    'started:marker-B',
    'retrying:marker-A',
    'started:marker-A',
    'succeeded:marker-B',
    'succeeded:marker-A',
  ]);

  const eventsA = events.filter(event => event.request.messages[0]?.content === 'marker-A');
  const eventsB = events.filter(event => event.request.messages[0]?.content === 'marker-B');
  assert.equal(new Set(events.map(event => event.callId)).size, 2);
  assert.equal(new Set(eventsA.map(event => event.callId)).size, 1);
  assert.equal(new Set(eventsB.map(event => event.callId)).size, 1);
  assert.notEqual(eventsA[0].callId, eventsB[0].callId);
  assert.deepEqual(eventsA.map(event => event.outcome), ['started', 'retrying', 'started', 'succeeded']);
  assert.equal(eventsA[0].attemptId, eventsA[1].attemptId);
  assert.equal(eventsA[2].attemptId, eventsA[3].attemptId);
  assert.notEqual(eventsA[0].attemptId, eventsA[2].attemptId);
  assert.equal(eventsA[3].response?.usage?.cachedReadTokens, 11);
  assert.equal(eventsA.every(event => event.context?.episodeId === 'episode-A'), true);
  assert.deepEqual(eventsB.map(event => event.outcome), ['started', 'succeeded']);
  assert.equal(eventsB[0].attemptId, eventsB[1].attemptId);
  assert.equal(eventsB[1].response?.usage?.cachedReadTokens, 22);
  assert.equal(eventsB.every(event => event.context?.episodeId === 'episode-B'), true);
});

test('isolates an interleaved terminal failure from a sibling success', async () => {
  process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '0';
  const service = createTestService();
  const events: ModelAttemptEvent[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<ChatResponse>>>();
  (service as any).provider = {
    chat: async (messages: Message[]) => {
      const marker = String(messages[0]?.content || '');
      const gate = deferred<ChatResponse>();
      gates.set(marker, gate);
      return gate.promise;
    },
    chatStream: async () => ({ content: 'unused' }),
  };
  const sink = collectingSink(events);

  const callA = service.chat([{ role: 'user', content: 'failed-A' }], undefined, {
    modelAttemptSink: sink,
    modelAttemptContext: { episodeId: 'failed-episode-A', episodeNumber: 7 },
  });
  const callB = service.chat([{ role: 'user', content: 'succeeded-B' }], undefined, {
    modelAttemptSink: sink,
    modelAttemptContext: { episodeId: 'succeeded-episode-B', episodeNumber: 8 },
  });
  const callARejection = assert.rejects(
    callA,
    /API错误 \(400\): invalid request A/,
  );

  await waitUntil(() => gates.size === 2);
  gates.get('failed-A')!.reject(Object.assign(new Error('invalid request A'), {
    response: { status: 400 },
  }));
  await waitUntil(() => events.some(event => event.outcome === 'failed'));
  gates.get('succeeded-B')!.resolve({
    content: 'response-B',
    usage: { promptTokens: 505, completionTokens: 5, totalTokens: 510, cachedReadTokens: 55 },
  });

  await callARejection;
  const responseB = await callB;
  assert.equal(responseB.content, 'response-B');
  assert.deepEqual(events.map(event => `${event.outcome}:${event.request.messages[0]?.content}`), [
    'started:failed-A',
    'started:succeeded-B',
    'failed:failed-A',
    'succeeded:succeeded-B',
  ]);

  const eventsA = events.filter(event => event.request.messages[0]?.content === 'failed-A');
  const eventsB = events.filter(event => event.request.messages[0]?.content === 'succeeded-B');
  assert.equal(new Set(events.map(event => event.callId)).size, 2);
  assert.equal(new Set(eventsA.map(event => event.attemptId)).size, 1);
  assert.equal(new Set(eventsB.map(event => event.attemptId)).size, 1);
  assert.notEqual(eventsA[0].callId, eventsB[0].callId);
  assert.equal(eventsA[1].retry?.stopReason, 'non_retryable');
  assert.equal(eventsA[1].error instanceof Error, true);
  assert.equal(eventsA.every(event => event.context?.episodeId === 'failed-episode-A'), true);
  assert.equal(eventsB[1].response?.usage?.cachedReadTokens, 55);
  assert.equal(eventsB.every(event => event.context?.episodeId === 'succeeded-episode-B'), true);
});

test('isolates interleaved streaming calls and callbacks on a shared service', async () => {
  const service = createTestService();
  const events: ModelAttemptEvent[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<ChatResponse>>>();
  const providerCallbacks = new Map<string, StreamCallbacks | undefined>();
  (service as any).provider = {
    chat: async () => ({ content: 'unused' }),
    chatStream: async (messages: Message[], _tools: ToolDefinition[], callbacks?: StreamCallbacks) => {
      const marker = String(messages[0]?.content || '');
      const gate = deferred<ChatResponse>();
      gates.set(marker, gate);
      providerCallbacks.set(marker, callbacks);
      return gate.promise;
    },
  };
  const chunksA: string[] = [];
  const chunksB: string[] = [];
  const sink = collectingSink(events);

  const callA = service.chatStream(
    [{ role: 'user', content: 'stream-A' }],
    undefined,
    { onText: chunk => { chunksA.push(chunk); } },
    { modelAttemptSink: sink, modelAttemptContext: { episodeId: 'stream-episode-A' } },
  );
  const callB = service.chatStream(
    [{ role: 'user', content: 'stream-B' }],
    undefined,
    { onText: chunk => { chunksB.push(chunk); } },
    { modelAttemptSink: sink, modelAttemptContext: { episodeId: 'stream-episode-B' } },
  );

  await waitUntil(() => gates.size === 2);
  providerCallbacks.get('stream-B')?.onText?.('chunk-B');
  gates.get('stream-B')!.resolve({
    content: 'response-stream-B',
    usage: { promptTokens: 404, completionTokens: 4, totalTokens: 408, cachedReadTokens: 44 },
  });
  await new Promise(resolve => setImmediate(resolve));
  providerCallbacks.get('stream-A')?.onText?.('chunk-A');
  gates.get('stream-A')!.resolve({
    content: 'response-stream-A',
    usage: { promptTokens: 303, completionTokens: 3, totalTokens: 306, cachedReadTokens: 33 },
  });

  const [responseA, responseB] = await Promise.all([callA, callB]);
  assert.equal(responseA.content, 'response-stream-A');
  assert.equal(responseB.content, 'response-stream-B');
  assert.deepEqual(chunksA, ['chunk-A']);
  assert.deepEqual(chunksB, ['chunk-B']);
  assert.deepEqual(events.map(event => `${event.outcome}:${event.request.messages[0]?.content}`), [
    'started:stream-A',
    'started:stream-B',
    'succeeded:stream-B',
    'succeeded:stream-A',
  ]);
  assert.equal(new Set(events.map(event => event.callId)).size, 2);
  for (const marker of ['stream-A', 'stream-B']) {
    const markerEvents = events.filter(event => event.request.messages[0]?.content === marker);
    assert.deepEqual(markerEvents.map(event => event.outcome), ['started', 'succeeded']);
    assert.equal(new Set(markerEvents.map(event => event.callId)).size, 1);
    assert.equal(new Set(markerEvents.map(event => event.attemptId)).size, 1);
    assert.equal(markerEvents.every(event => event.stream), true);
    assert.equal(markerEvents[1].response?.usage?.cachedReadTokens, marker === 'stream-A' ? 33 : 44);
    assert.equal(markerEvents.every(event => event.context?.episodeId === `stream-episode-${marker.at(-1)}`), true);
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('timed out waiting for concurrent provider invocation');
}

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

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

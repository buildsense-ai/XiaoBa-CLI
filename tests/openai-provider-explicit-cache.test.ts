import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai-provider';
import type { Message } from '../src/types';
import { Logger } from '../src/utils/logger';

function provider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://relay.example/v1',
    model: 'gpt-5.6-sol',
    openaiApiMode: 'responses',
  });
}

function explicitProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    openaiApiMode: 'responses',
  });
}

const context = {
  promptCacheContext: {
    sessionKey: 'session-alpha',
    currentEpisodeId: 'episode-2',
    phase: 'normal' as const,
    explicitCaching: true,
  },
};

function countBreakpoints(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countBreakpoints(item), 0);
  const record = value as Record<string, unknown>;
  return (record.prompt_cache_breakpoint ? 1 : 0)
    + Object.values(record).reduce((sum, item) => sum + countBreakpoints(item), 0);
}

function circularErrorStream(payload: unknown): Readable {
  const stream = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  (stream as any).socket = { _httpMessage: stream };
  return stream;
}

test('Responses cache omits the S carrier on custom endpoints and appends transient developer context', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'system', content: '[transient_skills_list]\n- lookup', __cacheScope: 'stable' },
    { role: 'user', content: 'old task', __episodeId: 'episode-1' },
    { role: 'assistant', content: 'old answer', __episodeId: 'episode-1' },
    { role: 'user', content: 'root task', __episodeId: 'episode-2', __episodeInputKind: 'root' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', content: 'first result', tool_call_id: 'call-1', __episodeId: 'episode-2' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', content: 'second result', tool_call_id: 'call-2', __episodeId: 'episode-2' },
    { role: 'system', content: '[transient_plan_status]\nstep two', __cacheScope: 'dynamic' },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  assert.equal(body.prompt_cache_options, undefined);
  assert.match(body.instructions, /stable system/);
  assert.match(body.instructions, /transient_skills_list/);
  assert.doesNotMatch(body.instructions, /transient_plan_status/);
  assert.equal(countBreakpoints(body.input), 0);
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content, 'old task');
  assert.equal(body.input.at(-1).role, 'developer');
  assert.match(String(body.input.at(-1).content), /transient_plan_status/);
  assert.equal(body.input.at(-3).type, 'function_call');
  assert.equal(body.input.at(-2).type, 'function_call_output');
  assert.equal(messages.some(message => (message as any).prompt_cache_breakpoint), false);
});

test('Responses keeps a continuation checkpoint before its retained historical evidence', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    {
      role: 'user',
      content: 'CONTINUATION_CHECKPOINT',
      __checkpointSummary: true,
      __episodeId: 'episode-2',
    },
    { role: 'user', content: 'retained old evidence', __episodeId: 'episode-1' },
    { role: 'assistant', content: 'retained old answer', __episodeId: 'episode-1' },
    { role: 'user', content: 'current root task', __episodeId: 'episode-2', __episodeInputKind: 'root' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [{ id: 'call-current', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', content: 'latest result', tool_call_id: 'call-current', __episodeId: 'episode-2' },
    { role: 'system', content: '[transient_plan_status]\ncurrent step', __cacheScope: 'dynamic' },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const checkpointIndex = body.input.findIndex((item: any) => item.content === 'CONTINUATION_CHECKPOINT');
  const oldEvidenceIndex = body.input.findIndex((item: any) => item.content === 'retained old evidence');
  const rootIndex = body.input.findIndex((item: any) => item.content === 'current root task');
  const planIndex = body.input.findIndex((item: any) => String(item.content).includes('transient_plan_status'));
  const callIndex = body.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call-current');
  const breakpointIndexes = body.input
    .map((item: any, index: number) => countBreakpoints(item) > 0 ? index : -1)
    .filter((index: number) => index >= 0);

  assert.equal(breakpointIndexes.length, 0);
  assert.ok(checkpointIndex < oldEvidenceIndex);
  assert.ok(oldEvidenceIndex < rootIndex);
  assert.ok(rootIndex < callIndex);
  assert.ok(callIndex < planIndex);
  assert.equal(body.input[planIndex].role, 'developer');
});

test('Responses cache key is isolated by session without exposing the session id', () => {
  const messages: Message[] = [{ role: 'system', content: 'stable' }, { role: 'user', content: 'hello' }];
  const first = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const second = (provider() as any).buildResponsesRequestBody(messages, [], false, {
    promptCacheContext: { ...context.promptCacheContext, sessionKey: 'session-beta' },
  });
  assert.notEqual(first.prompt_cache_key, second.prompt_cache_key);
  assert.doesNotMatch(first.prompt_cache_key, /session-alpha/);
});

test('Responses relay uses Pi-style stable session affinity headers without exposing the session id', () => {
  const original = process.env.XIAOBA_RESPONSES_SESSION_AFFINITY;
  delete process.env.XIAOBA_RESPONSES_SESSION_AFFINITY;
  try {
    const headers = (provider() as any).responsesHeaders(context);
    assert.match(headers.session_id, /^xiaoba-[a-f0-9]{32}$/);
    assert.equal(headers['x-client-request-id'], headers.session_id);
    assert.doesNotMatch(headers.session_id, /session-alpha/);

    const officialHeaders = (explicitProvider() as any).responsesHeaders(context);
    assert.equal(officialHeaders.session_id, undefined);
    assert.equal(officialHeaders['x-client-request-id'], undefined);
  } finally {
    if (original === undefined) delete process.env.XIAOBA_RESPONSES_SESSION_AFFINITY;
    else process.env.XIAOBA_RESPONSES_SESSION_AFFINITY = original;
  }
});

test('Responses session affinity can be disabled without changing the cache body', () => {
  const original = process.env.XIAOBA_RESPONSES_SESSION_AFFINITY;
  process.env.XIAOBA_RESPONSES_SESSION_AFFINITY = 'off';
  try {
    const headers = (provider() as any).responsesHeaders(context);
    assert.equal(headers.session_id, undefined);
    assert.equal(headers['x-client-request-id'], undefined);
  } finally {
    if (original === undefined) delete process.env.XIAOBA_RESPONSES_SESSION_AFFINITY;
    else process.env.XIAOBA_RESPONSES_SESSION_AFFINITY = original;
  }
});

test('Responses streaming and non-streaming requests share the same logical cache body', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'current request', __episodeId: 'episode-2' },
    { role: 'system', content: '[transient_plan_status]\nstep two', __cacheScope: 'dynamic' },
  ];
  const nonStreaming = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const streaming = (provider() as any).buildResponsesRequestBody(messages, [], true, context);
  const { stream: nonStreamingFlag, ...nonStreamingLogicalBody } = nonStreaming;
  const { stream: streamingFlag, ...streamingLogicalBody } = streaming;

  assert.equal(nonStreamingFlag, false);
  assert.equal(streamingFlag, true);
  assert.deepEqual(streamingLogicalBody, nonStreamingLogicalBody);
});

test('Responses keeps synthetic observation calls paired after durable history', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'system', content: '[transient_plan_status]\nstep two', __cacheScope: 'dynamic' },
    { role: 'user', content: 'current request', __episodeId: 'episode-2' },
    {
      role: 'assistant',
      content: null,
      __syntheticObservation: true,
      tool_calls: [{
        id: 'synthetic-observation-1',
        type: 'function',
        function: { name: 'runtime_observation', arguments: '{"source":"subagent"}' },
      }],
    },
    {
      role: 'tool',
      content: 'late observation',
      tool_call_id: 'synthetic-observation-1',
      __syntheticObservation: true,
    },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const durableUserIndex = body.input.findIndex((item: any) => item.content === 'current request');
  const callIndex = body.input.findIndex((item: any) => item.type === 'function_call');
  const outputIndex = body.input.findIndex((item: any) => item.type === 'function_call_output');
  const planIndex = body.input.findIndex((item: any) => String(item.content).includes('transient_plan_status'));

  assert.ok(durableUserIndex < callIndex);
  assert.ok(callIndex < outputIndex);
  assert.ok(outputIndex < planIndex);
  assert.equal(body.input[planIndex].role, 'developer');
});

test('Responses breakpoints never rewrite parallel function calls or outputs', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'root task', __episodeId: 'episode-2', __episodeInputKind: 'root' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"id":"a"}' } },
        { id: 'call-b', type: 'function', function: { name: 'lookup', arguments: '{"id":"b"}' } },
      ],
    },
    { role: 'tool', content: 'result-a', tool_call_id: 'call-a', __episodeId: 'episode-2' },
    { role: 'tool', content: 'result-b', tool_call_id: 'call-b', __episodeId: 'episode-2' },
    { role: 'assistant', content: 'finished', __episodeId: 'episode-2' },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const callA = body.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call-a');
  const callB = body.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call-b');
  const outputA = body.input.findIndex((item: any) => item.type === 'function_call_output' && item.call_id === 'call-a');
  const outputB = body.input.findIndex((item: any) => item.type === 'function_call_output' && item.call_id === 'call-b');
  const boundaryAfterTools = body.input.findIndex((item: any, index: number) => (
    index > outputB && countBreakpoints(item) > 0
  ));

  assert.ok(callA < callB && callB < outputA && outputA < outputB);
  assert.equal(boundaryAfterTools, -1);
  assert.equal(body.input[outputA].output, 'result-a');
  assert.equal(body.input[outputB].output, 'result-b');
  assert.equal(JSON.stringify(messages).includes('prompt_cache_breakpoint'), false);
});

test('Responses custom endpoints do not inject a fixed session breakpoint', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'root task', __episodeId: 'episode-2', __episodeInputKind: 'root' },
    { role: 'assistant', content: 'first turn', __episodeId: 'episode-2' },
    { role: 'user', content: 'continue', __episodeId: 'episode-2' },
    { role: 'assistant', content: 'second turn', __episodeId: 'episode-2' },
    { role: 'user', content: 'latest event', __episodeId: 'episode-2' },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const breakpointIndexes = body.input
    .map((item: any, index: number) => countBreakpoints(item) > 0 ? index : -1)
    .filter((index: number) => index >= 0);
  const secondTurnIndex = body.input.findIndex((item: any) => item.content === 'second turn');
  const latestEventIndex = body.input.findIndex((item: any) => item.content === 'latest event');

  assert.equal(breakpointIndexes.length, 0);
  assert.ok(secondTurnIndex < latestEventIndex);
});

test('Responses explicit cache is disabled by default on custom and official endpoints', () => {
  const messages: Message[] = [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }];
  const customBody = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const officialBody = (explicitProvider() as any).buildResponsesRequestBody(messages, [], false, context);

  assert.equal(countBreakpoints(customBody.input), 0);
  assert.equal(countBreakpoints(officialBody.input), 0);
  assert.equal(customBody.input[0].content, 'hello');
  assert.equal(officialBody.input[0].content, 'hello');
});

test('Responses explicit cache auto mode remains an opt-in for the official OpenAI endpoint', () => {
  const originalMode = process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
  process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = 'auto';
  try {
    const messages: Message[] = [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }];
    const customBody = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
    const officialBody = (explicitProvider() as any).buildResponsesRequestBody(messages, [], false, context);

    assert.equal(countBreakpoints(customBody.input), 0);
    assert.equal(countBreakpoints(officialBody.input), 1);
    assert.equal(officialBody.input[0].role, 'developer');
  } finally {
    if (originalMode === undefined) delete process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
    else process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = originalMode;
  }
});

test('Responses explicit cache can be forced on a custom endpoint', () => {
  const originalMode = process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
  process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = 'force';
  try {
    const body = (provider() as any).buildResponsesRequestBody(
      [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
      [],
      false,
      context,
    );
    assert.equal(countBreakpoints(body.input), 1);
  } finally {
    if (originalMode === undefined) delete process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
    else process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = originalMode;
  }
});

test('Responses explicit cache is not sent to older models', () => {
  const oldProvider = new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://relay.example/v1',
    model: 'gpt-5.5-sol',
    openaiApiMode: 'responses',
  });
  const body = (oldProvider as any).buildResponsesRequestBody(
    [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
    [],
    false,
    context,
  );
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(countBreakpoints(body.input), 0);
});

test('Responses-only projection does not change Chat Completions roles', () => {
  const chatProvider = new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://relay.example/v1',
    model: 'gpt-5.6-sol',
    openaiApiMode: 'chat_completions',
  });
  const body = (chatProvider as any).buildRequestBody([
    { role: 'system', content: '[transient_plan_status]\nstep two', __cacheScope: 'dynamic' },
    { role: 'user', content: 'hello', __injected: true },
  ], [], false);

  assert.deepEqual(body.messages.map((message: any) => message.role), ['system', 'user']);
  assert.equal(JSON.stringify(body.messages).includes('developer'), false);
});

test('legacy checkpoint boundary is filtered but ordinary discussion is preserved', () => {
  const messages: Message[] = [
    { role: 'system', content: '[checkpoint_compaction_boundary]\nphase=mid_turn' },
    { role: 'user', content: 'Please explain checkpoint_compaction_boundary behavior.', __episodeId: 'episode-2' },
  ];
  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const serialized = JSON.stringify(body.input);
  assert.doesNotMatch(serialized, /phase=mid_turn/);
  assert.match(serialized, /Please explain checkpoint_compaction_boundary behavior/);
});

test('unsupported explicit fields retry once and pin the provider to compatibility mode', async () => {
  const originalPost = axios.post;
  const originalMode = process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
  const bodies: any[] = [];
  process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = 'on';
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) {
      throw Object.assign(new Error('unknown field prompt_cache_options'), {
        response: { status: 400, data: { error: { message: 'prompt_cache_breakpoint is unsupported' } } },
      });
    }
    return { data: { status: 'completed', output: [] } };
  };
  try {
    const instance = explicitProvider();
    await instance.chat([{ role: 'user', content: 'hello', __episodeId: 'episode-2' }], [], context);
    assert.equal(bodies.length, 2);
    assert.equal(countBreakpoints(bodies[0].input), 1);
    assert.equal(bodies[1].prompt_cache_options, undefined);
    assert.equal(countBreakpoints(bodies[1].input), 0);
    assert.deepEqual(bodies[0].input.slice(1), bodies[1].input);
    const { input: _firstInput, ...firstTransportBody } = bodies[0];
    const { input: _secondInput, ...secondTransportBody } = bodies[1];
    assert.deepEqual(firstTransportBody, secondTransportBody);
  } finally {
    if (originalMode === undefined) delete process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
    else process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = originalMode;
    (axios as any).post = originalPost;
  }
});

test('streamed unsupported explicit fields retry once in compatibility mode', async () => {
  const originalPost = axios.post;
  const originalMode = process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
  const bodies: any[] = [];
  const callbackErrors: Error[] = [];
  process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = 'on';
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) {
      return {
        data: Readable.from([
          `data: ${JSON.stringify({
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { message: 'prompt_cache_breakpoint is not supported on this model' },
            },
          })}\n\n`,
        ]),
      };
    }
    return {
      data: Readable.from([
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          },
        })}\n\n`,
      ]),
    };
  };
  try {
    const instance = explicitProvider();
    const result = await instance.chatStream(
      [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
      [],
      { onError: error => callbackErrors.push(error) },
      context,
    );
    assert.equal(result.content, 'OK');
    assert.equal(bodies.length, 2);
    assert.equal(countBreakpoints(bodies[0].input), 1);
    assert.equal(bodies[1].prompt_cache_options, undefined);
    assert.equal(countBreakpoints(bodies[1].input), 0);
    assert.deepEqual(callbackErrors, []);
  } finally {
    if (originalMode === undefined) delete process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
    else process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = originalMode;
    (axios as any).post = originalPost;
  }
});

test('HTTP stream errors are read before explicit cache compatibility is evaluated', async () => {
  const originalPost = axios.post;
  const originalMode = process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
  const bodies: any[] = [];
  process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = 'on';
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          headers: { 'x-request-id': 'req-cache-stream' },
          data: circularErrorStream({
            error: { message: 'prompt_cache_options is not supported on this endpoint' },
          }),
        },
      });
    }
    return {
      data: Readable.from([
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          },
        })}\n\n`,
      ]),
    };
  };
  try {
    const instance = explicitProvider();
    const result = await instance.chatStream(
      [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
      [],
      undefined,
      context,
    );
    assert.equal(result.content, 'OK');
    assert.equal(bodies.length, 2);
    assert.equal(countBreakpoints(bodies[0].input), 1);
    assert.equal(bodies[1].prompt_cache_options, undefined);
    assert.equal(countBreakpoints(bodies[1].input), 0);
  } finally {
    if (originalMode === undefined) delete process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
    else process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = originalMode;
    (axios as any).post = originalPost;
  }
});

test('non-cache HTTP stream errors preserve the original status and parsed provider body', async () => {
  const originalPost = axios.post;
  let calls = 0;
  (axios as any).post = async () => {
    calls++;
    throw Object.assign(new Error('Request failed with status code 502'), {
      response: {
        status: 502,
        headers: { 'x-request-id': 'req-upstream-stream' },
        data: circularErrorStream({
          error: { type: 'upstream_error', message: 'upstream service unavailable' },
        }),
      },
    });
  };
  try {
    const instance = provider();
    await assert.rejects(
      instance.chatStream(
        [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
        [],
        undefined,
        context,
      ),
      (error: any) => {
        assert.equal(error.response?.status, 502);
        assert.equal(error.response?.headers?.['x-request-id'], 'req-upstream-stream');
        assert.equal(error.response?.data?.error?.message, 'upstream service unavailable');
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('Chat Completions HTTP stream errors use the same normalized provider body', async () => {
  const originalPost = axios.post;
  (axios as any).post = async () => {
    throw Object.assign(new Error('Request failed with status code 503'), {
      response: {
        status: 503,
        headers: { 'x-request-id': 'req-chat-stream' },
        data: circularErrorStream({
          error: { type: 'service_unavailable', message: 'chat upstream unavailable' },
        }),
      },
    });
  };
  try {
    const instance = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.example/v1',
      model: 'chat-model',
      openaiApiMode: 'chat_completions',
    });
    await assert.rejects(
      instance.chatStream([{ role: 'user', content: 'hello' }]),
      (error: any) => {
        assert.equal(error.response?.status, 503);
        assert.equal(error.response?.headers?.['x-request-id'], 'req-chat-stream');
        assert.equal(error.response?.data?.error?.message, 'chat upstream unavailable');
        return true;
      },
    );
  } finally {
    (axios as any).post = originalPost;
  }
});

test('plain-text HTTP stream errors are preserved as bounded provider messages', async () => {
  const originalPost = axios.post;
  const oversizedMessage = 'upstream failure '.repeat(8_000);
  let hadErrorListenerAtDestroy = false;
  (axios as any).post = async () => {
    const stream = Readable.from([Buffer.from(oversizedMessage, 'utf8')]);
    const originalDestroy = stream.destroy.bind(stream);
    (stream as any).destroy = (error?: Error) => {
      hadErrorListenerAtDestroy = stream.listenerCount('error') > 0;
      return originalDestroy(error);
    };
    (stream as any).socket = { _httpMessage: stream };
    throw Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: stream },
    });
  };
  try {
    await assert.rejects(
      provider().chatStream(
        [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
        [],
        undefined,
        context,
      ),
      (error: any) => {
        assert.equal(error.response?.status, 502);
        assert.equal(typeof error.response?.data?.message, 'string');
        assert.match(error.response.data.message, /\[truncated\]$/);
        assert.ok(Buffer.byteLength(error.response.data.message, 'utf8') < 66 * 1024);
        return true;
      },
    );
    assert.equal(hadErrorListenerAtDestroy, true);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('cancelled Responses requests do not wait for provider error stream normalization', async () => {
  const originalPost = axios.post;
  const controller = new AbortController();
  controller.abort();
  (axios as any).post = async () => {
    const stream = new Readable({ read() {} });
    throw Object.assign(new Error('canceled'), {
      name: 'CanceledError',
      code: 'ERR_CANCELED',
      response: { status: 499, data: stream },
    });
  };
  try {
    const startedAt = Date.now();
    await assert.rejects(
      provider().chatStream(
        [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
        [],
        undefined,
        { ...context, signal: controller.signal },
      ),
      /canceled/,
    );
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('explicit cache retry inspection never throws for circular non-stream error data', () => {
  const data: any = { error: { message: 'unrelated failure' } };
  data.self = data;
  const instance = provider();
  assert.doesNotThrow(() => {
    assert.equal((instance as any).shouldRetryWithoutExplicitAnchor({
      response: { status: 500, data },
    }, {
      input: [{
        role: 'developer',
        content: [{
          type: 'input_text',
          text: 'anchor',
          prompt_cache_breakpoint: { mode: 'explicit' },
        }],
      }],
    }), false);
  });
});

test('strict explicit cache mode surfaces streamed rejection without fallback', async () => {
  const originalPost = axios.post;
  const originalMode = process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
  const originalStrict = process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE_STRICT;
  const bodies: any[] = [];
  process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = 'on';
  process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE_STRICT = '1';
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    return {
      data: Readable.from([
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: { message: 'prompt_cache_breakpoint is not supported on this model' },
          },
        })}\n\n`,
      ]),
    };
  };
  try {
    const instance = explicitProvider();
    await assert.rejects(
      instance.chatStream(
        [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
        [],
        undefined,
        context,
      ),
      /prompt_cache_breakpoint is not supported/i,
    );
    assert.equal(bodies.length, 1);
    assert.equal(countBreakpoints(bodies[0].input), 1);
  } finally {
    if (originalMode === undefined) delete process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE;
    else process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE = originalMode;
    if (originalStrict === undefined) delete process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE_STRICT;
    else process.env.XIAOBA_RESPONSES_EXPLICIT_CACHE_STRICT = originalStrict;
    (axios as any).post = originalPost;
  }
});

test('Responses cache usage is recorded without prompt content', async () => {
  const originalPost = axios.post;
  const originalRuntimeEvent = Logger.runtimeEvent;
  const events: any[] = [];
  (axios as any).post = async () => ({
    data: {
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 1200,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 900, cache_write_tokens: 200 },
      },
    },
  });
  (Logger as any).runtimeEvent = (_level: string, _message: string, event: any) => events.push(event);
  try {
    await provider().chat([{ role: 'user', content: 'hello', __episodeId: 'episode-2' }], [], context);
    const usage = events.find(event => event.type === 'responses_cache_usage');
    assert.ok(usage);
    assert.equal(usage.payload.mode, 'implicit');
    assert.equal(typeof usage.payload.request_trace_id, 'string');
    assert.equal(typeof usage.payload.cache_key_hash, 'string');
    assert.equal(typeof usage.payload.logical_body_hash, 'string');
    assert.equal(usage.payload.input_tokens, 1200);
    assert.equal(usage.payload.cached_tokens, 900);
    assert.equal(usage.payload.cache_write_tokens, 200);
    assert.deepEqual(usage.payload.usage_input_detail_keys, ['cache_write_tokens', 'cached_tokens']);
    assert.equal(usage.payload.cache_write_tokens_present, true);
    assert.equal(JSON.stringify(usage).includes('hello'), false);
  } finally {
    (axios as any).post = originalPost;
    (Logger as any).runtimeEvent = originalRuntimeEvent;
  }
});

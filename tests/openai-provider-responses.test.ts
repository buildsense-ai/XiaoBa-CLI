import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai-provider';
import { AIService } from '../src/utils/ai-service';
import { Logger } from '../src/utils/logger';
import { captureModelErrorDiagnostics } from '../src/utils/model-error-observability';
import type { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

const lookupTool: ToolDefinition = {
  name: 'lookup',
  description: 'Look up a value',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function createProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://example.test/v1/chat/completions',
    model: 'gpt-test',
    openaiApiMode: 'responses',
  });
}

describe('OpenAIProvider Responses API mode', () => {
  test('builds Responses input and a stable prompt cache key', () => {
    const provider = createProvider();
    const first = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'first question' },
    ], [lookupTool]);
    const second = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'another question' },
    ], [lookupTool]);

    assert.equal(first.instructions, 'You are concise.');
    assert.deepEqual(first.input, [{ role: 'user', content: 'first question' }]);
    assert.deepEqual(first.tools, [{
      type: 'function',
      name: 'lookup',
      description: 'Look up a value',
      parameters: lookupTool.parameters,
    }]);
    assert.match(first.prompt_cache_key, /^catsco-[a-f0-9]{48}$/);
    assert.equal(first.prompt_cache_key, second.prompt_cache_key);
    assert.equal(first.store, false);
    assert.deepEqual(first.include, ['reasoning.encrypted_content']);
  });

  test('keeps dynamic system context out of cache identity and appends it as developer context', () => {
    const provider = createProvider();
    const first = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'system', content: '[transient_plan_status]\nstep one', __cacheScope: 'dynamic' },
      { role: 'user', content: 'first question' },
    ], [lookupTool]);
    const second = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'system', content: '[transient_plan_status]\nstep two' },
      { role: 'user', content: 'another question' },
    ], [lookupTool]);

    assert.equal(first.instructions, 'Stable policy.');
    assert.equal(second.instructions, 'Stable policy.');
    assert.equal(first.prompt_cache_key, second.prompt_cache_key);
    assert.deepEqual(first.input, [
      { role: 'user', content: 'first question' },
      { role: 'developer', content: '[transient_plan_status]\nstep one' },
    ]);
    assert.deepEqual(second.input, [
      { role: 'user', content: 'another question' },
      { role: 'developer', content: '[transient_plan_status]\nstep two' },
    ]);
  });

  test('logs implicit user and tool breakpoint prefixes from the actual Responses input', () => {
    const provider = createProvider();
    const originalRuntimeEvent = Logger.runtimeEvent;
    const events: any[] = [];
    (Logger as any).runtimeEvent = (_level: string, _message: string, event: any) => events.push(event);
    try {
      const commonMessages: Message[] = [
        { role: 'system', content: 'Stable policy.' },
        { role: 'user', content: 'use the tool' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"one"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'first result' },
      ];

      (provider as any).buildResponsesRequestBody([
        ...commonMessages,
        { role: 'system', content: '[transient_plan_status]\nstep one', __cacheScope: 'dynamic' },
      ], [lookupTool]);
      (provider as any).buildResponsesRequestBody([
        ...commonMessages,
        { role: 'system', content: '[transient_plan_status]\nstep two', __cacheScope: 'dynamic' },
      ], [lookupTool]);
      (provider as any).buildResponsesRequestBody([
        ...commonMessages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-2',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"two"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-2', content: 'second result' },
        { role: 'system', content: '[transient_plan_status]\nstep three', __cacheScope: 'dynamic' },
      ], [lookupTool]);

      const layouts = events.filter(event => event.type === 'responses_cache_layout');
      assert.equal(layouts.length, 3);
      assert.equal(layouts[0].payload.stream, false);
      assert.equal(layouts[0].payload.transport, 'json');
      assert.deepEqual(
        layouts[0].payload.implicit_candidates.map((candidate: any) => candidate.kind),
        ['user', 'tool'],
      );
      assert.equal(layouts[0].payload.implicit_trailing_items, 1);
      assert.equal(
        layouts[0].payload.implicit_latest_prefix_hash,
        layouts[1].payload.implicit_latest_prefix_hash,
      );
      assert.equal(
        layouts[2].payload.implicit_candidates.some((candidate: any) => (
          candidate.prefixHash === layouts[1].payload.implicit_latest_prefix_hash
        )),
        true,
      );
      assert.equal(JSON.stringify(layouts).includes('first result'), false);
      assert.equal(JSON.stringify(layouts).includes('step one'), false);
    } finally {
      (Logger as any).runtimeEvent = originalRuntimeEvent;
    }
  });

  test('keeps plan, subagent, runner, and device changes out of cache identity', () => {
    const provider = createProvider();
    const variants = [
      ['[transient_plan_status]\nstep one', '[transient_plan_status]\nstep two'],
      ['[transient_subagent_status]\nrunning', '[transient_subagent_status]\ncompleted'],
      ['[transient_runner_hint]\nfirst hint', '[transient_runner_hint]\nnext hint'],
      ['[transient_runtime_context]\ndevice-a', '[transient_runtime_context]\ndevice-b'],
    ];

    for (const [firstDynamic, secondDynamic] of variants) {
      const first = (provider as any).buildResponsesRequestBody([
        { role: 'system', content: 'Stable policy.' },
        { role: 'system', content: firstDynamic },
        { role: 'user', content: 'hello' },
      ], [lookupTool]);
      const second = (provider as any).buildResponsesRequestBody([
        { role: 'system', content: 'Stable policy.' },
        { role: 'system', content: secondDynamic },
        { role: 'user', content: 'hello' },
      ], [lookupTool]);

      assert.equal(first.prompt_cache_key, second.prompt_cache_key);
      assert.equal(first.input.at(-1).role, 'developer');
      assert.equal(first.input.at(-1).content, firstDynamic);
    }

    const changedStable = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Changed stable policy.' },
      { role: 'user', content: 'hello' },
    ], [lookupTool]);
    const baseline = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'hello' },
    ], [lookupTool]);
    assert.notEqual(changedStable.prompt_cache_key, baseline.prompt_cache_key);
  });

  test('canonicalizes tool order and schema keys while detecting contract changes', () => {
    const provider = createProvider();
    const alpha: ToolDefinition = {
      name: 'alpha',
      description: 'Alpha tool',
      parameters: {
        type: 'object',
        properties: {
          zebra: { description: 'last', type: 'string' },
          apple: { type: 'string', description: 'first' },
        },
        required: ['apple'],
      },
    };
    const alphaReordered: ToolDefinition = {
      name: 'alpha',
      description: 'Alpha tool',
      parameters: {
        required: ['apple'],
        properties: {
          apple: { description: 'first', type: 'string' },
          zebra: { type: 'string', description: 'last' },
        },
        type: 'object',
      },
    };
    const beta: ToolDefinition = {
      name: 'beta',
      description: 'Beta tool',
      parameters: { type: 'object', properties: {} },
    };

    const first = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'hello' },
    ], [beta, alpha]);
    const reordered = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'hello' },
    ], [alphaReordered, beta]);
    const changed = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'hello' },
    ], [{ ...alphaReordered, description: 'Changed contract' }, beta]);

    assert.deepEqual(first.tools.map((tool: any) => tool.name), ['alpha', 'beta']);
    assert.equal(first.prompt_cache_key, reordered.prompt_cache_key);
    assert.notEqual(first.prompt_cache_key, changed.prompt_cache_key);
  });

  test('applies configured reasoning only to endpoints known to support it', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      openaiApiMode: 'responses',
      reasoningEffort: 'high',
    });
    const compatibleProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://example.test/v1',
      model: 'gpt-test',
      openaiApiMode: 'responses',
      reasoningEffort: 'high',
    });

    const body = (provider as any).buildResponsesRequestBody([
      { role: 'user', content: 'use a tool' },
    ], [lookupTool]);
    const compatibleBody = (compatibleProvider as any).buildResponsesRequestBody([
      { role: 'user', content: 'use a tool' },
    ], [lookupTool]);

    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(compatibleBody.reasoning, undefined);
  });

  test('parses cached token usage from a non-stream response', async () => {
    const originalPost = axios.post;
    let seenUrl = '';
    let seenBody: any;
    (axios as any).post = async (url: string, body: any) => {
      seenUrl = url;
      seenBody = body;
      return {
        data: {
          status: 'completed',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'cached answer' }],
          }],
          usage: {
            input_tokens: 10000,
            output_tokens: 20,
            total_tokens: 10020,
            input_tokens_details: { cached_tokens: 9472, cache_creation_tokens: 512 },
          },
        },
      };
    };

    try {
      const result = await createProvider().chat([{ role: 'user', content: 'hello' }]);

      assert.equal(seenUrl, 'https://example.test/v1/responses');
      assert.equal(seenBody.stream, false);
      assert.equal(result.content, 'cached answer');
      assert.equal(result.usage?.cachedReadTokens, 9472);
      assert.equal(result.usage?.cachedWriteTokens, 512);
      assert.equal(result.usage?.totalTokens, 10020);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('returns a Responses refusal as visible content', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: {
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        }],
      },
    });

    try {
      const result = await createProvider().chat([{ role: 'user', content: 'hello' }]);
      assert.equal(result.content, 'I cannot help with that.');
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('throws a failed Responses result so callers can retry it', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: {
        id: 'resp_failed_1',
        status: 'failed',
        error: {
          code: 'upstream_error',
          type: 'server_error',
          message: 'upstream unavailable',
          request_id: 'req_failed_1',
        },
      },
      headers: { 'X-Request-Id': 'req_header_fallback' },
    });

    try {
      await assert.rejects(
        createProvider().chat([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error?.message === 'upstream unavailable'
          && error?.code === 'upstream_error'
          && error?.providerCode === 'upstream_error'
          && error?.providerType === 'server_error'
          && error?.status === 502
          && error?.responseId === 'resp_failed_1'
          && error?.request_id === 'req_failed_1'
        ),
      );
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('lets AIService retry a transient failed Responses result', async () => {
    const originalPost = axios.post;
    const originalMaxRetries = process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
    let attempts = 0;
    (axios as any).post = async () => {
      attempts += 1;
      return {
        data: attempts === 1
          ? {
              status: 'failed',
              error: { code: 'server_error', message: 'temporary upstream failure' },
            }
          : {
              status: 'completed',
              output: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'recovered' }],
              }],
            },
      };
    };
    process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';

    try {
      const service = new AIService({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1',
        model: 'gpt-test',
        provider: 'openai',
        openaiApiMode: 'responses',
      });
      (service as any).sleepWithAbort = async () => {};

      const result = await service.chat([{ role: 'user', content: 'hello' }]);
      assert.equal(attempts, 2);
      assert.equal(result.content, 'recovered');
    } finally {
      (axios as any).post = originalPost;
      if (originalMaxRetries === undefined) delete process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
      else process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = originalMaxRetries;
    }
  });

  test('replays provider function calls and CatsCo tool results', async () => {
    const originalPost = axios.post;
    const bodies: any[] = [];
    (axios as any).post = async (_url: string, body: any) => {
      bodies.push(body);
      return {
        data: bodies.length === 1
          ? {
              status: 'completed',
              output: [{
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'lookup',
                arguments: '{"query":"cats"}',
              }],
            }
          : {
              status: 'completed',
              output: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'tool result integrated' }],
              }],
            },
      };
    };

    try {
      const provider = createProvider();
      const first = await provider.chat([{ role: 'user', content: 'look it up' }], [lookupTool]);
      const messages: Message[] = [
        { role: 'user', content: 'look it up' },
        {
          role: 'assistant',
          content: first.content,
          tool_calls: first.toolCalls,
          providerContent: first.providerContent,
          providerState: first.providerState,
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'found cats' },
      ];
      const second = await provider.chat(messages, [lookupTool]);

      assert.equal(first.toolCalls?.[0].id, 'call_1');
      assert.equal(first.stopReason, 'tool_calls');
      assert.deepEqual(bodies[1].input.slice(-2), [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"query":"cats"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'found cats' },
      ]);
      assert.equal(second.content, 'tool result integrated');
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('falls back to canonical function calls when Responses replay state came from another endpoint', () => {
    const source = createProvider();
    const target = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://other.example.test/v1',
      model: 'gpt-test',
      provider: 'openai',
      openaiApiMode: 'responses',
    });
    const body = (target as any).buildResponsesRequestBody([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"cats"}' },
      }],
      providerContent: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"cats"}' },
      ],
      providerState: (source as any).providerStateReference('openai-responses'),
    }]);

    assert.deepEqual(body.input, [{
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"cats"}',
    }]);
  });

  test('streams visible text and resolves from the terminal Responses event', async () => {
    const originalPost = axios.post;
    const terminalResponse = {
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello<' }],
      }],
      usage: {
        input_tokens: 12,
        output_tokens: 2,
        total_tokens: 14,
        input_tokens_details: { cached_tokens: 8 },
      },
    };
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({ type: 'response.output_text.delta', delta: 'hello<' }),
        sse({ type: 'response.completed', response: terminalResponse }),
      ]),
    });

    try {
      const chunks: string[] = [];
      const result = await createProvider().chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: value => chunks.push(value) },
      );

      assert.deepEqual(chunks, ['hello', '<']);
      assert.equal(result.content, 'hello<');
      assert.equal(result.usage?.cachedReadTokens, 8);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves structured metadata from a terminal response.failed event', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({
          type: 'response.failed',
          response: {
            id: 'resp_stream_failed',
            status: 'failed',
            error: {
              code: 'stream_read_error',
              type: 'upstream_error',
              message: 'relay stream failed',
              request_id: 'req_stream_failed',
            },
          },
        }),
      ]),
      headers: { 'x-request-id': 'req_header_fallback' },
    });

    try {
      await assert.rejects(
        createProvider().chatStream([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error?.code === 'stream_read_error'
          && error?.providerCode === 'stream_read_error'
          && error?.providerType === 'upstream_error'
          && error?.responseId === 'resp_stream_failed'
          && error?.request_id === 'req_stream_failed'
          && error?.terminalEvent === 'response.failed'
          && error?.failurePhase === 'terminal_event'
        ),
      );
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves the response header request ID when a terminal failure has none', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({
          type: 'response.failed',
          response: {
            id: 'resp_header_only',
            status: 'failed',
            error: {
              code: 'upstream_error',
              type: 'server_error',
              message: 'upstream unavailable',
            },
          },
        }),
      ]),
      headers: {
        get: (name: string) => name === 'x-request-id' ? 'req_header_only' : undefined,
      },
    });

    try {
      await assert.rejects(
        createProvider().chatStream([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error?.request_id === 'req_header_only'
          && captureModelErrorDiagnostics(error).request_id === 'req_header_only'
        ),
      );
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('treats a terminal error event as a structured Responses failure', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({
          type: 'error',
          code: 'service_unavailable_error',
          message: 'temporarily unavailable',
        }),
      ]),
    });

    try {
      await assert.rejects(
        createProvider().chatStream([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error?.code === 'service_unavailable_error'
          && error?.status === 503
          && error?.terminalEvent === 'error'
          && error?.failurePhase === 'terminal_event'
        ),
      );
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('normalizes an unstructured Readable error with its cause and header request ID', async () => {
    const originalPost = axios.post;
    const sourceError = new Error('socket stream interrupted');
    (axios as any).post = async () => ({
      data: Readable.from((async function* () {
        throw sourceError;
      })()),
      headers: { 'x-request-id': 'req_stream_error' },
    });

    try {
      await assert.rejects(
        createProvider().chatStream([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error?.code === 'stream_read_error'
          && error?.providerCode === 'stream_read_error'
          && error?.providerType === 'stream_error'
          && error?.status === 502
          && error?.cause === sourceError
          && error?.request_id === 'req_stream_error'
          && error?.failurePhase === 'stream'
          && error?.terminalEvent === 'stream.error'
        ),
      );
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves structured Readable transport errors while adding stream metadata', async () => {
    const originalPost = axios.post;
    const sourceError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    (axios as any).post = async () => ({
      data: Readable.from((async function* () {
        throw sourceError;
      })()),
      headers: { 'x-request-id': 'req_structured_stream_error' },
    });

    try {
      await assert.rejects(
        createProvider().chatStream([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error === sourceError
          && error?.code === 'ECONNRESET'
          && error?.request_id === 'req_structured_stream_error'
          && error?.failurePhase === 'stream'
          && error?.terminalEvent === 'stream.error'
        ),
      );
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('retries the same streaming Responses request after a transient terminal failure', async () => {
    const originalPost = axios.post;
    const originalRetries = process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
    const bodies: any[] = [];
    const requestHeaders: any[] = [];
    (axios as any).post = async (_url: string, body: any, config: any) => {
      bodies.push(body);
      requestHeaders.push(config.headers);
      return {
        data: bodies.length === 1
          ? Readable.from([sse({
              type: 'response.failed',
              response: {
                status: 'failed',
                error: { code: 'upstream_error', message: 'try again' },
              },
            })])
          : Readable.from([sse({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [{
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'recovered' }],
                }],
              },
            })]),
      };
    };
    process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';

    try {
      const service = new AIService({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1',
        model: 'gpt-test',
        provider: 'openai',
        openaiApiMode: 'responses',
      });
      (service as any).sleepWithAbort = async () => {};
      const result = await service.chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        undefined,
        {
          promptCacheContext: {
            sessionKey: 'catscompany:test-session',
            phase: 'normal',
            explicitCaching: false,
          },
        },
      );

      assert.equal(result.content, 'recovered');
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].stream, true);
      assert.equal(bodies[1].stream, true);
      assert.equal(bodies[0].prompt_cache_key, bodies[1].prompt_cache_key);
      assert.equal(requestHeaders[0].session_id, requestHeaders[1].session_id);
      assert.equal(requestHeaders[0]['x-client-request-id'], requestHeaders[1]['x-client-request-id']);
    } finally {
      (axios as any).post = originalPost;
      if (originalRetries === undefined) delete process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
      else process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = originalRetries;
    }
  });

  test('retries an unstructured Readable error without publishing abandoned text', async () => {
    const originalPost = axios.post;
    const originalRetries = process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
    let attempts = 0;
    (axios as any).post = async () => {
      attempts += 1;
      return {
        data: attempts === 1
          ? Readable.from((async function* () {
              yield sse({ type: 'response.output_text.delta', delta: 'abandoned' });
              throw new Error('socket stream interrupted');
            })())
          : Readable.from([
              sse({ type: 'response.output_text.delta', delta: 'recovered' }),
              sse({
                type: 'response.completed',
                response: {
                  status: 'completed',
                  output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'recovered' }],
                  }],
                },
              }),
            ]),
        headers: { 'x-request-id': `req_attempt_${attempts}` },
      };
    };
    process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';

    try {
      const service = new AIService({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1',
        model: 'gpt-test',
        provider: 'openai',
        openaiApiMode: 'responses',
      });
      (service as any).sleepWithAbort = async () => {};
      const delivered: string[] = [];
      const result = await service.chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: text => delivered.push(text) },
        { streamOutputMode: 'buffered' },
      );

      assert.equal(attempts, 2);
      assert.equal(result.content, 'recovered');
      assert.deepEqual(delivered, ['recovered']);
    } finally {
      (axios as any).post = originalPost;
      if (originalRetries === undefined) delete process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
      else process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = originalRetries;
    }
  });

  test('does not expose abandoned function calls when a stream ends before its terminal event', async () => {
    const originalPost = axios.post;
    const originalRetries = process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
    let attempts = 0;
    (axios as any).post = async () => {
      attempts += 1;
      return {
        data: attempts === 1
          ? Readable.from([sse({
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'function_call',
                call_id: 'abandoned_call',
                name: 'lookup',
                arguments: '{"query":"abandoned"}',
              },
            })])
          : Readable.from([sse({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [{
                  type: 'function_call',
                  call_id: 'recovered_call',
                  name: 'lookup',
                  arguments: '{"query":"recovered"}',
                }],
              },
            })]),
      };
    };
    process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = '1';

    try {
      const service = new AIService({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1',
        model: 'gpt-test',
        provider: 'openai',
        openaiApiMode: 'responses',
      });
      (service as any).sleepWithAbort = async () => {};
      const result = await service.chatStream(
        [{ role: 'user', content: 'use a tool' }],
        [lookupTool],
        undefined,
        { streamOutputMode: 'buffered' },
      );

      assert.equal(attempts, 2);
      assert.deepEqual(result.toolCalls?.map(call => call.id), ['recovered_call']);
      assert.equal(JSON.stringify(result.providerContent).includes('abandoned_call'), false);
    } finally {
      (axios as any).post = originalPost;
      if (originalRetries === undefined) delete process.env.CATSCO_MODEL_RETRY_MAX_RETRIES;
      else process.env.CATSCO_MODEL_RETRY_MAX_RETRIES = originalRetries;
    }
  });

  test('aborts a Responses attempt when response headers exceed the watchdog', async () => {
    const originalPost = axios.post;
    const originalTimeout = process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
    let capturedSignal: AbortSignal | undefined;
    (axios as any).post = async (_url: string, _body: any, config: any) => {
      capturedSignal = config.signal;
      return await new Promise((_resolve, reject) => {
        config.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }));
        }, { once: true });
      });
    };
    process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = '5';

    try {
      await assert.rejects(
        createProvider().chatStream([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error?.code === 'XIAOBA_RESPONSES_HEADERS_TIMEOUT'
          && error?.status === 504
          && error?.failurePhase === 'headers'
        ),
      );
      assert.equal(capturedSignal?.aborted, true);
    } finally {
      (axios as any).post = originalPost;
      if (originalTimeout === undefined) delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
      else process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = originalTimeout;
    }
  });

  test('cleans up the Responses header watchdog after headers arrive', async () => {
    const originalPost = axios.post;
    const originalTimeout = process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
    let capturedSignal: AbortSignal | undefined;
    (axios as any).post = async (_url: string, _body: any, config: any) => {
      capturedSignal = config.signal;
      return {
        data: Readable.from([sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            }],
          },
        })]),
      };
    };
    process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = '5';

    try {
      const result = await createProvider().chatStream([{ role: 'user', content: 'hello' }]);
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(result.content, 'ok');
      assert.equal(capturedSignal?.aborted, false);
    } finally {
      (axios as any).post = originalPost;
      if (originalTimeout === undefined) delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
      else process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = originalTimeout;
    }
  });

  test('preserves streamed text when the terminal response omits its message', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({ type: 'response.output_text.delta', delta: 'answer from ' }),
        sse({ type: 'response.output_text.delta', delta: 'stream' }),
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'reasoning', id: 'reasoning_1', summary: [] }],
            usage: {
              input_tokens: 50,
              output_tokens: 10,
              total_tokens: 60,
            },
          },
        }),
      ]),
    });

    try {
      const chunks: string[] = [];
      const result = await createProvider().chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: value => chunks.push(value) },
      );

      assert.deepEqual(chunks, ['answer from ', 'stream']);
      assert.equal(result.content, 'answer from stream');
      assert.equal(result.stopReason, 'completed');
      assert.equal(result.usage?.totalTokens, 60);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('prefers terminal response text over the streamed fallback', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({ type: 'response.output_text.delta', delta: 'streamed draft' }),
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'terminal answer' }],
            }],
          },
        }),
      ]),
    });

    try {
      const result = await createProvider().chatStream(
        [{ role: 'user', content: 'hello' }],
      );

      assert.equal(result.content, 'terminal answer');
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('streams a Responses refusal and preserves it in the final result', async () => {
    const originalPost = axios.post;
    const terminalResponse = {
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
      }],
    };
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({ type: 'response.refusal.delta', delta: 'I cannot help with that.' }),
        sse({ type: 'response.completed', response: terminalResponse }),
      ]),
    });

    try {
      const chunks: string[] = [];
      const result = await createProvider().chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: value => chunks.push(value) },
      );

      assert.deepEqual(chunks, ['I cannot help with that.']);
      assert.equal(result.content, 'I cannot help with that.');
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves Chinese text when a UTF-8 character crosses Responses SSE chunks', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        ...splitSseInsideUtf8({ type: 'response.output_text.delta', delta: '中文' }, '中'),
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '中文' }],
            }],
          },
        }),
      ]),
    });

    try {
      const chunks: string[] = [];
      const result = await createProvider().chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: value => chunks.push(value) },
      );

      assert.equal(chunks.join(''), '中文');
      assert.equal(result.content, '中文');
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves Chinese text when a UTF-8 character crosses Chat Completions SSE chunks', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        ...splitSseInsideUtf8({
          choices: [{ index: 0, delta: { content: '中文' }, finish_reason: null }],
        }, '中'),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ]),
    });

    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://example.test/v1/chat/completions',
      model: 'gpt-test',
      openaiApiMode: 'chat_completions',
    });

    try {
      const chunks: string[] = [];
      const result = await provider.chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: value => chunks.push(value) },
      );

      assert.equal(chunks.join(''), '中文');
      assert.equal(result.content, '中文');
    } finally {
      (axios as any).post = originalPost;
    }
  });
});

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function splitSseInsideUtf8(payload: unknown, character: string): Buffer[] {
  const bytes = Buffer.from(sse(payload), 'utf8');
  const characterBytes = Buffer.from(character, 'utf8');
  const index = bytes.indexOf(characterBytes);
  assert.notEqual(index, -1, `expected ${character} in SSE payload`);
  return [bytes.subarray(0, index + 1), bytes.subarray(index + 1)];
}

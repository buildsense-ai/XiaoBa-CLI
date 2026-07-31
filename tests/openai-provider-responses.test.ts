import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai-provider';
import { AIService } from '../src/utils/ai-service';
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

function createCacheProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://relay.catsco.cc/v1',
    model: 'gpt-test',
    openaiApiMode: 'responses',
  });
}

describe('OpenAIProvider Responses API mode', () => {
  test('builds Responses input and a stable prompt cache key', () => {
    const provider = createCacheProvider();
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

  test('adds explicit cache breakpoints for GPT-5.6 Responses requests', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const body = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_lookup',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"one"}' },
        }],
      },
      { role: 'tool', name: 'lookup', tool_call_id: 'call_lookup', content: 'first result' },
      { role: 'user', content: 'second question' },
      {
        role: 'system',
        content: '[transient_plan_status]\nstep two',
        __cacheScope: 'dynamic',
      },
    ], [lookupTool]);

    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
    assert.equal(body.tools.at(-1).prompt_cache_breakpoint, undefined);
    assert.deepEqual(
      body.input
        .filter((item: any) => {
          const content = item.type === 'function_call_output' ? item.output : item.content;
          return Array.isArray(content)
            && content.some((block: any) => block.prompt_cache_breakpoint);
        })
        .map((item: any) => item.type ?? item.role),
      ['user', 'function_call_output', 'user'],
    );
    assert.equal(body.input.at(-1).role, 'system');
    const trailingContent = body.input.at(-1).content;
    assert.equal(
      Array.isArray(trailingContent)
        && trailingContent.some((block: any) => block.prompt_cache_breakpoint),
      false,
    );
    for (const item of body.input.slice(0, -1)) {
      if (item.role !== 'user' && item.type !== 'function_call_output') continue;
      const content = item.type === 'function_call_output' ? item.output : item.content;
      assert.deepEqual(content.at(-1).prompt_cache_breakpoint, { mode: 'explicit' });
    }
  });

  test('preserves cache boundaries as a GPT-5.6 conversation grows', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const firstMessages: Message[] = Array.from(
      { length: 5 },
      (_, index) => ({ role: 'user', content: `question ${index + 1}` }),
    );
    const first = (provider as any).buildResponsesRequestBody(firstMessages);
    const grown = (provider as any).buildResponsesRequestBody([
      ...firstMessages,
      { role: 'user', content: 'question 6' },
    ]);

    assert.deepEqual(grown.input.slice(0, first.input.length), first.input);

    const longMessages: Message[] = Array.from(
      { length: 52 },
      (_, index) => ({ role: 'user', content: `question ${index + 1}` }),
    );
    const long = (provider as any).buildResponsesRequestBody(longMessages);
    const longer = (provider as any).buildResponsesRequestBody([
      ...longMessages,
      { role: 'user', content: 'question 53' },
    ]);
    const marked = long.input.filter((item: any) => Array.isArray(item.content)
      && item.content.some((block: any) => block.prompt_cache_breakpoint));
    assert.equal(marked.length, 52);
    assert.deepEqual(marked[0].content.at(-1).prompt_cache_breakpoint, { mode: 'explicit' });
    assert.deepEqual(longer.input.slice(0, long.input.length), long.input);
  });

  test('does not send GPT-5.6 cache extensions to an unknown Responses endpoint', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://custom.example.test/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const body = (provider as any).buildResponsesRequestBody([
      { role: 'user', content: 'question' },
    ]);

    assert.equal(body.prompt_cache_options, undefined);
    assert.equal(body.prompt_cache_key, undefined);
    assert.deepEqual(body.input, [{ role: 'user', content: 'question' }]);
  });

  test('partitions prompt cache keys by stable request scope', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const first = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'first question' },
    ], [lookupTool], false, 'session-a');
    const grown = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'another question' },
    ], [lookupTool], false, 'session-a');
    const independent = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'first question' },
    ], [lookupTool], false, 'session-b');
    const otherTenantProvider = new OpenAIProvider({
      apiKey: 'other-test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const otherTenant = (otherTenantProvider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'first question' },
    ], [lookupTool], false, 'session-a');

    assert.equal(first.prompt_cache_key, grown.prompt_cache_key);
    assert.notEqual(first.prompt_cache_key, independent.prompt_cache_key);
    assert.notEqual(first.prompt_cache_key, otherTenant.prompt_cache_key);
  });

  test('keeps transient user and tool observations in the suffix after the last cache boundary', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const body = (provider as any).buildResponsesRequestBody([
      { role: 'user', content: 'durable question' },
      {
        role: 'user',
        content: 'temporary retry feedback',
        __injected: true,
        __runtimeFeedback: true,
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'synthetic-call',
          type: 'function',
          function: { name: 'runtime_observation', arguments: '{}' },
        }],
        __syntheticObservation: true,
      },
      {
        role: 'tool',
        name: 'runtime_observation',
        tool_call_id: 'synthetic-call',
        content: 'temporary branch result',
        __syntheticObservation: true,
      },
      { role: 'user', content: 'current question' },
    ]);

    assert.deepEqual(body.input[0].content.at(-1).prompt_cache_breakpoint, { mode: 'explicit' });
    assert.equal(body.input[1].content, 'temporary retry feedback');
    assert.equal(body.input[3].output, 'temporary branch result');
    assert.equal(body.input[4].content, 'current question');
    assert.equal(
      body.input.slice(1).some((item: any) => {
        const content = item.type === 'function_call_output' ? item.output : item.content;
        return Array.isArray(content)
          && content.some((block: any) => block.prompt_cache_breakpoint);
      }),
      false,
    );
  });

  test('keeps checkpoint boundaries out of the stable cache identity', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const first = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      {
        role: 'system',
        content: '[checkpoint_compaction_boundary] kind=base tokens_before=100',
        __checkpointBoundary: true,
      },
      { role: 'user', content: 'summary one', __checkpointSummary: true },
      { role: 'user', content: 'new question' },
    ]);
    const second = (provider as any).buildResponsesRequestBody([
      { role: 'system', content: 'Stable policy.' },
      {
        role: 'system',
        content: '[checkpoint_compaction_boundary] kind=delta tokens_before=200',
        __checkpointBoundary: true,
      },
      { role: 'user', content: 'summary one', __checkpointSummary: true },
      { role: 'user', content: 'new question' },
    ]);

    assert.equal(first.instructions, 'Stable policy.');
    assert.equal(second.instructions, 'Stable policy.');
    assert.equal(first.prompt_cache_key, second.prompt_cache_key);
    assert.deepEqual(first.input.at(-1), {
      role: 'system',
      content: '[checkpoint_compaction_boundary] kind=base tokens_before=100',
    });
    assert.deepEqual(second.input.at(-1), {
      role: 'system',
      content: '[checkpoint_compaction_boundary] kind=delta tokens_before=200',
    });
  });

  test('keeps explicit mode when transient content closes every cache boundary', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      openaiApiMode: 'responses',
    });
    const body = (provider as any).buildResponsesRequestBody([
      {
        role: 'user',
        content: 'temporary runtime feedback',
        __injected: true,
        __runtimeFeedback: true,
      },
      { role: 'user', content: 'current question' },
    ]);

    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
    assert.equal(
      body.input.some((item: any) => Array.isArray(item.content)
        && item.content.some((block: any) => block.prompt_cache_breakpoint)),
      false,
    );
  });

  test('keeps dynamic system context out of cache identity and appends it to input', () => {
    const provider = createCacheProvider();
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
      { role: 'system', content: '[transient_plan_status]\nstep one' },
    ]);
    assert.deepEqual(second.input, [
      { role: 'user', content: 'another question' },
      { role: 'system', content: '[transient_plan_status]\nstep two' },
    ]);
  });

  test('keeps plan, subagent, runner, and device changes out of cache identity', () => {
    const provider = createCacheProvider();
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
      assert.equal(first.input.at(-1).role, 'system');
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
    const provider = createCacheProvider();
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
        status: 'failed',
        error: { code: 'server_error', message: 'upstream unavailable' },
      },
    });

    try {
      await assert.rejects(
        createProvider().chat([{ role: 'user', content: 'hello' }]),
        (error: any) => (
          error?.message === 'upstream unavailable'
          && error?.code === 'server_error'
          && error?.status === 500
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

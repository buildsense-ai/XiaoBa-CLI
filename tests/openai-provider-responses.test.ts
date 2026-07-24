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
            input_tokens_details: { cached_tokens: 9472 },
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

  test('preserves UTF-8 when Responses SSE splits a character across chunks', async () => {
    const originalPost = axios.post;
    const terminalResponse = {
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '中文' }],
      }],
    };
    const splitEvent = splitInsideUtf8Character(
      sse({ type: 'response.output_text.delta', delta: '中文' }),
      '中',
    );
    (axios as any).post = async () => ({
      data: Readable.from([
        ...splitEvent,
        Buffer.from(sse({ type: 'response.completed', response: terminalResponse }), 'utf8'),
      ]),
    });

    try {
      const chunks: string[] = [];
      const result = await createProvider().chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: value => chunks.push(value) },
      );

      assert.deepEqual(chunks, ['中文']);
      assert.equal(result.content, '中文');
      assert.equal(JSON.stringify(result).includes('�'), false);
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
});

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function splitInsideUtf8Character(value: string, character: string): Buffer[] {
  const buffer = Buffer.from(value, 'utf8');
  const characterBytes = Buffer.from(character, 'utf8');
  const offset = buffer.indexOf(characterBytes);
  assert.notEqual(offset, -1);
  return [
    buffer.subarray(0, offset + 1),
    buffer.subarray(offset + 1),
  ];
}

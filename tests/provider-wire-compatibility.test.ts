import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai-provider';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
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

describe('provider wire compatibility', () => {
  test('selects OpenAI chat-completions and preserves its request and tool-call response shape', async () => {
    const originalPost = axios.post;
    let seenRequest: any;
    (axios as any).post = async (url: string, body: any, config: any) => {
      seenRequest = { url, body, config };
      return {
        data: {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_chat_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"query":"cats"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      };
    };

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'http://127.0.0.1:9/v1',
        model: 'gpt-wire-test',
        temperature: 0.25,
        openaiApiMode: 'chat_completions',
      });
      const result = await provider.chat([
        { role: 'system', content: 'System contract.' },
        { role: 'user', content: 'Call lookup.' },
      ], [lookupTool]);

      assert.equal(seenRequest.url, 'http://127.0.0.1:9/v1/chat/completions');
      assert.deepEqual(seenRequest.body.messages, [
        { role: 'system', content: 'System contract.' },
        { role: 'user', content: 'Call lookup.' },
      ]);
      assert.equal(seenRequest.body.model, 'gpt-wire-test');
      assert.equal(seenRequest.body.temperature, 0.25);
      assert.equal(seenRequest.body.stream, false);
      assert.deepEqual(seenRequest.body.tools, [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a value',
          parameters: lookupTool.parameters,
        },
      }]);
      assert.equal(seenRequest.config.headers.Authorization, 'Bearer test-key');
      assert.equal(result.content, null);
      assert.equal(result.stopReason, 'tool_calls');
      assert.deepEqual(result.toolCalls, [{
        id: 'call_chat_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"cats"}' },
      }]);
      assert.equal(result.usage?.totalTokens, 14);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('selects OpenAI responses and preserves its request and function-call response shape', async () => {
    const originalPost = axios.post;
    let seenRequest: any;
    (axios as any).post = async (url: string, body: any, config: any) => {
      seenRequest = { url, body, config };
      return {
        data: {
          status: 'completed',
          output: [{
            type: 'function_call',
            id: 'fc_responses_1',
            call_id: 'call_responses_1',
            name: 'lookup',
            arguments: '{"query":"dogs"}',
          }],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        },
        headers: {},
      };
    };

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'http://127.0.0.1:9/v1/chat/completions',
        model: 'gpt-wire-test',
        openaiApiMode: 'responses',
      });
      const result = await provider.chat([
        { role: 'system', content: 'System contract.' },
        { role: 'user', content: 'Call lookup.' },
      ], [lookupTool]);

      assert.equal(seenRequest.url, 'http://127.0.0.1:9/v1/responses');
      assert.equal(seenRequest.body.instructions, 'System contract.');
      assert.deepEqual(seenRequest.body.input, [{ role: 'user', content: 'Call lookup.' }]);
      assert.equal(seenRequest.body.messages, undefined);
      assert.equal(seenRequest.body.model, 'gpt-wire-test');
      assert.equal(seenRequest.body.stream, false);
      assert.equal(seenRequest.body.store, false);
      assert.deepEqual(seenRequest.body.include, ['reasoning.encrypted_content']);
      assert.match(seenRequest.body.prompt_cache_key, /^catsco-[a-f0-9]{48}$/);
      assert.deepEqual(seenRequest.body.tools, [{
        type: 'function',
        name: 'lookup',
        description: 'Look up a value',
        parameters: lookupTool.parameters,
      }]);
      assert.equal(seenRequest.config.headers.Authorization, 'Bearer test-key');
      assert.equal(result.content, null);
      assert.equal(result.stopReason, 'tool_calls');
      assert.deepEqual(result.toolCalls, [{
        id: 'call_responses_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"dogs"}' },
      }]);
      assert.equal(result.usage?.totalTokens, 15);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves Anthropic message payload and maps streamed terminal text and tool use', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'http://127.0.0.1:9/v1/messages',
      model: 'claude-wire-test',
      temperature: 0.2,
    });
    let seenParams: any;
    let seenOptions: any;
    const textListeners: Array<(text: string) => void> = [];
    const stream = {
      on(event: string, listener: (text: string) => void) {
        if (event === 'text') textListeners.push(listener);
        return stream;
      },
      async finalMessage() {
        for (const listener of textListeners) listener('checking ');
        return {
          content: [
            { type: 'text', text: 'checking ' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'lookup',
              input: { query: 'birds' },
            },
          ],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 2,
            output_tokens: 4,
          },
        };
      },
    };
    (provider as any).client.messages.stream = (params: any, options: any) => {
      seenParams = params;
      seenOptions = options;
      return stream;
    };

    const chunks: string[] = [];
    let completed: any;
    const result = await provider.chatStream([
      { role: 'system', content: 'System contract.' },
      { role: 'user', content: 'Call lookup.' },
    ], [lookupTool], {
      onText: text => chunks.push(text),
      onComplete: value => { completed = value; },
    });

    assert.equal((provider as any).client.baseURL, 'http://127.0.0.1:9');
    assert.equal(seenParams.model, 'claude-wire-test');
    assert.equal(seenParams.system, 'System contract.');
    assert.deepEqual(seenParams.messages, [{ role: 'user', content: 'Call lookup.' }]);
    assert.equal(seenParams.temperature, 0.2);
    assert.equal(seenParams.stream, true);
    assert.deepEqual(seenParams.tools, [{
      name: 'lookup',
      description: 'Look up a value',
      input_schema: lookupTool.parameters,
    }]);
    assert.deepEqual(seenOptions, { signal: undefined });
    assert.deepEqual(chunks, ['checking ']);
    assert.equal(result.content, 'checking ');
    assert.equal(result.stopReason, 'tool_use');
    assert.deepEqual(result.toolCalls, [{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"query":"birds"}' },
    }]);
    assert.equal(result.usage?.promptTokens, 12);
    assert.equal(result.usage?.completionTokens, 4);
    assert.equal(result.usage?.totalTokens, 16);
    assert.equal(completed, result);
  });
});

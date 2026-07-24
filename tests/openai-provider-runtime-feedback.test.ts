import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { Readable } from 'node:stream';
import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai-provider';
import { Message } from '../src/types';

describe('OpenAIProvider runtime feedback boundary', () => {
  test('strips internal injected fields before building SDK messages', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://example.test/v1/chat/completions',
      model: 'test-model',
    });

    const messages: Message[] = [
      {
        role: 'user',
        content: '[运行时反馈] feishu.file_download\n错误: 文件下载失败',
        __injected: true,
        __runtimeFeedback: true,
        __runtimeObservation: true,
        runtimeObservationSource: 'subagent_result',
        __episodeId: 'episode:test',
        __episodeInputKind: 'root',
        extra: 'must not leak',
      } as any,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'send_text', arguments: '{"text":"hello"}' },
        }],
        __injected: true,
      } as any,
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'send_text',
        content: 'ok',
        __runtimeFeedback: true,
      } as any,
    ];

    const body = (provider as any).buildRequestBody(messages);

    assert.deepStrictEqual(Object.keys(body.messages[0]).sort(), ['content', 'role']);
    assert.deepStrictEqual(Object.keys(body.messages[1]).sort(), ['content', 'role', 'tool_calls']);
    assert.deepStrictEqual(Object.keys(body.messages[2]).sort(), ['content', 'name', 'role', 'tool_call_id']);
    assert.equal(JSON.stringify(body.messages).includes('__injected'), false);
    assert.equal(JSON.stringify(body.messages).includes('__runtimeFeedback'), false);
    assert.equal(JSON.stringify(body.messages).includes('__runtimeObservation'), false);
    assert.equal(JSON.stringify(body.messages).includes('__episodeId'), false);
    assert.equal(JSON.stringify(body.messages).includes('__episodeInputKind'), false);
    assert.equal(JSON.stringify(body.messages).includes('runtimeObservationSource'), false);
    assert.equal(JSON.stringify(body.messages).includes('must not leak'), false);
  });

  test('adds explicit DeepSeek reasoning effort only when configured', () => {
    const maxProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    });
    const defaultProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'default',
    });
    const minimaxProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'MiniMax-M3',
      reasoningEffort: 'max',
    });

    const maxBody = (maxProvider as any).buildRequestBody([{ role: 'user', content: 'hello' }]);
    const defaultBody = (defaultProvider as any).buildRequestBody([{ role: 'user', content: 'hello' }]);
    const minimaxBody = (minimaxProvider as any).buildRequestBody([{ role: 'user', content: 'hello' }]);

    assert.deepStrictEqual(maxBody.thinking, { type: 'enabled' });
    assert.equal(maxBody.reasoning_effort, 'max');
    assert.equal(defaultBody.thinking, undefined);
    assert.equal(defaultBody.reasoning_effort, undefined);
    assert.equal(minimaxBody.thinking, undefined);
    assert.equal(minimaxBody.reasoning_effort, undefined);
  });

  test('maps GPT-5.6 reasoning effort to Chat Completions and Responses fields', () => {
    const chatProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'minimal',
      openaiApiMode: 'chat_completions',
    });
    const responsesProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      openaiApiMode: 'responses',
    });

    const chatBody = (chatProvider as any).buildRequestBody([{ role: 'user', content: 'hello' }]);
    const responsesBody = (responsesProvider as any).buildResponsesRequestBody([{ role: 'user', content: 'hello' }]);

    assert.equal(chatBody.reasoning_effort, 'minimal');
    assert.equal(chatBody.thinking, undefined);
    assert.deepStrictEqual(responsesBody.reasoning, { effort: 'xhigh' });
  });

  test('sends explicit OpenAI-compatible reasoning disable', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'disabled',
    });

    const body = (provider as any).buildRequestBody([{ role: 'user', content: 'hello' }]);

    assert.deepStrictEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.reasoning_effort, undefined);
  });

  test('maps OpenAI-compatible GLM reasoning to thinking switch without effort field', () => {
    const highProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'glm-5.1',
      reasoningEffort: 'high',
    });
    const disabledProvider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'glm-5.1',
      reasoningEffort: 'disabled',
    });

    const highBody = (highProvider as any).buildRequestBody([{ role: 'user', content: 'hello' }]);
    const disabledBody = (disabledProvider as any).buildRequestBody([{ role: 'user', content: 'hello' }]);

    assert.deepStrictEqual(highBody.thinking, { type: 'enabled' });
    assert.equal(highBody.reasoning_effort, undefined);
    assert.deepStrictEqual(disabledBody.thinking, { type: 'disabled' });
    assert.equal(disabledBody.reasoning_effort, undefined);
  });

  test('preserves finish reason for non-stream responses', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: {
        choices: [{
          finish_reason: 'length',
          message: { content: 'ok' },
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
        },
      },
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'test-model',
      });

      const result = await provider.chat([{ role: 'user', content: 'hello' }]);

      assert.equal(result.content, 'ok');
      assert.equal(result.stopReason, 'length');
      assert.equal(result.usage?.totalTokens, 3);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('hides OpenAI-compatible reasoning fields and think tags in non-stream responses', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: {
        choices: [{
          finish_reason: 'stop',
          message: {
            reasoning_content: 'private chain of thought',
            content: '<think>hidden scratchpad</think>\n最终答案',
          },
        }],
      },
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'test-model',
      });

      const result = await provider.chat([{ role: 'user', content: 'hello' }]);

      assert.equal(result.content, '最终答案');
      assert.equal(JSON.stringify(result).includes('private chain of thought'), false);
      assert.equal(JSON.stringify(result).includes('hidden scratchpad'), false);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('keeps OpenAI tool calls while hiding reasoning text', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: '<think>choose tool</think>',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"query":"cats"}' },
            }],
          },
        }],
      },
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'test-model',
      });

      const result = await provider.chat([{ role: 'user', content: 'hello' }]);

      assert.equal(result.content, null);
      assert.equal(result.toolCalls?.[0].id, 'call_1');
      assert.equal(result.toolCalls?.[0].function.name, 'lookup');
      assert.equal(JSON.stringify(result).includes('choose tool'), false);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves OpenAI reasoning content only for tool-call replay', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            reasoning_content: 'private chain for replay',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"query":"cats"}' },
            }],
          },
        }],
      },
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'deepseek-v4-flash',
      });

      const result = await provider.chat([{ role: 'user', content: 'hello' }]);

      assert.equal(result.content, null);
      assert.equal(result.toolCalls?.[0].id, 'call_1');
      assert.deepStrictEqual(result.providerContent, [
        { type: 'openai_reasoning', reasoning_content: 'private chain for replay' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'cats' } },
      ]);

      const replayBody = (provider as any).buildRequestBody([{
        role: 'assistant',
        content: null,
        tool_calls: result.toolCalls,
        providerContent: result.providerContent,
      }]);

      assert.equal(replayBody.messages[0].reasoning_content, 'private chain for replay');
      assert.equal(JSON.stringify({ content: result.content, toolCalls: result.toolCalls }).includes('private chain'), false);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('does not replay DeepSeek reasoning content after switching to non-DeepSeek OpenAI model', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/v1',
      model: 'MiniMax-M3',
    });

    const body = (provider as any).buildRequestBody([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"cats"}' },
      }],
      providerContent: [
        { type: 'openai_reasoning', reasoning_content: 'private deepseek chain' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'cats' } },
      ],
    }]);

    assert.equal(body.messages[0].reasoning_content, undefined);
  });

  test('replays OpenAI reasoning content for DeepSeek-compatible custom aliases', () => {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      apiUrl: 'https://api.deepseek.com/v1',
      model: 'custom-chat-alias',
    });

    const body = (provider as any).buildRequestBody([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"cats"}' },
      }],
      providerContent: [
        { type: 'openai_reasoning', reasoning_content: 'private deepseek chain' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'cats' } },
      ],
    }]);

    assert.equal(body.messages[0].reasoning_content, 'private deepseek chain');
  });

  test('preserves finish reason for stream responses', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'test-model',
      });
      const chunks: string[] = [];

      const result = await provider.chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: chunk => chunks.push(chunk) },
      );

      assert.equal(result.content, 'hello');
      assert.equal(result.stopReason, 'stop');
      assert.equal(result.usage?.totalTokens, 3);
      assert.deepEqual(chunks, ['hel', 'lo']);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves UTF-8 when Chat Completions SSE splits a character across chunks', async () => {
    const originalPost = axios.post;
    const splitEvent = splitInsideUtf8Character(
      'data: {"choices":[{"delta":{"content":"中文"},"finish_reason":"stop"}]}\n\n',
      '中',
    );
    (axios as any).post = async () => ({
      data: Readable.from([
        ...splitEvent,
        Buffer.from('data: [DONE]\n\n', 'utf8'),
      ]),
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'test-model',
      });
      const chunks: string[] = [];

      const result = await provider.chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: chunk => chunks.push(chunk) },
      );

      assert.equal(result.content, '中文');
      assert.deepEqual(chunks, ['中文']);
      assert.equal(JSON.stringify(result).includes('�'), false);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('hides OpenAI-compatible reasoning fields and split think tags in stream responses', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"nk>hidden"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"</think>可见"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"回复"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'test-model',
      });
      const chunks: string[] = [];

      const result = await provider.chatStream(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { onText: chunk => chunks.push(chunk) },
      );

      assert.equal(result.content, '可见回复');
      assert.deepEqual(chunks, ['可见', '回复']);
      assert.equal(JSON.stringify(result).includes('private'), false);
      assert.equal(JSON.stringify(result).includes('hidden'), false);
    } finally {
      (axios as any).post = originalPost;
    }
  });

  test('preserves streamed OpenAI reasoning content only for tool-call replay', async () => {
    const originalPost = axios.post;
    (axios as any).post = async () => ({
      data: Readable.from([
        sse({ choices: [{ delta: { reasoning_content: 'private ' } }] }),
        sse({ choices: [{ delta: { reasoning_content: 'stream chain' } }] }),
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_stream',
                type: 'function',
                function: { name: 'lookup', arguments: '{"query":"cats"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }),
        'data: [DONE]\n\n',
      ]),
    });

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        apiUrl: 'https://example.test/v1/chat/completions',
        model: 'deepseek-v4-flash',
      });

      const result = await provider.chatStream([{ role: 'user', content: 'hello' }]);

      assert.equal(result.content, null);
      assert.equal(result.toolCalls?.[0].id, 'call_stream');
      assert.deepStrictEqual(result.providerContent, [
        { type: 'openai_reasoning', reasoning_content: 'private stream chain' },
        { type: 'tool_use', id: 'call_stream', name: 'lookup', input: { query: 'cats' } },
      ]);

      const replayBody = (provider as any).buildRequestBody([{
        role: 'assistant',
        content: null,
        tool_calls: result.toolCalls,
        providerContent: result.providerContent,
      }]);

      assert.equal(replayBody.messages[0].reasoning_content, 'private stream chain');
    } finally {
      (axios as any).post = originalPost;
    }
  });
});

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

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

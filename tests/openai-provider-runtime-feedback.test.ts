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
    assert.equal(JSON.stringify(body.messages).includes('runtimeObservationSource'), false);
    assert.equal(JSON.stringify(body.messages).includes('must not leak'), false);
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
});

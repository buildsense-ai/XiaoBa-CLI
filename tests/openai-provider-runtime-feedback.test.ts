import { describe, test } from 'node:test';
import * as assert from 'node:assert';
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
});

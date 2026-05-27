import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { Message } from '../src/types';

describe('AnthropicProvider runtime feedback boundary', () => {
  test('transforms runtime feedback without leaking internal message fields', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://example.test/v1/messages',
      model: 'claude-sonnet-4-20250514',
    });

    const messages: Message[] = [
      {
        role: 'system',
        content: 'system',
        __injected: true,
      } as any,
      {
        role: 'user',
        content: '[运行时反馈] weixin.media_download\n错误: 媒体下载不完整',
        __injected: true,
        __runtimeFeedback: true,
        __runtimeObservation: true,
        runtimeObservationSource: 'subagent_result',
        extra: 'must not leak',
      } as any,
    ];

    const transformed = (provider as any).transformMessages(messages);

    assert.equal(transformed.system, 'system');
    assert.deepStrictEqual(transformed.messages, [{
      role: 'user',
      content: '[运行时反馈] weixin.media_download\n错误: 媒体下载不完整',
    }]);
    assert.equal(JSON.stringify(transformed).includes('__injected'), false);
    assert.equal(JSON.stringify(transformed).includes('__runtimeFeedback'), false);
    assert.equal(JSON.stringify(transformed).includes('__runtimeObservation'), false);
    assert.equal(JSON.stringify(transformed).includes('runtimeObservationSource'), false);
    assert.equal(JSON.stringify(transformed).includes('must not leak'), false);
  });

  test('preserves stop reason and joins multiple text blocks', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/anthropic/v1/messages',
      model: 'MiniMax-M2.7',
    });

    const result = (provider as any).parseResponse({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      stop_reason: 'max_tokens',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    });

    assert.equal(result.content, 'hello world');
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(result.usage.totalTokens, 30);
    assert.equal((provider as any).maxTokens, 32768);
  });
});

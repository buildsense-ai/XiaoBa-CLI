import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { Message } from '../src/types';
import {
  buildSyntheticObservationMessages,
  SYNTHETIC_OBSERVATION_TOOL_NAME,
  withSyntheticObservationTiming,
} from '../src/core/synthetic-observation';

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
        __episodeId: 'episode:test',
        __episodeInputKind: 'root',
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
    assert.equal(JSON.stringify(transformed).includes('__episodeId'), false);
    assert.equal(JSON.stringify(transformed).includes('__episodeInputKind'), false);
    assert.equal(JSON.stringify(transformed).includes('runtimeObservationSource'), false);
    assert.equal(JSON.stringify(transformed).includes('must not leak'), false);
  });

  test('transforms synthetic runtime observations as adjacent tool_use and tool_result messages', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://example.test/v1/messages',
      model: 'claude-sonnet-4-20250514',
    });

    const syntheticPair = buildSyntheticObservationMessages([
      withSyntheticObservationTiming({
        id: 'late-memory',
        source: 'memory',
        status: 'completed',
        relevance: 'medium',
        summary: 'Prior dinner planning memory.',
        formattedContent: JSON.stringify({
          source: 'memory',
          summary: 'Prior dinner planning memory.',
          refs: ['catscompany/2026-06-16/demo.jsonl#7'],
        }),
      }, 'late_previous_turn'),
    ]);

    const transformed = (provider as any).transformMessages([
      { role: 'user', content: 'continue the dinner plan' },
      ...syntheticPair,
    ] as Message[]);

    const toolUseId = syntheticPair[0].tool_calls?.[0].id;
    assert.deepStrictEqual(transformed.messages[1], {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: SYNTHETIC_OBSERVATION_TOOL_NAME,
        input: {
          source: 'memory',
          status: 'completed',
          relevance: 'medium',
          timing: 'late_previous_turn',
        },
      }],
    });
    assert.deepStrictEqual(transformed.messages[2], {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: JSON.stringify({
          source: 'memory',
          summary: 'Prior dinner planning memory.',
          refs: ['catscompany/2026-06-16/demo.jsonl#7'],
          timing: 'late_previous_turn',
        }),
      }],
    });
  });

  test('coalesces adjacent user messages before Anthropic-compatible requests', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://example.test/v1/messages',
      model: 'claude-sonnet-4-20250514',
    });

    const transformed = (provider as any).transformMessages([
      { role: 'system', content: 'system' },
      { role: 'user', content: '[以下是之前 99 条对话的 AI 摘要]\n\nold context' },
      { role: 'user', content: '继续' },
    ] as Message[]);

    assert.equal(transformed.system, 'system');
    assert.deepStrictEqual(transformed.messages, [{
      role: 'user',
      content: '[以下是之前 99 条对话的 AI 摘要]\n\nold context\n\n继续',
    }]);
  });

  test('coalesces tool_result user turn with following user text while keeping tool_result first', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://example.test/v1/messages',
      model: 'claude-sonnet-4-20250514',
    });

    const transformed = (provider as any).transformMessages([
      { role: 'user', content: 'read notes' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"notes.md"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'read_file',
        content: 'file contents',
      },
      { role: 'user', content: '继续' },
    ] as Message[]);

    assert.equal(transformed.messages.length, 3);
    assert.deepStrictEqual(transformed.messages[2], {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'file contents',
        },
        { type: 'text', text: '继续' },
      ],
    });
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

  test('preserves MiniMax M3 thinking blocks for tool-use replay', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/anthropic/v1/messages',
      model: 'MiniMax-M3',
    });

    const result = (provider as any).parseResponse({
      content: [
        { type: 'thinking', thinking: 'hidden chain', signature: 'sig_123' },
        { type: 'tool_use', id: 'call_1', name: 'execute_shell', input: { command: 'git status' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    });

    assert.equal(result.content, null);
    assert.equal(result.toolCalls.length, 1);
    assert.deepStrictEqual(result.providerContent, [
      { type: 'thinking', thinking: 'hidden chain', signature: 'sig_123' },
      { type: 'tool_use', id: 'call_1', name: 'execute_shell', input: { command: 'git status' } },
    ]);
  });

  test('replays preserved thinking blocks before tool_use blocks', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/anthropic/v1/messages',
      model: 'MiniMax-M3',
    });

    const messages: Message[] = [
      { role: 'user', content: 'clean repo' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'execute_shell', arguments: '{"command":"git status"}' },
        }],
        providerContent: [
          { type: 'thinking', thinking: 'hidden chain', signature: 'sig_123' },
          { type: 'tool_use', id: 'call_1', name: 'execute_shell', input: { command: 'git status' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'execute_shell',
        content: 'clean',
      },
    ];

    const transformed = (provider as any).transformMessages(messages);
    assert.deepStrictEqual(transformed.messages[1], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden chain', signature: 'sig_123' },
        { type: 'tool_use', id: 'call_1', name: 'execute_shell', input: { command: 'git status' } },
      ],
    });
  });
});

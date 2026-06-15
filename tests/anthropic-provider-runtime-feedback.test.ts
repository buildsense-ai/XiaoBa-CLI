import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { Message } from '../src/types';
import {
  makeRunnerHint,
  TRANSIENT_RUNNER_HINT_PREFIX,
} from '../src/core/runner-orchestration-policy';
import { TRANSIENT_SUBAGENT_STATUS_PREFIX } from '../src/core/sub-agent-observation';
import { TRANSIENT_SKILLS_LIST_PREFIX } from '../src/skills/session-skill-runtime';

describe('AnthropicProvider runtime feedback boundary', () => {
  test('passes system runner hints through the Anthropic system prompt', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/anthropic/v1/messages',
      model: 'MiniMax-M3',
    });

    const messages: Message[] = [
      { role: 'system', content: 'stable system prompt' },
      makeRunnerHint(['runtime-only orchestration nudge']),
    ];

    const transformed = (provider as any).transformMessages(messages);

    assert.match(transformed.system, /stable system prompt/);
    assert.equal(transformed.system.includes(TRANSIENT_RUNNER_HINT_PREFIX), true);
    assert.equal(transformed.messages.length, 0);
    assert.equal(JSON.stringify(transformed).includes('__injected'), false);
  });

  test('keeps transient runtime status out of the Anthropic system prompt', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      apiUrl: 'https://relay.catsco.cc/anthropic/v1/messages',
      model: 'MiniMax-M3',
    });

    const transientMessages: Message[] = [
      {
        role: 'user',
        content: '[transient_plan_status]\n[in_progress] run targeted checks',
        __injected: true,
      },
      {
        role: 'user',
        content: `${TRANSIENT_SUBAGENT_STATUS_PREFIX}\nsub-agent still running`,
        __injected: true,
      },
      {
        role: 'user',
        content: `${TRANSIENT_SKILLS_LIST_PREFIX}\n- demo: Demo skill`,
        __injected: true,
      },
    ];
    const messages: Message[] = [
      { role: 'system', content: 'stable system prompt' },
      ...transientMessages,
      { role: 'user', content: 'latest user request' },
    ];

    const transformed = (provider as any).transformMessages(messages);

    assert.equal(transformed.system, 'stable system prompt');
    assert.equal(transformed.system.includes('[transient_'), false);
    assert.equal(transformed.messages.length, 4);
    assert.deepEqual(transformed.messages.map((message: any) => message.role), [
      'user',
      'user',
      'user',
      'user',
    ]);
    assert.equal(JSON.stringify(transformed).includes('__injected'), false);
  });

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

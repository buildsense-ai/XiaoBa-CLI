import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { Message } from '../src/types';

const RELAY_URL = 'https://relay.catsco.cc/anthropic';
const NATIVE_URL = 'https://api.anthropic.com/v1/messages';
const STABLE_SYSTEM = 'Stable policy.';

function createProvider(apiUrl = RELAY_URL): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    apiUrl,
    model: 'deepseek-v4-flash',
  });
}

function planStatus(text: string): Message {
  return {
    role: 'system',
    content: `[transient_plan_status]\n${text}`,
    __cacheScope: 'dynamic',
  };
}

// 模拟 TurnContextBuilder 的真实注入位置：瞬态块落在最后一条 user 消息之前。
function toolLoopMessages(plan: string, toolResult = 'tool ok'): Message[] {
  return [
    { role: 'system', content: STABLE_SYSTEM },
    planStatus(plan),
    { role: 'user', content: 'build the logo' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'write_file', content: toolResult },
  ];
}

describe('AnthropicProvider stable prefix cache on compatible endpoints', () => {
  test('keeps the system string byte-stable across turns when transient blocks change', () => {
    const provider = createProvider();
    const first = (provider as any).transformMessages(toolLoopMessages('step 1 in progress'));
    const second = (provider as any).transformMessages(toolLoopMessages('step 2 in progress'));

    assert.equal(first.system, STABLE_SYSTEM);
    assert.equal(second.system, STABLE_SYSTEM);
    assert.equal(JSON.stringify(first.system), JSON.stringify(second.system));
  });

  test('delivers transient system blocks as trailing user notes', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: STABLE_SYSTEM },
      planStatus('step 1 in progress'),
      { role: 'user', content: 'Latest query' },
    ] as Message[]);

    assert.equal(transformed.system, STABLE_SYSTEM);
    assert.deepEqual(transformed.messages, [{
      role: 'user',
      content: 'Latest query\n\n[transient_plan_status]\nstep 1 in progress',
    }]);
    assert.equal(transformed.messages.some((message: any) => message.role === 'system'), false);
  });

  test('keeps tool_result blocks first when transient notes merge after tool results', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages(toolLoopMessages('step 1'));

    const tail = transformed.messages[transformed.messages.length - 1];
    assert.equal(tail.role, 'user');
    assert.equal(tail.content[0].type, 'tool_result');
    assert.equal(tail.content[0].tool_use_id, 'call_1');
    assert.deepEqual(tail.content[1], {
      type: 'text',
      text: '[transient_plan_status]\nstep 1',
    });
  });

  test('preserves the relative order of multiple transient blocks', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: STABLE_SYSTEM },
      planStatus('one'),
      { role: 'system', content: '[transient_runner_hint]\nuse a subagent', __cacheScope: 'dynamic' },
      { role: 'user', content: 'go' },
    ] as Message[]);

    assert.equal(transformed.system, STABLE_SYSTEM);
    assert.deepEqual(transformed.messages, [{
      role: 'user',
      content: 'go\n\n[transient_plan_status]\none\n\n[transient_runner_hint]\nuse a subagent',
    }]);
  });

  test('relocates explicit dynamic scope blocks without a transient prefix', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: STABLE_SYSTEM },
      { role: 'system', content: 'Runtime snapshot', __cacheScope: 'dynamic' },
      { role: 'user', content: 'hi' },
    ] as Message[]);

    assert.equal(transformed.system, STABLE_SYSTEM);
    assert.deepEqual(transformed.messages, [{ role: 'user', content: 'hi\n\nRuntime snapshot' }]);
  });

  test('keeps explicitly stable blocks in the system string even with a transient-looking prefix', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: STABLE_SYSTEM },
      { role: 'system', content: '[transient_skills]\nstable skills list', __cacheScope: 'stable' },
      { role: 'user', content: 'hi' },
    ] as Message[]);

    assert.equal(transformed.system, `${STABLE_SYSTEM}\n\n[transient_skills]\nstable skills list`);
    assert.deepEqual(transformed.messages, [{ role: 'user', content: 'hi' }]);
  });

  test('keeps one-shot compaction boundaries in the system string', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: STABLE_SYSTEM },
      { role: 'system', content: '[compact_boundary] 12 messages summarized. Pre-compact tokens: 9000' },
      { role: 'user', content: 'hi' },
    ] as Message[]);

    assert.equal(
      transformed.system,
      `${STABLE_SYSTEM}\n\n[compact_boundary] 12 messages summarized. Pre-compact tokens: 9000`,
    );
    assert.deepEqual(transformed.messages, [{ role: 'user', content: 'hi' }]);
  });

  test('falls back to notes-only requests when no stable system block exists', () => {
    const provider = createProvider();
    const transformed = (provider as any).transformMessages([
      planStatus('only dynamic'),
      { role: 'user', content: 'hi' },
    ] as Message[]);

    assert.equal(transformed.system, undefined);
    assert.deepEqual(transformed.messages, [{
      role: 'user',
      content: 'hi\n\n[transient_plan_status]\nonly dynamic',
    }]);
  });

  test('keeps the native Anthropic two-block system behavior unchanged', () => {
    const provider = createProvider(NATIVE_URL);
    const transformed = (provider as any).transformMessages([
      { role: 'system', content: STABLE_SYSTEM },
      planStatus('step 1 in progress'),
      { role: 'user', content: 'Latest query' },
    ] as Message[]);

    assert.deepEqual(transformed.system, [
      { type: 'text', text: STABLE_SYSTEM, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '[transient_plan_status]\nstep 1 in progress' },
    ]);
    assert.deepEqual(transformed.messages, [{ role: 'user', content: 'Latest query' }]);
  });
});

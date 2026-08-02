import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../src/types';
import { planDeepSeekReasoningRecovery } from '../src/providers/deepseek-reasoning-recovery';
import { createProviderStateReference } from '../src/providers/provider-state';
import { resolveOpenAIReasoningReplayMode } from '../src/utils/reasoning-effort';

function rejection(message: string, status = 400): unknown {
  return { response: { status, data: { error: { message } } } };
}

function toolExchange(providerState?: Message['providerState']): Message[] {
  return [
    { role: 'user', content: 'find cats' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"cats"}' },
      }],
      ...(providerState ? {
        providerContent: [
          { type: 'openai_reasoning', reasoning_content: 'opaque chain' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'cats' } },
        ],
        providerState,
      } : {}),
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: 'cats found' },
    { role: 'user', content: 'continue' },
  ];
}

const v4Config = {
  provider: 'openai' as const,
  apiUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  openaiApiMode: 'chat_completions' as const,
};

test('DeepSeek replay defaults distinguish legacy reasoner from current thinking models', () => {
  assert.equal(resolveOpenAIReasoningReplayMode(v4Config), 'include');
  assert.equal(resolveOpenAIReasoningReplayMode({
    apiUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-reasoner',
  }), 'omit');
  assert.equal(resolveOpenAIReasoningReplayMode({
    apiUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
  }), undefined);
});

test('explicit rejection can switch a current DeepSeek request to omit replay', () => {
  const state = createProviderStateReference({
    apiType: 'openai-chat-completions',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-v4-flash',
  });
  const messages = toolExchange(state);
  const plan = planDeepSeekReasoningRecovery({
    error: rejection('Unknown field reasoning_content: parameter is not allowed'),
    config: v4Config,
    messages,
    currentMode: undefined,
  });

  assert.equal(plan?.action, 'reasoning_replay_omit');
  assert.equal(plan?.replayMode, 'omit');
  assert.equal(plan?.messages, messages);
});

test('legacy reasoner can switch to include replay when the endpoint explicitly requires it', () => {
  const config = { ...v4Config, model: 'deepseek-reasoner' };
  const state = createProviderStateReference({
    apiType: 'openai-chat-completions',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-reasoner',
  });
  const messages = toolExchange(state);
  const plan = planDeepSeekReasoningRecovery({
    error: rejection('reasoning_content must be passed back for thinking mode tool calls'),
    config,
    messages,
    currentMode: undefined,
  });

  assert.equal(plan?.action, 'reasoning_replay_include');
  assert.equal(plan?.replayMode, 'include');
  assert.equal(plan?.messages, messages);
});

test('missing opaque reasoning degrades only the affected historical tool exchange', () => {
  const messages = toolExchange();
  const plan = planDeepSeekReasoningRecovery({
    error: rejection('reasoning_content is required and was missing'),
    config: v4Config,
    messages,
    currentMode: undefined,
  });

  assert.equal(plan?.action, 'reasoning_history_degrade');
  assert.equal(plan?.degradedExchanges, 1);
  assert.deepEqual(plan?.messages.map(message => message.role), ['user', 'user', 'user']);
  assert.match(String(plan?.messages[1].content), /cats found/);
  assert.equal(plan?.messages.some(message => message.tool_calls?.length), false);
  assert.equal(plan?.messages.some(message => message.role === 'tool'), false);
});

test('bare rejections, unrelated providers, and non-request statuses never trigger repair', () => {
  for (const input of [
    { error: rejection('bad request'), config: v4Config },
    { error: rejection('reasoning_content is required', 503), config: v4Config },
    { error: rejection('reasoning_content is required'), config: { ...v4Config, model: 'gpt-test', apiUrl: 'https://api.openai.com/v1' } },
    { error: rejection('reasoning_content is required'), config: { ...v4Config, provider: 'anthropic' as const } },
  ]) {
    assert.equal(planDeepSeekReasoningRecovery({
      ...input,
      messages: toolExchange(),
      currentMode: undefined,
    }), undefined);
  }
});

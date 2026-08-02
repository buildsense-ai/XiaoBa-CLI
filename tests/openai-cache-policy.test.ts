import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOpenAICachePlan,
  supportsOpenAIExplicitPromptCaching,
} from '../src/providers/openai-cache-policy';
import type { Message } from '../src/types';

const longStable: Message = {
  role: 'system',
  content: 'Stable reusable policy, examples, and tool instructions. '.repeat(140),
};

test('OpenAI cache policy gates provider-only fields by endpoint and model capability', () => {
  const messages: Message[] = [longStable, { role: 'user', content: 'hello' }];
  const compatible = resolveOpenAICachePlan({
    apiUrl: 'https://relay.example.test/v1/responses',
    model: 'gpt-5.6-sol',
    apiType: 'openai-responses',
    messages,
    tools: [],
  });
  const olderOfficial = resolveOpenAICachePlan({
    apiUrl: 'https://api.openai.com/v1/responses',
    model: 'gpt-5.5',
    apiType: 'openai-responses',
    messages,
    tools: [],
  });
  const explicitOfficial = resolveOpenAICachePlan({
    apiUrl: 'https://api.openai.com/v1/responses',
    model: 'gpt-5.6-sol',
    apiType: 'openai-responses',
    messages,
    tools: [],
  });

  assert.equal(compatible.strategy, 'openai-compatible-automatic-prefix');
  assert.equal(compatible.promptCacheKey, undefined);
  assert.equal(compatible.explicitBreakpoints, 0);
  assert.equal(olderOfficial.strategy, 'openai-prompt-cache-key');
  assert.match(olderOfficial.promptCacheKey || '', /^catsco-v3-rsp-/);
  assert.equal(olderOfficial.explicitBreakpoints, 0);
  assert.equal(explicitOfficial.strategy, 'openai-explicit-stable-prefix');
  assert.equal(explicitOfficial.explicitBreakpoints, 1);
  assert.equal(supportsOpenAIExplicitPromptCaching('gpt-5.6-luna-preview'), true);
  assert.equal(supportsOpenAIExplicitPromptCaching('gpt-6'), true);
  assert.equal(supportsOpenAIExplicitPromptCaching('gpt-5.5'), false);
});

test('cache routing identity ignores dynamic context and uses a stable partition shard', () => {
  const build = (dynamic: string, partitionKey: string, stable = longStable) => resolveOpenAICachePlan({
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5.6-terra',
    apiType: 'openai-chat-completions',
    messages: [
      stable,
      { role: 'system', content: dynamic, __cacheScope: 'dynamic' },
      { role: 'user', content: 'hello' },
    ],
    tools: [],
    partitionKey,
  });
  const first = build('[transient_plan_status]\none', 'session-a');
  const second = build('[transient_plan_status]\ntwo', 'session-a');
  const changedStable = build(
    '[transient_plan_status]\ntwo',
    'session-a',
    { role: 'system', content: `${String(longStable.content)} changed` },
  );

  assert.equal(first.promptCacheKey, second.promptCacheKey);
  assert.notEqual(first.promptCacheKey, changedStable.promptCacheKey);
  assert.equal(first.chatBreakpointMessageIndex, 0);
  assert.match(first.promptCacheKey || '', /^catsco-v3-chat-[a-f0-9]{36}-s[0-9a-f]{2}$/);
});

test('Chat cache policy never places a breakpoint after a dynamic leading system message', () => {
  const plan = resolveOpenAICachePlan({
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5.6-sol',
    apiType: 'openai-chat-completions',
    messages: [
      { role: 'system', content: '[transient_runtime_context]\nchanging', __cacheScope: 'dynamic' },
      longStable,
      { role: 'user', content: 'hello' },
    ],
    tools: [],
  });

  assert.equal(plan.explicitBreakpoints, 0);
  assert.equal(plan.chatBreakpointMessageIndex, undefined);
});

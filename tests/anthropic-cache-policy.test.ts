import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCanonicalAnthropicEndpoint,
  resolveAnthropicCachePlan,
} from '../src/providers/anthropic-cache-policy';
import type { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

const tools: ToolDefinition[] = [
  {
    name: 'zeta',
    description: 'last alphabetically',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
  },
  {
    name: 'alpha',
    description: 'first alphabetically',
    parameters: { type: 'object', properties: {} },
  },
];

test('Anthropic cache policy separates stable system content from a dynamic suffix', () => {
  const messages: Message[] = [
    { role: 'system', content: 'Stable policy.' },
    { role: 'system', content: '[transient_plan_status]\nrunning', __cacheScope: 'dynamic' },
    { role: 'user', content: 'hello' },
  ];
  const plan = resolveAnthropicCachePlan({
    apiUrl: 'https://api.anthropic.com/v1/messages',
    messages,
    tools,
  });

  assert.equal(plan.strategy, 'anthropic-explicit-stable-prefix');
  assert.equal(plan.stableSystemEnd, 1);
  assert.equal(plan.stableSystemMessages, 1);
  assert.equal(plan.toolBreakpointIndex, 1);
  assert.equal(plan.explicitBreakpoints, 3);
  assert.equal(plan.conversationBreakpoint, true);
  assert.ok(plan.stablePrefixEstimatedTokens > 0);
});

test('Anthropic-compatible endpoints remain marker-free until capability is proven', () => {
  const plan = resolveAnthropicCachePlan({
    apiUrl: 'https://relay.catsco.cc/anthropic',
    messages: [{ role: 'system', content: 'Stable policy.' }],
    tools,
  });

  assert.equal(plan.strategy, 'anthropic-compatible-no-markers');
  assert.equal(plan.explicitBreakpoints, 0);
  assert.equal(plan.toolBreakpointIndex, undefined);
  assert.equal(plan.conversationBreakpoint, false);
});

test('Anthropic cache policy does not claim a conversation marker when the wire input ends with an assistant', () => {
  const plan = resolveAnthropicCachePlan({
    apiUrl: 'https://api.anthropic.com/v1/messages',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ],
    tools: [],
  });

  assert.equal(plan.conversationBreakpoint, false);
  assert.equal(plan.explicitBreakpoints, 0);
});

test('canonical Anthropic endpoint detection rejects relay-like URL variations', () => {
  assert.equal(isCanonicalAnthropicEndpoint('https://api.anthropic.com'), true);
  assert.equal(isCanonicalAnthropicEndpoint('https://api.anthropic.com/v1/messages//'), true);
  assert.equal(isCanonicalAnthropicEndpoint('https://api.anthropic.com/v1/messages?relay=1'), false);
  assert.equal(isCanonicalAnthropicEndpoint('https://user@api.anthropic.com/v1/messages'), false);
  assert.equal(isCanonicalAnthropicEndpoint('https://relay.catsco.cc/anthropic'), false);
});

test('one-off internal calls bypass every Anthropic cache marker', () => {
  const plan = resolveAnthropicCachePlan({
    apiUrl: 'https://api.anthropic.com/v1/messages',
    messages: [
      { role: 'system', content: 'Stable policy.' },
      { role: 'user', content: 'summarize once' },
    ],
    tools,
    cacheMode: 'bypass',
  });

  assert.equal(plan.strategy, 'anthropic-cache-bypassed');
  assert.equal(plan.explicitBreakpoints, 0);
  assert.equal(plan.toolBreakpointIndex, undefined);
  assert.equal(plan.conversationBreakpoint, false);
  assert.equal(plan.stablePrefixEstimatedTokens, 0);
});

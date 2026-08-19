import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptCacheScopeKey, PROMPT_CACHE_SHARD_COUNT } from '../src/providers/prompt-cache-scope';

test('prompt cache scope is stable for an employee and bounded by user shards', () => {
  const first = buildPromptCacheScopeKey('session:one', {
    agentId: 'employee-42',
    actorUserId: 'user-a',
  });
  const same = buildPromptCacheScopeKey('session:two', {
    agentId: 'employee-42',
    actorUserId: 'user-a',
  });
  assert.equal(first, same);
  assert.match(first, /^employee:[a-f0-9]{16}:shard:[0-7]$/);
  assert.equal(PROMPT_CACHE_SHARD_COUNT, 8);
});

test('different employees do not share a prompt cache scope', () => {
  const first = buildPromptCacheScopeKey('session:one', { agentId: 'employee-42', actorUserId: 'user-a' });
  const second = buildPromptCacheScopeKey('session:two', { agentId: 'employee-43', actorUserId: 'user-a' });
  assert.notEqual(first, second);
});

test('legacy sessions remain isolated when no employee identity exists', () => {
  const first = buildPromptCacheScopeKey('session:one');
  const second = buildPromptCacheScopeKey('session:two');
  assert.notEqual(first, second);
  assert.match(first, /^session:[a-f0-9]{16}$/);
});

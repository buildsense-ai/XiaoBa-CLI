import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCanaryEvidence } from '../scripts/deepseek-reasoning-canary.mjs';

test('DeepSeek reasoning canary evidence omits prompt, response, and compatible endpoint content', () => {
  const first = {
    content: 'secret first response',
    stopReason: 'tool_calls',
    toolCalls: [{ id: 'call_1' }],
    providerContent: [
      { type: 'openai_reasoning', reasoning_content: 'secret reasoning' },
      { type: 'tool_use', id: 'call_1' },
    ],
  };
  const second = {
    content: 'secret final response',
    stopReason: 'stop',
    usage: { promptTokens: 100, cachedReadTokens: 80, completionTokens: 3 },
  };
  const evidence = buildCanaryEvidence({
    apiBase: 'https://relay.secret.example/v1',
    model: 'deepseek-test',
    first,
    second,
    recordedAt: new Date('2026-08-02T00:00:00.000Z'),
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.verdict, 'passed');
  assert.equal(evidence.first.has_reasoning, true);
  assert.equal(evidence.second?.usage.cache_read_tokens, 80);
  assert.equal(evidence.api_origin, null);
  assert.equal(serialized.includes('secret first response'), false);
  assert.equal(serialized.includes('secret reasoning'), false);
  assert.equal(serialized.includes('relay.secret.example'), false);
});

test('DeepSeek reasoning canary preserves missing cache usage versus explicit zero', () => {
  const base = {
    apiBase: 'https://api.deepseek.com',
    model: 'deepseek-test',
    first: { toolCalls: [{ id: 'call_1' }] },
    recordedAt: new Date('2026-08-02T00:00:00.000Z'),
  };
  const missing = buildCanaryEvidence({
    ...base,
    second: { usage: { promptTokens: 100, completionTokens: 3 } },
  });
  const explicitZero = buildCanaryEvidence({
    ...base,
    second: { usage: { promptTokens: 100, cachedReadTokens: 0, completionTokens: 3 } },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(missing.second?.usage, 'cache_read_tokens'), false);
  assert.equal(explicitZero.second?.usage.cache_read_tokens, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(explicitZero.second?.usage, 'cache_read_tokens'), true);
});

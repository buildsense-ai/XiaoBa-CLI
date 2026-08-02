import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttemptUsage,
  buildCapabilityProbeText,
  buildCanaryEvidence,
  evaluateCanaryAttempts,
  sha256,
} from '../scripts/provider-cache-canary.mjs';

describe('OpenAI-compatible provider cache canary evidence', () => {
  test('builds the minimum stable prefix without exposing it in evidence', () => {
    const source = 'stable secret prompt';
    const stable = buildCapabilityProbeText(source, 100);
    const evidence = buildCanaryEvidence({
      apiBase: 'https://api.deepseek.com/v1',
      model: 'deepseek-test',
      apiMode: 'chat_completions',
      sourceText: source,
      stableText: stable,
      attempts: [],
      recordedAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(evidence);

    assert.equal(stable.length >= 100, true);
    assert.equal(evidence.api_kind, 'canonical-deepseek');
    assert.equal(evidence.source_system_sha256, sha256(source));
    assert.equal(evidence.stable_system_sha256, sha256(stable));
    assert.equal(serialized.includes(source), false);
    assert.equal(serialized.includes(stable), false);
  });

  test('passes only when a request after the seed reads cached tokens', () => {
    const attempt = (input: number, read: number) => ({
      usage: { input_tokens: input, cache_read_tokens: read },
    });

    assert.equal(evaluateCanaryAttempts([attempt(100, 0), attempt(100, 80)]), 'passed');
    assert.equal(evaluateCanaryAttempts([attempt(100, 0), attempt(100, 0)]), 'failed_no_reuse');
    assert.equal(evaluateCanaryAttempts([attempt(100, 0), attempt(100, 101)]), 'unobservable_usage');
    assert.equal(evaluateCanaryAttempts([attempt(0, 0), attempt(100, 80)]), 'unobservable_usage');
    assert.equal(evaluateCanaryAttempts([
      attempt(100, 0),
      { usage: { input_tokens: 100 } },
    ]), 'unobservable_usage');
    assert.equal(evaluateCanaryAttempts([]), 'unsupported_usage');
  });

  test('preserves missing cache fields separately from explicit zero', () => {
    assert.deepEqual(buildAttemptUsage({
      promptTokens: 100,
      completionTokens: 1,
    }), {
      input_tokens: 100,
      output_tokens: 1,
    });
    assert.deepEqual(buildAttemptUsage({
      promptTokens: 100,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      completionTokens: 1,
    }), {
      input_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 1,
    });
  });

  test('redacts compatible endpoint origins', () => {
    const evidence = buildCanaryEvidence({
      apiBase: 'https://relay.secret.example/v1',
      model: 'relay-model',
      apiMode: 'responses',
      sourceText: 'source',
      stableText: 'stable',
      attempts: [],
      recordedAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(evidence);

    assert.equal(evidence.api_kind, 'openai-compatible');
    assert.equal(evidence.api_origin, null);
    assert.equal(serialized.includes('relay.secret.example'), false);
  });
});

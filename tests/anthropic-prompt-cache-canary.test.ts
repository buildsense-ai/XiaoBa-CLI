import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttemptEvidence,
  buildCapabilityProbeText,
  buildCanaryEvidence,
  buildCanarySystem,
  evaluateCanaryAttempts,
  sha256,
} from '../scripts/anthropic-prompt-cache-canary.mjs';

describe('Anthropic prompt-cache canary evidence', () => {
  test('builds a stable cached prefix followed by an uncached dynamic suffix', () => {
    const system = buildCanarySystem('stable secret prompt', 'dynamic secret state');

    assert.deepEqual(system, [
      {
        type: 'text',
        text: 'stable secret prompt',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: 'dynamic secret state',
      },
    ]);
  });

  test('records required evidence without prompt bodies', () => {
    const sourceText = 'stable secret prompt';
    const stableText = buildCapabilityProbeText(sourceText, 100);
    const dynamicText = 'dynamic secret state';
    const response = {
      url: 'https://api.anthropic.com/v1/messages?beta=prompt_caching',
      headers: new Headers({ 'request-id': 'req_123' }),
    } as Response;
    const message = {
      id: 'msg_123',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 1,
      },
    };
    const attempt = buildAttemptEvidence({ response, message, dynamicText });
    const evidence = buildCanaryEvidence({
      model: 'claude-test',
      sourceText,
      stableText,
      attempts: [attempt],
      recordedAt: new Date('2026-07-30T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(evidence);

    assert.equal(evidence.source_system_sha256, sha256(sourceText));
    assert.equal(evidence.stable_system_sha256, sha256(stableText));
    assert.equal(evidence.stable_system_chars >= 100, true);
    assert.equal(evidence.api_kind, 'canonical-anthropic');
    assert.equal(evidence.verdict, 'inconclusive_prior_entry');
    assert.equal(attempt.dynamic_system_sha256, sha256(dynamicText));
    assert.equal(attempt.request_id, 'req_123');
    assert.equal(attempt.api_path, '/v1/messages');
    assert.equal(serialized.includes('prompt_caching'), false);
    assert.deepEqual(attempt.usage, {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 1,
    });
    assert.equal(serialized.includes(stableText), false);
    assert.equal(serialized.includes(dynamicText), false);
  });

  test('requires a cache read on the second request for a passing verdict', () => {
    const attempt = (write: number, read: number, input: number = 100) => ({
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
      },
    });

    assert.equal(evaluateCanaryAttempts([attempt(5000, 0), attempt(0, 5000)]), 'passed');
    assert.equal(evaluateCanaryAttempts([attempt(5000, 0), attempt(5000, 0)]), 'failed_no_reuse');
    assert.equal(evaluateCanaryAttempts([attempt(0, 0, 1), attempt(0, 0, 1)]), 'unsupported_or_below_threshold');
    assert.equal(evaluateCanaryAttempts([
      attempt(5000, 0),
      { usage: { input_tokens: 100, cache_creation_input_tokens: 0 } },
    ]), 'unobservable_usage');
    assert.equal(evaluateCanaryAttempts([
      attempt(5000, 0),
      { usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 } },
    ]), 'unobservable_usage');
  });

  test('omits missing usage fields instead of recording them as zero', () => {
    const attempt = buildAttemptEvidence({
      response: {
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
      } as Response,
      message: { id: 'msg_missing', usage: { input_tokens: 10, output_tokens: 1 } },
      dynamicText: 'dynamic',
    });

    assert.deepEqual(attempt.usage, { input_tokens: 10, output_tokens: 1 });
    assert.equal(Object.prototype.hasOwnProperty.call(attempt.usage, 'cache_read_input_tokens'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(attempt.usage, 'cache_creation_input_tokens'), false);
  });

  test('redacts compatible endpoint origins from evidence', () => {
    const evidence = buildCanaryEvidence({
      model: 'claude-test',
      apiBase: 'https://relay.secret.example/anthropic',
      sourceText: 'source',
      stableText: 'stable',
      attempts: [],
      recordedAt: new Date('2026-07-30T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(evidence);

    assert.equal(evidence.api_kind, 'anthropic-compatible');
    assert.equal(evidence.api_origin, null);
    assert.equal(serialized.includes('relay.secret.example'), false);
  });
});

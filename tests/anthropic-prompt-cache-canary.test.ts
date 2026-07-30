import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttemptEvidence,
  buildCanaryEvidence,
  buildCanarySystem,
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
    const stableText = 'stable secret prompt';
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
      stableText,
      attempts: [attempt],
      recordedAt: new Date('2026-07-30T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(evidence);

    assert.equal(evidence.stable_system_sha256, sha256(stableText));
    assert.equal(attempt.dynamic_system_sha256, sha256(dynamicText));
    assert.equal(attempt.request_id, 'req_123');
    assert.equal(attempt.api_path, '/v1/messages?beta=prompt_caching');
    assert.deepEqual(attempt.usage, {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 1,
    });
    assert.equal(serialized.includes(stableText), false);
    assert.equal(serialized.includes(dynamicText), false);
  });
});

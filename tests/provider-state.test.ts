import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderStateReference,
  isProviderStateCompatible,
} from '../src/providers/provider-state';

test('provider replay state is scoped to API type, model, and endpoint identity', () => {
  const baseline = createProviderStateReference({
    apiType: 'openai-responses',
    endpoint: 'https://API.OpenAI.com/v1/responses#ignored',
    model: 'gpt-test',
  });
  const equivalent = createProviderStateReference({
    apiType: 'openai-responses',
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'gpt-test',
  });

  assert.equal(isProviderStateCompatible(baseline, equivalent), true);
  assert.equal(isProviderStateCompatible(undefined, equivalent), false);
  assert.equal(isProviderStateCompatible({ ...baseline, model: 'gpt-other' }, equivalent), false);
  assert.equal(isProviderStateCompatible({ ...baseline, apiType: 'openai-chat-completions' }, equivalent), false);
  assert.match(baseline.endpointFingerprint, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(baseline), /api\.openai\.com/i);
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  DEEPSEEK_RESPONSES_PROFILE,
  applyDeepSeekResponsesRequestPolicy,
  isDeepSeekResponses,
  normalizeDeepSeekReasoningEffort,
  sanitizeDeepSeekResponsesReplayItem,
} from '../src/providers/deepseek/responses-policy';
import { DEEPSEEK_RELAY_MODEL_PROFILE } from '../src/providers/deepseek/catalog-profile';

describe('DeepSeek Responses policy', () => {
  test('keeps one stable public model boundary', () => {
    assert.equal(DEEPSEEK_RESPONSES_PROFILE.publicModelId, 'deepseek-v4-flash');
    assert.equal(isDeepSeekResponses('responses', 'deepseek-v4-flash'), true);
    assert.equal(isDeepSeekResponses('chat_completions', 'deepseek-v4-flash'), false);
    assert.equal(isDeepSeekResponses('responses', 'gpt-5.6-terra'), false);
    assert.equal(DEEPSEEK_RELAY_MODEL_PROFILE.id, DEEPSEEK_RESPONSES_PROFILE.publicModelId);
    assert.equal(DEEPSEEK_RELAY_MODEL_PROFILE.preferredProvider, 'openai');
    assert.equal(DEEPSEEK_RELAY_MODEL_PROFILE.openaiApiMode, 'responses');
  });

  test('owns DeepSeek reasoning values', () => {
    assert.equal(normalizeDeepSeekReasoningEffort('disabled'), 'none');
    assert.equal(normalizeDeepSeekReasoningEffort('low'), 'low');
    assert.equal(normalizeDeepSeekReasoningEffort('high'), 'high');
    assert.equal(normalizeDeepSeekReasoningEffort('max'), 'max');
    assert.equal(normalizeDeepSeekReasoningEffort('default'), undefined);
  });

  test('removes OpenAI-only state and normalizes tool choice', () => {
    const body: any = {
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'cache',
      tools: [{ type: 'function', name: 'lookup' }],
      tool_choice: 'required',
    };
    applyDeepSeekResponsesRequestPolicy(body, 'max');
    assert.deepEqual(body.reasoning, { effort: 'max' });
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.store, undefined);
    assert.equal(body.include, undefined);
    assert.equal(body.prompt_cache_key, undefined);
  });

  test('replays plaintext reasoning without encrypted state', () => {
    const replay = sanitizeDeepSeekResponsesReplayItem({
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'continuation' }],
      encrypted_content: 'secret',
      summary: [{ text: 'summary' }],
    });
    assert.equal(replay?.content[0].text, 'continuation');
    assert.equal(replay?.encrypted_content, undefined);
    assert.equal(replay?.summary, undefined);
    assert.equal(sanitizeDeepSeekResponsesReplayItem({
      type: 'reasoning', encrypted_content: 'secret',
    }), undefined);
  });
});

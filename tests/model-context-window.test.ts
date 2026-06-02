import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS,
  calculatePromptBudgetTokens,
  calculateSummaryBudgetTokens,
  resolveModelContextWindow,
} from '../src/utils/model-context-window';

test('relay MiniMax M3 uses a 1M official window with output and estimator reserve', () => {
  const resolved = resolveModelContextWindow({
    apiUrl: 'https://relay.catsco.cc/anthropic',
    model: 'MiniMax-M3',
    provider: 'anthropic',
  }, { CATSCO_MODEL_SOURCE: 'relay' } as NodeJS.ProcessEnv);

  assert.equal(resolved.contextWindowTokens, 1_000_000);
  assert.equal(resolved.maxOutputTokens, 32_768);
  assert.equal(resolved.promptBudgetTokens + resolved.safetyReserveTokens, 1_000_000);
  assert.equal(resolved.summaryBudgetTokens, 300_000);
  assert.ok(resolved.safetyReserveTokens > resolved.maxOutputTokens, 'reserve must include output tokens and protocol margin');
  assert.ok(resolved.promptBudgetTokens < resolved.contextWindowTokens, 'runtime budget must stay below the official window');
});

test('relay catalog models resolve to their official context windows', () => {
  assert.equal(resolveModelContextWindow({
    apiUrl: 'https://relay.catsco.cc/anthropic',
    model: 'MiniMax-M2.7',
    provider: 'anthropic',
  }, { CATSCO_MODEL_SOURCE: 'relay' } as NodeJS.ProcessEnv).contextWindowTokens, 204_800);

  assert.equal(resolveModelContextWindow({
    apiUrl: 'https://relay.catsco.cc/anthropic',
    model: 'deepseek-v4-flash',
    provider: 'anthropic',
  }, { CATSCO_MODEL_SOURCE: 'relay' } as NodeJS.ProcessEnv).contextWindowTokens, 1_000_000);

  assert.equal(resolveModelContextWindow({
    apiUrl: 'https://relay.catsco.cc/anthropic',
    model: 'glm-5.1',
    provider: 'anthropic',
  }, { CATSCO_MODEL_SOURCE: 'relay' } as NodeJS.ProcessEnv).contextWindowTokens, 200_000);
});

test('custom models keep the safe default even if the model name resembles a known relay model', () => {
  const resolved = resolveModelContextWindow({
    apiUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M3',
    provider: 'anthropic',
  }, { CATSCO_MODEL_SOURCE: 'custom' } as NodeJS.ProcessEnv);

  assert.equal(resolved.source, 'custom');
  assert.equal(resolved.contextWindowTokens, CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS);
  assert.equal(resolved.summaryBudgetTokens, 50_000);
  assert.ok(resolved.promptBudgetTokens < CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW_TOKENS);
});

test('explicit context window override still keeps a safety reserve', () => {
  const resolved = resolveModelContextWindow({
    apiUrl: 'https://custom.example.test/anthropic',
    model: 'custom-long-context',
    provider: 'anthropic',
  }, {
    CATSCO_MODEL_SOURCE: 'custom',
    GAUZ_LLM_CONTEXT_WINDOW_TOKENS: '256000',
  } as NodeJS.ProcessEnv);
  const expected = calculatePromptBudgetTokens(256_000, resolved.maxOutputTokens);

  assert.equal(resolved.source, 'explicit');
  assert.equal(resolved.contextWindowTokens, 256_000);
  assert.equal(resolved.promptBudgetTokens, expected.promptBudgetTokens);
  assert.equal(resolved.safetyReserveTokens, expected.safetyReserveTokens);
});

test('tiny explicit context windows never produce a prompt budget beyond the window', () => {
  const resolved = resolveModelContextWindow({
    apiUrl: 'https://custom.example.test/anthropic',
    model: 'tiny-window',
    provider: 'anthropic',
  }, {
    CATSCO_MODEL_SOURCE: 'custom',
    GAUZ_LLM_CONTEXT_WINDOW_TOKENS: '1024',
  } as NodeJS.ProcessEnv);

  assert.equal(resolved.contextWindowTokens, 1024);
  assert.equal(resolved.promptBudgetTokens + resolved.safetyReserveTokens, 1024);
  assert.equal(resolved.promptBudgetTokens, 1);
  assert.equal(resolved.promptBudgetTokens + resolved.maxOutputTokens <= resolved.contextWindowTokens, true);
  assert.equal(resolved.summaryBudgetTokens, 1);
});

test('summary content budget reserves room for summary wrapper on small prompt budgets', () => {
  const promptBudget = 30_000;
  const summaryBudget = calculateSummaryBudgetTokens(promptBudget);

  assert.ok(summaryBudget > 0);
  assert.ok(summaryBudget < promptBudget);
});

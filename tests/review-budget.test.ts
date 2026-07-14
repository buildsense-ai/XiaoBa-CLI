import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewBudget } from '../src/utils/review-budget';

describe('review budget', () => {
  test('bounds hundreds of candidates and conservatively accounts serialized input', () => {
    let now = 0;
    const budget = createReviewBudget({
      maxCandidates: 7,
      maxPromptTokens: 10_000,
      deadlineMs: 1_000,
      now: () => now,
    });
    for (let index = 0; index < 500; index++) {
      budget.admit({ episode: index, evidence: 'bounded evidence' });
    }
    assert.equal(budget.candidates, 7);
    assert.ok(budget.estimatedPromptTokens > 0);
  });

  test('leaves remaining work resumable after the shared deadline', () => {
    let now = 0;
    const budget = createReviewBudget({
      maxCandidates: 100,
      maxPromptTokens: 100_000,
      deadlineMs: 10,
      now: () => now,
    });
    assert.equal(budget.admit({ episode: 1 }), true);
    now = 10;
    assert.equal(budget.admit({ episode: 2 }), false);
    assert.equal(budget.candidates, 1);
  });
});

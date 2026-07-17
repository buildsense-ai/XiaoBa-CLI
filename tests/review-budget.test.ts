import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewBudget } from '../src/utils/review-budget';

describe('review budget', () => {
  test('admits by candidate capacity and deadline, not estimated prompt size', () => {
    let now = 0;
    const budget = createReviewBudget({
      maxCandidates: 7,
      maxPromptTokens: 0,
      deadlineMs: 1_000,
      now: () => now,
    });
    const large = { evidence: 'x'.repeat(20_000) };
    for (let index = 0; index < 500; index++) {
      budget.admit({ episode: index, ...large });
    }
    assert.equal(budget.candidates, 7);
    assert.equal(budget.canStart(large), false);
  });

  test('leaves remaining work resumable after the shared deadline', () => {
    let now = 0;
    const budget = createReviewBudget({
      maxCandidates: 100,
      deadlineMs: 10,
      now: () => now,
    });
    assert.equal(budget.admit({ episode: 1 }), true);
    now = 10;
    assert.equal(budget.admit({ episode: 2 }), false);
    assert.equal(budget.candidates, 1);
  });

  test('ignores obsolete maxPromptTokens even for ~19KB evidence payloads', () => {
    const payload = { evidence: 'y'.repeat(19_000) };
    const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    assert.ok(serializedBytes >= 19_000);
    // Old estimator: bytes * 16 > default 200_000 wake budget for ~19KB.
    assert.ok(serializedBytes * 16 > 200_000);

    const budget = createReviewBudget({
      maxCandidates: 1,
      maxPromptTokens: 200_000,
      deadlineMs: 1_000,
      now: () => 0,
    });
    assert.equal(budget.admit(payload), true);
    assert.equal(budget.candidates, 1);
  });
});

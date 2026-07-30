import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/utils/metrics';

describe('Metrics cached token aggregation', () => {
  test('aggregates cached reads and writes and computes the read ratio', () => {
    Metrics.reset();
    try {
      Metrics.recordAICall('gpt-test', {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedReadTokens: 40,
        cachedWriteTokens: 10,
      });
      Metrics.recordAICall('gpt-test', {
        promptTokens: 50,
        completionTokens: 5,
        totalTokens: 55,
        cachedReadTokens: 20,
        cachedWriteTokens: 5,
      });

      const summary = Metrics.getSummary();
      assert.equal(summary.totalCachedReadTokens, 60);
      assert.equal(summary.totalCachedWriteTokens, 15);
      assert.equal(summary.cacheReadRatio, 0.4);
    } finally {
      Metrics.reset();
    }
  });

  test('treats missing cached fields as zero', () => {
    Metrics.reset();
    try {
      Metrics.recordAICall('gpt-test', {
        promptTokens: 25,
        completionTokens: 5,
        totalTokens: 30,
      });

      const summary = Metrics.getSummary();
      assert.equal(summary.totalCachedReadTokens, 0);
      assert.equal(summary.totalCachedWriteTokens, 0);
      assert.equal(summary.cacheReadRatio, 0);
    } finally {
      Metrics.reset();
    }
  });

  test('reset clears cached totals and omits ratio for a zero denominator', () => {
    Metrics.reset();
    Metrics.recordAICall('gpt-test', {
      promptTokens: 10,
      completionTokens: 1,
      totalTokens: 11,
      cachedReadTokens: 8,
      cachedWriteTokens: 2,
    });

    Metrics.reset();
    const summary = Metrics.getSummary();
    assert.equal(summary.aiCalls, 0);
    assert.equal(summary.totalCachedReadTokens, 0);
    assert.equal(summary.totalCachedWriteTokens, 0);
    assert.equal(summary.cacheReadRatio, undefined);
  });
});

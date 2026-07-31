import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/utils/metrics';

describe('Metrics cached token aggregation', () => {
  test('keeps concurrent session metrics isolated', () => {
    const first = new Metrics();
    const second = new Metrics();

    first.recordAICall('first-model', {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedReadTokens: 60,
    });
    second.recordAICall('second-model', {
      promptTokens: 25,
      completionTokens: 5,
      totalTokens: 30,
      cachedReadTokens: 5,
    });
    second.reset();

    assert.equal(first.getSummary().aiCalls, 1);
    assert.equal(first.getSummary().totalPromptTokens, 100);
    assert.equal(first.getSummary().totalCachedReadTokens, 60);
    assert.equal(second.getSummary().aiCalls, 0);
  });

  test('aggregates cached reads and writes and computes the read ratio', () => {
    const metrics = new Metrics();
    try {
      metrics.recordAICall('gpt-test', {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedReadTokens: 40,
        cachedWriteTokens: 10,
      });
      metrics.recordAICall('gpt-test', {
        promptTokens: 50,
        completionTokens: 5,
        totalTokens: 55,
        cachedReadTokens: 20,
        cachedWriteTokens: 5,
      });

      const summary = metrics.getSummary();
      assert.equal(summary.totalCachedReadTokens, 60);
      assert.equal(summary.totalCachedWriteTokens, 15);
      assert.equal(summary.cacheReadRatio, 0.4);
    } finally {
      metrics.reset();
    }
  });

  test('treats missing cached fields as zero', () => {
    const metrics = new Metrics();
    try {
      metrics.recordAICall('gpt-test', {
        promptTokens: 25,
        completionTokens: 5,
        totalTokens: 30,
      });

      const summary = metrics.getSummary();
      assert.equal(summary.totalCachedReadTokens, 0);
      assert.equal(summary.totalCachedWriteTokens, 0);
      assert.equal(summary.cacheReadRatio, 0);
    } finally {
      metrics.reset();
    }
  });

  test('reset clears cached totals and omits ratio for a zero denominator', () => {
    const metrics = new Metrics();
    metrics.recordAICall('gpt-test', {
      promptTokens: 10,
      completionTokens: 1,
      totalTokens: 11,
      cachedReadTokens: 8,
      cachedWriteTokens: 2,
    });

    metrics.reset();
    const summary = metrics.getSummary();
    assert.equal(summary.aiCalls, 0);
    assert.equal(summary.totalCachedReadTokens, 0);
    assert.equal(summary.totalCachedWriteTokens, 0);
    assert.equal(summary.cacheReadRatio, undefined);
  });
});

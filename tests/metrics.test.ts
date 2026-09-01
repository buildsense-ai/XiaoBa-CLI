import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics, MetricsCollector } from '../src/utils/metrics';

const ai = (promptTokens: number, completionTokens: number, cachedReadTokens = 0, cachedWriteTokens = 0) => ({
  promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedReadTokens, cachedWriteTokens,
});

describe('Metrics cached token aggregation', () => {
  test('aggregates cached reads and writes and computes the read ratio', () => {
    Metrics.reset();
    try {
      Metrics.recordAICall('gpt-test', ai(100, 20, 40, 10));
      Metrics.recordAICall('gpt-test', ai(50, 5, 20, 5));
      const summary = Metrics.getSummary();
      assert.equal(summary.totalCachedReadTokens, 60);
      assert.equal(summary.totalCachedWriteTokens, 15);
      assert.equal(summary.cacheReadRatio, 0.4);
    } finally { Metrics.reset(); }
  });

  test('treats missing cached fields as zero', () => {
    Metrics.reset();
    try {
      Metrics.recordAICall('gpt-test', { promptTokens: 25, completionTokens: 5, totalTokens: 30 });
      const summary = Metrics.getSummary();
      assert.equal(summary.totalCachedReadTokens, 0);
      assert.equal(summary.totalCachedWriteTokens, 0);
      assert.equal(summary.cacheReadRatio, 0);
    } finally { Metrics.reset(); }
  });

  test('isolates concurrent collectors and interleaved main/background writes', async () => {
    const a = new MetricsCollector();
    const b = new MetricsCollector();
    await Promise.all([
      Promise.resolve().then(() => { for (let i = 0; i < 20; i++) { a.recordAICall('a', ai(2, 1)); a.recordBackgroundAICall('ac', ai(3, 1), { sessionKey: 'a', candidateId: `a-${i}` }); a.recordToolCall('read', i); } }),
      Promise.resolve().then(() => { for (let i = 0; i < 13; i++) { b.recordAICall('b', ai(5, 2)); b.recordBackgroundAICall('bc', ai(7, 2), { sessionKey: 'b', candidateId: `b-${i}` }); b.recordToolCall('write', i); } }),
    ]);
    assert.equal(a.getSummary().aiCalls, 20); assert.equal(a.getSummary().totalTokens, 60); assert.equal(a.getSummary().toolCalls, 20);
    assert.equal(b.getSummary().aiCalls, 13); assert.equal(b.getSummary().totalTokens, 91); assert.equal(b.getSummary().toolCalls, 13);
    assert.equal(a.getBackgroundSummary().totalTokens, 80); assert.equal(b.getBackgroundSummary().totalTokens, 117);
    assert.ok(a.getBackgroundRecords().every(record => record.context?.sessionKey === 'a'));
    assert.ok(b.getBackgroundRecords().every(record => record.context?.sessionKey === 'b'));
  });

  test('preserves all background attribution and isolates returned records', () => {
    const collector = new MetricsCollector();
    collector.recordBackgroundAICall('candidate-a', ai(5, 2), { sessionKey: 's1', candidateId: 'c1', episodeId: 'e1', phase: 'pre_turn', attempt: 2, providerRequest: 3 });
    collector.recordBackgroundAICall('candidate-b', ai(7, 4), { sessionKey: 's2', candidateId: 'c2', episodeId: 'e2', phase: 'mid_turn', attempt: 1, providerRequest: 8 });
    const records = collector.getBackgroundRecords() as any[];
    assert.deepEqual(records.map(record => record.context), [
      { sessionKey: 's1', candidateId: 'c1', episodeId: 'e1', phase: 'pre_turn', attempt: 2, providerRequest: 3 },
      { sessionKey: 's2', candidateId: 'c2', episodeId: 'e2', phase: 'mid_turn', attempt: 1, providerRequest: 8 },
    ]);
    records[0].context.candidateId = 'tampered';
    assert.equal(collector.getBackgroundRecords()[0].context?.candidateId, 'c1');
  });

  test('main summary excludes candidate fields while total ledger includes both', () => {
    const collector = new MetricsCollector();
    collector.recordAICall('main', ai(10, 2, 4, 1));
    collector.recordToolCall('inspect', 9);
    collector.recordBackgroundAICall('candidate', ai(30, 7, 20, 3), { candidateId: 'c1' });
    assert.deepEqual(collector.getSummary(), { aiCalls: 1, totalPromptTokens: 10, totalCompletionTokens: 2, totalTokens: 12, totalCachedReadTokens: 4, totalCachedWriteTokens: 1, cacheReadRatio: 0.4, toolCalls: 1, toolDurationMs: 9, toolBreakdown: { inspect: { count: 1, totalMs: 9 } } });
    assert.equal(collector.getBackgroundSummary().aiCalls, 1);
    assert.equal(collector.getBackgroundSummary().toolCalls, 0);
    const total = collector.getTotalSummary();
    assert.equal(total.aiCalls, 2); assert.equal(total.totalTokens, 49); assert.equal(total.toolCalls, 1); assert.equal(total.totalCachedReadTokens, 24);
  });

  test('reset clears main turn data but preserves multi-turn background ledger', () => {
    const collector = new MetricsCollector();
    collector.recordAICall('turn-1', ai(2, 1)); collector.recordToolCall('one', 4);
    collector.recordBackgroundAICall('candidate-1', ai(5, 2), { candidateId: 'c1', episodeId: 'e1' });
    collector.reset();
    collector.recordAICall('turn-2', ai(3, 2)); collector.recordToolCall('two', 6);
    collector.recordBackgroundAICall('candidate-2', ai(7, 4), { candidateId: 'c2', episodeId: 'e2' });
    assert.equal(collector.getSummary().totalTokens, 5); assert.equal(collector.getSummary().toolCalls, 1);
    assert.equal(collector.getBackgroundSummary().totalTokens, 18);
    assert.deepEqual(collector.getBackgroundRecords().map(record => record.context?.candidateId), ['c1', 'c2']);
    assert.equal(collector.getTotalSummary().totalTokens, 23);
    collector.reset(); assert.equal(collector.getSummary().totalTokens, 0); assert.equal(collector.getBackgroundSummary().totalTokens, 18);
  });

  test('reset clears cached totals and omits ratio for a zero denominator', () => {
    Metrics.reset(); Metrics.recordAICall('gpt-test', ai(10, 1, 8, 2)); Metrics.reset();
    const summary = Metrics.getSummary();
    assert.equal(summary.aiCalls, 0); assert.equal(summary.totalCachedReadTokens, 0); assert.equal(summary.totalCachedWriteTokens, 0); assert.equal(summary.cacheReadRatio, undefined);
  });
});

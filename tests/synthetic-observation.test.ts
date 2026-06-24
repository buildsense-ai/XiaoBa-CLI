import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildSyntheticObservationLifecycleEvent,
  buildSyntheticObservationMessages,
  describeSyntheticObservationForLog,
  InMemorySyntheticObservationQueue,
  SYNTHETIC_OBSERVATION_TOOL_NAME,
  SyntheticObservation,
  withSyntheticObservationTiming,
} from '../src/core/synthetic-observation';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { Message } from '../src/types';

function observation(id = 'memory-demo'): SyntheticObservation {
  return {
    id,
    source: 'memory',
    status: 'completed',
    relevance: 'high',
    confidence: 0.87,
    userIntent: 'remember the dashboard decision',
    summary: 'Earlier session decided to keep dashboard filters compact.',
    keyFacts: ['Use compact filters on the dashboard.'],
    evidence: [{
      sourceType: 'session',
      title: 'previous session',
      pathOrUrl: 'logs/sessions/demo.jsonl',
      locator: 'turn 3',
      snippet: 'Decision: keep dashboard filters compact.',
      relevanceReason: 'Matches dashboard decision request.',
    }],
    recommendedUse: {
      shouldUse: true,
      howToUse: 'Treat as prior project context.',
    },
  };
}

describe('synthetic observations', () => {
  test('builds a synthetic assistant tool_call and matching tool_result pair', () => {
    const messages = buildSyntheticObservationMessages([observation()]);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[1].role, 'tool');
    assert.equal(messages[0].__syntheticObservation, true);
    assert.equal(messages[1].__syntheticObservation, true);
    assert.equal(messages[0].tool_calls?.[0].function.name, SYNTHETIC_OBSERVATION_TOOL_NAME);
    assert.equal(messages[1].name, SYNTHETIC_OBSERVATION_TOOL_NAME);
    assert.equal(messages[1].tool_call_id, messages[0].tool_calls?.[0].id);
    assert.equal(JSON.parse(messages[0].tool_calls?.[0].function.arguments || '{}').timing, 'current_turn');
    assert.match(String(messages[1].content), /Earlier session decided/);
    assert.match(String(messages[1].content), /Decision: keep dashboard filters compact/);
    assert.match(String(messages[1].content), /timing: current_turn/);
  });

  test('queue drains once, dedupes ids, and discards after cancellation', () => {
    const queue = new InMemorySyntheticObservationQueue();

    assert.equal(queue.push(observation('same')), true);
    assert.equal(queue.push(observation('same')), false);
    assert.equal(queue.size(), 1);

    const firstDrain = queue.drain();
    assert.equal(firstDrain.length, 1);
    assert.equal(queue.drain().length, 0);

    assert.equal(queue.push(observation('after-drain')), true);
    const dropped = queue.cancel();
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].id, 'after-drain');
    assert.equal(queue.drain().length, 0);
    assert.equal(queue.push(observation('after-cancel')), false);
  });

  test('describes observations with branch metadata for logs', () => {
    const logLine = describeSyntheticObservationForLog({
      ...observation('memory-ready'),
      metadata: {
        branchType: 'memory',
        branchId: 'memory-abc',
        refs: ['chat/2026-06-16/demo.jsonl#1'],
      },
    });

    assert.match(logLine, /id=memory-ready/);
    assert.match(logLine, /source=memory/);
    assert.match(logLine, /branch=memory:memory-abc/);
    assert.match(logLine, /refs=chat\/2026-06-16\/demo\.jsonl#1/);
  });

  test('builds compact lifecycle events for log analysis', () => {
    const event = buildSyntheticObservationLifecycleEvent({
      ...observation('memory-ready'),
      timing: 'late_previous_turn',
      metadata: {
        branchType: 'memory',
        branchId: 'memory-abc',
        refs: ['chat/2026-06-16/demo.jsonl#1'],
        originTurn: 7,
      },
    }, {
      outcome: 'dropped',
      reason: 'carryover_ttl_expired',
    });

    assert.equal(event.type, 'synthetic_observation_lifecycle');
    assert.deepEqual(event.payload, {
      outcome: 'dropped',
      observation_id: 'memory-ready',
      source: 'memory',
      timing: 'late_previous_turn',
      reason: 'carryover_ttl_expired',
      origin_turn: 7,
      branch_id: 'memory-abc',
      branch_type: 'memory',
      refs: ['chat/2026-06-16/demo.jsonl#1'],
    });
  });

  test('uses formatted content override for compact JSON observations', () => {
    const compact = {
      ...observation('compact-json'),
      formattedContent: JSON.stringify({
        source: 'memory',
        summary: 'compact memory summary',
        refs: ['chat/2026-06-16/demo.jsonl#1'],
      }),
    };

    const messages = buildSyntheticObservationMessages([compact]);
    assert.deepEqual(JSON.parse(String(messages[1].content)), {
      source: 'memory',
      summary: 'compact memory summary',
      refs: ['chat/2026-06-16/demo.jsonl#1'],
    });
  });

  test('can mark formatted observations as late previous turn without breaking the tool pair', () => {
    const compact = withSyntheticObservationTiming({
      ...observation('late-json'),
      formattedContent: JSON.stringify({
        source: 'memory',
        summary: 'late memory summary',
        refs: ['chat/2026-06-16/demo.jsonl#1'],
      }),
    }, 'late_previous_turn');

    const messages = buildSyntheticObservationMessages([compact]);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[1].role, 'tool');
    assert.equal(messages[1].tool_call_id, messages[0].tool_calls?.[0].id);
    assert.equal(JSON.parse(messages[0].tool_calls?.[0].function.arguments || '{}').timing, 'late_previous_turn');
    assert.deepEqual(JSON.parse(String(messages[1].content)), {
      source: 'memory',
      summary: 'late memory summary',
      refs: ['chat/2026-06-16/demo.jsonl#1'],
      timing: 'late_previous_turn',
    });
  });

  test('does not truncate model-visible formatted observation content', () => {
    const summary = 'memory detail '.repeat(900);
    const formattedContent = JSON.stringify({
      source: 'memory',
      summary,
      refs: ['chat/2026-06-16/demo.jsonl#1'],
    });
    const messages = buildSyntheticObservationMessages([{
      ...observation('long-json'),
      formattedContent,
    }]);

    assert.equal(messages[1].content, formattedContent);
    assert.equal(JSON.parse(String(messages[1].content)).summary, summary);
    assert.doesNotMatch(String(messages[1].content), /truncated/);
  });

  test('does not truncate generated observation text content', () => {
    const longSummary = 'prior context '.repeat(900).trim();
    const messages = buildSyntheticObservationMessages([{
      ...observation('long-text'),
      summary: longSummary,
    }]);

    assert.match(String(messages[1].content), new RegExp(longSummary.slice(0, 200)));
    assert.ok(String(messages[1].content).includes(longSummary));
    assert.doesNotMatch(String(messages[1].content), /truncated/);
  });

  test('turn context cleanup strips synthetic observations from durable history', () => {
    const syntheticPair = buildSyntheticObservationMessages([observation()]);
    const durable: Message[] = [
      { role: 'user', content: 'hello' },
      ...syntheticPair,
      { role: 'assistant', content: 'done' },
    ];

    const cleaned = new TurnContextBuilder().removeTransientMessages(durable);

    assert.deepEqual(cleaned, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ]);
  });
});

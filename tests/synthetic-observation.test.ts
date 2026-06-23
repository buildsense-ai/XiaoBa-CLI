import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildSyntheticObservationMessages,
  InMemorySyntheticObservationQueue,
  SYNTHETIC_OBSERVATION_TOOL_NAME,
  SyntheticObservation,
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
    assert.match(String(messages[1].content), /Earlier session decided/);
    assert.match(String(messages[1].content), /Decision: keep dashboard filters compact/);
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
    queue.cancel();
    assert.equal(queue.drain().length, 0);
    assert.equal(queue.push(observation('after-cancel')), false);
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

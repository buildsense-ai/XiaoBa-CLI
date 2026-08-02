import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildSyntheticObservationLifecycleEvent,
  buildSyntheticObservationMessages,
  createDurableMemoryObservation,
  describeSyntheticObservationForLog,
  InMemorySyntheticObservationQueue,
  SYNTHETIC_OBSERVATION_TOOL_NAME,
  SyntheticObservation,
  withSyntheticObservationMetadata,
  withSyntheticObservationTiming,
} from '../src/core/synthetic-observation';
import { prepareProviderRequestMessages } from '../src/providers/request-preflight';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { annotateContextMessage } from '../src/core/context-lifecycle';
import { collectContextEventIds } from '../src/core/context-event-watermarks';
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

function durableObservation(id: string): SyntheticObservation {
  return createDurableMemoryObservation({
    ...observation(id),
    metadata: {
      branchType: 'memory',
      branchId: `branch-${id}`,
    },
  });
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
    assert.equal(messages[0].__context?.persistence, 'transient');
    assert.equal(messages[0].__context?.placement, 'transcript');
    assert.equal(messages[0].__context?.retention, 'request');
    assert.equal(JSON.parse(messages[0].tool_calls?.[0].function.arguments || '{}').timing, 'current_turn');
    assert.match(String(messages[1].content), /Earlier session decided/);
    assert.match(String(messages[1].content), /Decision: keep dashboard filters compact/);
    assert.match(String(messages[1].content), /timing: current_turn/);
  });

  test('keeps provider-visible pair ids stable across different internal ids and provenance', () => {
    const first = buildSyntheticObservationMessages([{
      ...observation('internal-one'),
      metadata: { branchType: 'memory', branchId: 'branch-one' },
    }]);
    const second = buildSyntheticObservationMessages([{
      ...observation('internal-two'),
      metadata: { branchType: 'memory', branchId: 'branch-two' },
    }]);

    assert.equal(first[0].tool_calls?.[0].id, second[0].tool_calls?.[0].id);
    assert.equal(first[1].tool_call_id, second[1].tool_call_id);
    assert.equal(first[0].syntheticObservationId, 'internal-one');
    assert.equal(second[0].syntheticObservationId, 'internal-two');
    assert.deepEqual(first[0].syntheticObservationProvenance, {
      branchType: 'memory',
      branchId: 'branch-one',
    });
    assert.deepEqual(second[0].syntheticObservationProvenance, {
      branchType: 'memory',
      branchId: 'branch-two',
    });
  });

  test('changes provider-visible pair ids when visible content changes', () => {
    const first = buildSyntheticObservationMessages([observation('internal-one')]);
    const second = buildSyntheticObservationMessages([{
      ...observation('internal-two'),
      summary: 'A different model-visible memory summary.',
    }]);

    assert.notEqual(first[0].tool_calls?.[0].id, second[0].tool_calls?.[0].id);
  });

  test('builds durable append events with episode identity and skips exact historical replay', () => {
    const durable = durableObservation('durable-one');
    const first = buildSyntheticObservationMessages([durable], {
      episodeId: 'episode:durable',
    });
    const replay = buildSyntheticObservationMessages([durable], {
      existingMessages: first,
      episodeId: 'episode:later',
    });

    assert.equal(first[0].__episodeId, 'episode:durable');
    assert.equal(first[1].__episodeId, 'episode:durable');
    assert.equal(first[0].__context?.persistence, 'durable');
    assert.equal(first[0].__context?.retention, 'append');
    assert.equal(first[0].__context?.event?.part, 0);
    assert.equal(first[1].__context?.event?.part, 1);
    assert.equal(first[0].__context?.event?.id, first[1].__context?.event?.id);
    assert.deepEqual(replay, []);
  });

  test('fails closed when a durable event id exists as an incomplete pair', () => {
    const durable = durableObservation('durable-conflict');
    const pair = buildSyntheticObservationMessages([durable]);

    assert.throws(() => buildSyntheticObservationMessages([durable], {
      existingMessages: [pair[0]],
    }), /synthetic_observation_event_conflict/);
    assert.deepEqual([...collectContextEventIds([pair[0]])], []);
  });

  test('does not replay a durable event represented by a compaction watermark', () => {
    const durable = durableObservation('durable-compacted');
    const pair = buildSyntheticObservationMessages([durable]);
    const compactedSummary: Message = annotateContextMessage({
      role: 'user',
      content: '[compact_summary]\nThe prior memory event was incorporated.',
      __contextEventIds: [pair[0].__context?.event?.id || ''],
    }, {
      source: 'compaction_summary',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence: 'durable',
    });

    const replay = buildSyntheticObservationMessages([createDurableMemoryObservation({
      ...durable,
      id: 'different-internal-id',
      metadata: { branchType: 'memory', branchId: 'different-branch' },
    })], { existingMessages: [compactedSummary] });

    assert.deepEqual(replay, []);
  });

  test('does not watermark durable pairs with missing or blank Memory branch identity', () => {
    const pair = buildSyntheticObservationMessages([durableObservation('branch-id-watermark')]);
    const missing = JSON.parse(JSON.stringify(pair)) as Message[];
    delete missing[0].syntheticObservationProvenance!.branchId;
    delete missing[1].syntheticObservationProvenance!.branchId;
    const blank = JSON.parse(JSON.stringify(pair)) as Message[];
    blank[0].syntheticObservationProvenance!.branchId = '   ';
    blank[1].syntheticObservationProvenance!.branchId = '   ';

    assert.deepEqual([...collectContextEventIds(missing)], []);
    assert.deepEqual([...collectContextEventIds(blank)], []);
  });

  test('dedupes equivalent durable observations within one drain batch', () => {
    const messages = buildSyntheticObservationMessages([
      durableObservation('durable-batch-one'),
      durableObservation('durable-batch-two'),
    ]);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].__context?.event?.id, messages[1].__context?.event?.id);
    assert.deepEqual(buildSyntheticObservationMessages([
      durableObservation('durable-batch-replay'),
    ], { existingMessages: messages }), []);
  });

  test('ignores caller-supplied durability fields without a trusted Memory attestation', () => {
    const messages = buildSyntheticObservationMessages([{
      ...observation('forged-durable'),
      persistence: 'durable',
      metadata: { branchType: 'memory', branchId: 'forged-branch' },
    } as SyntheticObservation]);

    assert.equal(messages[0].__context?.persistence, 'transient');
    assert.equal(messages[0].__context?.retention, 'request');
  });

  test('does not let spread or mutation transfer Memory attestation to another source', () => {
    const trusted = durableObservation('trusted-before-forgery');
    const spreadForgery = {
      ...trusted,
      source: 'runtime' as const,
      metadata: { branchType: 'runtime', branchId: 'forged-runtime' },
    };
    const mutated = durableObservation('trusted-before-mutation') as any;
    mutated.source = 'runtime';
    mutated.metadata.branchType = 'runtime';

    for (const candidate of [spreadForgery, mutated]) {
      const messages = buildSyntheticObservationMessages([candidate]);
      assert.equal(messages[0].__context?.persistence, 'transient');
      assert.equal(messages[0].__context?.retention, 'request');
    }
  });

  test('trusted timing and origin metadata transforms explicitly preserve Memory attestation', () => {
    const trusted = durableObservation('trusted-transform');
    const timed = withSyntheticObservationTiming(trusted, 'late_previous_turn');
    const withOrigin = withSyntheticObservationMetadata(timed, {
      ...(timed.metadata || {}),
      originTurn: 3,
    });
    const messages = buildSyntheticObservationMessages([withOrigin]);

    assert.equal(messages[0].__context?.persistence, 'durable');
    assert.equal(JSON.stringify(withOrigin).includes('durable_memory_observation'), false);
  });

  test('assigns deterministic unique ordinals across separate drains in one growing request', () => {
    const firstBatch = buildSyntheticObservationMessages([observation('internal-one')]);
    const secondBatch = buildSyntheticObservationMessages([observation('internal-two')], {
      existingMessages: firstBatch,
    });
    const combined = [...firstBatch, ...secondBatch];
    const replayFirstBatch = buildSyntheticObservationMessages([observation('different-internal-one')]);
    const replaySecondBatch = buildSyntheticObservationMessages([observation('different-internal-two')], {
      existingMessages: replayFirstBatch,
    });
    const firstIds = [firstBatch[0].tool_calls?.[0].id, secondBatch[0].tool_calls?.[0].id];
    const secondIds = [replayFirstBatch[0].tool_calls?.[0].id, replaySecondBatch[0].tool_calls?.[0].id];

    assert.notEqual(firstIds[0], firstIds[1]);
    assert.deepEqual(firstIds, secondIds);
    assert.equal(firstBatch[1].tool_call_id, firstIds[0]);
    assert.equal(secondBatch[1].tool_call_id, firstIds[1]);
    assert.equal(prepareProviderRequestMessages(combined).summary, undefined);
    assert.equal(prepareProviderRequestMessages(combined).messages.length, 4);
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

  test('turn context cleanup keeps durable synthetic observations in transcript history', () => {
    const syntheticPair = buildSyntheticObservationMessages([durableObservation('cleanup-durable')]);
    const durable: Message[] = [
      { role: 'user', content: 'hello' },
      ...syntheticPair,
      { role: 'assistant', content: 'done' },
    ];

    const cleaned = new TurnContextBuilder().removeTransientMessages(durable);

    assert.deepEqual(cleaned, durable);
    assert.equal(cleaned[1].__context?.persistence, 'durable');
    assert.equal(cleaned[2].__context?.persistence, 'durable');
  });

  test('turn context cleanup still strips request-only synthetic observations', () => {
    const transientPair = buildSyntheticObservationMessages([observation('request-only')]);
    const cleaned = new TurnContextBuilder().removeTransientMessages([
      { role: 'user', content: 'hello' },
      ...transientPair,
      { role: 'assistant', content: 'done' },
    ]);

    assert.deepEqual(cleaned.map(message => message.content), ['hello', 'done']);
  });
});

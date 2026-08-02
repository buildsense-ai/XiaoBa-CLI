import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import { CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';
import {
  TOOL_RESULT_PRUNED_PREFIX,
  pruneStaleToolResults,
} from '../src/core/tool-result-pruning';
import { prepareProviderRequestMessages } from '../src/providers/request-preflight';

function exchange(episodeId: string, callId: string, content: string): Message[] {
  return [
    { role: 'user', content: `request ${episodeId}`, __episodeId: episodeId },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }],
      __episodeId: episodeId,
    },
    {
      role: 'tool',
      name: 'read_file',
      tool_call_id: callId,
      content,
      __episodeId: episodeId,
    },
  ];
}

test('stale tool pruning preserves protocol identity and protects the active episode', () => {
  const oldRaw = `OLD_HEAD\n${'x'.repeat(12_000)}\nOLD_TAIL`;
  const activeRaw = `ACTIVE_HEAD\n${'y'.repeat(12_000)}\nACTIVE_TAIL`;
  const messages = [
    ...exchange('episode-old', 'call-old', oldRaw),
    ...exchange('episode-active', 'call-active', activeRaw),
  ];

  const result = pruneStaleToolResults(messages, {
    phase: 'mid_turn',
    countThreshold: 1,
    tokenThreshold: 1,
    targetCount: 1,
    targetTokens: 1,
  });

  assert.equal(result.pruned, true);
  assert.equal(result.prunedCount, 1);
  const oldResult = result.messages.find(message => message.tool_call_id === 'call-old');
  const activeResult = result.messages.find(message => message.tool_call_id === 'call-active');
  assert.ok(String(oldResult?.content).startsWith(TOOL_RESULT_PRUNED_PREFIX));
  assert.match(String(oldResult?.content), /tool_call_id: call-old/);
  assert.match(String(oldResult?.content), /sha256: [a-f0-9]{64}/);
  assert.match(String(oldResult?.content), /OLD_HEAD/);
  assert.match(String(oldResult?.content), /OLD_TAIL/);
  assert.equal(oldResult?.__context?.source, 'tool_result_prune');
  assert.equal(oldResult?.__context?.persistence, 'durable');
  assert.equal(activeResult?.content, activeRaw);
  assert.equal(messages[2].content, oldRaw);
  assert.equal(prepareProviderRequestMessages(result.messages).summary, undefined);
});

test('checkpoint coordinator persists pruning without calling a summary model when enough space is recovered', async () => {
  const service = {
    chatStream: async () => {
      throw new Error('summary model must not be called');
    },
  } as any;
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 6_000,
    compactionThreshold: 0.5,
    toolResultPruningCountThreshold: 99,
    toolResultPruningTokenThreshold: 1_000,
    toolResultPruningTargetCount: 99,
    toolResultPruningTargetTokens: 1_000,
  });
  const messages = [
    ...exchange('episode-old', 'call-old', `OLD_HEAD\n${'z'.repeat(20_000)}\nOLD_TAIL`),
    ...exchange('episode-active', 'call-active', 'current result'),
  ];

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'prune-only-session',
    phase: 'mid_turn',
  });

  assert.equal(result.compacted, true);
  assert.equal(result.action, 'tool_result_prune');
  assert.ok(String(result.messages[2].content).startsWith(TOOL_RESULT_PRUNED_PREFIX));
  assert.equal(result.messages.at(-1)?.content, 'current result');
});

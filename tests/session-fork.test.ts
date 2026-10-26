import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareForkMessages, truncateAtTurn } from '../src/core/session-fork';

test('fork preserves summaries and tool exchanges but not runtime context or provider replay', () => {
  const source: any[] = [
    { role: 'system', content: 'old environment' },
    { role: 'user', content: 'approved spec', __checkpointSummary: true, __remoteContextWatermarks: { 'catscompany.agent_context': 10 } },
    { role: 'user', content: 'temporary', __injected: true },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"spec.md"}' } }], providerState: { secret: true } },
    { role: 'tool', tool_call_id: 't1', content: 'spec contents' },
    { role: 'assistant', content: 'done', __remoteContextSource: 'catscompany.agent_context', __remoteContextId: 12 },
  ];
  const target = prepareForkMessages(source, { '10': 30, '12': 32 });
  assert.equal(target.length, 4);
  assert.equal(target[0].__checkpointSummary, true);
  assert.deepEqual(target[0].__remoteContextWatermarks, { 'catscompany.agent_context': 30 });
  assert.equal(target[3].__remoteContextId, 32);
  assert.equal(target[1].providerState, undefined);
  (target[1].tool_calls![0].function as any).arguments = 'changed';
  assert.equal(source[3].tool_calls[0].function.arguments, '{"path":"spec.md"}');
});

test('fork rejects incomplete or orphan tool exchanges instead of replaying them', () => {
  assert.throws(() => prepareForkMessages([{ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'shell', arguments: '{}' } }] }], {}), /incomplete/i);
  assert.throws(() => prepareForkMessages([{ role: 'tool', tool_call_id: 'x', content: 'ok' }], {}), /orphan/i);
});

test('fork supports parallel completed tools, rejects malformed durable messages', () => {
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'read', arguments: '{}' } });
  assert.equal(prepareForkMessages([
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'b', content: 'b result' },
    { role: 'tool', tool_call_id: 'a', content: 'a result' },
  ], {}).length, 3);
  assert.throws(() => prepareForkMessages([{ role: 'unknown', content: 'corrupt' } as any], {}), /invalid/i);
  assert.throws(() => prepareForkMessages([{ role: 'user', content: { invalid: true } } as any], {}), /invalid/i);
});

test('bounded fork cuts after the last complete turn and drops stale summaries', () => {
  const source: any[] = [
    { role: 'user', content: 'turn one' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'turn two' },
    { role: 'assistant', content: 'answer two' },
    { role: 'user', content: 'turn three' },
    { role: 'assistant', content: 'answer three' },
  ];
  // Two complete turns keep everything up to the third user message.
  assert.deepEqual(truncateAtTurn(source, 2).map(message => message.content),
    ['turn one', 'answer one', 'turn two', 'answer two']);
  // Absent means the server sent no bound, so the whole conversation is copied.
  assert.equal(truncateAtTurn(source, undefined).length, 6);

  const withSummary: any[] = [
    { role: 'user', content: 'summary of the future', __checkpointSummary: true },
    { role: 'user', content: 'turn one' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'turn two' },
  ];
  // The summary may already describe turns beyond the cut, so it must not travel.
  assert.deepEqual(truncateAtTurn(withSummary, 1).map(message => message.content), ['turn one', 'answer one']);
});

test('bounded fork ignores synthetic user messages when counting turns', () => {
  const source: any[] = [
    { role: 'user', content: 'turn one' },
    { role: 'assistant', content: 'answer one' },
    // Synthetic user-role rows must not look like new turns, or the cut drifts.
    { role: 'user', content: 'observation', __runtimeObservation: true },
    { role: 'user', content: 'feedback', __runtimeFeedback: true },
    { role: 'user', content: 'turn two' },
    { role: 'assistant', content: 'answer two' },
  ];
  assert.equal(truncateAtTurn(source, 2).length, source.length);
  // The synthetic rows sit inside turn one, so cutting after it keeps them: they
  // belong to that turn rather than opening a new one.
  assert.equal(truncateAtTurn(source, 1).length, 4);
});

test('bounded fork fails closed instead of cutting somewhere unexpected', () => {
  // The server counted more turns than this transcript holds: the two sides
  // disagree, so guessing a boundary would produce a mismatched copy.
  assert.throws(() => truncateAtTurn([{ role: 'user', content: 'only' }], 2), /session_fork_source_turn_mismatch/);
  // A trailing turn with no answer is not complete, so the server would not have
  // counted it; accepting it here would keep a turn the server never copied.
  assert.throws(() => truncateAtTurn([{ role: 'user', content: 'asked' }], 1), /session_fork_source_turn_mismatch/);
});

// The regression this guards: an explicit 0 used to be read as "unbounded", so a
// server that could not establish a bound make the runtime copy the whole
// transcript while the cloud copied only a prefix — the exact mismatch the guard
// exists to prevent. Only absence means "no bound".
test('an explicit zero bound fails closed instead of copying everything', () => {
  const source: any[] = [
    { role: 'user', content: 'asked' },
    { role: 'assistant', content: 'answered' },
  ];
  assert.equal(truncateAtTurn(source, undefined).length, 2);
  assert.throws(() => truncateAtTurn(source, 0), /session_fork_source_turn_mismatch/);
  assert.throws(() => truncateAtTurn(source, -1), /session_fork_source_turn_mismatch/);
});

// Both sides must fold this the same way. The server treats u1,u2,a1 as one
// turn; building a per-message turn-start list here cut between u1 and u2, hit an
// interval with no assistant, and failed the fork outright. A user sending twice
// before an answer is common, so that made the feature unusable on those threads.
test('consecutive user messages fold into one turn, matching the server', () => {
  const source: any[] = [
    { role: 'user', content: 'first ask' },
    { role: 'user', content: 'second ask' },
    { role: 'assistant', content: 'one answer' },
    { role: 'user', content: 'next ask' },
    { role: 'assistant', content: 'next answer' },
  ];
  assert.deepEqual(truncateAtTurn(source, 1).map(message => message.content),
    ['first ask', 'second ask', 'one answer']);
  assert.equal(truncateAtTurn(source, 2).length, 5);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareForkMessages } from '../src/core/session-fork';

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

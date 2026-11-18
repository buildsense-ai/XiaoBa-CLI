import assert from 'node:assert/strict';
import test from 'node:test';
import { attachCheckpointMetadata, buildExecutionGraphCallEvent, checkpointMetadata } from '../src/core/execution-graph-metadata';
import type { Message } from '../src/types';

test('execution metadata binds stable session nodes, precise results, schemas, attempt and checkpoint consumption', () => {
  const summary: Message = { role: 'user', content: 'continuation summary', __checkpointSummary: true, __executionNodeRef: 'session:ep1:checkpoint:cp-1' };
  const toolResult: Message = { role: 'tool', tool_call_id: 'call-1', name: 'inspect', content: 'result', __executionNodeRef: 'provider-result:call-1' };
  attachCheckpointMetadata(summary, checkpointMetadata({
    sessionId: 'session-1', episodeId: 'ep1', summary, covered: [toolResult],
    lastMessage: toolResult, coverageComplete: true,
  }));
  summary.__checkpointPersisted = true;
  const event = buildExecutionGraphCallEvent([summary, toolResult], {
    content: 'done', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }, { sessionId: 'session-1', episodeId: 'ep1', attempt: 2, tools: [{ name: 'inspect', description: 'inspect', parameters: { type: 'object' } }] });
  assert.equal(event.session_id, 'session-1');
  assert.equal(event.episode_id, 'ep1');
  assert.equal(event.model_call_attempt_id, `${event.model_call_id}:attempt:2`);
  assert.equal(event.input_manifest.items[0].ref, summary.__checkpointId);
  assert.equal(event.input_manifest.items[1].ref, 'provider-result:call-1');
  assert.equal(event.input_manifest.tools.length, 1);
  assert.equal(event.checkpoint_consumptions[0].checkpoint_id, summary.__checkpointId);
  assert.equal(event.checkpoint_consumptions[0].summary_sha256, summary.__checkpointSummarySHA256);
});

test('memory bindings retain exact producer origins when reused IDs have identical bodies', () => {
  const body = JSON.stringify({ source: { status: 'read', coverage: 'complete', text: 'Pinned node.', anchor: {
    kind: 'source_memory_projection_node', source_projection_ref: `ref_${'a'.repeat(64)}`, revision: 'b'.repeat(64), id: 'c'.repeat(64),
  } } });
  const messages: Message[] = [
    { role: 'tool', tool_call_id: 'reused-read', content: body, __executionSourceSessionId: 's', __executionSourceEpisodeId: 'e1', __executionSourceModelCallId: 'producer-1' },
    { role: 'tool', tool_call_id: 'reused-read', content: body, __executionSourceSessionId: 's', __executionSourceEpisodeId: 'e2', __executionSourceModelCallId: 'producer-2' },
  ];
  const event = buildExecutionGraphCallEvent(messages, { content: 'done', toolCalls: [] }, { sessionId: 's', episodeId: 'consumer', attempt: 1 });
  const bindings = event.memory_node_inputs;
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings.map((binding: any) => binding.source_model_call_id), ['producer-1', 'producer-2']);
  assert.equal(bindings[0].input_node_ref, bindings[1].input_node_ref);
  assert.equal(bindings[0].input_sha256, bindings[1].input_sha256);
  for (const binding of bindings) {
    assert.ok(event.input_manifest.items.some((item: any) => item.ref === binding.input_node_ref
      && item.sha256 === binding.input_sha256 && item.source_model_call_id === binding.source_model_call_id));
  }
});

test('modified checkpoint bytes are not bound as consumption', () => {
  const summary: Message = { role: 'user', content: 'original', __checkpointSummary: true };
  attachCheckpointMetadata(summary, checkpointMetadata({ sessionId: 's', episodeId: 'e', summary, covered: [], coverageComplete: true }));
  const altered = { ...summary, content: 'changed' };
  const event = buildExecutionGraphCallEvent([altered], { content: 'ok' }, { sessionId: 's', episodeId: 'e', attempt: 1 });
  assert.deepEqual(event.checkpoint_consumptions, []);
});

test('checkpoint is not consumed unless the exact summary bytes are submitted', () => {
  const event = buildExecutionGraphCallEvent([{ role: 'user', content: 'ordinary' }], { content: 'ok' }, { sessionId: 's', episodeId: 'e', attempt: 1 });
  assert.deepEqual(event.checkpoint_consumptions, []);
});

test('metadata bounds output and input manifests and states why coverage is incomplete', () => {
  const calls = Array.from({ length: 520 }, (_, i) => ({ id: `c${i}`, type: 'function' as const, function: { name: 'x', arguments: '{}' } }));
  const event = buildExecutionGraphCallEvent(Array.from({ length: 520 }, (_, i) => ({ role: 'user' as const, content: String(i), __executionNodeRef: `query-${i}` })), { content: null, toolCalls: calls }, { sessionId: 's', episodeId: 'e', attempt: 1 });
  assert.ok(event.outputs.length <= 512);
  assert.ok(event.input_manifest.items.length <= 512);
  assert.equal(event.input_manifest.complete, false);
  assert.equal(event.outputs_complete, false);
  assert.ok(event.completeness_reason);
});

test('input manifests retain assistant text alongside sibling tool calls and content hashes', () => {
  const event = buildExecutionGraphCallEvent([{
    role: 'assistant', content: 'I will inspect both sources.',
    tool_calls: [
      { id: 'same-a', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      { id: 'same-b', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ], __executionNodeRef: 'message:tc1',
  }], { content: null, toolCalls: [] }, { sessionId: 's', episodeId: 'e', attempt: 1 });
  assert.deepEqual(event.input_manifest.items.map((item: any) => item.ref), [
    'provider-call:same-a', 'provider-call:same-b', 'message:tc1',
  ]);
  assert.ok(event.input_manifest.items.every((item: any) => /^[a-f0-9]{64}$/.test(item.content_sha256)));
});

test('checkpoint input uses backend wire fields and coverage refs match actual manifest refs', () => {
  const toolCall = { id: 'tc-1', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } };
  const assistant: Message = { role: 'assistant', content: 'checking', tool_calls: [toolCall], __executionNodeRef: 'message:tc1' };
  const result: Message = { role: 'tool', tool_call_id: 'tc-1', name: 'lookup', content: 'done' };
  const summary: Message = { role: 'user', content: 'checkpoint text', __checkpointSummary: true };
  attachCheckpointMetadata(summary, checkpointMetadata({ sessionId: 's', episodeId: 'e', summary, covered: [assistant, result], coverageComplete: false }));
  summary.__checkpointPersisted = true;
  const event = buildExecutionGraphCallEvent([summary, assistant, result], { content: 'done' }, { sessionId: 's', episodeId: 'e', attempt: 3 });
  const cp = event.input_manifest.items[0];
  assert.equal(cp.ref, cp.checkpoint.checkpoint_id);
  assert.equal(Number.isInteger(cp.checkpoint.version), true);
  assert.equal(typeof cp.content_sha256, 'string');
  assert.deepEqual(cp.checkpoint.covered_node_refs, ['provider-call:tc-1', 'message:tc1', 'provider-result:tc-1']);
  assert.deepEqual(cp.checkpoint.previous_frontier_ref, []);
  assert.equal(event.checkpoint_consumptions[0].summary_sha256, cp.content_sha256);
});

test('tool schemas and outputs stay byte-bounded and completeness reflects truncation', () => {
  const calls = Array.from({ length: 512 }, (_, i) => ({ id: `c${i}`, type: 'function' as const, function: { name: 'x', arguments: '{}' } }));
  const tools = Array.from({ length: 512 }, () => ({ name: 't'.repeat(256), description: 'd'.repeat(300), parameters: { type: 'object' } }));
  const event = buildExecutionGraphCallEvent([], { content: 'assistant sibling', toolCalls: calls }, { sessionId: 's', episodeId: 'e', attempt: 1, tools });
  assert.ok(Buffer.byteLength(JSON.stringify(event.input_manifest)) <= 64 * 1024);
  assert.equal(event.input_manifest.tools_complete, false);
  assert.equal(event.input_manifest.complete, false);
  assert.equal(event.outputs.length, 512);
  assert.equal(event.outputs_complete, false);
});

test('manifest refs for the same captured transcript message remain stable', () => {
  const messages: Message[] = [{ role: 'user', content: 'same', __executionNodeRef: 'session:s:episode:e:message:0:abc' }];
  const one = buildExecutionGraphCallEvent(messages, { content: 'one' }, { sessionId: 's', episodeId: 'e', attempt: 1 });
  const two = buildExecutionGraphCallEvent(messages, { content: 'two' }, { sessionId: 's', episodeId: 'e', attempt: 2 });
  assert.equal(one.input_manifest.items[0].ref, two.input_manifest.items[0].ref);
});

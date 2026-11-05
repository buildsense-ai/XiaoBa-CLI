import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ConversationRunner } from '../src/core/conversation-runner';
import type { Message, ChatResponse } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7 };
const anchor = { kind: 'source_memory_projection_node', source_projection_ref: `ref_${'a'.repeat(64)}`, revision: 'b'.repeat(64), id: 'c'.repeat(64) };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function schemaHash(tool: ToolDefinition): string {
  return createHash('sha256').update(JSON.stringify({ description: tool.description, parameters: tool.parameters })).digest('hex');
}

test('runtime call evidence snapshots dispatched messages, tool schema, and late branch material', async () => {
  // Failure scenarios checked before implementation:
  // 1. runtime material arriving while request 1 is pending must not appear in call 1 evidence;
  // 2. mutating a retained message/source body after dispatch must not rewrite call 1/2 evidence or memory binding;
  // 3. mutating nested tool schema after dispatch must not rewrite that call's schema hash;
  // 4. late runtime material is attributed when first dispatched on request 2.
  const first = deferred<ChatResponse>();
  const second = deferred<ChatResponse>();
  const dispatched: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  const dispatchSignals = [deferred<void>(), deferred<void>()];
  let requestCount = 0;
  const sourceBody = JSON.stringify({ source: { status: 'read', coverage: 'complete', text: 'Pinned source node.', anchor } });
  const tool: ToolDefinition = { name: 'lookup', description: 'original schema', parameters: { type: 'object', properties: { key: { type: 'string' } } } };
  const originalSchemaHash = schemaHash(tool);
  const changedSchemaHash = (() => {
    const copy = structuredClone(tool);
    copy.parameters.properties.key = { type: 'number' } as any;
    copy.description = 'schema at second dispatch';
    return schemaHash(copy);
  })();
  const originalMessage: Message = { role: 'user', content: 'submitted before request', __episodeId: 'snapshot-episode', __episodeInputKind: 'root' };
  const transcript: Message[] = [originalMessage];
  const events: any[] = [];
  let lateBranchAvailable = false;
  let lateBranchDrained = false;
  const runner = new ConversationRunner({
    chat: async (messages: Message[], tools: ToolDefinition[]) => {
      const index = requestCount++;
      dispatched.push(structuredClone({ messages, tools }));
      dispatchSignals[index].resolve();
      return index === 0 ? first.promise : second.promise;
    },
  } as any, {
    getToolDefinitions: () => [tool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => ({
      role: 'tool', tool_call_id: call.id, name: call.function.name, content: sourceBody, ok: true,
    }),
  } as ToolExecutor, {
    stream: false,
    episodeId: 'snapshot-episode',
    toolExecutionContext: { sessionId: 'snapshot-session' },
    runtimeTransientProvider: () => {
      if (!lateBranchAvailable || lateBranchDrained) return [];
      lateBranchDrained = true;
      return [{ role: 'system', content: 'late Branch result', __runtimeObservation: true, runtimeObservationSource: 'branch' }];
    },
  });
  const waitForDispatch = (index: number) => dispatchSignals[index].promise;
  const run = runner.run(transcript, { onExecutionGraphEvent: event => events.push(event) } as any);

  await waitForDispatch(0);
  originalMessage.content = 'mutated after request 1 dispatch';
  lateBranchAvailable = true;
  tool.description = 'schema at second dispatch';
  tool.parameters.properties.key = { type: 'number' } as any;
  first.resolve({ content: null, toolCalls: [{ id: 'source-read', type: 'function', function: { name: 'lookup', arguments: '{}' } }], usage });

  await waitForDispatch(1);
  const dispatchedSource = dispatched[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'source-read')!;
  assert.equal(dispatchedSource.content, sourceBody, 'second provider request captured the original structured source result');
  tool.description = 'schema mutated after request 2 dispatch';
  tool.parameters.properties.key = { type: 'boolean' } as any;
  const retainedSource = transcript.find(message => message.role === 'tool' && message.tool_call_id === 'source-read')!;
  retainedSource.content = JSON.stringify({ source: { status: 'read', coverage: 'complete', text: 'changed after dispatch', anchor: { ...anchor, id: 'd'.repeat(64) } } });
  second.resolve({ content: 'complete', toolCalls: [], usage });
  await run;

  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].messages[0].content, 'submitted before request', 'provider got the original dispatched body');
  assert.equal(events[0].input_manifest.items.some((item: any) => item.ref === 'runtime-material:snapshot-session:snapshot-episode'), false);
  assert.equal(events[0].input_manifest.items.some((item: any) => item.sha256 === createHash('sha256').update(JSON.stringify({
    role: 'user', content: 'submitted before request', tool_calls: undefined, tool_call_id: undefined,
  })).digest('hex')), true, 'first event manifest uses dispatch-time message bytes');
  assert.equal(events[0].input_manifest.tools[0].schema_sha256, originalSchemaHash, 'first event keeps dispatch-time nested tool schema');
  assert.equal(events[0].memory_node_inputs.length, 0, 'late Branch result is not attributed to the earlier call');

  assert.ok(dispatched[1].messages.some(message => message.content === 'late Branch result'), 'runtimeTransientProvider material is included in the later request');
  assert.ok(events[1].input_manifest.items.some((item: any) => item.sha256 === createHash('sha256').update(JSON.stringify({
    role: 'system', content: 'late Branch result', tool_calls: undefined, tool_call_id: undefined,
  })).digest('hex')), 'later call metadata includes the late material actually dispatched');
  assert.equal(events[1].input_manifest.tools[0].schema_sha256, changedSchemaHash, 'second call records schema captured at its dispatch');
  assert.deepEqual(events[1].memory_node_inputs.map((binding: any) => binding.anchor), [anchor], 'binding follows the source body captured at dispatch');
  const sourceItem = events[1].input_manifest.items.find((item: any) => item.ref === 'provider-result:source-read');
  assert.equal(events[1].memory_node_inputs[0].input_sha256, sourceItem.sha256);
  assert.equal(events[1].memory_node_inputs[0].input_node_ref, sourceItem.ref);
});

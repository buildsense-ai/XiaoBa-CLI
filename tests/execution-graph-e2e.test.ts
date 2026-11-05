import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Logger } from '../src/utils/logger';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import { CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';
import { ConversationRunner } from '../src/core/conversation-runner';
import { decodeSharedRuntime } from '../scripts/execution-memory-fixture';
import type { Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };
const projectionAnchor = { kind: 'source_memory_projection_node' as const, source_projection_ref: `ref_${'a'.repeat(64)}`, revision: 'b'.repeat(64), id: 'c'.repeat(64) };

test('E2E: checkpoint persists before request and exact summary is consumed in session runtime JSONL', async () => {
  const sessionId = `execution-graph-e2e-${Date.now()}`;
  const episodeId = 'episode-e2e-1';
  const logger = new SessionTurnLogger('cli', sessionId);
  const events: string[] = [];
  let providerCalls = 0;
  const tool: ToolDefinition = { name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } };
  const coordinator = new CheckpointCompactionCoordinator({
    chatStream: async () => ({ content: 'Checkpoint summary covering earlier work.', usage }),
  } as any, { maxContextTokens: 1000 });
  const runner = new ConversationRunner({
    chat: async (messages: Message[]) => {
      providerCalls++;
      events.push(`provider:${providerCalls}`);
      if (providerCalls === 1) {
        return {
          content: null,
          toolCalls: ['call-A', 'call-B'].map(id => ({ id, type: 'function' as const, function: { name: 'lookup', arguments: '{"key":"x"}' } })),
          usage,
        };
      }
      if (providerCalls === 2) return { content: null, toolCalls: [{ id: 'call-C', type: 'function', function: { name: 'lookup', arguments: '{"key":"y"}' } }], usage };
      return { content: 'finished', toolCalls: [], usage };
    },
  } as any, {
    getToolDefinitions: () => [tool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: call.id === 'call-A'
      ? JSON.stringify({ retained_remote_evidence: [{ ref: projectionAnchor.source_projection_ref, semantic_view: { content_trust: 'derived_memory_projection', nodes: [{ id: projectionAnchor.id, text: 'preserve the lock', anchor: projectionAnchor }] } }] })
      : `result-${call.id}`, ok: true }),
  } as ToolExecutor, {
    stream: false,
    episodeId,
    toolExecutionContext: { sessionId },
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async messages => {
      events.push('persist');
      assert.ok(messages.some(message => message.__checkpointId));
    },
  });

  await Logger.withSessionContext(sessionId, logger, async () => {
    await runner.run([
      { role: 'user', content: 'old query '.repeat(160), __episodeId: episodeId },
      { role: 'assistant', content: 'old response '.repeat(160), __episodeId: episodeId },
      { role: 'user', content: 'continue work', __episodeId: episodeId, __episodeInputKind: 'root' },
    ], {
      onExecutionGraphEvent: event => Logger.runtimeEvent('INFO', 'execution graph model call', { type: 'execution_graph', payload: event }),
      onToolExecutionResult: (result, _messages, origin) => Logger.runtimeEvent('INFO', 'execution graph function result', { type: 'execution_graph', payload: {
        contract_version: 'execution-graph/1', identity_contract: 'execution-identity/1', event_id: randomUUID(),
        session_id: origin.session_id, episode_id: origin.episode_id, model_call_id: origin.model_call_id,
        type: 'function_result', call_node_ref: `provider-call:${result.tool_call_id}`,
        result_node_ref: `provider-result:${result.tool_call_id}`,
        provider_call_id: result.tool_call_id, result_sha256: require('node:crypto').createHash('sha256').update(JSON.stringify(result.content)).digest('hex'), result_state: 'captured',
      } }),
    });
  });

  const entries = fs.readFileSync(logger.getLogFilePath(), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const executionLines = entries.filter(entry => entry.entry_type === 'runtime'
    && ['execution_graph', 'execution_graph_checkpoint'].includes(entry.event?.type));
  const execution = decodeSharedRuntime(executionLines).map(entry => entry.event.payload);
  fs.writeFileSync('/tmp/catslog-three-layer-luna/client-execution-fixture.jsonl', executionLines.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const checkpointIndex = execution.findIndex(event => event.type === 'checkpoint_persisted');
  const calls = execution.filter(event => event.type === 'successful_model_call');
  assert.ok(checkpointIndex >= 0, 'durable checkpoint event emitted');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].session_id, sessionId);
  assert.equal(calls[0].episode_id, episodeId);
  assert.equal(calls[0].checkpoint_consumptions.length, 1, 'checkpoint bound only because exact summary was submitted');
  assert.equal(calls[0].checkpoint_consumptions[0].summary_sha256, calls[0].input_manifest.items.find((item: any) => item.kind === 'checkpoint_summary').content_sha256);
  assert.equal(calls[0].checkpoint_consumptions[0].coverage_complete, false, 'imported historical source refs stay explicitly incomplete');
  assert.ok(calls[0].checkpoint_consumptions[0].covered_node_refs.some((ref: string) => ref.startsWith('unknown-session-node:')));
  assert.ok(calls[1].input_manifest.items.some((item: any) => item.ref === 'provider-result:call-A'));
  assert.ok(calls[1].input_manifest.items.some((item: any) => item.ref === 'provider-result:call-B'));
  assert.ok(calls[1].input_manifest.items.some((item: any) => item.ref === 'provider-call:call-A'));
  assert.ok(calls[1].input_manifest.items.some((item: any) => item.ref === 'provider-call:call-B'));
  assert.deepEqual(calls[1].memory_node_inputs, [{
    anchor: projectionAnchor,
    input_node_ref: 'provider-result:call-A',
    input_sha256: calls[1].input_manifest.items.find((item: any) => item.ref === 'provider-result:call-A').sha256,
    observation: 'submitted_node_body',
    identity_state: 'producer_origin_resolved',
    source_session_id: sessionId,
    source_episode_id: episodeId,
    source_model_call_id: calls[0].model_call_id,
  }]);
  assert.equal(calls[0].outputs.filter((item: any) => item.kind === 'tool_call').length, 2);
  assert.deepEqual(events.slice(0, 2), ['persist', 'provider:1']);
  assert.ok(calls.every(event => event.outputs.length <= 512 && event.input_manifest.items.length <= 512));
  const captured = entries.filter(entry => entry.event?.type === 'execution_graph').map(entry => JSON.stringify(entry)).join('\n');
  assert.equal(captured.includes('old query'), false, 'metadata does not duplicate source text');
});

test('E2E failure: checkpoint persistence failure stops before model call and emits no consumption', async () => {
  const sessionId = `execution-graph-persist-failure-${Date.now()}`;
  const logger = new SessionTurnLogger('cli', sessionId);
  const coordinator = new CheckpointCompactionCoordinator({ chatStream: async () => ({ content: 'Unpersisted summary.', usage }) } as any, { maxContextTokens: 1000 });
  let providerCalls = 0;
  const runner = new ConversationRunner({ chat: async () => { providerCalls++; return { content: 'unexpected' }; } } as any, {
    getToolDefinitions: () => [], executeTool: async () => { throw new Error('unexpected'); },
  }, {
    stream: false, episodeId: 'failure-episode', toolExecutionContext: { sessionId },
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => { throw new Error('checkpoint persistence unavailable'); },
  });
  await assert.rejects(Logger.withSessionContext(sessionId, logger, () => runner.run([
    { role: 'user', content: 'earlier '.repeat(1600), __episodeId: 'failure-episode' },
    { role: 'assistant', content: 'result '.repeat(1600), __episodeId: 'failure-episode' },
    { role: 'user', content: 'continue', __episodeId: 'failure-episode', __episodeInputKind: 'root' },
    { role: 'system', content: `[transient_runtime]\\n${'x'.repeat(3000)}`, __injected: true },
  ])));
  assert.equal(providerCalls, 0);
  const entries = fs.readFileSync(logger.getLogFilePath(), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(entries.some(entry => ['execution_graph', 'execution_graph_checkpoint'].includes(entry.event?.type)
    && ['checkpoint_persisted', 'successful_model_call'].includes(entry.event.payload?.type)), false);
});

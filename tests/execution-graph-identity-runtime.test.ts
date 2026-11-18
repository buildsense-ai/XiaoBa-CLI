import assert from 'node:assert/strict';
import test from 'node:test';
import { Logger } from '../src/utils/logger';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import { ConversationRunner } from '../src/core/conversation-runner';
import type { Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 5, completionTokens: 3, totalTokens: 8 };
const sharedId = 'reused-provider-call';
const tool: ToolDefinition = { name: 'lookup', description: 'lookup', parameters: { type: 'object' } };

test('runtime origin identity preserves ordinary unique provider refs', async () => {
  const sessionId = `execution-identity-unique-${Date.now()}`;
  const calls: any[] = [];
  const results: any[] = [];
  let turn = 0;
  const runner = new ConversationRunner({
    chat: async () => {
      turn++;
      return turn === 1
        ? { content: 'lookup', toolCalls: [{ id: 'unique-call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }], usage }
        : { content: 'done', toolCalls: [], usage };
    },
  } as any, {
    getToolDefinitions: () => [tool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'unique result', ok: true }),
  } as ToolExecutor, { stream: false, episodeId: 'unique-episode', toolExecutionContext: { sessionId } });
  await runner.run([{ role: 'user', content: 'unique input', __episodeId: 'unique-episode', __episodeInputKind: 'root' }], {
    onExecutionGraphEvent: event => calls.push(event),
    onToolExecutionResult: (_result, _messages, origin) => results.push(origin),
  } as any);
  const producer = calls.find(event => event.outputs.some((item: any) => item.kind === 'tool_call'));
  assert.equal(producer.outputs.find((item: any) => item.kind === 'tool_call').node_ref, 'provider-call:unique-call-1');
  assert.equal(results[0].model_call_id, producer.model_call_id);
  assert.equal(results[0].episode_id, 'unique-episode');
});

test('runtime memory bindings preserve exact origins for identical reused provider results', async () => {
  const sessionId = `execution-memory-origin-${Date.now()}`;
  const anchor = { kind: 'source_memory_projection_node', source_projection_ref: `ref_${'a'.repeat(64)}`, revision: 'b'.repeat(64), id: 'c'.repeat(64) };
  const sourceBody = JSON.stringify({ source: { status: 'read', coverage: 'complete', text: 'Pinned source body.', anchor } });
  const calls: any[] = [];
  const runEpisode = async (episodeId: string, input: Message[]): Promise<Message[]> => {
    let turn = 0;
    const runner = new ConversationRunner({
      chat: async () => {
        turn++;
        return turn === 1
          ? { content: null, toolCalls: [{ id: sharedId, type: 'function', function: { name: 'lookup', arguments: '{}' } }], usage }
          : { content: `done ${episodeId}`, toolCalls: [], usage };
      },
    } as any, {
      getToolDefinitions: () => [tool],
      executeTool: async (call: ToolCall): Promise<ToolResult> => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: sourceBody, ok: true }),
    } as ToolExecutor, { stream: false, episodeId, toolExecutionContext: { sessionId } });
    const result = await runner.run(input, { onExecutionGraphEvent: event => calls.push(event) } as any);
    return result.messages;
  };
  let messages = await runEpisode('episode-one', [{ role: 'user', content: 'read source one', __episodeId: 'episode-one', __episodeInputKind: 'root' }]);
  const firstProducer = calls.find(event => event.outputs.some((output: any) => output.provider_call_id === sharedId));
  messages.push({ role: 'user', content: 'read source two', __episodeId: 'episode-two', __episodeInputKind: 'root' });
  messages = await runEpisode('episode-two', messages);
  const producers = calls.filter(event => event.outputs.some((output: any) => output.provider_call_id === sharedId));
  const finalCall = calls[calls.length - 1];
  const bindings = finalCall.memory_node_inputs;
  assert.equal(producers.length, 2);
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].input_node_ref, bindings[1].input_node_ref);
  assert.equal(bindings[0].input_sha256, bindings[1].input_sha256);
  assert.deepEqual(new Set(bindings.map((binding: any) => binding.source_model_call_id)), new Set(producers.map(event => event.model_call_id)));
  assert.ok(bindings.every((binding: any) => binding.anchor.id === anchor.id));
  const submitted = finalCall.input_manifest.items.filter((item: any) => item.ref === `provider-result:${sharedId}`);
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every((item: any) => item.sha256 === bindings[0].input_sha256));
  assert.notEqual(submitted[0].source_model_call_id, submitted[1].source_model_call_id);
  assert.ok(firstProducer);
});

test('runtime origin identity: reused provider IDs remain scoped across episodes and a same-episode runner restart', async () => {
  const sessionId = `execution-identity-runtime-${Date.now()}`;
  const logger = new SessionTurnLogger('cli', sessionId);
  const calls: any[] = [];
  const results: any[] = [];
  const run = async (episodeId: string, input: Message[]): Promise<Message[]> => {
    let providerTurn = 0;
    const runner = new ConversationRunner({
      chat: async () => {
        providerTurn++;
        if (providerTurn === 1) return { content: `lookup ${episodeId}`, toolCalls: [{ id: sharedId, type: 'function', function: { name: 'lookup', arguments: '{}' } }], usage };
        return { content: `done ${episodeId}`, toolCalls: [], usage };
      },
    } as any, {
      getToolDefinitions: () => [tool],
      executeTool: async (call: ToolCall): Promise<ToolResult> => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: `result ${episodeId}`, ok: true }),
    } as ToolExecutor, { stream: false, episodeId, toolExecutionContext: { sessionId } });
    const result = await runner.run(input, {
      onExecutionGraphEvent: (event: any) => {
        calls.push(event);
        Logger.runtimeEvent('INFO', 'execution graph model call', { type: 'execution_graph', payload: event });
      },
      onToolExecutionResult: (result: ToolResult, _messages: readonly Message[], origin: any) => {
        const payload = {
          contract_version: 'execution-graph/1', identity_contract: 'execution-identity/1', event_id: `result-${origin?.model_call_id ?? results.length}`,
          session_id: origin?.session_id, episode_id: origin?.episode_id, model_call_id: origin?.model_call_id,
          type: 'function_result', provider_call_id: result.tool_call_id,
          call_node_ref: `provider-call:${result.tool_call_id}`, result_node_ref: `provider-result:${result.tool_call_id}`,
          result_sha256: require('node:crypto').createHash('sha256').update(JSON.stringify(result.content)).digest('hex'), result_state: 'captured',
        };
        results.push(payload);
        Logger.runtimeEvent('INFO', 'execution graph function result', { type: 'execution_graph', payload });
      },
    } as any);
    return result.messages;
  };

  let messages: Message[] = [];
  await Logger.withSessionContext(sessionId, logger, async () => {
    messages = await run('episode-one', [{ role: 'user', content: 'episode one', __episodeId: 'episode-one', __episodeInputKind: 'root' }]);
    messages.push({ role: 'user', content: 'episode two', __episodeId: 'episode-two', __episodeInputKind: 'root' });
    messages = await run('episode-two', messages);
    messages.push({ role: 'user', content: 'resume episode two after runner restart', __episodeId: 'episode-two', __episodeInputKind: 'pending' });
    messages = await run('episode-two', messages);
  });

  assert.equal(calls.length, 6);
  assert.equal(results.length, 3);
  assert.ok(calls.every(event => event.identity_contract === 'execution-identity/1'));
  const producerCalls = calls.filter(event => event.outputs.some((item: any) => item.kind === 'tool_call'));
  assert.equal(producerCalls.length, 3);
  const callOutputs = producerCalls.map(event => event.outputs.find((item: any) => item.kind === 'tool_call'));
  assert.ok(callOutputs.every(output => output.node_ref === `provider-call:${sharedId}`), 'raw provider refs remain in the producer log');
  const assistantRefs = producerCalls.map(event => event.outputs.find((item: any) => item.kind === 'message')?.node_ref).filter(Boolean);
  assert.equal(new Set(assistantRefs).size, 3, 'assistant output refs stay unique through same-episode runner restart');
  for (let index = 0; index < results.length; index++) {
    assert.equal(results[index].model_call_id, producerCalls[index].model_call_id, 'result names its producing successful call');
    assert.equal(results[index].session_id, sessionId);
    assert.equal(results[index].episode_id, producerCalls[index].episode_id);
    assert.equal(results[index].provider_call_id, sharedId);
  }
  const lastItems = calls[4].input_manifest.items.filter((item: any) => item.ref === `provider-result:${sharedId}`);
  const origins = new Set(lastItems.map((item: any) => item.source_model_call_id));
  assert.ok(origins.has(producerCalls[0].model_call_id), 'episode-one result retains its source call through later input');
  assert.ok(origins.has(producerCalls[1].model_call_id), 'episode-two result retains its source call after restart');
  assert.ok(lastItems.every((item: any) => item.source_session_id === sessionId && item.source_episode_id));
  assert.ok(calls[4].input_manifest.items.some((item: any) => item.source_model_call_id === producerCalls[1].model_call_id
    && item.ref === assistantRefs[1]), `assistant output origin survives message persistence into a later manifest: ${JSON.stringify(calls[4].input_manifest.items.map((item: any) => ({ ref: item.ref, source_model_call_id: item.source_model_call_id })))}`);
});

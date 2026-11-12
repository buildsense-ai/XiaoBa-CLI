import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';
import { ConversationRunner } from '../src/core/conversation-runner';
import { resolveExecutionFixtureConfig, type ExecutionFixtureConfig } from '../src/core/execution-memory-fixture-config';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { Logger } from '../src/utils/logger';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import type { Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 40, completionTokens: 12, totalTokens: 52 };
const episode = 'execution-fixture-episode';
function historyBeforeRoot(repetitions = 160): Message[] {
  return [
    { role: 'user', content: 'Earlier request '.repeat(repetitions), __episodeId: episode },
    { role: 'assistant', content: 'Earlier response '.repeat(repetitions), __episodeId: episode },
  ];
}

function writeLines(filePath: string, entries: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
}
function readSessionEntries(logger: SessionTurnLogger): any[] {
  return fs.readFileSync(logger.getLogFilePath(), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function runtimeEvents(entries: any[]): any[] {
  return entries.filter(entry => entry.entry_type === 'runtime'
    && ['execution_graph', 'execution_graph_checkpoint'].includes(entry.event?.type));
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function runSessionA(sessionId: string, runtimePath: string): Promise<Record<string, unknown>> {
  const logger = new SessionTurnLogger('cli', sessionId);
  const checkpointPath = `${runtimePath}.checkpoint.state.json`;
  const coordinator = new CheckpointCompactionCoordinator({
    chatStream: async () => ({ content: 'Earlier work summarized before continuation.', usage }),
  } as any, { maxContextTokens: 1000 });
  const runner = new ConversationRunner({
    chat: async () => ({ content: 'Session A completed the fixture turn.', toolCalls: [], usage }),
  } as any, { getToolDefinitions: () => [], executeTool: async () => { throw new Error('Session A has no tools.'); } } as ToolExecutor, {
    stream: false, episodeId: episode, toolExecutionContext: { sessionId },
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async messages => fs.writeFileSync(checkpointPath, JSON.stringify(messages), { mode: 0o600 }),
  });
  let finalText = '';
  await Logger.withSessionContext(sessionId, logger, async () => {
    const runResult = await runner.run([
      ...historyBeforeRoot(),
      { role: 'user', content: 'Continue the earlier fixture work.', __episodeId: episode, __episodeInputKind: 'root' },
    ], {
      onExecutionGraphEvent: event => Logger.runtimeEvent('INFO', 'execution graph model call', { type: 'execution_graph', payload: event }),
    });
    finalText = runResult.response;
  });
  logger.logTurn('Continue the earlier fixture work.', finalText, [], { prompt: usage.promptTokens, completion: usage.completionTokens });
  const entries = readSessionEntries(logger);
  const runtime = runtimeEvents(entries);
  const checkpointAt = runtime.findIndex(entry => entry.event.type === 'execution_graph_checkpoint');
  const callAt = runtime.findIndex(entry => entry.event.payload?.type === 'successful_model_call');
  if (checkpointAt < 0 || callAt < 0 || checkpointAt > callAt || !fs.existsSync(checkpointPath)) {
    throw new Error('Session A checkpoint was not durably recorded before its first successful provider call.');
  }
  return { sessionId, runtimePath, runtime, turns: entries.filter(entry => entry.entry_type === 'turn'), checkpointPath };
}

async function runSessionB(config: ExecutionFixtureConfig, runtimePath: string): Promise<Record<string, unknown>> {
  if (!config.baseUrl || !config.token || !config.anchor) throw new Error('Session B requires source read URL, token, and anchor.');
  const sessionId = config.sessionId;
  const logger = new SessionTurnLogger('cli', sessionId);
  const client = new CatscoLogAgentClient(config.baseUrl);
  let authenticatedReadMatchesAnchor = false;
  let authenticatedSource: any;
  const recallTool = new CatsLogKnowledgeRecallTool({
    readKnowledgeSource: async (query, signal) => {
      const page = await client.readKnowledgeSource({ ...query, token: config.token, signal });
      const source = page.source;
      authenticatedReadMatchesAnchor = source.status === 'read' && source.coverage === 'complete' && !source.truncated
        && source.anchor.kind === config.anchor!.kind
        && source.anchor.source_projection_ref === config.anchor!.source_projection_ref
        && source.anchor.revision === config.anchor!.revision && source.anchor.id === config.anchor!.id;
      if (!authenticatedReadMatchesAnchor) throw new Error('Authenticated source read did not return the exact complete typed anchor.');
      authenticatedSource = source;
      return page;
    },
  } as any);
  const definition = recallTool.definition as ToolDefinition;
  const executor: ToolExecutor = {
    getToolDefinitions: () => [definition],
    executeTool: async (call: ToolCall, context?: any): Promise<ToolResult> => {
      let result: any;
      try {
        result = await recallTool.execute(JSON.parse(call.function.arguments), context);
      } catch (error: any) {
        throw new Error(`read_source execution failed: ${error?.message || String(error)}`);
      }
      if (!result.ok) throw new Error(result.message || result.errorCode || 'read_source tool failed');
      return { role: 'tool', tool_call_id: call.id, name: call.function.name, content: result.content ?? '', ok: result.ok };
    },
  };
  const coordinator = new CheckpointCompactionCoordinator({
    chatStream: async () => ({ content: 'Earlier work summarized before continuation.', usage }),
  } as any, { maxContextTokens: 12000 });
  const checkpointPath = `${runtimePath}.checkpoint.state.json`;
  let providerCalls = 0;
  const runner = new ConversationRunner({
    chat: async (messages: Message[]) => {
      providerCalls++;
      if (providerCalls === 1) return {
        content: null, usage,
        toolCalls: [{ id: 'fixture-exact-source-read', type: 'function', function: {
          name: definition.name,
          arguments: JSON.stringify({ action: 'read_source', anchor: config.anchor, before: 0, after: 0 }),
        } }],
      };
      const submittedReadResult = messages.find(message => message.role === 'tool' && message.tool_call_id === 'fixture-exact-source-read');
      if (providerCalls === 2 && submittedReadResult) {
        const submittedBody = (() => { try { return JSON.parse(String(submittedReadResult.content ?? '')); } catch { return undefined; } })();
        const submittedSource = submittedBody?.source;
        const sourceFields = (value: any) => value && ({ anchor: value.anchor,
          ...(value.projection_context?.contract_version === 'memory-graph/3'
            ? { projection_context: value.projection_context, content_hash: value.content_hash }
            : { text: value.text, conditions: value.conditions, omissions: value.omissions }),
          coverage: value.coverage, truncated: value.truncated, status: value.status });
        if (JSON.stringify(sourceFields(submittedSource)) !== JSON.stringify(sourceFields(authenticatedSource))) {
          throw new Error('Session B provider input changed source anchor, text, conditions, omissions, or coverage.');
        }
        return { content: 'Session B consumed the exact returned source node.', toolCalls: [], usage };
      }
      throw new Error(`Unexpected deterministic provider request sequence: ${JSON.stringify(messages.map(message => ({ role: message.role,
        tool_call_id: message.tool_call_id ?? null, content_type: typeof message.content,
        content_bytes: typeof message.content === 'string' ? Buffer.byteLength(message.content) : null,
        content_is_json: typeof message.content === 'string' && (() => { try { JSON.parse(message.content); return true; } catch { return false; } })() })))}`);
    },
  } as any, executor, {
    stream: false, episodeId: episode, toolExecutionContext: { sessionId }, checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async messages => fs.writeFileSync(checkpointPath, JSON.stringify(messages), { mode: 0o600 }),
  });
  let finalText = '';
  await Logger.withSessionContext(sessionId, logger, async () => {
    const runResult = await runner.run([
      ...historyBeforeRoot(2000),
      { role: 'user', content: 'Read the exact typed source anchor, then continue.', __episodeId: episode, __episodeInputKind: 'root' },
    ], {
      onExecutionGraphEvent: event => Logger.runtimeEvent('INFO', 'execution graph model call', { type: 'execution_graph', payload: event }),
      onToolExecutionResult: (result, _messages, origin) => Logger.runtimeEvent('INFO', 'execution graph function result', { type: 'execution_graph', payload: {
        contract_version: 'execution-graph/1', identity_contract: 'execution-identity/1', event_id: randomUUID(),
        session_id: origin.session_id, episode_id: origin.episode_id, model_call_id: origin.model_call_id,
        type: 'function_result', call_node_ref: `provider-call:${result.tool_call_id}`,
        result_node_ref: `provider-result:${result.tool_call_id}`, provider_call_id: result.tool_call_id,
        result_sha256: sha256(JSON.stringify(result.content)), result_state: 'captured',
      } }),
    });
    finalText = runResult.response;
  });
  logger.logTurn('Read the exact typed source anchor, then continue.', finalText, [], { prompt: usage.promptTokens, completion: usage.completionTokens });
  const entries = readSessionEntries(logger);
  const runtime = runtimeEvents(entries);
  const calls = decodeSharedRuntime(runtime).filter(entry => entry.event.payload?.type === 'successful_model_call').map(entry => entry.event.payload);
  const functionResults = runtime.filter(entry => entry.event.payload?.type === 'function_result').map(entry => entry.event.payload);
  const producer = calls.find((call: any) => call.outputs.some((output: any) => output.node_ref === 'provider-call:fixture-exact-source-read'));
  if (functionResults.length !== 1 || !producer || functionResults[0].identity_contract !== 'execution-identity/1'
    || functionResults[0].model_call_id !== producer.model_call_id || functionResults[0].session_id !== producer.session_id
    || functionResults[0].episode_id !== producer.episode_id) {
    throw new Error('Session B function-result event lacks the exact successful producer identity.');
  }
  if (!authenticatedReadMatchesAnchor) throw new Error('Session B did not complete the authenticated exact-node read.');
  if (!fs.existsSync(checkpointPath) || calls.length !== 2) throw new Error('Session B checkpoint or two-call request sequence is incomplete.');
  const readBinding = calls[1].memory_node_inputs?.filter((binding: any) =>
    binding.anchor.kind === config.anchor!.kind
    && binding.anchor.source_projection_ref === config.anchor!.source_projection_ref
    && binding.anchor.revision === config.anchor!.revision && binding.anchor.id === config.anchor!.id
    && binding.input_node_ref === 'provider-result:fixture-exact-source-read'
    && calls[1].input_manifest.items.some((item: any) => item.ref === binding.input_node_ref && item.sha256 === binding.input_sha256));
  if (!Array.isArray(readBinding) || readBinding.length !== 1) {
    const submittedTool = calls[1]?.input_manifest?.items?.find((item: any) => item.kind === 'turn_result');
    throw new Error(`Session B successful model call lacks exactly one typed anchor binding to the submitted manifest wrapper SHA: ${JSON.stringify({
      tool_item: submittedTool && { ref: submittedTool.ref, sha256: submittedTool.sha256, content_sha256: submittedTool.content_sha256 },
      memory_node_inputs: calls[1]?.memory_node_inputs ?? [],
    })}`);
  }
  return { sessionId, runtimePath, runtime, turns: entries.filter(entry => entry.entry_type === 'turn'), calls, anchor: config.anchor, binding: readBinding[0], checkpointPath };
}

export function decodeSharedRuntime(entries: any[]): any[] {
  const definitions = new Map<string, any>();
  const epochs = new Map<string, string>();
  return entries.map(entry => {
    const event = entry.event;
    if (event?.type !== 'execution_graph' || event.payload?.input_manifest_encoding !== 'shared-input-manifest/1') return entry;
    const payload = event.payload;
    const scope = entry.session_id;
    const epoch = payload.input_manifest_epoch;
    if (payload.input_manifest_reset) {
      definitions.forEach((_value, key) => { if (key.startsWith(`${scope}:`)) definitions.delete(key); });
      epochs.set(scope, epoch);
    } else if (epochs.get(scope) !== epoch) {
      throw new Error('fixture has shared input without its active reset epoch');
    }
    const items = payload.input_manifest.items.map((row: any) => {
      if (row.definition) {
        const id = sha256(JSON.stringify(row.definition));
        definitions.set(`${scope}:${id}`, row.definition);
        return row.definition;
      }
      const definition = definitions.get(`${scope}:${row.ref}`);
      if (!definition) throw new Error(`fixture has missing shared input definition ${row.ref}`);
      return definition;
    });
    const logicalPayload = Object.fromEntries(Object.entries(payload).filter(([key]) =>
      !['input_manifest_encoding', 'input_manifest_epoch', 'input_manifest_reset'].includes(key)));
    return { ...entry, event: { ...event, payload: { ...logicalPayload, input_manifest: { ...payload.input_manifest, items } } } };
  });
}

function normalizedGraphSummary(sessionResults: any[]): Record<string, unknown> {
  const calls = sessionResults.flatMap(result => result.runtime.map((entry: any) => entry.event.payload)
    .filter((payload: any) => payload?.type === 'successful_model_call'));
  const checkpoints = sessionResults.flatMap(result => result.runtime.map((entry: any) => entry.event.payload)
    .filter((payload: any) => payload?.type === 'checkpoint_persisted'));
  const nodeRefs = new Set<string>();
  for (const call of calls) {
    for (const item of call.input_manifest.items) nodeRefs.add(item.ref);
    for (const output of call.outputs) nodeRefs.add(output.node_ref);
    for (const binding of call.memory_node_inputs ?? []) nodeRefs.add(`memory-node:${binding.anchor.source_projection_ref}:${binding.anchor.revision}:${binding.anchor.id}`);
  }
  for (const checkpoint of checkpoints) for (const ref of checkpoint.covered_node_refs ?? []) nodeRefs.add(ref);
  return {
    contract: 'execution-graph/1',
    session_ids: sessionResults.map(result => result.sessionId).sort(),
    node_refs: [...nodeRefs].sort(),
    hyperedge_ids: calls.map(call => call.model_call_id).sort(),
    checkpoints: checkpoints.map(checkpoint => ({ checkpoint_id: checkpoint.checkpoint_id, version: checkpoint.version,
      covered_node_refs: [...checkpoint.covered_node_refs].sort(), coverage_complete: checkpoint.coverage_complete })).sort((a, b) => a.checkpoint_id.localeCompare(b.checkpoint_id)),
    memory_node_anchors: calls.flatMap(call => (call.memory_node_inputs ?? []).map((binding: any) => ({
      model_call_id: call.model_call_id, input_node_ref: binding.input_node_ref, input_sha256: binding.input_sha256,
      anchor: binding.anchor,
    }))).sort((a: any, b: any) => `${a.anchor.source_projection_ref}:${a.anchor.revision}:${a.anchor.id}`
      .localeCompare(`${b.anchor.source_projection_ref}:${b.anchor.revision}:${b.anchor.id}`)),
  };
}

export async function runExecutionMemoryFixture(config = resolveExecutionFixtureConfig()): Promise<Record<string, unknown>> {
  const rolePaths = config.role === 'both'
    ? { a: `${config.fixturePath}.session_a`, b: `${config.fixturePath}.session_b` }
    : config.role === 'session_a' ? { a: config.fixturePath } : { b: config.fixturePath };
  const results: any[] = [];
  if (rolePaths.a) results.push(await runSessionA(config.role === 'both' ? `${config.sessionId}-a` : config.sessionId, rolePaths.a));
  if (rolePaths.b) results.push(await runSessionB({ ...config, sessionId: config.role === 'both' ? `${config.sessionId}-b` : config.sessionId }, rolePaths.b));

  for (const result of results) {
    const logicalRuntime = decodeSharedRuntime(result.runtime);
    writeLines(result.runtimePath, result.runtime);
    writeLines(`${result.runtimePath}.turn.jsonl`, result.turns);
    const calls = logicalRuntime.map((entry: any) => entry.event.payload).filter((payload: any) => payload?.type === 'successful_model_call');
    writeLines(`${result.runtimePath}.requests.jsonl`, calls.map((call: any) => ({
      session_id: call.session_id, episode_id: call.episode_id, model_call_id: call.model_call_id,
      input_manifest_sha256: call.input_manifest_sha256, input_manifest: call.input_manifest,
      checkpoint_consumptions: call.checkpoint_consumptions, memory_node_inputs: call.memory_node_inputs,
      outputs: call.outputs, outputs_complete: call.outputs_complete,
    })));
  }
  const graphSummary = normalizedGraphSummary(results.map(result => ({ ...result, runtime: decodeSharedRuntime(result.runtime) })));
  const graphSummaryJson = `${JSON.stringify(graphSummary, null, 2)}\n`;
  const summaryPath = `${config.fixturePath}.graph-summary.json`;
  fs.writeFileSync(summaryPath, graphSummaryJson, { mode: 0o600 });
  fs.writeFileSync(`${config.fixturePath}.graph-summary.sha256`, `${sha256(graphSummaryJson)}\n`, { mode: 0o600 });
  const report = {
    role: config.role, session_ids: results.map(result => result.sessionId),
    runtime_paths: results.map(result => result.runtimePath),
    turn_paths: results.map(result => `${result.runtimePath}.turn.jsonl`),
    graph_summary_path: summaryPath, graph_summary_sha256_path: `${config.fixturePath}.graph-summary.sha256`,
    exact_memory_node_binding: results.some(result => Boolean(result.binding)),
  };
  fs.writeFileSync(`${config.fixturePath}.report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  runExecutionMemoryFixture().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

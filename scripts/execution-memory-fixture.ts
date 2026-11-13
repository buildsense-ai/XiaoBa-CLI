import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';
import { ConversationRunner } from '../src/core/conversation-runner';
import { resolveExecutionFixtureConfig, type ExecutionFixtureConfig } from '../src/core/execution-memory-fixture-config';
import { CATSLOG_KNOWLEDGE_RECALL_TOOL_NAME } from '../src/tools/catslog-knowledge-recall-tool';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { Logger } from '../src/utils/logger';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import type { Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';
import type { CatsLogKnowledgeSourceQuery } from '../src/utils/catslog-knowledge-types';

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

/**
 * Session B follows the recall layering (docs/catslog-recall-layering.md): the
 * main agent's earlier Diary read cites the Memory node; the Memory Branch reads
 * that exact node through the authenticated source route; the runtime injects the
 * Branch result late, into the second main-agent call. The fixture's Diary
 * citation stands in for a Diary written after Session A.
 */
async function runSessionB(config: ExecutionFixtureConfig, runtimePath: string): Promise<Record<string, unknown>> {
  if (!config.baseUrl || !config.token || !config.anchor) throw new Error('Session B requires source read URL, token, and anchor.');
  const sessionId = config.sessionId;
  const logger = new SessionTurnLogger('cli', sessionId);
  const client = new CatscoLogAgentClient(config.baseUrl);
  const anchor = config.anchor;
  let authenticatedReadMatchesAnchor = false;
  const backend = {
    isAvailable: () => true,
    // No discovery: the Branch reaches the node only through the Diary citation.
    branch: async () => ({ schema_version: 1, request_id: 'fixture-no-discovery', status: 'ok', branches: [] }),
    readKnowledgeSource: async (query: CatsLogKnowledgeSourceQuery, signal?: AbortSignal) => {
      const page = await client.readKnowledgeSource({ ...query, token: config.token, signal });
      const source = page.source;
      authenticatedReadMatchesAnchor = source.status === 'read' && source.coverage === 'complete' && !source.truncated
        && source.anchor.kind === anchor.kind && source.anchor.source_projection_ref === anchor.source_projection_ref
        && source.anchor.revision === anchor.revision && source.anchor.id === anchor.id;
      if (!authenticatedReadMatchesAnchor) throw new Error('Authenticated source read did not return the exact complete typed anchor.');
      return page;
    },
  };
  const diaryEntry = { id: 'ake-fixture-diary', title: 'Fixture Diary entry', text: 'Diary entry citing the Session A Memory node.', status: 'draft', source_anchors: [anchor] };
  const diaryRead: Message[] = [
    { role: 'user', content: 'Recall the Diary entry for this work.', __episodeId: episode },
    { role: 'assistant', content: null, __episodeId: episode, tool_calls: [{ id: 'fixture-diary-read', type: 'function',
      function: { name: CATSLOG_KNOWLEDGE_RECALL_TOOL_NAME, arguments: JSON.stringify({ action: 'read', document_id: 'akd-fixture-diary' }) } }] },
    { role: 'tool', tool_call_id: 'fixture-diary-read', name: CATSLOG_KNOWLEDGE_RECALL_TOOL_NAME, __episodeId: episode,
      content: JSON.stringify({ document_id: 'akd-fixture-diary', revision: 'akr-fixture-diary', entries: [diaryEntry], exhausted: true }) },
    { role: 'assistant', content: 'The Diary entry cites one Memory node.', __episodeId: episode },
  ];

  const queue = new InMemorySyntheticObservationQueue();
  const seedHandle = `memory-node:${anchor.source_projection_ref}:${anchor.revision}:${anchor.id}`;
  let branchCalls = 0;
  let seededNodes: unknown;
  let deliveredRef: string | undefined;
  const branchAi = {
    isToolCallingSupported: () => true,
    chat: async (messages: Message[]) => {
      branchCalls++;
      if (branchCalls === 1) {
        seededNodes = messages.flatMap(message => {
          try { const body = JSON.parse(String(message.content)); return body?.retrieval_mode === 'document_cited_memory_nodes' ? body.document_cited_memory_nodes : []; } catch { return []; }
        });
      } else {
        try { deliveredRef = JSON.parse(String(messages.at(-1)?.content)).ref; } catch { deliveredRef = undefined; }
      }
      const call = branchCalls === 1
        ? { name: 'memory_node_read', arguments: { node: seedHandle } }
        : { name: 'finish_memory_search', arguments: { summary: 'The Diary-cited Memory node was read completely.', evidence: deliveredRef ? [deliveredRef] : [], inject: Boolean(deliveredRef) } };
      return { content: null, usage, toolCalls: [{ id: `fixture-branch-${branchCalls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
    },
  };
  await new MemorySearchBranchSession({ sessionKey: sessionId, input: 'Continue the lock review.', recentMessages: diaryRead,
    workingDirectory: path.dirname(runtimePath), aiService: branchAi as any, queue, catslogMemory: backend as any, logEnabled: false }).run();
  if (JSON.stringify(seededNodes) !== JSON.stringify([{ node: seedHandle }])) throw new Error('Branch was not seeded by the Diary citation.');
  if (!authenticatedReadMatchesAnchor || queue.size() !== 1) throw new Error('Branch did not complete the authenticated exact-node read.');

  const continueTool: ToolDefinition = { name: 'continue_work', description: 'Continue the fixture work.', parameters: { type: 'object', properties: {} } };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [continueTool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'continued', ok: true }),
  };
  const coordinator = new CheckpointCompactionCoordinator({
    chatStream: async () => ({ content: 'Earlier work summarized before continuation.', usage }),
  } as any, { maxContextTokens: 12000 });
  const checkpointPath = `${runtimePath}.checkpoint.state.json`;
  let providerCalls = 0;
  let observationsDrained = 0;
  const runner = new ConversationRunner({
    chat: async (messages: Message[]) => {
      providerCalls++;
      const injected = messages.some(message => message.__syntheticObservation === true);
      if (providerCalls === 1 && !injected) return { content: null, usage,
        toolCalls: [{ id: 'fixture-continue', type: 'function', function: { name: continueTool.name, arguments: '{}' } }] };
      if (providerCalls === 2 && injected) return { content: 'Session B consumed the Diary-cited Memory node.', toolCalls: [], usage };
      throw new Error(`Unexpected deterministic provider request sequence: call=${providerCalls} injected=${injected}`);
    },
  } as any, executor, {
    stream: false, episodeId: episode, toolExecutionContext: { sessionId }, checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async messages => fs.writeFileSync(checkpointPath, JSON.stringify(messages), { mode: 0o600 }),
    // A late Branch result: absent from call 1, delivered before the next call.
    syntheticObservationProvider: progress => {
      if (!progress.some(message => message.role === 'tool' && message.tool_call_id === 'fixture-continue')) return [];
      observationsDrained++;
      return queue.drain();
    },
  });
  let finalText = '';
  await Logger.withSessionContext(sessionId, logger, async () => {
    const runResult = await runner.run([
      ...historyBeforeRoot(2000),
      ...diaryRead,
      { role: 'user', content: 'Continue the lock review.', __episodeId: episode, __episodeInputKind: 'root' },
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
  logger.logTurn('Continue the lock review.', finalText, [], { prompt: usage.promptTokens, completion: usage.completionTokens });
  const entries = readSessionEntries(logger);
  const runtime = runtimeEvents(entries);
  const calls = decodeSharedRuntime(runtime).filter(entry => entry.event.payload?.type === 'successful_model_call').map(entry => entry.event.payload);
  const functionResults = runtime.filter(entry => entry.event.payload?.type === 'function_result').map(entry => entry.event.payload);
  const producer = calls.find((call: any) => call.outputs.some((output: any) => output.node_ref === 'provider-call:fixture-continue'));
  if (functionResults.length !== 1 || !producer || functionResults[0].identity_contract !== 'execution-identity/1'
    || functionResults[0].model_call_id !== producer.model_call_id || functionResults[0].session_id !== producer.session_id
    || functionResults[0].episode_id !== producer.episode_id) {
    throw new Error('Session B function-result event lacks the exact successful producer identity.');
  }
  if (!fs.existsSync(checkpointPath) || calls.length !== 2 || observationsDrained !== 1) {
    throw new Error('Session B checkpoint, late Branch delivery, or two-call request sequence is incomplete.');
  }
  if ((calls[0].memory_node_inputs ?? []).length !== 0) throw new Error('Late Branch evidence was bound to the call that preceded it.');
  const readBinding = calls[1].memory_node_inputs?.filter((binding: any) =>
    binding.anchor.kind === anchor.kind
    && binding.anchor.source_projection_ref === anchor.source_projection_ref
    && binding.anchor.revision === anchor.revision && binding.anchor.id === anchor.id
    && binding.identity_state === 'programmatic_observation'
    && /^runtime-observation:[A-Za-z0-9._-]+:result$/.test(binding.input_node_ref)
    && calls[1].input_manifest.items.some((item: any) => item.ref === binding.input_node_ref && item.sha256 === binding.input_sha256));
  if (!Array.isArray(readBinding) || readBinding.length !== 1) {
    throw new Error(`Session B successful model call lacks exactly one Branch-delivered typed anchor binding: ${JSON.stringify({
      memory_node_inputs: calls[1]?.memory_node_inputs ?? [],
    })}`);
  }
  return { sessionId, runtimePath, runtime, turns: entries.filter(entry => entry.entry_type === 'turn'), calls, anchor, binding: readBinding[0], checkpointPath };
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

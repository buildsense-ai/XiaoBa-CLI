import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Message, ChatResponse, ToolDefinition } from '../src/types';

const isolatedDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-late-branch-data-'));
const previousDataRoot = process.env.XIAOBA_USER_DATA_DIR;
process.env.XIAOBA_USER_DATA_DIR = isolatedDataRoot;

const usage = { promptTokens: 8, completionTokens: 3, totalTokens: 11 };
const revision = 'a'.repeat(64);
const projectionRef = `ref_${createHash('sha256').update(`smp_${revision}\0source-memory:fixture-stream:${revision}`).digest('hex')}`;
const nodeId = createHash('sha256').update('late-memory-branch-node').digest('hex');
const sourceAnchor = { kind: 'source_memory_projection_node', source_projection_ref: projectionRef, revision, id: nodeId };
const tool: ToolDefinition = { name: 'continue_work', description: 'continue work', parameters: { type: 'object', properties: {} } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function waitFor<T>(label: string, promise: Promise<T>, ms = 30000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${ms}ms`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function extractExecutionGraphLogRecords(raw: Buffer): Buffer {
  const selected: Buffer[] = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf(0x0a, start);
    const end = newline < 0 ? raw.length : newline + 1;
    const line = raw.subarray(start, end);
    try {
      const entry = JSON.parse(line.toString('utf8'));
      if (entry.entry_type === 'runtime' && entry.event?.type === 'execution_graph') selected.push(line);
    } catch { /* Keep malformed logger records out of the replay fixture. */ }
    start = end;
  }
  return Buffer.concat(selected);
}
function toolCall(id: string): ChatResponse {
  return { content: null, toolCalls: [{ id, type: 'function', function: { name: tool.name, arguments: '{}' } }], usage };
}

async function actualAgentTurn(options: { failFirstDispatch?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-late-memory-branch-'));
  const sessionId = `late-memory-branch-${options.failFirstDispatch ? 'failed' : 'success'}-${Date.now()}`;
  const mainDispatch = deferred<void>();
  const firstResponse = deferred<ChatResponse>();
  const prefetchStarted = deferred<void>();
  const prefetchResponse = deferred<any>();
  const observationQueued = deferred<void>();
  const events: any[] = [];
  const mainRequests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  const mainRequestHashes: string[] = [];
  const branchRequests: Message[][] = [];
  const branchOperations: string[] = [];
  let branchTurn = 0;
  let branchCallCount = 0;
  let runSettled = false;
  let originalPush: any;
  let originalRuntimeEvent: any;
  let abortController: AbortController | undefined;
  let running: Promise<any> | undefined;

  try {
    const [agent, synthetic, context, ai, loggerModule, turnLoggerModule, fixture] = await Promise.all([
      import('../src/core/agent-turn-controller'),
      import('../src/core/synthetic-observation'),
      import('../src/core/turn-context-builder'),
      import('../src/utils/ai-service'),
      import('../src/utils/logger'),
      import('../src/utils/session-turn-logger'),
      import('./helpers/catslog-projection-reference-fixture'),
    ]);
    class ScriptedAIService extends ai.AIService {
      constructor(config: any, private handler: (messages: Message[], tools?: ToolDefinition[], options?: any) => Promise<ChatResponse>) {
        super(config);
      }
      override isToolCallingSupported(): boolean {
        return true;
      }
      override chatStream(messages: Message[], tools?: ToolDefinition[], _callbacks?: any, options?: any): Promise<ChatResponse> {
        return this.handler(messages, tools, options);
      }
      override chat(messages: Message[], tools?: ToolDefinition[], options?: any): Promise<ChatResponse> {
        return this.handler(messages, tools, options);
      }
    }
    const mainAi = new ScriptedAIService(
      { provider: 'openai', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake', model: 'scripted', modelCapabilities: { toolCalling: true } },
      async (messages, tools, options) => {
        const index = mainRequests.length;
        const snapshot = structuredClone({ messages, tools: tools ?? [] });
        mainRequests.push(snapshot);
        mainRequestHashes.push(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'));
        if (index === 0) {
          mainDispatch.resolve();
          return new Promise((resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('scripted request aborted during cleanup')), { once: true });
            firstResponse.promise.then(resolve, reject);
          });
        }
        return { content: 'The next request received the late branch result.', toolCalls: [], usage };
      },
    );
    const branchAi = new ScriptedAIService(
      { provider: 'openai', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake', model: 'scripted-branch', modelCapabilities: { toolCalling: true } },
      async messages => {
        branchTurn++;
        branchRequests.push(structuredClone(messages));
        if (branchTurn === 1) {
          branchOperations.push('memory_remote_search');
          return { content: null, toolCalls: [{ id: 'branch-search', type: 'function', function: { name: 'memory_remote_search', arguments: JSON.stringify({ keywords: ['Meridian'] }) } }], usage };
        }
        if (branchTurn === 2) {
          branchOperations.push('memory_source_read');
          return { content: null, toolCalls: [{ id: 'branch-read', type: 'function', function: { name: 'memory_source_read', arguments: JSON.stringify({ ref: projectionRef }) } }], usage };
        }
        branchOperations.push('finish_memory_search');
        return { content: null, toolCalls: [{ id: 'branch-finish', type: 'function', function: { name: 'finish_memory_search', arguments: JSON.stringify({ summary: 'A completed branch read returned one precise projection node.', evidence: [projectionRef], inject: true }) } }], usage };
      },
    );
    const projectionRead = fixture.fixtureRead(revision);
    projectionRead.projection.Document.nodes = [{ id: nodeId, kind: 'assertion', text: 'A typed projection node returned by the controlled local source oracle.' }];
    projectionRead.projection.Document.edges = [];
    projectionRead.projection.Document.mappings = [{ node_id: nodeId, source_ref: projectionRef, source_digest: 'b'.repeat(64) }];
    projectionRead.projection.Document.aggregate.leaves = [{ leaf_kind: 'result_synthesis', leaf_ref: projectionRef, leaf_revision: revision }];
    const backend = {
      isAvailable: () => true,
      async branch(query: any) {
        branchCallCount++;
        if (!query.queryText) {
          prefetchStarted.resolve();
          return prefetchResponse.promise;
        }
        branchOperations.push('keyword_branch_search');
        return fixture.fixtureBranch(projectionRef, 'late-branch-search');
      },
      async readSourceMemoryProjection(input: any) {
        branchOperations.push('exact_source_projection_read');
        assert.equal(input.projectionRef, projectionRef);
        return projectionRead;
      },
    };
    const controller = new agent.AgentTurnController({
      sessionKey: sessionId, sessionType: 'cli',
      services: {
        aiService: mainAi,
        memoryBranch: { enabled: true, modelSource: 'catalog', aiService: branchAi },
        catslogMemory: backend as any,
        toolManager: {
          getToolDefinitions: () => [tool],
          executeTool: async (call: any) => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'tool completed', ok: true }),
        } as any,
        skillManager: {} as any,
      },
      skillRuntime: { reloadSkills: async () => undefined, buildSkillsListMessage: () => null } as any,
      planRuntime: undefined as any,
      turnContextBuilder: new context.TurnContextBuilder(),
      turnLogRecorder: { recordTurn: () => undefined } as any,
      workspaceRoot: root,
      getCurrentDirectory: () => root,
      updateCurrentDirectory: () => undefined,
    });
    const logger = new turnLoggerModule.SessionTurnLogger('cli', sessionId);
    const queuePrototype = synthetic.InMemorySyntheticObservationQueue.prototype;
    originalPush = queuePrototype.push;
    queuePrototype.push = function(observation: any) {
      const pushed = originalPush.call(this, observation);
      if (pushed && observation.source === 'memory') observationQueued.resolve();
      return pushed;
    };
    originalRuntimeEvent = loggerModule.Logger.runtimeEvent;
    loggerModule.Logger.runtimeEvent = function(level: string, message: string, event: any) {
      if (event?.type === 'execution_graph') events.push(structuredClone(event.payload));
      return originalRuntimeEvent.call(this, level, message, event);
    };
    abortController = new AbortController();
    running = loggerModule.Logger.withSessionContext(sessionId, logger, () => controller.run({
      input: 'Continue the Meridian retention review.', messages: [], runtimeFeedback: [], shouldContinue: () => true,
      abortSignal: abortController!.signal,
    }));
    running.then(() => { runSettled = true; }, () => { runSettled = true; });
    await waitFor('main provider call 1 dispatch', mainDispatch.promise);
    await waitFor('real MemorySearchBranchSession initial prefetch', prefetchStarted.promise);
    prefetchResponse.resolve(fixture.fixtureBranch(projectionRef, 'late-branch-prefetch'));
    await waitFor('real branch observation queue publication', observationQueued.promise);
    if (options.failFirstDispatch) {
      firstResponse.reject(new Error('scripted dispatch failure after branch completed'));
      await assert.rejects(waitFor('failed controller dispatch settlement', running), /scripted dispatch failure/);
    } else {
      firstResponse.resolve(toolCall('main-work'));
      await waitFor('controller completion after next eligible provider call', running);
    }
    const rawLoggerBytes = fs.existsSync(logger.getLogFilePath()) ? fs.readFileSync(logger.getLogFilePath()) : Buffer.alloc(0);
    const rawLogBytes = extractExecutionGraphLogRecords(rawLoggerBytes);
    return { sessionId, events, mainRequests, mainRequestHashes, branchRequests, branchCallCount, branchOperations, nodeAnchor: sourceAnchor, rawLogBytes };
  } finally {
    if (!runSettled) {
      abortController?.abort();
      if (running) await Promise.race([running.then(() => undefined, () => undefined), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    if (originalPush) (await import('../src/core/synthetic-observation')).InMemorySyntheticObservationQueue.prototype.push = originalPush;
    if (originalRuntimeEvent) (await import('../src/utils/logger')).Logger.runtimeEvent = originalRuntimeEvent;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('D5: actual MemorySearchBranchSession late result is excluded from call 1 and bound only to the next submitted call', async () => {
  // Failure assertions defined before production edits:
  // 1. Call 1 dispatches while the actual sidecar prefetch is unresolved.
  // 2. The typed source result and completed observation arrive while call 1 is pending; call 1's captured request and successful event stay unchanged.
  // 3. The real AgentTurnController queue drain injects the branch result into call 2, whose exact node/version binding matches that submitted result and consumer call.
  // 4. A failed call 1 after branch completion emits no successful consumer event or binding.
  try {
    const successful = await actualAgentTurn({});
    assert.equal(successful.branchCallCount, 2, 'actual branch performed prefetch and keyword search');
    assert.deepEqual(successful.branchOperations, ['memory_remote_search', 'keyword_branch_search', 'memory_source_read', 'exact_source_projection_read', 'finish_memory_search']);
    assert.equal(successful.branchRequests.length, 3, 'actual branch provider completed search, read, and finish');
    assert.equal(successful.mainRequests.length, 2);
    assert.equal(createHash('sha256').update(JSON.stringify(successful.mainRequests[0])).digest('hex'), successful.mainRequestHashes[0],
      'call 1 dispatch snapshot stayed byte stable after the branch completed');
    assert.equal(createHash('sha256').update(JSON.stringify(successful.mainRequests[1])).digest('hex'), successful.mainRequestHashes[1]);
    const successfulCalls = successful.events.filter(event => event.type === 'successful_model_call');
    assert.equal(successfulCalls.length, 2);
    const [call1, call2] = successfulCalls;
    assert.equal(successful.mainRequests[0].messages.some(message => String(message.content).includes(projectionRef)), false,
      'dispatch-time call 1 request excludes the late typed source result');
    assert.equal(call1.memory_node_inputs.length, 0, 'call 1 manifest has no late memory membership');
    assert.equal(call1.input_manifest.items.some((item: any) => String(item.ref).startsWith('runtime-observation:')), false,
      'call 1 immutable input manifest has no programmatic branch result');
    assert.ok(successful.mainRequests[1].messages.some(message => String(message.content).includes(projectionRef)),
      'actual branch result was submitted to call 2');
    assert.deepEqual(call2.memory_node_inputs.map((binding: any) => binding.anchor), [successful.nodeAnchor]);
    const binding = call2.memory_node_inputs[0];
    const inputItem = call2.input_manifest.items.find((item: any) => item.ref === binding.input_node_ref);
    assert.ok(inputItem, 'consumer manifest contains the exact submitted tool-result item');
    assert.equal(inputItem.kind, 'message');
    assert.equal(inputItem.identity_state, 'programmatic_observation');
    assert.equal(inputItem.source_session_id, successful.sessionId);
    assert.equal(inputItem.source_episode_id, call2.episode_id);
    assert.equal(inputItem.source_model_call_id, undefined);
    assert.equal(binding.carrier, 'programmatic_observation');
    assert.equal(binding.identity_state, 'programmatic_observation');
    assert.equal(binding.source_session_id, successful.sessionId);
    assert.equal(binding.source_episode_id, call2.episode_id);
    assert.equal(binding.source_model_call_id, undefined);
    assert.match(binding.input_node_ref, /^runtime-observation:[A-Za-z0-9._-]+:result$/);
    assert.equal(binding.input_sha256, inputItem.sha256, 'binding hash equals exact submitted wrapper hash');
    const submittedObservation = successful.mainRequests[1].messages.find(message => message.role === 'tool' && message.name === 'runtime_observation');
    assert.ok(submittedObservation, 'direct dispatch snapshot contains the programmatic observation message');
    assert.equal(binding.input_sha256, createHash('sha256').update(JSON.stringify({
      role: submittedObservation.role,
      content: submittedObservation.content,
      tool_calls: submittedObservation.tool_calls,
      tool_call_id: submittedObservation.tool_call_id,
    })).digest('hex'), 'binding hash also matches the actual submitted request message wrapper');
    assert.equal(successful.events.some(event => event.type === 'function_result' && String(event.provider_call_id).startsWith('synthetic-')), false,
      'programmatic observation does not fabricate a provider Function result');
    assert.ok(call2.model_call_id, 'the successful call carrying the binding owns the consumer model_call_id');
    assert.notEqual(call1.model_call_id, call2.model_call_id);

    const failed = await actualAgentTurn({ failFirstDispatch: true });
    assert.equal(failed.events.filter(event => event.type === 'successful_model_call').length, 0,
      'failed provider dispatch cannot create successful consumption evidence');

    const report = {
      schema: 'catslog.execution_late_memory_branch.v1',
      path: 'actual AgentTurnController -> ConversationRunner -> startMemorySidecarBranch -> MemorySearchBranchSession',
      external_provider_calls: 0,
      scripted_provider_dispatches: { main: successful.mainRequests.length, branch: successful.branchRequests.length },
      branch_operations: successful.branchOperations,
      dispatch_order: ['main call 1 dispatched while prefetch pending', 'branch completed while call 1 pending', 'main call 1 completed', 'main call 2 dispatched with injection'],
      raw_logger_sha256: createHash('sha256').update(successful.rawLogBytes).digest('hex'),
      raw_logger_record_selection: 'execution_graph JSONL records copied byte for byte from the actual session logger',
      raw_logger_bytes: successful.rawLogBytes.length,
      first_call_memory_node_inputs: call1.memory_node_inputs.length,
      first_call_input_manifest_sha256: call1.input_manifest_sha256,
      first_call_request_sha256: successful.mainRequestHashes[0],
      second_call_input_manifest_sha256: call2.input_manifest_sha256,
      second_call_request_sha256: successful.mainRequestHashes[1],
      second_call_consumer_model_call_id: call2.model_call_id,
      second_call_typed_anchor: successful.nodeAnchor,
      binding_input_node_ref: binding.input_node_ref,
      binding_wrapper_sha256: binding.input_sha256,
      failed_dispatch_success_events: failed.events.filter(event => event.type === 'successful_model_call').length,
      semantic_adoption_claimed: false,
    };
    const evidenceDir = process.env.CATSLOG_EXECUTION_EVIDENCE_DIR
      ?? fs.mkdtempSync(path.join(os.tmpdir(), 'catslog-execution-evidence-'));
    const reportPath = path.join(evidenceDir, 'reports', 'late-memory-branch.json');
    const rawLogPath = path.join(evidenceDir, 'reports', 'late-memory-branch-session.jsonl');
    const expectationPath = path.join(evidenceDir, 'reports', 'late-memory-branch-expected.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(rawLogPath, successful.rawLogBytes, { mode: 0o600 });
    const copiedRawLog = fs.readFileSync(rawLogPath);
    assert.deepEqual(copiedRawLog, successful.rawLogBytes, 'raw logger capture was copied byte for byte');
    fs.writeFileSync(expectationPath, `${JSON.stringify({
      session_id: successful.sessionId,
      model_call_id: call2.model_call_id,
      input_manifest_sha256: call2.input_manifest_sha256,
      input_manifest_items: call2.input_manifest.items,
      request_sha256: successful.mainRequestHashes[1],
      memory_input: binding,
    }, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  } finally {
    fs.rmSync(isolatedDataRoot, { recursive: true, force: true });
    if (previousDataRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousDataRoot;
  }
});

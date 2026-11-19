import {fixtureBranch, fixtureRead, fixtureRef} from './helpers/catslog-projection-reference-fixture';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';
import { AgentSession } from '../src/core/agent-session';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { SessionMemoryBranchStore, normalizeMemoryBranchScope } from '../src/core/session-memory-branch';
import { SessionStore } from '../src/utils/session-store';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import type { ChatConfig, ChatResponse, Message, ToolDefinition } from '../src/types';
import { AIService } from '../src/utils/ai-service';
import { Logger } from '../src/utils/logger';

const usage = { promptTokens: 8, completionTokens: 3, totalTokens: 11 };
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-memory-branch-data-'));
const previousDataRoot = process.env.XIAOBA_USER_DATA_DIR;
process.env.XIAOBA_USER_DATA_DIR = dataRoot;

const report: Record<string, any> = {
  schema: 'catsco.session_memory_branch.report.v1',
  data_root: dataRoot,
  fixtures: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function waitFor<T>(label: string, promise: Promise<T>, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${ms}ms`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function poll(label: string, predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const refs = {refA: fixtureRef('a'.repeat(64)), refB: fixtureRef('b'.repeat(64))};
const catslogFixture = {
  isAvailable: () => true,
  async branch() {
    const response = fixtureBranch(refs.refA);
    response.branches[0].items.push({...response.branches[0].items[0], ref: refs.refB});
    return response;
  },
  async readSourceMemoryProjection({projectionRef}: {projectionRef: string}) {
    const second = projectionRef === refs.refB;
    const response = fixtureRead((second ? 'b' : 'a').repeat(64));
    response.projection.Document.summary = second ? 'Narration verified for delivered export.' : 'Repair report approved.';
    return response;
  },
};

class ScriptedAI extends AIService {
  requests: Message[][] = [];
  constructor(config: Partial<ChatConfig>, private readonly handler: (messages: Message[], tools?: ToolDefinition[]) => Promise<ChatResponse>) {
    super(config as ChatConfig);
  }
  override isToolCallingSupported(): boolean { return true; }
  override chatStream(messages: Message[], tools?: ToolDefinition[], _callbacks?: any, _options?: any): Promise<ChatResponse> {
    this.requests.push(structuredClone(messages));
    return this.handler(messages, tools);
  }
  override chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push(structuredClone(messages));
    return this.handler(messages, tools);
  }
}

function toolCall(id: string, name: string, args: unknown) {
  return { content: null, toolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }], usage };
}

interface Relay {
  config: ChatConfig;
  actions: Array<{ action: string; task_id: string; at: number }>;
  server: Server;
}

async function startCreditRelay(t: TestContext): Promise<Relay> {
  const actions: Relay['actions'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/credit-tasks') {
      actions.push({ action: body.action, task_id: body.task_id, at: Date.now() });
      res.end(JSON.stringify({
        enabled: true, allowed: true, task_id: body.task_id,
        state: body.action === 'finish' ? 'completed' : 'running',
        spendable_units: 100, debt_units: 0,
      }));
      return;
    }
    res.statusCode = 500;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as any).port;
  return {
    actions,
    server,
    config: {
      apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'relay-key', model: 'scripted',
      provider: 'openai', catsCoRelay: true, modelCapabilities: { toolCalling: true },
    } as ChatConfig,
  };
}

function toolManager() {
  return {
    getToolDefinitions: () => [{ name: 'continue_work', description: 'continue', parameters: { type: 'object', properties: {} } }],
    executeTool: async (call: any) => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'tool completed', ok: true }),
    getWorkspaceRoot: () => dataRoot,
  } as any;
}

function createSession(options: {
  relay: Relay;
  mainAi: AIService;
  branchAi: AIService;
  key: string;
}): AgentSession {
  const session = new AgentSession(options.key, {
    aiService: options.mainAi, catslogMemory: catslogFixture,
    memoryBranch: { enabled: true, modelSource: 'catalog', aiService: options.branchAi },
    toolManager: toolManager(),
    skillManager: {
      getSkill: () => undefined, getUserInvocableSkills: () => [], getAutoInvocableSkills: () => [],
      findAutoInvocableSkillByText: () => undefined, loadSkills: async () => undefined,
    } as any,
  } as any);
  session.setSystemPromptProvider(() => 'Test system prompt');
  return session;
}

function executionScope(actorUserId: string, topicId = 'grp_7445') {
  return {
    source: 'catscompany' as const, sessionKey: `session:grp_7445:${actorUserId}`, topicId, topicType: 'group' as const,
    actorUserId, identityTrust: 'server_canonical' as const, isTrusted: true,
  };
}

function captureRuntimeEvents(): { events: any[]; restore: () => void } {
  const events: any[] = [];
  const original = Logger.runtimeEvent;
  Logger.runtimeEvent = function (level: string, message: string, event: any) {
    if (event?.type) events.push({ type: event.type, payload: structuredClone(event.payload) });
    return original.call(this, level, message, event);
  };
  return { events, restore: () => { Logger.runtimeEvent = original; } };
}

test('a completed read batch uses the next existing Branch request for its evidence decision', async t => {
  const { MemorySearchBranchSession } = await import('../src/core/memory-search-branch-session');
  const { refA, refB } = refs;
  const calls: string[] = [];
  const publications: any[] = [];
  const events: any[] = [];
  const ai = new ScriptedAI({provider:'openai',apiUrl:'http://127.0.0.1:1/v1',model:'scripted',apiKey:'fixture'}, async messages => {
    const last = [...messages].reverse().find(m => m.role === 'tool');
    const step = calls.length;
    calls.push(last?.name ?? 'start');
    if (!step) {
      events.push({kind:'user_input',sequence:2,turn:2,text:'Does the export contain narration?'});
      return toolCall('clip', 'memory_source_read', { ref: 'ref_' + 'c'.repeat(64) });
    }
    if (step === 1) {
      assert.ok(JSON.stringify(messages).includes('Does the export contain narration?'));
      assert.ok(JSON.stringify(messages).includes('evidence_decision'));
      return toolCall('invalid', 'publish_memory_finding', { subject:'export',claim:'approved',evidence:[refA] });
    }
    if (step === 2) {
      assert.match(String(last?.content), /read|完整|invalid canonical/i);
      return toolCall('full', 'memory_source_read', {ref:refB});
    }
    if (step === 3) return toolCall('report', 'publish_memory_finding', {subject:'export',claim:'Narration remains open',evidence:[refB]});
    if (step === 4) return toolCall('end', 'finish_memory_search', {summary:'No more evidence',evidence:[],inject:false});
    return {content:'done',toolCalls:[],usage};
  });
  const branch = new MemorySearchBranchSession({catslogMemory: catslogFixture as any, workingDirectory:dataRoot, aiService:ai, input:'Draft note',recentMessages:[], queue:{push:()=>true} as any,
    session:{inputSequence:1, originTurn:1, originTurnId:'one',scope:executionScope('usr275'),currentInputSequence:()=>2,
      takeEvents:()=>events.splice(0), heldObservations:()=>[], publish:(finding: any,_id: string,seq: number,observation: any)=>{
        assert.equal(observation.metadata.memory_branch.schema, 'catsco.memory_branch.v1');
        assert.deepEqual(observation.metadata.deliveredRemoteRefs, observation.metadata.memory_branch.read_refs.slice(-1));
        publications.push({finding,seq}); return {ok:true,verifiedThroughInput:seq};
      } } as any } as any);
  await branch.run();
  assert.deepEqual(publications.map(p=>[p.finding.sourceRefs,p.seq]), [[[refB],2]]);
  assert.equal(branch.branchTermination,'finished');
  report.fixtures.evidence_decision = { calls, publications, outcome:branch.branchTermination };
});

test('19:12 replay: the reply ends, the Branch keeps running and terminalizes, the follow-up is admitted immediately, A settles once', async t => {
  const relay = await startCreditRelay(t);
  const { refA, refB } = refs;
  const sessionKey = `session:v2:catscompany:group:grp_7445:agent:usr1:${Date.now()}`;
  const capture = captureRuntimeEvents();
  const mainReplyGate = deferred<void>();
  const followUpGate = deferred<void>();
  const branchPublishGate = deferred<void>();
  let mainCall = 0;

  const mainAi = new ScriptedAI(relay.config, async () => {
    mainCall += 1;
    if (mainCall === 1) {
      await mainReplyGate.promise;
      return { content: 'The delivery note is drafted from the approved picture edit.', toolCalls: [], usage };
    }
    if (mainCall === 2) {
      await followUpGate.promise;
      return { content: 'Follow-up acknowledged.', toolCalls: [], usage };
    }
    return { content: 'done', toolCalls: [], usage };
  });
  let branchCall = 0;
  const branchAi = new ScriptedAI(relay.config, async (messages) => {
    branchCall += 1;
    const lastTool = [...messages].reverse().find(message => message.role === 'tool');
    if (!lastTool) return toolCall('read-a', 'memory_source_read', { ref: refA });
    if (lastTool.name === 'memory_source_read' && !String(lastTool.content).includes('Narration')) {
      return toolCall('read-b', 'memory_source_read', { ref: refB });
    }
    if (lastTool.name === 'memory_source_read') {
      // Two reads are done while the main reply is still pending: this is the
      // 19:12 shape (two reads, zero injections on the first answer).
      await branchPublishGate.promise;
      return toolCall('publish-1', 'publish_memory_finding', {
        subject: 'Meridian 60-second delivery',
        claim: 'The picture edit was approved; the delivered export\'s narration is still unverified.',
        evidence: [refA],
        qualification: 'Repair reported; export not inspected.',
      });
    }
    if (lastTool.name === 'publish_memory_finding') {
      return toolCall('finish-1', 'finish_memory_search', {
        summary: 'Published the delivery-qualification finding.', evidence: [], inject: false,
      });
    }
    return toolCall('finish-2', 'finish_memory_search', { summary: 'Nothing else.', evidence: [], inject: false });
  });

  const session = createSession({ relay, mainAi, branchAi, key: sessionKey });
  try {
    const firstTurn = session.handleMessage('Draft a delivery note for the 60-second film.', {
      executionScope: executionScope('usr275'),
    } as any);
    await poll('branch performs two reads', () => branchCall >= 3);
    mainReplyGate.resolve(undefined);
    const first = await waitFor('main reply settles', firstTurn);
    assert.equal(first.taskOutcome, 'completed');

    const taskA = SessionStore.getInstance().loadRuntimeState(sessionKey).creditTask!.taskId;
    assert.equal(relay.actions.filter(action => action.action === 'finish' && action.task_id === taskA).length, 0,
      'A has not settled while its Branch still runs');

    // Follow-up input: admitted immediately, while A's Branch still runs.
    const followUp = session.handleMessage('Now send the export to the client.', {
      executionScope: executionScope('usr275'),
    } as any);
    await poll('follow-up gets its own credit task', () =>
      relay.actions.some(action => action.action === 'start' && action.task_id !== taskA));
    const taskB = SessionStore.getInstance().loadRuntimeState(sessionKey).creditTask!.taskId;
    assert.notEqual(taskB, taskA);
    assert.equal(relay.actions.filter(action => action.action === 'finish' && action.task_id === taskA).length, 0,
      'B admission does not settle A');

    branchPublishGate.resolve(undefined);
    await poll('A settles exactly once after its Branch exits',
      () => relay.actions.filter(action => action.action === 'finish' && action.task_id === taskA).length === 1);
    followUpGate.resolve(undefined);
    const second = await waitFor('follow-up completes', followUp);
    assert.equal(second.taskOutcome, 'completed');

    const publication = capture.events.filter(event => event.type === 'memory_branch_publication'
      && event.payload.status === 'published');
    assert.equal(publication.length, 1, 'the Branch published one verified finding after the reply');
    const finished = capture.events.filter(event => event.type === 'memory_branch_investigation_finished');
    assert.ok(finished.length >= 1);
    assert.notEqual(finished.at(-1)!.payload.outcome, 'failed', 'the Branch reached a terminal state other than failed');

    const requestMessages = mainAi.requests[1];
    assert.equal(JSON.stringify(requestMessages).includes('delivered export'), false,
      'the follow-up request contains no evidence the Branch had not verified for that input');
    const held = (session as any).memoryBranchStore.snapshot().entries
      .filter((entry: any) => entry.status === 'held' || entry.status === 'queued');
    assert.equal(held.length, 1, 'the published finding is held for the newer input');
    assert.equal(held[0].verifiedThroughInput, 1);

    const finishOrder = relay.actions.findIndex(action => action.action === 'finish' && action.task_id === taskA);
    const bStartOrder = relay.actions.findIndex(action => action.action === 'start' && action.task_id === taskB);
    assert.ok(bStartOrder >= 0 && finishOrder > bStartOrder, 'B was admitted before A settled');

    report.fixtures.replay_19_12 = {
      input_acceptance: capture.events.filter(event => event.type === 'memory_branch_input_admitted'),
      credit_events: capture.events.filter(event => event.type.startsWith('credit_task')),
      task_a: taskA,
      task_b: taskB,
      actions: relay.actions,
      publication,
      branch_finished: finished,
      held,
      main_provider_calls: mainAi.requests.length,
      branch_provider_calls: branchCall,
      follow_up_contains_finding: false,
    };
  } finally {
    capture.restore();
    await poll('branch cleanup', () => {
      try { return !(session as any).turnController.activeMemoryInvestigation; } catch { return true; }
    }, 5000).catch(() => undefined);
    session.clear();
  }
});

test('interleaved credit: both gates admit B immediately; A settles once after its Branch exits; B has its own snapshot and survives a restart', async t => {
  const relay = await startCreditRelay(t);
  const sessionKey = `session:v2:catscompany:group:grp_7445:agent:usr2:${Date.now()}`;
  const capture = captureRuntimeEvents();
  const mainReplyGate = deferred<void>();
  const branchGate = deferred<void>();
  let mainCall = 0;
  const mainAi = new ScriptedAI(relay.config, async () => {
    mainCall += 1;
    if (mainCall === 1) {
      await mainReplyGate.promise;
      return { content: 'A replied.', toolCalls: [], usage };
    }
    return { content: 'B replied.', toolCalls: [], usage };
  });
  // A scripted Branch that stays running after A's reply.
  const branchAi = new ScriptedAI(relay.config, async () => {
    await branchGate.promise;
    return toolCall('finish-0', 'finish_memory_search', { summary: 'No finding.', evidence: [], inject: false });
  });
  const session = createSession({ relay, mainAi, branchAi, key: sessionKey });
  const controller = (session as any).turnController as AgentTurnController;
  let branchId = 'branch-interleaved';
  const originalCreate = (controller as any).createMemorySidecarHandle.bind(controller);

  try {
    const first = session.handleMessage('A: draft the note.', { executionScope: executionScope('usr2') } as any);
    await poll('A branch started', () => Boolean(controller.activeMemoryInvestigation));
    branchId = controller.activeMemoryInvestigation!.branchId;
    mainReplyGate.resolve(undefined);
    const firstResult = await waitFor('A reply completes', first);
    assert.equal(firstResult.taskOutcome, 'completed');
    assert.ok(controller.activeMemoryInvestigation, 'A branch is still running after the reply');

    const stateAfterA = SessionStore.getInstance().loadRuntimeState(sessionKey);
    const taskA = stateAfterA.creditTask!.taskId;
    const aSnapshot = stateAfterA.creditTasks![taskA];
    assert.equal(aSnapshot.foregroundCompleted, true);
    assert.equal(relay.actions.filter(action => action.action === 'finish' && action.task_id === taskA).length, 0);

    const second = session.handleMessage('B: unrelated question.', { executionScope: executionScope('usr2') } as any);
    const secondResult = await waitFor('B reply completes', second);
    assert.equal(secondResult.taskOutcome, 'completed', 'B is admitted while A only holds Branch children');
    const stateAfterB = SessionStore.getInstance().loadRuntimeState(sessionKey);
    const taskB = stateAfterB.creditTask!.taskId;
    assert.notEqual(taskB, taskA, 'B owns the active snapshot');
    assert.ok(stateAfterB.creditTasks![taskB], 'B persisted its own snapshot');
    assert.equal(relay.actions.filter(action => action.action === 'finish' && action.task_id === taskB).length, 1,
      "B settles on its own, independently of A");
    assert.equal(relay.actions.filter(action => action.action === 'finish' && action.task_id === taskA).length, 0,
      "B's own settlement does not settle A");

    branchGate.resolve(undefined);
    await poll('A branch exits and A settles once',
      () => relay.actions.filter(action => action.action === 'finish' && action.task_id === taskA).length === 1);
    await poll('A is persisted completed',
      () => SessionStore.getInstance().loadRuntimeState(sessionKey).creditTasks?.[taskA]?.state === 'completed'
        || SessionStore.getInstance().loadRuntimeState(sessionKey).creditTasks?.[taskA] === undefined);
    assert.equal(SessionStore.getInstance().loadRuntimeState(sessionKey).creditTask?.taskId, taskB,
      'A settlement never overwrites the newer task snapshot');
    assert.equal(relay.actions.filter(action => action.action === 'finish' && action.task_id === taskB).length, 1,
      "A's settlement does not re-settle B");

    // Restart: A is pending branch-only (it was running when the process died)
    // and B is the active task. Recovery settles A exactly once and resumes B.
    const store = SessionStore.getInstance();
    const restartKey = `${sessionKey}:restart`;
    const taskAId = 'task-a-restart';
    const taskBId = 'task-b-restart';
    store.saveRuntimeState(restartKey, {
      creditTask: { taskId: taskBId, state: 'running', enabled: true, startSent: true, pendingInput: 'B pending', foregroundCompleted: false, updatedAtMs: 2 },
      creditTasks: {
        [taskAId]: { taskId: taskAId, state: 'running', enabled: true, startSent: true, foregroundCompleted: true, branchChildren: 1, updatedAtMs: 1 },
        [taskBId]: { taskId: taskBId, state: 'running', enabled: true, startSent: true, pendingInput: 'B pending', foregroundCompleted: false, updatedAtMs: 2 },
      },
    } as any);
    const restarted = createSession({ relay, mainAi, branchAi, key: restartKey });
    await poll('recovery settles A once',
      () => relay.actions.filter(action => action.action === 'finish' && action.task_id === taskAId).length === 1);
    const settled = SessionStore.getInstance().loadRuntimeState(restartKey);
    assert.equal(settled.creditTask?.taskId, taskBId, 'B remains the active recovery snapshot');
    assert.notEqual(settled.creditTask?.state, 'completed', 'A settlement never completes B');
    assert.equal(relay.actions.filter(action => action.action === 'resume' && action.task_id === taskAId).length, 0,
      'the older task is never resumed');
    assert.equal((restarted as any).creditTask.snapshot.taskId, taskBId);
    restarted.clear();

    // Legacy single-slot state still behaves exactly as before.
    const legacyKey = `${sessionKey}:legacy`;
    store.saveRuntimeState(legacyKey, {
      creditTask: { taskId: 'legacy-task', state: 'running', enabled: true, startSent: true, pendingInput: 'legacy input' },
    } as any);
    const legacySession = createSession({ relay, mainAi, branchAi, key: legacyKey });
    assert.match((legacySession as any).creditTask.pauseMessage, /任务已暂停/);
    assert.equal(relay.actions.filter(action => action.task_id === 'legacy-task' && action.action === 'finish').length, 0);
    legacySession.clear();

    report.fixtures.interleaved_credit = {
      task_a: taskA,
      task_b: taskB,
      branch_id: branchId,
      actions: relay.actions,
      state_after_a: { foreground_completed: aSnapshot.foregroundCompleted },
      restart: {
        task_a: taskAId, task_b: taskBId,
        active_after_restart: settled.creditTask?.taskId,
        a_finish_count: relay.actions.filter(action => action.action === 'finish' && action.task_id === taskAId).length,
        a_resume_count: relay.actions.filter(action => action.action === 'resume' && action.task_id === taskAId).length,
      },
      legacy_state: 'single creditTask slot still loads and pauses',
      credit_events: capture.events.filter(event => event.type.startsWith('credit_task')),
    };
  } finally {
    capture.restore();
    (controller as any).createMemorySidecarHandle = originalCreate;
    session.clear();
  }
});

function controllerHarness(options: {
  mainHandler: (messages: Message[]) => Promise<ChatResponse>;
  branchHandler?: (messages: Message[]) => Promise<ChatResponse>;
  store?: SessionMemoryBranchStore;
  sessionRoute?: any;
  toolManager?: any;
}) {
  const config = { provider: 'openai', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake', model: 'scripted', modelCapabilities: { toolCalling: true } } as ChatConfig;
  const mainAi = new ScriptedAI(config, options.mainHandler);
  const branchAi = new ScriptedAI(config, options.branchHandler ?? (async () =>
    toolCall('finish-default', 'finish_memory_search', { summary: 'Nothing.', evidence: [], inject: false })));
  const store = options.store ?? new SessionMemoryBranchStore();
  const controller = new AgentTurnController({
    sessionKey: `session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    sessionType: 'catscompany',
    memoryBranchStore: store,
    services: {
      aiService: mainAi, catslogMemory: catslogFixture as any,
      memoryBranch: { enabled: true, modelSource: 'catalog', aiService: branchAi },
      toolManager: options.toolManager ?? toolManager(),
      skillManager: {
        getSkill: () => undefined, getUserInvocableSkills: () => [], getAutoInvocableSkills: () => [],
        findAutoInvocableSkillByText: () => undefined, loadSkills: async () => undefined,
      } as any,
    },
    skillRuntime: { reloadSkills: async () => undefined, buildSkillsListMessage: () => null } as any,
    planRuntime: undefined as any,
    turnContextBuilder: new TurnContextBuilder(),
    turnLogRecorder: { startRun: () => undefined, recordEvent: () => undefined, recordTurn: () => undefined } as any,
    workspaceRoot: dataRoot,
    getCurrentDirectory: () => dataRoot,
    updateCurrentDirectory: () => undefined,
  });
  return { controller, store, mainAi, branchAi };
}

function syntheticCount(request: Message[]): number {
  return request.filter(message => message.__syntheticObservation && message.role === 'tool').length;
}

function memoryInput(store: SessionMemoryBranchStore, turn: number, text: string, scope = normalizeMemoryBranchScope({
  sessionKey: 'session:controller', topicId: 'grp_7445', actorUserId: 'usr1',
})) {
  return { sequence: store.noteUserInput({ text, scope, turn, turnId: `input:${turn}` }), turn, turnId: `input:${turn}`, scope };
}

test('an observation published before the next provider request appears exactly once; one published after a request waits for the next current request', async () => {
  const scope = normalizeMemoryBranchScope({ sessionKey: 'session:controller', topicId: 'grp_7445', actorUserId: 'usr1' });
  const store = new SessionMemoryBranchStore();
  let call = 0;
  const { controller, mainAi } = controllerHarness({
    store,
    mainHandler: async () => {
      call += 1;
      // The request for this call is already captured; a publication here is
      // therefore "before the next provider request".
      if (call === 1) {
        store.publish({
          subject: 'Meridian export',
          claim: 'The delivered export contains audible narration.',
          sourceRefs: ['chat/2026-11-18/fixture.jsonl#2'],
          scope,
          originTurn: 1,
          originTurnId: 'episode:1',
          verifiedThroughInput: store.currentInputSequence,
          branchId: 'branch-1',
        });
        return toolCall('work-1', 'continue_work', {});
      }
      if (call === 2) {
        store.publish({
          subject: 'Meridian narration',
          claim: 'A later inspection confirmed the narration repair.',
          sourceRefs: ['chat/2026-11-18/fixture.jsonl#1'],
          scope,
          originTurn: 1,
          originTurnId: 'episode:1',
          verifiedThroughInput: store.currentInputSequence,
          branchId: 'branch-1',
        });
        return toolCall('work-2', 'continue_work', {});
      }
      return { content: 'done', toolCalls: [], usage };
    },
  });
  const input = memoryInput(store, 1, 'Draft the delivery note.');
  await controller.run({ input: 'Draft the delivery note.', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: input });

  assert.equal(mainAi.requests.length, 3);
  assert.equal(syntheticCount(mainAi.requests[0]), 0, 'request 1 predates any publication');
  const occurrence = (request: Message[], text: string) => (JSON.stringify(request).match(new RegExp(text, 'g')) || []).length;
  assert.equal(syntheticCount(mainAi.requests[1]), 1, 'request 2 contains exactly the finding published before it');
  assert.equal(occurrence(mainAi.requests[1], 'audible narration'), 1);
  assert.equal(syntheticCount(mainAi.requests[2]), 2, 'request 3 carries the earlier observation in history plus the new one');
  assert.equal(syntheticCount(mainAi.requests[2]) - syntheticCount(mainAi.requests[1]), 1,
    'exactly one new observation is added for the later finding');
  assert.equal(occurrence(mainAi.requests[2], 'audible narration'), 1, 'the first finding is not repeated after delivery');
  assert.equal(occurrence(mainAi.requests[2], 'narration repair'), 1);
  report.fixtures.publication_timing = {
    request_synthetic_counts: mainAi.requests.map(syntheticCount),
    entries: store.snapshot().entries.map(entry => ({
      claim: entry.claim, status: entry.status, verified_through_input: entry.verifiedThroughInput,
    })),
  };
});

test('a held finding is reconfirmed through the Branch tool after a same-topic follow-up and only then reaches the request', async () => {
  const scope = normalizeMemoryBranchScope({ sessionKey: 'session:controller', topicId: 'grp_7445', actorUserId: 'usr1' });
  const store = new SessionMemoryBranchStore();
  const { refA, refB } = refs;
  let mainTurn = 0;
  let mainCall = 0;
  const reconfirmed = deferred<void>();
  let branchCall = 0;
  const { controller, mainAi } = controllerHarness({
    store,
    mainHandler: async () => {
      mainCall += 1;
      if (mainTurn === 1) return { content: 'first answer', toolCalls: [], usage };
      if (mainCall === 2) {
        await reconfirmed.promise;
        return toolCall('work-1', 'continue_work', {});
      }
      return { content: 'follow-up answer', toolCalls: [], usage };
    },
    branchHandler: async (messages) => {
      branchCall += 1;
      const lastTool = [...messages].reverse().find(message => message.role === 'tool');
      if (branchCall === 1) return toolCall('read-a', 'memory_source_read', { ref: refA });
      if (branchCall === 2) {
        return toolCall('publish-a', 'publish_memory_finding', {
          subject: 'Meridian picture edit',
          claim: 'The picture edit was approved; narration was still open.',
          evidence: [refA],
        });
      }
      if (branchCall === 3) return toolCall('finish-a', 'finish_memory_search', { summary: 'Published.', evidence: [], inject: false });
      // Follow-up investigation: its prompt lists the held finding.
      if (branchCall === 4) {
        const heldMessage = [...messages].reverse().find(message =>
          typeof message.content === 'string'
          && message.content.trimStart().startsWith('{')
          && message.content.includes('held_observations'));
        assert.ok(heldMessage, 'the follow-up investigation sees the held observation');
        const held = JSON.parse(String(heldMessage!.content)).held_observations;
        assert.equal(held.length, 1);
        return toolCall('reconfirm-1', 'resolve_held_memory_observation', { observation_id: held[0].observationId, decision: 'reconfirm' });
      }
      if (branchCall === 5) {
        reconfirmed.resolve(undefined);
        return toolCall('finish-b', 'finish_memory_search', { summary: 'Still current.', evidence: [], inject: false });
      }
      return toolCall('finish-c', 'finish_memory_search', { summary: 'Nothing.', evidence: [], inject: false });
    },
  });
  const first = memoryInput(store, 1, 'What did we decide about the Meridian film?');
  mainTurn = 1;
  await controller.run({ input: 'What did we decide about the Meridian film?', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: first });
  await poll('first publication queued', () => store.snapshot().entries.some(entry => entry.status === 'held' || entry.status === 'queued'));
  await poll('first investigation finished', () => !(controller as any).activeMemoryInvestigation, 8000);
  assert.equal(store.snapshot().entries[0].verifiedThroughInput, 1);

  const second = memoryInput(store, 2, 'Now draft the export for the client.');
  mainTurn = 2;
  mainCall = 1;
  await controller.run({ input: 'Now draft the export for the client.', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: second });

  await poll('reconfirmation audit', () => store.snapshot().entries[0].verifiedThroughInput === 2, 8000);
  assert.equal(mainAi.requests.length, 3, 'the main turn kept its own requests');
  assert.equal(syntheticCount(mainAi.requests[0]), 0, 'the first turn predates the publication');
  assert.equal(syntheticCount(mainAi.requests[1]), 0, 'the request sent before reconfirmation excludes the held finding');
  assert.equal(syntheticCount(mainAi.requests[2]), 1, 'the next request while the input is current contains it exactly once');
  assert.equal(store.snapshot().entries[0].status, 'delivered');
  report.fixtures.held_reconfirmation = {
    request_synthetic_counts: mainAi.requests.map(syntheticCount),
    entry: store.snapshot().entries[0],
    branch_calls: branchCall,
  };
});

test('insufficient evidence and nothing relevant: zero publications, zero injections, Branch exits within budget', async () => {
  const scope = normalizeMemoryBranchScope({ sessionKey: 'session:controller', topicId: 'grp_7445', actorUserId: 'usr1' });
  const store = new SessionMemoryBranchStore();
  const capture = captureRuntimeEvents();
  const { controller, mainAi, branchAi } = controllerHarness({
    store,
    mainHandler: async () => ({ content: 'no memory needed', toolCalls: [], usage }),
    branchHandler: async () => toolCall('finish-empty', 'finish_memory_search', {
      summary: 'No useful memory for this request.', evidence: [], inject: false,
    }),
  });
  try {
    const input = memoryInput(store, 1, 'What is the weather?');
    await controller.run({ input: 'What is the weather?', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: input });
    await poll('investigation finished', () => !(controller as any).activeMemoryInvestigation, 8000);
    assert.equal(store.snapshot().entries.length, 0, 'no publication without verified evidence');
    assert.equal(syntheticCount(mainAi.requests[0]), 0);
    const spend = capture.events.find(event => event.type === 'memory_branch_spend');
    assert.ok(spend, 'branch spend is reported');
    assert.ok(spend!.payload.total_tokens > 0 && spend!.payload.total_tokens < 1000, 'spend stays within the investigation budget');
    const finished = capture.events.find(event => event.type === 'memory_branch_investigation_finished');
    assert.ok(finished);
    assert.notEqual(finished!.payload.outcome, 'failed');
    report.fixtures.no_evidence = {
      publications: store.snapshot().entries.length,
      injections: syntheticCount(mainAi.requests[0]),
      outcome: finished!.payload.outcome,
      spend: spend!.payload,
      branch_calls: branchAi.requests.length,
    };
  } finally {
    capture.restore();
  }
});

test('project A to project B: B\'s request contains no A evidence; the trace shows the hold before the withdrawal', async () => {
  const scope = normalizeMemoryBranchScope({ sessionKey: 'session:controller', topicId: 'grp_7445', actorUserId: 'usr1' });
  const store = new SessionMemoryBranchStore();
  const capture = captureRuntimeEvents();
  const { controller, mainAi } = controllerHarness({
    store,
    mainHandler: async () => ({ content: 'B answer', toolCalls: [], usage }),
  });
  try {
    const first = memoryInput(store, 1, 'Project A: the release is blocked by the migration.');
    store.publish({
      subject: 'Project A release', claim: 'Project A is blocked by the migration.',
      sourceRefs: ['chat/2026-11-18/fixture.jsonl#1'], scope,
      originTurn: 1, originTurnId: 'episode:1', verifiedThroughInput: first.sequence, branchId: 'branch-1',
    });
    const second = memoryInput(store, 2, 'Project B: write the launch post.');
    await controller.run({ input: 'Project B: write the launch post.', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: second });
    assert.equal(syntheticCount(mainAi.requests[0]), 0, "B's provider request contains no A evidence");
    const heldIndex = capture.events.findIndex(event => event.type === 'memory_branch_observation_held');
    assert.ok(heldIndex >= 0);
    store.withdraw({ observationId: store.snapshot().entries[0].id, reason: 'topic_switch', scope });
    const withdrawnIndex = capture.events.findIndex(event => event.type === 'memory_branch_observation_withdrawn');
    assert.ok(withdrawnIndex > heldIndex, 'the hold is recorded before the withdrawal');
    assert.equal(store.snapshot().entries[0].status, 'withdrawn');
    report.fixtures.project_switch = {
      request_synthetic_count: syntheticCount(mainAi.requests[0]),
      trace: capture.events
        .filter(event => event.type.startsWith('memory_branch_observation_'))
        .map(event => ({ type: event.type, reason: event.payload.reason, status: event.payload.status })),
    };
  } finally {
    capture.restore();
  }
});


test('a narrowing question retargets the next lookup to the export, and only a later inspection resolves it', async () => {
  const scope = normalizeMemoryBranchScope({ sessionKey: 'session:controller', topicId: 'grp_7445', actorUserId: 'usr1' });
  const store = new SessionMemoryBranchStore();
  const { refA, refB } = refs;
  let branchCall = 0;
  let turn = 1;
  let turnTwoCalls = 0;
  let sawNarrowing: string | null = null;
  const gatedToolManager = toolManager();
  gatedToolManager.executeTool = async (call: any) => {
    if (call.function.name === 'continue_work') {
      const deadline = Date.now() + 8000;
      while (!store.snapshot().entries.some(entry => entry.subject === 'Delivered 60-second export')
        && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return { role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'tool completed', ok: true };
  };
  const { controller } = controllerHarness({
    store,
    toolManager: gatedToolManager,
    mainHandler: async () => {
      if (turn === 1) return { content: 'The repair report says speech is fixed.', toolCalls: [], usage };
      turnTwoCalls += 1;
      return turnTwoCalls === 1
        ? toolCall('work-1', 'continue_work', {})
        : { content: 'done', toolCalls: [], usage };
    },
    branchHandler: async (messages) => {
      branchCall += 1;
      const lastTool = [...messages].reverse().find(message => message.role === 'tool');
      const narrowed = messages.some(message => typeof message.content === 'string'
        && message.content.toLowerCase().includes('does this export have narration'));
      if (narrowed) sawNarrowing = 'narrowed input present';
      if (branchCall === 1) return toolCall('read-repair', 'memory_source_read', { ref: refA });
      if (branchCall === 2) {
        return toolCall('publish-repair', 'publish_memory_finding', {
          subject: 'Speech repair report',
          claim: 'The repair report says speech synthesis is fixed.',
          evidence: [refA],
          qualification: 'A repair report about the pipeline; it does not verify the delivered export.',
        });
      }
      if (branchCall === 3) {
        return toolCall('finish-a', 'finish_memory_search', { summary: 'Repair report published.', evidence: [], inject: false });
      }
      // Turn 2 investigation: narrowing input arrived, so retarget the lookup.
      if (branchCall === 4) {
        const heldMessage = [...messages].reverse().find(message => typeof message.content === 'string'
          && message.content.trimStart().startsWith('{') && message.content.includes('held_observations'));
        assert.ok(heldMessage, 'the narrowed input reaches the Branch with the held finding');
        const payload = JSON.parse(String(heldMessage!.content));
        assert.equal(payload.held_observations.length, 1);
        return toolCall('withdraw-repair', 'resolve_held_memory_observation', {
          observation_id: payload.held_observations[0].observationId, decision: 'withdraw',
        });
      }
      if (branchCall === 5) {
        return toolCall('search-export', 'memory_remote_search', { keywords: ['export'] });
      }
      if (branchCall === 6) return toolCall('read-export', 'memory_source_read', { ref: refB });
      if (branchCall === 7) {
        return toolCall('publish-export', 'publish_memory_finding', {
          subject: 'Delivered 60-second export',
          claim: 'The delivered 60-second export contains audible narration.',
          evidence: [refB],
          qualification: 'Read from the export inspection turn.',
        });
      }
      return toolCall('finish-b', 'finish_memory_search', { summary: 'Export verified.', evidence: [], inject: false });
    },
  });

  const first = memoryInput(store, 1, 'Is speech fixed?');
  await controller.run({ input: 'Is speech fixed?', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: first });
  await poll('repair report published', () => store.snapshot().entries.length === 1, 8000);
  assert.ok(store.snapshot().entries[0].qualification?.includes('does not verify'));

  turn = 2;
  const second = memoryInput(store, 2, 'Does this export have narration?');
  await controller.run({ input: 'Does this export have narration?', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: second });
  assert.ok(sawNarrowing, 'the Branch consumed the narrowed input before its next lookup');
  const entries = store.snapshot().entries;
  const repair = entries.find(entry => entry.subject === 'Speech repair report')!;
  const exported = entries.find(entry => entry.subject === 'Delivered 60-second export')!;
  assert.equal(repair.status, 'withdrawn', 'the repair report is not used as export evidence');
  assert.equal(exported.status, 'delivered');
  assert.equal(exported.verifiedThroughInput, 2);
  assert.deepEqual(exported.sourceRefs, [refB]);
  report.fixtures.narrowing = {
    repair: { status: repair.status, qualification: repair.qualification },
    export: { status: exported.status, refs: exported.sourceRefs, verified_through_input: exported.verifiedThroughInput },
    narrowed_input_seen_by_branch: Boolean(sawNarrowing),
    branch_calls: branchCall,
  };
});

test('a duplicated repair report enters context once and a correction supersedes it with its own pinned reference', async () => {
  const scope = normalizeMemoryBranchScope({ sessionKey: 'session:controller', topicId: 'grp_7445', actorUserId: 'usr1' });
  const store = new SessionMemoryBranchStore();
  const capture = captureRuntimeEvents();
  let call = 0;
  const { controller, mainAi } = controllerHarness({
    store,
    mainHandler: async () => {
      call += 1;
      const publish = (claim: string, ref: string, supersedes?: string[]) => {
        const published = store.publish({
          subject: 'Repair status', claim, sourceRefs: [ref], scope,
          originTurn: 1, originTurnId: 'episode:1', verifiedThroughInput: 1, branchId: 'branch-1',
          ...(supersedes ? { supersedes } : {}),
        });
        return published;
      };
      if (call === 1) {
        publish('The repair report says the speech pipeline is fixed.', 'chat/2026-11-18/fixture.jsonl#1');
        publish('The repair report says the speech pipeline is fixed.', 'chat/2026-11-18/fixture.jsonl#1');
        return toolCall('work-1', 'continue_work', {});
      }
      if (call === 2) {
        assert.equal(JSON.stringify(mainAi.requests[1]).match(/repair report says the speech pipeline is fixed/g)?.length, 1,
          'the duplicate claim enters the request once');
        const firstId = store.snapshot().entries[0].id;
        publish('The delivered export contains audible narration, contrary to the repair report.',
          'chat/2026-11-18/fixture.jsonl#2', [firstId]);
        return toolCall('work-2', 'continue_work', {});
      }
      return { content: 'corrected', toolCalls: [], usage };
    },
  });
  const input = memoryInput(store, 1, 'Is the speech repair done?');
  await controller.run({ input: 'Is the speech repair done?', messages: [], runtimeFeedback: [], shouldContinue: () => true, memoryBranchInput: input });
  const entries = store.snapshot().entries;
  assert.equal(entries.length, 2, 'the duplicate was deduplicated');
  const original = entries[0];
  const correction = entries[1];
  assert.equal(original.status, 'delivered', 'the original already entered the request');
  assert.equal(original.supersededBy, correction.id, 'the delivered record points at the correction');
  assert.deepEqual(correction.supersedes, [original.id]);
  assert.deepEqual(correction.sourceRefs, ['chat/2026-11-18/fixture.jsonl#2']);
  assert.equal(syntheticCount(mainAi.requests[2]), 2, 'history keeps the original plus the correction');
  assert.equal(JSON.stringify(mainAi.requests[2]).match(/contrary to the repair report/g)?.length, 1);
  const deliveredSupersede = capture.events.filter(event => event.type === 'memory_branch_observation_supersedes_delivered');
  assert.equal(deliveredSupersede.length, 1, 'superseding an already delivered claim is recorded');
  const duplicateAudit = capture.events.filter(event => event.type === 'memory_branch_publication'
    && event.payload.reason === 'duplicate');
  assert.equal(duplicateAudit.length, 1);
  capture.restore();
  report.fixtures.duplicate_and_correction = {
    entries: entries.map(entry => ({ claim: entry.claim, status: entry.status, supersedes: entry.supersedes, refs: entry.sourceRefs })),
    duplicate_audits: duplicateAudit.length,
    request_synthetic_counts: mainAi.requests.map(syntheticCount),
  };
});

test('two senders in one group session: sender A\'s evidence never enters sender B\'s provider request', async t => {
  const relay = await startCreditRelay(t);
  const sessionKey = `session:v2:catscompany:group:grp_7445:agent:usr1:${Date.now()}`;
  const { refA } = refs;
  let mainCall = 0;
  const mainAi = new ScriptedAI(relay.config, async () => {
    mainCall += 1;
    return { content: `answer ${mainCall}`, toolCalls: [], usage };
  });
  let branchCall = 0;
  const branchAi = new ScriptedAI(relay.config, async () => {
    branchCall += 1;
    if (branchCall === 1) return toolCall('read-a', 'memory_source_read', { ref: refA });
    if (branchCall === 2) {
      return toolCall('publish-a', 'publish_memory_finding', {
        subject: 'Sender A project',
        claim: 'Sender A private project note: the migration is approved.',
        evidence: [refA],
      });
    }
    return toolCall('finish', 'finish_memory_search', { summary: 'Done.', evidence: [], inject: false });
  });
  const session = createSession({ relay, mainAi, branchAi, key: sessionKey });
  try {
    await waitFor('sender A turn', session.handleMessage('A: check the migration note.', { executionScope: executionScope('usrA') } as any));
    await poll('A finding published', () => (session as any).memoryBranchStore.snapshot().entries.length === 1, 8000);
    await poll('A investigation finished', () => !(session as any).turnController.activeMemoryInvestigation, 8000);

    const secondResult = await waitFor('sender B turn', session.handleMessage('B: unrelated question.', { executionScope: executionScope('usrB') } as any));
    assert.equal(secondResult.taskOutcome, 'completed', `sender B turn: ${secondResult.text}`);
    const request = mainAi.requests.at(-1)!;
    assert.equal(JSON.stringify(request).includes('migration is approved'), false,
      "sender A's evidence never reaches sender B's request");
    assert.ok(mainCall >= 2, `sender B produced its own provider request (calls=${mainCall})`);
    await poll('sender B request holds the out-of-scope finding', () =>
      (session as any).memoryBranchStore.snapshot().entries[0].status === 'held', 5000);
    const entry = (session as any).memoryBranchStore.snapshot().entries[0];
    assert.equal(entry.holdReasons['2'], 'scope_mismatch');
    report.fixtures.two_senders = {
      entry_status: entry.status,
      hold_reasons: entry.holdReasons,
      sender_b_request_contains_a_evidence: false,
    };
  } finally {
    session.clear();
  }
});

test('writes the repeatable verification report', () => {
  report.generated_at = new Date().toISOString();
  report.branch_budget = { source: 'DEFAULT_MEMORY_BRANCH_BUDGET', unit: 'wall clock + passes + context; tokens charged to the originating task' };
  const fixtures = Object.values(report.fixtures) as any[];
  const mainProviderCalls = fixtures.reduce((total, fixture) =>
    total + (typeof fixture.main_provider_calls === 'number'
      ? fixture.main_provider_calls
      : (fixture.request_synthetic_counts?.length ?? 0)), 0);
  const branchProviderCalls = fixtures.reduce((total, fixture) =>
    total + (fixture.branch_provider_calls ?? fixture.branch_calls ?? 0), 0);
  const deliveredFindings = fixtures.reduce((total, fixture) => {
    const entries = Array.isArray(fixture.entries) ? fixture.entries : [];
    const fromEntries = entries.filter((entry: any) => entry.status === 'delivered').length;
    return total + fromEntries + (fixture.export?.status === 'delivered' ? 1 : 0);
  }, 0);
  report.summary = {
    // No main-agent provider call exists to coordinate the Branch: the main
    // agent has no Branch tool and never waits, polls, or queries it.
    main_agent_coordination_calls: 0,
    main_provider_requests: mainProviderCalls,
    branch_provider_calls: branchProviderCalls,
    delivered_findings: deliveredFindings,
    // Scripted provider usage is 11 tokens per call; spend is charged to the
    // originating credit task, not to the main agent's request.
    branch_tokens: branchProviderCalls * 11,
    branch_tokens_per_delivered_finding: deliveredFindings ? (branchProviderCalls * 11) / deliveredFindings : null,
  };
  const evidenceDir = process.env.CATSLOG_EXECUTION_EVIDENCE_DIR;
  const target = evidenceDir
    ? path.join(evidenceDir, 'reports', 'session-memory-branch.json')
    : path.join(dataRoot, 'session-memory-branch-report.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  assert.ok(fs.existsSync(target));
  report.report_path = target;
  console.log(`session-memory-branch report: ${target}`);
});

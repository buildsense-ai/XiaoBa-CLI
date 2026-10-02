import { beforeEach, afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { Logger } from '../src/utils/logger';
import { InMemorySyntheticObservationQueue, SyntheticObservation } from '../src/core/synthetic-observation';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type { CatscoBranchQuery } from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

const SESSION_KEY = 'session:v2:catscompany:group:grp_timing:agent:usr1';
const OBS_SUMMARY = 'Previous turn found the birthday dinner decision.';
const OBS_REF = 'catscompany/2026-06-16/demo.jsonl#7';
const BRANCH_INPUT = 'please recall the release decision for the nginx rollback';
const TIMING_EVENT_TYPES = new Set(['injection_consumed', 'injection_first_action_ms', 'branch_stage_timing']);

interface CapturedRuntimeEvent {
  level: string;
  message: string;
  event: { type: string; payload: Record<string, unknown> };
}

function captureRuntimeEvents() {
  const captured: CapturedRuntimeEvent[] = [];
  const original = Logger.runtimeEvent.bind(Logger);
  (Logger as any).runtimeEvent = (level: string, message: string, event: any) => {
    captured.push({ level, message, event });
  };
  return {
    captured,
    byType(type: string): CapturedRuntimeEvent[] {
      return captured.filter(entry => entry.event?.type === type);
    },
    restore() {
      (Logger as any).runtimeEvent = original;
    },
  };
}

let runtime: ReturnType<typeof captureRuntimeEvents>;

beforeEach(() => {
  runtime = captureRuntimeEvents();
});

afterEach(() => {
  runtime.restore();
});

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function memoryObservation(id: string): SyntheticObservation {
  return {
    id,
    source: 'memory',
    status: 'completed',
    relevance: 'medium',
    summary: OBS_SUMMARY,
    metadata: {
      branchId: `branch-${id}`,
      branchType: 'memory',
      refs: [OBS_REF],
    },
    formattedContent: JSON.stringify({
      source: 'memory',
      summary: OBS_SUMMARY,
      refs: [OBS_REF],
    }),
  };
}

function assertTimingPayloadHasNoContent(serialized: string): void {
  assert.equal(serialized.includes('birthday dinner'), false, 'observation summary leaked into timing event');
  assert.equal(serialized.includes(OBS_REF), false, 'observation ref leaked into timing event');
}

// ─── Branch session harness ────────────────────────────────────────────────

/** Minimal device-bound backend: one session_graph item carrying a canonical ref. */
class RemoteEvidenceMemory implements CatsLogMemoryBackend {
  async branch(_query: CatscoBranchQuery): Promise<any> {
    return {
      schema_version: 1,
      content_trust: 'untrusted_branch_evidence',
      request_id: 'req-timing-1',
      status: 'ok',
      branches: [
        {
          source: 'session_graph',
          status: 'ok',
          items: [{
            source: 'session',
            ref: 'timing-release#17',
            kind: 'session_turn',
            text: 'release decision: keep nginx read-only mount',
            score_hint: 0.9,
          }],
        },
      ],
    };
  }
}

/** v1.3 pipeline fake: turn 1 assess-recall, turn 2 finish citing an observed ref. */
class AssessRecallThenFinishAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  evidencePackRefs(messages: Message[]): string[] {
    const pack = [...messages].reverse().find(message => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('evidence_pack')
    ));
    if (!pack || typeof pack.content !== 'string') return [];
    try {
      const parsed = JSON.parse(pack.content);
      return [
        ...((parsed?.evidence_pack?.remote_branch?.branches || []) as any[])
          .flatMap(branch => (branch.items || []).map((item: any) => item.ref)),
        ...((parsed?.evidence_pack?.session_records?.records || []) as any[])
          .flatMap(record => record.type === 'session_turn_group' ? record.refs || [] : [record.ref]),
        ...((parsed?.evidence_pack?.local_knowledge?.entries || []) as any[]).map(entry => entry.ref),
      ].filter((ref: unknown) => typeof ref === 'string');
    } catch {
      return [];
    }
  }

  async chat(messages: Message[]): Promise<ChatResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: null,
        toolCalls: [call('assess-1', 'assess_memory_need', {
          action: 'recall',
          query_text: 'release decision',
          keywords: ['release', 'nginx'],
        })],
        usage,
      };
    }
    const refs = this.evidencePackRefs(messages);
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', refs.length > 0 ? {
        summary: 'Relevant release decision found.',
        refs: [refs[0]],
        inject: true,
        delivery: 'context',
      } : {
        summary: 'No usable evidence arrived.',
        refs: [],
        inject: false,
        delivery: 'discard',
      })],
      usage,
    };
  }
}

class AssessSkipAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[]): Promise<ChatResponse> {
    this.calls += 1;
    return {
      content: null,
      toolCalls: [call('assess-1', 'assess_memory_need', {
        action: 'skip',
        reason: '当前上下文足够，无需历史记忆。',
      })],
      usage,
    };
  }
}

function createBranchSession(options: {
  aiService: unknown;
  queue: InMemorySyntheticObservationQueue;
  signal?: AbortSignal;
  catslogMemory?: CatsLogMemoryBackend;
}): { session: MemorySearchBranchSession; branchEvents: Array<{ type: string; payload: Record<string, unknown> }> } {
  const session = new MemorySearchBranchSession({
    sessionKey: SESSION_KEY,
    input: BRANCH_INPUT,
    recentMessages: [],
    workingDirectory: process.cwd(),
    aiService: options.aiService as any,
    queue: options.queue,
    signal: options.signal,
    logEnabled: false,
    catslogMemory: options.catslogMemory,
  });
  // logEnabled:false keeps the BranchSessionLogger file-free; the patched
  // write captures events in memory so the assertions never touch fs.
  const branchEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  (session as any).logger.write = (type: string, payload: Record<string, unknown> = {}) => {
    branchEvents.push({ type, payload });
  };
  return { session, branchEvents };
}

function stageTimingEvents(branchEvents: Array<{ type: string; payload: Record<string, unknown> }>) {
  return branchEvents.filter(entry => entry.type === 'branch_stage_timing');
}

// ─── Controller harness ────────────────────────────────────────────────────

class ScriptedChatStreamAI {
  requests: Message[][] = [];

  constructor(private readonly script: Array<{ content?: string | null; toolCalls?: ToolCall[] }>) {}

  isToolCallingSupported(): boolean {
    return true;
  }

  async chatStream(messages: Message[]): Promise<any> {
    this.requests.push(JSON.parse(JSON.stringify(messages)));
    const next = this.script[this.requests.length - 1] ?? { content: 'done' };
    return { content: next.content ?? null, toolCalls: next.toolCalls ?? [], usage };
  }
}

const TIMING_TOOL: ToolDefinition = {
  name: 'timing_test_tool',
  description: 'No-op tool for first-action timing tests',
  parameters: { type: 'object', properties: {} },
};

function createTimingController(
  aiService: ScriptedChatStreamAI,
  options?: {
    toolManager?: unknown;
    onQueueCreated?: (queue: InMemorySyntheticObservationQueue, turnNumber: number) => void;
  },
): { controller: AgentTurnController; queues: InMemorySyntheticObservationQueue[] } {
  const controller = new AgentTurnController({
    sessionKey: SESSION_KEY,
    sessionType: 'catscompany',
    services: {
      aiService: aiService as any,
      toolManager: (options?.toolManager ?? {
        getToolDefinitions: () => [],
        executeTool: async () => {
          throw new Error('not expected');
        },
      }) as any,
      skillManager: {} as any,
    },
    skillRuntime: {
      reloadSkills: async () => undefined,
      buildSkillsListMessage: () => null,
    } as any,
    planRuntime: undefined as any,
    turnContextBuilder: new TurnContextBuilder(),
    turnLogRecorder: {
      recordTurn: () => undefined,
    } as any,
    workspaceRoot: process.cwd(),
    getCurrentDirectory: () => process.cwd(),
    updateCurrentDirectory: () => undefined,
  });

  const queues: InMemorySyntheticObservationQueue[] = [];
  (controller as any).startMemorySidecarIfEnabled = (slotOptions: { turnNumber: number }) => {
    const queue = new InMemorySyntheticObservationQueue();
    queues.push(queue);
    options?.onQueueCreated?.(queue, slotOptions.turnNumber);
    return {
      queue,
      originTurn: slotOptions.turnNumber,
      done: false,
      handle: {
        cancel: () => undefined,
        done: new Promise<void>(() => undefined),
      },
    };
  };
  return { controller, queues };
}

// ─── branch_stage_timing (MemorySearchBranchSession) ───────────────────────

describe('MemorySearchBranchSession branch_stage_timing', () => {
  test('records assess_end, mechanical_retrieval_end and refine_finish for the recall path', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const { session, branchEvents } = createBranchSession({
      aiService: new AssessRecallThenFinishAI(),
      queue,
      catslogMemory: new RemoteEvidenceMemory(),
    });

    await session.run();

    const timings = stageTimingEvents(branchEvents);
    const stages = timings.map(entry => entry.payload.stage);
    assert.ok(stages.includes('assess_end'), `assess_end missing: ${stages}`);
    assert.ok(stages.includes('mechanical_retrieval_end'), `mechanical_retrieval_end missing: ${stages}`);
    assert.ok(stages.includes('refine_finish'), `refine_finish missing: ${stages}`);
    assert.equal(stages[stages.length - 1], 'refine_finish', 'refine_finish must be the final stage marker');
    for (const timing of timings) {
      assert.equal(typeof timing.payload.ms_since_run_start, 'number');
      assert.ok((timing.payload.ms_since_run_start as number) >= 0);
      assert.equal(timing.payload.session_key, SESSION_KEY);
    }
    // Each stage marker fires at most once per run.
    assert.equal(new Set(stages).size, stages.length);
    assert.equal(queue.size(), 1, 'context delivery should publish exactly one observation');
  });

  test('records only assess_end for the skip path', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const { session, branchEvents } = createBranchSession({
      aiService: new AssessSkipAI(),
      queue,
    });

    await session.run();

    const stages = stageTimingEvents(branchEvents).map(entry => entry.payload.stage);
    assert.deepEqual(stages, ['assess_end']);
    assert.equal(queue.size(), 0, 'skip path must not publish an observation');
  });

  test('abort mid-pipeline yields the reached stage markers only and never refine_finish', async () => {
    const external = new AbortController();
    // The remote lane aborts the whole branch from inside the mechanical stage.
    const abortingBackend: CatsLogMemoryBackend = {
      async branch(_query: CatscoBranchQuery, signal?: AbortSignal): Promise<never> {
        external.abort();
        signal?.throwIfAborted();
        throw new Error('unreachable');
      },
    } as unknown as CatsLogMemoryBackend;
    const queue = new InMemorySyntheticObservationQueue();
    const { session, branchEvents } = createBranchSession({
      aiService: new AssessRecallThenFinishAI(),
      queue,
      signal: external.signal,
      catslogMemory: abortingBackend,
    });

    await session.run(); // must resolve, not throw

    const stages = stageTimingEvents(branchEvents).map(entry => entry.payload.stage);
    assert.ok(stages.includes('mechanical_retrieval_end'), `mechanical_retrieval_end missing: ${stages}`);
    assert.ok(stages.includes('assess_end'), `assess_end missing: ${stages}`);
    assert.equal(stages.includes('refine_finish'), false, 'refine_finish must not fire for an aborted run');
    assert.equal(queue.size(), 0, 'aborted run must not publish an observation');
  });

  test('branch_stage_timing payloads stay bounded to ids and ms', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const { session, branchEvents } = createBranchSession({
      aiService: new AssessRecallThenFinishAI(),
      queue,
    });

    await session.run();

    const timings = stageTimingEvents(branchEvents);
    assert.ok(timings.length > 0);
    for (const timing of timings) {
      assert.deepEqual(
        Object.keys(timing.payload).sort(),
        ['ms_since_run_start', 'session_key', 'stage'],
      );
    }
    assertTimingPayloadHasNoContent(JSON.stringify(timings));
    assert.equal(JSON.stringify(timings).includes(BRANCH_INPUT), false, 'turn input leaked into timing event');
  });
});

// ─── injection_consumed / injection_first_action_ms (AgentTurnController) ──

describe('AgentTurnController injection timing', () => {
  test('emits no timing events when no observation is consumed', async () => {
    const aiService = new ScriptedChatStreamAI([{ content: 'plain answer' }]);
    const { controller } = createTimingController(aiService);

    await controller.run({
      input: 'turn one',
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    assert.equal(runtime.byType('injection_consumed').length, 0);
    assert.equal(runtime.byType('injection_first_action_ms').length, 0);
  });

  test('emits injection_consumed with carryover=true for a previous-turn observation', async () => {
    const aiService = new ScriptedChatStreamAI([{ content: 'first done' }, { content: 'second done' }]);
    const { controller, queues } = createTimingController(aiService);
    const runTurn = async (input: string) => controller.run({
      input,
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    await runTurn('turn one');
    assert.equal(runtime.byType('injection_consumed').length, 0);
    assert.equal(queues[0].push(memoryObservation('obs-carry')), true);

    await runTurn('turn two continues the same topic');

    const events = runtime.byType('injection_consumed');
    assert.equal(events.length, 1);
    const payload = events[0].event.payload;
    assert.equal(payload.session_key, SESSION_KEY);
    assert.equal(payload.turn, 2);
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.observation_ids, ['obs-carry']);
    assert.deepEqual(payload.branch_ids, ['branch-obs-carry']);
    assert.deepEqual(payload.origin_turns, [1]);
    assert.equal(payload.carryover, true);
    assert.equal(payload.carryover_count, 1);
    assert.equal(typeof payload.since_turn_start_ms, 'number');
    assert.ok((payload.since_turn_start_ms as number) >= 0);

    // Consumed injection + text-only turn → first action is the final text.
    const firstAction = runtime.byType('injection_first_action_ms');
    assert.equal(firstAction.length, 1);
    assert.equal(firstAction[0].event.payload.kind, 'text');
    assert.equal(firstAction[0].event.payload.turn, 2);
    assert.equal(firstAction[0].event.payload.consumed_count, 1);
    assert.equal(typeof firstAction[0].event.payload.first_action_ms, 'number');
    assert.ok((firstAction[0].event.payload.first_action_ms as number) >= 0);
  });

  test('marks current-turn injections with carryover=false and attributes the producing turn', async () => {
    const aiService = new ScriptedChatStreamAI([{ content: 'first done' }]);
    const { controller } = createTimingController(aiService, {
      onQueueCreated: queue => {
        queue.push(memoryObservation('obs-now-a'));
        queue.push(memoryObservation('obs-now-b'));
      },
    });

    await controller.run({
      input: 'turn one',
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    const events = runtime.byType('injection_consumed');
    assert.equal(events.length, 1, 'one drain batch = one bounded event');
    const payload = events[0].event.payload;
    assert.equal(payload.turn, 1);
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.observation_ids, ['obs-now-a', 'obs-now-b']);
    assert.deepEqual(payload.origin_turns, [1]);
    assert.equal(payload.carryover, false);
    assert.equal(payload.carryover_count, 0);
  });

  test('records tool dispatch as the first action and ignores earlier tool-prelude text', async () => {
    const aiService = new ScriptedChatStreamAI([
      { content: 'let me check the file first', toolCalls: [call('t1', 'timing_test_tool', {})] },
      { content: 'final answer after tool' },
    ]);
    const toolManager = {
      getToolDefinitions: () => [TIMING_TOOL],
      executeTool: async (toolCall: ToolCall) => ({
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: 'timing tool ok',
      }),
    };
    const { controller } = createTimingController(aiService, {
      toolManager,
      onQueueCreated: queue => queue.push(memoryObservation('obs-tool')),
    });

    await controller.run({
      input: 'turn one',
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    const events = runtime.byType('injection_first_action_ms');
    assert.equal(events.length, 1, 'first-action event fires exactly once per turn');
    const payload = events[0].event.payload;
    // The prelude text precedes the tool dispatch; the dispatch wins.
    assert.equal(payload.kind, 'tool_call');
    assert.equal(payload.turn, 1);
    assert.equal(payload.consumed_count, 1);
    assert.equal(typeof payload.first_action_ms, 'number');
    assert.ok((payload.first_action_ms as number) >= 0);
    assert.equal(runtime.byType('injection_consumed').length, 1);
  });

  test('records the final assistant text as first action when no tool dispatch happened', async () => {
    const aiService = new ScriptedChatStreamAI([{ content: 'text only answer' }]);
    const { controller } = createTimingController(aiService, {
      onQueueCreated: queue => queue.push(memoryObservation('obs-text')),
    });

    await controller.run({
      input: 'turn one',
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    const events = runtime.byType('injection_first_action_ms');
    assert.equal(events.length, 1);
    assert.equal(events[0].event.payload.kind, 'text');
  });

  test('dropped observations stay out of the timing timeline', async () => {
    const aiService = new ScriptedChatStreamAI([{ content: 'unused' }]);
    const { controller } = createTimingController(aiService);
    const queue = new InMemorySyntheticObservationQueue();
    queue.push(memoryObservation('obs-dropped'));
    const slot = {
      queue,
      originTurn: 3,
      done: false,
      handle: { cancel: () => undefined, done: Promise.resolve() },
    };

    (controller as any).expireMemoryBranch(slot, 'test_drop');

    const dropped = runtime.byType('synthetic_observation_lifecycle')
      .filter(entry => entry.event.payload.outcome === 'dropped');
    assert.equal(dropped.length, 1, 'existing lifecycle telemetry stays intact');
    assert.equal(runtime.byType('injection_consumed').length, 0);
    assert.equal(runtime.byType('injection_first_action_ms').length, 0);
  });

  test('timing events carry ids and ms only — never message text, refs or raw content', async () => {
    const aiService = new ScriptedChatStreamAI([{ content: 'first done' }, { content: 'second done' }]);
    const { controller, queues } = createTimingController(aiService);
    const runTurn = (input: string) => controller.run({
      input,
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    await runTurn('turn one');
    queues[0].push(memoryObservation('obs-privacy'));
    await runTurn('turn two that mentions birthday dinner plans');

    const timingEvents = runtime.captured.filter(entry => TIMING_EVENT_TYPES.has(entry.event?.type));
    assert.ok(timingEvents.length > 0);
    for (const entry of timingEvents) {
      assertTimingPayloadHasNoContent(JSON.stringify(entry));
    }
    const consumed = runtime.byType('injection_consumed')[0];
    assert.deepEqual(
      Object.keys(consumed.event.payload).sort(),
      ['branch_ids', 'carryover', 'carryover_count', 'count', 'observation_ids', 'origin_turns', 'session_key', 'since_turn_start_ms', 'turn'],
    );
    const firstAction = runtime.byType('injection_first_action_ms')[0];
    assert.deepEqual(
      Object.keys(firstAction.event.payload).sort(),
      ['consumed_count', 'first_action_ms', 'kind', 'session_key', 'turn'],
    );
  });
});

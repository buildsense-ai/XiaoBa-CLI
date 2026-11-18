import { beforeEach, afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { Logger } from '../src/utils/logger';
import { SyntheticObservation } from '../src/core/synthetic-observation';
import { SessionMemoryBranchStore, normalizeMemoryBranchScope } from '../src/core/session-memory-branch';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';

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

function memoryObservation(id: string, summary = OBS_SUMMARY): SyntheticObservation {
  return {
    id,
    source: 'memory',
    status: 'completed',
    relevance: 'medium',
    summary,
    metadata: {
      branchId: `branch-${id}`,
      branchType: 'memory',
      refs: [OBS_REF],
    },
    formattedContent: JSON.stringify({
      source: 'memory',
      summary,
      refs: [OBS_REF],
    }),
  };
}

function assertTimingPayloadHasNoContent(serialized: string): void {
  assert.equal(serialized.includes('birthday dinner'), false, 'observation summary leaked into timing event');
  assert.equal(serialized.includes(OBS_REF), false, 'observation ref leaked into timing event');
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
      memoryBranch: { enabled: true, modelSource: 'inherit' },
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
      startRun: () => undefined,
      recordEvent: () => undefined,
      recordTurn: () => undefined,
    } as any,
    workspaceRoot: process.cwd(),
    getCurrentDirectory: () => process.cwd(),
    updateCurrentDirectory: () => undefined,
  });

  const queues: Array<{ push: (observation: SyntheticObservation) => boolean }> = [];
  // The Branch itself is not under test here: publications enter the session
  // store exactly as the Branch tools would, at this turn's input sequence.
  (controller as any).createMemorySidecarHandle = (slotOptions: any) => {
    const store = (controller as any).memoryBranchStore as SessionMemoryBranchStore;
    const queue = {
      push: (observation: SyntheticObservation) => store.push({
        ...observation,
        metadata: {
          ...(observation.metadata || {}),
          originTurn: slotOptions.originTurn,
          originTurnId: slotOptions.episodeId,
          verifiedThroughInput: slotOptions.memoryInput.sequence,
          memoryBranchScope: slotOptions.memoryInput.scope,
        },
      }),
    };
    queues.push(queue);
    options?.onQueueCreated?.(queue as any, slotOptions.turnNumber);
    return {
      branchId: 'timing-branch',
      done: new Promise<void>(() => undefined),
      outcome: () => 'idle' as const,
      cancel: () => undefined,
    };
  };
  return { controller, queues };
}

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

    // The newer input makes the earlier claim stale until the Branch
    // reconfirms it for this input; only then may the request contain it.
    const store = (controller as any).memoryBranchStore as SessionMemoryBranchStore;
    const scope = normalizeMemoryBranchScope({ sessionKey: SESSION_KEY, topicId: SESSION_KEY, actorUserId: 'unknown_actor' });
    const sequence = store.noteUserInput({ text: 'turn two continues the same topic', scope, turn: 2, turnId: 'input:2' });
    const observationId = store.snapshot().entries[0].id;
    assert.equal(store.reconfirm({ observationId, sequence, scope }).ok, true);
    await controller.run({
      input: 'turn two continues the same topic',
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
      memoryBranchInput: { sequence, turn: 2, turnId: 'input:2', scope },
    });

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
        queue.push(memoryObservation('obs-now-a', 'The first current-turn claim.'));
        queue.push(memoryObservation('obs-now-b', 'A different current-turn claim.'));
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

  test('expired observations stay out of the timing timeline', async () => {
    const aiService = new ScriptedChatStreamAI([{ content: 'unused' }]);
    const { controller } = createTimingController(aiService);
    const store = (controller as any).memoryBranchStore as SessionMemoryBranchStore;
    const scope = normalizeMemoryBranchScope({ sessionKey: SESSION_KEY, topicId: SESSION_KEY, actorUserId: 'unknown_actor' });
    store.publish({
      subject: 'dropped subject',
      claim: 'A claim that will be dropped.',
      sourceRefs: [OBS_REF],
      scope,
      originTurn: 3,
      originTurnId: 'episode:3',
      verifiedThroughInput: 0,
      branchId: 'timing-branch',
    });

    store.expireBranch('timing-branch', 'test_drop');

    const dropped = runtime.byType('memory_branch_observation_expired');
    assert.equal(dropped.length, 1, 'cancellation expires the queued claims');
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
    const store = (controller as any).memoryBranchStore as SessionMemoryBranchStore;
    const scope = normalizeMemoryBranchScope({ sessionKey: SESSION_KEY, topicId: SESSION_KEY, actorUserId: 'unknown_actor' });
    const sequence = store.noteUserInput({ text: 'turn two that mentions birthday dinner plans', scope, turn: 2, turnId: 'input:2' });
    const observationId = store.snapshot().entries[0].id;
    store.reconfirm({ observationId, sequence, scope });
    await controller.run({
      input: 'turn two that mentions birthday dinner plans',
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
      memoryBranchInput: { sequence, turn: 2, turnId: 'input:2', scope },
    });

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

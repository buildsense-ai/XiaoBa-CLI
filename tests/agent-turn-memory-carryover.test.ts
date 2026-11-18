import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import {
  BRANCH_AGENTS_ENABLED_ENV,
  MEMORY_SIDECAR_ENABLED_ENV,
} from '../src/core/branch-agent-settings';
import { SessionMemoryBranchStore, normalizeMemoryBranchScope } from '../src/core/session-memory-branch';
import { SYNTHETIC_OBSERVATION_TOOL_NAME } from '../src/core/synthetic-observation';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { Message } from '../src/types';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const scope = normalizeMemoryBranchScope({
  sessionKey: 'session:v2:catscompany:group:grp_test:agent:usr1',
  topicId: 'grp_test',
  actorUserId: 'usr1',
});
const otherScope = { ...scope, actorUserId: 'usr2' };

class CapturingAIService {
  requests: Message[][] = [];
  responses: Array<{ content: string | null; toolCalls?: any[] }> = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chatStream(messages: Message[]): Promise<any> {
    this.requests.push(JSON.parse(JSON.stringify(messages)));
    const response = this.responses.shift() || { content: 'done' };
    return { content: response.content, toolCalls: response.toolCalls || [], usage };
  }
}

function createController(options: {
  store?: SessionMemoryBranchStore;
  aiService: CapturingAIService;
  enabled?: boolean;
}): AgentTurnController {
  const aiService = options.aiService as any;
  const controller = new AgentTurnController({
    sessionKey: scope.sessionKey,
    sessionType: 'catscompany',
    ...(options.store ? { memoryBranchStore: options.store } : {}),
    services: {
      aiService,
      memoryBranch: { enabled: options.enabled ?? true, modelSource: 'inherit', aiService },
      toolManager: {
        getToolDefinitions: () => [{ name: 'continue_work', description: 'continue', parameters: { type: 'object', properties: {} } }],
        executeTool: async (call: any) => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'tool completed', ok: true }),
      } as any,
      skillManager: {} as any,
    },
    skillRuntime: { reloadSkills: async () => undefined, buildSkillsListMessage: () => null } as any,
    planRuntime: undefined as any,
    turnContextBuilder: new TurnContextBuilder(),
    turnLogRecorder: { startRun: () => undefined, recordEvent: () => undefined, recordTurn: () => undefined } as any,
    workspaceRoot: process.cwd(),
    getCurrentDirectory: () => process.cwd(),
    updateCurrentDirectory: () => undefined,
  });
  return controller;
}

function memoryPublication(claim = 'The approval covered the picture edit, not the narration track.') {
  return {
    subject: 'Meridian delivery',
    claim,
    sourceRefs: ['catscompany/2026-11-16/meridian.jsonl#7'],
    scope,
    originTurn: 1,
    originTurnId: 'episode:1',
    verifiedThroughInput: 1,
    branchId: 'branch-1',
  };
}

function syntheticMessages(request: Message[]): Message[] {
  return request.filter(message => message.__syntheticObservation);
}

describe('AgentTurnController session-scoped memory branch', () => {
  test('honors the persisted Branch switch even when legacy env switches are disabled', () => {
    const previousBranch = process.env[BRANCH_AGENTS_ENABLED_ENV];
    const previousMemory = process.env[MEMORY_SIDECAR_ENABLED_ENV];
    process.env[BRANCH_AGENTS_ENABLED_ENV] = 'false';
    process.env[MEMORY_SIDECAR_ENABLED_ENV] = 'false';
    try {
      const starts: any[] = [];
      const controller = createController({ aiService: new CapturingAIService(), enabled: true });
      (controller as any).createMemorySidecarHandle = (options: any) => {
        starts.push(options);
        return { branchId: 'branch-x', cancel: () => undefined, done: new Promise<void>(() => undefined), outcome: () => 'running' };
      };
      (controller as any).startMemoryInvestigation({
        turnNumber: 1,
        memoryInput: { sequence: 1, turn: 1, turnId: 'input:1', scope },
        episodeId: 'episode:1',
        input: 'hello',
        messages: [],
      });
      assert.equal(starts.length, 1);
    } finally {
      if (previousBranch === undefined) delete process.env[BRANCH_AGENTS_ENABLED_ENV];
      else process.env[BRANCH_AGENTS_ENABLED_ENV] = previousBranch;
      if (previousMemory === undefined) delete process.env[MEMORY_SIDECAR_ENABLED_ENV];
      else process.env[MEMORY_SIDECAR_ENABLED_ENV] = previousMemory;
    }
  });

  test('does not start a branch when the persisted switch is disabled', () => {
    const starts: any[] = [];
    const controller = createController({ aiService: new CapturingAIService(), enabled: false });
    (controller as any).createMemorySidecarHandle = (options: any) => {
      starts.push(options);
      return { branchId: 'branch-x', cancel: () => undefined, done: Promise.resolve(), outcome: () => 'finished' };
    };
    (controller as any).startMemoryInvestigation({
      turnNumber: 1,
      memoryInput: { sequence: 1, turn: 1, turnId: 'input:1', scope },
      episodeId: 'episode:1',
      input: 'hello',
      messages: [],
    });
    assert.equal(starts.length, 0);
  });

  test('holds an older verified claim on a new input and delivers it once after reconfirmation', async () => {
    const store = new SessionMemoryBranchStore();
    const ai = new CapturingAIService();
    const controller = createController({ store, aiService: ai });
    (controller as any).createMemorySidecarHandle = () => ({
      branchId: 'branch-1',
      cancel: () => undefined,
      done: new Promise<void>(() => undefined),
      outcome: () => 'running',
    });

    let messages: Message[] = [];
    let turn = 0;
    const runTurn = async (input: string, callbacks?: any) => {
      turn += 1;
      const memoryBranchInput = {
        sequence: store.noteUserInput({ text: input, scope, turn, turnId: `input:${turn}` }),
        turn,
        turnId: `input:${turn}`,
        scope,
      };
      const result = await controller.run({
        input,
        messages,
        runtimeFeedback: [],
        shouldContinue: () => true,
        memoryBranchInput,
        ...(callbacks ? { callbacks } : {}),
      });
      messages = result.messages;
      return result;
    };

    ai.responses = [{ content: 'first answer' }];
    await runTurn('What did we decide about the Meridian delivery note?');
    // The Branch verified this claim against input #1 (the admission sequence).
    assert.equal(store.publish(memoryPublication()).ok, true);

    ai.responses = [
      { content: null, toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'continue_work', arguments: '{}' } }] },
      { content: 'second answer' },
    ];
    await runTurn('Draft it for the 60-second cut.', {
      onToolStart: () => {
        // Reconfirmation happens after the first request of the new input and
        // before the next provider call of the same turn.
        const entry = store.snapshot().entries[0];
        const reconfirmed = store.reconfirm({
          observationId: entry.id,
          sequence: store.currentInputSequence,
          scope,
        });
        assert.equal(reconfirmed.ok, true);
      },
    });

    assert.equal(ai.requests.length, 3);
    assert.equal(syntheticMessages(ai.requests[1]).length, 0, 'claim verified for input #1 is held out of input #2');
    const injected = syntheticMessages(ai.requests[2]);
    assert.equal(injected.length, 2, 'reconfirmed claim reaches the next provider call');
    assert.equal(injected[0].tool_calls?.[0].function.name, SYNTHETIC_OBSERVATION_TOOL_NAME);
    const args = JSON.parse(injected[0].tool_calls?.[0].function.arguments || '{}');
    assert.equal(args.timing, 'late_previous_turn');
    assert.equal(JSON.parse(String(injected[1].content)).claim, memoryPublication().claim);

    const snapshot = store.snapshot();
    assert.equal(snapshot.entries[0].status, 'delivered');
    assert.equal(snapshot.entries[0].verifiedThroughInput, 2);
    assert.equal(snapshot.entries[0].deliveredTurn, 2);
  });

  test('never delivers another sender\'s claim in a group session', async () => {
    const store = new SessionMemoryBranchStore();
    const ai = new CapturingAIService();
    const controller = createController({ store, aiService: ai });
    (controller as any).createMemorySidecarHandle = () => ({
      branchId: 'branch-1',
      cancel: () => undefined,
      done: new Promise<void>(() => undefined),
      outcome: () => 'running',
    });

    store.noteUserInput({ text: 'sender A input', scope: otherScope, turn: 1, turnId: 'input:1' });
    assert.equal(store.publish({
      ...memoryPublication('Sender A learned the export is missing narration.'),
      scope: otherScope,
    }).ok, true);

    await controller.run({
      input: 'sender B asks about something else',
      messages: [],
      runtimeFeedback: [],
      shouldContinue: () => true,
      memoryBranchInput: { sequence: store.noteUserInput({ text: 'sender B input', scope, turn: 2, turnId: 'input:2' }), turn: 2, turnId: 'input:2', scope },
    });

    assert.equal(syntheticMessages(ai.requests[0]).length, 0, "sender B's request contains no sender A evidence");
    const entry = store.snapshot().entries[0];
    assert.equal(entry.status, 'held', "sender A's claim stays held for sender B's input");
  });

  test('event-driven activation replaces the removed refresh interval and passes prior publications', async () => {
    const starts: any[] = [];
    const controller = createController({ aiService: new CapturingAIService() });
    (controller as any).createMemorySidecarHandle = (options: any) => {
      const index = starts.length;
      starts.push(options);
      return {
        branchId: `branch-${index}`,
        cancel: () => undefined,
        done: new Promise<void>(() => undefined),
        outcome: () => 'running',
      };
    };
    const memoryInput = { sequence: 1, turn: 1, turnId: 'input:1', scope };
    (controller as any).startMemoryInvestigation({
      turnNumber: 1,
      memoryInput,
      episodeId: 'episode:1',
      input: 'root task',
      messages: [],
    });
    assert.equal(starts.length, 1);
    // A second event while the first investigation is in flight coalesces.
    (controller as any).startMemoryInvestigation({
      turnNumber: 1,
      memoryInput,
      episodeId: 'episode:1',
      input: 'root task',
      messages: [],
    });
    assert.equal(starts.length, 1, 'an active investigation never overlaps another');
    assert.deepEqual(starts[0].activationContext.deltaSinceLastRun, []);
  });
});

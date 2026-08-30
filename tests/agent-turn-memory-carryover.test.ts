import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import {
  BRANCH_AGENTS_ENABLED_ENV,
  MEMORY_SIDECAR_ENABLED_ENV,
} from '../src/core/branch-agent-settings';
import { InMemorySyntheticObservationQueue, SYNTHETIC_OBSERVATION_TOOL_NAME, SyntheticObservation } from '../src/core/synthetic-observation';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { Message } from '../src/types';
import { AIService } from '../src/utils/ai-service';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function memoryObservation(id: string): SyntheticObservation {
  return {
    id,
    source: 'memory',
    status: 'completed',
    relevance: 'medium',
    summary: 'Previous turn found the birthday dinner decision.',
    metadata: {
      branchId: `branch-${id}`,
      branchType: 'memory',
      refs: ['catscompany/2026-06-16/demo.jsonl#7'],
    },
    formattedContent: JSON.stringify({
      source: 'memory',
      summary: 'Previous turn found the birthday dinner decision.',
      refs: ['catscompany/2026-06-16/demo.jsonl#7'],
    }),
  };
}

class CapturingAIService {
  requests: Message[][] = [];
  responses = ['first done', 'second done', 'third done'];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chatStream(messages: Message[]): Promise<any> {
    this.requests.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: this.responses.shift() || 'done',
      toolCalls: [],
      usage,
    };
  }
}

function createMemoryBranchController(enabled: boolean): AgentTurnController {
  const aiService = new AIService({
    provider: 'openai',
    apiUrl: 'https://models.example.test/v1',
    apiKey: 'test-key',
    model: 'tool-model',
    modelCapabilities: { toolCalling: true },
  });
  const controller = new AgentTurnController({
    sessionKey: 'session:v2:catscompany:group:grp_test:agent:usr1',
    sessionType: 'catscompany',
    services: {
      aiService,
      memoryBranch: { enabled, modelSource: 'inherit', aiService },
      toolManager: {} as any,
      skillManager: {} as any,
    },
    skillRuntime: {} as any,
    planRuntime: undefined as any,
    turnContextBuilder: new TurnContextBuilder(),
    turnLogRecorder: {} as any,
    workspaceRoot: process.cwd(),
    getCurrentDirectory: () => process.cwd(),
    updateCurrentDirectory: () => undefined,
  });
  (controller as any).createMemorySidecarHandle = () => ({
    cancel: () => undefined,
    done: Promise.resolve(),
  });
  return controller;
}

describe('AgentTurnController memory branch carryover', () => {
  test('uses the persisted Branch switch even when both legacy env switches are disabled', () => {
    const previousBranch = process.env[BRANCH_AGENTS_ENABLED_ENV];
    const previousMemory = process.env[MEMORY_SIDECAR_ENABLED_ENV];
    process.env[BRANCH_AGENTS_ENABLED_ENV] = 'false';
    process.env[MEMORY_SIDECAR_ENABLED_ENV] = 'false';
    try {
      const controller = createMemoryBranchController(true);
      const slot = (controller as any).startMemorySidecarIfEnabled({
        turnNumber: 1,
        input: 'hello',
        messages: [],
      });
      assert.notEqual(slot, null);
    } finally {
      if (previousBranch === undefined) {
        delete process.env[BRANCH_AGENTS_ENABLED_ENV];
      } else {
        process.env[BRANCH_AGENTS_ENABLED_ENV] = previousBranch;
      }
      if (previousMemory === undefined) delete process.env[MEMORY_SIDECAR_ENABLED_ENV];
      else process.env[MEMORY_SIDECAR_ENABLED_ENV] = previousMemory;
    }
  });

  test('does not start memory sidecar when the persisted Branch switch is disabled', () => {
    const controller = createMemoryBranchController(false);
    const slot = (controller as any).startMemorySidecarIfEnabled({
      turnNumber: 1,
      input: 'hello',
      messages: [],
    });
    assert.equal(slot, null);
  });

  test('injects previous-turn memory as a legal late synthetic tool pair and expires it after one turn', async () => {
    const aiService = new CapturingAIService();
    const queues: InMemorySyntheticObservationQueue[] = [];
    const cancelled: boolean[] = [];
    const controller = new AgentTurnController({
      sessionKey: 'session:v2:catscompany:group:grp_test:agent:usr1',
      sessionType: 'catscompany',
      services: {
        aiService: aiService as any,
        toolManager: {
          getToolDefinitions: () => [],
          executeTool: async () => {
            throw new Error('not expected');
          },
        } as any,
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

    (controller as any).startMemorySidecarIfEnabled = (options: { turnNumber: number }) => {
      const queue = new InMemorySyntheticObservationQueue();
      const index = queues.length;
      queues.push(queue);
      cancelled[index] = false;
      return {
        queue,
        originTurn: options.turnNumber,
        done: false,
        handle: {
          cancel: () => {
            cancelled[index] = true;
          },
          done: new Promise<void>(() => undefined),
        },
      };
    };

    let messages: Message[] = [];
    const runTurn = async (input: string) => {
      const result = await controller.run({
        input,
        messages,
        runtimeFeedback: [],
        shouldContinue: () => true,
      });
      messages = result.messages;
      return result;
    };

    await runTurn('turn one');
    assert.equal(aiService.requests.length, 1);
    assert.equal(queues[0].push(memoryObservation('late-one')), true);

    await runTurn('turn two continues the same topic');
    assert.equal(aiService.requests.length, 2);

    const secondRequest = aiService.requests[1];
    const synthetic = secondRequest.filter(message => message.__syntheticObservation);
    assert.equal(synthetic.length, 2);
    assert.equal(synthetic[0].role, 'assistant');
    assert.equal(synthetic[1].role, 'tool');
    assert.equal(synthetic[0].tool_calls?.[0].function.name, SYNTHETIC_OBSERVATION_TOOL_NAME);
    assert.equal(synthetic[1].tool_call_id, synthetic[0].tool_calls?.[0].id);

    const callArgs = JSON.parse(synthetic[0].tool_calls?.[0].function.arguments || '{}');
    const resultContent = JSON.parse(String(synthetic[1].content));
    assert.equal(callArgs.timing, 'late_previous_turn');
    assert.equal(resultContent.timing, 'late_previous_turn');
    assert.equal(resultContent.summary, 'Previous turn found the birthday dinner decision.');

    const currentUserIndex = secondRequest.findIndex(message => message.role === 'user' && message.content === 'turn two continues the same topic');
    const syntheticCallIndex = secondRequest.indexOf(synthetic[0]);
    const syntheticResultIndex = secondRequest.indexOf(synthetic[1]);
    assert.ok(currentUserIndex >= 0);
    assert.ok(currentUserIndex < syntheticCallIndex);
    assert.ok(syntheticCallIndex < syntheticResultIndex);
    assert.equal(cancelled[0], true, 'previous-turn branch is expired after its carryover turn');
    assert.equal(queues[0].push(memoryObservation('too-late')), false);

    await runTurn('turn three should not receive turn one memory');
    const thirdSynthetic = aiService.requests[2].filter(message => message.__syntheticObservation);
    assert.equal(thirdSynthetic.length, 0);
  });
});

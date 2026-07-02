import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { BRANCH_AGENTS_ENABLED_ENV } from '../src/core/branch-agent-settings';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import {
  TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX,
  buildPromptModeRouterObservation,
} from '../src/core/prompt-mode-runtime';
import { TRANSIENT_FIXED_PROMPT_MODE_PREFIX, TRANSIENT_PROMPT_MODES_LIST_PREFIX } from '../src/runtime/prompt-modes';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { PlanRuntime } from '../src/core/plan-runtime';
import { Message } from '../src/types';
import { AIService } from '../src/utils/ai-service';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

class CapturingAIService {
  requests: Message[][] = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chatStream(messages: Message[]): Promise<any> {
    this.requests.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: `done ${this.requests.length}`,
      toolCalls: [],
      usage,
    };
  }
}

describe('AgentTurnController prompt mode router integration', () => {
  let previousBranchEnv: string | undefined;
  let previousRouterEnv: string | undefined;

  beforeEach(() => {
    previousBranchEnv = process.env[BRANCH_AGENTS_ENABLED_ENV];
    previousRouterEnv = process.env.XIAOBA_PROMPT_MODE_ROUTER_ENABLED;
    process.env[BRANCH_AGENTS_ENABLED_ENV] = 'true';
    delete process.env.XIAOBA_PROMPT_MODE_ROUTER_ENABLED;
  });

  afterEach(() => {
    if (previousBranchEnv === undefined) {
      delete process.env[BRANCH_AGENTS_ENABLED_ENV];
    } else {
      process.env[BRANCH_AGENTS_ENABLED_ENV] = previousBranchEnv;
    }
    if (previousRouterEnv === undefined) {
      delete process.env.XIAOBA_PROMPT_MODE_ROUTER_ENABLED;
    } else {
      process.env.XIAOBA_PROMPT_MODE_ROUTER_ENABLED = previousRouterEnv;
    }
  });

  test('mode router requires explicit environment opt-in', () => {
    const aiService = Object.create(AIService.prototype);
    const controller = buildController(aiService);

    assert.equal((controller as any).isPromptModeRouterEnabled(true, undefined), false);
    process.env.XIAOBA_PROMPT_MODE_ROUTER_ENABLED = 'false';
    assert.equal((controller as any).isPromptModeRouterEnabled(true, undefined), false);
    process.env.XIAOBA_PROMPT_MODE_ROUTER_ENABLED = 'true';
    assert.equal((controller as any).isPromptModeRouterEnabled(true, undefined), true);
  });

  test('carries a late mode router result into the next user turn', async () => {
    const aiService = new CapturingAIService();
    const queues: InMemorySyntheticObservationQueue[] = [];
    const controller = buildController(aiService);

    (controller as any).isPromptModeRouterEnabled = () => true;
    (controller as any).startModeRouterIfEnabled = (options: { turnNumber: number; enabled: boolean }) => {
      if (!options.enabled) return null;
      const queue = new InMemorySyntheticObservationQueue();
      queues.push(queue);
      return {
        queue,
        originTurn: options.turnNumber,
        done: false,
        handle: {
          cancel: () => undefined,
          done: new Promise<void>(() => undefined),
        },
      };
    };

    let messages: Message[] = [];
    let result = await controller.run({
      input: 'debug this build',
      messages,
      runtimeFeedback: [],
      shouldContinue: () => true,
    });
    messages = result.messages;
    assert.equal(aiService.requests.length, 1);
    assert.equal(hasPrefix(aiService.requests[0], TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX), false);
    assert.equal(hasPrefix(aiService.requests[0], TRANSIENT_PROMPT_MODES_LIST_PREFIX), false);

    assert.equal(queues[0].push(buildPromptModeRouterObservation({
      action: 'activate',
      mode: 'coding-agent',
      confidence: 0.93,
      reason: 'local build debugging',
    })), true);

    result = await controller.run({
      input: 'continue',
      messages,
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    assert.equal(aiService.requests.length, 2);
    assert.equal(hasPrefix(aiService.requests[1], TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX), true);
    assert.equal(hasPrefix(aiService.requests[1], TRANSIENT_PROMPT_MODES_LIST_PREFIX), false);
    assert.match(allContent(aiService.requests[1]), /\[mode:coding-agent\]/);
    assert.match(allContent(aiService.requests[1]), /Timing: selected from turn 1 and arrived late/);
    assert.equal(hasPrefix(result.messages, TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX), false);

    messages = result.messages;
    result = await controller.run({
      input: 'continue again',
      messages,
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    assert.equal(aiService.requests.length, 3);
    assert.equal(hasPrefix(aiService.requests[2], TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX), true);
    assert.equal(hasPrefix(aiService.requests[2], TRANSIENT_PROMPT_MODES_LIST_PREFIX), false);
    assert.match(allContent(aiService.requests[2]), /Full mode instructions were already supplied on turn 2/);
    assert.doesNotMatch(allContent(aiService.requests[2]), /\[mode:coding-agent\]/);

    messages = result.messages;
    result = await controller.run({
      input: 'continue once more',
      messages,
      runtimeFeedback: [],
      shouldContinue: () => true,
    });
    assert.equal(aiService.requests.length, 4);
    assert.doesNotMatch(allContent(aiService.requests[3]), /\[mode:coding-agent\]/);

    messages = result.messages;
    result = await controller.run({
      input: 'still same task',
      messages,
      runtimeFeedback: [],
      shouldContinue: () => true,
    });
    assert.equal(aiService.requests.length, 5);
    assert.match(allContent(aiService.requests[4]), /\[mode:coding-agent\]/);
  });

  test('fixed mode suppresses router list and async active mode', async () => {
    const aiService = new CapturingAIService();
    const controller = buildController(aiService);
    let enabledStarts = 0;

    (controller as any).promptModeRuntime.applyRouterPayload({
      action: 'activate',
      mode: 'office',
      confidence: 0.95,
      reason: 'preloaded async mode',
    }, 1);
    (controller as any).isPromptModeRouterEnabled = (branchAgentsEnabled: boolean, fixedMode: unknown) => {
      return branchAgentsEnabled && !fixedMode;
    };
    (controller as any).startModeRouterIfEnabled = (options: { enabled: boolean }) => {
      if (options.enabled) enabledStarts += 1;
      return null;
    };

    await controller.run({
      input: 'debug this build',
      messages: [
        { role: 'system', content: 'base\n[mode:coding-agent]\nfixed coding instructions' },
      ],
      runtimeFeedback: [],
      shouldContinue: () => true,
    });

    assert.equal(enabledStarts, 0);
    assert.equal(hasPrefix(aiService.requests[0], TRANSIENT_FIXED_PROMPT_MODE_PREFIX), true);
    assert.equal(hasPrefix(aiService.requests[0], TRANSIENT_PROMPT_MODES_LIST_PREFIX), false);
    assert.equal(hasPrefix(aiService.requests[0], TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX), false);
  });
});

function buildController(aiService: any): AgentTurnController {
  return new AgentTurnController({
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
    planRuntime: new PlanRuntime(),
    turnContextBuilder: new TurnContextBuilder(),
    turnLogRecorder: {
      recordTurn: () => undefined,
    } as any,
    workspaceRoot: process.cwd(),
    getCurrentDirectory: () => process.cwd(),
    updateCurrentDirectory: () => undefined,
  });
}

function hasPrefix(messages: Message[], prefix: string): boolean {
  return messages.some(message => (
    typeof message.content === 'string'
    && message.content.startsWith(prefix)
  ));
}

function allContent(messages: Message[]): string {
  return messages.map(message => (
    typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content)
  )).join('\n');
}

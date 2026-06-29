import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModeRouterBranchSession } from '../src/core/mode-router-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { PromptModeRuntime } from '../src/core/prompt-mode-runtime';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function makeToolCall(id: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'finish_prompt_mode_routing',
      arguments: JSON.stringify(args),
    },
  };
}

class ModeRouterAI {
  calls: Message[][] = [];
  chatCalls = 0;

  constructor(private readonly args: unknown) {}

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(): Promise<ChatResponse> {
    this.chatCalls += 1;
    assert.fail('mode router branch should use chatStream');
  }

  async chatStream(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    assert.equal(tools?.map(tool => tool.name).join(','), 'finish_prompt_mode_routing');
    return {
      content: null,
      toolCalls: [makeToolCall('finish_1', this.args)],
      usage,
    };
  }
}

class HangingModeRouterAI {
  chatCalls = 0;
  streamCalls = 0;
  aborted = false;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(): Promise<ChatResponse> {
    this.chatCalls += 1;
    assert.fail('mode router branch should use chatStream');
  }

  chatStream(
    _messages: Message[],
    _tools?: ToolDefinition[],
    _callbacks?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<ChatResponse> {
    this.streamCalls += 1;
    options?.signal?.addEventListener('abort', () => {
      this.aborted = true;
    }, { once: true });
    return new Promise<ChatResponse>(() => undefined);
  }
}

describe('mode router branch', () => {
  test('publishes activate, clear, and ignore router observations', async () => {
    for (const args of [
      {
        action: 'activate',
        mode: 'coding-agent',
        confidence: 0.92,
        reason: 'local build debugging',
      },
      {
        action: 'clear',
        confidence: 0.88,
        reason: 'topic changed to casual chat',
      },
      {
        action: 'ignore',
        confidence: 0.3,
        reason: 'no clear mode',
      },
    ]) {
      const queue = new InMemorySyntheticObservationQueue();
      const aiService = new ModeRouterAI(args);
      const session = new ModeRouterBranchSession({
        sessionKey: 'mode-router-test',
        input: 'debug this build',
        recentMessages: [],
        workingDirectory: process.cwd(),
        aiService: aiService as any,
        queue,
        logEnabled: false,
      });

      await session.run();
      const observations = queue.drain();
      assert.equal(observations.length, 1);
      const payload = JSON.parse(String(observations[0].formattedContent));
      assert.equal(payload.source, 'prompt_mode_router');
      assert.equal(payload.action, (args as any).action);
      assert.equal(aiService.calls.length, 1);
      assert.equal(aiService.chatCalls, 0);
    }
  });

  test('runtime ignores invalid router mode from branch output', async () => {
    const promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-mode-router-invalid-'));
    try {
      fs.mkdirSync(path.join(promptsDir, 'modes'), { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'modes', 'coding-agent.md'), [
        '---',
        'id: coding-agent',
        'name: Coding Agent',
        'description: Work on code',
        '---',
        '',
        'Use engineering workflow.',
      ].join('\n'), 'utf-8');

      const queue = new InMemorySyntheticObservationQueue();
      const session = new ModeRouterBranchSession({
        sessionKey: 'mode-router-invalid',
        input: 'debug this build',
        recentMessages: [],
        workingDirectory: process.cwd(),
        aiService: new ModeRouterAI({
          action: 'activate',
          mode: 'does-not-exist',
          confidence: 0.99,
          reason: 'bad model output',
        }) as any,
        queue,
        logEnabled: false,
        promptsDir,
      });

      await session.run();
      const runtime = new PromptModeRuntime({ promptsDir });
      runtime.beginTurn(1);
      runtime.applyRouterObservations(queue.drain(), 1);
      assert.equal(runtime.buildTransientMessage({ turnNumber: 1 }), null);
    } finally {
      fs.rmSync(promptsDir, { recursive: true, force: true });
    }
  });

  test('times out hanging model requests without publishing router observations', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new HangingModeRouterAI();
    const session = new ModeRouterBranchSession({
      sessionKey: 'mode-router-timeout',
      input: 'debug this build',
      recentMessages: [],
      workingDirectory: process.cwd(),
      aiService: aiService as any,
      queue,
      logEnabled: false,
      modelTimeoutMs: 20,
    });

    await session.run();

    assert.equal(aiService.streamCalls, 1);
    assert.equal(aiService.chatCalls, 0);
    assert.equal(aiService.aborted, true);
    assert.equal(queue.drain().length, 0);
  });
});

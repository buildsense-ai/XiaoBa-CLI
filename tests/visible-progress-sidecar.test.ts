import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import { VisibleProgressBranchSession } from '../src/core/visible-progress-branch-session';
import { VisibleProgressRuntime } from '../src/core/visible-progress-runtime';
import { VisibleProgressFinishPayload } from '../src/tools/visible-progress-tools';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const initialTurnState = {
  emittedCount: 0,
  shouldBeConservative: false,
  emitAgainPolicy: 'No progress has been emitted yet.',
};

function makeToolCall(id: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'finish_visible_progress',
      arguments: JSON.stringify(args),
    },
  };
}

class VisibleProgressAI {
  calls: Message[][] = [];

  constructor(private readonly nextPayload: () => Promise<VisibleProgressFinishPayload> | VisibleProgressFinishPayload) {}

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    assert.equal(tools?.map(tool => tool.name).join(','), 'finish_visible_progress');
    const payload = await this.nextPayload();
    return {
      content: null,
      toolCalls: [makeToolCall('finish_1', payload)],
      usage,
    };
  }

  async chatStream(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    return this.chat(messages, tools);
  }
}

describe('visible progress sidecar', () => {
  test('branch returns an emit payload from finish_visible_progress', async () => {
    const aiService = new VisibleProgressAI(() => ({
      action: 'emit',
      text: '?????????????',
      reason: 'useful_progress',
    }));
    const session = new VisibleProgressBranchSession({
      sessionKey: 'visible-progress-branch-test',
      snapshot: {
        currentUserInput: '??????????',
        surface: 'cli',
        recentContext: [],
        emittedProgress: [],
        turnState: initialTurnState,
        events: [
          {
            type: 'model_prelude',
            text: '?? bug ??`coupon.value` ??????subtotal 250 ? 0.8 = 200?',
          },
        ],
      },
      workingDirectory: process.cwd(),
      aiService: aiService as any,
      logEnabled: false,
    });

    const payload = await session.run();

    assert.deepEqual(payload, {
      action: 'emit',
      text: '?????????????',
      reason: 'useful_progress',
    });
    assert.match(String(aiService.calls[0][1].content), /model_prelude/);
  });

  test('runtime emits sidecar progress and skips skip payloads', async () => {
    const emitted: string[] = [];
    const runtime = new VisibleProgressRuntime({
      sessionKey: 'visible-progress-runtime-test',
      input: '???? build ??',
      recentMessages: [],
      workingDirectory: process.cwd(),
      surface: 'cli',
      aiService: new VisibleProgressAI(() => ({
        action: 'emit',
        text: '??????????????',
        reason: 'turn_start',
      })) as any,
      logEnabled: false,
      onProgress: text => emitted.push(text),
    });

    runtime.recordEvent({ type: 'turn_started' });
    await runtime.waitForIdle();

    assert.deepEqual(emitted, ['??????????????']);

    const skipped: string[] = [];
    const skipRuntime = new VisibleProgressRuntime({
      sessionKey: 'visible-progress-runtime-skip-test',
      input: '???? build ??',
      recentMessages: [],
      workingDirectory: process.cwd(),
      surface: 'cli',
      aiService: new VisibleProgressAI(() => ({
        action: 'skip',
        reason: 'tool_bookkeeping',
      })) as any,
      logEnabled: false,
      onProgress: text => skipped.push(text),
    });

    skipRuntime.recordEvent({ type: 'model_prelude', text: '??????' });
    await skipRuntime.waitForIdle();

    assert.deepEqual(skipped, []);
  });

  test('runtime marks later snapshots conservative after emitting progress', async () => {
    const emitted: string[] = [];
    const payloads: VisibleProgressFinishPayload[] = [
      {
        action: 'emit',
        text: 'I will check the failing output first.',
        reason: 'turn_start',
      },
      {
        action: 'skip',
        reason: 'already_updated',
      },
    ];
    const aiService = new VisibleProgressAI(() => payloads.shift()!);
    const runtime = new VisibleProgressRuntime({
      sessionKey: 'visible-progress-runtime-budget-test',
      input: 'debug build failure',
      recentMessages: [],
      workingDirectory: process.cwd(),
      surface: 'cli',
      aiService: aiService as any,
      logEnabled: false,
      onProgress: text => emitted.push(text),
    });

    runtime.recordEvent({ type: 'turn_started' });
    await runtime.waitForIdle();
    runtime.recordEvent({ type: 'tool_started', toolName: 'read_file' });
    await runtime.waitForIdle();

    assert.deepEqual(emitted, ['I will check the failing output first.']);
    assert.equal(aiService.calls.length, 2);

    const firstPayload = JSON.parse(String(aiService.calls[0][1].content));
    const secondPayload = JSON.parse(String(aiService.calls[1][1].content));
    assert.equal(firstPayload.turn_progress_state.should_be_conservative, false);
    assert.match(firstPayload.turn_progress_state.emit_again_policy, /Skip for quick direct answers/);
    assert.equal(secondPayload.turn_progress_state.should_be_conservative, true);
    assert.equal(secondPayload.turn_progress_state.already_emitted_count, 1);
    assert.match(secondPayload.turn_progress_state.emit_again_policy, /Default to skip/);
  });

  test('runtime drops late sidecar results after close', async () => {
    const emitted: string[] = [];
    let resolvePayload!: (payload: VisibleProgressFinishPayload) => void;
    const payloadPromise = new Promise<VisibleProgressFinishPayload>(resolve => {
      resolvePayload = resolve;
    });
    const runtime = new VisibleProgressRuntime({
      sessionKey: 'visible-progress-runtime-late-test',
      input: '?????',
      recentMessages: [],
      workingDirectory: process.cwd(),
      surface: 'cli',
      aiService: new VisibleProgressAI(() => payloadPromise) as any,
      logEnabled: false,
      onProgress: text => emitted.push(text),
    });

    runtime.recordEvent({ type: 'model_prelude', text: '?????????????' });
    runtime.close('test_finished');
    resolvePayload({
      action: 'emit',
      text: '????????????',
      reason: 'late',
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(emitted, []);
  });
});

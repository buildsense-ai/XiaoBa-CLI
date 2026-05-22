import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRunner } from '../src/core/conversation-runner';
import { Message } from '../src/types';
import { ToolDefinition, ToolExecutor, ToolCall, ToolResult } from '../src/types/tool';

class EmptyToolExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    throw new Error(`unexpected tool call: ${toolCall.function.name}`);
  }
}

test('ConversationRunner passes AbortSignal to streamed model requests', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;

  const aiService = {
    async chatStream(_messages: Message[], _tools: ToolDefinition[], _callbacks: any, options: any = {}) {
      observedSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
      });
    },
  };

  const runner = new ConversationRunner(aiService as any, new EmptyToolExecutor(), {
    enableCompression: false,
    toolExecutionContext: { abortSignal: controller.signal },
  });

  const runPromise = runner.run([{ role: 'user', content: 'wait' }]);
  await waitFor(() => observedSignal === controller.signal);
  controller.abort();

  await assert.rejects(runPromise, /aborted by test/);
  assert.equal(observedSignal?.aborted, true);
});

test('ConversationRunner reuses AbortSignal after prompt-too-long trim retry', async () => {
  const controller = new AbortController();
  const observedSignals: Array<AbortSignal | undefined> = [];
  let calls = 0;

  const aiService = {
    async chat(_messages: Message[], _tools: ToolDefinition[], options: any = {}) {
      observedSignals.push(options.signal);
      calls++;
      if (calls === 1) {
        throw new Error('maximum context length exceeded');
      }
      return {
        content: 'done',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runner = new ConversationRunner(aiService as any, new EmptyToolExecutor(), {
    stream: false,
    enableCompression: false,
    toolExecutionContext: { abortSignal: controller.signal },
  });

  const result = await runner.run([{ role: 'user', content: 'x'.repeat(2000) }]);

  assert.equal(result.response, 'done');
  assert.equal(calls, 2);
  assert.deepEqual(observedSignals, [controller.signal, controller.signal]);
});

async function waitFor(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}

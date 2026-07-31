import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import type { Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';
import { Metrics } from '../src/utils/metrics';

class EmptyToolExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: 'unused',
      ok: true,
    };
  }
}

describe('ConversationRunner cache scope and metrics', () => {
  test('passes the stable session id as the prompt cache scope', async () => {
    let seenScope: string | undefined;
    const aiService = {
      chat: async (_messages: Message[], _tools: ToolDefinition[], options: any) => {
        seenScope = options?.promptCacheScopeKey;
        return {
          content: 'done',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
      },
    } as any;
    const runner = new ConversationRunner(aiService, new EmptyToolExecutor(), {
      stream: false,
      enableCompression: false,
      toolExecutionContext: { sessionId: 'session-cache-a' },
    });

    await runner.run([{ role: 'user', content: 'hello' }]);

    assert.equal(seenScope, 'session-cache-a');
  });

  test('keeps concurrent runner metrics isolated', async () => {
    const firstMetrics = new Metrics();
    const secondMetrics = new Metrics();
    let firstCallCount = 0;
    let notifyToolStarted!: () => void;
    let releaseTool!: () => void;
    const toolStarted = new Promise<void>(resolve => { notifyToolStarted = resolve; });
    const toolRelease = new Promise<void>(resolve => { releaseTool = resolve; });
    const firstRunner = new ConversationRunner({
      chat: async () => {
        firstCallCount += 1;
        return firstCallCount === 1
          ? {
              content: null,
              toolCalls: [{
                id: 'first-tool-call',
                type: 'function',
                function: { name: 'wait', arguments: '{}' },
              }],
              usage: {
                promptTokens: 60,
                completionTokens: 10,
                totalTokens: 70,
                cachedReadTokens: 40,
              },
            }
          : {
              content: 'first',
              usage: {
                promptTokens: 40,
                completionTokens: 10,
                totalTokens: 50,
                cachedReadTokens: 20,
              },
            };
      },
    } as any, {
      getToolDefinitions: () => [{
        name: 'wait',
        description: 'wait',
        parameters: { type: 'object', properties: {} },
      }],
      executeTool: async (toolCall: ToolCall): Promise<ToolResult> => {
        notifyToolStarted();
        await toolRelease;
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: 'released',
          ok: true,
        };
      },
    }, {
      stream: false,
      enableCompression: false,
      metrics: firstMetrics,
    });
    const secondRunner = new ConversationRunner({
      chat: async () => ({
        content: 'second',
        usage: {
          promptTokens: 25,
          completionTokens: 5,
          totalTokens: 30,
          cachedReadTokens: 5,
        },
      }),
    } as any, new EmptyToolExecutor(), {
      stream: false,
      enableCompression: false,
      metrics: secondMetrics,
    });

    const firstRun = firstRunner.run([{ role: 'user', content: 'first request' }]);
    await toolStarted;
    await secondRunner.run([{ role: 'user', content: 'second request' }]);
    secondMetrics.reset();
    releaseTool();
    await firstRun;

    const firstSummary = firstMetrics.getSummary();
    assert.equal(firstSummary.aiCalls, 2);
    assert.equal(firstSummary.totalPromptTokens, 100);
    assert.equal(firstSummary.totalCompletionTokens, 20);
    assert.equal(firstSummary.totalTokens, 120);
    assert.equal(firstSummary.totalCachedReadTokens, 60);
    assert.equal(firstSummary.totalCachedWriteTokens, 0);
    assert.equal(firstSummary.cacheReadRatio, 0.6);
    assert.equal(firstSummary.toolCalls, 1);
    assert.equal(firstSummary.toolBreakdown.wait.count, 1);
    assert.equal(firstSummary.toolBreakdown.wait.totalMs, firstSummary.toolDurationMs);
    assert.ok(firstSummary.toolDurationMs >= 0);
    assert.equal(secondMetrics.getSummary().aiCalls, 0);
  });
});

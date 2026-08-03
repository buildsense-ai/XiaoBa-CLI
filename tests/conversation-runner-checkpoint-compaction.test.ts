import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import { CHECKPOINT_SUMMARY_PREFIX } from '../src/core/checkpoint-compaction';
import { ConversationRunner } from '../src/core/conversation-runner';
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '../src/types/tool';

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

test('runner checkpoints only after a complete tool result and resumes the same episode', async () => {
  const events: string[] = [];
  const modelRequests: Message[][] = [];
  const aiService = {
    chat: async (messages: Message[]) => {
      modelRequests.push(messages.map(message => ({ ...message })));
      if (modelRequests.length === 1) {
        events.push('model:first');
        return {
          content: null,
          toolCalls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'inspect', arguments: '{}' },
          }],
          usage,
        };
      }
      events.push('model:second');
      return { content: 'continued successfully', toolCalls: [], usage };
    },
  } as any;
  const tool: ToolDefinition = {
    name: 'inspect',
    description: 'inspect',
    parameters: { type: 'object', properties: {} },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [tool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => {
      events.push('tool:complete');
      return {
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: 'verified tool evidence',
        ok: true,
      };
    },
  };
  let checkpointRequest: any;
  const coordinator = {
    compactIfNeeded: async (messages: Message[], request: any) => {
      checkpointRequest = request;
      events.push('checkpoint');
      assert.ok(messages.some(message =>
        message.role === 'tool' && message.content === 'verified tool evidence'));
      return {
        messages: [{
          role: 'user',
          content: `${CHECKPOINT_SUMMARY_PREFIX}\n\nContinue from verified tool evidence.`,
          __checkpointSummary: true,
          __episodeId: 'episode-main',
        }],
        compacted: true,
        usedTokens: 100,
        toolTokens: 10,
        maxTokens: 100,
        usagePercent: 110,
      };
    },
  } as any;

  const runner = new ConversationRunner(aiService, executor, {
    stream: false,
    episodeId: 'episode-main',
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async messages => {
      events.push('persist');
      assert.ok(messages.some(message => message.__checkpointSummary));
    },
  });

  const result = await runner.run([{
    role: 'user',
    content: 'inspect and continue',
    __episodeId: 'episode-main',
  }]);

  assert.equal(result.response, 'continued successfully');
  assert.equal(checkpointRequest.phase, 'mid_turn');
  assert.deepEqual(events, [
    'model:first',
    'tool:complete',
    'checkpoint',
    'persist',
    'model:second',
  ]);
  assert.ok(modelRequests[1].some(message => message.__checkpointSummary));
});

test('runner keeps the original transcript when checkpoint persistence fails', async () => {
  const modelRequests: Message[][] = [];
  const aiService = {
    chat: async (messages: Message[]) => {
      modelRequests.push(messages.map(message => ({ ...message })));
      if (modelRequests.length === 1) {
        return {
          content: null,
          toolCalls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'inspect', arguments: '{}' },
          }],
          usage,
        };
      }
      return { content: 'continued with original transcript', toolCalls: [], usage };
    },
  } as any;
  const tool: ToolDefinition = {
    name: 'inspect',
    description: 'inspect',
    parameters: { type: 'object', properties: {} },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [tool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => ({
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: 'verified tool evidence',
      ok: true,
    }),
  };
  const coordinator = {
    compactIfNeeded: async () => ({
      messages: [{
        role: 'user',
        content: `${CHECKPOINT_SUMMARY_PREFIX}\n\nThis checkpoint must not be used.`,
        __checkpointSummary: true,
      }],
      compacted: true,
      usedTokens: 100,
      toolTokens: 10,
      maxTokens: 100,
      usagePercent: 110,
    }),
  } as any;

  const runner = new ConversationRunner(aiService, executor, {
    stream: false,
    episodeId: 'episode-main',
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => {
      throw new Error('disk full');
    },
  });

  const result = await runner.run([{
    role: 'user',
    content: 'inspect and continue',
    __episodeId: 'episode-main',
  }]);

  assert.equal(result.response, 'continued with original transcript');
  assert.ok(modelRequests[1].some(message =>
    message.role === 'tool' && message.content === 'verified tool evidence'));
  assert.equal(modelRequests[1].some(message => message.__checkpointSummary), false);
});

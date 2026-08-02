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
      if (!messages.some(message => message.role === 'tool')) {
        return {
          messages,
          compacted: false,
          attempted: false,
          usedTokens: 10,
          toolTokens: 10,
          maxTokens: 100,
          usagePercent: 20,
        };
      }
      checkpointRequest = request;
      events.push('checkpoint');
      assert.ok(messages.some(message =>
        message.role === 'tool' && message.content === 'verified tool evidence'));
      assert.ok(messages.some(message => (
        message.role === 'assistant'
        && message.tool_calls?.[0]?.id === 'call-1'
        && message.__episodeId === 'episode-main'
      )));
      assert.deepEqual(messages.find(message => message.role === 'tool')?.__toolResultState, {
        status: 'success',
        retryable: false,
      });
      return {
        messages: [{
          role: 'user',
          content: `${CHECKPOINT_SUMMARY_PREFIX}\n\nContinue from verified tool evidence.`,
          __checkpointSummary: true,
          __episodeId: 'episode-main',
        }],
        compacted: true,
        attempted: true,
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
    toolExecutionContext: {
      sessionId: 'session:v2:catscompany:group:checkpoint-main',
      surface: 'catscompany',
    },
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
  assert.equal(checkpointRequest.modelRequestOptions.modelAttemptSink, undefined);
  assert.deepEqual(checkpointRequest.modelRequestOptions.modelAttemptContext, {
    sessionId: 'session:v2:catscompany:group:checkpoint-main',
    surface: 'catscompany',
    episodeId: 'episode-main',
    episodeNumber: 2,
  });
  assert.deepEqual(events, [
    'model:first',
    'tool:complete',
    'checkpoint',
    'persist',
    'model:second',
  ]);
  assert.ok(modelRequests[1].some(message => message.__checkpointSummary));
});

test('runner preserves the original transcript and stops when checkpoint persistence fails', async () => {
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
    compactIfNeeded: async (messages: Message[]) => {
      if (!messages.some(message => message.role === 'tool')) {
        return {
          messages,
          compacted: false,
          attempted: false,
          usedTokens: 10,
          toolTokens: 10,
          maxTokens: 100,
          usagePercent: 20,
        };
      }
      return {
        messages: [{
          role: 'user',
          content: `${CHECKPOINT_SUMMARY_PREFIX}\n\nThis checkpoint must not be used.`,
          __checkpointSummary: true,
        }],
        compacted: true,
        attempted: true,
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
    onCompactionCheckpoint: async () => {
      throw new Error('disk full');
    },
  });

  const messages: Message[] = [{
    role: 'user',
    content: 'inspect and continue',
    __episodeId: 'episode-main',
  }];

  await assert.rejects(runner.run(messages), /checkpoint persistence failed/);
  assert.equal(modelRequests.length, 1);
  assert.ok(messages.some(message =>
    message.role === 'tool' && message.content === 'verified tool evidence'));
  assert.equal(messages.some(message => message.__checkpointSummary), false);
});

test('runner records failed retryable tool-result state for checkpoint semantics', async () => {
  const modelRequests: Message[][] = [];
  const aiService = {
    chat: async (messages: Message[]) => {
      modelRequests.push(messages.map(message => ({ ...message })));
      return modelRequests.length === 1 ? {
        content: null,
        toolCalls: [{
          id: 'retry-call',
          type: 'function',
          function: { name: 'inspect', arguments: '{}' },
        }],
        usage,
      } : { content: 'retry may be attempted', toolCalls: [], usage };
    },
  } as any;
  const executor: ToolExecutor = {
    getToolDefinitions: () => [{
      name: 'inspect',
      description: 'inspect',
      parameters: { type: 'object', properties: {} },
    }],
    executeTool: async (call: ToolCall): Promise<ToolResult> => ({
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: 'temporary timeout',
      ok: false,
      errorCode: 'TEMPORARY_TIMEOUT',
      retryable: true,
    }),
  };
  const runner = new ConversationRunner(aiService, executor, {
    stream: false,
    episodeId: 'episode-retry-state',
  });

  await runner.run([{
    role: 'user',
    content: 'inspect status',
    __episodeId: 'episode-retry-state',
  }]);

  const failedResult = modelRequests[1].find(message => message.role === 'tool');
  assert.equal(failedResult?.__episodeId, 'episode-retry-state');
  assert.deepEqual(failedResult?.__toolResultState, {
    status: 'failure',
    retryable: true,
  });
});

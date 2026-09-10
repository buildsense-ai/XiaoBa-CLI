import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import { CHECKPOINT_SUMMARY_PREFIX, CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';
import { ConversationRunner } from '../src/core/conversation-runner';
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '../src/types/tool';

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const legacyArtifactSentinel = 'LEGACY_ARTIFACT_PAGE_SENTINEL_7f31c2';
const legacyArtifactObservation: Message = {
  role: 'user',
  content: `[transient_artifact_observation]\n${legacyArtifactSentinel}`,
  __injected: true,
  __runtimeObservation: true,
  runtimeObservationSource: 'catsco_artifact',
};

const unchanged = (messages: Message[]) => ({
  messages, compacted: false, usedTokens: 10, toolTokens: 10,
  maxTokens: 100, usagePercent: 20,
});

test('runner reports provider prompt usage to checkpoint accounting', async () => {
  const observations: Array<{
    promptTokens: number;
    messageCount: number;
    providerMessageCount: number;
    toolTokens: number;
  }> = [];
  const coordinator = {
    compactIfNeeded: async (messages: Message[]) => unchanged(messages),
    observeProviderPromptUsage: (
      promptTokens: number,
      messages: Message[],
      providerMessages: Message[],
      toolTokens: number,
    ) => {
      observations.push({
        promptTokens,
        messageCount: messages.length,
        providerMessageCount: providerMessages.length,
        toolTokens,
      });
    },
  } as any;
  const tool: ToolDefinition = {
    name: 'inspect',
    description: 'inspect',
    parameters: { type: 'object', properties: {} },
  };
  const runner = new ConversationRunner({
    chat: async () => ({ content: 'done', toolCalls: [], usage: {
      promptTokens: 777,
      completionTokens: 5,
      totalTokens: 782,
    } }),
  } as any, {
    getToolDefinitions: () => [tool],
    executeTool: async () => { throw new Error('Unexpected tool'); },
  }, {
    stream: false,
    checkpointCompactionCoordinator: coordinator,
  });

  await runner.run([{ role: 'user', content: 'inspect once' }]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0].promptTokens, 777);
  assert.equal(observations[0].messageCount, 1);
  assert.ok(observations[0].providerMessageCount >= 1);
  assert.ok(observations[0].toolTokens > 0);
});

test('runner gives summary guards the actual tools and transient prompt overhead', async () => {
  const boundaryCalls: Array<{ toolNames: string[]; promptOverheadTokens: number }> = [];
  const requestGuards: Array<{ toolNames: string[]; promptOverheadTokens: number }> = [];
  const tool: ToolDefinition = {
    name: 'inspect',
    description: 'inspect',
    parameters: { type: 'object', properties: {} },
  };
  const runner = new ConversationRunner({
    chat: async () => ({ content: 'done', toolCalls: [], usage }),
  } as any, {
    getToolDefinitions: () => [tool],
    executeTool: async () => { throw new Error('Unexpected tool'); },
  }, {
    stream: false,
    onCheckpointCandidateBoundary: async (messages, tools = [], promptOverheadTokens = 0) => {
      boundaryCalls.push({ toolNames: tools.map(item => item.name), promptOverheadTokens });
      return messages;
    },
    beforeModelRequest: async (_messages, tools, promptOverheadTokens = 0) => {
      requestGuards.push({ toolNames: tools.map(item => item.name), promptOverheadTokens });
    },
  });

  await runner.run([
    { role: 'user', content: 'inspect once' },
    { role: 'system', content: `[transient_runtime]\n${'x'.repeat(200)}`, __injected: true },
  ]);

  assert.ok(boundaryCalls.some(call => call.promptOverheadTokens > 0));
  assert.ok(boundaryCalls.every(call => call.toolNames.join(',') === 'inspect'));
  assert.equal(requestGuards.length, 1);
  assert.deepEqual(requestGuards[0].toolNames, ['inspect']);
  assert.ok(requestGuards[0].promptOverheadTokens > 0);
});

test('runner checkpoints durable history before a large one-shot transient prompt is sent', async () => {
  const events: string[] = [];
  const coordinator = new CheckpointCompactionCoordinator({
    chatStream: async () => {
      events.push('summary');
      return { content: 'Earlier work is complete; continue the active request.', usage };
    },
  } as any, { maxContextTokens: 1_000 });
  const runner = new ConversationRunner({
    chat: async (messages: Message[]) => {
      events.push('agent');
      assert.ok(messages.some(message => message.__checkpointSummary));
      assert.ok(messages.some(message => message.__injected));
      return { content: 'continued', toolCalls: [], usage };
    },
  } as any, {
    getToolDefinitions: () => [],
    executeTool: async () => { throw new Error('Unexpected tool'); },
  }, {
    stream: false,
    episodeId: 'active',
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => { events.push('persist'); },
  });

  await runner.run([
    { role: 'user', content: 'x'.repeat(400), __episodeId: 'old' },
    { role: 'assistant', content: 'x'.repeat(400), __episodeId: 'old' },
    { role: 'user', content: 'continue', __episodeId: 'active', __episodeInputKind: 'root' },
    {
      role: 'system',
      content: `[transient_runtime]\n${'x'.repeat(2_700)}`,
      __injected: true,
    },
  ]);

  assert.deepEqual(events, ['summary', 'persist', 'agent']);
});

test('cancellation during a tool rate-limit backoff prevents another execution', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  let executions = 0;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const runner = new ConversationRunner({
    chat: async () => ({ content: '', toolCalls: [{ id: 'limited', type: 'function', function: { name: 'inspect', arguments: '{}' } }] }),
  } as any, {
    getToolDefinitions: () => [{ name: 'inspect', description: 'inspect', parameters: { type: 'object', properties: {} } }],
    executeTool: async call => {
      executions++;
      cancelTimer = setTimeout(() => controller.abort(), 50);
      return { role: 'tool', tool_call_id: call.id, name: 'inspect', content: 'rate limited', ok: false, errorCode: 'HTTP_429' };
    },
  }, { stream: false, toolExecutionContext: { abortSignal: controller.signal } });
  try {
    const result = await runner.run([{ role: 'user', content: 'inspect once' }]);
    assert.equal(executions, 1);
    assert.ok(result.messages.some(message => message.role === 'tool' && message.tool_call_id === 'limited'));
  } finally { clearTimeout(cancelTimer); }
});

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
      if (!messages.some(message => message.role === 'tool')) return unchanged(messages);
      checkpointRequest = request;
      events.push('checkpoint');
      assert.equal(JSON.stringify(messages).includes(legacyArtifactSentinel), false);
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
      assert.equal(JSON.stringify(messages).includes(legacyArtifactSentinel), false);
      assert.ok(messages.some(message => message.__checkpointSummary));
    },
  });

  const result = await runner.run([
    legacyArtifactObservation,
    {
      role: 'user',
      content: 'inspect and continue',
      __episodeId: 'episode-main',
    },
  ]);

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
  assert.equal(JSON.stringify(modelRequests).includes(legacyArtifactSentinel), false);
});

test('runner stops before another model request when checkpoint persistence fails', async () => {
  const modelRequests: Message[][] = [];
  const thinking: string[] = [];
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
    compactIfNeeded: async (messages: Message[]) => messages.some(message => message.role === 'tool') ? ({
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
    }) : unchanged(messages),
  } as any;

  const runner = new ConversationRunner(aiService, executor, {
    stream: false,
    episodeId: 'episode-main',
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => {
      throw new Error('disk full');
    },
  });

  await assert.rejects(
    runner.run([{
      role: 'user',
      content: 'inspect and continue',
      __episodeId: 'episode-main',
    }], {
      onThinking: message => {
        thinking.push(message);
      },
    }),
    error => error instanceof Error && error.name === 'CheckpointPersistenceError',
  );

  assert.equal(modelRequests.length, 1);
  assert.deepEqual(thinking, [
    'Checkpoint could not be saved. Stopping this turn with the original context preserved.',
  ]);
});

test('runner does not create a fresh checkpoint retry budget after a terminal 502', async () => {
  let modelRequests = 0;
  let toolExecutions = 0;
  let checkpointRequests = 0;
  const aiService = {
    chat: async () => {
      modelRequests++;
      return {
        content: null,
        toolCalls: [{
          id: `call-${modelRequests}`,
          type: 'function',
          function: { name: 'inspect', arguments: '{}' },
        }],
        usage,
      };
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
      toolExecutions++;
      return {
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: 'verified tool evidence',
        ok: true,
      };
    },
  };
  const terminalError = Object.assign(
    new Error('API错误 (502): Responses API stream ended without a terminal response'),
    { status: 502 },
  );
  const coordinator = {
    compactIfNeeded: async (messages: Message[]) => {
      if (!messages.some(message => message.role === 'tool')) return unchanged(messages);
      checkpointRequests++;
      throw terminalError;
    },
  } as any;
  const runner = new ConversationRunner(aiService, executor, {
    stream: false,
    episodeId: 'episode-502',
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => undefined,
  });

  await assert.rejects(
    runner.run([{
      role: 'user',
      content: 'inspect repeatedly',
      __episodeId: 'episode-502',
    }]),
    error => error === terminalError,
  );

  assert.equal(modelRequests, 1);
  assert.equal(toolExecutions, 1);
  assert.equal(checkpointRequests, 1);
});

test('runner checkpoints a newly appended oversized root before the first agent request', async () => {
  const events: string[] = [];
  const incoming = `Inspect this complete evidence and produce audit.md.\n${'log evidence '.repeat(4000)}\nEND_OF_INCOMING_EVIDENCE`;
  const coordinator = new CheckpointCompactionCoordinator({
    chatStream: async (messages: Message[]) => {
      events.push('summary');
      assert.ok(JSON.stringify(messages).includes('END_OF_INCOMING_EVIDENCE'));
      return { content: 'Task: inspect the incoming evidence and produce audit.md. No work has been completed.', usage };
    },
  } as any, { maxContextTokens: 4000 });
  const runner = new ConversationRunner({
    chat: async (messages: Message[]) => {
      events.push('agent');
      assert.ok(messages.some(message => message.__checkpointSummary));
      assert.ok(JSON.stringify(messages).includes('audit.md'));
      return { content: 'Ready to continue from the checkpoint.', toolCalls: [], usage };
    },
  } as any, { getToolDefinitions: () => [], executeTool: async () => { throw new Error('Unexpected tool'); } }, {
    stream: false,
    episodeId: 'incoming-episode',
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => { events.push('persist'); },
  });
  await runner.run([{ role: 'user', content: incoming, __episodeId: 'incoming-episode', __episodeInputKind: 'root' }]);
  assert.deepEqual(events, ['summary', 'persist', 'agent']);
});

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
const legacyArtifactSentinel = 'LEGACY_ARTIFACT_PAGE_SENTINEL_7f31c2';
const legacyArtifactObservation: Message = {
  role: 'user',
  content: `[transient_artifact_observation]\n${legacyArtifactSentinel}`,
  __injected: true,
  __runtimeObservation: true,
  runtimeObservationSource: 'catsco_artifact',
};

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

test('runner coordinates a candidate after the complete tool batch before the next model request', async () => {
  const events: string[] = [];
  const modelRequests: Message[][] = [];
  const aiService = {
    chat: async (messages: Message[]) => {
      modelRequests.push(messages.map(message => ({ ...message })));
      if (modelRequests.length === 1) {
        events.push('model:first');
        return {
          content: null,
          toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
          usage,
        };
      }
      events.push('model:second');
      return { content: 'continued', toolCalls: [], usage };
    },
  } as any;
  const executor: ToolExecutor = {
    getToolDefinitions: () => [{ name: 'inspect', description: 'inspect', parameters: { type: 'object', properties: {} } }],
    executeTool: async (call: ToolCall): Promise<ToolResult> => {
      events.push('tool:complete');
      return { role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'evidence', ok: true };
    },
  };
  const runner = new ConversationRunner(aiService, executor, {
    stream: false,
    onCheckpointCandidateBoundary: async messages => {
      events.push('candidate-boundary');
      if (!messages.some(message => message.role === 'tool' && message.content === 'evidence')) {
        return messages;
      }
      return [{ role: 'user', content: 'candidate summary' }];
    },
  });

  await runner.run([{ role: 'user', content: 'inspect' }]);

  assert.deepEqual(events, [
    'candidate-boundary',
    'model:first',
    'tool:complete',
    'candidate-boundary',
    'candidate-boundary',
    'model:second',
  ]);
  assert.ok(modelRequests[1].some(message => message.content === 'candidate summary'));
  assert.equal(modelRequests[1].some(message => message.role === 'tool'), false);
});

test('a candidate ready during tool execution commits only after the complete tool batch', async () => {
  let releaseTool!: () => void;
  let toolStarted!: () => void;
  const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
  const toolStartedGate = new Promise<void>(resolve => { toolStarted = resolve; });
  let candidateReady = false;
  const modelRequests: Message[][] = [];
  const transcript: Message[] = [{ role: 'user', content: 'inspect' }];
  const runner = new ConversationRunner({
    chat: async (messages: Message[]) => {
      modelRequests.push(messages.map(message => structuredClone(message)));
      if (modelRequests.length === 1) {
        return {
          content: null,
          toolCalls: [{ id: 'call-ready', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
          usage,
        };
      }
      return { content: 'continued', toolCalls: [], usage };
    },
  } as any, {
    getToolDefinitions: () => [{ name: 'inspect', description: 'inspect', parameters: { type: 'object', properties: {} } }],
    executeTool: async (call: ToolCall): Promise<ToolResult> => {
      toolStarted();
      await toolGate;
      return { role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'complete evidence', ok: true };
    },
  }, {
    stream: false,
    onCheckpointCandidateBoundary: messages => {
      if (!candidateReady) return messages;
      const toolCallIndex = messages.findIndex(message => message.tool_calls?.some(call => call.id === 'call-ready'));
      if (toolCallIndex < 0 || !messages.some(message => message.tool_call_id === 'call-ready')) return messages;
      return [
        { role: 'user', content: 'candidate summary' },
        ...messages.slice(toolCallIndex),
      ];
    },
  });

  const running = runner.run(transcript);
  await toolStartedGate;
  candidateReady = true;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(transcript.some(message => message.content === 'candidate summary'), false);
  assert.equal(transcript.some(message => message.role === 'tool'), false);
  assert.equal(modelRequests.length, 1);

  releaseTool();
  await running;

  assert.equal(modelRequests.length, 2);
  assert.ok(modelRequests[1].some(message => message.content === 'candidate summary'));
  assert.ok(modelRequests[1].some(message => message.tool_calls?.some(call => call.id === 'call-ready')));
  assert.ok(modelRequests[1].some(message => message.tool_call_id === 'call-ready'));
});

test('runner invokes the candidate boundary before every model request', async () => {
  const boundaryCalls: number[] = [];
  let modelCalls = 0;
  const runner = new ConversationRunner({
    chat: async () => {
      modelCalls++;
      return { content: 'done', toolCalls: [], usage };
    },
  } as any, { getToolDefinitions: () => [], executeTool: async () => ({}) } as any, {
    stream: false,
    onCheckpointCandidateBoundary: async messages => {
      boundaryCalls.push(modelCalls);
      return messages;
    },
  });

  await runner.run([{ role: 'user', content: 'hello' }]);

  assert.deepEqual(boundaryCalls, [0]);
  assert.equal(modelCalls, 1);
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

  await assert.rejects(() => runner.run([{
    role: 'user',
    content: 'inspect and continue',
    __episodeId: 'episode-main',
  }]), /disk full/);

  assert.equal(modelRequests.length, 1);
  assert.ok(modelRequests[0].some(message =>
    message.role === 'user' && message.content === 'inspect and continue'));

});

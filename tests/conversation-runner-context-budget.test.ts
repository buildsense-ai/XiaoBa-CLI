import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_CHECKPOINT_FAILED_MESSAGE,
  ConversationRunner,
} from '../src/core/conversation-runner';
import { estimateMessageTokens, estimateMessagesTokens, estimateToolsTokens } from '../src/core/token-estimator';
import type { ContentBlock, Message } from '../src/types';
import type { ToolDefinition, ToolExecutor } from '../src/types/tool';

const smallTool: ToolDefinition = {
  name: 'inspect',
  description: 'Inspect without changing anything.',
  parameters: { type: 'object', properties: {} },
};

function executorWith(tools: ToolDefinition[] = []): ToolExecutor {
  return {
    getToolDefinitions: () => tools,
    executeTool: async () => ({ content: 'unused' }),
  };
}

function checkpointMessages(episodeId = 'episode-budget'): Message[] {
  return [{
    role: 'user',
    content: 'Continuation checkpoint: preserve the objective and continue.',
    __checkpointSummary: true,
    __episodeId: episodeId,
  }];
}

test('full final request triggers a persisted checkpoint before the provider call', async () => {
  const original: Message[] = [{
    role: 'user',
    content: `ROOT_EVIDENCE:${'important evidence '.repeat(1_000)}`,
    __episodeId: 'episode-budget',
    __episodeInputKind: 'root',
  }];
  const checkpointRequests: any[] = [];
  const providerRequests: Array<{ messages: Message[]; tools: ToolDefinition[]; options: any }> = [];
  const events: string[] = [];
  const coordinator = {
    compactIfNeeded: async (_messages: Message[], request: any) => {
      checkpointRequests.push(request);
      events.push('checkpoint');
      return {
        messages: checkpointMessages(),
        compacted: true,
        attempted: true,
        action: 'checkpoint',
        usedTokens: 2_000,
        toolTokens: 20,
        maxTokens: 1_000,
        usagePercent: 202,
      };
    },
  } as any;
  const aiService = {
    async chat(messages: Message[], tools: ToolDefinition[], options: any) {
      events.push('provider');
      providerRequests.push({ messages, tools, options });
      return { content: 'done', toolCalls: [] };
    },
  };
  const runner = new ConversationRunner(aiService as any, executorWith([smallTool]), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    episodeId: 'episode-budget',
    runtimeTransientProvider: () => [{
      role: 'system',
      content: `[transient_runtime_context]\n${'runtime fact '.repeat(100)}\n[/transient_runtime_context]`,
      __injected: true,
    }],
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => { events.push('persist'); },
  });

  const result = await runner.run(original);

  assert.equal(result.response, 'done');
  assert.deepEqual(events, ['checkpoint', 'persist', 'provider']);
  assert.equal(checkpointRequests[0].phase, 'mid_turn');
  assert.equal(checkpointRequests[0].force, false);
  assert.ok(checkpointRequests[0].requestOverheadTokens > 0);
  assert.deepEqual(providerRequests[0].tools, [smallTool]);
  assert.equal(providerRequests[0].options.requestKind, 'main_inference');
  assert.ok(providerRequests[0].messages.some(message => message.__checkpointSummary));
  assert.equal(providerRequests[0].messages.some(message =>
    String(message.content).includes('ROOT_EVIDENCE:')), false);
  assert.equal(JSON.stringify(providerRequests[0].messages).includes('已截断'), false);
  assert.ok(original.some(message => message.__checkpointSummary));
});

test('pending correction arriving during checkpoint is included before resumed inference', async () => {
  let releaseCheckpoint!: () => void;
  let checkpointStarted!: () => void;
  const checkpointGate = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  const checkpointStartedPromise = new Promise<void>(resolve => { checkpointStarted = resolve; });
  let checkpointCalls = 0;
  let pendingAvailable = false;
  let pendingDelivered = false;
  const providerRequests: Message[][] = [];
  const messages: Message[] = [{
    role: 'user',
    content: 'ROOT_STATE '.repeat(1_000),
    __episodeId: 'episode-pending-race',
    __episodeInputKind: 'root',
  }];
  const coordinator = {
    compactIfNeeded: async () => {
      checkpointCalls++;
      if (checkpointCalls > 1) {
        return {
          messages,
          compacted: false,
          attempted: false,
          usedTokens: 100,
          toolTokens: 0,
          maxTokens: 1_000,
          usagePercent: 10,
        };
      }
      checkpointStarted();
      await checkpointGate;
      return {
        messages: checkpointMessages('episode-pending-race'),
        compacted: true,
        attempted: true,
        action: 'checkpoint',
        usedTokens: 2_000,
        toolTokens: 0,
        maxTokens: 1_000,
        usagePercent: 200,
      };
    },
  } as any;
  const runner = new ConversationRunner({
    async chat(requestMessages: Message[]) {
      providerRequests.push(structuredClone(requestMessages));
      return { content: 'done', toolCalls: [] };
    },
  } as any, executorWith(), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    episodeId: 'episode-pending-race',
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => {},
    pendingUserInputProvider: async () => {
      if (!pendingAvailable || pendingDelivered) return null;
      pendingDelivered = true;
      return 'CORRECTION_DURING_CHECKPOINT';
    },
  });

  const running = runner.run(messages);
  await checkpointStartedPromise;
  pendingAvailable = true;
  releaseCheckpoint();
  const result = await running;

  assert.equal(result.response, 'done');
  assert.equal(providerRequests.length, 1);
  assert.equal(checkpointCalls, 2);
  assert.equal(providerRequests[0].some(message => (
    String(message.content).includes('CORRECTION_DURING_CHECKPOINT')
  )), true);
  assert.equal(result.newMessages.some(message => (
    String(message.content).includes('CORRECTION_DURING_CHECKPOINT')
  )), true);
});

test('an oversized request without a compression path fails without calling the provider or mutating history', async () => {
  const messages: Message[] = [{ role: 'user', content: 'KEEP_EXACT '.repeat(2_000) }];
  const snapshot = structuredClone(messages);
  let providerCalls = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      return { content: 'must not run' };
    },
  } as any, executorWith(), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
  });

  await assert.rejects(
    runner.run(messages),
    error => String((error as Error).message).includes(CONTEXT_CHECKPOINT_FAILED_MESSAGE),
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(messages, snapshot);
});

test('tool schemas that cannot fit fail explicitly instead of silently disabling capabilities', async () => {
  const hugeTool: ToolDefinition = {
    name: 'huge_tool_schema',
    description: '工具说明'.repeat(10_000),
    parameters: {
      type: 'object',
      properties: {
        payload: { type: 'string', description: '参数说明'.repeat(10_000) },
      },
    },
  };
  let providerCalls = 0;
  let checkpointCalls = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      return { content: 'must not run' };
    },
  } as any, executorWith([hugeTool]), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async () => {
        checkpointCalls++;
        throw new Error('must not try to compress tool schemas');
      },
    } as any,
  });

  await assert.rejects(runner.run([{ role: 'user', content: 'continue' }]), /all 1 tool definitions/);
  assert.equal(providerCalls, 0);
  assert.equal(checkpointCalls, 0);
  assert.ok(estimateToolsTokens([hugeTool]) >= 1_000);
});

test('provider-confirmed overflow forces a durable checkpoint and retries once in the same episode', async () => {
  const controller = new AbortController();
  const providerRequests: Message[][] = [];
  const providerTools: ToolDefinition[][] = [];
  const observedSignals: Array<AbortSignal | undefined> = [];
  const checkpointRequests: any[] = [];
  const events: string[] = [];
  const aiService = {
    async chat(messages: Message[], tools: ToolDefinition[], options: any) {
      providerRequests.push(structuredClone(messages));
      providerTools.push(tools);
      observedSignals.push(options.signal);
      events.push(`provider:${providerRequests.length}`);
      if (providerRequests.length === 1) {
        throw Object.assign(new Error('maximum context length exceeded'), {
          code: 'context_length_exceeded',
        });
      }
      return { content: 'resumed', toolCalls: [] };
    },
  };
  const coordinator = {
    compactIfNeeded: async (_messages: Message[], request: any) => {
      checkpointRequests.push(request);
      if (!request.force) {
        return {
          messages: _messages,
          compacted: false,
          attempted: false,
          usedTokens: 100,
          toolTokens: 10,
          maxTokens: 50_000,
          usagePercent: 1,
        };
      }
      events.push('checkpoint');
      return {
        messages: checkpointMessages('episode-provider-overflow'),
        compacted: true,
        attempted: true,
        action: 'checkpoint',
        usedTokens: 100,
        toolTokens: 10,
        maxTokens: 50_000,
        usagePercent: 1,
      };
    },
  } as any;
  const runner = new ConversationRunner(aiService as any, executorWith([smallTool]), {
    maxContextTokens: 50_000,
    stream: false,
    enableCompression: false,
    episodeId: 'episode-provider-overflow',
    toolExecutionContext: { abortSignal: controller.signal },
    checkpointCompactionCoordinator: coordinator,
    onCompactionCheckpoint: async () => { events.push('persist'); },
  });

  const result = await runner.run([{
    role: 'user',
    content: 'ORIGINAL_OBJECTIVE',
    __episodeId: 'episode-provider-overflow',
    __episodeInputKind: 'root',
  }]);

  assert.equal(result.response, 'resumed');
  assert.deepEqual(events, ['provider:1', 'checkpoint', 'persist', 'provider:2']);
  assert.equal(checkpointRequests.length, 2);
  assert.equal(checkpointRequests[0].force, false);
  assert.equal(checkpointRequests[1].force, true);
  assert.ok(providerRequests[0].some(message => message.content === 'ORIGINAL_OBJECTIVE'));
  assert.ok(providerRequests[1].some(message => message.__checkpointSummary));
  assert.deepEqual(providerTools, [[smallTool], [smallTool]]);
  assert.deepEqual(observedSignals, [controller.signal, controller.signal]);
});

test('a second provider overflow fails explicitly after the single checkpoint retry', async () => {
  let providerCalls = 0;
  let forcedCheckpoints = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      throw new Error('maximum context length exceeded');
    },
  } as any, executorWith(), {
    maxContextTokens: 50_000,
    stream: false,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async (messages: Message[], request: any) => {
        if (!request.force) {
          return { messages, compacted: false, attempted: false };
        }
        forcedCheckpoints++;
        return {
          messages: checkpointMessages(),
          compacted: true,
          attempted: true,
        };
      },
    } as any,
    onCompactionCheckpoint: async () => {},
  });

  await assert.rejects(runner.run([{ role: 'user', content: 'continue' }]), /maximum context length exceeded/);
  assert.equal(providerCalls, 2);
  assert.equal(forcedCheckpoints, 1);
});

test('a premature transport close is not misclassified as context overflow', async () => {
  let providerCalls = 0;
  let forcedCheckpoints = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      throw new Error('premature close');
    },
  } as any, executorWith(), {
    maxContextTokens: 50_000,
    stream: false,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async (messages: Message[], request: any) => {
        if (request.force) forcedCheckpoints++;
        return { messages, compacted: false, attempted: false };
      },
    } as any,
    onCompactionCheckpoint: async () => {},
  });

  await assert.rejects(runner.run([{ role: 'user', content: 'continue' }]), /premature close/);
  assert.equal(providerCalls, 1);
  assert.equal(forcedCheckpoints, 0);
});

test('visible streamed text prevents an outer checkpoint replay after context overflow', async () => {
  let providerCalls = 0;
  let forcedCheckpoints = 0;
  const visible: string[] = [];
  const runner = new ConversationRunner({
    async chatStream(
      _messages: Message[],
      _tools: ToolDefinition[],
      callbacks: { onText?: (text: string) => void },
    ) {
      providerCalls++;
      callbacks.onText?.('PARTIAL_VISIBLE');
      throw new Error('maximum context length exceeded');
    },
  } as any, executorWith(), {
    maxContextTokens: 50_000,
    stream: true,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async (messages: Message[], request: any) => {
        if (request.force) forcedCheckpoints++;
        return { messages, compacted: false, attempted: false };
      },
    } as any,
    onCompactionCheckpoint: async () => {},
  });

  await assert.rejects(runner.run([{ role: 'user', content: 'continue' }], {
    onText: text => visible.push(text),
  }), /maximum context length exceeded/);
  assert.equal(providerCalls, 1);
  assert.equal(forcedCheckpoints, 0);
  assert.deepEqual(visible, ['PARTIAL_VISIBLE']);
});

test('checkpoint persistence failure preserves the exact transcript and blocks provider execution', async () => {
  const messages: Message[] = [{
    role: 'user',
    content: 'EXACT_ROOT '.repeat(1_000),
    __episodeId: 'episode-persist-failure',
    __episodeInputKind: 'root',
  }];
  const snapshot = structuredClone(messages);
  let providerCalls = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      return { content: 'must not run' };
    },
  } as any, executorWith(), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async () => ({
        messages: checkpointMessages('episode-persist-failure'),
        compacted: true,
        attempted: true,
      }),
    } as any,
    onCompactionCheckpoint: async () => { throw new Error('disk full'); },
  });

  await assert.rejects(runner.run(messages), /checkpoint persistence failed/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(messages, snapshot);
});

test('checkpoint generation failure preserves the exact transcript and blocks provider execution', async () => {
  const messages: Message[] = [{ role: 'user', content: 'EXACT_ROOT '.repeat(1_000) }];
  const snapshot = structuredClone(messages);
  let providerCalls = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      return { content: 'must not run' };
    },
  } as any, executorWith(), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async () => ({
        messages,
        compacted: false,
        attempted: true,
        error: new Error('summary model unavailable'),
      }),
    } as any,
    onCompactionCheckpoint: async () => {},
  });

  await assert.rejects(runner.run(messages), /checkpoint generation failed/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(messages, snapshot);
});

test('an incompressible transient suffix is validated before checkpoint persistence', async () => {
  const messages: Message[] = [{
    role: 'user',
    content: 'ORIGINAL_ROOT '.repeat(1_000),
    __episodeId: 'episode-large-transient',
    __episodeInputKind: 'root',
  }];
  const snapshot = structuredClone(messages);
  let providerCalls = 0;
  let persistenceCalls = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      return { content: 'must not run' };
    },
  } as any, executorWith(), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    runtimeTransientProvider: () => [{
      role: 'system',
      content: `[transient_runtime_context]\n${'INCOMPRESSIBLE_RUNTIME '.repeat(500)}\n[/transient_runtime_context]`,
      __injected: true,
    }],
    checkpointCompactionCoordinator: {
      compactIfNeeded: async () => ({
        messages: checkpointMessages('episode-large-transient'),
        compacted: true,
        attempted: true,
      }),
    } as any,
    onCompactionCheckpoint: async () => { persistenceCalls++; },
  });

  await assert.rejects(runner.run(messages), /checkpoint candidate remains over budget/);
  assert.equal(persistenceCalls, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(messages, snapshot);
});

test('an oversized forced-checkpoint summary is rejected before persistence or provider retry', async () => {
  const messages: Message[] = [{
    role: 'user',
    content: 'ORIGINAL_PROVIDER_ROOT',
    __episodeId: 'episode-verbose-summary',
    __episodeInputKind: 'root',
  }];
  const snapshot = structuredClone(messages);
  let providerCalls = 0;
  let persistenceCalls = 0;
  const runner = new ConversationRunner({
    async chat() {
      providerCalls++;
      throw new Error('maximum context length exceeded');
    },
  } as any, executorWith(), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async (current: Message[], request: any) => {
        if (!request.force) {
          return { messages: current, compacted: false, attempted: false };
        }
        return {
          messages: [{
            role: 'user',
            content: 'VERBOSE_SUMMARY '.repeat(2_000),
            __checkpointSummary: true,
            __episodeId: 'episode-verbose-summary',
          }],
          compacted: true,
          attempted: true,
        };
      },
    } as any,
    onCompactionCheckpoint: async () => { persistenceCalls++; },
  });

  await assert.rejects(runner.run(messages), /checkpoint candidate remains over budget/);
  assert.equal(providerCalls, 1);
  assert.equal(persistenceCalls, 0);
  assert.deepEqual(messages, snapshot);
});

test('provider input repair keeps tool calls and results paired without budget truncation', () => {
  const runner = new ConversationRunner({} as any, executorWith(), {
    maxContextTokens: 1_200,
    stream: false,
  });
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'kept_call', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'dropped_call', type: 'function', function: { name: 'execute_shell', arguments: '{}' } },
      ],
      providerContent: [
        { type: 'thinking', thinking: 'hidden chain', signature: 'sig_1' },
        { type: 'tool_use', id: 'kept_call', name: 'read_file', input: {} },
        { type: 'tool_use', id: 'dropped_call', name: 'execute_shell', input: {} },
      ],
    },
    { role: 'tool', content: 'kept result', tool_call_id: 'kept_call', name: 'read_file' },
  ];

  const repaired = (runner as any).repairToolExchangeMessages(messages) as Message[];
  const assistant = repaired.find(message => message.role === 'assistant');
  assert.deepEqual(assistant?.tool_calls?.map(toolCall => toolCall.id), ['kept_call']);
  assert.deepEqual(assistant?.providerContent?.map(block => block.type === 'tool_use' ? block.id : block.type), [
    'thinking',
    'kept_call',
  ]);
});

test('image content blocks contribute to prompt token estimates', () => {
  const image: ContentBlock = {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'a'.repeat(8_000),
    },
  };

  assert.ok(estimateMessageTokens({ role: 'user', content: [image] }) >= 1_000);
});

test('provider replay thinking contributes to prompt token estimates', () => {
  const hiddenThinking = 'a'.repeat(200_000);
  const tokens = estimateMessageTokens({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'execute_shell', arguments: '{}' },
    }],
    providerContent: [
      { type: 'thinking', thinking: hiddenThinking, signature: 'sig_1' },
      { type: 'tool_use', id: 'call_1', name: 'execute_shell', input: {} },
    ],
  });

  assert.ok(tokens > 40_000, `hidden provider thinking should be budgeted, got ${tokens}`);
});

test('checkpointed provider request fits the configured small-window budget', async () => {
  let captured: Message[] = [];
  const runner = new ConversationRunner({
    async chat(messages: Message[]) {
      captured = messages;
      return { content: 'done', toolCalls: [] };
    },
  } as any, executorWith([smallTool]), {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
    checkpointCompactionCoordinator: {
      compactIfNeeded: async () => ({
        messages: checkpointMessages(),
        compacted: true,
        attempted: true,
      }),
    } as any,
    onCompactionCheckpoint: async () => {},
  });

  await runner.run([{ role: 'user', content: 'large '.repeat(1_000) }]);
  assert.ok(estimateMessagesTokens(captured) + estimateToolsTokens([smallTool]) <= 1_000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { AgentSession, AgentServices } from '../src/core/agent-session';
import { ToolExecutor, ToolResult, ToolDefinition, ToolCall, ToolExecutionContext } from '../src/types/tool';
import { ChatResponse, Message } from '../src/types';
import { ToolManager } from '../src/tools/tool-manager';
import { SkillManager } from '../src/skills/skill-manager';

function cloneMessages(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages));
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function makeToolResponse(toolCall: ToolCall): ChatResponse {
  return {
    content: null,
    toolCalls: [toolCall],
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    },
  };
}

function makeFinalResponse(content = ''): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: {
      promptTokens: 120,
      completionTokens: 10,
      totalTokens: 130,
    },
  };
}

class MockToolExecutor implements ToolExecutor {
  private executionCount = new Map<string, number>();

  constructor(
    private definitions: ToolDefinition[],
    private outputByToolName: Record<string, string>,
    private controlByToolName: Record<string, 'pause_turn'> = {},
  ) {}

  getToolDefinitions(): ToolDefinition[] {
    return this.definitions;
  }

  getExecutionCount(toolName: string): number {
    return this.executionCount.get(toolName) ?? 0;
  }

  async executeTool(
    toolCall: ToolCall,
    _conversationHistory?: any[],
    _contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    this.executionCount.set(
      toolCall.function.name,
      (this.executionCount.get(toolCall.function.name) ?? 0) + 1,
    );

    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: this.outputByToolName[toolCall.function.name] ?? 'ok',
      ok: true,
      controlSignal: this.controlByToolName[toolCall.function.name],
    };
  }
}

function createMockAI(responses: ChatResponse[]) {
  const receivedMessages: Message[][] = [];
  const receivedTools: ToolDefinition[][] = [];
  let index = 0;

  return {
    aiService: {
      async chat(messages: Message[], tools?: ToolDefinition[]) {
        receivedMessages.push(cloneMessages(messages));
        receivedTools.push(JSON.parse(JSON.stringify(tools ?? [])));
        return responses[index++] ?? makeFinalResponse();
      },
      async chatStream(messages: Message[], tools?: ToolDefinition[]) {
        receivedMessages.push(cloneMessages(messages));
        receivedTools.push(JSON.parse(JSON.stringify(tools ?? [])));
        return responses[index++] ?? makeFinalResponse();
      },
    } as any,
    getReceivedMessages: () => receivedMessages,
    getReceivedTools: () => receivedTools,
  };
}

test('runner normalizes send_text tool into assistant transcript without tool_result pollution', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_1', 'send_text', { text: '老师好！' })),
    makeToolResponse(makeToolCall('call_2', 'send_text', { text: '我还能帮您处理图纸。' })),
    makeFinalResponse(),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [{
      name: 'send_text',
      description: 'send visible message',
      transcriptMode: 'outbound_message',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    }],
    { send_text: '消息已发送' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, { stream: true, enableCompression: false });
  const result = await runner.run([{ role: 'user', content: '你好' }]);

  const secondCallMessages = mock.getReceivedMessages()[1];
  assert.ok(secondCallMessages, 'runner should make a second AI call');
  assert.equal(
    secondCallMessages.some(message => message.role === 'tool'),
    false,
    'normalized outbound turn should not include tool_result in next round',
  );
  assert.equal(
    secondCallMessages.some(message => message.content === '消息已发送'),
    false,
    'next round should not contain outbound tool result text',
  );
  assert.ok(
    secondCallMessages.some(message => message.role === 'assistant' && message.content === '老师好！'),
    'next round should preserve the delivered assistant message',
  );

  const assistantMessages = result.messages.filter(message => message.role === 'assistant');
  assert.deepEqual(
    assistantMessages.map(message => message.content),
    ['老师好！', '我还能帮您处理图纸。'],
  );
});

test('runner does not persist assistant draft content when send_text already delivered the same turn', async () => {
  const responses = [
    {
      content: '对，高价值场景才是关键。',
      toolCalls: [makeToolCall('call_1', 'send_text', { text: '对，高价值场景才是关键。' })],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
    makeFinalResponse(),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [{
      name: 'send_text',
      description: 'send visible message',
      transcriptMode: 'outbound_message',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    }],
    { send_text: '消息已发送' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, { stream: true, enableCompression: false });
  const result = await runner.run([{ role: 'user', content: '说说高价值场景' }]);

  const secondCallMessages = mock.getReceivedMessages()[1];
  assert.deepEqual(
    secondCallMessages
      .filter(message => message.role === 'assistant')
      .map(message => message.content),
    ['对，高价值场景才是关键。'],
    'next round should only retain the delivered outbound message once',
  );

  assert.deepEqual(
    result.messages
      .filter(message => message.role !== 'system')
      .map(message => ({ role: message.role, content: message.content })),
    [
      { role: 'user', content: '说说高价值场景' },
      { role: 'assistant', content: '对，高价值场景才是关键。' },
    ],
    'durable session should keep only the delivered message, not the same-turn assistant draft',
  );
});

test('runner keeps non-outbound tools as assistant/tool transcript', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_read', 'read_file', { file_path: '/tmp/a.txt' })),
    makeFinalResponse('done'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [{
      name: 'read_file',
      description: 'read file',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
        },
        required: ['file_path'],
      },
    }],
    { read_file: 'file contents' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, { stream: true, enableCompression: false });
  await runner.run([{ role: 'user', content: '读一下文件' }]);

  const secondCallMessages = mock.getReceivedMessages()[1];
  assert.ok(
    secondCallMessages.some(message => message.role === 'tool' && message.content === 'file contents'),
    'non-outbound tools should still feed tool_result back into the next round',
  );
  assert.ok(
    secondCallMessages.some(message => message.role === 'assistant' && Boolean(message.tool_calls?.length)),
    'non-outbound tools should preserve assistant tool call transcript',
  );
});

test('runner can compact stale tool results while preserving recent observations', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_read_1', 'read_file', { file_path: '/tmp/1.txt' })),
    makeToolResponse(makeToolCall('call_read_2', 'read_file', { file_path: '/tmp/2.txt' })),
    makeToolResponse(makeToolCall('call_read_3', 'read_file', { file_path: '/tmp/3.txt' })),
    makeToolResponse(makeToolCall('call_read_4', 'read_file', { file_path: '/tmp/4.txt' })),
    makeToolResponse(makeToolCall('call_read_5', 'read_file', { file_path: '/tmp/5.txt' })),
    makeToolResponse(makeToolCall('call_read_6', 'read_file', { file_path: '/tmp/6.txt' })),
    makeFinalResponse('done'),
  ];
  const mock = createMockAI(responses);
  const longOutput = 'file contents '.repeat(120);
  const toolExecutor = new MockToolExecutor(
    [{
      name: 'read_file',
      description: 'read file',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
        },
        required: ['file_path'],
      },
    }],
    { read_file: longOutput },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
    compactStaleToolResults: true,
  });
  await runner.run([{ role: 'user', content: '连续读取多个文件' }]);

  const finalCallMessages = mock.getReceivedMessages()[6];
  const toolMessages = finalCallMessages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 6);
  assert.match(String(toolMessages[0].content), /历史工具输出已省略/);
  assert.match(String(toolMessages[1].content), /历史工具输出已省略/);
  assert.equal(toolMessages[2].content, longOutput);
  assert.equal(toolMessages[5].content, longOutput);
});

test('runner softly nudges long tool loops to consider subagents', async () => {
  const responses = [
    ...Array.from({ length: 8 }, (_, index) => (
      makeToolResponse(makeToolCall(`call_read_${index + 1}`, 'read_file', { file_path: `/tmp/${index + 1}.txt` }))
    )),
    makeFinalResponse('done'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
          required: ['task'],
        },
      },
    ],
    { read_file: 'file contents' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{ role: 'user', content: '检查一个比较大的项目' }]);

  const finalCallMessages = mock.getReceivedMessages()[8];
  const softHint = finalCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('还没有真正派出子 agent'),
  );

  assert.ok(softHint, 'long tool loops should receive a transient subagent orchestration hint');
  assert.match(String(softHint.content), /不是强制要求/);
  assert.equal(
    result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('还没有真正派出子 agent')
    )),
    false,
    'soft subagent hint should remain transient and not persist in the session transcript',
  );
});

test('runner gives an early transient delegation hint for broad review tasks', async () => {
  const responses = [makeFinalResponse('我会先检查关键链路。')];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
          required: ['task'],
        },
      },
    ],
    { read_file: 'file contents' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{
    role: 'user',
    content: [
      '我准备把当前这版 CatsCo 桌面端发给几个不太懂技术的朋友试用，你帮我做一次发布前可用性检查。',
      '重点看设置页、聊天里的 plan、WORKING、子任务状态、停止/中断、日志和上下文膨胀。',
      '先只读检查，不要改代码。最后给我必须马上修、可以带着测、后面优化的清单，每条带证据和建议。',
    ].join('\n\n'),
  }]);

  const firstCallMessages = mock.getReceivedMessages()[0];
  const initialHint = firstCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('第一轮先判断')
      && message.content.includes('spawn_subagent'),
  );

  assert.ok(initialHint, 'broad review tasks should receive an early transient delegation hint');
  assert.equal(
    result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('第一轮先判断')
    )),
    false,
    'early delegation hint should not persist in the durable session transcript',
  );
});

test('runner gives an early transient plan hint for broad multi-stage tasks', async () => {
  const responses = [makeFinalResponse('我会先梳理路线。')];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
    ],
    { read_file: 'file contents' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{
    role: 'user',
    content: [
      '帮我完整检查这个分支的 plan 和子 agent 链路，重点看触发、展示、停止、上下文和测试。',
      '先只读检查，不要改代码。',
      '要把桌面端、CatsCompany 通道、runtime 提示词、工具注册、事件回流和前端展示都串起来看。',
      '最后按必须修、可以带着测、后续优化给我清单。',
    ].join('\n\n'),
  }]);

  const firstCallMessages = mock.getReceivedMessages()[0];
  const initialHint = firstCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('update_plan')
      && message.content.includes('不是硬性 workflow'),
  );

  assert.ok(initialHint, 'broad tasks should receive an early transient plan hint');
  assert.equal(
    result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('update_plan')
      && message.content.includes('不是硬性 workflow')
    )),
    false,
    'early plan hint should not persist in the durable session transcript',
  );
});

test('runner softly nudges long tool loops to consider update_plan', async () => {
  const responses = [
    ...Array.from({ length: 4 }, (_, index) => (
      makeToolResponse(makeToolCall(`call_read_${index + 1}`, 'read_file', { file_path: `/tmp/${index + 1}.txt` }))
    )),
    makeFinalResponse('done'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
    ],
    { read_file: 'file contents' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{ role: 'user', content: '检查一个比较大的项目' }]);

  const finalCallMessages = mock.getReceivedMessages()[4];
  const softHint = finalCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('还没有维护运行时计划'),
  );

  assert.ok(softHint, 'long tool loops should receive a transient plan hint');
  assert.match(String(softHint.content), /不是强制要求/);
  assert.equal(
    result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('还没有维护运行时计划')
    )),
    false,
    'soft plan hint should remain transient and not persist in the session transcript',
  );
});

test('runner retries orchestration hint when broad tasks start with exploratory tools only', async () => {
  const responses: ChatResponse[] = [
    {
      content: '我先读几个关键点。',
      toolCalls: [
        makeToolCall('call_grep_1', 'grep', { pattern: 'working', path: '/tmp/a.ts' }),
        makeToolCall('call_read_1', 'read_file', { file_path: '/tmp/b.ts' }),
      ],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
    makeFinalResponse('done'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'grep',
        description: 'grep',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
        },
      },
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
      },
      {
        name: 'record_decision',
        description: 'record orchestration decision',
        transcriptMode: 'suppress',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    ],
    { grep: 'grep result', read_file: 'file contents' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{
    role: 'user',
    content: [
      '我准备把现在这个 CatsCo 桌面端给几个朋友试用，你帮我做一次发布前检查。',
      '重点看看聊天体验、设置页、登录绑定、停止/取消、历史消息、附件显示、日志排查这些地方有没有明显会让普通用户卡住的问题。',
      '先不要改代码，先把问题、证据位置、影响程度和建议处理顺序整理给我。',
    ].join('\n'),
  }]);

  const secondCallMessages = mock.getReceivedMessages()[1];
  const retryHint = secondCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('刚才请求的探索工具')
      && message.content.includes('没有执行')
      && message.content.includes('record_decision'),
  );

  assert.ok(retryHint, 'broad tasks that skip orchestration should receive a retry hint on the next turn');
  assert.deepEqual(
    mock.getReceivedTools()[1].map(tool => tool.name),
    ['update_plan', 'spawn_subagent', 'record_decision'],
    'the retry turn should only expose orchestration checkpoint tools',
  );
  assert.equal(toolExecutor.getExecutionCount('grep'), 0, 'exploratory tools should not execute before an orchestration decision');
  assert.equal(toolExecutor.getExecutionCount('read_file'), 0, 'exploratory tools should not execute before an orchestration decision');
  const firstCallMessages = mock.getReceivedMessages()[0];
  const checkpointHint = firstCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('编排 checkpoint')
      && message.content.includes('record_decision'),
  );
  assert.ok(checkpointHint, 'broad tasks should receive an initial decision checkpoint hint');
  assert.equal(
    result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('刚刚开始了多个探索类工具调用')
    )),
    false,
    'orchestration retry hint should remain transient',
  );
});

test('runner allows final answers during orchestration checkpoint without forcing another turn', async () => {
  const responses: ChatResponse[] = [
    makeFinalResponse('我刚才已经做过同样检查，直接复用上一条报告。'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
      },
      {
        name: 'record_decision',
        description: 'record orchestration decision',
        transcriptMode: 'suppress',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    ],
    {},
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{
    role: 'user',
    content: [
      '我准备把现在这个 CatsCo 桌面端给几个朋友试用，你帮我做一次发布前检查。',
      '重点看看聊天体验、设置页、登录绑定、停止/取消、历史消息、附件显示、日志排查这些地方有没有明显会让普通用户卡住的问题。',
      '先不要改代码，先把问题、证据位置、影响程度和建议处理顺序整理给我。',
    ].join('\n'),
  }]);

  assert.equal(mock.getReceivedMessages().length, 1, 'final answers should not be blocked by orchestration checkpoint');
  assert.equal(toolExecutor.getExecutionCount('record_decision'), 0);
  assert.equal(result.response, '我刚才已经做过同样检查，直接复用上一条报告。');
  assert.equal(
    result.messages.some(message => (
      message.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.includes('直接复用上一条报告')
    )),
    true,
    'the final answer should be persisted normally',
  );
});

test('runner retries explicit plan requests when the model answers with text instead of update_plan', async () => {
  const responses: ChatResponse[] = [
    makeFinalResponse('计划：1. 先看 skill；2. 再看触发；3. 最后总结。'),
    makeToolResponse(makeToolCall('call_plan_1', 'update_plan', {
      steps: [
        { text: '检查 skill 定义', status: 'in_progress' },
        { text: '梳理触发链路', status: 'pending' },
      ],
    })),
    makeFinalResponse('计划已同步，我开始检查。'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
      },
      {
        name: 'record_decision',
        description: 'record orchestration decision',
        transcriptMode: 'suppress',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    ],
    { update_plan: '计划已更新' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{
    role: 'user',
    content: '你先列个计划看看 CatsCo 这个项目的 skill 做得怎么样，怎么触发和使用。',
  }]);

  const firstCallMessages = mock.getReceivedMessages()[0];
  const initialHint = firstCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('用户明确要求列计划')
      && message.content.includes('update_plan'),
  );
  const retryMessages = mock.getReceivedMessages()[1];
  const retryHint = retryMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('直接用普通文本回复了计划')
      && message.content.includes('update_plan'),
  );

  assert.ok(initialHint, 'explicit plan requests should get a targeted transient hint');
  assert.ok(retryHint, 'text-only plan answers should be retried once');
  assert.equal(toolExecutor.getExecutionCount('update_plan'), 1);
  assert.equal(
    result.messages.some(message => (
      message.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.startsWith('计划：')
    )),
    false,
    'the discarded text-only plan should not be persisted before update_plan',
  );
  assert.equal(result.response, '计划已同步，我开始检查。');
});

test('runner does not force an orchestration checkpoint for meta questions about plan or subagents', async () => {
  const responses: ChatResponse[] = [
    makeFinalResponse('因为上一轮我误判成单线任务了，下次应该先做编排判断。'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
      },
      {
        name: 'record_decision',
        description: 'record orchestration decision',
        transcriptMode: 'suppress',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    ],
    {},
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{
    role: 'user',
    content: '我想问下你刚才执行这个任务的时候为什么不会列出plan和考虑使用子agent呢？',
  }]);

  assert.equal(result.response, '因为上一轮我误判成单线任务了，下次应该先做编排判断。');
  assert.equal(mock.getReceivedMessages().length, 1, 'meta questions should be answered directly in one model turn');
  assert.equal(
    mock.getReceivedMessages()[0].some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('编排 checkpoint')
    )),
    false,
    'meta questions about orchestration should not receive a checkpoint hint',
  );
});

test('runner blocks exploratory tools during checkpoint until the model records a decision', async () => {
  const responses: ChatResponse[] = [
    {
      content: '我先读几个关键点。',
      toolCalls: [
        makeToolCall('call_read_1', 'read_file', { file_path: '/tmp/a.ts' }),
        makeToolCall('call_grep_1', 'grep', { pattern: 'working', path: '/tmp/b.ts' }),
      ],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
    {
      content: '我继续查代码。',
      toolCalls: [
        makeToolCall('call_read_2', 'read_file', { file_path: '/tmp/c.ts' }),
      ],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
    makeToolResponse(makeToolCall('call_decision_1', 'record_decision', {
      summary: '先单线推进',
      reason: '范围虽然较广，但当前先验证入口文件即可',
      plan_decision: 'skip',
      subagent_decision: 'skip',
      task_split: '主线检查入口和状态链路',
      next_action: '继续读取关键文件',
    })),
    makeFinalResponse('checkpoint done'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
        },
      },
      {
        name: 'grep',
        description: 'grep',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
      },
      {
        name: 'record_decision',
        description: 'record orchestration decision',
        transcriptMode: 'suppress',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    ],
    { read_file: 'file contents', grep: 'grep result', record_decision: 'decision recorded' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{
    role: 'user',
    content: [
      '我想这周把 CatsCo 桌面端整理成一个给新用户可试用的版本。你先帮我做一次完整只读检查。',
      '从用户第一次打开应用开始，依次看安装启动、CatsCompany 登录绑定、模型配置、聊天发送、长任务等待、停止任务、历史消息、附件处理、日志排查这些流程。',
      '找出最容易让普通用户卡住或误解的地方，不要改代码，必要时可以跑现有测试。最后按“必须先修 / 可以这版修 / 后面优化”给我一份清单，每项写清楚证据文件、用户影响和建议动作。',
    ].join('\n'),
  }]);

  const secondCallMessages = mock.getReceivedMessages()[1];
  const retryHint = secondCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('刚才请求的探索工具')
      && message.content.includes('read_file')
      && message.content.includes('grep')
      && message.content.includes('没有执行')
      && message.content.includes('record_decision'),
  );

  assert.ok(retryHint, 'checkpoint should block exploration until an orchestration decision is made');
  assert.deepEqual(
    mock.getReceivedTools()[1].map(tool => tool.name),
    ['update_plan', 'spawn_subagent', 'record_decision'],
  );
  const thirdCallMessages = mock.getReceivedMessages()[2];
  const gateHint = thirdCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('当前轮次未开放的工具')
      && message.content.includes('read_file')
      && message.content.includes('record_decision'),
  );
  assert.ok(gateHint, 'checkpoint should block more exploration until a plan/subagent/decision tool is used');
  assert.equal(toolExecutor.getExecutionCount('read_file'), 0, 'checkpoint exploration should be blocked before decision');
  assert.equal(toolExecutor.getExecutionCount('grep'), 0, 'checkpoint exploration should be blocked before decision');
  assert.equal(toolExecutor.getExecutionCount('record_decision'), 1);
  assert.equal(result.response, 'checkpoint done');
});

test('runner gives short work requests a semantic orchestration checkpoint', async () => {
  const responses: ChatResponse[] = [
    {
      content: '我先看入口。',
      toolCalls: [
        makeToolCall('call_read_1', 'read_file', { file_path: '/tmp/a.ts' }),
        makeToolCall('call_grep_1', 'grep', { pattern: 'login', path: '/tmp' }),
      ],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
    makeToolResponse(makeToolCall('call_decision_1', 'record_decision', {
      summary: '短句触发但任务已变成长链路检查，先单线推进',
      reason: '当前证据仍集中在同一条链路，继续主线读取更快',
      plan_decision: 'skip',
      subagent_decision: 'skip',
      task_split: '主线继续收束登录和状态链路',
      next_action: '整理结论',
    })),
    makeFinalResponse('done'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
        },
      },
      {
        name: 'grep',
        description: 'grep',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
      {
        name: 'execute_shell',
        description: 'shell',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
        },
      },
      {
        name: 'update_plan',
        description: 'update runtime plan',
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'array' },
          },
        },
      },
      {
        name: 'spawn_subagent',
        description: 'spawn background worker',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
      },
      {
        name: 'record_decision',
        description: 'record orchestration decision',
        transcriptMode: 'suppress',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    ],
    {
      read_file: 'file contents',
      grep: 'grep result',
      execute_shell: 'shell result',
      record_decision: 'decision recorded',
    },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{ role: 'user', content: '继续看看这个' }]);

  const firstCallMessages = mock.getReceivedMessages()[0];
  const semanticHint = firstCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('语义编排 checkpoint')
      && message.content.includes('简单任务直接做'),
  );
  assert.ok(semanticHint, 'short work requests should receive a semantic orchestration hint');

  const checkpointCallMessages = mock.getReceivedMessages()[1];
  const retryHint = checkpointCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('刚刚开始了多个探索类工具调用')
      && message.content.includes('update_plan / spawn_subagent / record_decision'),
  );
  assert.ok(retryHint, 'short work requests that start exploring should be pulled into a decision checkpoint');
  assert.deepEqual(
    mock.getReceivedTools()[1].map(tool => tool.name),
    ['update_plan', 'spawn_subagent', 'record_decision'],
    'the semantic retry turn should switch to orchestration checkpoint tools after exploration starts',
  );
  assert.equal(toolExecutor.getExecutionCount('record_decision'), 1);
  assert.equal(result.response, 'done');
  assert.equal(
    mock.getReceivedMessages()[2].some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('还没有维护运行时计划')
    )),
    false,
    'record_decision should satisfy the checkpoint without immediately nagging about plan again',
  );
  assert.equal(
    result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('语义编排 checkpoint')
    )),
    false,
    'semantic checkpoint hint should remain transient',
  );
});

test('runner gives a transient finalization hint before maxTurns is exhausted', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_read_1', 'read_file', { file_path: '/tmp/1.txt' })),
    makeToolResponse(makeToolCall('call_read_2', 'read_file', { file_path: '/tmp/2.txt' })),
    makeToolResponse(makeToolCall('call_read_3', 'read_file', { file_path: '/tmp/3.txt' })),
    makeFinalResponse('final summary'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [{
      name: 'read_file',
      description: 'read file',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
        },
        required: ['file_path'],
      },
    }],
    { read_file: 'file contents' },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
    maxTurns: 5,
  });
  const result = await runner.run([{ role: 'user', content: '做一个较大的检查' }]);

  const secondCallMessages = mock.getReceivedMessages()[1];
  const finalizationHint = secondCallMessages.find(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('工具轮次预算即将耗尽'),
  );

  assert.ok(finalizationHint, 'runner should warn bounded tool loops before the budget is exhausted');
  assert.equal(
    result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('工具轮次预算即将耗尽')
    )),
    false,
    'finalization hint should remain transient',
  );
});

test('runner pauses only when pause_turn is called explicitly', async () => {
  const responses = [
    {
      content: null,
      toolCalls: [
        makeToolCall('call_reply', 'send_text', { text: '老师好！' }),
        makeToolCall('call_pause', 'pause_turn', { reason: '当前回复已完成' }),
      ],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'send_text',
        description: 'send visible message',
        transcriptMode: 'outbound_message',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
      {
        name: 'pause_turn',
        description: 'pause current turn',
        transcriptMode: 'suppress',
        controlMode: 'pause_turn',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
        },
      },
    ],
    {
      send_text: '消息已发送',
      pause_turn: '当前这一轮已暂停：当前回复已完成',
    },
    {
      pause_turn: 'pause_turn',
    },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{ role: 'user', content: '你好' }]);

  assert.equal(
    mock.getReceivedMessages().length,
    1,
    'pause_turn should stop the run immediately after the current turn',
  );
  assert.equal(result.response, '');
  assert.deepEqual(
    result.messages.map(message => ({ role: message.role, content: message.content })),
    [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '老师好！' },
    ],
  );
});

test('runner allows duplicate outbound messages but injects a soft hint before the next turn', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_1', 'send_text', { text: '老师好！' })),
    makeToolResponse(makeToolCall('call_2', 'send_text', { text: '老师好！' })),
    {
      content: null,
      toolCalls: [makeToolCall('call_3', 'pause_turn', { reason: '当前回复已完成' })],
      usage: {
        promptTokens: 110,
        completionTokens: 20,
        totalTokens: 130,
      },
    },
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'send_text',
        description: 'send visible message',
        transcriptMode: 'outbound_message',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
      {
        name: 'pause_turn',
        description: 'pause current turn',
        transcriptMode: 'suppress',
        controlMode: 'pause_turn',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
        },
      },
    ],
    {
      send_text: '消息已发送',
      pause_turn: '当前这一轮已暂停：当前回复已完成',
    },
    {
      pause_turn: 'pause_turn',
    },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, { stream: true, enableCompression: false });
  const result = await runner.run([{ role: 'user', content: '你好' }]);

  assert.equal(
    toolExecutor.getExecutionCount('send_text'),
    2,
    'duplicate outbound messages should no longer be hard-blocked',
  );

  const thirdCallMessages = mock.getReceivedMessages()[2];
  assert.ok(
    thirdCallMessages.some(
      message => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes('连续发送了与上一条相同的内容'),
    ),
    'runner should inject a soft hint so the model can decide whether to pause or continue',
  );

  assert.deepEqual(
    result.messages
      .filter(message => message.role !== 'system')
      .map(message => ({ role: message.role, content: message.content })),
    [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '老师好！' },
      { role: 'assistant', content: '老师好！' },
    ],
  );
});

test('runner keeps duplicate outbound hints transient and collapses repeated assistant text before the next provider call', async () => {
  const repeated = '在的老师，有什么事？';
  const responses = [
    makeToolResponse(makeToolCall('call_1', 'send_text', { text: repeated })),
    makeToolResponse(makeToolCall('call_2', 'send_text', { text: repeated })),
    makeToolResponse(makeToolCall('call_3', 'send_text', { text: repeated })),
    {
      content: null,
      toolCalls: [makeToolCall('call_4', 'pause_turn', { reason: '当前回复已完成' })],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'send_text',
        description: 'send visible message',
        transcriptMode: 'outbound_message',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
      {
        name: 'pause_turn',
        description: 'pause current turn',
        transcriptMode: 'suppress',
        controlMode: 'pause_turn',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
        },
      },
    ],
    {
      send_text: '消息已发送',
      pause_turn: '当前这一轮已暂停：当前回复已完成',
    },
    {
      pause_turn: 'pause_turn',
    },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });

  await runner.run([{ role: 'user', content: '你好' }]);

  const fourthCallMessages = mock.getReceivedMessages()[3];
  const repeatedAssistantMessages = fourthCallMessages.filter(
    message => message.role === 'assistant' && message.content === repeated,
  );
  const transientHints = fourthCallMessages.filter(
    message => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('连续发送了与上一条相同的内容'),
  );

  assert.equal(
    repeatedAssistantMessages.length,
    1,
    'provider input should collapse repeated assistant messages into a single visible message',
  );
  assert.equal(
    transientHints.length,
    1,
    'provider input should carry at most one transient duplicate-warning hint',
  );
});

test('runner allows sending the same outbound content again after a new observation arrives', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_reply_1', 'send_text', { text: '我先看看。' })),
    makeToolResponse(makeToolCall('call_read', 'read_file', { file_path: '/tmp/a.txt' })),
    makeToolResponse(makeToolCall('call_reply_2', 'send_text', { text: '我先看看。' })),
    {
      content: null,
      toolCalls: [makeToolCall('call_pause', 'pause_turn', { reason: '当前回复已完成' })],
      usage: {
        promptTokens: 110,
        completionTokens: 20,
        totalTokens: 130,
      },
    },
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'send_text',
        description: 'send visible message',
        transcriptMode: 'outbound_message',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
      {
        name: 'read_file',
        description: 'read file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'pause_turn',
        description: 'pause current turn',
        transcriptMode: 'suppress',
        controlMode: 'pause_turn',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
        },
      },
    ],
    {
      send_text: '消息已发送',
      read_file: '新的文件内容',
      pause_turn: '当前这一轮已暂停：当前回复已完成',
    },
    {
      pause_turn: 'pause_turn',
    },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });

  await runner.run([{ role: 'user', content: '开始吧' }]);

  assert.equal(
    toolExecutor.getExecutionCount('send_text'),
    2,
    'same outbound content should be allowed again after a new observation changes the working context',
  );
  const fourthCallMessages = mock.getReceivedMessages()[3];
  assert.equal(
    fourthCallMessages.some(
      message => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes('连续发送了与上一条相同的内容'),
    ),
    false,
    'new observations should clear the duplicate-outbound hint path',
  );
});

test('agent session stores normalized assistant messages after send_text tool calls', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_1', 'send_text', { text: '先回老师一声。' })),
    makeToolResponse(makeToolCall('call_2', 'send_text', { text: '我继续查一下。' })),
    makeFinalResponse(),
  ];
  const mock = createMockAI(responses);
  const toolManager = new ToolManager();
  const services: AgentServices = {
    aiService: mock.aiService,
    toolManager,
    skillManager: new SkillManager(),
  };
  const session = new AgentSession('cli', services);

  await session.handleMessage('你好', {
    channel: {
      chatId: 'test-chat',
      reply: async () => {},
      sendFile: async () => {},
    },
  });

  const messages = ((session as any).messages as Message[]).filter(message => message.role !== 'system');
  assert.equal(
    messages.some(message => message.role === 'tool'),
    false,
    'session transcript should not keep outbound send_text tool_result messages',
  );
  assert.deepEqual(
    messages.map(message => ({ role: message.role, content: message.content })),
    [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '先回老师一声。' },
      { role: 'assistant', content: '我继续查一下。' },
    ],
  );
});

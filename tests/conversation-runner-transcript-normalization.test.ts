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
  let index = 0;

  return {
    aiService: {
      async chat(messages: Message[]) {
        receivedMessages.push(cloneMessages(messages));
        return responses[index++] ?? makeFinalResponse();
      },
      async chatStream(messages: Message[]) {
        receivedMessages.push(cloneMessages(messages));
        return responses[index++] ?? makeFinalResponse();
      },
    } as any,
    getReceivedMessages: () => receivedMessages,
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

test('runner continues after an outbound file and blocks duplicate file sends in the same run', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_file', 'send_file', {
      file_path: 'C:\\Users\\test\\Desktop\\report.docx',
      file_name: 'report.docx',
    })),
    makeToolResponse(makeToolCall('call_file_again', 'send_file', {
      file_path: 'C:\\Users\\test\\Desktop\\report.docx',
      file_name: 'report.docx',
    })),
    makeFinalResponse('已发送 report.docx。'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'send_file',
        description: 'send visible file',
        transcriptMode: 'outbound_file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            file_name: { type: 'string' },
          },
          required: ['file_path', 'file_name'],
        },
      },
    ],
    {
      send_file: [
        'File sent to current chat.',
        'Path: C:\\Users\\test\\Desktop\\report.docx',
        'Name: report.docx',
      ].join('\n'),
    },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{ role: 'user', content: 'send the desktop docx' }]);

  assert.equal(
    mock.getReceivedMessages().length,
    3,
    'runner should continue normally after sending a file',
  );
  assert.equal(
    toolExecutor.getExecutionCount('send_file'),
    1,
    'duplicate send_file calls for the same file should not execute the upload again',
  );
  const thirdCallMessages = mock.getReceivedMessages()[2];
  assert.ok(
    thirdCallMessages.some(
      message => message.role === 'tool'
        && typeof message.content === 'string'
        && message.content.includes('already sent earlier in the current agent run'),
    ),
    'the model should see a tool_result explaining that the duplicate send was blocked',
  );
  assert.equal(result.response, '已发送 report.docx。');
  assert.deepEqual(
    result.messages
      .filter(message => message.role !== 'tool')
      .map(message => ({ role: message.role, content: message.content })),
    [
      { role: 'user', content: 'send the desktop docx' },
      { role: 'assistant', content: 'report.docx' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: '已发送 report.docx。' },
    ],
  );
});

test('runner keeps legal transcript order for duplicate send_file calls in the same assistant response', async () => {
  const responses = [
    {
      content: null,
      toolCalls: [
        makeToolCall('call_file_1', 'send_file', {
          file_path: 'C:\\Users\\test\\Desktop\\report.docx',
          file_name: 'report.docx',
        }),
        makeToolCall('call_file_2', 'send_file', {
          file_path: 'C:\\Users\\test\\Desktop\\report.docx',
          file_name: 'report.docx',
        }),
      ],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    },
    makeFinalResponse('sent report.docx'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'send_file',
        description: 'send visible file',
        transcriptMode: 'outbound_file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            file_name: { type: 'string' },
          },
          required: ['file_path', 'file_name'],
        },
      },
    ],
    {
      send_file: [
        'File sent to current chat.',
        'Path: C:\\Users\\test\\Desktop\\report.docx',
        'Name: report.docx',
      ].join('\n'),
    },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  await runner.run([{ role: 'user', content: 'send the desktop docx twice' }]);

  assert.equal(toolExecutor.getExecutionCount('send_file'), 1);
  const secondCallMessages = mock.getReceivedMessages()[1];
  const assistantIndex = secondCallMessages.findIndex(message => message.role === 'assistant' && Boolean(message.tool_calls?.length));
  const firstToolIndex = secondCallMessages.findIndex(message => message.role === 'tool' && message.tool_call_id === 'call_file_1');
  const secondToolIndex = secondCallMessages.findIndex(message => message.role === 'tool' && message.tool_call_id === 'call_file_2');
  const outboundAssistantBetween = secondCallMessages
    .slice(assistantIndex + 1, firstToolIndex)
    .some(message => message.role === 'assistant');

  assert.ok(assistantIndex >= 0);
  assert.equal(secondCallMessages[assistantIndex].tool_calls?.length, 2);
  assert.equal(firstToolIndex, assistantIndex + 1);
  assert.equal(secondToolIndex, assistantIndex + 2);
  assert.equal(outboundAssistantBetween, false);
  assert.match(String(secondCallMessages[secondToolIndex].content), /already sent earlier/);
});

test('runner does not locally retry failed outbound file sends unless the failure is rate limited', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_file', 'send_file', {
      file_path: 'C:\\Users\\test\\Desktop\\resume.html',
      file_name: 'resume.html',
    })),
    makeFinalResponse('这个平台不支持直接发送 html 文件。'),
  ];
  const mock = createMockAI(responses);
  const toolExecutor = new MockToolExecutor(
    [
      {
        name: 'send_file',
        description: 'send visible file',
        transcriptMode: 'outbound_file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            file_name: { type: 'string' },
          },
          required: ['file_path', 'file_name'],
        },
      },
    ],
    {
      send_file: 'File send failed: Upload failed: 400 - {"error":"file type not allowed"}',
    },
  );

  const originalExecute = toolExecutor.executeTool.bind(toolExecutor);
  toolExecutor.executeTool = async (toolCall, history, context) => {
    const result = await originalExecute(toolCall, history, context);
    return {
      ...result,
      ok: false,
      errorCode: 'TOOL_EXECUTION_ERROR',
      retryable: false,
    };
  };

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  const result = await runner.run([{ role: 'user', content: 'send the desktop html' }]);

  assert.equal(
    toolExecutor.getExecutionCount('send_file'),
    1,
    'ordinary upload failures must not be retried locally without another model turn',
  );
  assert.equal(
    mock.getReceivedMessages().length,
    2,
    'the next action after a non-rate-limit send failure should be another model turn with the tool_result',
  );
  assert.equal(result.response, '这个平台不支持直接发送 html 文件。');
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
  const originalGauzMemEnabled = process.env.GAUZMEM_ENABLED;
  process.env.GAUZMEM_ENABLED = 'false';
  const responses = [
    makeToolResponse(makeToolCall('call_1', 'send_text', { text: '先回老师一声。' })),
    makeToolResponse(makeToolCall('call_2', 'send_text', { text: '我继续查一下。' })),
    makeFinalResponse(),
  ];
  try {
    const mock = createMockAI(responses);
    const toolManager = new ToolManager(process.cwd(), {}, { enabledToolNames: ['send_text'] });
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
  } finally {
    if (originalGauzMemEnabled === undefined) delete process.env.GAUZMEM_ENABLED;
    else process.env.GAUZMEM_ENABLED = originalGauzMemEnabled;
  }
});

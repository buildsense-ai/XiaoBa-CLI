import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { AgentSession, AgentServices } from '../src/core/agent-session';
import { ToolExecutor, ToolResult, ToolDefinition, ToolCall, ToolExecutionContext } from '../src/types/tool';
import { ChatResponse, Message } from '../src/types';
import { ToolManager } from '../src/tools/tool-manager';
import { SkillManager } from '../src/skills/skill-manager';
import { MODEL_IMAGE_SAFETY_MESSAGE, isModelImageSafetyError } from '../src/utils/model-error-classifier';

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

test('runner injects current directory before the active request context without becoming the final message', async () => {
  const responses = [
    makeToolResponse(makeToolCall('call_read', 'read_file', { file_path: 'notes.txt' })),
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
  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
    toolExecutionContext: {
      workingDirectory: 'C:\\Users\\test\\workspace',
      getCurrentDirectory: () => 'C:\\Users\\test\\workspace',
    },
  });

  await runner.run([{ role: 'user', content: 'read notes' }]);

  const firstCallMessages = mock.getReceivedMessages()[0];
  assert.match(String(firstCallMessages[0].content), /^\[transient_current_directory\]/);
  assert.equal(firstCallMessages[0].role, 'user');
  assert.equal(firstCallMessages[1].role, 'user');
  assert.equal(firstCallMessages[1].content, 'read notes');

  const secondCallMessages = mock.getReceivedMessages()[1];
  const cwdIndex = secondCallMessages.findIndex(
    message => typeof message.content === 'string'
      && message.content.startsWith('[transient_current_directory]'),
  );
  const assistantToolIndex = secondCallMessages.findIndex(
    message => message.role === 'assistant'
      && message.tool_calls?.some(toolCall => toolCall.id === 'call_read'),
  );

  assert.equal(cwdIndex, assistantToolIndex - 1);
  assert.equal(secondCallMessages[assistantToolIndex + 1].role, 'tool');
  assert.match(
    String(secondCallMessages[cwdIndex].content),
    /^\[transient_current_directory\]\nRuntime context only\. Not a user request\. Do not answer\.\ncwd: C:\\Users\\test\\workspace\nUse only for relative file paths\.$/,
  );
  assert.equal(
    secondCallMessages[secondCallMessages.length - 1].role,
    'tool',
    'after a tool exchange, the tool_result should remain the final message instead of the cwd hint',
  );
});

test('runner surfaces image safety errors after outbound messages on message surfaces', async () => {
  const toolCall = makeToolCall('call_send', 'send_text', { text: '我先把前半段发给你。' });
  const receivedMessages: Message[][] = [];
  const sentReplies: string[] = [];
  let calls = 0;
  const aiService = {
    async chat(messages: Message[]) {
      return this.chatStream(messages);
    },
    async chatStream(messages: Message[]) {
      receivedMessages.push(cloneMessages(messages));
      calls++;
      if (calls === 1) {
        return makeToolResponse(toolCall);
      }
      throw new Error('API错误 (500): 500 {"type":"error","error":{"type":"api_error","message":"input_new_sensitive, messages[86] content[3] image is sensitive, please check your input (1026)"}}');
    },
  };
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
  const runner = new ConversationRunner(aiService as any, toolExecutor, {
    stream: true,
    enableCompression: false,
    toolExecutionContext: {
      surface: 'catscompany',
      channel: {
        chatId: 'p2p_1_2',
        reply: async (_chatId: string, text: string) => {
          sentReplies.push(text);
        },
      },
    } as any,
  });

  const result = await runner.run([{ role: 'user', content: '读图后分段发结果' }]);

  assert.equal(calls, 2);
  assert.equal(result.finalResponseVisible, true);
  assert.equal(result.response, MODEL_IMAGE_SAFETY_MESSAGE);
  assert.equal(
    result.messages.some(message => message.role === 'assistant' && message.content === MODEL_IMAGE_SAFETY_MESSAGE),
    true,
  );
  assert.equal(
    result.messages.some(message => message.role === 'assistant' && message.content === '我先把前半段发给你。'),
    true,
  );
  assert.equal(receivedMessages.length, 2);
  assert.deepEqual(sentReplies, [], 'CatsCompany outer adapter sends visible result, runner must not double-send');
});

test('runner replies image safety errors directly on non-CatsCompany message surfaces', async () => {
  const sentReplies: string[] = [];
  const aiService = {
    async chat() {
      throw new Error('API错误 (500): {"error":{"message":"input_new_sensitive, messages[3] content[1] image is sensitive"}}');
    },
    async chatStream() {
      throw new Error('API错误 (500): {"error":{"message":"input_new_sensitive, messages[3] content[1] image is sensitive"}}');
    },
  };
  const runner = new ConversationRunner(aiService as any, new MockToolExecutor([], {}), {
    stream: true,
    enableCompression: false,
    toolExecutionContext: {
      surface: 'feishu',
      channel: {
        chatId: 'chat_1',
        reply: async (_chatId: string, text: string) => {
          sentReplies.push(text);
        },
      },
    } as any,
  });

  const result = await runner.run([{ role: 'user', content: '看图' }]);

  assert.equal(result.finalResponseVisible, true);
  assert.equal(result.response, MODEL_IMAGE_SAFETY_MESSAGE);
  assert.deepEqual(sentReplies, [MODEL_IMAGE_SAFETY_MESSAGE]);
});

test('image safety classifier requires image evidence', () => {
  assert.equal(
    isModelImageSafetyError(new Error('API错误 (500): {"message":"input_new_sensitive, text is sensitive"}')),
    false,
  );
  assert.equal(
    isModelImageSafetyError(new Error('API错误 (500): {"message":"input_new_sensitive, messages[86] content[3] image is sensitive"}')),
    true,
  );
});

test('runner recovers once from empty max_tokens responses before surfacing a fallback', async () => {
  const responses: ChatResponse[] = [
    {
      content: null,
      toolCalls: [],
      stopReason: 'max_tokens',
      usage: {
        promptTokens: 100,
        completionTokens: 8192,
        totalTokens: 8292,
      },
    },
    makeFinalResponse('已继续处理。'),
  ];
  const mock = createMockAI(responses);
  const runner = new ConversationRunner(mock.aiService, new MockToolExecutor([], {}), {
    stream: true,
    enableCompression: false,
  });

  const result = await runner.run([{ role: 'user', content: '继续包装 skill' }]);

  assert.equal(result.response, '已继续处理。');
  assert.equal(mock.getReceivedMessages().length, 2);
  assert.ok(
    mock.getReceivedMessages()[1].some(message =>
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('输出 max_tokens 上限被截断')
    ),
    'second call should include a recovery hint',
  );
});

test('runner does not return raw no-reply when empty max_tokens recovery fails', async () => {
  const responses: ChatResponse[] = [
    {
      content: null,
      toolCalls: [],
      stopReason: 'max_tokens',
      usage: { promptTokens: 100, completionTokens: 8192, totalTokens: 8292 },
    },
    {
      content: null,
      toolCalls: [],
      stopReason: 'max_tokens',
      usage: { promptTokens: 100, completionTokens: 8192, totalTokens: 8292 },
    },
  ];
  const mock = createMockAI(responses);
  const runner = new ConversationRunner(mock.aiService, new MockToolExecutor([], {}), {
    stream: true,
    enableCompression: false,
  });

  const result = await runner.run([{ role: 'user', content: '继续包装 skill' }]);

  assert.match(result.response, /模型这轮输出达到了 max_tokens 上限/);
  assert.notEqual(result.response, '[无回复]');
  assert.equal(result.messages[result.messages.length - 1]?.content, result.response);
});

test('runner sends empty max_tokens fallback through message surface channel', async () => {
  const responses: ChatResponse[] = [
    {
      content: null,
      toolCalls: [],
      stopReason: 'max_tokens',
      usage: { promptTokens: 100, completionTokens: 8192, totalTokens: 8292 },
    },
    {
      content: null,
      toolCalls: [],
      stopReason: 'max_tokens',
      usage: { promptTokens: 100, completionTokens: 8192, totalTokens: 8292 },
    },
  ];
  const sent: Array<{ chatId: string; text: string }> = [];
  const mock = createMockAI(responses);
  const runner = new ConversationRunner(mock.aiService, new MockToolExecutor([], {}), {
    stream: true,
    enableCompression: false,
    toolExecutionContext: {
      surface: 'feishu',
      channel: {
        chatId: 'chat_1',
        reply: async (chatId: string, text: string) => {
          sent.push({ chatId, text });
        },
        sendFile: async () => {},
      },
    },
  });

  const result = await runner.run([{ role: 'user', content: '继续包装 skill' }]);

  assert.match(result.response, /模型这轮输出达到了 max_tokens 上限/);
  assert.deepEqual(sent, [{ chatId: 'chat_1', text: result.response }]);
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

test('runner records outbound file sends as normal tool_result transcript for later turns', async () => {
  const sentFileResult = [
    'File sent to current chat.',
    'Path: C:\\Users\\test\\Desktop\\report.docx',
    'Name: report.docx',
  ].join('\n');
  const responses = [
    makeToolResponse(makeToolCall('call_file', 'send_file', {
      file_path: 'C:\\Users\\test\\Desktop\\report.docx',
      file_name: 'report.docx',
    })),
    makeToolResponse(makeToolCall('call_file_again', 'send_file', {
      file_path: 'C:\\Users\\test\\Desktop\\report.docx',
      file_name: 'report.docx',
    })),
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
    { send_file: sentFileResult },
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
    2,
    'send_file calls should execute normally; repeated sends are handled by model-visible tool results',
  );

  const secondCallMessages = mock.getReceivedMessages()[1];
  const secondAssistantIndex = secondCallMessages.findIndex(
    message => message.role === 'assistant'
      && message.tool_calls?.some(toolCall => toolCall.id === 'call_file'),
  );
  assert.notEqual(secondAssistantIndex, -1);
  assert.deepEqual(
    secondCallMessages[secondAssistantIndex + 1],
    {
      role: 'tool',
      content: sentFileResult,
      tool_call_id: 'call_file',
      name: 'send_file',
    },
    'the model should see send_file as a normal tool_result immediately after its assistant tool_call',
  );

  const thirdCallMessages = mock.getReceivedMessages()[2];
  const thirdToolResults = thirdCallMessages.filter(
    message => message.role === 'tool' && message.name === 'send_file',
  );
  assert.equal(thirdToolResults.length, 2);
  assert.deepEqual(
    thirdToolResults.map(message => message.tool_call_id),
    ['call_file', 'call_file_again'],
    'each successful send_file call should have its own legal tool_result',
  );
  assert.ok(
    !thirdCallMessages.some(
      message => typeof message.content === 'string' && message.content.includes('[outbound_file_sent]'),
    ),
    'send_file should not inject assistant state markers into provider input',
  );
  assert.equal(result.response, 'sent report.docx');
  assert.deepEqual(
    result.messages.map(message => ({
      role: message.role,
      content: message.content,
      tool_call_id: message.tool_call_id,
      name: message.name,
    })),
    [
      { role: 'user', content: 'send the desktop docx', tool_call_id: undefined, name: undefined },
      { role: 'assistant', content: null, tool_call_id: undefined, name: undefined },
      { role: 'tool', content: sentFileResult, tool_call_id: 'call_file', name: 'send_file' },
      { role: 'assistant', content: null, tool_call_id: undefined, name: undefined },
      { role: 'tool', content: sentFileResult, tool_call_id: 'call_file_again', name: 'send_file' },
      { role: 'assistant', content: 'sent report.docx', tool_call_id: undefined, name: undefined },
    ],
  );
});

test('runner keeps repeated send_file calls in the same assistant response as legal tool_results', async () => {
  const sentFileResult = [
    'File sent to current chat.',
    'Path: C:\\Users\\test\\Desktop\\report.docx',
    'Name: report.docx',
  ].join('\n');
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
    { send_file: sentFileResult },
  );

  const runner = new ConversationRunner(mock.aiService, toolExecutor, {
    stream: true,
    enableCompression: false,
  });
  await runner.run([{ role: 'user', content: 'send the desktop docx twice' }]);

  assert.equal(toolExecutor.getExecutionCount('send_file'), 2);
  const secondCallMessages = mock.getReceivedMessages()[1];
  const assistantIndex = secondCallMessages.findIndex(
    message => message.role === 'assistant' && message.tool_calls?.length === 2,
  );
  assert.notEqual(assistantIndex, -1);
  assert.deepEqual(
    secondCallMessages[assistantIndex].tool_calls?.map(toolCall => toolCall.id),
    ['call_file_1', 'call_file_2'],
  );
  assert.deepEqual(
    secondCallMessages.slice(assistantIndex + 1, assistantIndex + 3),
    [
      {
        role: 'tool',
        content: sentFileResult,
        tool_call_id: 'call_file_1',
        name: 'send_file',
      },
      {
        role: 'tool',
        content: sentFileResult,
        tool_call_id: 'call_file_2',
        name: 'send_file',
      },
    ],
    'each send_file result should immediately follow the assistant message that requested it',
  );
  assert.ok(
    !secondCallMessages.some(
      message => typeof message.content === 'string' && message.content.includes('[outbound_file_sent]'),
    ),
    'send_file should not inject assistant state markers for repeated sends',
  );
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

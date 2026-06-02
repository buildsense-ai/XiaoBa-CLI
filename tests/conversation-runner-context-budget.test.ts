import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner, PROMPT_BUDGET_TRIM_MESSAGE, PROMPT_TOOLS_DISABLED_MESSAGE } from '../src/core/conversation-runner';
import { estimateMessageTokens, estimateMessagesTokens, estimateToolsTokens } from '../src/core/token-estimator';
import type { ContentBlock, Message } from '../src/types';
import type { ToolDefinition, ToolExecutor } from '../src/types/tool';

function makeRunner(maxContextTokens: number): ConversationRunner {
  const executor: ToolExecutor = {
    getToolDefinitions: () => [],
    executeTool: async () => ({ content: 'ok' }),
  };
  return new ConversationRunner({} as any, executor, {
    maxContextTokens,
    stream: false,
  });
}

test('prompt budget guard counts system messages and tool schemas before provider requests', () => {
  const runner = makeRunner(5_000);
  const tools: ToolDefinition[] = [
    {
      name: 'large_tool',
      description: '中'.repeat(1_200),
      parameters: {
        type: 'object',
        properties: {
          payload: {
            type: 'string',
            description: '中'.repeat(1_200),
          },
        },
      },
    },
  ];
  const messages: Message[] = [
    { role: 'system', content: '系统提示'.repeat(3_000) },
    { role: 'user', content: '用户历史'.repeat(3_000) },
    { role: 'assistant', content: '助手历史'.repeat(3_000) },
    { role: 'user', content: '当前问题'.repeat(1_000) },
  ];

  (runner as any).ensurePromptBudget(messages, tools);

  const total = estimateMessagesTokens(messages) + estimateToolsTokens(tools);
  assert.ok(total <= 5_000, `trimmed prompt should fit budget, got ${total}`);
  assert.ok(messages.some(message => message.role === 'system'), 'system prompt should be retained after trimming');
});

test('minimal fallback keeps shrinking oversized system prompts until they fit', () => {
  const runner = makeRunner(1_000);
  const messages: Message[] = [
    { role: 'system', content: '系统提示'.repeat(5_000) },
    { role: 'user', content: '当前问题'.repeat(2_000) },
    { role: 'assistant', content: '助手历史'.repeat(2_000) },
  ];

  (runner as any).ensurePromptBudget(messages, []);

  const total = estimateMessagesTokens(messages);
  assert.ok(total <= 1_000, `minimal fallback should fit budget, got ${total}`);
  assert.equal(messages[0].role, 'system');
});

test('prompt budget guard emits a visible thinking status before mechanical trimming', async () => {
  const executor: ToolExecutor = {
    getToolDefinitions: () => [],
    executeTool: async () => ({ content: 'ok' }),
  };
  let capturedMessages: Message[] = [];
  const aiService = {
    async chat(messages: Message[]) {
      capturedMessages = messages;
      return { content: 'done' };
    },
  };
  const runner = new ConversationRunner(aiService as any, executor, {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
  });
  const thinking: string[] = [];

  const result = await runner.run([
    { role: 'system', content: '系统提示'.repeat(4_000) },
    { role: 'user', content: '用户历史'.repeat(4_000) },
  ], {
    onThinking: text => thinking.push(text),
  });

  assert.equal(result.response, 'done');
  assert.deepEqual(thinking, [PROMPT_BUDGET_TRIM_MESSAGE]);
  assert.ok(estimateMessagesTokens(capturedMessages) <= 1_000);
});

test('mechanical prompt trimming removes dangling tool result messages', () => {
  const runner = makeRunner(1_200);
  const messages: Message[] = [
    { role: 'system', content: 'system' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', content: 'old result'.repeat(1_000), tool_call_id: 'old_call', name: 'read_file' },
    ...Array.from({ length: 10 }, (_, index): Message => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `recent ${index} `.repeat(1_000),
    })),
  ];

  (runner as any).ensurePromptBudget(messages, []);

  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const toolCall of message.tool_calls || []) {
      toolCallIds.add(toolCall.id);
    }
    if (message.role === 'tool' && message.tool_call_id) {
      toolResultIds.add(message.tool_call_id);
    }
  }

  for (const toolResultId of toolResultIds) {
    assert.ok(toolCallIds.has(toolResultId), `tool result ${toolResultId} should have a matching assistant tool_call`);
  }
  for (const toolCallId of toolCallIds) {
    assert.ok(toolResultIds.has(toolCallId), `assistant tool_call ${toolCallId} should have a matching tool result`);
  }
});

test('mechanical prompt trimming filters provider replay blocks with retained tool calls', () => {
  const runner = makeRunner(1_200);
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

test('oversized tool schemas are disabled visibly before provider requests', async () => {
  const hugeTool: ToolDefinition = {
    name: 'huge_tool_schema',
    description: '工具说明'.repeat(10_000),
    parameters: {
      type: 'object',
      properties: {
        payload: {
          type: 'string',
          description: '参数说明'.repeat(10_000),
        },
      },
    },
  };
  const executor: ToolExecutor = {
    getToolDefinitions: () => [hugeTool],
    executeTool: async () => ({ content: 'unused' }),
  };
  let capturedTools: ToolDefinition[] | undefined;
  const aiService = {
    async chat(_messages: Message[], tools: ToolDefinition[]) {
      capturedTools = tools;
      return { content: 'text only' };
    },
  };
  const runner = new ConversationRunner(aiService as any, executor, {
    maxContextTokens: 1_000,
    stream: false,
    enableCompression: false,
  });
  const thinking: string[] = [];

  const result = await runner.run([{ role: 'user', content: '继续' }], {
    onThinking: text => thinking.push(text),
  });

  assert.equal(result.response, 'text only');
  assert.deepEqual(capturedTools, []);
  assert.deepEqual(thinking, [PROMPT_TOOLS_DISABLED_MESSAGE]);
});

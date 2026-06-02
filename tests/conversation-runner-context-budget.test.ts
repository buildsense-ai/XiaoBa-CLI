import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { estimateMessagesTokens, estimateToolsTokens } from '../src/core/token-estimator';
import type { Message } from '../src/types';
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

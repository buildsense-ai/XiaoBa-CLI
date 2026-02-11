import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { estimateMessagesTokens } from '../src/core/token-estimator';
import { ToolCall, ToolExecutor, ToolResult } from '../src/types/tool';

class EmptyToolExecutor implements ToolExecutor {
  getToolDefinitions() {
    return [];
  }

  async executeTool(_toolCall: ToolCall): Promise<ToolResult> {
    throw new Error('executeTool should not be called in this test');
  }
}

test('conversation runner retries once with trimmed context when provider reports prompt overflow', async () => {
  const callEstimates: number[] = [];

  const mockAI = {
    async chat(messages: any[]) {
      const estimate = estimateMessagesTokens(messages);
      callEstimates.push(estimate);

      if (callEstimates.length === 1) {
        throw new Error('prompt is too long: > 200000 maximum');
      }

      return {
        content: 'done',
      };
    },
    async chatStream(): Promise<any> {
      throw new Error('not used in this test');
    },
  } as any;

  const runner = new ConversationRunner(mockAI, new EmptyToolExecutor(), {
    stream: false,
    enableCompression: true,
  });

  const hugeToolOutput = 'x'.repeat(18000);
  const hugeAssistantText = '分析内容 '.repeat(2500);
  const messages = [
    { role: 'system' as const, content: 'system prompt' },
    { role: 'user' as const, content: '请继续完善论文精读报告' },
    {
      role: 'assistant' as const,
      content: '调用工具中',
      tool_calls: [
        {
          id: 'tool-1',
          type: 'function' as const,
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'docs/analysis/a.md' }),
          },
        },
      ],
    },
    {
      role: 'tool' as const,
      name: 'read_file',
      tool_call_id: 'tool-1',
      content: hugeToolOutput,
    },
    { role: 'assistant' as const, content: hugeAssistantText },
    {
      role: 'tool' as const,
      name: 'write_file',
      tool_call_id: 'tool-2',
      content: hugeToolOutput,
    },
    { role: 'user' as const, content: '输出给老师的版本要更详细' },
  ];

  const result = await runner.run(messages);
  assert.equal(result.response, 'done');
  assert.equal(callEstimates.length, 2);
  assert.equal(callEstimates[1] < callEstimates[0], true);
});

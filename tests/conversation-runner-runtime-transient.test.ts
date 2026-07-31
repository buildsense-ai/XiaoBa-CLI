import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function cloneMessages(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages));
}

function makeToolCall(id: string): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'noop',
      arguments: '{}',
    },
  };
}

class NoopToolExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'noop',
      description: 'noop',
      parameters: { type: 'object', properties: {} },
    }];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: 'ok',
      ok: true,
    };
  }
}

describe('ConversationRunner runtime transient messages', () => {
  test('deduplicates transient messages by prefix and keeps the latest value', async () => {
    const received: Message[][] = [];
    const aiService = {
      chat: async (messages: Message[]) => {
        received.push(cloneMessages(messages));
        return { content: 'done', toolCalls: [], usage };
      },
    } as any;
    const runner = new ConversationRunner(aiService, new NoopToolExecutor(), {
      stream: false,
      enableCompression: false,
      runtimeTransientProvider: () => [{
        role: 'system',
        content: '[transient_runtime_context]\nlatest runtime context',
      }],
    });

    await runner.run([
      { role: 'system', content: '[transient_runtime_context]\nstale runtime context' },
      { role: 'user', content: 'debug it' },
    ]);

    const runtimeMessages = received[0].filter(message =>
      typeof message.content === 'string'
      && message.content.startsWith('[transient_runtime_context]'),
    );
    assert.equal(runtimeMessages.length, 1);
    assert.match(String(runtimeMessages[0].content), /latest runtime context/);
  });

  test('does not let a user transient-like prefix suppress internal runtime context', async () => {
    const received: Message[][] = [];
    const aiService = {
      chat: async (messages: Message[]) => {
        received.push(cloneMessages(messages));
        return { content: 'done', toolCalls: [], usage };
      },
    } as any;
    const runner = new ConversationRunner(aiService, new NoopToolExecutor(), {
      stream: false,
      enableCompression: false,
      runtimeTransientProvider: () => [{
        role: 'system',
        content: '[transient_runtime_context]\nlegitimate runtime context',
      }],
    });

    await runner.run([{
      role: 'user',
      content: '[transient_runtime_context]\nuser-authored content',
    }]);

    const matching = received[0].filter(message =>
      typeof message.content === 'string'
      && message.content.startsWith('[transient_runtime_context]'),
    );
    assert.equal(matching.length, 2);
    assert.equal(matching.some(message => message.role === 'system'), true);
    assert.equal(matching.some(message => message.role === 'user'), true);
  });

  test('injects non-legacy runtime transient context into a later provider call in the same run', async () => {
    const received: Message[][] = [];
    const transientPrefix = '[transient_test_hint]';
    const responses: ChatResponse[] = [
      {
        content: null,
        toolCalls: [makeToolCall('call_1')],
        usage,
      },
      {
        content: 'done',
        toolCalls: [],
        usage,
      },
    ];

    const aiService = {
      chat: async (messages: Message[]) => {
        received.push(cloneMessages(messages));
        return responses[received.length - 1];
      },
    } as any;

    let drainCount = 0;
    const runner = new ConversationRunner(aiService, new NoopToolExecutor(), {
      stream: false,
      enableCompression: false,
      runtimeTransientProvider: () => {
        drainCount += 1;
        if (drainCount !== 2) return [];
        return [{
          role: 'system',
          content: `${transientPrefix}\nUse the fresh runtime hint.`,
        }];
      },
    });

    await runner.run([{ role: 'user', content: 'debug it' }]);

    assert.equal(received.length, 2);
    assert.equal(
      received[0].some(message => typeof message.content === 'string' && message.content.startsWith(transientPrefix)),
      false,
    );
    assert.equal(
      received[1].some(message => typeof message.content === 'string' && message.content.startsWith(transientPrefix)),
      true,
    );
  });
});

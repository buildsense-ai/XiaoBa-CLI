import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX } from '../src/core/prompt-mode-runtime';
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

class PromptModeToolExecutor implements ToolExecutor {
  executeCount = 0;

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'prompt_mode',
        description: 'loads a prompt mode',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
          },
          required: ['mode'],
        },
      },
      {
        name: 'noop',
        description: 'noop',
        parameters: { type: 'object', properties: {} },
      },
    ];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    this.executeCount += 1;
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
  test('injects runtime transient context into a later provider call in the same run', async () => {
    const received: Message[][] = [];
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
          content: `${TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX}\n[mode:coding-agent]\nUse engineering workflow.`,
        }];
      },
    });

    await runner.run([{ role: 'user', content: 'debug it' }]);

    assert.equal(received.length, 2);
    assert.equal(
      received[0].some(message => typeof message.content === 'string' && message.content.startsWith(TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX)),
      false,
    );
    assert.equal(
      received[1].some(message => typeof message.content === 'string' && message.content.startsWith(TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX)),
      true,
    );
  });

  test('does not expose prompt_mode to the main agent provider tools', async () => {
    const receivedTools: string[][] = [];
    const aiService = {
      chat: async (_messages: Message[], tools: ToolDefinition[] = []) => {
        receivedTools.push(tools.map(tool => tool.name));
        return {
          content: 'done',
          toolCalls: [],
          usage,
        };
      },
    } as any;

    const runner = new ConversationRunner(aiService, new PromptModeToolExecutor(), {
      stream: false,
      enableCompression: false,
    });

    await runner.run([{ role: 'user', content: '准备一节公开课' }]);

    assert.deepEqual(receivedTools, [['noop']]);
  });

  test('does not execute or surface prompt_mode even if the model calls it', async () => {
    const executor = new PromptModeToolExecutor();
    const responses: ChatResponse[] = [
      {
        content: null,
        toolCalls: [{
          id: 'call_prompt_mode',
          type: 'function',
          function: {
            name: 'prompt_mode',
            arguments: JSON.stringify({ mode: 'classroom' }),
          },
        }],
        usage,
      },
      {
        content: 'done',
        toolCalls: [],
        usage,
      },
    ];
    const receivedTools: string[][] = [];
    const aiService = {
      chat: async (_messages: Message[], tools: ToolDefinition[] = []) => {
        receivedTools.push(tools.map(tool => tool.name));
        return responses[receivedTools.length - 1];
      },
    } as any;
    const callbackEvents: string[] = [];

    const runner = new ConversationRunner(aiService, executor, {
      stream: false,
      enableCompression: false,
    });

    const result = await runner.run(
      [{ role: 'user', content: '准备一节公开课' }],
      {
        onToolStart: name => callbackEvents.push(`start:${name}`),
        onToolEnd: name => callbackEvents.push(`end:${name}`),
        onToolDisplay: name => callbackEvents.push(`display:${name}`),
      },
    );

    assert.equal(result.response, 'done');
    assert.deepEqual(receivedTools, [['noop'], ['noop']]);
    assert.equal(executor.executeCount, 0);
    assert.deepEqual(callbackEvents, []);
  });
});

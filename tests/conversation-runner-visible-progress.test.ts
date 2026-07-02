import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';
import { VisibleProgressEvent } from '../src/core/visible-progress-types';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function makeToolCall(id: string): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'noop',
      arguments: JSON.stringify({ description: '??????' }),
    },
  };
}

class NoopToolExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'noop',
      description: 'noop',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string' },
        },
      },
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

describe('ConversationRunner visible progress events', () => {
  test('sends pre-tool assistant content to progress sink instead of onThinking', async () => {
    const rawPrelude = '?? bug ??`coupon.value` ??????subtotal 250 ? 0.8 = 200?';
    const responses: ChatResponse[] = [
      {
        content: rawPrelude,
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
      chat: async (): Promise<ChatResponse> => responses.shift()!,
    } as any;
    const thinking: string[] = [];
    const events: VisibleProgressEvent[] = [];
    const toolStarts: string[] = [];
    const toolEnds: string[] = [];
    const runner = new ConversationRunner(aiService, new NoopToolExecutor(), {
      stream: false,
      enableCompression: false,
      visibleProgressEventSink: event => events.push(event),
    });

    await runner.run([{ role: 'user', content: 'fix it' } as Message], {
      onThinking: text => thinking.push(text),
      onToolStart: name => toolStarts.push(name),
      onToolEnd: name => toolEnds.push(name),
    });

    assert.deepEqual(thinking, []);
    assert.equal(events[0].type, 'model_prelude');
    assert.equal(events[0].text, rawPrelude);
    assert.equal(events.some(event => event.type === 'tool_started' && event.toolName === 'noop'), true);
    assert.equal(events.some(event => event.type === 'tool_finished' && event.toolName === 'noop'), true);
    assert.deepEqual(toolStarts, ['noop']);
    assert.deepEqual(toolEnds, ['noop']);
  });

  test('falls back to existing prelude policy when no progress sink exists', async () => {
    const rawPrelude = '??????????';
    const responses: ChatResponse[] = [
      {
        content: rawPrelude,
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
      chat: async (): Promise<ChatResponse> => responses.shift()!,
    } as any;
    const thinking: string[] = [];
    const runner = new ConversationRunner(aiService, new NoopToolExecutor(), {
      stream: false,
      enableCompression: false,
    });

    await runner.run([{ role: 'user', content: 'fix it' } as Message], {
      onThinking: text => thinking.push(text),
    });

    assert.deepEqual(thinking, []);
  });
});

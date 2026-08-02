import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import { SYNTHETIC_OBSERVATION_TOOL_NAME, SyntheticObservation } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';
import { prepareProviderRequestMessages } from '../src/providers/request-preflight';

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

function makeObservation(id = 'memory-ready'): SyntheticObservation {
  return {
    id,
    source: 'memory',
    status: 'completed',
    relevance: 'medium',
    summary: 'A previous turn mentioned the relevant deployment preference.',
    keyFacts: ['Deploy with the existing release script.'],
    recommendedUse: {
      shouldUse: true,
      howToUse: 'Use as background only.',
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

describe('ConversationRunner synthetic observations', () => {
  test('drains completed observations into the current runner turn without duplicate injection', async () => {
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

    let providerCalls = 0;
    const runner = new ConversationRunner(aiService, new NoopToolExecutor(), {
      stream: false,
      enableCompression: false,
      syntheticObservationProvider: () => {
        providerCalls += 1;
        return providerCalls === 2 ? [makeObservation()] : [];
      },
    });

    await runner.run([{ role: 'user', content: 'deploy it' }]);

    assert.equal(received.length, 2);
    assert.equal(
      received[0].some(message => message.__syntheticObservation),
      false,
      'observation is not injected before it is available',
    );

    const injected = received[1].filter(message => message.__syntheticObservation);
    assert.equal(injected.length, 2);
    assert.equal(injected[0].role, 'assistant');
    assert.equal(injected[1].role, 'tool');
    assert.equal(injected[0].tool_calls?.[0].function.name, SYNTHETIC_OBSERVATION_TOOL_NAME);
    assert.equal(injected[1].tool_call_id, injected[0].tool_calls?.[0].id);
    assert.match(String(injected[1].content), /previous turn mentioned/);
    assert.equal(
      received[1].filter(message => message.syntheticObservationId === 'memory-ready').length,
      2,
      'matching synthetic pair is injected exactly once',
    );
  });

  test('keeps equivalent observations from separate loop drains provider-valid and uniquely paired', async () => {
    const received: Message[][] = [];
    const responses: ChatResponse[] = [
      { content: null, toolCalls: [makeToolCall('call_1')], usage },
      { content: null, toolCalls: [makeToolCall('call_2')], usage },
      { content: 'done', toolCalls: [], usage },
    ];
    const aiService = {
      chat: async (messages: Message[]) => {
        received.push(cloneMessages(messages));
        return responses[received.length - 1];
      },
    } as any;
    let providerCalls = 0;
    const runner = new ConversationRunner(aiService, new NoopToolExecutor(), {
      stream: false,
      enableCompression: false,
      syntheticObservationProvider: () => {
        providerCalls += 1;
        if (providerCalls === 1) return [makeObservation('internal-one')];
        if (providerCalls === 2) return [makeObservation('internal-two')];
        return [];
      },
    });

    await runner.run([{ role: 'user', content: 'deploy it' }]);

    const syntheticCalls = received[2]
      .filter(message => message.__syntheticObservation && message.role === 'assistant')
      .map(message => message.tool_calls?.[0].id);
    assert.equal(syntheticCalls.length, 2);
    assert.notEqual(syntheticCalls[0], syntheticCalls[1]);
    assert.equal(prepareProviderRequestMessages(received[2]).summary, undefined);
  });
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ConversationRunner } from '../src/core/conversation-runner';
import { Message } from '../src/types';
import { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function createNoopToolExecutor(): ToolExecutor {
  const noopTool: ToolDefinition = {
    name: 'noop',
    description: 'noop',
    parameters: { type: 'object', properties: {} },
  };

  return {
    getToolDefinitions: () => [noopTool],
    executeTool: async (toolCall: ToolCall): Promise<ToolResult> => ({
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: 'ok',
      ok: true,
    }),
  };
}

describe('ConversationRunner pending input', () => {
  test('continues into the next turn when pending input arrives before final reply is returned', async () => {
    const requests: Message[][] = [];
    const aiService = {
      chat: async (messages: Message[]) => {
        requests.push(messages.map(msg => ({ ...msg })));
        return requests.length === 1
          ? { content: 'first reply', toolCalls: [], usage }
          : { content: 'merged reply', toolCalls: [], usage };
      },
    } as any;

    let pendingUsed = false;
    const runner = new ConversationRunner(aiService, createNoopToolExecutor(), {
      stream: false,
      pendingUserInputProvider: () => {
        if (pendingUsed) return null;
        pendingUsed = true;
        return 'follow-up while busy';
      },
    });

    const result = await runner.run([{ role: 'user', content: 'first question' }]);

    assert.strictEqual(result.response, 'merged reply');
    assert.strictEqual(requests.length, 2);
    assert.ok(requests[1].some(msg => msg.role === 'user' && msg.content === 'follow-up while busy'));
  });

  test('injects pending input identity before the queued user message', async () => {
    const requests: Message[][] = [];
    const aiService = {
      chat: async (messages: Message[]) => {
        requests.push(messages.map(msg => ({ ...msg })));
        return requests.length === 1
          ? { content: 'first reply', toolCalls: [], usage }
          : { content: 'handled queued user', toolCalls: [], usage };
      },
    } as any;

    let pendingUsed = false;
    const runner = new ConversationRunner(aiService, createNoopToolExecutor(), {
      stream: false,
      pendingUserInputProvider: () => {
        if (pendingUsed) return null;
        pendingUsed = true;
        return {
          content: 'B 的补充消息',
          sessionIdentity: {
            schemaVersion: 1,
            sessionId: 'cc_group:grp1',
            legacySessionKey: 'cc_group:grp1',
            sessionType: 'catscompany',
            channel: 'catsco',
            actor: { actorUserId: 'usr8', actorDisplayName: 'Bob', externalUserId: 'usr8' },
            agent: { agentId: 'bot42', agentDisplayName: 'Dev Agent', bodyId: 'device_mac' },
            topic: { topicId: 'grp1', topicType: 'group', channelSeq: 13 },
          },
        };
      },
    });

    const result = await runner.run([{ role: 'user', content: 'A 的原始消息' }]);

    assert.strictEqual(result.response, 'handled queued user');
    assert.strictEqual(requests.length, 2);
    const identityIndex = requests[1].findIndex(msg =>
      msg.role === 'user'
      && typeof msg.content === 'string'
      && msg.content.startsWith('[transient_session_identity]')
    );
    const queuedIndex = requests[1].findIndex(msg => msg.role === 'user' && msg.content === 'B 的补充消息');
    assert.ok(identityIndex >= 0, 'pending identity should be sent to the model');
    assert.ok(identityIndex < queuedIndex, 'pending identity should appear before the queued user message');
    assert.match(String(requests[1][identityIndex].content), /actor: Bob \/ usr8/);
    assert.equal(result.newMessages.some(msg => msg.__transient), false);
  });

  test('adds pending input after a tool turn before asking the model again', async () => {
    const requests: Message[][] = [];
    const aiService = {
      chat: async (messages: Message[]) => {
        requests.push(messages.map(msg => ({ ...msg })));
        if (requests.length === 1) {
          return {
            content: null,
            toolCalls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'noop', arguments: '{}' },
            }],
            usage,
          };
        }
        return { content: 'tool plus pending handled', toolCalls: [], usage };
      },
    } as any;

    let pendingUsed = false;
    const runner = new ConversationRunner(aiService, createNoopToolExecutor(), {
      stream: false,
      pendingUserInputProvider: () => {
        if (pendingUsed) return null;
        pendingUsed = true;
        return 'new query after tool turn';
      },
    });

    const result = await runner.run([{ role: 'user', content: 'run a tool' }]);

    assert.strictEqual(result.response, 'tool plus pending handled');
    assert.strictEqual(requests.length, 2);
    assert.ok(requests[1].some(msg => msg.role === 'tool' && msg.content === 'ok'));
    assert.ok(requests[1].some(msg => msg.role === 'user' && msg.content === 'new query after tool turn'));
  });
});

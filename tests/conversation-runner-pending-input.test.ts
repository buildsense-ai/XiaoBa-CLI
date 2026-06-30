import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TRANSIENT_RUNTIME_CONTEXT_PREFIX } from '../src/core/runtime-context-builder';
import { TRANSIENT_PENDING_USER_INPUT_PREFIX } from '../src/core/pending-user-input-boundary';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { Message } from '../src/types';
import type { ExecutionScope, ScopedDeviceGrant, ScopedLocalFileGrant } from '../src/types/session-identity';
import { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function scope(): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'cc_user:usr7',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    permissionsSource: 'metadata.catsco_identity',
    identityTrust: 'server_canonical',
    isTrusted: true,
  };
}

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

function grant(filePath: string): ScopedLocalFileGrant {
  const now = Date.now();
  return {
    kind: 'catscompany_attachment',
    source: 'catscompany',
    attachmentRef: `catsco_attachment:${filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'file'}`,
    filePath,
    fileName: filePath.split(/[\\/]/).pop() || 'file.txt',
    fileType: 'file',
    size: 1,
    mtimeMs: now,
    sessionKey: 'cc_user:usr7',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    deviceBodyId: 'body-main',
    identityTrust: 'server_canonical',
    operations: ['read_file', 'send_file'],
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

function deviceGrant(deviceId: string): ScopedDeviceGrant {
  const now = Date.now();
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: `device_grant:${deviceId}`,
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'metadata.catsco_identity',
    deviceId,
    deviceDisplayName: deviceId,
    deviceBodyId: 'body-main',
    deviceInstallationId: `install:${deviceId}`,
    ownerUserId: 'usr7',
    sessionKey: 'cc_user:usr7',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    operations: ['read_file'],
    createdAt: now,
    expiresAt: now + 60_000,
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
    assertPendingBoundaryBeforeUser(requests[1], 'follow-up while busy');
  });

  test('marks pending input with the active episode metadata', async () => {
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
      episodeId: 'episode:test',
      pendingUserInputProvider: () => {
        if (pendingUsed) return null;
        pendingUsed = true;
        return 'follow-up while busy';
      },
    });

    await runner.run([{
      role: 'user',
      content: 'first question',
      __episodeId: 'episode:test',
      __episodeInputKind: 'root',
    }]);

    const root = requests[1].find(msg => msg.role === 'user' && msg.content === 'first question');
    const pending = requests[1].find(msg => msg.role === 'user' && msg.content === 'follow-up while busy');
    assert.equal(root?.__episodeId, 'episode:test');
    assert.equal(root?.__episodeInputKind, 'root');
    assert.equal(pending?.__episodeId, 'episode:test');
    assert.equal(pending?.__episodeInputKind, 'pending');
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
    assertPendingBoundaryBeforeUser(requests[1], 'new query after tool turn');
  });

  test('does not persist pending input boundary in durable history', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'base system' },
      { role: 'system', content: `${TRANSIENT_PENDING_USER_INPUT_PREFIX}\nlatest message wins` },
      { role: 'user', content: 'follow-up while busy' },
    ];

    const durable = new TurnContextBuilder().removeTransientMessages(messages);

    assert.deepEqual(durable, [
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'follow-up while busy' },
    ]);
  });

  test('merges pending local file grants into later tool execution context without clearing existing grants', async () => {
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
        if (requests.length === 2) {
          return {
            content: null,
            toolCalls: [{
              id: 'call_2',
              type: 'function',
              function: { name: 'noop', arguments: '{}' },
            }],
            usage,
          };
        }
        return { content: 'done', toolCalls: [], usage };
      },
    } as any;
    const contexts: Array<Partial<ToolExecutionContext> | undefined> = [];
    const executor: ToolExecutor = {
      getToolDefinitions: () => [{
        name: 'noop',
        description: 'noop',
        parameters: { type: 'object', properties: {} },
      }],
      executeTool: async (toolCall, _history, contextOverrides) => {
        contexts.push(contextOverrides);
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: 'ok',
          ok: true,
        };
      },
    };

    let pendingUsed = false;
    const initialGrant = grant('tmp/downloads/initial.md');
    const pendingGrant = grant('tmp/downloads/pending.md');
    const runner = new ConversationRunner(aiService, executor, {
      stream: false,
      toolExecutionContext: {
        localFileGrants: [initialGrant],
      },
      pendingUserInputProvider: () => {
        if (pendingUsed) return null;
        pendingUsed = true;
        return {
          content: 'new attachment while busy',
          localFileGrants: [pendingGrant],
        };
      },
    });

    const result = await runner.run([{ role: 'user', content: 'run a tool' }]);

    assert.equal(result.response, 'done');
    assert.equal(contexts.length, 2);
    assert.deepEqual(contexts[0]?.localFileGrants, [initialGrant]);
    assert.deepEqual(contexts[1]?.localFileGrants, [initialGrant, pendingGrant]);
  });

  test('merges pending device grants into later tool execution context without clearing existing grants', async () => {
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
        if (requests.length === 2) {
          return {
            content: null,
            toolCalls: [{
              id: 'call_2',
              type: 'function',
              function: { name: 'noop', arguments: '{}' },
            }],
            usage,
          };
        }
        return { content: 'done', toolCalls: [], usage };
      },
    } as any;
    const contexts: Array<Partial<ToolExecutionContext> | undefined> = [];
    const executor: ToolExecutor = {
      getToolDefinitions: () => [{
        name: 'noop',
        description: 'noop',
        parameters: { type: 'object', properties: {} },
      }],
      executeTool: async (toolCall, _history, contextOverrides) => {
        contexts.push(contextOverrides);
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: 'ok',
          ok: true,
        };
      },
    };

    let pendingUsed = false;
    const initialGrant = deviceGrant('device-initial');
    const pendingGrant = deviceGrant('device-pending');
    const runner = new ConversationRunner(aiService, executor, {
      stream: false,
      toolExecutionContext: {
        sessionId: 'cc_user:usr7',
        surface: 'catscompany',
        executionScope: scope(),
        deviceGrants: [initialGrant],
      },
      pendingUserInputProvider: () => {
        if (pendingUsed) return null;
        pendingUsed = true;
        return {
          content: 'new device grant while busy',
          deviceGrants: [pendingGrant],
        };
      },
    });

    const result = await runner.run([{ role: 'user', content: 'run a tool' }]);

    assert.equal(result.response, 'done');
    assert.equal(contexts.length, 2);
    assert.deepEqual(contexts[0]?.deviceGrants, [initialGrant]);
    assert.deepEqual(contexts[1]?.deviceGrants, [initialGrant, pendingGrant]);

    const refreshedContext = requests[1].find(isRuntimeContextMessage);
    assert.ok(refreshedContext);
    const refreshedContent = String(refreshedContext.content || '');
    assert.match(refreshedContent, /规则：/);
    assert.doesNotMatch(refreshedContent, /device-initial/);
    assert.doesNotMatch(refreshedContent, /device-pending/);
    assert.doesNotMatch(refreshedContext.content as string, /install:device-/);
    assert.doesNotMatch(refreshedContext.content as string, /body-main/);
  });
});

function isRuntimeContextMessage(message: Message): boolean {
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX);
}

function assertPendingBoundaryBeforeUser(messages: Message[], userContent: string): void {
  const boundaryIndex = messages.findIndex(message =>
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_PENDING_USER_INPUT_PREFIX)
  );
  const userIndex = messages.findIndex(message =>
    message.role === 'user'
    && message.content === userContent
  );

  assert.ok(boundaryIndex >= 0, 'pending boundary should be sent before merged input');
  assert.ok(userIndex >= 0, 'pending user input should be sent');
  assert.equal(boundaryIndex + 1, userIndex);
}

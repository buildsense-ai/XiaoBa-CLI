import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TRUNCATED_READ_FILE_PREFIX } from '../src/core/read-file-message-folder';
import type { ChatResponse, Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const longReadOutput = ['File: /repo/a.ts', 'Path: /repo/a.ts', '', '1→ const value = 1;\n'.repeat(2500)].join('\n');

function cloneMessages(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages));
}

function toolCall(id: string, name = 'Read'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

class ReadExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [
      { name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } },
      { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } },
    ];
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    return {
      tool_call_id: call.id,
      role: 'tool',
      name: call.function.name,
      content: call.function.name === 'Read' ? longReadOutput : 'ok',
      ok: true,
    };
  }
}

function makeRunner(aiService: any, workspaceRoot: string): ConversationRunner {
  return new ConversationRunner(aiService, new ReadExecutor(), {
    stream: false,
    enableCompression: false,
    toolExecutionContext: {
      workingDirectory: workspaceRoot,
      workspaceRoot,
      sessionId: 'stable-prefix-test',
    } as any,
  });
}

function stableRead(messages: Message[]): Message {
  const result = messages.find(message => message.role === 'tool' && message.name === 'Read');
  assert.ok(result);
  return result;
}

test('keeps a tool result byte-identical across subsequent provider calls', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prefix-stable-'));
  try {
    const received: Message[][] = [];
    const responses: ChatResponse[] = [
      { content: null, toolCalls: [toolCall('read_1')], usage },
      { content: null, toolCalls: [toolCall('noop_1', 'noop')], usage },
      { content: 'done', toolCalls: [], usage },
    ];
    const aiService = {
      chat: async (messages: Message[]) => {
        received.push(cloneMessages(messages));
        return responses[received.length - 1];
      },
    } as any;

    await makeRunner(aiService, workspace).run([{ role: 'user', content: 'inspect it' }]);

    assert.equal(received.length, 3);
    const second = stableRead(received[1]);
    const third = stableRead(received[2]);
    assert.equal(second.__toolResultStable, true);
    assert.ok(String(second.content).startsWith(TRUNCATED_READ_FILE_PREFIX));
    assert.match(String(second.content), /full_output_ref:/);
    assert.equal(third.content, second.content);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('stabilizes caller-owned partial history before a provider failure', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prefix-error-'));
  try {
    let calls = 0;
    const aiService = {
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return { content: null, toolCalls: [toolCall('read_1')], usage };
        }
        throw new Error('provider unavailable');
      },
    } as any;
    const messages: Message[] = [{ role: 'user', content: 'inspect it' }];

    await assert.rejects(makeRunner(aiService, workspace).run(messages), /provider unavailable/);

    const persisted = stableRead(messages);
    assert.equal(persisted.__toolResultStable, true);
    assert.ok(String(persisted.content).startsWith(TRUNCATED_READ_FILE_PREFIX));
    assert.match(String(persisted.content), /full_output_ref:/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

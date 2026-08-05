import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
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

test('keeps the full tool result when no artifact root is available', async () => {
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
  const runner = new ConversationRunner(aiService, new ReadExecutor(), {
    stream: false,
    enableCompression: false,
    // Mirrors BaseAgent: it has a session identity but no workspace root.
    toolExecutionContext: { sessionId: 'base-agent-without-workspace' } as any,
  });

  await assert.rejects(runner.run(messages), /provider unavailable/);

  const persisted = stableRead(messages);
  assert.equal(persisted.__toolResultStable, true);
  assert.equal(persisted.content, longReadOutput);
});

test('keeps the full tool result when artifact persistence fails', async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-artifact-write-failure-'));
  const artifactRoot = path.join(tempDirectory, 'not-a-directory');
  const previousArtifactDirectory = process.env.XIAOBA_TOOL_RESULT_ARTIFACT_DIR;
  const previousArtifactsEnabled = process.env.XIAOBA_TOOL_RESULT_ARTIFACTS;
  fs.writeFileSync(artifactRoot, 'not a directory');
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
  const runner = new ConversationRunner(aiService, new ReadExecutor(), {
    stream: false,
    enableCompression: false,
    toolExecutionContext: { sessionId: 'artifact-write-failure' } as any,
  });

  try {
    process.env.XIAOBA_TOOL_RESULT_ARTIFACTS = 'true';
    process.env.XIAOBA_TOOL_RESULT_ARTIFACT_DIR = artifactRoot;

    await assert.rejects(runner.run(messages), /provider unavailable/);

    const persisted = stableRead(messages);
    assert.equal(persisted.__toolResultStable, true);
    assert.equal(persisted.content, longReadOutput);
  } finally {
    if (previousArtifactDirectory === undefined) {
      delete process.env.XIAOBA_TOOL_RESULT_ARTIFACT_DIR;
    } else {
      process.env.XIAOBA_TOOL_RESULT_ARTIFACT_DIR = previousArtifactDirectory;
    }
    if (previousArtifactsEnabled === undefined) {
      delete process.env.XIAOBA_TOOL_RESULT_ARTIFACTS;
    } else {
      process.env.XIAOBA_TOOL_RESULT_ARTIFACTS = previousArtifactsEnabled;
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('replaces a corrupt artifact before folding a tool result', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-corrupt-artifact-'));
  const sessionId = 'corrupt-artifact';
  const hash = createHash('sha256')
    .update('/repo/a.ts')
    .update('\0')
    .update(longReadOutput)
    .digest('hex');
  const artifactPath = path.join(
    workspace,
    '.xiaoba',
    'tool-results',
    sessionId,
    `rf_${hash.slice(0, 16)}.txt`,
  );
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'partial artifact');
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
  const runner = new ConversationRunner(aiService, new ReadExecutor(), {
    stream: false,
    enableCompression: false,
    toolExecutionContext: {
      workingDirectory: workspace,
      workspaceRoot: workspace,
      sessionId,
    } as any,
  });

  try {
    await assert.rejects(runner.run(messages), /provider unavailable/);

    const persisted = stableRead(messages);
    assert.ok(String(persisted.content).startsWith(TRUNCATED_READ_FILE_PREFIX));
    assert.equal(
      fs.readFileSync(artifactPath, 'utf8'),
      ['tool_name: read_file', `sha256: ${hash}`, longReadOutput].join('\n'),
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

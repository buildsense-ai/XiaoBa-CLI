import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConversationRunner } from '../src/core/conversation-runner';
import type { ChatResponse, Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
      },
    },
  };
}

function makeToolCall(): ToolCall {
  return {
    id: 'call_trace_read',
    type: 'function',
    function: {
      name: 'read_file',
      arguments: JSON.stringify({
        file_path: 'secret.txt',
        token: 'sk-traceargumentsecret',
      }),
    },
  };
}

class TraceToolExecutor implements ToolExecutor {
  readonly tools = [tool('read_file')];

  getToolDefinitions(): ToolDefinition[] {
    return this.tools;
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      ok: true,
      content: 'file content with sk-toolresultsecret and enough context',
    };
  }
}

function createTraceAI() {
  let calls = 0;
  return {
    getConfig() {
      return {
        provider: 'openai',
        model: 'MiniMax-M2.7',
        apiUrl: 'https://user:pass@example.test/v1/chat/completions?api_key=sk-urlsecret',
        contextWindowTokens: 128000,
      };
    },
    isToolCallingSupported() {
      return true;
    },
    async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
      calls++;
      if (calls === 1) {
        return {
          content: 'I will inspect it with token sk-responsepreamble',
          toolCalls: [makeToolCall()],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        };
      }
      return {
        content: 'done without leaking sk-finalresponsesecret',
        toolCalls: [],
        usage: { promptTokens: 120, completionTokens: 10, totalTokens: 130 },
      };
    },
  };
}

test('prompt trace records summarized prompt, response, and tool result without leaking secrets', async () => {
  const originalTrace = process.env.XIAOBA_PROMPT_TRACE;
  const originalTraceDir = process.env.XIAOBA_PROMPT_TRACE_DIR;
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-trace-'));
  process.env.XIAOBA_PROMPT_TRACE = 'true';
  process.env.XIAOBA_PROMPT_TRACE_DIR = traceDir;

  try {
    const runner = new ConversationRunner(
      createTraceAI() as any,
      new TraceToolExecutor(),
      {
        stream: true,
        enableCompression: false,
        toolExecutionContext: {
          sessionId: 'prompt-trace:test',
          surface: 'cli',
          workingDirectory: traceDir,
          workspaceRoot: traceDir,
          getCurrentDirectory: () => traceDir,
        },
      },
    );

    await runner.run([{ role: 'user', content: '读取 secret.txt，里面可能有 sk-usersecret' }]);

    const entries = readTraceEntries(traceDir);
    assert.equal(entries.filter(entry => entry.entry_type === 'prompt_trace_request').length, 2);
    assert.equal(entries.filter(entry => entry.entry_type === 'prompt_trace_response').length, 2);
    assert.equal(entries.filter(entry => entry.entry_type === 'prompt_trace_tool_result').length, 1);

    const firstRequest = entries.find(entry => entry.entry_type === 'prompt_trace_request');
    assert.equal(firstRequest.tools.count, 1);
    assert.deepEqual(firstRequest.tools.names, ['read_file']);
    assert.equal(firstRequest.model.api_url, 'https://example.test/v1/chat/completions');
    assert.ok(firstRequest.prompt.transient_prefixes['[transient_current_directory]']);
    assert.ok(firstRequest.prompt.transient_prefixes['[transient_tool_guidance]']);

    const serialized = JSON.stringify(entries);
    assert.doesNotMatch(serialized, /sk-usersecret/);
    assert.doesNotMatch(serialized, /sk-urlsecret/);
    assert.doesNotMatch(serialized, /sk-responsepreamble/);
    assert.doesNotMatch(serialized, /sk-traceargumentsecret/);
    assert.doesNotMatch(serialized, /sk-toolresultsecret/);
    assert.doesNotMatch(serialized, /sk-finalresponsesecret/);
  } finally {
    restoreEnv('XIAOBA_PROMPT_TRACE', originalTrace);
    restoreEnv('XIAOBA_PROMPT_TRACE_DIR', originalTraceDir);
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
});

test('prompt trace stays silent when disabled', async () => {
  const originalTrace = process.env.XIAOBA_PROMPT_TRACE;
  const originalTraceDir = process.env.XIAOBA_PROMPT_TRACE_DIR;
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-trace-off-'));
  delete process.env.XIAOBA_PROMPT_TRACE;
  process.env.XIAOBA_PROMPT_TRACE_DIR = traceDir;

  try {
    const runner = new ConversationRunner(
      createTraceAI() as any,
      new TraceToolExecutor(),
      {
        stream: true,
        enableCompression: false,
        toolExecutionContext: {
          sessionId: 'prompt-trace:off',
          surface: 'cli',
          workingDirectory: traceDir,
          workspaceRoot: traceDir,
          getCurrentDirectory: () => traceDir,
        },
      },
    );

    await runner.run([{ role: 'user', content: '读取 secret.txt' }]);
    assert.deepEqual(listFiles(traceDir), []);
  } finally {
    restoreEnv('XIAOBA_PROMPT_TRACE', originalTrace);
    restoreEnv('XIAOBA_PROMPT_TRACE_DIR', originalTraceDir);
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
});

function readTraceEntries(root: string): any[] {
  return listFiles(root)
    .flatMap(file => fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean))
    .map(line => JSON.parse(line));
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

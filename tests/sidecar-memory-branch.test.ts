import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function makeToolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

class MemoryBranchAI {
  calls: Message[][] = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const lastTool = [...messages].reverse().find(message => message.role === 'tool');
    if (!lastTool) {
      return {
        content: null,
        toolCalls: [makeToolCall('search_1', 'memory_search', {
          keywords: ['dashboard_unique_memory', 'compact_filter_unique'],
        })],
        usage,
      };
    }

    const searchResult = JSON.parse(String(lastTool.content));
    const ref = searchResult.matches[0].ref;
    return {
      content: null,
      toolCalls: [makeToolCall('finish_1', 'finish_memory_search', {
        summary: 'Prior memory says dashboard filters should stay compact.',
        refs: [ref],
      })],
      usage,
    };
  }
}

class NoInjectMemoryBranchAI {
  calls: Message[][] = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: null,
      toolCalls: [makeToolCall('finish_1', 'finish_memory_search', {
        summary: 'No extra memory worth injecting.',
        refs: [],
        inject: false,
      })],
      usage,
    };
  }
}

describe('memory sidecar branch', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-memory-sidecar-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('searches local session logs and publishes a memory observation', async () => {
    const sessionDir = path.join(testRoot, 'logs', 'sessions', 'chat', '2026-06-09');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'demo.jsonl'),
      JSON.stringify({
        entry_type: 'turn',
        turn: 4,
        timestamp: '2026-06-09T10:00:00.000Z',
        session_id: 'chat:demo',
        session_type: 'chat',
        user: { text: 'dashboard_unique_memory compact_filter_unique preference' },
        assistant: {
          text: 'Decision: keep dashboard filters compact and avoid a large hero panel.',
          tool_calls: [],
        },
        tokens: { prompt: 1, completion: 1 },
      }) + '\n',
      'utf-8',
    );

    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new MemoryBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      input: 'what did we decide about dashboard filters?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    await handle.done;
    const observations = queue.drain();

    assert.equal(observations.length, 1);
    assert.equal(observations[0].source, 'memory');
    assert.equal(observations[0].status, 'completed');
    assert.match(observations[0].summary, /dashboard filters/);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.equal(injected.source, 'memory');
    assert.equal(injected.summary, 'Prior memory says dashboard filters should stay compact.');
    assert.deepEqual(injected.refs, ['chat/2026-06-09/demo.jsonl#1']);
    assert.equal(aiService.calls.length, 2);
  });

  test('suppresses observations when branch finishes with inject false', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new NoInjectMemoryBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      input: 'quick question with no useful prior memory',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    assert.equal(aiService.calls.length, 1);
    assert.match(readBranchLogs(testRoot), /suppressed_observation/);
  });

  test('cancelled branch does not publish late memory observations', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = {
      isToolCallingSupported: () => true,
      chat: (_messages: Message[], _tools?: ToolDefinition[], options?: { signal?: AbortSignal }) => {
        return new Promise<ChatResponse>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    };

    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      input: 'quick question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    handle.cancel();
    await handle.done;
    assert.equal(queue.drain().length, 0);
  });
});

function readBranchLogs(root: string): string {
  const branchRoot = path.join(root, 'logs', 'branches', 'memory');
  if (!fs.existsSync(branchRoot)) return '';
  const chunks: string[] = [];
  for (const dateDir of fs.readdirSync(branchRoot)) {
    const fullDateDir = path.join(branchRoot, dateDir);
    for (const fileName of fs.readdirSync(fullDateDir)) {
      chunks.push(fs.readFileSync(path.join(fullDateDir, fileName), 'utf-8'));
    }
  }
  return chunks.join('\n');
}

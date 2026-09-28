import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type { CatscoBranchQuery, CatscoBranchResponse } from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

const LOCAL_TOOLS = ['memory_search', 'memory_read_turn', 'memory_neighbors', 'finish_memory_search'];
const FULL_TOOLS = [...LOCAL_TOOLS.slice(0, 3), 'catslog_branch', 'finish_memory_search'];

class RemoteBranchAI {
  calls: Message[][] = [];
  toolNames: string[] = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    this.toolNames = tools?.map(tool => tool.name) || [];
    const lastTool = [...messages].reverse().find(message => message.role === 'tool');
    if (!lastTool) {
      return {
        content: null,
        toolCalls: [call('branch-1', 'catslog_branch', {
          query_text: 'release checklist',
        })],
        usage,
      };
    }
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: 'CatsLog returned a relevant release decision.',
        refs: ['stream-release#17'],
        inject: true,
        delivery: 'context',
      })],
      usage,
    };
  }
}

class FakeRemoteMemory implements CatsLogMemoryBackend {
  async branch(_query: CatscoBranchQuery): Promise<CatscoBranchResponse> {
    return {
      content_trust: 'untrusted_branch_evidence',
      branches: [{
        source: 'session_graph',
        status: 'ok',
        items: [{
          source: 'session',
          ref: 'stream-release#17',
          kind: 'session_turn',
          text: 'release decision: keep nginx read-only mount',
          score_hint: 0.9,
        }],
      }],
    };
  }
}

class ToggleRemoteMemory extends FakeRemoteMemory {
  available = false;

  isAvailable(): boolean {
    return this.available;
  }
}

class ThrowingAvailabilityMemory extends FakeRemoteMemory {
  isAvailable(): boolean {
    throw new Error('corrupt capability state');
  }
}

class FinishOnlyBranchAI {
  toolNames: string[] = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.toolNames = tools?.map(tool => tool.name) || [];
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: 'no additional memory',
        refs: [],
        inject: false,
      })],
      usage,
    };
  }
}

class ToggleDuringBranchAI {
  calls: Array<{ toolNames: string[]; messages: Message[] }> = [];
  private turn = 0;

  constructor(private readonly backend: ToggleRemoteMemory) {}

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push({
      toolNames: tools?.map(tool => tool.name) || [],
      messages: JSON.parse(JSON.stringify(messages)),
    });
    if (this.turn++ === 0) {
      this.backend.available = true;
      return { content: 'capability changed while this branch was running', toolCalls: [], usage };
    }
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: 'remote capability was refreshed',
        refs: [],
        inject: false,
      })],
      usage,
    };
  }
}

describe('CatsLog memory branch integration', () => {
  test('exposes the thin tool surface and publishes an observed citation', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new RemoteBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-memory-test',
      input: 'what is our release checklist?',
      recentMessages: [],
      workingDirectory: '/tmp/xiaoba-catslog-memory-branch',
      aiService: ai as any,
      queue,
      catslogMemory: new FakeRemoteMemory(),
      logEnabled: false,
    });

    await handle.done;
    const observations = queue.drain();
    assert.equal(observations.length, 1);
    assert.deepEqual(ai.toolNames, FULL_TOOLS);
    assert.match(ai.calls[0].find(message => message.role === 'system')?.content as string, /catslog_branch/);
    assert.match(
      ai.calls[0].find(message => message.role === 'system')?.content as string,
      /一次收窄 refine/,
    );
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual(injected.refs, ['stream-release#17']);
    assert.equal(injected.summary.includes('release decision'), true);
  });

  test('re-checks remote capability per branch turn without leaking unavailable tools', async () => {
    const backend = new ToggleRemoteMemory();
    const firstAI = new FinishOnlyBranchAI();
    const firstQueue = new InMemorySyntheticObservationQueue();
    const first = startMemorySidecarBranch({
      sessionKey: 'remote-memory-unavailable',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: '/tmp/xiaoba-catslog-memory-branch',
      aiService: firstAI as any,
      queue: firstQueue,
      catslogMemory: backend,
      logEnabled: false,
    });
    await first.done;
    assert.deepEqual(firstAI.toolNames, LOCAL_TOOLS);

    backend.available = true;
    const secondAI = new FinishOnlyBranchAI();
    const secondQueue = new InMemorySyntheticObservationQueue();
    const second = startMemorySidecarBranch({
      sessionKey: 'remote-memory-available',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: '/tmp/xiaoba-catslog-memory-branch',
      aiService: secondAI as any,
      queue: secondQueue,
      catslogMemory: backend,
      logEnabled: false,
    });
    await second.done;
    assert.deepEqual(secondAI.toolNames, FULL_TOOLS);
  });

  test('fails closed when remote capability discovery throws', async () => {
    const ai = new FinishOnlyBranchAI();
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-memory-discovery-error',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: '/tmp/xiaoba-catslog-memory-branch',
      aiService: ai as any,
      queue,
      catslogMemory: new ThrowingAvailabilityMemory(),
      logEnabled: false,
    });

    await handle.done;
    assert.deepEqual(ai.toolNames, LOCAL_TOOLS);
  });

  test('keeps the prompt and tool surface aligned when capability appears mid-branch', async () => {
    const backend = new ToggleRemoteMemory();
    const ai = new ToggleDuringBranchAI(backend);
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-memory-mid-branch-login',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: '/tmp/xiaoba-catslog-memory-branch',
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;
    assert.deepEqual(ai.calls.map(call => call.toolNames), [LOCAL_TOOLS, FULL_TOOLS]);
    assert.equal(ai.calls[1].messages.some(message => (
      message.role === 'system' && message.content.includes('在本轮已可用')
    )), true);
  });

  test('removes remote tools and tells the branch when capability is revoked mid-branch', async () => {
    const backend = new ToggleRemoteMemory();
    backend.available = true;
    const ai = new ToggleDuringBranchAI(backend);
    const originalChat = ai.chat.bind(ai);
    ai.chat = async (messages, tools) => {
      const result = await originalChat(messages, tools);
      if (ai.calls.length === 1) backend.available = false;
      return result;
    };
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-memory-mid-branch-revocation',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: '/tmp/xiaoba-catslog-memory-branch',
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;
    assert.equal(ai.calls[0].toolNames.includes('catslog_branch'), true);
    assert.deepEqual(ai.calls[1].toolNames, LOCAL_TOOLS);
    assert.equal(ai.calls[1].messages.some(message => (
      message.role === 'system' && message.content.includes('不可用')
    )), true);
  });
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type {
  CatscoMemoryRecallQuery,
  CatscoMemoryRecallResponse,
  CatscoSkillMemoryQuery,
  CatscoSkillMemoryResponse,
} from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

class RemoteMemoryBranchAI {
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
        toolCalls: [call('skill-1', 'catslog_skill_memory', {
          task: 'release checklist',
          include_content: true,
        })],
        usage,
      };
    }
    const result = JSON.parse(String(lastTool.content));
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: 'CatsLog returned a relevant release skill.',
        refs: [result.items[0].ref],
      })],
      usage,
    };
  }
}

class FakeRemoteMemory implements CatsLogMemoryBackend {
  async retrieveSkillMemory(_query: CatscoSkillMemoryQuery): Promise<CatscoSkillMemoryResponse> {
    return {
      content_trust: 'untrusted_runtime_memory',
      items: [{ handle: 'release-playbook', revision: 3, content: 'untrusted body' }],
      graph: {
        catalog_revision: 1,
        nodes: [{ handle: 'release-playbook', revision: 3, active: true, status: 'published' }],
        edges: [],
      },
    };
  }

  async recallMemory(_query: CatscoMemoryRecallQuery): Promise<CatscoMemoryRecallResponse> {
    return { session_available: true, session: { records: [] }, notes: [] };
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
  test('adds remote Skill Memory tools only to the branch and publishes a citation', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new RemoteMemoryBranchAI();
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
    assert.deepEqual(ai.toolNames, [
      'memory_search',
      'memory_read_turn',
      'memory_neighbors',
      'catslog_skill_catalog',
      'catslog_skill_graph',
      'catslog_skill_memory',
      'catslog_session_query',
      'catslog_session_recall',
      'finish_memory_search',
    ]);
    assert.match(ai.calls[0].find(message => message.role === 'system')?.content as string, /catslog_skill_memory/);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.equal(injected.refs[0], 'catslog:skill:release-playbook@3');
    assert.equal(injected.provenance.bodyReadCount, 1);
    assert.equal(injected.provenance.receiptState, 'inferred_from_body_read');
    assert.equal(injected.provenance.toolsUsed.includes('catslog_skill_memory'), true);
    assert.equal(JSON.stringify(injected).includes('retrieval_receipt'), false);
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
    assert.deepEqual(firstAI.toolNames, [
      'memory_search', 'memory_read_turn', 'memory_neighbors', 'finish_memory_search',
    ]);

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
    assert.deepEqual(secondAI.toolNames, [
      'memory_search', 'memory_read_turn', 'memory_neighbors',
      'catslog_skill_catalog', 'catslog_skill_graph', 'catslog_skill_memory',
      'catslog_session_query', 'catslog_session_recall', 'finish_memory_search',
    ]);
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
    assert.deepEqual(ai.toolNames, [
      'memory_search', 'memory_read_turn', 'memory_neighbors', 'finish_memory_search',
    ]);
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
    assert.deepEqual(ai.calls.map(call => call.toolNames), [
      ['memory_search', 'memory_read_turn', 'memory_neighbors', 'finish_memory_search'],
      [
        'memory_search', 'memory_read_turn', 'memory_neighbors',
        'catslog_skill_catalog', 'catslog_skill_graph', 'catslog_skill_memory',
        'catslog_session_query', 'catslog_session_recall', 'finish_memory_search',
      ],
    ]);
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
    assert.equal(ai.calls[0].toolNames.includes('catslog_skill_memory'), true);
    assert.deepEqual(ai.calls[1].toolNames, [
      'memory_search', 'memory_read_turn', 'memory_neighbors', 'finish_memory_search',
    ]);
    assert.equal(ai.calls[1].messages.some(message => (
      message.role === 'system' && message.content.includes('不可用')
    )), true);
  });
});

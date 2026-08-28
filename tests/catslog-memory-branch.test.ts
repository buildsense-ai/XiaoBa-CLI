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
    };
  }

  async recallMemory(_query: CatscoMemoryRecallQuery): Promise<CatscoMemoryRecallResponse> {
    return { session_available: true, session: { records: [] }, notes: [] };
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
    assert.equal(JSON.parse(observations[0].formattedContent || '').refs[0], 'catslog:skill:release-playbook@3');
  });
});

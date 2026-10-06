import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type { CatscoBranchQuery, CatscoBranchResponse } from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const OBSERVED_REF = 'stream-release#17';

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

class RemoteEvidenceMemory implements CatsLogMemoryBackend {
  async branch(_query: CatscoBranchQuery): Promise<CatscoBranchResponse> {
    return {
      schema_version: 1,
      content_trust: 'untrusted_branch_evidence',
      request_id: 'req-finish-contract',
      status: 'ok',
      branches: [
        {
          source: 'session_graph',
          status: 'ok',
          items: [{
            source: 'session',
            ref: OBSERVED_REF,
            kind: 'session_turn',
            text: 'release decision: keep nginx read-only mount',
            score_hint: 0.9,
          }],
        },
      ],
    };
  }
}

/**
 * Finish-contract fake: turn 1 assesses, turn 2 attempts an honest but
 * over-cap finish, turn 3 retries after the structured cap error with an
 * honest detail_needed marker. Any fourth call is a pipeline violation.
 */
class VerboseThenDetailNeededAI {
  calls: Array<{ toolNames: string[]; tools: ToolDefinition[]; messages: Message[] }> = [];
  sawCapError = false;
  retrySummary = [
    '结论：release 决策为 keep nginx read-only；时间状态不明，详见证据包。',
    '补充说明。'.repeat(120),
  ].join('');

  isToolCallingSupported(): boolean {
    return true;
  }

  evidencePackIn(messages: Message[]): any | undefined {
    const pack = [...messages].reverse().find(message => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('evidence_pack')
    ));
    if (!pack || typeof pack.content !== 'string') return undefined;
    try {
      return JSON.parse(pack.content);
    } catch {
      return undefined;
    }
  }

  evidencePackRefs(messages: Message[]): string[] {
    const pack = this.evidencePackIn(messages);
    if (!pack) return [];
    return [
      ...(pack.evidence_pack?.remote_branch?.branches || [])
        .flatMap((branch: any) => (branch.items || []).map((item: any) => item.ref)),
      ...(pack.evidence_pack?.session_records?.records || [])
        .flatMap((record: any) => record.type === 'session_turn_group' ? record.refs || [] : [record.ref]),
      ...(pack.evidence_pack?.local_knowledge?.entries || []).map((entry: any) => entry.ref),
    ].filter((ref: unknown) => typeof ref === 'string');
  }

  systemPrompt(): string {
    const system = this.calls[0]?.messages.find(message => message.role === 'system');
    return typeof system?.content === 'string' ? system.content : '';
  }

  toolResultTexts(messages: Message[]): string[] {
    return messages
      .filter(message => message.role === 'tool')
      .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push({
      toolNames: tools?.map(tool => tool.name) || [],
      tools: JSON.parse(JSON.stringify(tools || [])),
      messages: JSON.parse(JSON.stringify(messages)),
    });
    if (this.calls.length === 1) {
      return {
        content: null,
        toolCalls: [call('assess-1', 'assess_memory_need', {
          action: 'recall',
          query_text: 'release decision',
          keywords: ['release', 'nginx'],
        })],
        usage,
      };
    }
    if (this.calls.length === 2) {
      // Honest content, but over the concise cap (445 code points).
      const overCapSummary = `详细记录：${'证据'.repeat(220)}`;
      assert.ok(codePointLength(overCapSummary) > 400);
      return {
        content: null,
        toolCalls: [call('finish-1', 'finish_memory_search', {
          summary: overCapSummary,
          refs: this.evidencePackRefs(messages).slice(0, 1),
          inject: true,
          delivery: 'context',
        })],
        usage,
      };
    }
    // The rejected attempt must come back as a structured validation error the
    // model can act on — never a silent truncation, never a dead end.
    this.sawCapError = this.toolResultTexts(messages).some(text => (
      text.includes('summary must be at most 400 Unicode code points (got 445)')
      && text.includes('detail_needed')
    ));
    return {
      content: null,
      toolCalls: [call('finish-2', 'finish_memory_search', {
        summary: this.retrySummary,
        refs: [OBSERVED_REF],
        inject: true,
        delivery: 'context',
        detail_needed: true,
      })],
      usage,
    };
  }
}

function startBranch(ai: VerboseThenDetailNeededAI, queue: InMemorySyntheticObservationQueue) {
  return startMemorySidecarBranch({
    sessionKey: 'finish-contract-slim',
    input: 'recall the release decision',
    recentMessages: [],
    workingDirectory: process.cwd(),
    aiService: ai as any,
    queue,
    catslogMemory: new RemoteEvidenceMemory(),
    logEnabled: false,
  });
}

describe('MemorySearchBranchSession concise finish contract', () => {
  test('system prompt carries the concise delivery contract without dropping conflict/freshness rules', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new VerboseThenDetailNeededAI();
    const handle = startBranch(ai, queue);
    await handle.done;

    const prompt = ai.systemPrompt();
    assert.match(prompt, /summary 写法（简短交付契约）/);
    assert.match(prompt, /不超过 400 个字符（Unicode 码点）/);
    assert.match(prompt, /详情见证据包/);
    assert.match(prompt, /detail_needed/);
    assert.match(prompt, /800 字符/);
    assert.match(prompt, /refs 照常给全/);
    // Freshness/conflict honesty the prompt already required is still there.
    assert.match(prompt, /late\/older memory 与当前用户输入冲突，summary 要明确提示冲突/);
    assert.match(prompt, /时间状态不明就说明不确定/);
    // Delivery choices unchanged.
    assert.match(prompt, /delivery:context/);
    assert.match(prompt, /delivery:audit/);
    assert.match(prompt, /delivery:discard/);
  });

  test('finish tool surfaces the concise schema; refine still receives the evidence pack', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new VerboseThenDetailNeededAI();
    const handle = startBranch(ai, queue);
    await handle.done;

    assert.deepEqual(ai.calls[1].toolNames, ['finish_memory_search']);
    const finishTool = ai.calls[1].tools.find(tool => tool.name === 'finish_memory_search');
    assert.ok(finishTool, 'pass 2 must expose finish_memory_search');
    assert.equal((finishTool.parameters.properties as any).detail_needed.type, 'boolean');
    assert.match(String((finishTool.parameters.properties as any).summary.description), /400/);
    assert.ok(ai.evidencePackIn(ai.calls[1].messages), 'refine view must still carry the evidence pack');
  });

  test('over-cap finish is a structured error; honest detail_needed retry injects full summary + refs', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new VerboseThenDetailNeededAI();
    const handle = startBranch(ai, queue);
    await handle.done;

    assert.equal(ai.calls.length, 3, 'assess + rejected over-cap finish + honest retry');
    assert.equal(ai.sawCapError, true, 'cap error must reach the model as a structured tool result');

    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.equal(observation.status, 'completed');

    // Parent-facing shape untouched: formattedContent {source, summary, refs},
    // metadata.refs, and the >400-char summary accepted via detail_needed.
    const injected = JSON.parse(observation.formattedContent || '');
    assert.equal(injected.source, 'memory');
    assert.deepEqual(injected.refs, [OBSERVED_REF]);
    assert.equal(injected.summary, ai.retrySummary);
    assert.ok(codePointLength(injected.summary) > 400, 'detail_needed honestly exceeds the base cap');
    assert.ok(codePointLength(injected.summary) <= 800);
    assert.deepEqual(observation.metadata.refs, [OBSERVED_REF]);
  });
});

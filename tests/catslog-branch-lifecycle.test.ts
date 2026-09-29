import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { CatsLogObservedRefsTracker } from '../src/core/catslog-skill-evidence';
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

interface BranchQuery {
  queryText?: string;
  sources?: string[];
}

class BranchOnlyMemory implements CatsLogMemoryBackend {
  branchQueries: BranchQuery[] = [];
  branchResponse: CatscoBranchResponse = {
    schema_version: 1,
    content_trust: 'untrusted_branch_evidence',
    request_id: 'req-sidecar-1',
    status: 'ok',
    branches: [
      {
        source: 'memory',
        status: 'ok',
        elapsed_ms: 9,
        items: [
          {
            source: 'session',
            ref: 'stream-review#12',
            kind: 'session_turn',
            text: 'untrusted branch evidence body',
            score_hint: 0.87,
          },
          {
            source: 'skill',
            ref: 'catslog:skill:review-checklist@2',
            kind: 'skill',
            score_hint: 0.91,
          },
        ],
      },
      { source: 'graph', status: 'timeout' },
    ],
  };

  async branch(query: BranchQuery): Promise<CatscoBranchResponse> {
    this.branchQueries.push(query);
    return this.branchResponse;
  }
}

/** Pass 1: assess recall. Pass 2: finish citing an observed remote ref. */
class AssessThenCiteAI implements ToolCallPlan {
  calls = 0;

  constructor(private readonly finishArgs: Record<string, unknown>) {}

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    if (this.calls === 1) {
      return {
        content: null,
        toolCalls: [call('assess-1', 'assess_memory_need', {
          action: 'recall',
          query_text: 'upload migration rollback',
          keywords: ['rollback'],
          sources: ['agent_memory', 'skill'],
        })],
        usage,
      };
    }
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', this.finishArgs)],
      usage,
    };
  }
}

interface ToolCallPlan {
  calls: number;
  isToolCallingSupported(): boolean;
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse>;
}

class FabricatedRefAI extends AssessThenCiteAI {
  // stream-fabricated#99 never appeared in any evidence.
  constructor() {
    super({
      summary: 'This citation was never observed.',
      refs: ['stream-fabricated#99'],
      delivery: 'context',
    });
  }
}

class AuditDeliveryAI extends AssessThenCiteAI {
  constructor() {
    super({
      summary: '保留这条审计证据，但不要打扰当前主 agent 上下文。',
      refs: ['catslog:skill:review-checklist@2'],
      inject: false,
      delivery: 'audit',
    });
  }
}

class ContextDeliveryAI extends AssessThenCiteAI {
  constructor() {
    super({
      summary: 'Branch evidence locates the rollback decision in a prior session.',
      refs: ['stream-review#12'],
      delivery: 'context',
    });
  }
}

class SkipDiscardAI {
  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    return {
      content: null,
      toolCalls: [call('assess-1', 'assess_memory_need', {
        action: 'skip',
        reason: '闲聊，无新增记忆价值。',
      })],
      usage,
    };
  }
}

class StrayTextAI {
  toolNamesPerTurn: string[][] = [];
  calls = 0;

  constructor(private readonly tailSummary: string) {}

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const names = tools?.map(tool => tool.name) || [];
    this.toolNamesPerTurn.push(names);
    this.calls++;
    if (names.length === 1 && names[0] === 'finish_memory_search') {
      return {
        content: null,
        toolCalls: [call('finish-tail', 'finish_memory_search', {
          summary: this.tailSummary,
          refs: ['stream-review#12'],
          inject: false,
          delivery: 'audit',
        })],
        usage,
      };
    }
    return { content: '仍在检索。', toolCalls: [], usage };
  }
}

class BudgetExhaustingAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    return { content: '仍在检索，但还没有完成。', toolCalls: [], usage };
  }
}

class SensitiveEchoAI {
  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(): Promise<ChatResponse> {
    return { content: 'Bearer super-secret-token retrieval_receipt=receipt-secret', toolCalls: [], usage };
  }
}

describe('branch CatsLog lifecycle', () => {
  let testRoot: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-branch-lifecycle-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('publishes observed branch evidence to parent context', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const backend = new BranchOnlyMemory();
    const ai = new ContextDeliveryAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'branch-evidence-context',
      input: 'find the rollback decision',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    assert.equal(ai.calls, 2);
    assert.equal(backend.branchQueries.length, 1);
    assert.equal(backend.branchQueries[0].queryText, 'upload migration rollback');
    assert.deepEqual(backend.branchQueries[0].sources, ['agent_memory', 'skill']);
    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual(injected.refs, ['stream-review#12']);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /published_observation/);
    assert.doesNotMatch(logs, /unobserved_refs_audit_only/);
    // The evidence body stays out of the published observation; the evidence
    // pack remains visible (redacted) in the branch transcript log only.
    const publishedLine = logs.split('\n').find(line => line.includes('"event_type":"published_observation"')) || '';
    assert.equal(publishedLine.includes('untrusted branch evidence body'), false);
  });

  test('fails closed to audit when a finish cites an unobserved ref', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'fabricated-ref-guard',
      input: 'find the rollback decision',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: new FabricatedRefAI() as any,
      queue,
      catslogMemory: new BranchOnlyMemory(),
      logEnabled: true,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /unobserved_refs_audit_only/);
    assert.match(logs, /stream-fabricated#99/);
    assert.match(logs, /audited_observation/);
  });

  test('retains an explicit audit observation without injecting it into the parent queue', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'audit-lifecycle',
      input: '审计 review checklist',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: new AuditDeliveryAI() as any,
      queue,
      catslogMemory: new BranchOnlyMemory(),
      logEnabled: true,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /audited_observation/);
    assert.doesNotMatch(logs, /retrieval_receipt/);
    assert.match(logs, /catslog:skill:review-checklist@2/);
  });

  test('discards a chitchat branch without queueing anything', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'discard-lifecycle',
      input: '今天天气不错',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: new SkipDiscardAI() as any,
      queue,
      catslogMemory: new BranchOnlyMemory(),
      logEnabled: true,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    assert.match(readBranchLogs(testRoot), /suppressed_observation/);
  });

  test('offers a finish-only tail after the pass budget, then stops', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new StrayTextAI('预算耗尽，仅保留审计证据。');
    const handle = startMemorySidecarBranch({
      sessionKey: 'finish-only-tail',
      input: 'find the rollback decision',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: new BranchOnlyMemory(),
      logEnabled: true,
      maxTurnsPerPass: 1,
      maxPasses: 1,
    });

    await handle.done;

    // Pass 1 carries the assess surface; the reserved tail collapses to finish.
    assert.deepEqual(ai.toolNamesPerTurn[0], ['assess_memory_need']);
    assert.deepEqual(ai.toolNamesPerTurn[1], ['finish_memory_search']);
    // Audit delivery keeps the observation out of the parent queue.
    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /轮次预算已用尽/);
    assert.match(logs, /audited_observation/);
  });

  test('converges to the reserved tail after repeated stray passes', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new BudgetExhaustingAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'budget-lifecycle',
      input: 'budget test',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      logEnabled: true,
      maxTurnsPerPass: 1,
      maxPasses: 2,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    // Two normal passes + one reserved finish-only tail pass.
    assert.equal(ai.calls, 3);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /budget_exhausted/);
    assert.match(logs, /轮次预算已用尽/);
    assert.match(logs, /finish_memory_search/);
  });

  test('mechanical retrieval fans out remotely and locally, expanding top local turns', async () => {
    // Local lane: five hits so the bounded expansion (top 3) is observable.
    const sessionDir = path.join(testRoot, 'logs', 'sessions', 'chat', '2026-06-16');
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines: string[] = [];
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      lines.push(JSON.stringify({
        entry_type: 'turn',
        turn: ordinal,
        timestamp: `2026-06-16T10:0${ordinal - 1}:00.000Z`,
        session_id: 'chat:demo',
        session_type: 'chat',
        user: { text: `rollback_note_${ordinal} about the upload migration` },
        assistant: { text: `decision ${ordinal}`, tool_calls: [] },
        tokens: { prompt: 1, completion: 1 },
      }));
    }
    fs.writeFileSync(path.join(sessionDir, 'demo.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const ai = {
      calls: [] as Message[][],
      isToolCallingSupported: () => true,
      async chat(messages: Message[]): Promise<ChatResponse> {
        this.calls.push(JSON.parse(JSON.stringify(messages)));
        if (this.calls.length === 1) {
          return {
            content: null,
            toolCalls: [call('assess-1', 'assess_memory_need', {
              action: 'recall',
              query_text: 'upload migration rollback',
              keywords: ['upload', 'migration'],
            })],
            usage,
          };
        }
        const pack = JSON.parse(
          [...messages].reverse().find(message => (
            message.role === 'user' && String(message.content).includes('evidence_pack')
          ))?.content as string,
        );
        const refs = [
          ...pack.evidence_pack.remote_branch.branches.flatMap((branch: any) => branch.items.map((item: any) => item.ref)),
          ...pack.evidence_pack.local_matches.map((match: any) => match.ref),
        ];
        return {
          content: null,
          toolCalls: [call('finish-1', 'finish_memory_search', {
            summary: 'Remote branch evidence and local hits both describe the rollback decision.',
            refs: [refs[0], refs[1], ...pack.evidence_pack.local_matches.slice(0, 2).map((m: any) => m.ref)],
            delivery: 'context',
          })],
          usage,
        };
      },
    };

    const queue = new InMemorySyntheticObservationQueue();
    const backend = new BranchOnlyMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'parallel-retrieval',
      input: 'find the rollback decision',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    // Both mechanical lanes ran: the remote query was issued once and local
    // matches were attached to the same evidence pack.
    assert.equal(backend.branchQueries.length, 1);
    assert.equal(ai.calls.length, 2);
    const pack = JSON.parse(
      [...ai.calls[1]].reverse().find(message => (
        message.role === 'user' && String(message.content).includes('evidence_pack')
      ))?.content as string,
    );
    assert.equal(pack.evidence_pack.remote_branch.branches.length, 2);
    assert.ok(pack.evidence_pack.local_matches.length >= 2);
    // Top-3 bounded expansion of the local hits, most recent first.
    assert.equal(pack.evidence_pack.local_turns.length, 3);

    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.equal(injected.refs.length, 4);
    assert.deepEqual(injected.refs, [
      'stream-review#12',
      'catslog:skill:review-checklist@2',
      'chat/2026-06-16/demo.jsonl#5',
      'chat/2026-06-16/demo.jsonl#4',
    ]);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /mechanical_retrieval/);
    assert.doesNotMatch(logs, /unobserved_refs_audit_only/);
  });

  test('redacts capability material from every branch log event', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'log-redaction',
      input: 'log redaction test',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: new SensitiveEchoAI() as any,
      queue,
      logEnabled: true,
      maxPasses: 1,
    });

    await handle.done;

    const logs = readBranchLogs(testRoot);
    assert.doesNotMatch(logs, /super-secret-token/);
    assert.doesNotMatch(logs, /receipt-secret/);
    assert.match(logs, /\[redacted\]/);
  });
});

describe('CatsLogObservedRefsTracker', () => {
  test('collects citation-shaped refs from projected tool results only', () => {
    const tracker = new CatsLogObservedRefsTracker();
    tracker.recordToolResult('catslog_branch', JSON.stringify({
      content_trust: 'untrusted_branch_evidence',
      branches: [
        {
          source: 'memory',
          status: 'ok',
          items: [
            { source: 'session', ref: 'stream-review#12', kind: 'session_turn', score_hint: 0.4 },
            { source: 'skill', ref: 'catslog:skill:review-checklist@2', kind: 'skill', score_hint: 0.9 },
            { source: 'session', ref: 'https://evil.example.test/log#1', text: 'ignored unsafe item' },
            'not-an-object',
          ],
        },
        { source: 'graph', status: 'timeout', items: [{ ref: 'stream-review#12', score_hint: 0.6 }] },
      ],
    }));
    tracker.recordToolResult('memory_search', JSON.stringify({
      count: 1,
      matches: [{ ref: 'chat/2026-01-01/session.jsonl#42', hits: ['rollback'] }],
    }));
    tracker.recordToolResult('catslog_branch', 'not-json-at-all');
    tracker.recordToolResult('finish_memory_search', JSON.stringify({ ok: true }));

    assert.deepEqual(tracker.unobservedRefs(['stream-review#12', 'chat/2026-01-01/session.jsonl#42']), []);
    assert.deepEqual(tracker.unobservedRefs(['stream-fabricated#99']), ['stream-fabricated#99']);
    // Unsafe refs are never recorded as observed evidence.
    assert.deepEqual(tracker.unobservedRefs(['https://evil.example.test/log#1']), ['https://evil.example.test/log#1']);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.schema, 'catslog.branch.observed-refs.v1');
    assert.equal(snapshot.observedRefs.length, 3);
    assert.equal(JSON.stringify(snapshot).includes('untrusted branch evidence'), false);
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

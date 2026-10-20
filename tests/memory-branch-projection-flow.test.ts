import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { recomputeSourceProjectionRef } from '../src/core/catslog-projection-reference';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const REVISION = 'a'.repeat(64);
const STREAM = 'stream-ref-flow';
const VALID_REF = recomputeSourceProjectionRef(REVISION, STREAM)!;
const UNOBSERVED_REF = `ref_${'f'.repeat(64)}`;

const DOC = {
  schema_version: 1,
  provenance: 'derived',
  model_steps: 'unknown',
  causality: 'unknown',
  goal: 'Retention audit policy',
  summary: 'Audit evidence must be retained for 90 days only.',
  overall_coverage: 'partial',
  gap_acknowledgement: 'page 2 of the source tape was withheld',
  nodes: [
    { id: 'n1', kind: 'claim', text: 'Audit evidence retention is bounded to 90 days only.' },
    { id: 'n2', kind: 'omission', text: 'Emergency rollback procedure is not covered.' },
  ],
  edges: [{ from: 'n2', to: 'n1', kind: 'qualifies' }],
  mappings: [{ node_id: 'n1', source_ref: 'source-memory:page:1' }],
  conditions: ['Applies only to production releases after 2026-07-01.'],
  omissions: ['Page 2 of the source tape was withheld (unreviewed).'],
  aggregate: { verified_pages: 3, total_pages: 4, gaps: [{ status: 'unreviewed', first_page: 2, last_page: 2 }] },
};

function validRead() {
  return {
    schema_version: 1,
    content_trust: 'derived_memory_projection',
    projection: { revision: REVISION, stream_id: STREAM, document: DOC },
    sources: [{ anchor: { id: 'p1' }, text: 'raw page' }],
  };
}

function makeToolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

class ProjectionBackend implements CatsLogMemoryBackend {
  branchCalls: unknown[] = [];
  readCalls: unknown[] = [];
  constructor(
    private readonly branchResponse: unknown,
    private readonly readImpl?: (input: { projectionRef: string }) => Promise<unknown>,
  ) {}
  isAvailable() { return true; }
  async branch(query: any) {
    this.branchCalls.push(query);
    return this.branchResponse as any;
  }
  async readSourceMemoryProjection(input: { projectionRef: string }) {
    this.readCalls.push(input);
    if (this.readImpl) return this.readImpl(input);
    return validRead() as any;
  }
}

class FinishAI {
  calls: Message[][] = [];
  evidenceMessage?: Record<string, unknown>;
  constructor(private readonly finishArgs: Record<string, unknown>) {}
  isToolCallingSupported(): boolean { return true; }
  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const packMessage = messages.find(message => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      try {
        const parsed = JSON.parse(message.content);
        return parsed?.content_trust === 'untrusted_branch_evidence';
      } catch { return false; }
    });
    if (packMessage) this.evidenceMessage = JSON.parse(String(packMessage.content));
    return {
      content: null,
      toolCalls: [makeToolCall('finish_1', 'finish_memory_search', this.finishArgs)],
      usage,
    };
  }
}

const BRANCH_RESPONSE = {
  schema_version: 1,
  content_trust: 'untrusted_branch_evidence',
  request_id: 'br-test-1',
  status: 'ok',
  branches: [{
    source: 'agent_memory',
    status: 'partial',
    truncated: true,
    items: [{
      source: 'agent_memory',
      ref: VALID_REF,
      kind: 'source_reference',
      text: 'Source projection reference (metadata only; read_required). coverage=partial | claims=2 | conditions=1 | omissions=1 | verified_pages=3/4 | gap_ranges=1',
      score_hint: 0.5,
    }],
  }],
};

async function runBranch(backend: CatsLogMemoryBackend, finishArgs: Record<string, unknown>) {
  const queue = new InMemorySyntheticObservationQueue();
  const ai = new FinishAI(finishArgs);
  const session = new MemorySearchBranchSession({
    sessionKey: 'proj-flow',
    input: 'What are the audit retention conditions?',
    recentMessages: [],
    workingDirectory: '/tmp/proj-flow',
    aiService: ai as any,
    queue,
    catslogMemory: backend,
    logEnabled: false,
  });
  await session.run();
  return { queue, ai, observations: queue.drain() };
}

describe('memory branch source_reference flow (Lane E)', () => {
  test('mechanical prefetch expands the typed ref and delivers the complete semantic view', async () => {
    const backend = new ProjectionBackend(BRANCH_RESPONSE);
    const { ai, observations } = await runBranch(backend, {
      summary: 'Retention is 90 days, prod-only after 2026-07-01; page 2 withheld.',
      evidence: [VALID_REF],
      inject: true,
    });

    // One branch call + one bounded expansion, no model calls for retrieval.
    assert.equal(backend.branchCalls.length, 1);
    assert.equal(backend.readCalls.length, 1);
    assert.deepEqual(backend.readCalls[0], { projectionRef: VALID_REF });
    assert.equal((backend.branchCalls[0] as any).sources[0], 'agent_memory');

    // The pack message the model saw carries the complete semantic view.
    const pack = ai.evidenceMessage!;
    assert.ok(pack, 'remote evidence pack must reach the model');
    const expansion = (pack.source_reference_expansions as any[])[0];
    assert.equal(expansion.ref, VALID_REF);
    assert.equal(expansion.status, 'expanded');
    assert.deepEqual(expansion.semantic_view.conditions, DOC.conditions);
    assert.deepEqual(expansion.semantic_view.omissions, DOC.omissions);
    assert.equal(expansion.semantic_view.gap_acknowledgement, DOC.gap_acknowledgement);
    assert.equal((expansion.semantic_view.aggregate.gaps as any[])[0].first_page, 2);

    // The finish cited a delivered ref → observation injected with retained evidence.
    assert.equal(observations.length, 1);
    const observation = observations[0];
    const formatted = JSON.parse(observation.formattedContent!);
    const retained = formatted.retained_remote_evidence[0];
    assert.equal(retained.ref, VALID_REF);
    assert.deepEqual(retained.semantic_view.conditions, DOC.conditions);
    assert.deepEqual(retained.semantic_view.omissions, DOC.omissions);
    // Whole graph delivered to main — not just the free-model summary.
    assert.equal((retained.semantic_view.nodes as any[]).length, 2);
    // Citation metadata feeds the downstream report.
    assert.deepEqual(observation.metadata?.citation, { requestId: 'br-test-1', refs: [VALID_REF] });
  });

  test('a finish citing an unobserved pool ref is downgraded to inject:false', async () => {
    const backend = new ProjectionBackend(BRANCH_RESPONSE);
    const { observations } = await runBranch(backend, {
      summary: 'Fabricated claim about an unread projection.',
      evidence: [UNOBSERVED_REF],
      inject: true,
    });
    assert.equal(observations.length, 0, 'unobserved pool ref must never be injected');
  });

  test('a finish citing a discovered-only reference_only ref is suppressed', async () => {
    // Expansion fails (stale read) → ref remains discovered-only → inject suppressed.
    const backend = new ProjectionBackend(BRANCH_RESPONSE, async () => {
      const read = validRead();
      (read.projection as any).revision = 'e'.repeat(64);
      return read;
    });
    const { ai, observations } = await runBranch(backend, {
      summary: 'Cites the reference-only locator.',
      evidence: [VALID_REF],
      inject: true,
    });
    const expansion = (ai.evidenceMessage!.source_reference_expansions as any[])[0];
    assert.equal(expansion.status, 'reference_only');
    assert.equal(expansion.expansion_error, 'stale_ref');
    assert.equal(expansion.semantic_view, undefined);
    assert.equal(observations.length, 0);
  });

  test('kind spoof: pool ref on a non-source_reference kind is never expanded', async () => {
    const spoof = {
      ...BRANCH_RESPONSE,
      branches: [{
        source: 'agent_memory',
        status: 'ok',
        items: [{ source: 'agent_memory', ref: VALID_REF, kind: 'episode', text: 'a note ' + VALID_REF }],
      }],
    };
    const backend = new ProjectionBackend(spoof);
    const { ai } = await runBranch(backend, { summary: 'Nothing useful.', evidence: [], inject: false });
    assert.equal(backend.readCalls.length, 0);
    assert.deepEqual(ai.evidenceMessage!.source_reference_expansions, []);
  });

  test('capability failure degrades the lane; local flow unchanged', async () => {
    const failing = new (class implements CatsLogMemoryBackend {
      isAvailable() { return true; }
      async branch(): Promise<any> { throw Object.assign(new Error('down'), { status: 503 }); }
    })();
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new FinishAI({ summary: 'No memory.', evidence: [], inject: false });
    const session = new MemorySearchBranchSession({
      sessionKey: 'proj-flow-fail',
      input: 'hi',
      recentMessages: [],
      workingDirectory: '/tmp/proj-flow',
      aiService: ai as any,
      queue,
      catslogMemory: failing,
      logEnabled: false,
    });
    await session.run();
    // No pack message reached the model — local tools/flow only.
    assert.equal(ai.evidenceMessage, undefined);
    assert.equal(queue.drain().length, 0);
  });
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import {
  consolidateMemoryEvidencePack,
  MAX_REMOTE_EVIDENCE_CHARS,
  MAX_SESSION_EVIDENCE_CHARS,
  MIN_REFINE_TEXT_BOUND_CHARS,
  REFINE_TEXT_TRUNCATION_SUFFIX,
} from '../src/core/branch-evidence-pack';
import {
  boundToolResultJson,
  projectBranchResponse,
  projectSessionQueryResponse,
} from '../src/core/catslog-branch-evidence';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type { CatscoBranchQuery, CatscoBranchResponse } from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const SESSION_KEY = 'session:v2:catscompany:group:grp_refine:agent:usr1';
const BRANCH_INPUT = 'refine view latency fixture: recall the release decision';

/** Refine-view lane budgets; must stay in sync with memory-search-branch-session.ts. */
const REFINE_REMOTE_CHARS = 6_000;
const REFINE_SESSION_CHARS = 3_600;
const REFINE_KNOWLEDGE_CHARS = 2_400;
const REFINE_REMOTE_ITEM_TEXT_CHARS = 1_000;
const REFINE_SESSION_MEMBER_TEXT_CHARS = 700;
const REFINE_KNOWLEDGE_EXCERPT_TEXT_CHARS = 500;
const REFINE_VIEW = {
  remoteItemTextChars: REFINE_REMOTE_ITEM_TEXT_CHARS,
  sessionMemberTextChars: REFINE_SESSION_MEMBER_TEXT_CHARS,
  knowledgeExcerptTextChars: REFINE_KNOWLEDGE_EXCERPT_TEXT_CHARS,
};

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function sessionRecord(base: string, turn: number, sessionId: string, logDate: string, userText: string) {
  return {
    ref: `${base}#${turn}`,
    session_id: sessionId,
    log_date: logDate,
    turn,
    user: { text: userText },
  };
}

/** Session run of four adjacent turns; long texts so refine bounding bites. */
function groupRun(base: string, firstTurn: number, sessionId: string, logDate: string, userTextChars: number) {
  return Array.from({ length: 4 }, (_unused, index) =>
    sessionRecord(base, firstTurn + index, sessionId, logDate, 'u'.repeat(userTextChars)));
}

// ─── Unit: consolidateMemoryEvidencePack refineView ────────────────────────

describe('branch evidence pack refine view (unit)', () => {
  const smallLanes = () => ({
    remoteBranch: {
      branches: [
        {
          source: 'session_graph',
          status: 'ok',
          evidence_verdict: 'strong',
          items: [
            { source: 'session', ref: 'sim-remote#1', kind: 'session_turn', text: 'decision kept nginx read-only' },
            { source: 'session', ref: 'sim-remote#2', kind: 'session_turn', text: 'rollback plan drafted' },
          ],
        },
      ],
    },
    sessionRecords: {
      records: [
        ...groupRun('sim-log', 5, 'sim-sess', '2026-06-01', 60),
      ],
    },
    localKnowledge: {
      content_trust: 'local_distilled_knowledge',
      entries: [
        { ref: 'kb:alpha', excerpt: { text: 'k'.repeat(100) } },
      ],
    },
  });

  test('an already-fitting pack is byte-identical between full and refine consolidation', () => {
    const input = smallLanes();
    const full = consolidateMemoryEvidencePack(input, {});
    const refine = consolidateMemoryEvidencePack(input, {
      maxRemoteChars: REFINE_REMOTE_CHARS,
      maxSessionChars: REFINE_SESSION_CHARS,
      maxKnowledgeChars: REFINE_KNOWLEDGE_CHARS,
      refineView: REFINE_VIEW,
    });
    assert.equal(JSON.stringify(refine.evidencePack), JSON.stringify(full.evidencePack));
    // And identical to the plain default-budget consolidation (consolidation unaffected).
    const plain = consolidateMemoryEvidencePack(input);
    assert.equal(JSON.stringify(refine.evidencePack), JSON.stringify(plain.evidencePack));
    assert.deepEqual(refine.presentedRefs, full.presentedRefs);
    assert.equal(refine.diagnostics.session_groups_formed, 1, 'grouping must survive the refine pass');
    assert.equal(refine.diagnostics.remote_text_bounded, 0);
    assert.equal(refine.diagnostics.session_text_bounded, 0);
    assert.equal(refine.diagnostics.knowledge_text_bounded, 0);
    assert.equal(JSON.stringify(refine.evidencePack).includes('truncated'), false);
  });

  test('refine view bounds member texts and keeps the session group intact (no unroll)', () => {
    const input = {
      remoteBranch: {},
      sessionRecords: {
        records: groupRun('sim-log', 5, 'sim-sess', '2026-06-01', 900),
      },
      localKnowledge: {},
    };
    const refine = consolidateMemoryEvidencePack(input, {
      maxSessionChars: REFINE_SESSION_CHARS,
      refineView: { sessionMemberTextChars: REFINE_SESSION_MEMBER_TEXT_CHARS },
    });
    const sessionLane = refine.evidencePack.session_records as Record<string, unknown>;
    const records = sessionLane.records as Record<string, unknown>[];
    assert.equal(records.length, 1, 'the whole run must survive as one entry');
    const group = records[0] as Record<string, unknown> & { records: Record<string, unknown>[] };
    assert.equal(group.type, 'session_turn_group', 'refine view must never unroll groups');
    assert.equal(group.count, 4);
    assert.deepEqual(group.refs, ['sim-log#5', 'sim-log#6', 'sim-log#7', 'sim-log#8']);
    for (const member of group.records) {
      const text = (member as any).user.text as string;
      assert.equal(text.length, REFINE_SESSION_MEMBER_TEXT_CHARS);
      assert.ok(text.endsWith(REFINE_TEXT_TRUNCATION_SUFFIX), 'bounded text carries a visible marker');
    }
    assert.equal(sessionLane.truncated, undefined, 'nothing was dropped, so no truncation flag');
    assert.equal(refine.diagnostics.session_text_bounded, 4);
    assert.equal(refine.diagnostics.session_groups_unrolled, 0);
    assert.equal(refine.diagnostics.session_groups_presented, 1);
    assert.equal(refine.diagnostics.session_omitted_records, 0);
  });

  test('refine session overflow drops whole trailing entries instead of unrolling', () => {
    const input = {
      remoteBranch: {},
      sessionRecords: {
        records: [
          ...groupRun('sim-log', 5, 'sim-sess', '2026-06-01', 900),
          ...groupRun('sim-other', 1, 'sim-sess-b', '2026-06-02', 700),
        ],
      },
      localKnowledge: {},
    };
    const refine = consolidateMemoryEvidencePack(input, {
      maxSessionChars: REFINE_SESSION_CHARS,
      refineView: { sessionMemberTextChars: REFINE_SESSION_MEMBER_TEXT_CHARS },
    });
    const sessionLane = refine.evidencePack.session_records as Record<string, unknown>;
    const records = sessionLane.records as Record<string, unknown>[];
    assert.equal(records.length, 1, 'overflow drops the whole trailing group');
    assert.equal((records[0] as any).stream, 'sim-log');
    assert.equal(sessionLane.truncated, true);
    assert.equal(sessionLane.consolidation_omitted, 4);
    assert.equal(refine.diagnostics.session_groups_unrolled, 0, 'refine mode prefers group-level over member dumps');
    assert.ok(JSON.stringify(sessionLane).length <= REFINE_SESSION_CHARS);
  });

  test('plain mode still unrolls groups under the same pressure (consolidation unaffected)', () => {
    // Exact JSON sizes: member = 590 chars, grouped lane = 1313, unrolled = 1194.
    const input = {
      remoteBranch: {},
      sessionRecords: {
        records: [
          { ref: 'stream-a#5', session_id: 's1', log_date: '2026-06-01', turn: 5, user: { text: 'u'.repeat(500) } },
          { ref: 'stream-a#6', session_id: 's1', log_date: '2026-06-01', turn: 6, user: { text: 'u'.repeat(500) } },
        ],
      },
      localKnowledge: {},
    };
    const plain = consolidateMemoryEvidencePack(input, { maxSessionChars: 1_250 });
    const sessionLane = plain.evidencePack.session_records as Record<string, unknown>;
    const records = sessionLane.records as Record<string, unknown>[];
    assert.equal(records.length, 2, 'plain mode unrolls into bare records that fit');
    assert.ok(records.every(entry => (entry as any).type === undefined));
    assert.equal(plain.diagnostics.session_groups_unrolled, 1);
    assert.equal(sessionLane.truncated, undefined);
  });

  test('refine remote bounding shortens oversized item text and tail-drops with markers', () => {
    const items = [
      { source: 'session', ref: 'sim-remote#1', kind: 'session_turn', text: 'x'.repeat(2_400) },
      ...Array.from({ length: 24 }, (_unused, index) => ({
        source: 'session',
        ref: `sim-remote#${index + 2}`,
        kind: 'session_turn',
        text: 'y'.repeat(300),
      })),
    ];
    const input = { remoteBranch: { branches: [{ source: 'session_graph', status: 'ok', items }] }, sessionRecords: {}, localKnowledge: {} };
    const refine = consolidateMemoryEvidencePack(input, {
      maxRemoteChars: REFINE_REMOTE_CHARS,
      refineView: { remoteItemTextChars: REFINE_REMOTE_ITEM_TEXT_CHARS },
    });
    const remote = refine.evidencePack.remote_branch as any;
    assert.equal(remote.truncated, true);
    assert.ok(remote.consolidation_omitted_items > 0, 'tail items are dropped with a count marker');
    const first = remote.branches[0].items[0];
    assert.equal(first.text.length, REFINE_REMOTE_ITEM_TEXT_CHARS);
    assert.ok(first.text.endsWith(REFINE_TEXT_TRUNCATION_SUFFIX));
    assert.equal(first.ref, 'sim-remote#1', 'refs are never bounded or dropped by text bounding');
    assert.ok(JSON.stringify(refine.evidencePack.remote_branch).length <= REFINE_REMOTE_CHARS);
    assert.equal(refine.diagnostics.remote_text_bounded, 1);
  });

  test('refine knowledge bounding shortens oversized excerpt text', () => {
    const input = {
      remoteBranch: {},
      sessionRecords: {},
      localKnowledge: {
        content_trust: 'local_distilled_knowledge',
        entries: [
          { ref: 'kb:alpha', excerpt: { text: 'k'.repeat(1_500) } },
          { ref: 'kb:beta', excerpt: { text: 'k'.repeat(1_500) } },
          { ref: 'kb:gamma', excerpt: { text: 'k'.repeat(1_500) } },
        ],
      },
    };
    const refine = consolidateMemoryEvidencePack(input, {
      maxKnowledgeChars: REFINE_KNOWLEDGE_CHARS,
      refineView: { knowledgeExcerptTextChars: REFINE_KNOWLEDGE_EXCERPT_TEXT_CHARS },
    });
    const knowledgeLane = refine.evidencePack.local_knowledge as Record<string, unknown>;
    const entries = knowledgeLane.entries as any[];
    assert.equal(entries.length, 3, 'bounding must not drop entries');
    for (const entry of entries) {
      assert.equal(entry.excerpt.text.length, REFINE_KNOWLEDGE_EXCERPT_TEXT_CHARS);
      assert.ok(entry.excerpt.text.endsWith(REFINE_TEXT_TRUNCATION_SUFFIX));
      assert.equal(entry.ref.startsWith('kb:'), true);
    }
    assert.equal(knowledgeLane.truncated, undefined);
    assert.equal(refine.diagnostics.knowledge_text_bounded, 3);
  });

  test('refine presentedRefs stay a subset of the full presentedRefs', () => {
    const input = {
      remoteBranch: {
        branches: [
          {
            source: 'session_graph',
            status: 'ok',
            items: [
              { source: 'session', ref: 'sim-remote#1', text: 'x'.repeat(2_400) },
              ...Array.from({ length: 24 }, (_unused, index) => ({
                source: 'session',
                ref: `sim-remote#${index + 2}`,
                text: 'y'.repeat(300),
              })),
            ],
          },
        ],
      },
      sessionRecords: {
        records: [
          ...groupRun('sim-log', 5, 'sim-sess', '2026-06-01', 900),
          ...groupRun('sim-other', 1, 'sim-sess-b', '2026-06-02', 900),
        ],
      },
      localKnowledge: { entries: [{ ref: 'kb:alpha', excerpt: { text: 'k'.repeat(1_500) } }] },
    };
    const full = consolidateMemoryEvidencePack(input, {});
    const refine = consolidateMemoryEvidencePack(input, {
      maxRemoteChars: REFINE_REMOTE_CHARS,
      maxSessionChars: REFINE_SESSION_CHARS,
      maxKnowledgeChars: REFINE_KNOWLEDGE_CHARS,
      refineView: REFINE_VIEW,
    });
    const fullSet = new Set(full.presentedRefs);
    assert.ok(full.presentedRefs.length > refine.presentedRefs.length, 'fixture must actually overflow the refine budget');
    for (const ref of refine.presentedRefs) {
      assert.ok(fullSet.has(ref), `refine ref ${ref} must be observed by the full pack`);
    }
  });

  test('unrepresentable refine text bounds are rejected with a RangeError', () => {
    assert.throws(
      () => consolidateMemoryEvidencePack(smallLanes(), {
        refineView: { remoteItemTextChars: MIN_REFINE_TEXT_BOUND_CHARS - 1 },
      }),
      /remoteItemTextChars/,
    );
    assert.throws(
      () => consolidateMemoryEvidencePack(smallLanes(), {
        refineView: { sessionMemberTextChars: 10.5 },
      }),
      /sessionMemberTextChars/,
    );
  });
});

// ─── Integration: MemorySearchBranchSession refine view ────────────────────

/** Oversized mechanical lanes (synthetic, bounded): remote ≈ 11.7k, sessions ≈ 9.8k. */
class OversizedEvidenceMemory implements CatsLogMemoryBackend {
  async branch(_query: CatscoBranchQuery): Promise<CatscoBranchResponse> {
    return {
      schema_version: 1,
      content_trust: 'untrusted_branch_evidence',
      request_id: 'req-refine-view-1',
      status: 'ok',
      branches: [
        {
          source: 'session_graph',
          status: 'ok',
          items: [
            { source: 'session', ref: 'sim-remote#1', kind: 'session_turn', text: 'x'.repeat(2_400), score_hint: 0.9 },
            ...Array.from({ length: 24 }, (_unused, index) => ({
              source: 'session',
              ref: `sim-remote#${index + 2}`,
              kind: 'session_turn',
              text: 'y'.repeat(300),
              score_hint: 0.5,
            })),
          ],
        },
      ],
    };
  }

  async querySessions(_query: { searchAny?: string[]; latest?: boolean; limit?: number }): Promise<unknown> {
    return {
      content_trust: 'untrusted_log_data',
      records: groupRun('sim-log', 1, 'sim-sess', '2026-06-01', 800)
        .concat(groupRun('sim-log', 10, 'sim-sess', '2026-06-01', 800))
        .concat(groupRun('sim-log', 20, 'sim-sess', '2026-06-01', 800)),
      truncated: false,
    };
  }
}

class SmallEvidenceMemory extends OversizedEvidenceMemory {
  async branch(_query: CatscoBranchQuery): Promise<CatscoBranchResponse> {
    return {
      schema_version: 1,
      content_trust: 'untrusted_branch_evidence',
      request_id: 'req-refine-view-small',
      status: 'ok',
      branches: [
        {
          source: 'session_graph',
          status: 'ok',
          items: [
            { source: 'session', ref: 'sim-remote#1', kind: 'session_turn', text: 'small decision', score_hint: 0.9 },
          ],
        },
      ],
    };
  }

  async querySessions(_query: { searchAny?: string[]; latest?: boolean; limit?: number }): Promise<unknown> {
    return {
      content_trust: 'untrusted_log_data',
      records: [
        { ref: 'sim-log#1', session_id: 'sim-sess', log_date: '2026-06-01', turn: 1, user: { text: 'small recall' } },
      ],
      truncated: false,
    };
  }
}

/** Assess-recall, then finish citing the first ref visible in the refine view. */
class AssessThenFinishAI {
  calls: Array<{ toolNames: string[]; messages: Message[] }> = [];

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

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push({
      toolNames: tools?.map(tool => tool.name) || [],
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
    const refs = this.evidencePackRefs(messages);
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', refs.length > 0 ? {
        summary: 'Refine view fixture summary.',
        refs: [refs[0]],
        inject: true,
        delivery: 'context',
      } : {
        summary: 'No usable evidence.',
        refs: [],
        inject: false,
        delivery: 'discard',
      })],
      usage,
    };
  }
}

function createSession(options: {
  aiService: AssessThenFinishAI;
  queue: InMemorySyntheticObservationQueue;
  backend: CatsLogMemoryBackend;
}): {
  session: MemorySearchBranchSession;
  branchEvents: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const session = new MemorySearchBranchSession({
    sessionKey: SESSION_KEY,
    input: BRANCH_INPUT,
    recentMessages: [],
    workingDirectory: process.cwd(),
    aiService: options.aiService as any,
    queue: options.queue,
    logEnabled: false,
    catslogMemory: options.backend,
  });
  const branchEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  (session as any).logger.write = (type: string, payload: Record<string, unknown> = {}) => {
    branchEvents.push({ type, payload });
  };
  return { session, branchEvents };
}

describe('MemorySearchBranchSession refine view', () => {
  test('oversized evidence is capped to the refine budget with honest markers, and finish stays guarded', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const { session, branchEvents } = createSession({ aiService: ai, queue, backend: new OversizedEvidenceMemory() });

    await session.run();

    assert.equal(queue.size(), 1, 'a finish citing a refine-visible ref delivers context');
    const refineCall = ai.calls[1];
    assert.ok(refineCall, 'the refine inference must have happened');
    assert.deepEqual(refineCall.toolNames, ['finish_memory_search']);
    const parsed = ai.evidencePackIn(refineCall.messages);
    assert.ok(parsed?.evidence_pack, 'the refine call must receive the evidence pack');

    const packJson = JSON.stringify(parsed.evidence_pack);
    // 12k lane budget + content_trust/keyword-note wrapper slack.
    assert.ok(packJson.length <= 12_400, `refine-visible pack must be capped, got ${packJson.length}`);
    assert.ok(parsed.instruction.includes('收尾视图'), 'instruction must present the capped view honestly');
    assert.ok(parsed.instruction.includes('truncated'), 'instruction must name the truncation markers');

    const remote = parsed.evidence_pack.remote_branch;
    assert.equal(remote.truncated, true, 'overflowing remote lane must carry the truncation flag');
    assert.ok(remote.consolidation_omitted_items > 0, 'dropped remote items must be counted');
    const boundedRemoteText = remote.branches[0].items[0].text;
    assert.equal(boundedRemoteText.length, REFINE_REMOTE_ITEM_TEXT_CHARS);
    assert.ok(boundedRemoteText.endsWith(REFINE_TEXT_TRUNCATION_SUFFIX));

    const sessionLane = parsed.evidence_pack.session_records;
    assert.equal(sessionLane.truncated, true, 'overflowing session lane must carry the truncation flag');
    assert.equal(sessionLane.consolidation_omitted, 8, 'two of three groups are dropped whole (members counted)');
    const groups = sessionLane.records as any[];
    assert.equal(groups.length, 1, 'surviving session evidence stays group-level');
    assert.equal(groups[0].type, 'session_turn_group');
    assert.equal(groups[0].count, 4);
    assert.equal(groups[0].records[0].user.text.length, REFINE_SESSION_MEMBER_TEXT_CHARS);

    // Finish guard: cited ref is visible in the refine view (⊆ observed refs).
    const citedRef = ai.evidencePackRefs(refineCall.messages)[0];
    assert.equal(citedRef, 'sim-remote#1');
    assert.equal(
      branchEvents.some(entry => entry.type === 'unobserved_refs_audit_only'),
      false,
      'a refine-visible ref must pass the observed-refs guard',
    );

    const mechanical = branchEvents.find(entry => entry.type === 'mechanical_retrieval');
    assert.ok(mechanical, 'mechanical_retrieval must still be logged');
    const fullPackChars = mechanical!.payload.evidence_pack_chars as number;
    const refinePackChars = mechanical!.payload.refine_pack_chars as number;
    assert.ok(fullPackChars > refinePackChars, 'the refine view must be strictly smaller on oversized packs');
    assert.ok(refinePackChars <= 13_600, `refine message must stay near the 12k target, got ${refinePackChars}`);
    assert.equal(
      (mechanical!.payload.refine_view_refs_presented as number),
      ai.evidencePackRefs(refineCall.messages).length,
      'logged refine ref count matches the model-visible pack',
    );
  });

  test('an already-small pack reaches the model unchanged (no truncation markers)', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SmallEvidenceMemory();
    const { session } = createSession({ aiService: ai, queue, backend });

    await session.run();

    assert.equal(queue.size(), 1);
    const parsed = ai.evidencePackIn(ai.calls[1].messages);
    assert.ok(parsed?.evidence_pack);

    // Reconstruct the full-budget consolidation from the same backend data.
    const expectedRemoteLane = JSON.parse(boundToolResultJson(
      projectBranchResponse(await backend.branch({ queryText: 'release decision' })),
      MAX_REMOTE_EVIDENCE_CHARS,
    ));
    const expectedSessionLane = projectSessionQueryResponse(await backend.querySessions({}), MAX_SESSION_EVIDENCE_CHARS);
    const full = consolidateMemoryEvidencePack({
      remoteBranch: expectedRemoteLane,
      sessionRecords: expectedSessionLane,
      localKnowledge: parsed.evidence_pack.local_knowledge,
    });

    assert.deepEqual(parsed.evidence_pack.remote_branch, full.evidencePack.remote_branch);
    assert.deepEqual(parsed.evidence_pack.session_records, full.evidencePack.session_records);
    const remoteLane = parsed.evidence_pack.remote_branch as Record<string, unknown>;
    const sessionModelLane = parsed.evidence_pack.session_records as Record<string, unknown>;
    assert.equal(remoteLane.truncated, false, 'small remote lane must be untouched (projection-level false only)');
    assert.equal('consolidation_omitted_items' in remoteLane, false, 'no remote drops in a small pack');
    assert.equal('consolidation_omitted' in sessionModelLane, false, 'no session drops in a small pack');
    assert.equal(sessionModelLane.truncated, false, 'small session lane must be untouched (projection-level false only)');
    assert.ok(!JSON.stringify(parsed.evidence_pack).includes(REFINE_TEXT_TRUNCATION_SUFFIX), 'no text was shortened');
  });

  test('stage timings fire in pipeline order including refine_start, with ids/ms only', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const { session, branchEvents } = createSession({
      aiService: new AssessThenFinishAI(),
      queue,
      backend: new SmallEvidenceMemory(),
    });

    await session.run();

    const timings = branchEvents.filter(entry => entry.type === 'branch_stage_timing');
    const stages = timings.map(entry => entry.payload.stage);
    assert.deepEqual(
      stages,
      ['mechanical_retrieval_end', 'assess_end', 'refine_start', 'refine_finish'],
      'refine_start must sit between pack assembly and the finish',
    );
    let previousMs = -1;
    for (const timing of timings) {
      assert.deepEqual(
        Object.keys(timing.payload).sort(),
        ['ms_since_run_start', 'session_key', 'stage'],
        'timing payloads stay bounded to ids and ms',
      );
      const ms = timing.payload.ms_since_run_start as number;
      assert.ok(ms >= previousMs, 'stage ms are cumulative and monotonic');
      previousMs = ms;
      assert.equal(timing.payload.session_key, SESSION_KEY);
    }
    assert.equal(
      JSON.stringify(timings).includes('decision kept nginx'),
      false,
      'no evidence content may leak into timing events',
    );
  });
});

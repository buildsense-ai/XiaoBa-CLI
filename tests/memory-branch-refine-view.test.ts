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
import type { CatscoBranchQuery, CatscoBranchResponse } from '../src/utils/catsco-log-agent-client';

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

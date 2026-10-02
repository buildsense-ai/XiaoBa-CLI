import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  consolidateMemoryEvidencePack,
  MAX_KNOWLEDGE_EVIDENCE_CHARS,
  MAX_REMOTE_EVIDENCE_CHARS,
  MAX_SESSION_EVIDENCE_CHARS,
  SESSION_TURN_GROUP_TYPE,
} from '../src/core/branch-evidence-pack';
import { CatsLogObservedRefsTracker } from '../src/core/catslog-skill-evidence';

/**
 * Focused contract tests for the mechanical evidence-pack consolidation.
 * All fixtures are synthetic; no real transcripts, logs, or device data.
 */

const TEXT_A = 'rollback decision: keep the nginx mount read-only';
const TEXT_B = 'release playbook step 3: freeze deploys during migration';
const TEXT_C = 'standup note: queue depth alert tuned to 200';

function remoteItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'session',
    ref: 'stream-release#12',
    kind: 'session_turn',
    text: TEXT_A,
    score_hint: 0.87,
    ...overrides,
  };
}

function sessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'stream-release#12',
    session_type: 'chat',
    session_id: 'chat:release-planning',
    log_date: '2026-09-01',
    timestamp: '2026-09-01T10:00:00.000Z',
    turn: 12,
    entry_type: 'turn',
    user: { text: 'we agreed on the read-only mount' },
    agent: { text: 'Decision recorded: keep the mount read-only.' },
    ...overrides,
  };
}

function knowledgeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'kb:KB-1b2f3c4d-1111-2222-3333-444455556666',
    id: 'KB-1b2f3c4d-1111-2222-3333-444455556666',
    title: 'Deploy guardrails',
    summary: 'Freeze deploys while a migration is running.',
    category: 'ops',
    updated_at: '2026-08-01T00:00:00.000Z',
    revision: 'r3',
    managed: true,
    ...overrides,
  };
}

function laneChars(lane: unknown): number {
  return JSON.stringify(lane).length;
}

describe('consolidateMemoryEvidencePack — exact duplicate elimination', () => {
  test('exact duplicates collapse once, and both duplicated items keep their refs presented', () => {
    const input = {
      remoteBranch: {
        content_trust: 'untrusted_branch_evidence',
        request_id: 'br-1',
        branches: [
          {
            source: 'session_graph',
            status: 'ok',
            evidence_verdict: 'weak',
            elapsed_ms: 9,
            truncated: false,
            items: [
              remoteItem(),
              remoteItem({ ref: 'catslog:skill:release-playbook@3', kind: 'skill', source: 'skill', score_hint: 0.9 }),
            ],
          },
          {
            source: 'agent_memory',
            status: 'ok',
            truncated: false,
            items: [
              // Byte-identical copy of branch 1 item 1 (same ref, same content).
              remoteItem(),
            ],
          },
        ],
        truncated: false,
      },
      sessionRecords: {
        content_trust: 'untrusted_log_data',
        records: [sessionRecord(), sessionRecord()],
        truncated: false,
      },
      localKnowledge: {
        content_trust: 'local_distilled_knowledge',
        provenance: 'local_knowledge',
        scope: 'per_instance_shared',
        status: 'ok',
        entries: [knowledgeEntry(), knowledgeEntry()],
        keywords_queried: 2,
        truncated: false,
      },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);

    // One copy survives per lane, every branch envelope stays.
    const remote = evidencePack.remote_branch as Record<string, unknown>;
    const branches = remote.branches as Record<string, unknown>[];
    assert.equal(branches.length, 2, 'branch envelopes must survive dedup');
    assert.equal((branches[0].items as unknown[]).length, 2);
    assert.equal((branches[1].items as unknown[]).length, 0, 'later duplicate copies are removed');
    assert.equal(branches[1].source, 'agent_memory', 'the emptied branch stays visible');
    assert.equal(diagnostics.remote_duplicates_removed, 1);
    assert.equal(diagnostics.session_duplicates_removed, 1);
    assert.equal(diagnostics.knowledge_duplicates_removed, 1);

    // All distinct source refs stay presented — nothing citable is lost.
    // Two duplicated remote items keep both their refs; the session and KB
    // duplicates reuse refs already counted, so the distinct set is 3.
    assert.ok(presentedRefs.includes('stream-release#12'));
    assert.ok(presentedRefs.includes('catslog:skill:release-playbook@3'));
    assert.ok(presentedRefs.includes('kb:KB-1b2f3c4d-1111-2222-3333-444455556666'));
    assert.equal(presentedRefs.length, 3);
    assert.equal(diagnostics.refs_presented, 3);

    // Pack shape: top-level lane names and trust label are preserved.
    assert.equal(evidencePack.content_trust, 'untrusted_branch_evidence');
    for (const lane of ['remote_branch', 'session_records', 'local_knowledge']) {
      assert.ok(lane in evidencePack, `top-level ${lane} must exist`);
    }
    const session = evidencePack.session_records as Record<string, unknown>;
    assert.equal((session.records as unknown[]).length, 1);
    assert.equal((evidencePack.local_knowledge as Record<string, unknown>).content_trust, 'local_distilled_knowledge');
  });

  test('user vs assistant with the same text is not identical provenance and never merges', () => {
    const input = {
      remoteBranch: {
        branches: [{
          source: 'session_graph',
          items: [
            remoteItem({ ref: 'stream-x#3', kind: 'user_turn', text: 'same words' }),
            remoteItem({ ref: 'stream-x#3', kind: 'assistant_turn', text: 'same words' }),
          ],
        }],
      },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-a#5', turn: 5, user: { text: 'same sentence' }, agent: undefined }),
          sessionRecord({ ref: 'stream-a#5', turn: 5, agent: { text: 'same sentence' } }),
        ],
      },
      localKnowledge: { entries: [] },
    };
    // `agent: undefined` would be dropped by JSON round-trip; drop it up front instead.
    delete (input.sessionRecords.records[0] as Record<string, unknown>).agent;

    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    const remoteItems = (evidencePack.remote_branch as any).branches[0].items;
    assert.equal(remoteItems.length, 2, 'kind (speaker provenance) differs, so both remote items stay');
    assert.equal(diagnostics.remote_duplicates_removed, 0);

    const records = (evidencePack.session_records as any).records;
    assert.equal(records.length, 2, 'user text vs agent text under the same ref never merges');
    assert.equal(records[0].user.text, 'same sentence');
    assert.equal(records[1].agent.text, 'same sentence');
    assert.equal(diagnostics.session_duplicates_removed, 0);
  });

  test('changed dates, revisions, score_hint gaps, and conflicting facts are all preserved', () => {
    const input = {
      remoteBranch: {
        branches: [{
          source: 'session_graph',
          items: [
            remoteItem({ text: 'deploy window is Friday 14:00', score_hint: 0.9 }),
            remoteItem({ text: 'deploy window moved to Friday 16:00', score_hint: 0.4 }),
          ],
        }],
      },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-a#5', turn: 5, log_date: '2026-09-01', user: { text: 'deploy Friday 14:00' } }),
          sessionRecord({ ref: 'stream-a#6', turn: 6, log_date: '2026-09-02', user: { text: 'correction: deploy Friday 16:00' } }),
        ],
      },
      localKnowledge: {
        entries: [
          knowledgeEntry({ revision: 'r3', updated_at: '2026-08-01T00:00:00.000Z' }),
          knowledgeEntry({ ref: 'kb:KB-1b2f3c4d-1111-2222-3333-444455557777', id: 'KB-1b2f3c4d-1111-2222-3333-444455557777', revision: 'r4', updated_at: '2026-08-20T00:00:00.000Z' }),
        ],
      },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);
    assert.equal((evidencePack.remote_branch as any).branches[0].items.length, 2, 'conflicting texts stay separate');
    assert.equal(diagnostics.remote_duplicates_removed, 0, 'score_hint is not confidence; a gap never triggers a merge');

    const records = (evidencePack.session_records as any).records;
    assert.equal(records.length, 2, 'the correction turn is never dropped in favor of the older fact');
    assert.equal(records[0].log_date, '2026-09-01');
    assert.equal(records[1].log_date, '2026-09-02');

    const entries = (evidencePack.local_knowledge as any).entries;
    assert.equal(entries.length, 2, 'same KB id with different revision/updated_at stays separate');
    assert.deepEqual(entries.map((entry: any) => entry.revision), ['r3', 'r4'], 'revisions keep input order — no recency pruning');
    assert.equal(presentedRefs.length, 5, 'remote(1 distinct ref) + session(2) + knowledge(2) — no ref lost');
  });
});

describe('consolidateMemoryEvidencePack — session turn grouping', () => {
  test('adjacent same-stream turns group with flat refs; different streams and gaps stay separate', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-a#5', turn: 5, user: { text: 'question about quotas' } }),
          sessionRecord({ ref: 'stream-a#6', turn: 6, agent: { text: 'quota raised to 500' } }),
          sessionRecord({ ref: 'stream-b#5', turn: 5, session_id: 'chat:other', user: { text: 'b5' } }),
          sessionRecord({ ref: 'stream-b#6', turn: 6, session_id: 'chat:other', agent: { text: 'b6' } }),
          sessionRecord({ ref: 'stream-a#8', turn: 8, user: { text: 'follow-up' } }),
          sessionRecord({ ref: 'stream-a#9', turn: 9, agent: { text: 'answer' } }),
          sessionRecord({ ref: 'stream-a#20', turn: 20, user: { text: 'much later turn' } }),
          sessionRecord({ ref: 'stream-a#25', turn: 25, user: { text: 'unrelated later turn' } }),
        ],
      },
      localKnowledge: { entries: [] },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);
    const records = (evidencePack.session_records as any).records;
    assert.equal(diagnostics.session_groups_formed, 3, 'a-b-a-b-a interleave forms exactly the three contiguous runs');

    const groupA1 = records[0];
    assert.equal(groupA1.type, SESSION_TURN_GROUP_TYPE);
    assert.equal(groupA1.stream, 'stream-a');
    assert.deepEqual(groupA1.turns, [5, 6]);
    assert.deepEqual(groupA1.refs, ['stream-a#5', 'stream-a#6'], 'groups carry flat, deduped refs');
    assert.equal(groupA1.count, 2);
    // Members keep their own role, dates, and order — corrections/conflicts stay per-member.
    assert.equal(groupA1.records[0].user.text, 'question about quotas');
    assert.equal(groupA1.records[1].agent.text, 'quota raised to 500');
    assert.equal(groupA1.records[1].timestamp, '2026-09-01T10:00:00.000Z');

    assert.equal(records[1].stream, 'stream-b', 'a different stream forms its own group');
    assert.equal(records[2].turns[0], 8, 'a turn gap (>1) starts a new group instead of bridging');
    assert.equal(records[3].ref, 'stream-a#20', 'non-adjacent singletons are never wrapped');
    assert.equal(records[4].ref, 'stream-a#25');

    assert.deepEqual(presentedRefs, [
      'stream-a#5', 'stream-a#6', 'stream-b#5', 'stream-b#6', 'stream-a#8', 'stream-a#9', 'stream-a#20', 'stream-a#25',
    ]);
    assert.equal(diagnostics.session_records_out, 8, 'grouping never loses a member');
  });

  test('session_id or log_date disagreement, summary refs, and opaque refs block grouping', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-e#5', turn: 5, session_id: 'chat:one' }),
          sessionRecord({ ref: 'stream-e#6', turn: 6, session_id: 'chat:two' }),
          sessionRecord({ ref: 'stream-f#5', turn: 5, log_date: '2026-09-01' }),
          sessionRecord({ ref: 'stream-f#6', turn: 6, log_date: '2026-09-02' }),
          sessionRecord({ ref: 'stream-g#5', turn: 5 }),
          sessionRecord({ ref: 'stream-g#summary' }),
          sessionRecord({ ref: 'catslog:ref:aaaaaaaaaaaaaaaaaaaaaaaa', turn: 5 }),
          sessionRecord({ ref: 'catslog:ref:aaaaaaaaaaaaaaaaaaaaaaaa', turn: 6 }),
        ],
      },
      localKnowledge: { entries: [] },
    };

    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    const records = (evidencePack.session_records as any).records;
    assert.equal(diagnostics.session_groups_formed, 0, 'no group without full coordinate proof');
    for (const record of records) {
      assert.equal(record.type, undefined, 'every entry stays a plain record');
    }
    assert.equal(records.length, 8);
  });
});

describe('consolidateMemoryEvidencePack — Unicode and opaque refs', () => {
  test('Unicode text survives intact and opaque/summary/invalid refs never group', () => {
    const unicodeText = '決策：保留 nginx 唯讀掛載 🎉 astral 𝕏 ok';
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-zh#1', turn: 1, user: { text: unicodeText } }),
          sessionRecord({ ref: 'stream-zh#2', turn: 2, agent: { text: '已记录 ✓' } }),
          sessionRecord({ ref: 'stream-zh#3', turn: 3 }),
          sessionRecord({ ref: 42, turn: 4 }),
          sessionRecord({ ref: undefined, turn: 5 }),
        ],
      },
      localKnowledge: { entries: [] },
    };

    const { evidencePack, presentedRefs } = consolidateMemoryEvidencePack(input);
    const records = (evidencePack.session_records as any).records;
    assert.equal(records[0].type, SESSION_TURN_GROUP_TYPE, 'Unicode stream base groups like any other');
    assert.equal(records[0].records[0].user.text, unicodeText, 'Unicode round-trips byte-faithfully');
    assert.deepEqual(records[0].turns, [1, 2, 3], 'contiguous Δ1 chains into one group');
    assert.ok(presentedRefs.includes('stream-zh#1'));
    assert.equal(records[1].ref, 42, 'non-string refs pass through untouched and never group');
    assert.equal(records[2].ref, undefined, 'records without parseable turn refs are never grouped');
    // JSON round-trip stability for Unicode content.
    const reparsed = JSON.parse(JSON.stringify(evidencePack));
    assert.deepEqual(reparsed, JSON.parse(JSON.stringify(consolidateMemoryEvidencePack(input).evidencePack)));
  });

  test('opaque hashed refs with adjacent turn fields do not group — coordinates must come from refs', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'catslog:ref:bbbbbbbbbbbbbbbbbbbbbbbb', turn: 5 }),
          sessionRecord({ ref: 'catslog:ref:cccccccccccccccccccccccc', turn: 6 }),
        ],
      },
      localKnowledge: { entries: [] },
    };
    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    const records = (evidencePack.session_records as any).records;
    assert.equal(diagnostics.session_groups_formed, 0, 'opaque refs cannot prove a shared stream');
    assert.equal(records.length, 2);
  });
});

describe('consolidateMemoryEvidencePack — degraded lanes stay explicit', () => {
  test('failure placeholders, truncation flags, and cursors survive packing verbatim', () => {
    const input = {
      remoteBranch: { branches: [], note: 'CatsLog branch retrieval failed: connection reset' },
      sessionRecords: { status: 'unavailable', note: 'CatsLog session query failed: catslog_capability_unavailable' },
      localKnowledge: {
        content_trust: 'local_distilled_knowledge',
        provenance: 'local_knowledge',
        scope: 'per_instance_shared',
        status: 'unavailable',
        note: 'Local knowledge lane did not produce a usable result.',
      },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);
    assert.deepEqual(evidencePack.remote_branch, input.remoteBranch, 'failure note must survive untouched');
    assert.deepEqual(evidencePack.session_records, input.sessionRecords);
    assert.deepEqual(evidencePack.local_knowledge, input.localKnowledge);
    assert.deepEqual(presentedRefs, [], 'no refs are invented for degraded lanes');
    assert.equal(diagnostics.refs_presented, 0);
    assert.equal(diagnostics.session_groups_formed, 0);
    assert.equal(diagnostics.remote_truncated, false);
  });

  test('upstream truncated flags and next_cursor survive even when dedup frees space', () => {
    const input = {
      remoteBranch: { branches: [{ source: 'session_graph', items: [remoteItem(), remoteItem()], truncated: true }], truncated: true },
      sessionRecords: {
        content_trust: 'untrusted_log_data',
        records: [sessionRecord(), sessionRecord()],
        truncated: true,
        next_cursor: 'cur-9',
      },
      localKnowledge: { entries: [knowledgeEntry()], truncated: true, entries_capped: true },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);
    const session = evidencePack.session_records as Record<string, unknown>;
    assert.equal(session.truncated, true, 'dropped data stays dropped — truncation is never un-reported');
    assert.equal(session.next_cursor, 'cur-9', 'cursors survive packing');
    assert.equal((session.records as unknown[]).length, 1);
    assert.equal((evidencePack.remote_branch as any).truncated, true);
    assert.equal((evidencePack.local_knowledge as any).truncated, true);
    assert.equal((evidencePack.local_knowledge as any).entries_capped, true);
    assert.deepEqual(presentedRefs, ['stream-release#12', 'kb:KB-1b2f3c4d-1111-2222-3333-444455556666']);
    assert.equal(diagnostics.session_duplicates_removed, 1);
  });
});

describe('consolidateMemoryEvidencePack — char budgets stay honest', () => {
  test('oversized lanes tail-drop with visible omissions, and omitted refs never reach presentedRefs', () => {
    const manySessionRecords = Array.from({ length: 6 }, (_, index) =>
      sessionRecord({
        ref: `stream-s#${index + 1}`,
        turn: index + 1,
        user: { text: `synthetic filler user text ${index} — padded to consume budget quickly` },
        agent: { text: `synthetic filler agent text ${index} — padded to consume budget quickly` },
      }));
    const manyEntries = Array.from({ length: 5 }, (_, index) =>
      knowledgeEntry({
        ref: `file:documents/note-${index}.md`,
        id: `file:documents/note-${index}.md`,
        summary: `synthetic knowledge summary ${index} — padded to consume the knowledge budget quickly`,
      }));

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack({
      remoteBranch: { branches: [] },
      sessionRecords: { content_trust: 'untrusted_log_data', records: manySessionRecords, truncated: false },
      localKnowledge: { entries: manyEntries, status: 'ok', truncated: false },
    }, { maxSessionChars: 1_400, maxKnowledgeChars: 900 });

    const session = evidencePack.session_records as Record<string, unknown>;
    const knowledge = evidencePack.local_knowledge as Record<string, unknown>;
    assert.ok(laneChars(session) <= 1_400, `session lane must respect its cap: ${laneChars(session)}`);
    assert.ok(laneChars(knowledge) <= 900, `knowledge lane must respect its cap: ${laneChars(knowledge)}`);
    assert.equal(session.truncated, true);
    assert.equal(knowledge.truncated, true);
    assert.equal(knowledge.status, 'truncated', 'knowledge drops flip the lane status visibly');
    assert.ok((diagnostics.session_omitted_records as number) > 0);
    assert.ok((diagnostics.knowledge_omitted_entries as number) > 0);
    assert.equal(diagnostics.session_records_in, 6);
    assert.equal(diagnostics.session_records_out + (diagnostics.session_omitted_records as number), 6);

    // Ref honesty: presentedRefs == refs visible in the final pack, nothing more.
    const visibleRefs = new Set(presentedRefs);
    for (const record of session.records as any[]) {
      const refs = record.type === SESSION_TURN_GROUP_TYPE ? record.refs : [record.ref];
      for (const ref of refs) assert.ok(visibleRefs.has(ref), `presented ref ${ref} missing from presentedRefs`);
    }
    for (const entry of knowledge.entries as any[]) {
      assert.ok(visibleRefs.has(entry.ref), `presented ref ${entry.ref} missing from presentedRefs`);
    }
    const allInputRefs = [
      ...manySessionRecords.map(record => record.ref),
      ...manyEntries.map(entry => entry.ref),
    ];
    for (const ref of allInputRefs) {
      const isVisible = (session.records as any[]).some((record: any) =>
        record.type === SESSION_TURN_GROUP_TYPE ? record.refs.includes(ref) : record.ref === ref)
        || (knowledge.entries as any[]).some((entry: any) => entry.ref === ref);
      assert.equal(presentedRefs.includes(ref as string), isVisible, `ref honesty violated for ${ref}`);
    }
    // Speaker/date honesty on whatever survived.
    for (const record of session.records as any[]) {
      const members = record.type === SESSION_TURN_GROUP_TYPE ? record.records : [record];
      for (const member of members) {
        assert.ok(member.user || member.agent, 'retained records keep speaker fields');
        assert.equal(member.log_date, '2026-09-01');
      }
    }
  });

  test('remote lane cap drops tail items first and keeps branch envelopes visible', () => {
    const bigText = 'x'.repeat(400);
    const input = {
      remoteBranch: {
        content_trust: 'untrusted_branch_evidence',
        branches: [
          { source: 'session_graph', status: 'ok', items: Array.from({ length: 10 }, (_, index) => remoteItem({ ref: `stream-big#${index + 1}`, text: bigText })) },
          { source: 'graph', status: 'timeout', items: [] },
        ],
      },
      sessionRecords: { records: [] },
      localKnowledge: { entries: [] },
    };
    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input, { maxRemoteChars: 3_000 });
    const remote = evidencePack.remote_branch as Record<string, unknown>;
    assert.ok(laneChars(remote) <= 3_000, `remote lane must respect its cap: ${laneChars(remote)}`);
    assert.equal(remote.truncated, true);
    assert.ok((diagnostics.remote_omitted_items as number) > 0);
    const branches = remote.branches as any[];
    assert.equal(branches[1].status, 'timeout', 'a failed branch envelope survives item drops');
    assert.ok(presentedRefs.every(ref => ref.startsWith('stream-big#')), 'no invented refs after capping');
  });

  test('defaults match the current lane budgets', () => {
    assert.equal(MAX_REMOTE_EVIDENCE_CHARS, 20_000);
    assert.equal(MAX_SESSION_EVIDENCE_CHARS, 12_000);
    assert.equal(MAX_KNOWLEDGE_EVIDENCE_CHARS, 8_000);
  });
});

describe('consolidateMemoryEvidencePack — determinism and purity', () => {
  test('same input yields identical output; input is never mutated; outputs are fresh clones', () => {
    const input = {
      remoteBranch: {
        branches: [
          { source: 'session_graph', items: [remoteItem(), remoteItem({ ref: 'stream-release#13', text: TEXT_C, score_hint: 0.5 })] },
          { source: 'agent_memory', items: [remoteItem()] },
        ],
        truncated: false,
      },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-a#5', turn: 5 }),
          sessionRecord({ ref: 'stream-a#6', turn: 6 }),
          sessionRecord({ ref: 'stream-a#5', turn: 5 }),
        ],
        truncated: false,
        next_cursor: 'cursor-1',
      },
      localKnowledge: { entries: [knowledgeEntry(), knowledgeEntry()], truncated: false },
    };
    const snapshot = JSON.stringify(input);

    const first = consolidateMemoryEvidencePack(input);
    const second = consolidateMemoryEvidencePack(input);
    assert.equal(JSON.stringify(first.evidencePack), JSON.stringify(second.evidencePack), 'deterministic pack');
    assert.deepEqual(first.presentedRefs, second.presentedRefs, 'deterministic presentedRefs');
    assert.deepEqual(first.diagnostics, second.diagnostics, 'deterministic diagnostics');
    assert.equal(JSON.stringify(input), snapshot, 'input is never mutated');

    // Objects inside the pack are clones, not aliases of input records.
    const outputRecord = (first.evidencePack.session_records as any).records[0].records?.[0]
      ?? (first.evidencePack.session_records as any).records[0];
    assert.notEqual(outputRecord, (input.sessionRecords.records as unknown[])[0], 'no shared references with input');

    // Invalid option values fall back to the defaults instead of corrupting budgets.
    const withBadOptions = consolidateMemoryEvidencePack(input, {
      maxRemoteChars: 0,
      maxSessionChars: Number.NaN,
      maxKnowledgeChars: -5,
    });
    assert.equal(JSON.stringify(withBadOptions.evidencePack), JSON.stringify(first.evidencePack), 'invalid options fall back to defaults');
  });

  test('key order, not just content, is stable across runs', () => {
    const input = {
      remoteBranch: { branches: [{ source: 's', items: [remoteItem()] }] },
      sessionRecords: { records: [sessionRecord()] },
      localKnowledge: { entries: [knowledgeEntry()] },
    };
    const a = JSON.stringify(consolidateMemoryEvidencePack(input).evidencePack);
    const b = JSON.stringify(consolidateMemoryEvidencePack(input).evidencePack);
    assert.equal(a, b);
    assert.ok(a.indexOf('"content_trust"') < a.indexOf('"remote_branch"'), 'top-level key order is fixed');
  });
});

describe('consolidateMemoryEvidencePack — packing bench on synthetic repeats', () => {
  test('repeated fan-out shrinks the pack meaningfully with zero distinct-fact or ref loss', () => {
    const distinctTexts = Array.from({ length: 30 }, (_, index) =>
      `synthetic evidence ${index}: pin the migration window and record the rollback owner for component-${index}`);
    const branchSources = ['session_graph', 'agent_memory', 'graph', 'skill'];
    const repeatedItems = branchSources.map(source => ({
      source,
      status: 'ok',
      items: distinctTexts.map((text, index) => remoteItem({
        ref: `stream-bench#${index + 1}`,
        text,
        score_hint: 0.5,
        kind: 'session_turn',
      })),
    }));

    const sessionRecords = [
      ...distinctTexts.slice(0, 10).map((text, index) => sessionRecord({
        ref: `stream-sessions#${index + 1}`,
        turn: index + 1,
        user: { text },
      })),
      // Repeat half of them (byte-identical, same refs).
      ...distinctTexts.slice(0, 5).map((text, index) => sessionRecord({
        ref: `stream-sessions#${index + 1}`,
        turn: index + 1,
        user: { text },
      })),
    ];
    const entries = [
      ...Array.from({ length: 6 }, (_, index) => knowledgeEntry({
        ref: `file:documents/bench-${index}.md`,
        id: `file:documents/bench-${index}.md`,
        summary: `bench summary ${index} with distinct operational guidance`,
      })),
      ...Array.from({ length: 6 }, (_, index) => knowledgeEntry({
        ref: `file:documents/bench-${index}.md`,
        id: `file:documents/bench-${index}.md`,
        summary: `bench summary ${index} with distinct operational guidance`,
      })),
    ];

    const input = {
      remoteBranch: { content_trust: 'untrusted_branch_evidence', branches: repeatedItems, truncated: false },
      sessionRecords: { content_trust: 'untrusted_log_data', records: sessionRecords, truncated: false },
      localKnowledge: { content_trust: 'local_distilled_knowledge', entries, status: 'ok', truncated: false },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);
    const charsIn = (diagnostics.remote_chars_in as number)
      + (diagnostics.session_chars_in as number)
      + (diagnostics.knowledge_chars_in as number);
    const charsOut = (diagnostics.remote_chars_out as number)
      + (diagnostics.session_chars_out as number)
      + (diagnostics.knowledge_chars_out as number);

    // Meaningful reduction, expressed in characters only (this is a packing
    // audit, not a token-savings claim).
    const reduction = 1 - charsOut / charsIn;
    assert.ok(reduction > 0.4, `expected >40% char reduction on the repeat fixture, got ${(reduction * 100).toFixed(1)}%`);

    // Perfect distinct-fact preservation: every distinct text survives exactly once per lane.
    const remoteItems = (evidencePack.remote_branch as any).branches.flatMap((branch: any) => branch.items);
    assert.equal(remoteItems.length, 30, `remote collapses to the distinct set (got ${remoteItems.length})`);
    assert.equal(diagnostics.remote_duplicates_removed, 90);
    for (const text of distinctTexts) {
      assert.equal(remoteItems.filter((item: any) => item.text === text).length, 1, `text lost: ${text}`);
    }
    const sessionOut = (evidencePack.session_records as any).records;
    assert.equal(diagnostics.session_duplicates_removed, 5);
    for (const text of distinctTexts.slice(0, 10)) {
      assert.ok(sessionOut.some((entry: any) => (entry.records ?? [entry]).some((member: any) => member.user.text === text)));
    }
    const knowledgeOut = (evidencePack.local_knowledge as any).entries;
    assert.equal(knowledgeOut.length, 6);
    assert.equal(diagnostics.knowledge_duplicates_removed, 6);

    // Perfect ref preservation: all 46 distinct refs stay presented.
    assert.equal(presentedRefs.length, 30 + 10 + 6);
    assert.equal(diagnostics.refs_presented, presentedRefs.length);
    assert.ok(presentedRefs.includes('stream-bench#1'));
    assert.ok(presentedRefs.includes('stream-sessions#10'));
    assert.ok(presentedRefs.includes('file:documents/bench-5.md'));
  });
});

describe('consolidateMemoryEvidencePack — observed-refs guard wiring', () => {
  test('presentedRefs feed the tracker fail-closed: presented pass, omitted stay unobserved', () => {
    const filler = 'z'.repeat(300);
    const { evidencePack, presentedRefs } = consolidateMemoryEvidencePack({
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          ...Array.from({ length: 8 }, (_, index) => sessionRecord({
            ref: `stream-guard#${index + 1}`,
            turn: index + 1,
            user: { text: `${filler} ${index}` },
          })),
        ],
      },
      localKnowledge: { entries: [] },
    }, { maxSessionChars: 1_500 });

    const tracker = new CatsLogObservedRefsTracker();
    // Coordinator wiring under test: tracker-only input of exactly the
    // presented refs (MAX_WALK_DEPTH=6 cannot reach every nested ref when
    // the whole pack is fed as one result, so the flat feed is load-bearing).
    tracker.recordToolResult('consolidated_pack', JSON.stringify({ refs: presentedRefs }));
    assert.deepEqual(tracker.unobservedRefs(presentedRefs), [], 'every presented ref must clear the finish guard');

    const packJson = JSON.stringify(evidencePack);
    const omitted = ['stream-guard#1', 'stream-guard#2', 'stream-guard#3', 'stream-guard#4', 'stream-guard#5', 'stream-guard#6', 'stream-guard#7', 'stream-guard#8']
      .filter(ref => !presentedRefs.includes(ref));
    assert.ok(omitted.length > 0, 'fixture must actually drop refs for this test to be meaningful');
    assert.ok(omitted.every(ref => !packJson.includes(ref)), 'omitted refs must not linger in the pack text');
    const secondTracker = new CatsLogObservedRefsTracker();
    secondTracker.recordToolResult('consolidated_pack', JSON.stringify({ refs: presentedRefs }));
    assert.ok(secondTracker.unobservedRefs(omitted).length === omitted.length, 'omitted refs stay unobserved (audit downgrade, not silent pass)');
  });

  test('group flat refs are reachable by the real tracker walk from the pack JSON alone', () => {
    const { evidencePack, presentedRefs } = consolidateMemoryEvidencePack({
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-flat#1', turn: 1, user: { text: 'a' } }),
          sessionRecord({ ref: 'stream-flat#2', turn: 2, user: { text: 'b' } }),
        ],
      },
      localKnowledge: { entries: [] },
    });
    const tracker = new CatsLogObservedRefsTracker();
    tracker.recordToolResult('session_lane', JSON.stringify(evidencePack.session_records));
    for (const ref of presentedRefs) {
      assert.deepEqual(tracker.unobservedRefs([ref]), [], `group flat ref ${ref} must be walk-reachable from the lane JSON`);
    }
  });
});

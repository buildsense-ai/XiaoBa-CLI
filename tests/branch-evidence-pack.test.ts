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
  test('duplicates collapse within an envelope identity, and both duplicated items keep their refs presented', () => {
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
            // Identical envelope identity (source/status/verdict) — shares a dedup key space.
            source: 'session_graph',
            status: 'ok',
            evidence_verdict: 'weak',
            elapsed_ms: 11,
            truncated: false,
            items: [
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
    assert.equal((branches[1].items as unknown[]).length, 0, 'later duplicate copies within the same envelope identity are removed');
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

  test('the same item under session_graph(none) vs skill vs agent_memory survives in every envelope', () => {
    const item = () => remoteItem({ text: 'shared fact: rollout paused at 40%' });
    const input = {
      remoteBranch: {
        content_trust: 'untrusted_branch_evidence',
        branches: [
          { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [item()], truncated: false },
          { source: 'skill', status: 'ok', items: [item()], truncated: false },
          { source: 'agent_memory', status: 'ok', items: [item()], truncated: false },
        ],
        truncated: false,
      },
      sessionRecords: { records: [] },
      localKnowledge: { entries: [] },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);
    const branches = (evidencePack.remote_branch as any).branches;
    assert.equal(diagnostics.remote_duplicates_removed, 0, 'different envelope identities never collapse into each other');
    assert.equal(branches[0].items.length, 1, 'the none-verdict copy stays in its own branch');
    assert.equal(branches[1].items.length, 1, 'the skill copy survives');
    assert.equal(branches[2].items.length, 1, 'the agent_memory copy survives');
    assert.equal(branches[0].evidence_verdict, 'none', 'verdict annotations stay truthful per branch');
    assert.deepEqual(presentedRefs, ['stream-release#12']);
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

describe('consolidateMemoryEvidencePack — realistic packing audit', () => {
  test('already-unique realistic input is byte-identical: zero overhead, zero omissions', () => {
    // 3 branches with already-distinct items, 20 unique session records
    // across 3 streams (rerank order — no adjacent-turn runs), deduped KB.
    const branchItems = (source: string, offset: number) => Array.from({ length: 10 }, (_, index) =>
      remoteItem({
        ref: `stream-${source}#${offset + index + 1}`,
        text: `${source} evidence ${offset + index}: pin the migration window and record the rollback owner`,
        score_hint: 0.5,
      }));
    const streamLayouts: Array<[string, number[]]> = [
      ['alpha', [3, 7, 11, 15, 19, 23, 27, 31]],
      ['beta', [2, 5, 9, 14, 18, 22]],
      ['gamma', [4, 8, 13, 17, 21, 26]],
    ];
    const sessionRecords = streamLayouts.flatMap(([stream, turns]) =>
      turns.map(turn => sessionRecord({
        ref: `stream-${stream}#${turn}`,
        turn,
        session_id: `chat:${stream}-planning`,
        user: { text: `unique ${stream} turn ${turn} with distinct operational detail` },
      })));
    const entries = Array.from({ length: 8 }, (_, index) => knowledgeEntry({
      ref: `file:documents/note-${index}.md`,
      id: `file:documents/note-${index}.md`,
      summary: `unique knowledge note ${index} with distinct guidance`,
    }));
    const input = {
      remoteBranch: {
        content_trust: 'untrusted_branch_evidence',
        branches: [
          { source: 'session_graph', status: 'ok', evidence_verdict: 'weak', items: branchItems('session_graph', 0), truncated: false },
          { source: 'agent_memory', status: 'ok', items: branchItems('agent_memory', 20), truncated: false },
          { source: 'skill', status: 'ok', items: branchItems('skill', 40), truncated: false },
        ],
        truncated: false,
      },
      sessionRecords: { content_trust: 'untrusted_log_data', records: sessionRecords, truncated: false },
      localKnowledge: { content_trust: 'local_distilled_knowledge', entries, status: 'ok', truncated: false },
    };

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);

    // Byte identity per lane: consolidation is a no-op on unique input.
    assert.equal(JSON.stringify(evidencePack.remote_branch), JSON.stringify(input.remoteBranch), 'remote lane is byte-identical');
    assert.equal(JSON.stringify(evidencePack.session_records), JSON.stringify(input.sessionRecords), 'session lane is byte-identical');
    assert.equal(JSON.stringify(evidencePack.local_knowledge), JSON.stringify(input.localKnowledge), 'knowledge lane is byte-identical');
    assert.equal(diagnostics.remote_duplicates_removed, 0);
    assert.equal(diagnostics.session_duplicates_removed, 0);
    assert.equal(diagnostics.session_groups_formed, 0, 'no adjacent-turn runs — no grouping overhead');
    assert.equal(diagnostics.session_groups_unrolled, 0);
    assert.equal(diagnostics.session_omitted_records, 0);
    assert.equal(diagnostics.remote_omitted_items, 0);
    assert.equal(diagnostics.knowledge_omitted_entries, 0);
    assert.equal(presentedRefs.length, 30 + 20 + 8, 'every source ref presented exactly once');
    // No savings claim: reduction on unique realistic input is zero by contract.
    assert.equal(diagnostics.session_chars_out, diagnostics.session_chars_in);
    assert.equal(diagnostics.remote_chars_out, diagnostics.remote_chars_in);
    assert.equal(diagnostics.knowledge_chars_out, diagnostics.knowledge_chars_in);
  });

  test('same-envelope repeats still collapse mechanically; group size is bounded', () => {
    // Two branches with IDENTICAL envelope identity carrying byte-identical
    // items — the only legitimate remote dedup scope.
    const duplicateBranch = () => ({
      source: 'session_graph',
      status: 'ok',
      evidence_verdict: 'weak',
      items: Array.from({ length: 10 }, (_, index) =>
        remoteItem({ ref: `stream-dup#${index + 1}`, text: `repeatable fact ${index} stated once per envelope copy` })),
      truncated: false,
    });
    const sessionWithRuns = [
      ...Array.from({ length: 6 }, (_, index) => sessionRecord({
        ref: `stream-runs#${index + 1}`,
        turn: index + 1,
        user: { text: `run turn ${index + 1}` },
      })),
      ...Array.from({ length: 3 }, (_, index) => sessionRecord({
        ref: `stream-runs#${index + 1}`,
        turn: index + 1,
        user: { text: `run turn ${index + 1}` },
      })),
    ];
    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack({
      remoteBranch: { content_trust: 'untrusted_branch_evidence', branches: [duplicateBranch(), duplicateBranch()], truncated: false },
      sessionRecords: { content_trust: 'untrusted_log_data', records: sessionWithRuns, truncated: false },
      localKnowledge: { entries: [] },
    });

    assert.equal(diagnostics.remote_duplicates_removed, 10, 'identical-envelope copies collapse');
    assert.equal(diagnostics.remote_items_out, 10);
    assert.equal(diagnostics.session_duplicates_removed, 3);
    assert.equal(diagnostics.session_groups_formed, 2, '6 consecutive turns form two max-size groups (4+2)');
    const groups = (evidencePack.session_records as any).records;
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].turns, [1, 2, 3, 4], 'group size is bounded by MAX_SESSION_GROUP_MEMBERS');
    assert.deepEqual(groups[1].turns, [5, 6]);
    assert.equal(presentedRefs.filter(ref => ref.startsWith('stream-dup#')).length, 10);
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

describe('consolidateMemoryEvidencePack — grouping never displaces facts', () => {
  function consecutiveFixture(count: number, textLength: number) {
    return Array.from({ length: count }, (_, index) => sessionRecord({
      ref: `stream-r#${index + 1}`,
      turn: index + 1,
      user: { text: 'x'.repeat(textLength) },
      agent: { text: 'y' },
    }));
  }

  test('20 consecutive refs that fit at 12k keep every record: grouped overhead unrolls, byte-identical', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: { content_trust: 'untrusted_log_data', records: consecutiveFixture(20, 350), truncated: false },
      localKnowledge: { entries: [] },
    };
    const plain = JSON.stringify(input.sessionRecords);
    assert.ok(plain.length <= MAX_SESSION_EVIDENCE_CHARS && plain.length > 11_000,
      `fixture must sit just under the budget, got ${plain.length}`);

    const { evidencePack, presentedRefs, diagnostics } = consolidateMemoryEvidencePack(input);
    const session = evidencePack.session_records as Record<string, unknown>;
    // Grouping DID form (so its overhead was real), but never cost a record.
    assert.ok((diagnostics.session_groups_formed as number) > 0);
    assert.ok((diagnostics.session_groups_unrolled as number) > 0, 'groups unrolled instead of displacing records');
    assert.equal(diagnostics.session_omitted_records, 0, 'zero extra omission from wrappers');
    assert.equal(diagnostics.session_records_out, 20);
    assert.equal(session.truncated, false, 'no NEW truncation markers for a lane that fits ungrouped');
    assert.equal(JSON.stringify(session), plain, 'output is byte-identical to the plain input');
    assert.equal(presentedRefs.length, 20);
  });

  test('15 consecutive refs just under 12k: same guarantee', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: { content_trust: 'untrusted_log_data', records: consecutiveFixture(15, 550), truncated: false },
      localKnowledge: { entries: [] },
    };
    const plain = JSON.stringify(input.sessionRecords);
    assert.ok(plain.length <= MAX_SESSION_EVIDENCE_CHARS && plain.length > 11_000,
      `fixture must sit just under the budget, got ${plain.length}`);

    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    assert.equal(diagnostics.session_omitted_records, 0);
    assert.equal(diagnostics.session_records_out, 15);
    assert.equal(JSON.stringify((evidencePack.session_records as any)), plain);
  });

  test('genuinely overflowing input drops individual records, never a whole group as a unit', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: { content_trust: 'untrusted_log_data', records: consecutiveFixture(30, 290), truncated: false },
      localKnowledge: { entries: [] },
    };
    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    const session = evidencePack.session_records as Record<string, unknown>;
    const kept = (session.records as unknown[]).length;
    assert.ok(kept < 30, 'overflow must drop something');
    assert.equal(diagnostics.session_omitted_records, 30 - kept);
    assert.ok(diagnostics.session_groups_unrolled as number > 0, 'groups unrolled before dropping');
    // Kept entries are plain records in input order — no partial group survived as a wrapper.
    for (const entry of session.records as any[]) {
      assert.equal(entry.type, undefined);
      assert.equal(entry.session_id, 'chat:release-planning');
    }
    assert.equal((session.records as any[])[0].ref, 'stream-r#1', 'input order preserved from the front');
    assert.ok(JSON.stringify(session).length <= MAX_SESSION_EVIDENCE_CHARS);
  });
});

describe('consolidateMemoryEvidencePack — hard budgets and bounded overflow', () => {
  test('boundary: exactly-at-budget fits untouched; budget-1 drops the minimum with markers counted', () => {
    const entries = Array.from({ length: 3 }, (_, index) => knowledgeEntry({
      ref: `file:documents/b-${index}.md`,
      id: `file:documents/b-${index}.md`,
      summary: `bounded summary ${index}`,
    }));
    const lane = { content_trust: 'local_distilled_knowledge', entries, status: 'ok', truncated: false };
    const exact = JSON.stringify(lane).length;

    const fits = consolidateMemoryEvidencePack(
      { remoteBranch: { branches: [] }, sessionRecords: { records: [] }, localKnowledge: lane },
      { maxKnowledgeChars: exact },
    );
    assert.equal((fits.diagnostics.knowledge_omitted_entries as number), 0);
    assert.equal(fits.diagnostics.knowledge_truncated, false);
    assert.equal(JSON.stringify(fits.evidencePack.local_knowledge).length, exact);

    const tight = consolidateMemoryEvidencePack(
      { remoteBranch: { branches: [] }, sessionRecords: { records: [] }, localKnowledge: lane },
      { maxKnowledgeChars: exact - 40 },
    );
    const tightLane = tight.evidencePack.local_knowledge as Record<string, unknown>;
    assert.ok(JSON.stringify(tightLane).length <= exact - 40, 'marker bytes are counted inside the fits check');
    assert.equal(tightLane.truncated, true);
    assert.equal(tightLane.status, 'truncated');
    assert.equal(tight.diagnostics.knowledge_omitted_entries, 1);
  });

  test('knowledge marker overrun: markers that would exceed the budget force one more drop', () => {
    const entries = Array.from({ length: 3 }, (_, index) => knowledgeEntry({
      ref: `file:documents/m-${index}.md`,
      id: `file:documents/m-${index}.md`,
      summary: `s${index}`.padEnd(40, '.'),
    }));
    const all = JSON.stringify({ entries });
    // Budget = everything minus a few chars: markers (~45B) cannot fit without a drop.
    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(
      { remoteBranch: { branches: [] }, sessionRecords: { records: [] }, localKnowledge: { entries } },
      { maxKnowledgeChars: all.length - 8 },
    );
    const lane = evidencePack.local_knowledge as Record<string, unknown>;
    assert.ok(JSON.stringify(lane).length <= all.length - 8);
    assert.equal(diagnostics.knowledge_omitted_entries, 1);
    assert.equal(lane.truncated, true);
    assert.equal(lane.consolidation_omitted, 1);
  });

  test('remote marker overrun: same guarantee on the branch fan-out', () => {
    const items = Array.from({ length: 3 }, (_, index) => remoteItem({
      ref: `stream-m#${index + 1}`,
      text: 'z'.repeat(60),
    }));
    const all = JSON.stringify({ branches: [{ source: 'session_graph', items }] });
    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(
      { remoteBranch: { branches: [{ source: 'session_graph', items }] }, sessionRecords: { records: [] }, localKnowledge: { entries: [] } },
      { maxRemoteChars: all.length - 8 },
    );
    const lane = evidencePack.remote_branch as Record<string, unknown>;
    assert.ok(JSON.stringify(lane).length <= all.length - 8);
    assert.equal(diagnostics.remote_omitted_items, 1);
    assert.equal(lane.consolidation_omitted_items, 1);
  });

  test('envelope-only overflow degrades to a bounded, explicit failure in all three lanes', () => {
    const hugeNote = 'n'.repeat(6_000);
    const remoteInput = { content_trust: 'untrusted_branch_evidence', request_id: 'req-overflow', branches: [], note: hugeNote };
    const sessionInput = { content_trust: 'untrusted_log_data', records: [], note: hugeNote };
    const knowledgeInput = { content_trust: 'local_distilled_knowledge', status: 'unavailable', entries: [], note: hugeNote };

    const { evidencePack } = consolidateMemoryEvidencePack(
      { remoteBranch: remoteInput, sessionRecords: sessionInput, localKnowledge: knowledgeInput },
      { maxRemoteChars: 1_500, maxSessionChars: 1_500, maxKnowledgeChars: 1_500 },
    );

    for (const [name, lane] of [['remote_branch', evidencePack.remote_branch], ['session_records', evidencePack.session_records], ['local_knowledge', evidencePack.local_knowledge]] as const) {
      const text = JSON.stringify(lane);
      assert.ok(text.length <= 1_500, `${name} overflow envelope must stay within budget, got ${text.length}`);
      assert.equal((lane as any).truncated, true, `${name} must be explicitly truncated`);
      assert.equal((lane as any).consolidation_overflow, true, `${name} must carry the explicit overflow marker`);
      assert.ok(Object.keys(lane as object).length >= 3, `${name} must not be blank`);
    }
    // Status/trust/request_id/note survival whenever the budget allows.
    assert.equal((evidencePack.remote_branch as any).content_trust, 'untrusted_branch_evidence');
    assert.equal((evidencePack.remote_branch as any).request_id, 'req-overflow');
    assert.match((evidencePack.remote_branch as any).note as string, /exceeded|n+/);
    assert.ok(((evidencePack.remote_branch as any).note as string).length < 6_000, 'note is bounded, not dropped silently');
    assert.equal((evidencePack.local_knowledge as any).status, 'unavailable', 'status survives the overflow degradation');
    assert.equal((evidencePack.local_knowledge as any).content_trust, 'local_distilled_knowledge');
  });

  test('tiny budgets still return an explicit bounded marker, never silence', () => {
    const { evidencePack } = consolidateMemoryEvidencePack(
      {
        remoteBranch: { branches: [], note: 'x'.repeat(4_000) },
        sessionRecords: { records: [{ ref: 'stream-t#1', user: { text: 'x'.repeat(4_000) } }] },
        localKnowledge: { entries: [{ ref: 'file:documents/t.md', summary: 'x'.repeat(4_000) }] },
      },
      { maxRemoteChars: 80, maxSessionChars: 80, maxKnowledgeChars: 80 },
    );
    // Remote: envelope-only overflow (nothing droppable) → explicit bounded failure.
    const remote = evidencePack.remote_branch as Record<string, unknown>;
    assert.ok(JSON.stringify(remote).length <= 80, `tiny budget must hold: ${JSON.stringify(remote)}`);
    assert.equal(remote.truncated, true, 'explicit failure marker always present');
    assert.equal(remote.consolidation_overflow, true);
    // Session: the one huge record is droppable → bounded marker degradation.
    const session = evidencePack.session_records as Record<string, unknown>;
    assert.ok(JSON.stringify(session).length <= 80);
    assert.equal(session.truncated, true);
    assert.equal(session.consolidation_omitted, 1);
    assert.ok(Object.keys(session).length >= 3, 'never blank');
    // Knowledge: markers + status flip fit within 80 chars → bounded marker
    // degradation (droppable entry), not overflow. Envelope-only overflow is
    // covered explicitly in the previous test.
    const knowledge = evidencePack.local_knowledge as Record<string, unknown>;
    assert.ok(JSON.stringify(knowledge).length <= 80);
    assert.equal(knowledge.truncated, true);
    assert.equal(knowledge.consolidation_omitted, 1);
    assert.equal(knowledge.status, 'truncated');
    assert.ok(Object.keys(knowledge).length >= 4, 'never blank');
  });
});

describe('consolidateMemoryEvidencePack — monotonic direction and run metadata', () => {
  test('zigzag 5→6→5 never groups the re-appearing turn; descending 9→8→7 groups monotonically', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-z#5', turn: 5, user: { text: 'rev1 of the decision' } }),
          sessionRecord({ ref: 'stream-z#6', turn: 6, user: { text: 'turn six' } }),
          sessionRecord({ ref: 'stream-z#5', turn: 5, user: { text: 'rev2 of the decision — conflicting revision' } }),
          sessionRecord({ ref: 'stream-d#9', turn: 9, user: { text: 'd9' } }),
          sessionRecord({ ref: 'stream-d#8', turn: 8, user: { text: 'd8' } }),
          sessionRecord({ ref: 'stream-d#7', turn: 7, user: { text: 'd7' } }),
        ],
      },
      localKnowledge: { entries: [] },
    };
    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    const records = (evidencePack.session_records as any).records;
    assert.equal(diagnostics.session_groups_formed, 2);
    assert.deepEqual(records[0].turns, [5, 6], 'ascending pair groups');
    assert.equal(records[1].ref, 'stream-z#5', 'same-ref conflicting revision stays OUT of the run (no zigzag)');
    assert.equal(records[1].user.text, 'rev2 of the decision — conflicting revision');
    assert.deepEqual(records[2].turns, [9, 8, 7], 'consistent descending direction groups');
  });

  test('missing metadata never bridges conflicting epochs; unknown-scope records stay preserved', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-e#5', turn: 5, log_date: '2026-08-01' }),
          sessionRecord({ ref: 'stream-e#6', turn: 6, log_date: undefined }),
          sessionRecord({ ref: 'stream-e#7', turn: 7, log_date: '2026-09-01' }),
          sessionRecord({ ref: 'stream-e#8', turn: 8, session_id: undefined }),
        ],
      },
      localKnowledge: { entries: [] },
    };
    // JSON round-trip in the module drops undefined, but drop up front for clarity.
    delete (input.sessionRecords.records[1] as Record<string, unknown>).log_date;
    delete (input.sessionRecords.records[3] as Record<string, unknown>).session_id;

    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    const records = (evidencePack.session_records as any).records;
    assert.equal(diagnostics.session_groups_formed, 0, 'unknown metadata cannot bridge D1→unknown→D2');
    assert.equal(records.length, 4, 'every differently-scoped record preserved individually');
    assert.equal(records[0].log_date, '2026-08-01');
    assert.equal(records[2].log_date, '2026-09-01');
    assert.equal(records[3].session_id, undefined);
  });

  test('a metadata conflict against the run breaks the group even between fully-known records', () => {
    const input = {
      remoteBranch: { branches: [] },
      sessionRecords: {
        records: [
          sessionRecord({ ref: 'stream-f#5', turn: 5, log_date: '2026-08-01' }),
          sessionRecord({ ref: 'stream-f#6', turn: 6, log_date: '2026-08-01' }),
          sessionRecord({ ref: 'stream-f#7', turn: 7, log_date: '2026-09-01' }),
        ],
      },
      localKnowledge: { entries: [] },
    };
    const { evidencePack, diagnostics } = consolidateMemoryEvidencePack(input);
    const records = (evidencePack.session_records as any).records;
    assert.equal(diagnostics.session_groups_formed, 1);
    assert.deepEqual(records[0].turns, [5, 6]);
    assert.equal(records[1].ref, 'stream-f#7', 'epoch change splits the run');
  });
});

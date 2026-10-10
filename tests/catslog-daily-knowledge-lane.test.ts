import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  collectDailyKnowledgeRefs,
  projectDailyKnowledgeLane,
  searchDailyKnowledgeLane,
} from '../src/core/catslog-daily-knowledge-lane';
import { catslogKnowledgeCitationRef, isMemoryCitationRef } from '../src/tools/memory-branch-tools';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';
import type { CatsLogKnowledgeAnchor, CatsLogKnowledgeSourceContent, CatsLogKnowledgeSourcePage } from '../src/utils/catslog-knowledge-types';

// Skill lineage fixtures mirror the server contract in
// internal/store/agent_knowledge_skill_sources.go: a program read is
// metadata_only + per-node node_sources; a node read discloses its own body.
const SKILL_VERSION = 'skv-' + 'c'.repeat(20);
const SKILL_DIGEST = 'b'.repeat(64);
const TURN_DIGEST = 'a'.repeat(64);
const SKILL_NODE_A = 'skn-' + 'd'.repeat(20);
const SKILL_NODE_B = 'skn-' + 'e'.repeat(20);
const PROGRAM_ANCHOR: CatsLogKnowledgeAnchor = { kind: 'skill_program', id: SKILL_VERSION, skill_version_id: SKILL_VERSION, revision: SKILL_DIGEST };
const NODE_A: CatsLogKnowledgeAnchor = { kind: 'skill_node', id: SKILL_NODE_A, skill_version_id: SKILL_VERSION, revision: SKILL_DIGEST };
const NODE_B: CatsLogKnowledgeAnchor = { kind: 'skill_node', id: SKILL_NODE_B, skill_version_id: SKILL_VERSION, revision: SKILL_DIGEST };
const TURN_ANCHOR: CatsLogKnowledgeAnchor = { kind: 'session_query', id: 'turn-1', session_id: 'skill-session', stream_id: 'skill-stream', byte_offset: 0, revision: TURN_DIGEST };

function skillContent(overrides: Partial<CatsLogKnowledgeSourceContent> = {}): CatsLogKnowledgeSourceContent {
  return { anchor: { ...PROGRAM_ANCHOR }, status: 'read', role: 'learning', speaker: 'structure',
    occurred_at: null, text: '', coverage: 'structural_only', truncated: false, redacted: false,
    missing: false, revoked: false, ...overrides };
}
function skillPage(source: CatsLogKnowledgeSourceContent): CatsLogKnowledgeSourcePage {
  return { source, before: [], after: [], before_exhausted: true, after_exhausted: true,
    context_truncated: false, served_at: '2026-10-09T00:00:00Z' };
}
function skillProgramPage(): CatsLogKnowledgeSourcePage {
  return skillPage(skillContent({ reason: 'program_node_mapping', node_sources: [
    { anchor: { ...NODE_A }, source_anchors: [{ ...TURN_ANCHOR }] },
    { anchor: { ...NODE_B }, source_anchors: [{ ...TURN_ANCHOR }] },
  ] }));
}
function skillNodePage(anchor: CatsLogKnowledgeAnchor, text: string): CatsLogKnowledgeSourcePage {
  return skillPage(skillContent({ anchor: { ...anchor }, speaker: 'assistant', text,
    coverage: 'complete', content_hash: `sha256:${'f'.repeat(64)}`,
    source_anchors: [{ ...TURN_ANCHOR }] }));
}
/** Backend whose single read exposes a skill_program via expand edge provenance. */
function skillBackend(overrides: Partial<CatsLogMemoryBackend> = {}): CatsLogMemoryBackend {
  return fakeBackend({
    expandKnowledge: async () => ({ edges: [{
      link: { id: 'akl-skill', kind: 'used', source: PROGRAM_ANCHOR, target: { kind: 'knowledge_entry', id: ENTRY, document_id: DOC, revision: REV } },
      remote: { ...PROGRAM_ANCHOR }, remote_status: 'resolved' }], exhausted: true }),
    readKnowledgeSource: async query => query.anchor.kind === 'skill_node'
      ? skillNodePage(query.anchor, `body of ${query.anchor.id}`)
      : skillProgramPage(),
    ...overrides,
  } as any);
}


const DOC = 'akd-' + 'a'.repeat(24);
const REV = 'akr-' + 'b'.repeat(64);
const ENTRY = 'ake-' + 'c'.repeat(24);

function fakeBackend(overrides: Partial<CatsLogMemoryBackend> = {}): CatsLogMemoryBackend {
  return {
    isAvailable: () => true,
    isKnowledgeRecallAvailable: () => true,
    searchKnowledge: async () => ({
      hits: [{
        document_id: DOC, day: '2026-10-07', entry_id: ENTRY,
        title: 'T', status: 'active', revision: REV,
      }],
      exhausted: true,
    }),
    readKnowledge: async () => ({
      format: 'json' as const,
      page: {
        document_id: DOC, revision: REV, day: '2026-10-07',
        generated_at: '2026-10-07T22:14:09Z', generated_by: 'w',
        entries: [{ id: ENTRY, title: 'T', text: 'full body text', status: 'active' }],
        exhausted: true,
      },
    }),
    ...overrides,
  } as any;
}

describe('daily knowledge lane', () => {
  test('typed corpus citation grammar: well-formed refs are citable, junk is not', () => {
    const ref = catslogKnowledgeCitationRef(DOC, REV, ENTRY);
    assert.ok(ref);
    assert.equal(ref, `catslog:knowledge:${DOC}:${REV}:${ENTRY}`);
    assert.equal(isMemoryCitationRef(ref!), true);
    // Branch-conversation refs and stream#line strings can never masquerade.
    assert.equal(isMemoryCitationRef('catslog:knowledge:x:y:stream/file.jsonl#12'), false);
    assert.equal(catslogKnowledgeCitationRef('bad id', REV, ENTRY), null);
    // Local-KB grammar unchanged.
    assert.equal(isMemoryCitationRef('kb:KB-0123abcd-0000-0000-0000-000000000000'), true);
  });

  test('performs search + bounded actual reads; retained read is citable and readable', async () => {
    let searchCalls = 0;
    let readCalls = 0;
    const readQueries: any[] = [];
    const draftEntry = 'ake-' + 'd'.repeat(24);
    const backend = fakeBackend({
      searchKnowledge: async (query: any) => {
        searchCalls += 1;
        assert.equal(query.query, 'sparse attention');
        // Contract: fresh daily knowledge is EntryStatusDraft and the store
        // default excludes drafts — the Branch mechanical query MUST include
        // them or new knowledge is invisible.
        assert.equal(query.include_draft, true);
        return {
          hits: [
            { document_id: DOC, day: '2026-10-07', entry_id: ENTRY, title: 'T1', status: 'active', revision: REV },
            { document_id: DOC, day: '2026-10-06', entry_id: ENTRY, title: 'T2', status: 'active', revision: REV },
            { document_id: DOC, day: '2026-10-05', entry_id: draftEntry, title: 'T3', status: 'draft', revision: REV },
          ],
          exhausted: true,
        };
      },
      readKnowledge: async (query: any) => {
        readCalls += 1;
        readQueries.push(query);
        return {
          format: 'json' as const,
          page: {
            document_id: DOC, revision: REV, day: '2026-10-07',
            generated_at: '', generated_by: 'w',
            entries: [{ id: ENTRY, title: 'T1', text: 'full body text', status: 'active' }],
            exhausted: true,
          },
        };
      },
    });
    const lane = await searchDailyKnowledgeLane({ backend, queryText: 'sparse attention', keywords: [] });
    assert.equal(searchCalls, 1);
    assert.equal(readCalls, 2); // bounded top-2 actual reads
    assert.equal(readQueries[0].entry_id, ENTRY);
    assert.equal(readQueries[0].revision, REV);
    assert.equal(readQueries[0].format, 'json');
    assert.equal(lane.status, 'truncated'); // 3 hits > 2 reads → more remains
    assert.equal(lane.reads.length, 2);
    assert.equal(lane.reads[0].text, 'full body text');
    assert.equal(lane.reads[0].ref, `catslog:knowledge:${DOC}:${REV}:${ENTRY}`);
    // Draft hits stay visible with their status — draft ≠ verified, but not
    // invisible either.
    assert.equal(lane.hits[2].status, 'draft');
    const projected = projectDailyKnowledgeLane(lane) as any;
    assert.equal(projected.hits[2].status, 'draft');
    assert.equal(projected.reads[0].text, 'full body text');
    assert.match(projected.refs_note, /catslog:knowledge/);
  });

  test('lane refs are collectible for the observed tracker and citable', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: fakeBackend(),
      queryText: 'q', keywords: [], maxReads: 1,
    });
    const refs = collectDailyKnowledgeRefs(lane);
    assert.equal(refs.length, 1);
    assert.equal(isMemoryCitationRef(refs[0]), true);
  });

  test('per-read failure is typed on the read; metadata hits survive', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: fakeBackend({
        readKnowledge: async () => { throw new Error('stale_anchor'); },
      }),
      queryText: 'q', keywords: [],
    });
    assert.equal(lane.status, 'truncated');
    assert.equal(lane.reads.length, 1);
    assert.match(lane.reads[0].read_error!, /stale_anchor/);
    assert.equal(lane.hits.length, 1);
  });

  test('oversized read text is explicitly marked, never silently clipped', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: fakeBackend({
        readKnowledge: async () => ({
          format: 'json' as const,
          page: {
            document_id: DOC, revision: REV, day: '2026-10-07',
            generated_at: '', generated_by: 'w',
            entries: [{ id: ENTRY, title: 'T', text: 'x'.repeat(5_000), status: 'active' }],
            exhausted: true,
          },
        }),
      }),
      queryText: 'q', keywords: [], maxReads: 1,
    });
    assert.equal(lane.status, 'truncated');
    assert.equal(lane.reads[0].text_truncated, true);
    assert.ok(lane.reads[0].text.endsWith('[truncated]'));
  });

  test('no backend / recall disabled is a typed unavailable, never a fake ok', async () => {
    const withoutBackend = await searchDailyKnowledgeLane({ backend: undefined, queryText: 'q', keywords: [] });
    assert.equal(withoutBackend.status, 'unavailable');
    assert.equal(withoutBackend.error, 'catslog_daily_knowledge_unavailable');
    assert.deepEqual(withoutBackend.hits, []);
    assert.deepEqual(withoutBackend.reads, []);

    const disabled = await searchDailyKnowledgeLane({
      backend: { isKnowledgeRecallAvailable: () => false } as any,
      queryText: 'q',
      keywords: [],
    });
    assert.equal(disabled.status, 'unavailable');
    assert.equal(disabled.reads.length, 0);
  });

  test('empty pages are typed empty; server truncation marks the lane truncated', async () => {
    const empty = await searchDailyKnowledgeLane({
      backend: fakeBackend({
        searchKnowledge: async () => ({ hits: [], exhausted: true }),
      }),
      queryText: 'q', keywords: [],
    });
    assert.equal(empty.status, 'empty');

    const truncated = await searchDailyKnowledgeLane({
      backend: fakeBackend({
        searchKnowledge: async () => ({ hits: [{ document_id: DOC, day: 'd', entry_id: ENTRY, title: 'T', status: 'active', revision: REV }], next_cursor: 'more', exhausted: false }),
      }),
      queryText: 'q', keywords: [],
    });
    assert.equal(truncated.status, 'truncated');
    assert.equal(truncated.serverTruncated, true);
  });

  test('provider search failures degrade to a typed unavailable with the reason', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: fakeBackend({
        searchKnowledge: async () => { throw new Error('knowledge_unavailable'); },
      }),
      queryText: 'q', keywords: [],
    });
    assert.equal(lane.status, 'unavailable');
    assert.match(lane.error!, /knowledge_unavailable/);
    assert.deepEqual(lane.reads, []);
  });

  test('abort signal reaches the provider', async () => {
    let observed: AbortSignal | undefined;
    const controller = new AbortController();
    await searchDailyKnowledgeLane({
      backend: fakeBackend({
        searchKnowledge: async (_q: any, signal?: AbortSignal) => {
          observed = signal;
          return { hits: [], exhausted: true };
        },
      }),
      queryText: 'q', keywords: [], signal: controller.signal,
    });
    assert.equal(observed, controller.signal);
  });

  test('newer correction adopted: expand finds supplements edge, remote NEW entry is read as the authoritative update', async () => {
    const OLD_DOC = DOC;
    const NEW_DOC = 'akd-' + 'e'.repeat(24);
    const NEW_ENTRY = 'ake-' + 'f'.repeat(24);
    const NEW_REV = 'akr-' + '9'.repeat(64);
    const expandCalls: any[] = [];
    const readCalls: any[] = [];
    const backend = fakeBackend({
      searchKnowledge: async () => ({
        hits: [{ document_id: OLD_DOC, day: '2026-10-01', entry_id: ENTRY, title: 'Old entry', status: 'active', revision: REV, follow_on: { has_later: true } }],
        exhausted: true,
      }),
      readKnowledge: async (query: any) => {
        readCalls.push(query);
        const isNew = query.document_id === NEW_DOC;
        return {
          format: 'json' as const,
          page: {
            document_id: query.document_id, revision: query.revision, day: '2026-10-07',
            generated_at: '', generated_by: 'w',
            entries: [{
              id: isNew ? NEW_ENTRY : ENTRY,
              title: isNew ? 'Corrected entry' : 'Old entry',
              text: isNew ? 'authoritative corrected body' : 'stale original body',
              status: isNew ? 'draft' : 'active',
            }],
            exhausted: true,
          },
        };
      },
      expandKnowledge: async (query: any) => {
        expandCalls.push(query);
        return {
          edges: [{
            link: { id: 'akl-1', kind: 'supplements', source: { kind: 'knowledge_entry', id: NEW_ENTRY, document_id: NEW_DOC, revision: NEW_REV }, target: { kind: 'knowledge_entry', id: ENTRY, document_id: OLD_DOC, revision: REV } },
            remote: { kind: 'knowledge_entry', id: NEW_ENTRY, document_id: NEW_DOC, revision: NEW_REV },
            remote_status: 'resolved',
          }],
          exhausted: true,
        };
      },
    });
    const lane = await searchDailyKnowledgeLane({ backend, queryText: 'q', keywords: [] });
    // Expansion: exact anchor, both directions, all supported relations.
    assert.equal(expandCalls.length, 1);
    assert.equal(expandCalls[0].anchor.kind, 'knowledge_entry');
    assert.equal(expandCalls[0].anchor.document_id, OLD_DOC);
    assert.equal(expandCalls[0].direction, 'both');
    assert.deepEqual(expandCalls[0].kinds, ['supplements', 'corrects', 'continues', 'derived_from', 'used', 'related']);
    // Remote NEW entry actually read (2 reads total: original + remote).
    assert.equal(readCalls.length, 2);
    assert.equal(readCalls[1].document_id, NEW_DOC);
    const oldRead = lane.reads.find(read => read.ref === `catslog:knowledge:${OLD_DOC}:${REV}:${ENTRY}`)!;
    const newRead = lane.reads.find(read => read.is_remote_update)!;
    assert.equal(newRead.text, 'authoritative corrected body');
    assert.equal(newRead.ref, `catslog:knowledge:${NEW_DOC}:${NEW_REV}:${NEW_ENTRY}`);
    // The stale read is marked with the newer update, and points at the read row.
    assert.equal(oldRead.newer_updates!.length, 1);
    assert.equal(oldRead.newer_updates![0].link_kind, 'supplements');
    assert.equal(oldRead.newer_updates![0].remote_read_ref, newRead.ref);
    // Refs tracker gets both; expansion page recorded as-seen.
    const refs = collectDailyKnowledgeRefs(lane);
    assert.ok(refs.includes(newRead.ref));
    assert.equal(lane.expansions.length, 1);
    assert.equal(lane.expansions[0].edges[0].remote_status, 'resolved');
    const projected = projectDailyKnowledgeLane(lane) as any;
    assert.match(projected.reads[0].newer_updates_note, /内容已呈现/);
  });

  test('revoked / missing remote endpoints are explicit statuses — anchor-only, no fake text', async () => {
    const backend = fakeBackend({
      expandKnowledge: async () => ({
        edges: [
          { link: { kind: 'corrects', target: { kind: 'knowledge_entry', id: ENTRY, document_id: DOC, revision: REV } }, remote: { kind: 'knowledge_entry', id: 'ake-missing', document_id: DOC, revision: REV }, remote_status: 'target_missing' },
          { link: { kind: 'corrects', target: { kind: 'knowledge_entry', id: ENTRY, document_id: DOC, revision: REV } }, remote: { kind: 'knowledge_entry', id: 'ake-revoked', document_id: DOC, revision: REV }, remote_status: 'source_revoked' },
        ],
        exhausted: true,
      }),
    });
    const lane = await searchDailyKnowledgeLane({ backend, queryText: 'q', keywords: [] });
    assert.equal(lane.reads.length, 1); // only the original; no remote fabricated
    assert.ok(!lane.reads.some(read => read.is_remote_update));
    assert.equal(lane.expansions[0].edges.length, 2);
    assert.deepEqual(lane.expansions[0].edges.map(edge => edge.remote_status), ['target_missing', 'source_revoked']);
    // Anchor-only updates carry no remote_read_ref and no content claims.
    const updates = lane.reads[0].newer_updates!;
    assert.equal(updates.length, 2);
    assert.ok(updates.every(update => !update.remote_read_ref));
    const projected = projectDailyKnowledgeLane(lane) as any;
    assert.match(projected.reads[0].newer_updates_note, /仅有锚点信息/);
  });

  test('expansion pages and remote reads are budget-bounded; truncated pages never claim totals', async () => {
    let expandCalls = 0;
    let remoteReadCalls = 0;
    const NEW_DOC = 'akd-' + 'e'.repeat(24);
    const backend = fakeBackend({
      searchKnowledge: async () => ({
        hits: [
          { document_id: DOC, day: '2026-10-01', entry_id: ENTRY, title: 'A', status: 'active', revision: REV },
          { document_id: DOC, day: '2026-10-02', entry_id: ENTRY, title: 'B', status: 'active', revision: REV },
          { document_id: DOC, day: '2026-10-03', entry_id: ENTRY, title: 'C', status: 'active', revision: REV },
        ],
        exhausted: true,
      }),
      readKnowledge: async (query: any) => {
        if (query.document_id === NEW_DOC) remoteReadCalls += 1;
        return {
          format: 'json' as const,
          page: {
            document_id: query.document_id, revision: query.revision, day: '',
            generated_at: '', generated_by: 'w',
            entries: [{ id: ENTRY, title: 'T', text: 'body', status: 'active' }],
            exhausted: true,
          },
        };
      },
      expandKnowledge: async () => {
        expandCalls += 1;
        // Every page claims more: next_cursor present, exhausted false.
        return {
          edges: [{
            link: { kind: 'corrects' },
            remote: { kind: 'knowledge_entry', id: ENTRY, document_id: NEW_DOC, revision: REV },
            remote_status: 'resolved',
          }],
          next_cursor: 'more',
          exhausted: false,
        };
      },
    });
    const lane = await searchDailyKnowledgeLane({ backend, queryText: 'q', keywords: [] });
    assert.equal(expandCalls, 2); // MAX_DAILY_KNOWLEDGE_EXPANDS
    assert.ok(remoteReadCalls <= 2); // MAX_DAILY_KNOWLEDGE_REMOTE_READS
    assert.equal(lane.status, 'truncated');
    assert.ok(lane.expansions.every(expansion => expansion.truncated));
  });

  test('expansion failure is typed on the expansion row; lane still completes', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: fakeBackend({
        expandKnowledge: async () => { throw new Error('capability expired'); },
      }),
      queryText: 'q', keywords: [],
    });
    assert.equal(lane.expansions.length, 1);
    assert.match(lane.expansions[0].error!, /capability expired/);
    assert.equal(lane.reads.length, 1);
    assert.equal(lane.reads[0].text, 'full body text');
    assert.equal(lane.status, 'truncated');
  });

  // ---- Skill lineage (objective 1: real, not narrowed-scope, consumption) ----

  test('proved skill_program read resolves lineage and presents per-node mappings plus node bodies', async () => {
    const lane = await searchDailyKnowledgeLane({ backend: skillBackend(), queryText: 'q', keywords: [] });
    // The server-returned skill anchor was actually dispatched through the
    // budgeted source reader — not summarized away.
    assert.equal(lane.skill_lineage, 'resolved');
    assert.deepEqual(lane.source_errors, []);
    const program = lane.source_reads!.find(row => row.requested_anchor.kind === 'skill_program')!;
    assert.ok(program, 'skill_program read row exists');
    // Program is metadata-only: structure, never a claimed body.
    assert.equal(program.source.status, 'read');
    assert.equal(program.source.disclosure, 'metadata');
    assert.equal(program.source.text, '');
    // Per-node mappings survive verbatim and are NOT collapsed into one union.
    assert.equal(program.source.node_sources!.length, 2);
    assert.deepEqual(program.source.node_sources!.map(m => m.anchor.id), [SKILL_NODE_A, SKILL_NODE_B]);
    assert.equal(lane.budgets!.skill_lineage_nodes, 2);
    // Follow-on node reads use only server-returned node anchors.
    const nodeRows = lane.source_reads!.filter(row => row.requested_anchor.kind === 'skill_node');
    assert.equal(nodeRows.length, 2);
    for (const row of nodeRows) assert.equal(row.source.disclosure, 'text');
    // Per-anchor rows are the truth record for each anchor independently.
    const rows = lane.skill_lineage_anchors!;
    assert.equal(rows.length, 3);
    const programRow = rows.find(row => row.anchor.kind === 'skill_program')!;
    assert.equal(programRow.outcome, 'resolved');
    assert.equal(programRow.node_mappings, 2);
    assert.equal(programRow.body_disclosed, undefined, 'a program read never claims node body');
    assert.ok(rows.filter(r => r.anchor.kind === 'skill_node').every(r => r.outcome === 'resolved' && r.body_disclosed === true));
    // Projection keeps the resolved lineage and its per-node rows.
    const projected = projectDailyKnowledgeLane(lane, 16_000) as any;
    assert.equal(projected.skill_lineage, 'resolved');
    assert.equal(projected.skill_lineage_anchors.length, 3);
    assert.ok(projected.skill_lineage_anchors.every((r: any) => r.presented === true));
  });

  test('server-reported absent mapping stays truthful unsupported with its exact reason', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: skillBackend({
        readKnowledgeSource: async () => skillPage(skillContent({ status: 'unsupported',
          coverage: 'structural_only', reason: 'node_source_mapping_not_captured' })),
      }),
      queryText: 'q', keywords: [],
    });
    assert.equal(lane.skill_lineage, 'unsupported');
    assert.match(lane.skill_lineage_stop_reason!, /skill_lineage_source_unsupported/);
    const row = lane.skill_lineage_anchors![0];
    assert.equal(row.outcome, 'unsupported');
    assert.equal(row.server_reason, 'node_source_mapping_not_captured');
    // No fabricated mapping or body anywhere.
    assert.equal(lane.source_reads![0].source.node_sources, undefined);
    assert.equal(lane.source_reads![0].source.text, '');
    assert.ok(lane.stop_reasons!.includes('skill_lineage_source_unsupported'));
    assert.ok(!lane.stop_reasons!.some(reason => /resolved|claimed/.test(reason)));
    // The gap is stated, not silently dropped.
    const projected = projectDailyKnowledgeLane(lane, 16_000) as any;
    assert.equal(projected.skill_lineage, 'unsupported');
    assert.equal(projected.skill_lineage_anchors[0].outcome, 'unsupported');
  });

  test('missing source reader is unavailable, not unsupported — absence of attempt is not absence of lineage', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: skillBackend({ readKnowledgeSource: undefined } as any),
      queryText: 'q', keywords: [],
    });
    assert.equal(lane.skill_lineage, 'unavailable');
    assert.equal(lane.skill_lineage_stop_reason, 'skill_lineage_reader_unavailable');
    assert.ok(lane.skill_lineage_anchors!.every(row => row.outcome === 'unavailable'));
    assert.deepEqual(lane.source_reads, []);
    assert.ok(lane.stop_reasons!.includes('skill_lineage_reader_unavailable'));
  });

  test('skill version/id mismatch is rejected exactly like every other anchor kind', async () => {
    for (const [label, bad] of [
      ['version', { ...PROGRAM_ANCHOR, skill_version_id: 'skv-' + '9'.repeat(20) }],
      ['program id', { ...PROGRAM_ANCHOR, id: SKILL_VERSION + 'x' }],
      ['revision', { ...PROGRAM_ANCHOR, revision: '9'.repeat(64) }],
    ] as const) {
      const lane = await searchDailyKnowledgeLane({
        backend: skillBackend({
          readKnowledgeSource: async () => skillPage(skillContent({ anchor: { ...bad } })),
        }),
        queryText: 'q', keywords: [],
      });
      assert.equal(lane.source_reads!.length, 0, `${label} mismatch yields no read row`);
      assert.match(lane.source_errors![0].error, /source_identity_mismatch/, label);
      // Rejected, never downgraded to a plausible-looking lineage claim.
      assert.equal(lane.skill_lineage, 'unsupported');
      const row = lane.skill_lineage_anchors![0];
      assert.equal(row.outcome, 'rejected');
      assert.equal(row.stop_reason, 'skill_lineage_identity_mismatch');
      assert.ok(lane.stop_reasons!.includes('skill_lineage_identity_mismatch'));
    }
  });

  test('a fabricated node mapping is dropped and counted; it never merges into the real lineage', async () => {
    const lane = await searchDailyKnowledgeLane({
      backend: skillBackend({ readKnowledgeSource: async () => skillPage(skillContent({ node_sources: [
        { anchor: { ...NODE_A }, source_anchors: [{ ...TURN_ANCHOR }] },
        // Forged: a node belonging to a different program version.
        { anchor: { kind: 'skill_node', id: 'skn-forged', skill_version_id: 'skv-' + '9'.repeat(20), revision: SKILL_DIGEST },
          source_anchors: [{ ...TURN_ANCHOR }] },
      ] })) }),
      queryText: 'q', keywords: [],
    });
    assert.ok(lane.stop_reasons!.includes('skill_node_mapping_identity_mismatch'));
    const program = lane.source_reads!.find(row => row.requested_anchor.kind === 'skill_program')!;
    assert.equal(program.source.node_sources!.length, 1, 'only the proved mapping survives');
    assert.equal(program.source.node_sources![0].anchor.id, SKILL_NODE_A);
    // Follow-on reads are unlocked ONLY by proved mappings.
    assert.ok(lane.source_reads!.every(row => row.requested_anchor.id !== 'skn-forged'));
    assert.equal(lane.skill_lineage, 'resolved');
  });

  test('not_observed spends no presentation budget when no skill anchor exists', async () => {
    const lane = await searchDailyKnowledgeLane({ backend: fakeBackend(), queryText: 'q', keywords: [] });
    assert.equal(lane.skill_lineage, 'not_observed');
    assert.equal(lane.skill_lineage_anchors, undefined);
    const projected = projectDailyKnowledgeLane(lane, 16_000) as any;
    assert.equal(projected.skill_lineage, undefined, 'nothing attempted ⇒ nothing claimed in the bounded view');
    assert.doesNotMatch(JSON.stringify(projected), /skill_lineage/);
  });

  test('skill node follow-on reads stay inside the shared fixed source-read budget', async () => {
    const wire: any[] = [];
    const lane = await searchDailyKnowledgeLane({
      backend: skillBackend({ readKnowledgeSource: async query => { wire.push(query.anchor); return query.anchor.kind === 'skill_node' ? skillNodePage(query.anchor, 'n') : skillProgramPage(); } }),
      queryText: 'q', keywords: [],
    });
    // 1 program + MAX_DAILY_KNOWLEDGE_SKILL_NODE_READS (2) nodes = the whole
    // 3-read budget; the byte cap is unchanged.
    assert.equal(wire.length, 3);
    assert.ok(lane.budgets!.source_reads <= 3);
  });
});

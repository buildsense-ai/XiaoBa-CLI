import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { searchDailyKnowledgeLane, projectDailyKnowledgeLane, collectProjectedDailyKnowledgeRefs } from '../src/core/catslog-daily-knowledge-lane';
import { consolidateMemoryEvidencePack } from '../src/core/branch-evidence-pack';
import { MemorySearchBranchSession, MAX_MEMORY_SOURCE_LOCATORS, MAX_MEMORY_SOURCE_LOCATOR_CHARS } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue, buildSyntheticObservationMessages } from '../src/core/synthetic-observation';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { hashedRecallRef } from '../src/core/native-recall-attribution';
import { isMemoryCitationRef } from '../src/tools/memory-branch-tools';
import { estimateMessagesTokens, estimateToolsTokens } from '../src/core/token-estimator';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';
import type { CatsLogKnowledgeAnchor, CatsLogKnowledgeSourceContent, CatsLogKnowledgeSourcePage } from '../src/utils/catslog-knowledge-types';

const anchor = (n: number): CatsLogKnowledgeAnchor => ({ kind: 'knowledge_entry', document_id: `akd-${String(n).padStart(24, '0')}`, id: `ake-${String(n).padStart(24, '0')}`, revision: `akr-${String(n).padStart(64, '0')}` });
const sourceAnchor = (n: number): CatsLogKnowledgeAnchor => ({ kind: 'session_query', id: `ref_${createHash('sha256').update(`source-stream\0${n * 100}`).digest('hex')}`, session_id: 'source-session', stream_id: 'source-stream', byte_offset: n * 100, revision: String(n).padStart(64, '0') });
const old = anchor(1);
const ref = (a: CatsLogKnowledgeAnchor) => `catslog:knowledge:${a.document_id}:${a.revision}:${a.id}`;
function source(a: CatsLogKnowledgeAnchor, text = 'source body'): CatsLogKnowledgeSourceContent {
  return { anchor: a, status: 'read', role: 'organic', speaker: 'user_assistant', occurred_at: '2026-10-08T00:00:00Z',
    text, content_hash: `sha256:${createHash('sha256').update(text).digest('hex')}`, coverage: 'complete', truncated: false, redacted: true, missing: false, revoked: false };
}
function sourcePage(a: CatsLogKnowledgeAnchor): CatsLogKnowledgeSourcePage {
  return { source: source(a), before: [source(sourceAnchor(98), 'before body')], after: [source(sourceAnchor(99), 'after body')], before_exhausted: true, after_exhausted: false, context_truncated: false, served_at: '2026-10-08T00:00:00Z' };
}
function backend(overrides: Partial<CatsLogMemoryBackend> = {}): CatsLogMemoryBackend {
  return { isAvailable: () => true, isKnowledgeRecallAvailable: () => true,
    searchKnowledge: async () => ({ hits: [{ document_id: old.document_id!, entry_id: old.id, revision: old.revision!, day: '2026-10-08', title: 'release', status: 'active' }], exhausted: true }),
    readKnowledge: async q => ({ format: 'json', page: { document_id: q.document_id, revision: q.revision!, day: '2026-10-08', generated_at: '', generated_by: 'fixture',
      entries: [{ id: q.entry_id!, title: 'release', text: '发布近况'.repeat(25), status: 'active', source_anchors: [sourceAnchor(1)] }], exhausted: true } }),
    expandKnowledge: async () => ({ edges: [], exhausted: true }),
    readKnowledgeSource: async q => sourcePage(q.anchor), ...overrides };
}

test('bounded both-direction relations read real sources, prioritize corrections, and distinguish outgoing updates', async () => {
  const wire: any[] = [];
  const lane = await searchDailyKnowledgeLane({ queryText: 'release task', keywords: ['release'], backend: backend({
    expandKnowledge: async q => {
      wire.push(q);
      return { edges: [
        ...[2, 3, 4].map(n => ({ link: { id: `link-${n}`, kind: 'corrects' as const, source: anchor(n), target: old }, remote: anchor(n), remote_status: 'resolved' as const })),
        { link: { id: 'link-out', kind: 'corrects', source: old, target: anchor(5) }, remote: anchor(5), remote_status: 'resolved' },
        { link: { id: 'link-related', kind: 'related', source: old, target: anchor(6) }, remote: anchor(6), remote_status: 'resolved' },
        { link: { id: 'link-source', kind: 'derived_from', source: old, target: sourceAnchor(7) }, remote: sourceAnchor(7), remote_status: 'resolved' },
        { link: { id: 'link-used', kind: 'used', source: sourceAnchor(8), target: old }, remote: sourceAnchor(8), remote_status: 'resolved' },
      ], exhausted: false, next_cursor: 'more' };
    },
    readKnowledge: async q => ({ format: 'json', page: { document_id: q.document_id, revision: q.revision!, day: '', generated_at: '', generated_by: '',
      entries: [{ id: q.entry_id!, title: 'release', text: `actual ${q.entry_id}`, status: 'active', source_anchors: [sourceAnchor(Number(q.entry_id!.slice(4)))] }], exhausted: true } }),
    readKnowledgeSource: async q => { wire.push(q); return sourcePage(q.anchor); },
  }) });
  assert.equal(wire[0].direction, 'both');
  assert.deepEqual(wire[0].kinds, ['supplements', 'corrects', 'continues', 'derived_from', 'used', 'related']);
  assert.equal(lane.reads.filter(r => r.is_remote_update).length, 2);
  assert.equal(lane.reads.filter(r => r.is_related_read).length, 2);
  assert.equal(lane.reads[0].newer_updates!.length, 3);
  assert.ok(!lane.reads[0].newer_updates!.some(r => r.remote_ref === ref(anchor(5))), 'outgoing correction is historical, not a newer update');
  assert.equal(lane.reads[0].newer_updates![2].remote_read_ref, undefined, 'beyond budget stays anchor only');
  assert.equal(lane.source_reads!.length, 3);
  assert.ok([2, 3].includes(lane.source_reads![0].requested_anchor.byte_offset! / 100), 'correction source prioritized');
  assert.ok(wire.slice(1).every(q => q.before === 1 && q.after === 1 && q.max_bytes === 2048));
  assert.ok(lane.stop_reasons!.includes('update_read_cap'));
  assert.ok(lane.stop_reasons!.includes('relation_page_cap'));
  assert.ok(lane.stop_reasons!.includes('source_read_cap'));
  // No skill anchor appears in this fixture's provenance/expansion edges, so
  // the lane honestly reports "nothing attempted" rather than the old
  // hardcoded 'unsupported' (which implied the server refused to provide one).
  assert.equal(lane.skill_lineage, 'not_observed');
  const projectedLineage = projectDailyKnowledgeLane(lane, 16000) as any;
  assert.equal(projectedLineage.skill_lineage, undefined, 'an unobserved lineage costs no bounded-view budget');
  const view = projectDailyKnowledgeLane(lane, 16000) as any;
  for (const page of view.source_reads) {
    for (const item of [page.source, ...page.before, ...page.after]) {
      assert.equal(item.ref, hashedRecallRef('source', [item.anchor, item.content_hash]));
      assert.equal(isMemoryCitationRef(item.ref), true);
      assert.equal(item.disclosure, 'text');
    }
  }
  assert.notEqual(view.source_reads[0].source.ref, view.source_reads[0].before[0].ref);
});

test('Go canonical omitted-zero raw anchors are accepted and deduplicated without changing wire anchors', async () => {
  const explicitZero = sourceAnchor(0);
  const { byte_offset: _zeroOffset, ...goZero } = explicitZero;
  // Mirrors Go Anchor's json byte_offset,omitempty serialization. Exercise
  // primary zero and a separate page whose before neighbor is the zero turn.
  for (const primary of [explicitZero, sourceAnchor(1)]) {
    let sourceCalls = 0;
    const page: CatsLogKnowledgeSourcePage = JSON.parse(JSON.stringify({
      source: source(primary.byte_offset === 0 ? goZero : primary, 'primary body'),
      before: primary.byte_offset === 0 ? [] : [source(goZero, 'first-turn context')],
      after: [source(sourceAnchor(2), 'later context')], before_exhausted: true, after_exhausted: true,
      context_truncated: false, served_at: '2026-10-08T00:00:00Z',
    }));
    const lane = await searchDailyKnowledgeLane({ queryText: 'q', keywords: [], backend: backend({
      readKnowledge: async q => ({ format: 'json', page: { document_id: q.document_id, revision: q.revision!, day: '', generated_at: '', generated_by: '',
        entries: [{ id: q.entry_id!, title: 'release', text: 'entry', status: 'active', source_anchors: primary.byte_offset === 0 ? [explicitZero, goZero] : [primary] }], exhausted: true } }),
      readKnowledgeSource: async () => { sourceCalls++; return page; },
    }) });
    assert.equal(sourceCalls, 1, 'explicit/omitted zero is one source identity, not two budget slots');
    assert.deepEqual(lane.source_errors, []);
    assert.equal(lane.source_reads!.length, 1);
    const actual = lane.source_reads![0];
    const zeroContent = primary.byte_offset === 0 ? actual.source : actual.before[0];
    assert.equal(Object.hasOwn(zeroContent.anchor, 'byte_offset'), false, 'retain actual Go wire anchor, no coordinate insertion');
    assert.equal(zeroContent.text, primary.byte_offset === 0 ? 'primary body' : 'first-turn context');
    assert.equal(zeroContent.ref, hashedRecallRef('source', [explicitZero, zeroContent.content_hash]));
    assert.equal(zeroContent.ref, hashedRecallRef('source', [goZero, zeroContent.content_hash]));
    assert.notEqual(actual.source.ref, actual.after[0].ref, 'neighbor keeps independent anchor/ref');
    const projected = projectDailyKnowledgeLane(lane, 6000) as any;
    assert.equal(projected.source_reads[0].source.ref, actual.source.ref);
  }
});

test('zero-offset normalization stays in raw domains and nonzero source offset mismatches still fail', async () => {
  const zero = sourceAnchor(0);
  const bad = await searchDailyKnowledgeLane({ queryText: 'q', keywords: [], backend: backend({
    readKnowledge: async q => ({ format: 'json', page: { document_id: q.document_id, revision: q.revision!, day: '', generated_at: '', generated_by: '',
      entries: [{ id: q.entry_id!, title: 'release', text: 'entry', status: 'active', source_anchors: [zero] }], exhausted: true } }),
    readKnowledgeSource: async () => ({ ...sourcePage(zero), source: source({ ...zero, byte_offset: 100 }) }),
  }) });
  assert.equal(bad.source_reads!.length, 0);
  assert.match(bad.source_errors![0].error, /source_identity_mismatch/);
  const { byte_offset: _zeroOffset, ...omitted } = zero;
  for (const kind of ['session_query', 'session_result'] as const) {
    const raw = { ...omitted, kind, ...(kind === 'session_result' ? { byte_length: 20 } : {}) };
    assert.equal(hashedRecallRef('source', [raw, null]), hashedRecallRef('source', [{ ...raw, byte_offset: 0 }, null]));
    assert.notEqual(hashedRecallRef('source', [raw, null]), hashedRecallRef('source', [{ ...raw, byte_offset: 100 }, null]));
    if (kind === 'session_result') {
      const lane = await searchDailyKnowledgeLane({ queryText: 'q', keywords: [], backend: backend({
        readKnowledge: async q => ({ format: 'json', page: { document_id: q.document_id, revision: q.revision!, day: '', generated_at: '', generated_by: '',
          entries: [{ id: q.entry_id!, title: 'release', text: 'entry', status: 'active', source_anchors: [{ ...raw, byte_offset: 0 }] }], exhausted: true } }),
        readKnowledgeSource: async () => ({ ...sourcePage(raw), source: { ...source(raw, ''), status: 'unsupported', coverage: 'structural_only', content_hash: undefined }, before: [], after: [] }),
      }) });
      assert.deepEqual(lane.source_errors, []);
      assert.equal(lane.source_reads![0].source.status, 'unsupported', 'real unsupported rich result is not replaced by a zero-offset identity failure');
      assert.equal(lane.source_reads![0].source.disclosure, 'metadata');
      assert.equal(Object.hasOwn(lane.source_reads![0].source.anchor, 'byte_offset'), false);
    }
  }
  for (const nonRaw of [anchor(1), { kind: 'learning_node', id: 'learning-1', session_id: 'derived-session' }, { kind: 'graph_node', id: 'graph-1', session_id: 's1' }]) {
    assert.notEqual(hashedRecallRef('source', [nonRaw, null]), hashedRecallRef('source', [{ ...nonRaw, byte_offset: 0 }, null]), 'other domains do not gain an implicit raw coordinate');
  }
});

test('source endpoints preserve missing/revoked/stale/unsupported and structural-only without fabricated body', async () => {
  for (const status of ['missing', 'revoked', 'stale', 'unsupported'] as const) {
    const lane = await searchDailyKnowledgeLane({ queryText: 'q', keywords: [], backend: backend({ readKnowledgeSource: async q => ({
      ...sourcePage(q.anchor), source: { ...source(q.anchor, ''), status, content_hash: undefined, coverage: 'structural_only', missing: status === 'missing', revoked: status === 'revoked' }, before: [], after: [],
    }) }) });
    assert.equal(lane.source_reads![0].source.status, status);
    assert.equal(lane.source_reads![0].source.disclosure, 'metadata');
    assert.equal(lane.source_reads![0].source.text, '');
    assert.ok(lane.stop_reasons!.includes(`source_${status}`));
  }
  const structural = await searchDailyKnowledgeLane({ queryText: 'q', keywords: [], backend: backend({ readKnowledgeSource: async q => ({
    ...sourcePage(q.anchor), source: { ...source(q.anchor, ''), content_hash: undefined, coverage: 'structural_only', speaker: 'structure' }, before: [], after: [],
  }) }) });
  assert.equal(structural.source_reads![0].source.disclosure, 'metadata');
  assert.ok(structural.stop_reasons!.includes('source_structural_only'));
});

test('failed or mismatched source read is a real error, not a fake unsupported endpoint', async () => {
  for (const mismatch of [false, true]) {
    const lane = await searchDailyKnowledgeLane({ queryText: 'q', keywords: [], backend: backend({ readKnowledgeSource: async q => {
      if (!mismatch) throw new Error('capability revoked');
      return sourcePage({ ...q.anchor, id: 'different-source' });
    } }) });
    assert.equal(lane.source_reads!.length, 0);
    assert.match(lane.source_errors![0].error, mismatch ? /identity_mismatch/ : /capability revoked/);
    assert.equal(lane.budgets!.source_read_attempts, 1);
  }
});

test('full→refine source refs/body are monotonic and all serialized budgets hold', async () => {
  const lane = await searchDailyKnowledgeLane({ queryText: 'q', keywords: [], backend: backend({ readKnowledgeSource: async q => ({
    ...sourcePage(q.anchor), source: { ...source(q.anchor, '原文🙂'.repeat(1800)), coverage: 'partial', truncated: true },
  }) }) });
  const raw = JSON.stringify(lane);
  const full = projectDailyKnowledgeLane(lane, 8000) as any;
  const fullRefs = new Set(collectProjectedDailyKnowledgeRefs(full));
  for (let cap = 256; cap <= 8000; cap += 128) {
    const refine = projectDailyKnowledgeLane({ ...lane, hits: full.hits ?? [], reads: full.reads ?? [], expansions: full.expansions ?? [], source_reads: full.source_reads ?? [], presentationOmitted: full.presentation_omitted }, cap) as any;
    assert.ok(JSON.stringify(refine).length <= cap, `cap ${cap}`);
    assert.ok(collectProjectedDailyKnowledgeRefs(refine).every(r => fullRefs.has(r)));
    for (const page of refine.source_reads ?? []) {
      const actual = full.source_reads.find((p: any) => p.source.ref === page.source.ref);
      assert.ok(actual.source.text.startsWith(page.source.text));
      if (page.source.text_truncated) assert.equal(page.source.content_hash, undefined, 'wire hash cannot claim to hash a shorter view');
    }
  }
  assert.equal(JSON.stringify(lane), raw, 'raw retrieval remains unchanged');
});

test('one task-clue fallback search is bounded, incomplete empty is not exhausted, and abort stops work', async () => {
  const queries: string[] = [];
  const empty = backend({ searchKnowledge: async q => { queries.push(q.query); return { hits: [], exhausted: true }; } });
  const lane = await searchDailyKnowledgeLane({ backend: empty, queryText: 'long task', keywords: ['release', 'rollback'] });
  assert.deepEqual(queries, ['long task', 'release rollback']);
  assert.equal(lane.status, 'empty');
  const partial = await searchDailyKnowledgeLane({ backend: backend({ searchKnowledge: async () => ({ hits: [], exhausted: false }) }), queryText: 'q', keywords: ['other'] });
  assert.equal(partial.status, 'truncated');
  assert.equal(partial.budgets!.searches, 1);
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const aborted = await searchDailyKnowledgeLane({ backend: backend({ searchKnowledge: async () => { calls++; throw new Error('should not dispatch'); } }), queryText: 'q', keywords: [], signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(aborted.status, 'unavailable');
  assert.match(aborted.error!, /aborted/);
});

test('secondary KB packing retains metadata before excerpts and reports actual prefix coordinates/counters', () => {
  const entries = [1, 2].map(n => ({ ref: `kb:entry-${n}`, title: `metadata-${n}`, revision: 'revision-pin', excerpt: {
    ref: `kb:entry-${n}`, revision: 'revision-pin', text: '\"\\🙂'.repeat(500), char_start: 10, char_end: 2010, omitted_after: false, truncated: false,
  } }));
  const full = consolidateMemoryEvidencePack({ remoteBranch: {}, sessionRecords: {}, localKnowledge: { entries, excerpts_requested: 2, excerpts_retained: 2, excerpts_projected: 2 } });
  const raw = JSON.stringify(full);
  for (let cap = 400; cap <= 1200; cap += 50) {
    const refine = consolidateMemoryEvidencePack({ remoteBranch: {}, sessionRecords: {}, localKnowledge: full.evidencePack.local_knowledge as any }, { maxKnowledgeChars: cap, refineView: { knowledgeExcerptTextChars: 500 } });
    const kb = refine.evidencePack.local_knowledge as any;
    assert.equal(kb.entries.length, 2);
    assert.ok(JSON.stringify(kb).length <= cap);
    assert.equal(kb.excerpts_projected, kb.entries.filter((e: any) => e.excerpt).length);
    for (const entry of kb.entries) {
      assert.equal(entry.revision, 'revision-pin');
      if (entry.excerpt) {
        const text = entry.excerpt.text.replace(/\n\.\.\.\[truncated\]$/, '');
        assert.equal(entry.excerpt.char_end, 10 + text.length);
        assert.equal(entry.excerpt.projection_shortened, true);
      }
    }
    assert.ok(refine.presentedRefs.every(r => full.presentedRefs.includes(r)));
  }
  assert.equal(JSON.stringify(full), raw);
});

const toolCall = (name: string, args: unknown) => ({ id: `coverage-${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
test('finish cannot cite a source omitted from refine even when full audit observed it', () => {
  const session: any = new MemorySearchBranchSession({ sessionKey: 'source-omission-guard', input: 'release', recentMessages: [],
    workingDirectory: os.tmpdir(), aiService: {} as any, queue: new InMemorySyntheticObservationQueue(), logEnabled: false });
  const seenRef = hashedRecallRef('source', [sourceAnchor(1), 'hash']);
  session.observedRefs.recordPresentedRefs([seenRef]);
  session.retrieval.refinePresentation = { presentedRefs: [], evidencePack: {}, diagnostics: {} };
  const decision = session.resolveFinishDecision({ summary: 'unseen source body', refs: [seenRef], inject: true, delivery: 'context' }, 'context');
  assert.equal(decision.delivery, 'audit');
  assert.deepEqual(decision.unobservedRefs, [seenRef]);
  assert.ok(decision.evidence.observedRefs.includes(seenRef));
});
test('injected source locators fit a hard budget, prioritize cited primaries, and exclude uncited/full-only sources and bodies', () => {
  const session: any = new MemorySearchBranchSession({ sessionKey: 'bounded-source-locators', input: 'release', recentMessages: [],
    workingDirectory: os.tmpdir(), aiService: {} as any, queue: new InMemorySyntheticObservationQueue(), logEnabled: false });
  const projected = (item: CatsLogKnowledgeSourceContent) => ({ ...item,
    ref: hashedRecallRef('source', [item.anchor, item.content_hash ?? null]), disclosure: item.text ? 'text' : 'metadata' });
  const pages = [1, 2, 3].map(n => ({ ...sourcePage(sourceAnchor(n)),
    source: projected({ ...source(sourceAnchor(n), `private primary body ${n}`), ...(n === 3 ? { coverage: 'partial' as const, truncated: true } : {}) }),
    before: [projected(source(sourceAnchor(100 + n), `private before body ${n}`))],
    after: [projected(source(sourceAnchor(200 + n), `private after body ${n}`))],
  }));
  const uncited = projected(source(sourceAnchor(777), 'UNCITED-PRIVATE-BODY'));
  pages[0].after.push(uncited);
  const fullOnly = projected(source(sourceAnchor(888), 'FULL-ONLY-PRIVATE-BODY'));
  session.retrieval.presentation = { evidencePack: { daily_knowledge: { source_reads: [{ source: fullOnly, before: [], after: [] }] } } };
  session.retrieval.refinePresentation = { evidencePack: { daily_knowledge: { source_reads: pages } } };
  // Put neighbors first in finish refs: locator retention still prefers the
  // primary for every selected page, independent of payload ref ordering.
  const selected = pages.flatMap(page => [...page.before, ...page.after.filter(item => item.ref !== uncited.ref), page.source]).map(item => item.ref);
  session.observedRefs.recordPresentedRefs(selected);
  session.retrieval.refinePresentation.presentedRefs = selected;
  const observation = session.buildObservation({ summary: 'bounded source summary', refs: selected, delivery: 'context', inject: true });
  const modelMessage = buildSyntheticObservationMessages([observation]).find(message => message.role === 'tool')!;
  const body = JSON.parse(modelMessage.content as string);
  const pack = body.source_locators;
  assert.ok(pack.items.length <= MAX_MEMORY_SOURCE_LOCATORS);
  assert.ok(JSON.stringify(pack).length <= MAX_MEMORY_SOURCE_LOCATOR_CHARS);
  assert.ok(pack.omitted > 0, 'fixture exercises real locator omission');
  assert.equal(pack.omitted, selected.length - pack.items.length);
  assert.deepEqual(pack.items.slice(0, 3).map((item: any) => item.ref), pages.map(page => page.source.ref));
  assert.ok(pack.items.every((item: any) => selected.includes(item.ref)));
  assert.ok(!pack.items.some((item: any) => item.ref === uncited.ref || item.ref === fullOnly.ref));
  assert.ok(!JSON.stringify(body).includes('PRIVATE-BODY'));
  assert.ok(!JSON.stringify(body).includes('private primary body'));
  assert.ok(!JSON.stringify(body).includes('private before body'));
  assert.match(pack.note, /Unmapped refs cannot be read from their hash/);
  assert.ok(pack.items.every((item: any) => item.disclosure === 'metadata' && !('text' in item)));
  const partial = pack.items.find((item: any) => item.ref === pages[2].source.ref);
  assert.equal(partial.coverage, 'partial');
  assert.equal(partial.truncated, true);
  assert.equal(partial.read_content_hash, pages[2].source.content_hash);
});

test('actual two-call Branch retains managed KB with 100-char daily and delivers source/context refs under fixed budgets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-coverage-branch-'));
  const previous = process.env.XIAOBA_USER_DATA_DIR;
  process.env.XIAOBA_USER_DATA_DIR = root;
  const kbId = 'KB-11111111-2222-4333-8444-000000000001';
  const docs = path.join(root, 'knowledge', 'documents'); fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, `${kbId}.md`), `---\n${JSON.stringify({ id: kbId, title: 'release 发布决策', summary: 'release 知识约束', category: 'deploy', updatedAt: '2026-10-07T00:00:00Z', change: 'coverage regression', sources: [] })}\n---\n\nrelease 发布决策 ${'知识更正'.repeat(600)}`);
  const calls: string[] = [];
  const queue = new InMemorySyntheticObservationQueue();
  let pack: any;
  let finishTokens = 0;
  const ai: any = { isToolCallingSupported: () => true, async chat(messages: any[], tools: any[]) {
    const name = tools[0].name; calls.push(name);
    const promptTokens = estimateMessagesTokens(messages) + estimateToolsTokens(tools);
    const usage = { promptTokens, completionTokens: 40, totalTokens: promptTokens + 40 };
    if (name === 'assess_memory_need') return { content: null, toolCalls: [toolCall(name, { action: 'recall', query_text: 'release', keywords: ['release'] })], usage };
    finishTokens = promptTokens;
    pack = JSON.parse(messages.find(m => typeof m.content === 'string' && m.content.startsWith('{"evidence_pack":')).content).evidence_pack;
    assert.equal(pack.local_knowledge.entries.length, 1, 'R1: 100-char daily must not displace metadata');
    assert.ok(pack.local_knowledge.entries[0].excerpt?.text.length > 0, JSON.stringify(pack.local_knowledge));
    const src = pack.daily_knowledge.source_reads[0];
    return { content: null, toolCalls: [toolCall(name, { delivery: 'context', summary: 'release 条件与原 session 投影，含独立邻近节点。', refs: [`kb:${kbId}`, src.source.ref, src.before[0].ref, src.after[0].ref] })], usage };
  }, async chatStream() { throw new Error('unexpected checkpoint'); } };
  try {
    const session: any = new MemorySearchBranchSession({ sessionKey: 'coverage-real-branch', input: 'release 发布决策', recentMessages: [], workingDirectory: root, aiService: ai, queue, catslogMemory: backend(), logEnabled: false });
    await session.run();
    assert.deepEqual(calls, ['assess_memory_need', 'finish_memory_search']);
    assert.ok(finishTokens < 13600);
    assert.ok(JSON.stringify(pack.local_knowledge).length <= 1200);
    assert.ok(JSON.stringify(pack.daily_knowledge).length <= 6000);
    const observed = new Set(session.observedRefs.snapshot().observedRefs);
    assert.ok(session.retrieval.refinePresentation.presentedRefs.every((r: string) => observed.has(r)), 'actual observed tracker contains all refine refs');
    assert.equal(queue.size(), 1, 'successful finish delivered context');
    const delivered = queue.drain()[0];
    assert.equal(delivered.metadata?.refs?.length, 4);
    assert.equal((delivered.metadata?.sourceDisclosures as any[]).length, 3);
    assert.ok((delivered.metadata?.sourceDisclosures as any[]).every(s => s.disclosure === 'text'));
    const modelMessage = buildSyntheticObservationMessages([delivered]).find(message => message.role === 'tool')!;
    const parentInput = JSON.parse(modelMessage.content as string);
    const locatorPack = parentInput.source_locators;
    assert.equal(locatorPack.items.length, 3, 'source and both neighbors retain independently replayable locators');
    assert.equal(locatorPack.omitted, 0);
    assert.ok(JSON.stringify(locatorPack).length <= MAX_MEMORY_SOURCE_LOCATOR_CHARS);
    assert.ok(!JSON.stringify(parentInput).includes('before body'), 'source text is not sent through the locator mapping');
    const replayed: CatsLogKnowledgeAnchor[] = [];
    const native = new CatsLogKnowledgeRecallTool(backend({ readKnowledgeSource: async q => {
      replayed.push(q.anchor);
      const text = q.anchor.id === sourceAnchor(98).id ? 'before body' : q.anchor.id === sourceAnchor(99).id ? 'after body' : 'source body';
      return { source: source(q.anchor, text), before: [], after: [], before_exhausted: true, after_exhausted: true, context_truncated: false, served_at: '2026-10-08T00:00:00Z' };
    } }));
    for (const locator of locatorPack.items) {
      assert.equal(locator.disclosure, 'metadata');
      assert.equal(locator.branch_disclosure, 'text');
      const expected = [pack.daily_knowledge.source_reads[0].source, ...pack.daily_knowledge.source_reads[0].before, ...pack.daily_knowledge.source_reads[0].after]
        .find((item: any) => item.ref === locator.ref);
      assert.deepEqual(locator.anchor, expected.anchor);
      const result = await native.execute({ action: 'read_source', anchor: locator.anchor, before: 0, after: 0, max_bytes: 2048 }, { workingDirectory: root } as any);
      assert.equal(result.ok, true);
      const body = JSON.parse(result.content as string);
      assert.deepEqual(body.source.anchor, locator.anchor);
      assert.equal(body.source.ref, locator.ref, 'actual injected canonical anchor replays the same source ref through native reader');
      assert.equal(body.source.content_hash, locator.read_content_hash);
    }
    assert.equal(replayed.length, 3);
    console.log(JSON.stringify({ fixture: 'R1-managed-KB-plus-source', finish_kb_entries: pack.local_knowledge.entries.length,
      full_kb_chars: JSON.stringify(session.retrieval.presentation.evidencePack.local_knowledge).length,
      refine_kb_chars: JSON.stringify(pack.local_knowledge).length, excerpt_chars: pack.local_knowledge.entries[0].excerpt.text.length,
      source_pages: pack.daily_knowledge.source_reads.length, finish_prompt_tokens: finishTokens, calls }));
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_USER_DATA_DIR; else process.env.XIAOBA_USER_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

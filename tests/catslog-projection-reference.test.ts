import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildSourceProjectionSemanticView, discoverSourceReferenceItems, expandSourceReferences,
  recomputeSourceProjectionRef, retainedEvidenceBytes, validateSourceMemoryProjectionDocument } from '../src/core/catslog-projection-reference';
import { FinishMemorySearchTool } from '../src/tools/memory-branch-tools';
import { fixtureBranch, fixtureRead, fixtureRef } from './helpers/catslog-projection-reference-fixture';

test('Go-cased envelope binds exact opaque ref and preserves complete graph/qualifiers/gaps', () => {
  const read = fixtureRead();
  assert.equal(recomputeSourceProjectionRef(read.projection.Revision, read.projection.StreamID), fixtureRef());
  const result = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(result.ok, true);
  const view = buildSourceProjectionSemanticView(result)!;
  for (const key of ['goal', 'summary', 'conditions', 'omissions', 'nodes', 'edges', 'gap_acknowledgement']) {
    assert.deepEqual(view[key], read.projection.Document[key]);
  }
  assert.deepEqual((view.aggregate as any).gaps, read.projection.Document.aggregate.gaps);
  for (const hidden of ['PRIVATE_PRINCIPAL', 'PRIVATE_SCOPE', 'RAW_PAGE_REPROOF_ONLY', 'PRIVATE_RECEIPT']) assert.ok(!JSON.stringify(view).includes(hidden));
});
for (const mutation of ['kind', 'source', 'branch', 'ref', 'prose']) test(`candidate fence rejects ${mutation}`, () => {
  const response = fixtureBranch(); const item = response.branches[0].items[0];
  if (mutation === 'kind') item.kind = 'note';
  if (mutation === 'source') item.source = 'skill';
  if (mutation === 'branch') response.branches[0].source = 'skill';
  if (mutation === 'ref') item.ref = 'https://invalid.test/ref';
  if (mutation === 'prose') { item.text = item.ref; delete item.ref; }
  assert.deepEqual(discoverSourceReferenceItems(response), []);
});
for (const field of ['Revision', 'StreamID']) test(`changed ${field} rejects a stale/foreign read`, () => {
  const read = fixtureRead(); read.projection[field] = field === 'Revision' ? 'e'.repeat(64) : 'other';
  assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).reason, 'stale_ref');
});
for (const mutation of ['nodekind', 'edgekind', 'endpoint', 'mapping', 'leaves', 'pages', 'ranges', 'gaps']) test(`malformed ${mutation} stays invalid_response`, () => {
  const read = fixtureRead(); const d = read.projection.Document;
  if (mutation === 'nodekind') d.nodes[0].kind = 'fact';
  if (mutation === 'edgekind') d.edges[0].kind = 'proves';
  if (mutation === 'endpoint') d.edges[0].to = 'missing';
  if (mutation === 'mapping') d.mappings = [];
  if (['leaves', 'pages', 'ranges', 'gaps'].includes(mutation)) d.aggregate[mutation] = {};
  assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).reason, 'invalid_response');
});
test('142 gap ranges are structurally valid; total view budget decides delivery', () => {
  const read = fixtureRead();
  read.projection.Document.aggregate.gaps = Array.from({ length: 142 }, (_, i) => ({ first_page: i * 2, last_page: i * 2, status: 'unreviewed' }));
  const validated = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(validated.ok, true);
  const view = buildSourceProjectionSemanticView(validated)!;
  assert.equal((view.aggregate as any).gaps.length, 142);
  read.projection.Document.aggregate.gaps = Array.from({ length: 400 }, (_, i) => ({ first_page: i * 2, last_page: i * 2, status: 'unreviewed' }));
  assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, true);
  assert.equal(buildSourceProjectionSemanticView(validateSourceMemoryProjectionDocument(read, fixtureRef())), undefined);
});
test('UTF8 budget drops whole qualifier rather than trimming; 0 budget remains zero', async () => {
  const read = fixtureRead(); read.projection.Document.conditions = ['界'.repeat(6000)];
  assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, true);
  const result = await expandSourceReferences(fixtureBranch(), async () => read);
  assert.equal(result[0].expansion_error, 'semantic_view_over_budget');
  assert.equal(result[0].semantic_view, undefined);
  const zero = await expandSourceReferences(fixtureBranch(), async () => fixtureRead(), { totalViewChars: 0 });
  assert.equal(zero[0].expansion_error, 'semantic_view_over_budget');
});
test('shared view budget includes JSON/ref framing across two expansions', async () => {
  const r2 = 'b'.repeat(64); const response = fixtureBranch();
  response.branches[0].items.push({ ...response.branches[0].items[0], ref: fixtureRef(r2) });
  const read = fixtureRead(); read.projection.Document.summary = 'x'.repeat(8000);
  const result = await expandSourceReferences(response, async ({ projectionRef }) => ({ ...read,
    projection: { ...read.projection, Revision: projectionRef === fixtureRef() ? 'a'.repeat(64) : r2 },
  }));
  assert.equal(result[0].status, 'expanded'); assert.equal(result[1].expansion_error, 'semantic_view_over_budget');
  assert.ok(retainedEvidenceBytes(result.filter(x => x.semantic_view).map(x => ({ ref: x.ref, semantic_view: x.semantic_view! }))) <= 16000);
});
for (const status of [401, 403, 404, 409, 500]) test(`HTTP ${status} fails once without content promotion`, async () => {
  let calls = 0;
  const result = await expandSourceReferences(fixtureBranch(), async () => { calls++; throw Object.assign(new Error('PRIVATE_ERROR'), { status }); });
  assert.equal(calls, 1); assert.equal(result[0].status, 'reference_only'); assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR'));
});
test('finish preserves local grammar and admits only explicit delivered-pool membership', async () => {
  const bad = [fixtureRef(), 'stream#2', 'catslog:skill:unopened@1', 'kb:KB-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'];
  for (const ref of bad) {
    const tool = new FinishMemorySearchTool(() => assert.fail('undeclared ref accepted'));
    assert.equal((await tool.execute({ summary: 's', evidence: [ref], inject: true })).ok, false);
  }
  let finished = false;
  const allowed = new FinishMemorySearchTool(() => { finished = true; }, ref => ref === fixtureRef());
  assert.equal((await allowed.execute({ summary: 's', evidence: [fixtureRef()], inject: true })).ok, true); assert.ok(finished);
  const local = new FinishMemorySearchTool(() => {});
  assert.equal((await local.execute({ summary: 's', evidence: ['chat/2026-10-20/a.jsonl#1'], inject: true })).ok, true);
});

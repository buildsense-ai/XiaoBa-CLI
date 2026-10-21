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
  read.projection.Document.aggregate.root_proof = { page: 0, pages: 284 };
  read.projection.Document.aggregate.pages = [];
  read.projection.Document.aggregate.ranges = Array.from({ length: 142 }, (_, i) => ({ first_page: i * 2 + 1, last_page: i * 2 + 1 }));
  read.projection.Document.aggregate.gaps = Array.from({ length: 142 }, (_, i) => ({ first_page: i * 2, last_page: i * 2, status: 'unreviewed' }));
  const validated = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(validated.ok, true);
  const view = buildSourceProjectionSemanticView(validated)!;
  assert.equal((view.aggregate as any).gaps.length, 142);
  read.projection.Document.aggregate.root_proof = { page: 0, pages: 800 };
  read.projection.Document.aggregate.ranges = Array.from({ length: 400 }, (_, i) => ({ first_page: i * 2 + 1, last_page: i * 2 + 1 }));
  read.projection.Document.aggregate.gaps = Array.from({ length: 400 }, (_, i) => ({ first_page: i * 2, last_page: i * 2, status: 'unreviewed' }));
  assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, true);
  assert.equal(buildSourceProjectionSemanticView(validateSourceMemoryProjectionDocument(read, fixtureRef())), undefined);
});
test('aggregate contract cannot be downgraded by omitting transform_contract', () => {
  const read = fixtureRead(); const d = read.projection.Document;
  delete d.transform_contract;
  d.aggregate.contract = 'result_collection/v1';
  d.aggregate.disclosure = 'derived_membership_index';
  read.content_trust = 'derived_memory_projection';
  // Keep ordinary synthesis nodes and mappings: they must not change the root contract.
  assert.equal(d.nodes.length > 0 && d.mappings.length > 0, true);
  assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, false);
});

function nonDeltaProjectionRead(contract: 'result_synthesis/v1' | 'result_synthesis/v2' | 'result_collection/v1'): any {
  const read = fixtureRead(); const d = read.projection.Document;
  d.transform_contract = contract; d.aggregate.contract = contract;
  d.aggregate.disclosure = contract === 'result_collection/v1' ? 'derived_membership_index' : 'derived_memory_projection';
  if (contract === 'result_synthesis/v1') {
    delete d.aggregate.version; delete d.aggregate.root_proof; delete d.aggregate.ranges;
    d.aggregate.pages = [0, 1, 3, 4].map(page => ({ page, pages: 5 }));
  } else if (contract === 'result_synthesis/v2') d.aggregate.version = 2;
  if (contract === 'result_collection/v1') {
    read.content_trust = 'derived_membership_index'; d.aggregate.version = 1; d.aggregate.pages = [];
    d.nodes = []; d.edges = []; d.mappings = []; d.conditions = []; d.omissions = [];
    d.overall_coverage = 'complete'; d.gap_acknowledgement = '';
  }
  return read;
}

function deltaProjectionRead(): any {
  const read = fixtureRead(); const d = read.projection.Document;
  const authoredNode = 'e'.repeat(64); const existingNode = 'a'.repeat(64); const memberRef = d.aggregate.leaves[0].leaf_ref;
  d.transform_contract = 'result_synthesis_delta/v1';
  d.nodes[0] = { id: authoredNode, kind: 'assertion', text: 'A new cross-child assertion.' };
  d.mappings[0].node_id = authoredNode; d.edges = [];
  d.aggregate.contract = 'result_synthesis_delta/v1'; d.aggregate.version = 1; d.aggregate.disclosure = 'derived_memory_projection';
  d.aggregate.collection_ref = fixtureRef(); d.aggregate.collection_revision = 'b'.repeat(64); d.aggregate.delta_scope = 'cross_child_conclusion';
  d.aggregate.qualifier_bindings = [{ member_ref: memberRef, node_id: 'c'.repeat(64), kind: 'condition' }];
  d.aggregate.gaps = [{ first_page: 2, last_page: 2, status: 'unknown' }];
  d.aggregate.delta_relations = [{ relation_id: 'f'.repeat(64), kind: 'qualifies',
    from: { kind: 'new', node_id: authoredNode },
    to: { kind: 'existing', member_ref: memberRef, node_id: existingNode }, scope: 'cross_child_conclusion' }];
  return read;
}

test('non-Delta aggregate contracts reject every Delta-only field before semantic projection', () => {
  const contracts = ['result_synthesis/v1', 'result_synthesis/v2', 'result_collection/v1'] as const;
  const relation = { relation_id: 'f'.repeat(64), kind: 'qualifies',
    from: { kind: 'new', node_id: 'e'.repeat(64), private_endpoint: 'PRIVATE_NESTED_ENDPOINT_SENTINEL' },
    to: { kind: 'existing', member_ref: fixtureRef(), node_id: 'a'.repeat(64), private_endpoint: 'PRIVATE_NESTED_ENDPOINT_SENTINEL' },
    scope: 'PRIVATE_DELTA_RELATION_SENTINEL' };
  for (const contract of contracts) for (const field of ['collection_ref', 'collection_revision', 'delta_scope', 'delta_relations']) {
    const read = nonDeltaProjectionRead(contract); const aggregate = read.projection.Document.aggregate;
    assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, true, `${contract} baseline fixture invalid`);
    aggregate[field] = field === 'delta_relations' ? [relation] : `PRIVATE_${field.toUpperCase()}_SENTINEL`;
    assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, false, `${contract} accepted ${field}`);
  }
});

test('legacy synthesis rejects Collection/Delta-only version, qualifier bindings and leaf coverage', () => {
  for (const contract of ['result_synthesis/v1', 'result_synthesis/v2'] as const) {
    const baseline = nonDeltaProjectionRead(contract);
    const baselineValidation = validateSourceMemoryProjectionDocument(baseline, fixtureRef());
    assert.equal(baselineValidation.ok, true, `${contract} baseline fixture invalid`);
    const baselineView = buildSourceProjectionSemanticView(baselineValidation)!;
    const baselineAggregate = baselineView.aggregate as any;
    for (const field of ['collection_ref', 'collection_revision', 'delta_scope', 'delta_relations', 'qualifier_bindings']) {
      assert.equal(Object.hasOwn(baselineAggregate, field), false, `${contract} semantic view emitted ${field}`);
    }
    assert.equal(Object.hasOwn(baselineAggregate.leaves[0], 'covered_ranges'), false);
    for (const field of ['version', 'qualifier_bindings', 'covered_ranges']) {
      const read = nonDeltaProjectionRead(contract); const aggregate = read.projection.Document.aggregate;
      assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, true, `${contract} baseline fixture invalid`);
      if (field === 'covered_ranges') aggregate.leaves[0].covered_ranges = [{ first_page: 0, last_page: 1, private_field: 'PRIVATE_LEAF_COVERAGE_SENTINEL' }];
      else if (field === 'qualifier_bindings') aggregate.qualifier_bindings = [{ member_ref: aggregate.leaves[0].leaf_ref, node_id: 'a'.repeat(64), kind: 'condition' }];
      else aggregate.version = 'PRIVATE_VERSION_SENTINEL';
      assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, false, `${contract} accepted ${field}`);
    }
  }
});

test('Delta rejects every present member_ref on a new relation endpoint', () => {
  assert.equal(validateSourceMemoryProjectionDocument(deltaProjectionRead(), fixtureRef()).ok, true);
  for (const foreignMember of [`ref_${'9'.repeat(64)}`, null, '', undefined]) {
    const read = deltaProjectionRead();
    read.projection.Document.aggregate.delta_relations[0].from.member_ref = foreignMember;
    assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, false, `accepted new endpoint member_ref=${String(foreignMember)}`);
  }
});

test('Delta rejects existing relation endpoints outside its exact pinned leaf set', () => {
  assert.equal(validateSourceMemoryProjectionDocument(deltaProjectionRead(), fixtureRef()).ok, true);
  for (const foreignMember of [`ref_${'9'.repeat(64)}`, null, '']) {
    const read = deltaProjectionRead();
    read.projection.Document.aggregate.delta_relations[0].to.member_ref = foreignMember;
    assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, false, `accepted existing endpoint member_ref=${String(foreignMember)}`);
  }
});

test('Delta semantic view allowlists every nested aggregate structure and preserves its typed semantics', () => {
  const read = deltaProjectionRead(); const aggregate = read.projection.Document.aggregate;
  const sentinel = 'PRIVATE_NESTED_AGGREGATE_SENTINEL';
  aggregate.ranges[0].private_field = sentinel;
  aggregate.gaps[0].private_field = sentinel;
  aggregate.leaves[0].covered_ranges = [
    { first_page: 0, last_page: 1, private_field: sentinel },
    { first_page: 3, last_page: 4, private_field: sentinel },
  ];
  aggregate.delta_relations[0].from.private_field = sentinel;
  aggregate.delta_relations[0].to.private_field = sentinel;
  const validated = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(validated.ok, true);
  const view = buildSourceProjectionSemanticView(validated)!;
  const projected = view.aggregate as any;
  assert.equal(JSON.stringify(view).includes(sentinel), false);
  assert.deepEqual(projected.ranges, [{ first_page: 0, last_page: 1 }, { first_page: 3, last_page: 4 }]);
  assert.deepEqual(projected.gaps, [{ first_page: 2, last_page: 2, status: 'unknown' }]);
  assert.deepEqual(projected.leaves[0].covered_ranges, [{ first_page: 0, last_page: 1 }, { first_page: 3, last_page: 4 }]);
  assert.deepEqual(projected.delta_relations, [{ relation_id: 'f'.repeat(64), kind: 'qualifies',
    from: { kind: 'new', node_id: 'e'.repeat(64) },
    to: { kind: 'existing', member_ref: aggregate.leaves[0].leaf_ref, node_id: 'a'.repeat(64) }, scope: 'cross_child_conclusion' }]);
});

test('ordinary projection without aggregate remains compatible', () => {
  const read = fixtureRead();
  delete read.projection.Document.transform_contract;
  delete read.projection.Document.aggregate;
  const validated = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(validated.ok, true);
  assert.equal(validated.contentTrust, 'derived_memory_projection');
});

test('Collection document stays a bounded membership index, never a semantic full view', () => {
  const read = fixtureRead(); const d = read.projection.Document;
  read.content_trust = 'derived_membership_index';
  d.transform_contract = 'result_collection/v1';
  d.nodes = []; d.edges = []; d.mappings = []; d.conditions = []; d.omissions = [];
  d.overall_coverage = 'complete'; d.gap_acknowledgement = '';
  d.aggregate = {
    contract: 'result_collection/v1', disclosure: 'derived_membership_index', version: 1,
    coverage_digest: 'c'.repeat(64), source_basis: 'd'.repeat(64), root_proof: { page: 0, pages: 5 },
    leaves: [{ leaf_kind: 'result_synthesis', leaf_ref: fixtureRef(), leaf_revision: 'b'.repeat(64), covered_ranges: [{ first_page: 0, last_page: 4 }] }],
    pages: [], ranges: [{ first_page: 0, last_page: 4 }], gaps: [], qualifier_bindings: [],
  };
  const validated = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(validated.ok, true);
  const view = buildSourceProjectionSemanticView(validated)!;
  assert.equal(view.content_trust, 'derived_membership_index');
  assert.equal(view.transform_contract, 'result_collection/v1');
  assert.deepEqual(view.nodes, []); assert.deepEqual(view.edges, []); assert.deepEqual(view.mappings, []);
  for (const field of ['collection_ref', 'collection_revision', 'delta_scope', 'delta_relations']) {
    assert.equal(Object.hasOwn(view.aggregate as object, field), false, `Collection semantic view emitted ${field}`);
  }
  assert.deepEqual((view.aggregate as any).leaves[0].covered_ranges, [{ first_page: 0, last_page: 4 }]);
});
test('Delta document preserves exact typed relation endpoints and pinned collection identity', () => {
  const read = fixtureRead(); const d = read.projection.Document;
  const nodeId = 'e'.repeat(64); const relationId = 'f'.repeat(64);
  d.transform_contract = 'result_synthesis_delta/v1';
  d.nodes[0].id = nodeId; d.nodes[0].kind = 'assertion'; d.edges = []; d.mappings[0].node_id = nodeId;
  d.aggregate.contract = 'result_synthesis_delta/v1'; d.aggregate.version = 1;
  d.aggregate.disclosure = 'derived_memory_projection'; d.aggregate.pages = []; d.aggregate.ranges = [
    { first_page: 0, last_page: 1 }, { first_page: 3, last_page: 4 },
  ];
  d.aggregate.root_proof = { page: 0, pages: 5 }; d.aggregate.collection_ref = fixtureRef();
  d.aggregate.collection_revision = 'b'.repeat(64); d.aggregate.delta_scope = 'current_question';
  d.aggregate.qualifier_bindings = [{ member_ref: fixtureRef(), node_id: 'a'.repeat(64), kind: 'condition' }];
  d.aggregate.delta_relations = [{ relation_id: relationId, kind: 'qualifies',
    from: { kind: 'new', node_id: nodeId }, to: { kind: 'existing', member_ref: fixtureRef(), node_id: 'a'.repeat(64) }, scope: 'current_question' }];
  const validated = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(validated.ok, true);
  const view = buildSourceProjectionSemanticView(validated)!;
  assert.equal(view.content_trust, 'derived_memory_projection');
  assert.equal(view.transform_contract, 'result_synthesis_delta/v1');
  assert.deepEqual((view.aggregate as any).delta_relations, d.aggregate.delta_relations);
  assert.equal((view.aggregate as any).collection_ref, fixtureRef());
});
test('compact v1 gap table expands losslessly and rejects malformed ranges before view construction', () => {
  const read = fixtureRead(); const aggregate = read.projection.Document.aggregate;
  delete aggregate.gaps;
  aggregate.gap_encoding = 'synthesis-gap-table/v1';
  aggregate.gap_table = { contract: 'synthesis-gap-table/v1', reasons: ['unreviewed'], ranges: [[2, 2, 0]] };
  const validated = validateSourceMemoryProjectionDocument(read, fixtureRef());
  assert.equal(validated.ok, true);
  assert.deepEqual((buildSourceProjectionSemanticView(validated)!.aggregate as any).gaps,
    [{ first_page: 2, last_page: 2, status: 'unreviewed' }]);
  aggregate.gap_table.ranges = [[1, 2, 0]];
  assert.equal(validateSourceMemoryProjectionDocument(read, fixtureRef()).ok, false);
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

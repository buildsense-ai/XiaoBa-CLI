import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCatsLogProjectionFixture, syntheticProjectionDocument, DEFAULT_ROOT_REF, opaqueRef } from './helpers/catslog-projection-fixture';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { runActualFlow, assertPositiveFlow, poolRef } from './helpers/catslog-projection-harness';
import { fixtureRead } from './helpers/catslog-projection-reference-fixture';
const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = process.env.XIAOBA_PROJECTION_TARGET_ROOT ?? ownRoot;
const question = 'For Meridian, what did we decide about staging, owner approval, the inclusive date boundary, and the withheld metric?';
function collectionMembershipDocument() {
  return {
    ...syntheticProjectionDocument(), transform_contract: 'result_collection/v1', overall_coverage: 'complete',
    gap_acknowledgement: '', nodes: [], edges: [], mappings: [], conditions: [], omissions: [],
    aggregate: {
      contract: 'result_collection/v1', disclosure: 'derived_membership_index', version: 1,
      coverage_digest: 'c'.repeat(64), source_basis: 'd'.repeat(64), root_proof: { page: 0, pages: 5 },
      leaves: [{ leaf_kind: 'result_synthesis', leaf_ref: DEFAULT_ROOT_REF, leaf_revision: 'a'.repeat(64),
        covered_ranges: [{ first_page: 0, last_page: 4 }] }],
      pages: [], ranges: [{ first_page: 0, last_page: 4 }], gaps: [], qualifier_bindings: [],
    },
  };
}
function deltaProjectionDocumentWithNestedSentinels() {
  const document = syntheticProjectionDocument();
  const authoredNode = 'e'.repeat(64); const existingNode = 'a'.repeat(64); const sentinel = 'PRIVATE_NESTED_DELTA_SENTINEL';
  document.transform_contract = 'result_synthesis_delta/v1';
  document.nodes[0] = { id: authoredNode, kind: 'assertion', text: 'A new assertion qualifies an existing child conclusion.' };
  document.mappings[0].node_id = authoredNode;
  document.edges = [];
  const aggregate = document.aggregate;
  aggregate.contract = 'result_synthesis_delta/v1'; aggregate.version = 1; aggregate.disclosure = 'derived_memory_projection'; aggregate.pages = [];
  aggregate.collection_ref = DEFAULT_ROOT_REF; aggregate.collection_revision = 'b'.repeat(64); aggregate.delta_scope = 'cross_child_conclusion';
  aggregate.qualifier_bindings = [{ member_ref: aggregate.leaves[0].leaf_ref, node_id: 'c'.repeat(64), kind: 'condition' }];
  aggregate.delta_relations = [{ relation_id: 'f'.repeat(64), kind: 'qualifies',
    from: { kind: 'new', node_id: authoredNode },
    to: { kind: 'existing', member_ref: aggregate.leaves[0].leaf_ref, node_id: existingNode }, scope: 'cross_child_conclusion' }];
  for (const range of aggregate.ranges) range.private_field = sentinel;
  for (const gap of aggregate.gaps) gap.private_field = sentinel;
  aggregate.leaves[0].covered_ranges = [
    { first_page: 0, last_page: 1, private_field: sentinel },
    { first_page: 3, last_page: 4, private_field: sentinel },
  ];
  aggregate.delta_relations[0].from.private_field = sentinel;
  aggregate.delta_relations[0].to.private_field = sentinel;
  return document;
}
async function scenario(fixtureOptions: any, runOptions: any, check: (run: any, fixture: any) => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-independent-'));
  const fixture = await startCatsLogProjectionFixture(fixtureOptions);
  const old = process.env.XIAOBA_USER_DATA_DIR;
  process.env.XIAOBA_USER_DATA_DIR = root;
  try {
    const run = await runActualFlow({ targetRoot, root, baseUrl: fixture.baseUrl, token: fixture.token, question, keyword: 'Meridian', signal: AbortSignal.timeout(10_000), ...runOptions,
      ...(runOptions.cancelRead ? { cancelAtRead: fixture.readStarted } : {}) });
    await check(run, fixture);
  } finally {
    if (old === undefined) delete process.env.XIAOBA_USER_DATA_DIR; else process.env.XIAOBA_USER_DATA_DIR = old;
    await fixture.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
function active(run: any) { assert.ok(run.requests.some((r: any) => r.path.endsWith('/branch')), 'actual session remote lane missing [strict RED]'); }
function suppressed(run: any) { active(run); assert.equal(run.delivered.size, 0); assert.equal(run.retained.length, 0); assert.equal(run.observations.length, 0, 'undelivered pool ref injected'); }

test('shared source-read budget reserves synchronously across concurrent projection and assertion requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-shared-budget-'));
  const projectionRef = opaqueRef('b'.repeat(64), 'concurrent-projection');
  const deniedRef = opaqueRef('c'.repeat(64), 'third-projection');
  let projectionCalls = 0; let assertionCalls = 0;
  let resolveProjection!: (value: any) => void; let resolveAssertion!: (value: any) => void;
  const projectionPending = new Promise<any>(resolve => { resolveProjection = resolve; });
  const assertionPending = new Promise<any>(resolve => { resolveAssertion = resolve; });
  const backend = {
    isAvailable: () => true,
    readSourceMemoryProjection: async () => { projectionCalls++; return projectionPending; },
    readSourceAssertionClosure: async () => { assertionCalls++; return assertionPending; },
  };
  const session = new MemorySearchBranchSession({ sessionKey: 'shared-budget', input: 'budget test', recentMessages: [],
    workingDirectory: root, aiService: {} as any, queue: new InMemorySyntheticObservationQueue(), catslogMemory: backend as any });
  const state: any = session;
  state.candidates.set(projectionRef, {}); state.candidates.set(deniedRef, {});
  state.expandedRefs.add(DEFAULT_ROOT_REF);
  state.navigableViews.set(DEFAULT_ROOT_REF, { aggregate: { contract: 'result_collection/v1', leaves: [{ leaf_ref: DEFAULT_ROOT_REF }] } });
  try {
    const pendingProjection = state.expandInLoop(projectionRef);
    const pendingAssertion = state.readAssertionInLoop({ ref: DEFAULT_ROOT_REF, memberRef: DEFAULT_ROOT_REF, nodeId: 'a'.repeat(64) });
    const pendingDeniedProjection = state.expandInLoop(deniedRef);
    const inFlightProjectionCalls = projectionCalls;
    const inFlightAssertionCalls = assertionCalls;
    resolveProjection(fixtureRead('b'.repeat(64), 'concurrent-projection'));
    resolveAssertion({ status: 'not_found', read_required: true, content_trust: 'derived_assertion_closure',
      source_completeness: 'not_asserted', projection_ref: DEFAULT_ROOT_REF, member_ref: DEFAULT_ROOT_REF, bytes: 0, nodes: 0 });
    const [projectionResult, assertionResult, deniedProjection] = await Promise.all([pendingProjection, pendingAssertion, pendingDeniedProjection]);
    assert.equal(inFlightProjectionCalls, 1);
    assert.equal(inFlightAssertionCalls, 1);
    assert.equal(deniedProjection.expansion_error, 'source_read_budget_exhausted');
    assert.ok(projectionResult && assertionResult);
    const cachedProjection = await state.expandInLoop(projectionRef);
    assert.equal(cachedProjection.expansion_error, 'already_delivered');
    assert.equal(projectionCalls, 1, 'same-document cache hit spent another source-read call');
  } finally { session.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual session -> real provider/client HTTP -> full branch and MAIN input; uppercase Go envelope', async () => {
  await scenario({}, {}, (run, fixture) => { assertPositiveFlow(run, question, DEFAULT_ROOT_REF); assert.equal(fixture.bootstraps, 0); });
});
test('actual Delta retention allowlists nested ranges, gaps, leaf cuts, endpoints and main-input semantics', async () => {
  const document = deltaProjectionDocumentWithNestedSentinels();
  await scenario({ document }, {}, (run, fixture) => {
    assertPositiveFlow(run, question, DEFAULT_ROOT_REF);
    const retainedView = run.retained[0].semantic_view;
    const mainToolResult = run.mainCalls[0].find((message: any) => message.role === 'tool' && message.name === 'runtime_observation');
    assert.ok(mainToolResult && typeof mainToolResult.content === 'string');
    const mainPayload = JSON.parse(mainToolResult.content);
    const mainView = mainPayload.retained_remote_evidence.find((entry: any) => entry.ref === DEFAULT_ROOT_REF)?.semantic_view;
    assert.ok(mainView);
    for (const view of [retainedView, mainView]) {
      assert.deepEqual(view.aggregate.ranges, [{ first_page: 0, last_page: 1 }, { first_page: 3, last_page: 4 }]);
      assert.deepEqual(view.aggregate.gaps, [{ first_page: 2, last_page: 2, status: 'unknown' }]);
      assert.deepEqual(view.aggregate.leaves[0].covered_ranges, [{ first_page: 0, last_page: 1 }, { first_page: 3, last_page: 4 }]);
      assert.deepEqual(view.aggregate.delta_relations, [{ relation_id: 'f'.repeat(64), kind: 'qualifies',
        from: { kind: 'new', node_id: 'e'.repeat(64) },
        to: { kind: 'existing', member_ref: document.aggregate.leaves[0].leaf_ref, node_id: 'a'.repeat(64) },
        scope: 'cross_child_conclusion' }]);
    }
    assert.deepEqual(mainView, retainedView);
    const visible = JSON.stringify([...run.branchCalls.map((call: any) => call.messages), ...run.mainCalls]);
    assert.doesNotMatch(visible, /PRIVATE_NESTED_DELTA_SENTINEL/);
    assert.equal(fixture.bootstraps, 0);
  });
});

test('natural full question misses literal ILIKE; fake model keyword search discovers and reads an actual ref', async () => {
  await scenario({ hideRecency: true }, { forceSearch: true }, (run, fixture) => {
    assertPositiveFlow(run, question, DEFAULT_ROOT_REF);
    assert.deepEqual(fixture.requests.filter((r: any) => r.path.endsWith('/branch')).map((r: any) => r.body.query_text), ['', 'Meridian']);
    assert.equal(run.branchCalls[0].tools.includes('memory_remote_search'), true);
  });
});
for (const itemKind of ['note', 'episode']) test(`kind spoof ${itemKind} mentioning a valid ref never expands`, async () => {
  await scenario({ itemKind }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
test('actual Collection loopback rejects Delta-only scope/revision fields before model context', async () => {
  const document = collectionMembershipDocument();
  document.aggregate.collection_revision = 'PRIVATE_COLLECTION_REVISION_SENTINEL';
  document.aggregate.delta_scope = 'PRIVATE_COLLECTION_SCOPE_SENTINEL';
  await scenario({ document, contentTrust: 'derived_membership_index' }, {}, run => {
    const visible = JSON.stringify([...run.branchCalls.map((call: any) => call.messages), ...run.mainCalls]);
    assert.doesNotMatch(visible, /PRIVATE_COLLECTION_(?:REVISION|SCOPE)_SENTINEL/);
    assert.equal(run.retained.length, 0);
  });
});

test('actual legacy synthesis loopback rejects Delta-only fields and nested relations before main input', async () => {
  const document = syntheticProjectionDocument();
  document.aggregate.collection_ref = 'PRIVATE_LEGACY_COLLECTION_REF_SENTINEL';
  document.aggregate.collection_revision = 'PRIVATE_LEGACY_COLLECTION_REVISION_SENTINEL';
  document.aggregate.delta_scope = 'PRIVATE_LEGACY_DELTA_SCOPE_SENTINEL';
  document.aggregate.delta_relations = [{ relation_id: 'f'.repeat(64), kind: 'qualifies',
    from: { kind: 'new', node_id: 'e'.repeat(64), private_field: 'PRIVATE_LEGACY_ENDPOINT_SENTINEL' },
    to: { kind: 'existing', member_ref: document.aggregate.leaves[0].leaf_ref, node_id: 'a'.repeat(64), private_field: 'PRIVATE_LEGACY_ENDPOINT_SENTINEL' },
    scope: 'PRIVATE_LEGACY_RELATION_SCOPE_SENTINEL' }];
  await scenario({ document }, {}, run => {
    const visible = JSON.stringify([...run.branchCalls.map((call: any) => call.messages), ...run.mainCalls]);
    assert.doesNotMatch(visible, /PRIVATE_LEGACY_(?:COLLECTION_REF|COLLECTION_REVISION|DELTA_SCOPE|ENDPOINT|RELATION_SCOPE)_SENTINEL/);
    assert.equal(run.retained.length, 0);
  });
});

test('shared source-read cap denies assertion after two projection requests without a third wire call', async () => {
  await scenario({ document: collectionMembershipDocument(), contentTrust: 'derived_membership_index', count: 2 },
    { readSequence: ['projection', 'projection', 'assertion'] }, run => {
      const reads = run.requests.filter(request => request.path.endsWith('/source/read'));
      assert.equal(reads.length, 2);
      assert.ok(reads.every(request => !request.body_keys.includes('assertion')));
      assert.match(JSON.stringify(run.branchToolResults), /source_read_budget_exhausted/);
    });
});

test('shared source-read cap denies a distinct projection after projection plus assertion', async () => {
  await scenario({ document: collectionMembershipDocument(), contentTrust: 'derived_membership_index', count: 2 },
    { readSequence: ['projection', 'assertion', 'projection'] }, run => {
      const reads = run.requests.filter(request => request.path.endsWith('/source/read'));
      assert.equal(reads.length, 2);
      assert.deepEqual(reads.map(request => request.body_keys.includes('assertion')), [false, true]);
      assert.match(JSON.stringify(run.branchToolResults), /source_read_budget_exhausted/);
    });
});

test('failed projection attempt consumes one shared slot before the assertion is denied', async () => {
  await scenario({ document: collectionMembershipDocument(), contentTrust: 'derived_membership_index', count: 2, failProjectionReads: 1 },
    { readSequence: ['projection', 'projection', 'assertion'] }, run => {
      const reads = run.requests.filter(request => request.path.endsWith('/source/read'));
      assert.equal(reads.length, 2);
      assert.deepEqual(reads.map(request => request.status), [503, 200]);
      assert.ok(reads.every(request => !request.body_keys.includes('assertion')));
      assert.match(JSON.stringify(run.branchToolResults), /source_read_budget_exhausted/);
    });
});

test('failed assertion attempt consumes one shared slot before a distinct projection is denied', async () => {
  await scenario({ document: collectionMembershipDocument(), contentTrust: 'derived_membership_index', count: 2, assertionFailureStatus: 503 },
    { readSequence: ['projection', 'assertion', 'projection'] }, run => {
      const reads = run.requests.filter(request => request.path.endsWith('/source/read'));
      assert.equal(reads.length, 2);
      assert.deepEqual(reads.map(request => request.status), [200, 503]);
      assert.deepEqual(reads.map(request => request.body_keys.includes('assertion')), [false, true]);
      assert.match(JSON.stringify(run.branchToolResults), /source_read_budget_exhausted/);
    });
});

test('actual Collection membership stays navigation-only until bounded user-context assertion closure', async () => {
  await scenario({ document: collectionMembershipDocument(), contentTrust: 'derived_membership_index' }, { readAssertion: true }, (run, fixture) => {
    assert.ok(run.requests.some((r: any) => r.path.endsWith('/branch')));
    const reads = run.requests.filter((r: any) => r.path.endsWith('/source/read'));
    assert.equal(reads.length, 2);
    assert.deepEqual(reads[0].body_keys, ['projection_ref']);
    assert.deepEqual(reads[1].body_keys.slice().sort(), ['assertion', 'projection_ref']);
    assert.deepEqual(Object.keys(fixture.requests.filter((r: any) => r.path.endsWith('/source/read'))[1].body.assertion).sort(),
      ['max_bytes', 'max_nodes', 'member_ref', 'node_id']);
    assert.equal(run.navigable.get(DEFAULT_ROOT_REF)?.content_trust, 'derived_membership_index');
    assert.equal(run.delivered.get(DEFAULT_ROOT_REF)?.content_trust, 'derived_assertion_closure');
    assert.equal(run.retained.length, 1); assert.equal(run.retained[0].ref, DEFAULT_ROOT_REF);
    assert.equal(run.retained[0].semantic_view.assertion.text, 'Only production releases require owner approval.');
    assert.equal(run.retained[0].semantic_view.entries[0].locator.text, 'Approval condition.');
    assert.deepEqual(run.retained[0].semantic_view.relations[0], {
      relation_id: 'd'.repeat(64), kind: 'qualifies',
      from: { kind: 'new', node_id: 'a'.repeat(64) },
      to: { kind: 'existing', member_ref: DEFAULT_ROOT_REF, node_id: 'b'.repeat(64) },
      scope: 'current_question',
    });
    assert.equal(run.retained[0].semantic_view.covered_ranges[0].private_field, undefined);
    assert.equal(run.observations.length, 1); assert.deepEqual(run.cited, [DEFAULT_ROOT_REF]);
    const visible = JSON.stringify([...run.branchCalls.map((c: any) => c.messages), ...run.mainCalls]);
    assert.match(visible, /derived_assertion_closure/);
    assert.doesNotMatch(visible, /private-principal-sentinel|source_scope|DO_NOT_PROJECT_RANGE_FIELD|DO_NOT_PROJECT_RELATION_FIELD/);
    assert.equal(fixture.bootstraps, 0);
  });
});

test('source_reference on a non-agent_memory branch never expands', async () => {
  await scenario({ branchSource: 'skill' }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
test('source_reference with item.source=skill inside agent_memory never expands', async () => {
  await scenario({ itemSource: 'skill' }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
for (const advertisedRef of ['https://attacker.invalid/read', 'ref_SHORT', `ref_${'A'.repeat(64)}`, 'file:../../etc/passwd']) test(`unsafe locator ${advertisedRef.slice(0, 30)} never reaches source/read`, async () => {
  await scenario({ advertisedRef }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
for (const failureStatus of [401, 403, 404, 409, 500]) test(`HTTP ${failureStatus}: explicit reference_only, no injected metadata, bounded calls`, async () => {
  await scenario({ failureStatus }, { citeUndelivered: true }, (run, fixture) => {
    suppressed(run); assert.ok(fixture.reads >= 1 && fixture.reads <= 2);
    const packs = run.branchCalls.map((c: any) => JSON.stringify(c.messages)).join('\n');
    assert.match(packs, /reference_only/); assert.doesNotMatch(packs, /synthetic untrusted server error/);
  });
});
for (const mode of ['stale', 'malformed']) test(`${mode} expansion fails closed after real read`, async () => {
  await scenario({ [mode]: true }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 1); });
});
test('401 on an issued projection never bootstraps/replays the ref under a replacement capability', async () => {
  await scenario({ rotateOnRead: true }, { loginToken: 'synthetic-user-login', citeUndelivered: true }, (run, fixture) => {
    suppressed(run); assert.equal(fixture.bootstraps, 0); assert.equal(fixture.reads, 1);
  });
});
test('token rotation between discovery and read fails closed before HTTP, no cross-identity replay', async () => {
  await scenario({}, { citeUndelivered: true, beforeSourceRead(root: string) {
    const filename = path.join(root, 'data/catsco-log-agent-state.json');
    const state = JSON.parse(fs.readFileSync(filename, 'utf8')); state.skillToken = 'synthetic-replacement-identity';
    fs.writeFileSync(filename, JSON.stringify(state), { mode: 0o600 });
  } }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); assert.equal(fixture.bootstraps, 0); });
});
test('cancel after actual source/read starts aborts transport, no late observation', async () => {
  await scenario({ delayRead: true }, { cancelRead: true }, (run, fixture) => {
    active(run); assert.equal(fixture.reads, 1); assert.equal(run.observations.length, 0); assert.equal(run.delivered.size, 0);
    assert.ok(run.requests.some((r: any) => r.path.endsWith('/source/read') && r.error_class));
  });
});
test('oversize qualifiers omit the WHOLE view with explicit degradation', async () => {
  const document = syntheticProjectionDocument(); document.conditions = ['alpha'.repeat(1400), 'omega'.repeat(1400), 'zeta'.repeat(1400)];
  await scenario({ document }, { citeUndelivered: true }, (run, fixture) => {
    suppressed(run); assert.equal(fixture.reads, 1);
    const visible = JSON.stringify(run.branchCalls); assert.match(visible, /semantic_view_over_budget/);
    assert.ok(!visible.includes(document.conditions[0]), 'partial view leaked into branch context');
  });
});
test('one shared call/view budget across multiple locators, raw pages excluded', async () => {
  const document = syntheticProjectionDocument(); document.nodes[0].text = 'bounded-node-'.repeat(600);
  await scenario({ count: 6, document }, { readAll: true }, (run, fixture) => {
    assertPositiveFlow(run, question, DEFAULT_ROOT_REF); assert.ok(fixture.reads <= 2);
    assert.ok(Buffer.byteLength(JSON.stringify({ retained_remote_evidence: [...run.delivered].map(([ref, semantic_view]: any) => ({ ref, semantic_view })) }), 'utf8') <= 16_000);
    assert.ok(run.delivered.size < fixture.identities.length);
  });
});
for (const finishRef of [`ref_${'b'.repeat(64)}`, 'kb:KB-11111111-1111-1111-1111-111111111111', 'catslog:skill:unopened@1', 'unopened-stream#1']) test(`finish cannot open undeclared grammar/undelivered ref ${finishRef.slice(0, 35)}`, async () => {
  await scenario({}, { finishRef }, run => { active(run); assert.equal(run.observations.length, 0, 'finish widened unrelated ref grammar'); });
});
test('strict positive assertion stays RED when actual session has discovery but NO expansion capability', async () => {
  await scenario({}, { citeUndelivered: true, injectedBackend: (provider: any) => ({
    isAvailable: () => provider.isAvailable(), branch: provider.branch.bind(provider),
  }) }, (run, fixture) => {
    active(run); assert.equal(fixture.reads, 0); assert.equal(run.observations.length, 0);
    assert.throws(() => assertPositiveFlow(run, question), /no actual source\/read expansion/);
  });
});
test('transport error leaves only explicit reference_only metadata and suppresses injection', async () => {
  await scenario({ networkFailure: true }, { citeUndelivered: true }, run => {
    suppressed(run); assert.ok(run.requests.some((r: any) => r.path.endsWith('/source/read') && r.error_class));
    assert.match(JSON.stringify(run.branchCalls), /network_error/);
  });
});
test('UTF-8 whole-view budget counts bytes, with no partial Unicode qualifier', async () => {
  const document = syntheticProjectionDocument(); document.conditions = ['限定'.repeat(3100)];
  await scenario({ document }, { citeUndelivered: true }, run => {
    suppressed(run); assert.match(JSON.stringify(run.branchCalls), /semantic_view_over_budget/);
    assert.ok(!JSON.stringify(run.branchCalls).includes(document.conditions[0]));
  });
});
test('pool refs delivered/retained/cited are subsets of the observed set, not its reverse', async () => {
  await scenario({ count: 6 }, {}, run => {
    assertPositiveFlow(run, question); assert.ok(run.observed.length > run.retained.length);
    for (const ref of [...run.delivered.keys(), ...run.retained.map((e: any) => e.ref), ...run.cited]) assert.ok(poolRef(ref) && run.observed.includes(ref));
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

process.env.XIAOBA_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-assertion-data-'));

import type { Message } from '../src/types';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import {
  buildSourceProjectionSemanticView, recomputeSourceProjectionRef, validateSourceMemoryProjectionDocument,
} from '../src/core/catslog-projection-reference';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { fixtureBranch, fixtureRef } from './helpers/catslog-projection-reference-fixture';

// Failure modes D1-D10: docs/catslog-recall-layering.md ("Collection and Delta roots").
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const SCOPE_SENTINEL = 'PRIVATE_SOURCE_SCOPE_SENTINEL';
const MEMBER = `ref_${hex('member-1')}`;
const NEW_ASSERTION = hex('assertion-new');
const EXISTING_NODE = hex('assertion-existing');

function envelope(seed: string, document: Record<string, any>, trust = 'derived_memory_projection') {
  const revision = hex(`revision-${seed}`);
  const streamId = `stream-${seed}`;
  return { ref: recomputeSourceProjectionRef(revision, streamId)!, read: {
    schema_version: 1, content_trust: trust, sources: [],
    projection: { Revision: revision, StreamID: streamId, PrincipalID: 'private-principal-sentinel', Document: document },
  } };
}
const base = (summary = 'Delta over two member results.') => ({
  schema_version: 1, provenance: 'derived', model_steps: 'unknown', causality: 'unknown',
  goal: 'Cross-child conclusion', summary, overall_coverage: 'complete', gap_acknowledgement: '', conditions: [], omissions: [],
});
const memberAggregate = (contract: string, extra: Record<string, unknown> = {}) => ({
  contract, version: 1, disclosure: contract === 'result_collection/v1' ? 'derived_membership_index' : 'derived_memory_projection',
  coverage_digest: hex('coverage'), source_basis: hex('basis'),
  leaves: [{ leaf_kind: 'result_synthesis', leaf_ref: MEMBER, leaf_revision: hex('leaf-revision') }],
  ranges: [{ first_page: 0, last_page: 0 }], root_proof: { page: 0, pages: 1 }, gaps: [], ...extra,
});
function deltaRoot(seed = 'delta', summary?: string, aggregateExtra: Record<string, unknown> = {}) {
  return envelope(seed, { ...base(summary), transform_contract: 'result_synthesis_delta/v1',
    nodes: [{ id: NEW_ASSERTION, kind: 'assertion', text: 'The retry budget must be shared.' }], edges: [],
    mappings: [{ node_id: NEW_ASSERTION, source_ref: MEMBER }],
    aggregate: memberAggregate('result_synthesis_delta/v1', {
      collection_ref: `ref_${hex('collection')}`, collection_revision: hex('collection-revision'), delta_scope: 'cross_child_conclusion',
      delta_relations: [{ relation_id: hex('relation'), kind: 'qualifies', from: { kind: 'new', node_id: NEW_ASSERTION },
        to: { kind: 'existing', member_ref: MEMBER, node_id: EXISTING_NODE }, scope: 'retry budget' }],
      ...aggregateExtra,
    }) });
}
function collectionRoot(seed = 'collection') {
  return envelope(seed, { ...base('Membership of two results.'), transform_contract: 'result_collection/v1',
    nodes: [], edges: [], mappings: [], aggregate: memberAggregate('result_collection/v1') }, 'derived_membership_index');
}
// The server omits empty arrays (omitempty): covered_ranges and entries are absent here on purpose.
function closure(projectionRef: string, memberRef: string, nodeId: string, overrides: Record<string, unknown> = {}) {
  return { status: 'complete', read_required: false, content_trust: 'derived_assertion_closure', source_completeness: 'not_asserted',
    projection_ref: projectionRef, member_ref: memberRef, source_scope: { principal: SCOPE_SENTINEL },
    assertion: { id: nodeId, kind: 'assertion', text: 'The retry budget must be shared.' },
    relations: [{ relation_id: hex('relation'), kind: 'qualifies', from: { kind: 'new', node_id: NEW_ASSERTION },
      to: { kind: 'existing', member_ref: MEMBER, node_id: EXISTING_NODE }, scope: 'retry budget' }],
    bytes: 420, nodes: 1, ...overrides };
}

type Step = [string, unknown];
async function runBranch(roots: Array<{ ref: string; read: unknown }>, script: (turn: number, results: any[]) => Step,
  assertionRead: (input: any) => Promise<unknown> = async () => { throw new Error('unexpected assertion read'); }) {
  const queue = new InMemorySyntheticObservationQueue();
  const requests: Message[][] = [];
  const results: any[] = [];
  const calls = { projection: 0, assertion: [] as any[] };
  const aiService = {
    isToolCallingSupported: () => true,
    async chat(messages: Message[]) {
      requests.push(structuredClone(messages));
      const last = messages.at(-1);
      if (last?.role === 'tool') { try { results.push(JSON.parse(String(last.content))); } catch { results.push(last.content); } }
      const [name, args] = script(requests.length, results);
      return { content: null, usage, toolCalls: [{ id: `t-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    },
  };
  const backend = {
    isAvailable: () => true,
    async branch() {
      return { schema_version: 1, request_id: 'req-1', status: 'ok', branches: [{ source: 'agent_memory',
        items: roots.map(root => ({ source: 'agent_memory', kind: 'source_reference', ref: root.ref })) }] };
    },
    async readSourceMemoryProjection(input: any) {
      calls.projection += 1;
      const root = roots.find(candidate => candidate.ref === input.projectionRef);
      if (!root) throw Object.assign(new Error('not found'), { status: 404 });
      return root.read;
    },
    async readSourceAssertionClosure(input: any) { calls.assertion.push(input); return assertionRead(input); },
  };
  await new MemorySearchBranchSession({
    sessionKey: 'delta', input: 'Which assertion does the Delta add?', recentMessages: [], workingDirectory: os.tmpdir(),
    aiService: aiService as any, queue, logEnabled: false, catslogMemory: backend as any,
  }).run();
  const observations = queue.drain();
  return { requests, results, calls, observations, formatted: observations.map(o => o.formattedContent).join('\n') };
}
const finish = (evidence: string[]): Step => ['finish_memory_search', { summary: 'done', evidence, inject: evidence.length > 0 }];
const lastResult = (results: any[]) => results.at(-1);

test('D1 Delta and Collection projections expand; Collection is navigable only', async () => {
  const delta = deltaRoot();
  const deltaView = buildSourceProjectionSemanticView(validateSourceMemoryProjectionDocument(delta.read, delta.ref)) as any;
  assert.equal(deltaView?.aggregate.contract, 'result_synthesis_delta/v1');
  assert.equal(deltaView.aggregate.delta_relations[0].to.member_ref, MEMBER);
  const collection = collectionRoot();
  const validation = validateSourceMemoryProjectionDocument(collection.read, collection.ref);
  assert.equal(validation.ok, true);
  assert.equal((buildSourceProjectionSemanticView(validation) as any).content_trust, 'derived_membership_index');
  // A Collection envelope that claims projection trust is refused.
  assert.equal(validateSourceMemoryProjectionDocument({ ...(collection.read as any), content_trust: 'derived_memory_projection' }, collection.ref).ok, false);
});

test('D2 gap tables decode into plain gaps; overlap with a verified page is refused', () => {
  const gapTable = (ranges: number[][]) => ({ gaps: undefined, root_proof: { page: 0, pages: 2 }, gap_encoding: 'synthesis-gap-table/v1',
    gap_table: { contract: 'synthesis-gap-table/v1', reasons: ['unreviewed'], ranges } });
  const valid = deltaRoot('gap', undefined, gapTable([[1, 1, 0]]));
  const view = buildSourceProjectionSemanticView(validateSourceMemoryProjectionDocument(valid.read, valid.ref)) as any;
  assert.deepEqual(view.aggregate.gaps, [{ first_page: 1, last_page: 1, status: 'unreviewed' }]);
  const overlap = deltaRoot('gap-overlap', undefined, gapTable([[0, 1, 0]]));
  assert.equal(validateSourceMemoryProjectionDocument(overlap.read, overlap.ref).ok, false);
  const uncovered = deltaRoot('gap-uncovered', undefined, { root_proof: { page: 0, pages: 2 } });
  assert.equal(validateSourceMemoryProjectionDocument(uncovered.read, uncovered.ref).ok, false);
});

test('D3 a Collection root alone never supports finish evidence', async () => {
  const collection = collectionRoot();
  const run = await runBranch([collection], (turn) => turn === 1 ? ['memory_source_read', { ref: collection.ref }] : finish([collection.ref]));
  assert.equal(run.results[0].final_evidence, false);
  assert.equal(run.results[0].content_trust, 'derived_membership_index');
  assert.ok(!run.formatted.includes('retained_remote_evidence'), 'membership index reached the parent');
});

test('D4 assertion reads are refused before HTTP for unexpanded roots and foreign locators', async () => {
  const delta = deltaRoot();
  const collection = collectionRoot();
  const run = await runBranch([delta, collection], (turn) => {
    if (turn === 1) return ['memory_assertion_read', { ref: delta.ref, member_ref: delta.ref, node_id: NEW_ASSERTION }];
    if (turn === 2) return ['memory_source_read', { ref: delta.ref }];
    if (turn === 3) return ['memory_assertion_read', { ref: delta.ref, member_ref: delta.ref, node_id: hex('not-in-graph') }];
    if (turn === 4) return ['memory_assertion_read', { ref: delta.ref, member_ref: `ref_${hex('stranger')}`, node_id: EXISTING_NODE }];
    return finish([]);
  });
  assert.equal(run.results[0].expansion_error, 'not_a_discovered_root');
  assert.equal(run.results[2].expansion_error, 'assertion_locator_not_in_delivered_membership');
  assert.equal(run.results[3].expansion_error, 'assertion_locator_not_in_delivered_membership');
  assert.equal(run.calls.assertion.length, 0);
});

test('D5 assertion reads share the two-read budget, run once, and a failure consumes its slot', async () => {
  const delta = deltaRoot();
  const other = deltaRoot('other');
  const exhausted = await runBranch([delta, other], (turn) => {
    if (turn === 1) return ['memory_source_read', { ref: delta.ref }];
    if (turn === 2) return ['memory_source_read', { ref: other.ref }];
    if (turn === 3) return ['memory_assertion_read', { ref: delta.ref, member_ref: delta.ref, node_id: NEW_ASSERTION }];
    return finish([]);
  });
  assert.equal(exhausted.results[2].expansion_error, 'budget_exhausted');
  assert.equal(exhausted.calls.assertion.length, 0);
  const failed = await runBranch([delta, other], (turn) => {
    if (turn === 1) return ['memory_source_read', { ref: delta.ref }];
    if (turn === 2) return ['memory_assertion_read', { ref: delta.ref, member_ref: delta.ref, node_id: NEW_ASSERTION }];
    if (turn === 3) return ['memory_source_read', { ref: other.ref }];
    if (turn === 4) return ['memory_assertion_read', { ref: delta.ref, member_ref: MEMBER, node_id: EXISTING_NODE }];
    return finish([]);
  }, async () => { throw Object.assign(new Error('boom'), { status: 500 }); });
  assert.equal(failed.results[1].expansion_error, 'http_error');
  assert.equal(failed.results[2].expansion_error, 'budget_exhausted');
  assert.equal(failed.results[3].expansion_error, 'budget_exhausted');
  assert.equal(failed.calls.projection, 1);
  assert.equal(failed.calls.assertion.length, 1);
});

test('D6/D8 a complete closure joins its Delta root whole; omitted arrays are empty; source_scope never crosses', async () => {
  const delta = deltaRoot();
  const run = await runBranch([delta], (turn) => {
    if (turn === 1) return ['memory_source_read', { ref: delta.ref }];
    if (turn === 2) return ['memory_assertion_read', { ref: delta.ref, member_ref: delta.ref, node_id: NEW_ASSERTION }];
    return finish([delta.ref]);
  }, async input => closure(input.projectionRef, input.memberRef, input.nodeId));
  assert.deepEqual(run.calls.assertion[0], { projectionRef: delta.ref, memberRef: delta.ref, nodeId: NEW_ASSERTION, maxBytes: 12 * 1024, maxNodes: 16 });
  assert.equal(lastResult(run.results.slice(0, 2)).status, 'complete');
  const retained = JSON.parse(run.formatted).retained_remote_evidence;
  assert.equal(retained.length, 1);
  const view = retained[0].semantic_view;
  assert.equal(view.aggregate.contract, 'result_synthesis_delta/v1');
  assert.equal(view.assertion_closures.length, 1);
  assert.deepEqual(view.assertion_closures[0].covered_ranges, []);
  assert.deepEqual(view.assertion_closures[0].entries, []);
  const visible = JSON.stringify([...run.requests, run.formatted]);
  assert.ok(!visible.includes(SCOPE_SENTINEL) && !visible.includes('source_scope'), 'closure source_scope reached a model');
  assert.ok(!visible.includes('private-principal-sentinel'), 'projection envelope reached a model');
});

test('D6 a closure that disagrees with its request is refused whole', async () => {
  const delta = deltaRoot();
  for (const override of [{ member_ref: MEMBER }, { projection_ref: `ref_${hex('elsewhere')}` }, { content_trust: 'derived_memory_projection' },
    { assertion: { id: EXISTING_NODE, kind: 'assertion', text: 'x' } }, { bytes: 13 * 1024 }, { entries: 'not-an-array' }]) {
    const run = await runBranch([delta], (turn) => {
      if (turn === 1) return ['memory_source_read', { ref: delta.ref }];
      if (turn === 2) return ['memory_assertion_read', { ref: delta.ref, member_ref: delta.ref, node_id: NEW_ASSERTION }];
      return finish([delta.ref]);
    }, async input => closure(input.projectionRef, input.memberRef, input.nodeId, override));
    assert.equal(run.results[1].expansion_error, 'invalid_assertion_closure', JSON.stringify(override));
    assert.ok(!run.formatted.includes('assertion_closures'), 'refused closure reached the parent');
  }
});

test('D7 bounded and not_found closures never become evidence', async () => {
  const collection = collectionRoot();
  for (const status of ['bounded', 'not_found']) {
    const run = await runBranch([collection], (turn) => {
      if (turn === 1) return ['memory_source_read', { ref: collection.ref }];
      if (turn === 2) return ['memory_assertion_read', { ref: collection.ref, member_ref: MEMBER, node_id: EXISTING_NODE }];
      return finish([collection.ref]);
    }, async input => ({ ...closure(input.projectionRef, input.memberRef, input.nodeId), status, read_required: status === 'bounded' }));
    assert.equal(run.results[1].final_evidence, false);
    assert.ok(!run.formatted.includes('retained_remote_evidence'), `${status} closure reached the parent`);
  }
});

test('D10 a closure that would exceed the shared budget is refused, not cut', async () => {
  const delta = deltaRoot('large', 'S'.repeat(12_500));
  const run = await runBranch([delta], (turn) => {
    if (turn === 1) return ['memory_source_read', { ref: delta.ref }];
    if (turn === 2) return ['memory_assertion_read', { ref: delta.ref, member_ref: delta.ref, node_id: NEW_ASSERTION }];
    return finish([delta.ref]);
  }, async input => closure(input.projectionRef, input.memberRef, input.nodeId,
    { assertion: { id: input.nodeId, kind: 'assertion', text: 'A'.repeat(4_000) } }));
  assert.equal(run.results[0].status, 'expanded');
  assert.equal(run.results[1].expansion_error, 'semantic_view_over_budget');
  const view = JSON.parse(run.formatted).retained_remote_evidence[0].semantic_view;
  assert.equal(view.assertion_closures, undefined, 'root view changed after a refused closure');
});

async function server(mode: string, run: (ctx: { base: string; requests: any[] }) => Promise<void>) {
  const requests: any[] = [];
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/catsco/agent/branch') return res.end(JSON.stringify(fixtureBranch()));
    if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', '/elsewhere'); return res.end(); }
    if (mode === 'stream') { res.write(' '.repeat(40 * 1024)); return res.end(' '.repeat(40 * 1024)); }
    return res.end(JSON.stringify(closure(fixtureRef(), fixtureRef(), NEW_ASSERTION)));
  });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  try { await run({ base: `http://127.0.0.1:${(srv.address() as any).port}`, requests }); }
  finally { srv.closeAllConnections(); await new Promise<void>(resolve => srv.close(() => resolve())); }
}

test('D9 the client sends the typed assertion body, refuses redirects and bounds the response', async () => {
  const input = { token: 'cap', projectionRef: fixtureRef(), memberRef: fixtureRef(), nodeId: NEW_ASSERTION };
  await server('', async ({ base, requests }) => {
    await new CatscoLogAgentClient(base).readSourceAssertionClosure(input);
    assert.deepEqual(requests[0].body, { projection_ref: fixtureRef(),
      assertion: { member_ref: fixtureRef(), node_id: NEW_ASSERTION, max_bytes: 12 * 1024, max_nodes: 16 } });
  });
  await server('redirect', async ({ base }) => {
    await assert.rejects(new CatscoLogAgentClient(base).readSourceAssertionClosure(input));
  });
  await server('stream', async ({ base }) => {
    await assert.rejects(new CatscoLogAgentClient(base).readSourceAssertionClosure(input), /byte budget/);
  });
});

test('D9 the provider refuses an assertion read after the issuing capability rotated, before HTTP', async () => {
  await server('', async ({ base, requests }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-cap-'));
    try {
      const state = { schemaVersion: 1, deviceId: 'device', skillToken: 'cap-a',
        skillTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(), uploaded: {} };
      const provider = new CatsLogMemoryProvider(root, { env: { CATSCO_LOG_API_BASE_URL: base } });
      const statePath = (provider as any).currentConfig().stateFilePath;
      fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state));
      await provider.branch({ queryText: '', sources: ['agent_memory'] });
      const read = { projectionRef: fixtureRef(), memberRef: fixtureRef(), nodeId: NEW_ASSERTION };
      await provider.readSourceAssertionClosure(read);
      assert.equal(requests.at(-1).authorization, 'Bearer cap-a');
      fs.writeFileSync(statePath, JSON.stringify({ ...state, skillToken: 'cap-b' }));
      const before = requests.length;
      await assert.rejects(provider.readSourceAssertionClosure(read), /capability changed or unavailable/);
      assert.equal(requests.length, before, 'stale-capability assertion read reached HTTP');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

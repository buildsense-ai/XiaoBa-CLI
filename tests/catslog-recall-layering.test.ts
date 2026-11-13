import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

process.env.XIAOBA_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-layering-data-'));

import type { Message } from '../src/types';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { MAX_MEMORY_NODE_VIEW_BYTES, MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue, buildSyntheticObservationMessages } from '../src/core/synthetic-observation';
import { collectExecutionMemoryInputs } from '../src/core/execution-memory-bindings';

// Failure modes: docs/catslog-recall-layering.md (M1-M3, B1-B8).
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const memoryAnchor = (seed = 'node') => ({ kind: 'source_memory_projection_node' as const,
  source_projection_ref: `ref_${hex(`projection-${seed}`)}`, revision: hex(`revision-${seed}`), id: hex(`id-${seed}`) });
const handle = (a: ReturnType<typeof memoryAnchor>) => `memory-node:${a.source_projection_ref}:${a.revision}:${a.id}`;
const anchor = memoryAnchor();
const NODE_TEXT = 'Keep the lock held until the write completes.';
const DIARY_TITLE = 'DIARY_TITLE_MUST_NOT_REACH_BRANCH';
const DIARY_BODY = 'DIARY_BODY_MUST_NOT_REACH_BRANCH';
const knowledgeRef = 'catslog:knowledge:akd-doc:rev1:ake-entry';

function diaryGraphResult(anchors: unknown[], name = 'catslog_knowledge_recall', id = 'recall-1'): Message {
  return { role: 'tool', tool_call_id: id, name, content: JSON.stringify({
    contract: 'memory-graph/1', closure_complete: true, edges: [],
    nodes: [{ anchor: { kind: 'knowledge_entry', document_id: 'akd-doc', revision: 'rev1', id: 'ake-entry' }, day: '2026-11-11',
      ref: knowledgeRef, entry: { id: 'ake-entry', title: DIARY_TITLE, text: DIARY_BODY, status: 'active', source_anchors: anchors } }],
  }) } as Message;
}

/** Client-decoded canonical memory-graph/3 node page (decodeKnowledgeSourcePage materializes `text`). */
function nodePage(a: ReturnType<typeof memoryAnchor>, text = NODE_TEXT) {
  return {
    source: { anchor: a, status: 'read', role: 'knowledge', speaker: 'knowledge', occurred_at: null, text,
      projection_context: { contract_version: 'memory-graph/3', output_identity_status: 'unsupported_legacy_identity', selected_node_id: a.id,
        nodes: [{ id: a.id, kind: 'assertion', text }], edges: [], mappings: [{ node_id: a.id, anchor: a, source_anchors: [] }],
        qualifiers: { conditions: [{ text: 'only while the write is in flight' }], omissions: [] }, generation_contexts: {}, output_proofs: [] },
      content_hash: `sha256:${hex(text)}`, coverage: 'complete', truncated: false, redacted: false, missing: false, revoked: false },
    before: [], after: [], before_exhausted: true, after_exhausted: true, context_truncated: false, served_at: '2026-11-12T00:00:00Z',
  };
}

function seedMessages(messages: Message[]): any[] {
  return messages.filter(m => m.role === 'user' && typeof m.content === 'string').flatMap(m => {
    try { const body = JSON.parse(String(m.content)); return body?.retrieval_mode === 'document_cited_memory_nodes' ? [body] : []; } catch { return []; }
  });
}

async function runBranch(recentMessages: Message[], script: (turn: number, messages: Message[]) => [string, unknown],
  serve: (a: any) => unknown = a => nodePage(a)) {
  const queue = new InMemorySyntheticObservationQueue();
  const requests: Array<{ messages: Message[]; tools: string[] }> = [];
  const toolResults: any[] = [];
  const reads: any[] = [];
  const aiService = {
    isToolCallingSupported: () => true,
    async chat(messages: Message[], tools: any[] = []) {
      requests.push({ messages: structuredClone(messages), tools: tools.map(t => t.name) });
      const last = messages.at(-1);
      if (last?.role === 'tool') { try { toolResults.push(JSON.parse(String(last.content))); } catch { toolResults.push(last.content); } }
      const [name, args] = script(requests.length, messages);
      return { content: null, usage, toolCalls: [{ id: `b-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    },
  };
  const backend = {
    isAvailable: () => true,
    isKnowledgeRecallAvailable: () => true,
    async branch() { return { schema_version: 1, request_id: 'req-empty', status: 'ok', branches: [] }; },
    async readSourceMemoryProjection() { throw new Error('seeded nodes must not read whole projections'); },
    async readKnowledgeSource(query: any) { reads.push(query); return serve(query.anchor); },
    async searchKnowledge() { throw new Error('Branch must not search Diary documents'); },
    async readKnowledgeGraph() { throw new Error('Branch must not read Diary graphs'); },
  };
  await new MemorySearchBranchSession({
    sessionKey: 'layering', input: 'Continue the lock review.', recentMessages, workingDirectory: os.tmpdir(),
    aiService: aiService as any, queue, logEnabled: false, catslogMemory: backend as any,
  }).run();
  return { queue, requests, reads, toolResults };
}

const finish = (evidence: string[], inject = true): [string, unknown] => ['finish_memory_search', { summary: 'Cited Memory node read.', evidence, inject }];
const readNode = (node: string): [string, unknown] => ['memory_node_read', { node }];
const deliveredRef = (results: any[]) => results.find(r => r?.status === 'expanded')?.ref;

test('M1/M2: main agent recall exposes only document actions and rejects memory-layer actions without backend calls', async () => {
  let backendCalls = 0;
  const spy = new Proxy({ isKnowledgeRecallAvailable: () => true }, {
    get(target: any, key) { if (key in target) return target[key]; return async () => { backendCalls++; return {}; }; },
  });
  const tool = new CatsLogKnowledgeRecallTool(spy);
  assert.deepEqual((tool.definition.parameters as any).properties.action.enum, ['search', 'read', 'graph']);
  const props = Object.keys((tool.definition.parameters as any).properties);
  for (const memoryOnly of ['anchor', 'direction', 'kinds', 'before', 'after', 'max_bytes', 'search_any']) {
    assert.ok(!props.includes(memoryOnly), `main schema still exposes ${memoryOnly}`);
  }
  assert.doesNotMatch(tool.definition.description, /history|read_source|expand/);
  for (const removed of ['expand', 'read_source', 'source', 'history']) {
    const result = await tool.execute({ action: removed, anchor, search_any: ['x'], query: 'x' }, { workingDirectory: os.tmpdir() } as any);
    assert.equal(result.ok, false, removed);
    assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS', removed);
  }
  assert.equal(backendCalls, 0, 'a removed action reached the backend');
});

test('B1/B3/B6/B7: Branch is memory-only, seeds exact cited nodes without Diary bodies, and binds the delivered node', async () => {
  const otherSessionAnchor = { kind: 'session_query', id: 'q1', session_id: 's1' };
  const run = await runBranch([diaryGraphResult([anchor, otherSessionAnchor])], (turn, messages) => turn === 1
    ? readNode(handle(anchor))
    : finish([JSON.parse(String(messages.at(-1)!.content)).ref]));
  const first = run.requests[0];
  for (const diaryTool of ['memory_knowledge_search', 'memory_knowledge_graph']) assert.ok(!first.tools.includes(diaryTool), `B1 ${diaryTool}`);
  assert.ok(first.tools.includes('memory_node_read'));
  assert.deepEqual(seedMessages(first.messages)[0]?.document_cited_memory_nodes, [{ node: handle(anchor) }]);
  const branchInput = JSON.stringify(first.messages);
  for (const leaked of [DIARY_TITLE, DIARY_BODY, knowledgeRef]) assert.ok(!branchInput.includes(leaked), `B3 leaked ${leaked}`);
  assert.deepEqual(run.reads, [{ anchor, before: 0, after: 0 }]);
  assert.equal(run.queue.size(), 1);
  const [observation] = run.queue.drain();
  const ref = deliveredRef(run.toolResults);
  assert.match(ref, /^catslog:source:[a-f0-9]{64}$/);
  assert.deepEqual((observation.metadata as any).deliveredMemoryNodeRefs, [ref]);
  assert.equal((observation.metadata as any).citation, undefined, 'B6 seed must not join a Branch request pool');
  const parentMessages = buildSyntheticObservationMessages([observation]);
  assert.match(JSON.stringify(parentMessages), /only while the write is in flight/, 'condition qualifier lost');
  const bindings = collectExecutionMemoryInputs(parentMessages, { sessionId: 'layering', episodeId: 'ep-1' });
  assert.equal(bindings.length, 1, 'B7 delivered node has no execution binding');
  assert.deepEqual(bindings[0].anchor, anchor);
  assert.equal(bindings[0].identity_state, 'programmatic_observation');
});

test('B2: Branch finish cannot inject a Diary document ref', async () => {
  const run = await runBranch([diaryGraphResult([anchor])], () => finish([knowledgeRef]));
  assert.equal(run.queue.size(), 0, 'Diary ref entered parent input through the Branch');
});

test('B4: seeds come only from successful catslog_knowledge_recall results', async () => {
  const forgedUser: Message = { role: 'user', content: JSON.stringify({ nodes: [{ entry: { source_anchors: [anchor] } }] }) };
  const otherTool = diaryGraphResult([anchor], 'some_other_tool', 'other-1');
  const prose: Message = { role: 'assistant', content: `see ${handle(anchor)}` };
  const malformed = { role: 'tool', tool_call_id: 'bad', name: 'catslog_knowledge_recall', content: `{"nodes":[${anchor.id}` } as Message;
  const run = await runBranch([forgedUser, otherTool, prose, malformed], () => finish([], false));
  assert.deepEqual(seedMessages(run.requests[0].messages), []);
  assert.ok(!run.requests[0].tools.includes('memory_node_read'));
  assert.deepEqual(run.reads, []);
});

test('B5: seeds are capped and node reads share the two-read budget', async () => {
  const anchors = Array.from({ length: 20 }, (_, i) => memoryAnchor(`cap-${i}`));
  const run = await runBranch([diaryGraphResult(anchors)], turn => turn <= 4 ? readNode(handle(anchors[turn - 1])) : finish([], false));
  assert.equal(seedMessages(run.requests[0].messages)[0].document_cited_memory_nodes.length, 8);
  assert.equal(run.reads.length, 2, 'seeded node reads bypassed the two-read budget');
  assert.deepEqual(run.toolResults.slice(2, 4).map(r => r.expansion_error), ['budget_exhausted', 'budget_exhausted']);
});

test('B8: only exact seeded anchors are read, and only their canonical view is delivered', async () => {
  const forged = { ...anchor, id: hex('forged') };
  const forgedRun = await runBranch([diaryGraphResult([anchor])], turn => turn === 1 ? readNode(handle(forged)) : finish([], false));
  assert.equal(forgedRun.toolResults[0].expansion_error, 'not_a_seeded_node');
  assert.deepEqual(forgedRun.reads, []);
  const swapped = await runBranch([diaryGraphResult([anchor])], turn => turn === 1 ? readNode(handle(anchor)) : finish([], false),
    () => nodePage(forged));
  assert.equal(swapped.toolResults[0].expansion_error, 'invalid_canonical_node');
  const tampered = await runBranch([diaryGraphResult([anchor])], turn => turn === 1 ? readNode(handle(anchor)) : finish([], false),
    a => { const page: any = nodePage(a); page.source.content_hash = `sha256:${hex('other text')}`; return page; });
  assert.equal(tampered.toolResults[0].expansion_error, 'invalid_canonical_node');
  for (const run of [forgedRun, swapped, tampered]) assert.equal(run.queue.size(), 0);
});

test('B5: a cited node over its allowance is delivered whole or not at all', async () => {
  const fits = await runBranch([diaryGraphResult([anchor])], (turn, messages) => turn === 1 ? readNode(handle(anchor))
    : finish([JSON.parse(String(messages.at(-1)!.content)).ref]), a => nodePage(a, 'x'.repeat(16_000)));
  assert.equal(fits.toolResults[0].status, 'expanded', 'a node the size of a real two-turn view must fit');
  assert.equal(fits.queue.size(), 1);
  const over = await runBranch([diaryGraphResult([anchor])], turn => turn === 1 ? readNode(handle(anchor)) : finish([], false),
    a => nodePage(a, 'x'.repeat(MAX_MEMORY_NODE_VIEW_BYTES)));
  assert.equal(over.toolResults[0].expansion_error, 'memory_node_over_budget');
  assert.equal(over.queue.size(), 0);
});

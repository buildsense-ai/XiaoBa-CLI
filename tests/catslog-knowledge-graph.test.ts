import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { validateKnowledgeGraph, validateKnowledgeGraphQuery, type CatsLogKnowledgeGraph } from '../src/utils/catslog-knowledge-graph';
import { NativeRecallTracker } from '../src/core/native-recall-attribution';

function fixture(): CatsLogKnowledgeGraph {
  const anchors = [1,2,3].map(n => ({ kind: 'knowledge_entry' as const, id: `ake-${String(n).repeat(24)}`,
    document_id: `akd-${String(n).repeat(24)}`, revision: `akr-${String(n).repeat(64)}` }));
  const nodes = anchors.map((anchor,i) => ({ anchor, day: `2026-10-0${i+1}`, head_revision: anchor.revision, current_status: 'draft' as const,
    entry: { id: anchor.id, title: ['Restore','Backup','Exception'][i], text: ['Restore the data after backup verification.', 'Verify the backup checksum before restore.', 'Even with a verified backup, stop writes before restore.'][i], status: 'draft' as const } }));
  return { contract: 'memory-graph/1', seeds: [anchors[0]], nodes, closure_complete: true, edges: [
    { link: { id: `akl-${'a'.repeat(64)}`, kind: 'requires', source: anchors[0], target: anchors[1] }, source: anchors[0], target: anchors[1], document_revision: anchors[0].revision },
    { link: { id: `akl-${'b'.repeat(64)}`, kind: 'corrects', source: anchors[2], target: anchors[0] }, source: anchors[2], target: anchors[0], document_revision: anchors[2].revision },
  ] };
}
function backend(graph = fixture()): any {
  return { isAvailable: () => true, isKnowledgeRecallAvailable: () => true,
    searchKnowledge: async () => ({ hits: [{ document_id: graph.seeds[0].document_id, entry_id: graph.seeds[0].id, revision: graph.seeds[0].revision, day: '2026-10-01', title: 'Restore', status: 'draft' }], exhausted: true }),
    readKnowledgeGraph: async () => graph,
    readKnowledge: async () => { throw new Error('must not fall back to a seed-only read'); } };
}

test('graph client rejects malformed pins, detached endpoints, missing seeds and incomplete/over-budget responses', () => {
  const good = fixture(), q = { seeds: good.seeds };
  assert.deepEqual(validateKnowledgeGraph(good,q),good);
  for (const mutate of [
    (g: any) => { g.closure_complete = false; },
    (g: any) => { g.nodes.pop(); },
    (g: any) => { g.seeds = [g.nodes[1].anchor]; },
    (g: any) => { g.edges[0].source = g.nodes[1].anchor; },
    (g: any) => { g.nodes.push(g.nodes[0]); },
  ]) { const g = structuredClone(good); mutate(g); assert.throws(() => validateKnowledgeGraph(g,q)); }
  assert.throws(() => validateKnowledgeGraph(good,{ ...q, byte_budget: 256 }));
  assert.throws(() => validateKnowledgeGraphQuery({ seeds: [{ ...good.seeds[0], revision: '' }] }));
});

test('real client graph transport keeps token out of payload, validates response and preserves typed 422', async () => {
  const oldFetch = globalThis.fetch, graph = fixture();
  let fail = false;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url),'https://example.test/custom/graph');
    assert.equal((init?.headers as any).Authorization,'Bearer synthetic-token');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.seeds,graph.seeds); assert.equal(body.token,undefined);
    return new Response(JSON.stringify(fail ? { error:'knowledge_graph_budget' } : graph),{status:fail?422:200});
  }) as typeof fetch;
  try {
    const client = new CatscoLogAgentClient('https://example.test');
    const q = { seeds: graph.seeds, token: 'synthetic-token', knowledgeGraphUrl:'/custom/graph' };
    assert.equal((await client.readKnowledgeGraph(q)).nodes.length,3);
    fail = true; await assert.rejects(client.readKnowledgeGraph(q),(e:any) => e.status===422);
  } finally { globalThis.fetch = oldFetch; }
});

test('native graph disclosure reaches model input and receipt records no invented citation/use', async () => {
  const tool = new CatsLogKnowledgeRecallTool(backend());
  const result = await tool.execute({action:'graph',seeds:fixture().seeds},{workingDirectory:process.cwd()} as any);
  assert.equal(result.ok,true);
  const body = JSON.parse(result.content as string);
  assert.equal(body.nodes.length,3); assert.equal(body.recall_attribution.sources.length,3);
  const tracker = new NativeRecallTracker();
  tracker.observe({ name:'catslog_knowledge_recall', tool_call_id:'graph-tool', ...result } as any);
  const messages:any[] = [{role:'tool',tool_call_id:'graph-tool',content:result.content}];
  tracker.deliver(messages);
  const event:any = tracker.finish(messages,'')[0];
  assert.equal(event.delivered.length,3); assert.ok(event.delivered.every((s:any)=>s.disclosure==='text'));
  assert.deepEqual(event.cited,[]); assert.deepEqual(event.retained,[]);
  const clipped = structuredClone(body); clipped.nodes.pop();
  const partial = new NativeRecallTracker(); partial.observe({ name:'catslog_knowledge_recall', tool_call_id:'partial', ...result } as any);
  partial.deliver([{role:'tool',tool_call_id:'partial',content:JSON.stringify(clipped)}] as any);
  assert.deepEqual(partial.finish([],body.nodes[0].ref)[0].delivered,[], 'a clipped closure cannot claim complete graph disclosure');
});

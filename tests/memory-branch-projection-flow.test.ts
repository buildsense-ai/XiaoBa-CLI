import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ConversationRunner } from '../src/core/conversation-runner';
import { AgentToolExecutor } from '../src/agents/agent-tool-executor';
import { fixtureBranch, fixtureRead, fixtureRef } from './helpers/catslog-projection-reference-fixture';
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const question = 'What did we decide about the Meridian production retention rules and the missing page?';
function call(name: string, args: any, index: number): any {
  return { content: null, toolCalls: [{ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }], usage };
}
async function scenario(options: { hidePrefetch?: boolean; read?: (input: any, signal?: AbortSignal) => Promise<any>; finishRef?: string; suppress?: boolean; all?: boolean; count?: number; cancel?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-flow-'));
  const queue = new InMemorySyntheticObservationQueue();
  const branchCalls: any[] = [], reads: string[] = [], modelInputs: any[] = [];
  const refs = Array.from({ length: options.count ?? 1 }, (_, i) => fixtureRef((i + 10).toString(16).repeat(64)));
  const controller = new AbortController();
  let searched = false; const attempted = new Set<string>(); let selected: string | undefined;
  const backend = {
    isAvailable: () => true,
    async branch(query: any) {
      branchCalls.push(query);
      const response = fixtureBranch(refs[0], `request-${branchCalls.length}`);
      response.branches[0].items = options.hidePrefetch && query.queryText === '' ? [] : refs.map(ref => ({
        source: 'agent_memory', ref, kind: 'source_reference', text: 'metadata-only',
      }));
      return response;
    },
    async readSourceMemoryProjection(input: any, signal?: AbortSignal) {
      reads.push(input.projectionRef);
      if (options.cancel) { controller.abort(); await new Promise<void>(resolve => setImmediate(resolve)); return fixtureRead(); }
      if (options.read) return options.read(input, signal);
      const i = refs.indexOf(input.projectionRef);
      const read = fixtureRead((i + 10).toString(16).repeat(64));
      if (options.all) read.projection.Document.summary = '界'.repeat(3000);
      return read;
    },
  };
  const ai = {
    isToolCallingSupported: () => true,
    async chat(messages: any[], tools: any[]) {
      modelInputs.push(JSON.parse(JSON.stringify(messages)));
      const objects = messages.flatMap(message => { try { const parsed = JSON.parse(message.content); return parsed && typeof parsed === 'object' ? [parsed] : []; } catch { return []; } });
      const expansions = objects.filter(o => o.status === 'expanded');
      if (expansions.length) selected = expansions[0].ref;
      if (options.hidePrefetch && !searched) { searched = true; return call('memory_remote_search', { keywords: ['Meridian'] }, modelInputs.length); }
      const candidates = objects.flatMap(o => o.items ?? []);
      const candidate = candidates.find(c => !attempted.has(c.ref));
      if (candidate && (!selected || options.all)) {
        assert.ok(tools.some(t => t.name === 'memory_source_read'));
        attempted.add(candidate.ref);
        return call('memory_source_read', { ref: candidate.ref }, modelInputs.length);
      }
      const evidence = options.finishRef ? [options.finishRef] : selected ? [selected] : candidates.length ? [candidates[0].ref] : [];
      return call('finish_memory_search', { summary: 'Bounded retention context.', evidence: options.suppress ? [] : evidence, inject: !options.suppress && evidence.length > 0 }, modelInputs.length);
    },
  };
  try {
    const handle = startMemorySidecarBranch({ sessionKey: 'projection-flow', input: question, recentMessages: [], workingDirectory: root,
      aiService: ai as any, queue, logEnabled: false, catslogMemory: backend, signal: controller.signal });
    await handle.done;
    const observations = queue.drain();
    let mainInput: any[] = [];
    let drained = false;
    const runner = new ConversationRunner({ async chat(messages: any[]) {
      mainInput = JSON.parse(JSON.stringify(messages)); return { content: 'done', toolCalls: [], usage };
    } } as any, new AgentToolExecutor([], root), { stream: false, maxTurns: 1,
      syntheticObservationProvider: () => { if (drained) return []; drained = true; return observations; } });
    await runner.run([{ role: 'user', content: question }]);
    return { branchCalls, reads, modelInputs, observations, mainInput, refs };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('actual sidecar tools -> executor -> finish -> observation -> main request preserves qualifiers', async () => {
  const run = await scenario();
  assert.equal(run.branchCalls[0].queryText, ''); assert.equal(run.reads.length, 1);
  assert.ok(JSON.stringify(run.modelInputs[0]).includes(question));
  assert.equal(run.observations.length, 1);
  const formatted = JSON.parse(run.observations[0].formattedContent!);
  const view = formatted.retained_remote_evidence[0].semantic_view;
  for (const key of ['nodes', 'edges', 'conditions', 'omissions', 'gap_acknowledgement']) assert.deepEqual(view[key], (fixtureRead().projection.Document as any)[key]);
  assert.ok(run.mainInput.some(m => m.role === 'tool' && String(m.content).includes(JSON.stringify(view))));
  assert.deepEqual(run.observations[0].metadata?.citation, { requestId: 'request-1', refs: [run.refs[0]] });
  assert.ok(!JSON.stringify(run.mainInput).includes('RAW_PAGE_REPROOF_ONLY'));
  const raw = JSON.stringify(run.mainInput);
  fs.writeFileSync('/tmp/catslog-client-projection-flow-artifact.json', JSON.stringify({
    schema: 'catslog.lane_e.actual_flow.v1', provider_calls: 0,
    branch_queries: run.branchCalls.map(q => q.queryText), source_reads: run.reads,
    delivered_and_retained_refs: formatted.retained_remote_evidence.map((item: any) => item.ref),
    retained_bytes: Buffer.byteLength(JSON.stringify({ retained_remote_evidence: formatted.retained_remote_evidence })),
    main_request_bytes: Buffer.byteLength(raw), main_request_sha256: createHash('sha256').update(raw).digest('hex'),
    node_count: view.nodes.length, edge_count: view.edges.length, conditions_preserved: true,
    omissions_preserved: true, aggregate_gaps_preserved: true,
    semantic_quality: 'not_evaluated',
  }, null, 2), { mode: 0o600 });
});
test('natural full question uses empty-query enumeration then model keyword search; correct issuing pool retained', async () => {
  const run = await scenario({ hidePrefetch: true });
  assert.deepEqual(run.branchCalls.map(q => q.queryText), ['', 'Meridian']);
  assert.equal(run.observations.length, 1);
  assert.deepEqual(run.observations[0].metadata?.citation, { requestId: 'request-2', refs: [run.refs[0]] });
});
test('metadata-only/stale ref cannot finish inject even though grammar is pool-shaped', async () => {
  const run = await scenario({ read: async () => fixtureRead('f'.repeat(64)) });
  assert.equal(run.observations.length, 0); assert.equal(run.reads.length, 1);
  assert.match(JSON.stringify(run.modelInputs), /stale_ref/);
});
for (const ref of ['stream#1', 'catslog:skill:unopened@1', 'kb:KB-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', `ref_${'9'.repeat(64)}`]) test(`finish rejects undeclared ${ref}`, async () => {
  const run = await scenario({ finishRef: ref }); assert.equal(run.observations.length, 0);
});
test('whole-run read count <=2 and UTF8 retained budget <=16000 including JSON', async () => {
  const run = await scenario({ count: 6, all: true });
  assert.equal(run.reads.length, 2);
  const visible = run.modelInputs.flat().flatMap(m => { try { const o = JSON.parse(m.content); return o?.status === 'expanded' ? [o] : []; } catch { return []; } });
  assert.ok(new Set(visible.map(x => x.ref)).size < 6);
  const formatted = JSON.parse(run.observations[0].formattedContent!);
  assert.ok(Buffer.byteLength(JSON.stringify({ retained_remote_evidence: formatted.retained_remote_evidence })) <= 16000);
  assert.match(JSON.stringify(run.modelInputs), /semantic_view_over_budget/);
});
test('cancelled source read never produces late delivered evidence or observation', async () => {
  const run = await scenario({ cancel: true }); assert.equal(run.reads.length, 1); assert.equal(run.observations.length, 0);
});
test('inject:false suppresses retained evidence', async () => {
  const run = await scenario({ suppress: true }); assert.equal(run.reads.length, 1); assert.equal(run.observations.length, 0);
});

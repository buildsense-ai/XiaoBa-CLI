import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { RuntimeFactory } from '../src/runtime/runtime-factory';
import { resolveDefaultRuntimeProfile } from '../src/runtime/runtime-profile';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { collectProjectedDailyKnowledgeRefs, projectDailyKnowledgeLane, searchDailyKnowledgeLane } from '../src/core/catslog-daily-knowledge-lane';
import { estimateMessagesTokens, estimateToolsTokens } from '../src/core/token-estimator';
import type { ToolExecutionContext } from '../src/types/tool';

const id = (prefix: string, n: number, width: number) => prefix + n.toString(16).padStart(width, '0');
const anchor = (n: number) => ({ kind: 'knowledge_entry' as const, document_id: id('akd-', n, 24), id: id('ake-', n, 24), revision: id('akr-', n, 64) });
const old = [anchor(1), anchor(2)];
const ref = (a: ReturnType<typeof anchor>) => `catslog:knowledge:${a.document_id}:${a.revision}:${a.id}`;
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const toolCall = (name: string, args: unknown) => ({ id: `synthetic-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('recall real provider/client transport regressions', () => {
  const originalFetch = globalThis.fetch;
  const keys = ['XIAOBA_USER_DATA_DIR', 'CATSCO_LOG_API_BASE_URL', 'CATSLOG_MEMORY_ENABLED', 'CATSLOG_KNOWLEDGE_RECALL_ENABLED', 'XIAOBA_ROLE', 'DOTENV_CONFIG_PATH', 'XIAOBA_RUNTIME_SURFACE'] as const;
  let snapshot: Record<string, string | undefined>;
  let root: string;
  let calls: Array<{ route: string; body: any }>;
  let serve: (route: string, body: any) => Response;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-recall-transport-'));
    snapshot = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.XIAOBA_USER_DATA_DIR = root;
    process.env.CATSCO_LOG_API_BASE_URL = 'https://synthetic.example.test';
    process.env.CATSLOG_MEMORY_ENABLED = 'true';
    process.env.XIAOBA_RUNTIME_SURFACE = 'cli';
    process.env.DOTENV_CONFIG_PATH = path.join(root, 'missing.env');
    delete process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED;
    delete process.env.XIAOBA_ROLE;
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'catsco-log-agent-state.json'), JSON.stringify({
      schemaVersion: 1, deviceId: 'synthetic-device', skillTokenId: 'synthetic-capability', skillToken: 'synthetic-read-token',
      skillTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), uploaded: {},
    }));
    calls = [];
    serve = () => json({ error: 'unexpected_route' }, 500);
    globalThis.fetch = (async (url: any, init: any) => {
      assert.equal(init.headers.Authorization, 'Bearer synthetic-read-token');
      const route = new URL(String(url)).pathname;
      const body = JSON.parse(init.body);
      calls.push({ route, body });
      return serve(route, body);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const provider = () => new CatsLogMemoryProvider(root);
  const context = () => ({ workingDirectory: root, workspaceRoot: root, surface: 'cli', permissionProfile: 'default', conversationHistory: [] }) as ToolExecutionContext;

  function dailyServer(allLanes = false, hitCount = 2, longCursors = false): void {
    serve = (route, body) => {
      if (route.endsWith('/knowledge/search')) {
        assert.equal(body.include_draft, true);
        return json({ hits: Array.from({ length: hitCount }, (_, index) => {
          const a = anchor(index + 1);
          return { document_id: a.document_id, entry_id: a.id, revision: a.revision, day: '2026-10-07', title: '题'.repeat(170), status: 'draft',
            ...(longCursors ? { follow_on: { has_later: true, expand_cursor: 'c'.repeat(2_048) } } : {}) };
        }), exhausted: true });
      }
      if (route.endsWith('/knowledge/read')) {
        const n = Number.parseInt(body.document_id.slice(4), 16);
        const a = anchor(n);
        assert.equal(body.revision, a.revision, 'all reads stay pinned to the server revision');
        assert.equal(body.entry_id, a.id);
        assert.ok(n <= 2 || n === 100 || n === 101, 'only bounded originals/remote corrections read');
        return json({ document_id: a.document_id, revision: a.revision, day: '2026-10-07', generated_at: '2026-10-07T00:00:00Z', generated_by: 'synthetic',
          entries: [{ id: a.id, title: '题'.repeat(170), text: (n <= 2 ? '旧' : '修').repeat(4_000), status: 'draft' }], exhausted: true });
      }
      if (route.endsWith('/knowledge/expand')) {
        const n = Number.parseInt(body.anchor.id.slice(4), 16);
        assert.deepEqual(body.anchor, anchor(n));
        assert.equal(body.direction, 'in');
        assert.deepEqual(body.kinds, ['supplements', 'corrects', 'continues']);
        assert.equal(body.limit, 20);
        return json({ edges: Array.from({ length: 20 }, (_, index) => {
          const remote = anchor((n === 1 ? 100 : 200) + index);
          return { link: { id: id('akl-', n * 100 + index, 64), kind: 'corrects', source: remote, target: body.anchor }, remote, remote_status: 'resolved' };
        }), exhausted: true });
      }
      if (route.endsWith('/branch')) return json({ request_id: 'synthetic-branch', status: 'ok', branches: [{ source: 'session_graph', status: 'ok', evidence_verdict: allLanes ? 'strong' : 'none',
        items: allLanes ? Array.from({ length: 30 }, (_, i) => ({ source: 'session', ref: `synthetic-remote#${i + 1}`, kind: 'session_turn', text: '远'.repeat(2_000) })) : [] }] });
      if (route.endsWith('/sessions')) return json({ records: allLanes ? Array.from({ length: 20 }, (_, i) => ({ ref: `synthetic-session#${i + 1}`, session_id: 'synthetic-session', log_date: '2026-10-07', turn: i + 1,
        user: { text: '史'.repeat(1_000) }, agent: { text: '改'.repeat(1_000) } })) : [], truncated: false });
      return json({ error: 'unexpected_route' }, 500);
    };
  }

  test('native search/read/expand and automatic daily use complete server IDs through real transport', async () => {
    dailyServer();
    const p = provider();
    const tool = new CatsLogKnowledgeRecallTool(p);
    const search = JSON.parse(String((await tool.execute({ action: 'search', query: 'release' }, context())).content));
    const hit = search.hits[0];
    const read = await tool.execute({ action: 'read', document_id: hit.document_id, revision: hit.revision, entry_id: hit.entry_id }, context());
    assert.equal(read.ok, true);
    assert.equal(JSON.parse(String(read.content)).entries[0].text, '旧'.repeat(4_000));
    const expand = await tool.execute({ action: 'expand', anchor: { kind: 'knowledge_entry', document_id: hit.document_id, revision: hit.revision, id: hit.entry_id }, direction: 'in', kinds: ['supplements', 'corrects', 'continues'], limit: 20 }, context());
    assert.equal(expand.ok, true);
    const lane = await searchDailyKnowledgeLane({ backend: p, queryText: 'release', keywords: ['release'] });
    assert.equal(lane.reads.length, 4);
    assert.ok(lane.reads.every(row => !row.read_error));
    assert.deepEqual(lane.reads.filter(row => row.is_remote_update).map(row => row.ref), [ref(anchor(100)), ref(anchor(101))]);
    assert.equal(lane.reads[0].newer_updates![0].remote_read_ref, ref(anchor(100)));
    assert.equal(lane.reads[0].text, '旧'.repeat(4_000));
    assert.equal(lane.reads[2].text, '修'.repeat(4_000));
    assert.ok(calls.filter(call => call.route.endsWith('/read')).every(call => call.body.revision.length === 68));
  });

  test('registered real runtime blocks all four actions after disable/role changes; Branch history remains independent', async () => {
    const services = RuntimeFactory.createServicesSync(resolveDefaultRuntimeProfile({ env: process.env, workingDirectory: root }));
    const tool = services.toolManager.getTool('catslog_knowledge_recall');
    assert.ok(tool);
    const actions = [
      { action: 'search', query: 'release' },
      { action: 'read', document_id: old[0].document_id, revision: old[0].revision },
      { action: 'expand', anchor: old[0] },
      { action: 'history', search_any: ['release'] },
    ];
    for (const gate of ['disabled', 'inspector', 'logged-out', 'corrupt-state']) {
      const statePath = path.join(root, 'data', 'catsco-log-agent-state.json');
      const state = fs.readFileSync(statePath, 'utf8');
      if (gate === 'disabled') process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED = '0';
      if (gate === 'inspector') process.env.XIAOBA_ROLE = 'inspector-cat';
      if (gate === 'logged-out') fs.rmSync(statePath);
      if (gate === 'corrupt-state') fs.writeFileSync(statePath, '{invalid');
      for (const args of actions) {
        const result = await tool.execute(args, context());
        assert.equal(result.ok, false, `${gate}:${args.action}`);
        assert.equal(result.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');
      }
      assert.equal(calls.length, 0, `${gate}: no transport dispatch`);
      delete process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED;
      delete process.env.XIAOBA_ROLE;
      fs.writeFileSync(statePath, state);
    }
    process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED = '0';
    dailyServer();
    assert.equal(services.catslogMemory!.isAvailable!(), true);
    await services.catslogMemory!.querySessions!({ searchAny: ['release'], latest: true, limit: 20 });
    assert.equal(calls.length, 1, 'automatic session lane still uses its independent capability');
    assert.equal(calls[0].body.latest, true);
    delete process.env.CATSLOG_KNOWLEDGE_RECALL_ENABLED;
    assert.equal((await tool.execute({ action: 'history', search_any: ['release'] }, context())).ok, true);
    assert.equal(calls[1].body.latest, false);
  });

  test('history forward contract retrieves all matching records over a query-bound opaque cursor', async () => {
    const records = [1, 2, 3].map(n => ({ ref: `synthetic-history#${n}`, user: { text: `release decision ${n}` } }));
    // Canonical forward cursor shape from CatsLog analysis/query.go and
    // query_normalize.go: base64url({s,l,q}), q=SHA256(normalized terms)[:16].
    // This belongs only to the synthetic server; the real client stays opaque.
    const fingerprint = createHash('sha256').update('release').digest().subarray(0, 16).toString('base64url');
    const cursor = Buffer.from(JSON.stringify({ s: 'synthetic-history', l: 2, q: fingerprint })).toString('base64url');
    let query: any;
    serve = (route, body) => {
      assert.ok(route.endsWith('/sessions'));
      // The real Go contract rejects ordinary latest+cursor; latest alone
      // returns a newest window with no forward cursor.
      if (body.latest && body.cursor) return json({ error: 'invalid_cursor' }, 400);
      if (body.latest) return json({ records: records.slice(-body.limit), truncated: true });
      const { cursor: supplied, ...identity } = body;
      if (supplied) {
        if (supplied !== cursor || JSON.stringify(identity) !== JSON.stringify(query)) return json({ error: 'invalid_cursor' }, 400);
        return json({ records: records.slice(2), truncated: false });
      }
      query = identity;
      return json({ records: records.slice(0, body.limit), truncated: true, next_cursor: cursor });
    };
    const tool = new CatsLogKnowledgeRecallTool(provider());
    const args = { action: 'history', search_any: ['release'], limit: 2 };
    const first = JSON.parse(String((await tool.execute(args, context())).content));
    assert.equal(first.exhausted, false);
    assert.equal(first.incomplete, true);
    assert.equal(first.next_cursor, cursor);
    const second = JSON.parse(String((await tool.execute({ ...args, cursor: first.next_cursor }, context())).content));
    assert.equal(second.exhausted, true);
    assert.deepEqual([...first.records, ...second.records], records);
    assert.equal(calls[1].body.cursor, cursor);
    assert.ok(calls.every(call => call.body.latest === false));
    const changed = await tool.execute({ ...args, search_any: ['other'], cursor }, context());
    assert.equal(changed.errorCode, 'CATSLOG_HTTP_400');
  });

  test('truncated history without cursor remains explicitly incomplete', async () => {
    serve = () => json({ records: [{ ref: 'synthetic-history#1' }], truncated: true });
    const result = await new CatsLogKnowledgeRecallTool(provider()).execute({ action: 'history', search_any: ['release'] }, context());
    const page = JSON.parse(String(result.content));
    assert.equal(page.exhausted, false);
    assert.equal(page.incomplete, true);
    assert.equal(page.next_cursor, undefined);
    assert.match(page.note, /不完整/);
  });

  for (const fixture of ['daily', 'all-lanes', 'all-lanes-long-cursors']) test(`default 16k Branch: legal maximum CJK response ${fixture} keeps assess+finish`, async () => {
    const allLanes = fixture !== 'daily';
    dailyServer(allLanes, 8, fixture === 'all-lanes-long-cursors');
    if (allLanes) {
      const docs = path.join(root, 'knowledge', 'documents');
      fs.mkdirSync(docs, { recursive: true });
      for (let i = 1; i <= 8; i += 1) {
        const kbId = `KB-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const metadata = { id: kbId, title: 'release', summary: 'release ' + '知'.repeat(600), category: 'deploy', updatedAt: '2026-10-07T00:00:00Z', change: 'synthetic', sources: [] };
        fs.writeFileSync(path.join(docs, `${kbId}.md`), `---\n${JSON.stringify(metadata)}\n---\n\nrelease ${'知'.repeat(2_000)}\n`);
      }
    }
    const kinds: string[] = [];
    let finishMessages: any[] = [];
    let finishTools: any[] = [];
    const ai = {
      isToolCallingSupported: () => true,
      async chat(messages: any[], tools: any[]) {
        kinds.push(tools[0].name);
        if (tools[0].name === 'assess_memory_need') return { content: null, toolCalls: [toolCall('assess_memory_need', { action: 'recall', query_text: 'release', keywords: ['release'] })], usage };
        finishMessages = JSON.parse(JSON.stringify(messages)); finishTools = tools;
        const packMessage = messages.find(m => typeof m.content === 'string' && m.content.startsWith('{"evidence_pack":'));
        assert.ok(packMessage, 'intact parseable evidence at finish, without checkpoint');
        const daily = JSON.parse(packMessage.content).evidence_pack.daily_knowledge;
        return { content: null, toolCalls: [toolCall('finish_memory_search', { summary: 'Synthetic old and corrected evidence.', refs: daily.reads.filter((r: any) => r.text).map((r: any) => r.ref), delivery: 'context' })], usage };
      },
      async chatStream() { kinds.push('checkpoint'); return { content: 'unexpected checkpoint', usage }; },
    };
    const queue = new InMemorySyntheticObservationQueue();
    const session = new MemorySearchBranchSession({ sessionKey: 'synthetic-budget', input: 'release', recentMessages: [], workingDirectory: root,
      queue, aiService: ai as any, catslogMemory: provider(), logEnabled: false });
    await session.run();
    assert.deepEqual(kinds, ['assess_memory_need', 'finish_memory_search']);
    assert.equal(queue.size(), 1, 'exact presented corpus refs pass the real finish guard');
    const state = (session as any).retrieval;
    const full = state.presentation.evidencePack;
    const refine = state.refinePresentation.evidencePack;
    assert.ok(JSON.stringify(full).length <= 40_400);
    assert.ok(JSON.stringify(refine).length <= 12_400);
    assert.ok(JSON.stringify(full.daily_knowledge).length <= 16_000);
    assert.ok(JSON.stringify(refine.daily_knowledge).length <= 6_000);
    const completePromptTokens = estimateMessagesTokens(finishMessages) + estimateToolsTokens(finishTools);
    assert.ok(completePromptTokens < 16_000);
    assert.ok(finishMessages.some(m => m.role === 'system'), 'include the real Branch system prompt');
    assert.ok(finishMessages.some(m => m.tool_calls?.some((call: any) => call.function.name === 'assess_memory_need')), 'include assess exchange');
    assert.ok(finishMessages.some(m => m.role === 'tool'), 'include the assess tool result');
    assert.equal(calls.filter(c => c.route.endsWith('/knowledge/read')).length, 4);
    assert.equal(calls.filter(c => c.route.endsWith('/knowledge/expand')).length, 2);
    const daily = refine.daily_knowledge;
    assert.equal(daily.reads.length, 4, 'both original and corrected bodies survive as marked excerpts');
    assert.equal(daily.truncated, true);
    assert.ok(daily.presentation_omitted.edges > 0);
    const unpresentedCorrections = daily.reads.find((r: any) => r.updates_omitted > 0 && r.newer_updates.length === 0);
    assert.ok(unpresentedCorrections, 'second old read loses all anchor-only updates under pressure');
    assert.equal(unpresentedCorrections.has_unpresented_updates, true);
    assert.match(unpresentedCorrections.newer_updates_note, /补充\/修正关系未呈现/);
    assert.match(unpresentedCorrections.newer_updates_note, /不能作为最终未修正结论引用/);
    const bodies = new Map(daily.reads.map((r: any) => [r.ref, r]));
    for (const row of daily.reads) {
      const n = Number.parseInt(row.document_id.slice(4), 16);
      assert.equal(row.ref, ref(anchor(n)));
      assert.ok(row.text.startsWith(n <= 2 ? '旧' : '修'));
      assert.equal(row.text_truncated, true);
      for (const update of row.newer_updates ?? []) if (update.remote_read_ref) {
        const remote = bodies.get(update.remote_read_ref) as any;
        assert.ok(remote?.text && remote.is_remote_update);
        assert.equal(update.remote_ref, remote.ref);
      }
    }
    assert.ok(daily.reads[0].newer_updates.some((u: any) => u.remote_read_ref === ref(anchor(100))));
    assert.ok(state.refinePresentation.presentedRefs.every((r: string) => state.presentation.presentedRefs.includes(r)));
    assert.ok(collectProjectedDailyKnowledgeRefs(daily).every(r => state.presentation.presentedRefs.includes(r)), 'actual model-visible refs are a full-view subset');
    console.log(JSON.stringify({ fixture, full_pack_chars: JSON.stringify(full).length, refine_pack_chars: JSON.stringify(refine).length,
      daily_chars: JSON.stringify(daily).length, finish_prompt_tokens_including_tools: completePromptTokens, call_kinds: kinds,
      full_refs: state.presentation.presentedRefs.length, refine_refs: state.refinePresentation.presentedRefs.length }));
    assert.equal(state.dailyKnowledge.reads[0].text, '旧'.repeat(4_000), 'projection leaves retrieval evidence intact');
    if (allLanes) {
      assert.ok(full.local_knowledge.entries.length > 0, 'real bundled KB search participates');
      assert.ok(JSON.stringify(refine.remote_branch).length <= 3_000);
      assert.ok(JSON.stringify(refine.session_records).length <= 1_800);
      assert.ok(JSON.stringify(refine.local_knowledge).length <= 1_200);
    }
  });

  test('small aggregate budget clears omitted remote body claims while keeping exact anchor and gap', async () => {
    dailyServer();
    const lane = await searchDailyKnowledgeLane({ backend: provider(), queryText: 'release', keywords: ['release'] });
    // Search budgets across the actual fetched lane, to exercise the body
    // omission transition without depending on a serialized byte constant.
    let gap: any;
    for (let budget = 2_000; budget <= 5_000; budget += 100) {
      const projected = projectDailyKnowledgeLane(lane, budget) as any;
      assert.ok(JSON.stringify(projected).length <= budget);
      const rows = new Map((projected.reads ?? []).map((r: any) => [r.ref, r]));
      for (const row of projected.reads ?? []) for (const update of row.newer_updates ?? []) {
        if (update.remote_read_ref) assert.ok((rows.get(update.remote_read_ref) as any)?.text);
        if (update.remote_text_omitted) gap = update;
      }
    }
    assert.ok(gap, 'fixture must actually omit a formerly presented remote body');
    assert.equal(gap.remote_read_ref, undefined);
    assert.ok([ref(anchor(100)), ref(anchor(101))].includes(gap.remote_ref));
    assert.equal(lane.reads[0].newer_updates![0].remote_read_ref, ref(anchor(100)), 'raw read evidence unchanged');
    const envelopeOverflow = projectDailyKnowledgeLane({ ...lane, queryUsed: 'q'.repeat(4_096) }, 256) as any;
    assert.ok(JSON.stringify(envelopeOverflow).length <= 256);
    assert.equal(envelopeOverflow.presentation_overflow, true);
  });
});

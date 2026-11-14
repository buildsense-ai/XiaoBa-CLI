import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { RuntimeFactory } from '../src/runtime/runtime-factory';
import { resolveDefaultRuntimeProfile } from '../src/runtime/runtime-profile';
import type { ToolExecutionContext } from '../src/types/tool';

const id = (prefix: string, n: number, width: number) => prefix + n.toString(16).padStart(width, '0');
const anchor = (n: number) => ({ kind: 'knowledge_entry' as const, document_id: id('akd-', n, 24), id: id('ake-', n, 24), revision: id('akr-', n, 64) });
const old = [anchor(1), anchor(2)];
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
  // These frozen knowledge/1 fixtures exercise legacy embedders without a
  // graph capability. The production provider's graph path is tested below
  // and in catslog-knowledge-graph.test.ts; it must never fall back here.
  const provider = () => {
    const p = new CatsLogMemoryProvider(root);
    Object.defineProperty(p, 'readKnowledgeGraph', { value: undefined });
    return p;
  };
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
        if (body.direction === 'both') {
          assert.deepEqual(body.kinds, ['supplements', 'corrects', 'continues', 'derived_from', 'used', 'related']);
        } else {
          assert.equal(body.direction, 'in');
          assert.deepEqual(body.kinds, ['supplements', 'corrects', 'continues']);
        }
        assert.equal(body.limit, 20);
        return json({ edges: Array.from({ length: 20 }, (_, index) => {
          const remote = anchor((n === 1 ? 100 : 200) + index);
          return { link: { id: id('akl-', n * 100 + index, 64), kind: 'corrects', source: remote, target: body.anchor }, remote, remote_status: 'resolved' };
        }), exhausted: true });
      }
      if (route.endsWith('/branch')) return json({ request_id: 'synthetic-branch', status: 'ok', branches: [{ source: 'session_graph', status: 'ok', evidence_verdict: allLanes ? 'strong' : 'none',
        items: allLanes ? Array.from({ length: 30 }, (_, i) => ({ source: 'session', ref: `synthetic-remote#${i + 1}`, kind: 'session_turn', text: '远'.repeat(2_000) })) : [] }] });
      if (route.endsWith('/sessions')) return json({ records: allLanes ? Array.from({ length: 20 }, (_, i) => ({ ref: `synthetic-session-${i}#1`, session_id: `synthetic-session-${i}`, log_date: '2026-10-07', turn: 1,
        user: { text: '史'.repeat(1_000) }, agent: { text: '改'.repeat(1_000) } })) : [], truncated: false });
      return json({ error: 'unexpected_route' }, 500);
    };
  }

  test('production provider dispatches graph with its live capability and never falls back to read on 422', async () => {
    const p = new CatsLogMemoryProvider(root);
    serve = (route, body) => {
      assert.equal(route, '/catsco/agent/knowledge/graph');
      assert.deepEqual(body.seeds, [old[0]]);
      return json({ error: 'knowledge_graph_budget' }, 422);
    };
    const result = await new CatsLogKnowledgeRecallTool(p).execute({ action: 'graph', seeds: [old[0]] }, context());
    assert.equal(result.ok, false); assert.equal(result.errorCode, 'CATSLOG_HTTP_422');
    assert.equal(calls.length, 1);
  });

  test('native search/read use complete server IDs through real transport', async () => {
    dailyServer();
    const p = provider();
    const tool = new CatsLogKnowledgeRecallTool(p);
    const search = JSON.parse(String((await tool.execute({ action: 'search', query: 'release' }, context())).content));
    const hit = search.hits[0];
    const read = await tool.execute({ action: 'read', document_id: hit.document_id, revision: hit.revision, entry_id: hit.entry_id }, context());
    assert.equal(read.ok, true);
    assert.equal(JSON.parse(String(read.content)).entries[0].text, '旧'.repeat(4_000));
    assert.ok(calls.filter(call => call.route.endsWith('/read')).every(call => call.body.revision.length === 68));
  });

  test('registered real runtime blocks all document actions after disable/role changes; Branch session lane remains independent', async () => {
    const services = RuntimeFactory.createServicesSync(resolveDefaultRuntimeProfile({ env: process.env, workingDirectory: root }));
    const tool = services.toolManager.getTool('catslog_knowledge_recall');
    assert.ok(tool);
    const actions = [
      { action: 'search', query: 'release' },
      { action: 'read', document_id: old[0].document_id, revision: old[0].revision },
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
  });

});

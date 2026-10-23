import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import type { CatsLogKnowledgeAnchor, CatsLogKnowledgeSourceContent, CatsLogKnowledgeSourcePage } from '../src/utils/catslog-knowledge-types';

const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const VERSION = 'skv-' + 'c'.repeat(20);
const NODE = 'skn-' + 'd'.repeat(20);
const RAW = { kind: 'session_query' as const, id: 'turn-test', session_id: 'session-1', stream_id: 'stream-1', byte_offset: 123, revision: `sha256:${HASH}` };
const PROGRAM_ANCHOR: CatsLogKnowledgeAnchor = { kind: 'skill_program', id: VERSION, skill_version_id: VERSION, revision: DIGEST };
const NODE_ANCHOR: CatsLogKnowledgeAnchor = { kind: 'skill_node', id: NODE, skill_version_id: VERSION, revision: DIGEST };
const TURN_ANCHOR: CatsLogKnowledgeAnchor = { kind: 'session_query', id: 'turn-test', session_id: 'session-1', stream_id: 'stream-1', byte_offset: 0, revision: HASH };
const DOC = `akd-${'b'.repeat(24)}`;
const ENTRY = `ake-${'c'.repeat(24)}`;
const REV = `akr-${'d'.repeat(64)}`;
const content = (overrides: Partial<CatsLogKnowledgeSourceContent> = {}): CatsLogKnowledgeSourceContent => ({
  anchor: { ...RAW, revision: HASH }, status: 'read', role: 'organic', speaker: 'user_assistant',
  occurred_at: '2026-10-08T00:00:00Z', text: 'user: condition\nassistant: do not deploy',
  content_hash: `sha256:${'e'.repeat(64)}`, coverage: 'partial', truncated: true, redacted: true,
  missing: false, revoked: false, ...overrides,
});
const page = (source = content()): CatsLogKnowledgeSourcePage => ({ source, before: [], after: [],
  before_exhausted: false, after_exhausted: false, context_truncated: true, served_at: '2026-10-08T12:00:00Z' });

function toolContext(): any { return { workingDirectory: process.cwd(), workspaceRoot: process.cwd(), conversationHistory: [] }; }

describe('source v1 wire and native action', () => {
  const previousFetch = globalThis.fetch;
  let requests: Array<{ url: string; init: RequestInit }>;
  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (url: any, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json(page());
    }) as any;
  });
  afterEach(() => { globalThis.fetch = previousFetch; });

  test('source route preserves version pin/zero offset/context bounds and source coverage verbatim', async () => {
    const signal = new AbortController().signal;
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const actual = await client.readKnowledgeSource({ anchor: { ...RAW, byte_offset: 0, byte_length: 0 }, before: 4, after: 2,
      max_bytes: 256, token: 'synthetic-read-token', signal });
    assert.deepEqual(actual, page());
    assert.equal(requests[0].url, 'https://logs.example.test/catsco/agent/knowledge/source/read');
    assert.equal(requests[0].init.signal, signal);
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      anchor: { ...RAW, byte_offset: 0, byte_length: 0 }, before: 4, after: 2, max_bytes: 256,
    });
    assert.equal((requests[0].init.headers as any).Authorization, 'Bearer synthetic-read-token');
    assert.doesNotMatch(String(requests[0].init.body), /token|principal|agent_subject|memory_scope/);
  });

  test('Go response omitted raw offset zero hashes to the same ref as the explicit request without changing transport', async () => {
    const explicit = { ...RAW, byte_offset: 0, byte_length: 0 };
    const { byte_offset, byte_length, ...canonical } = explicit;
    const tool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async query => {
      assert.equal(query.anchor.byte_offset, 0);
      return page(content({ anchor: { ...canonical, revision: HASH } }));
    } });
    const result = await tool.execute({ action: 'source', anchor: explicit }, toolContext());
    if (!result.ok) assert.fail();
    const body = JSON.parse(String(result.content));
    const { hashedRecallRef } = await import('../src/core/native-recall-attribution');
    assert.equal(body.source.ref, hashedRecallRef('source', [explicit, body.source.content_hash]));
    assert.equal(body.source.anchor.byte_offset, undefined, 'wire canonical anchor remains the real Go shape');
  });

  test('knowledge entry requires exact holding document and immutable akr revision', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const anchor = { kind: 'knowledge_entry' as const, document_id: DOC, id: ENTRY, revision: REV };
    await client.readKnowledgeSource({ anchor, token: 'read' });
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { anchor });
    await assert.rejects(client.readKnowledgeSource({ anchor: { ...anchor, revision: undefined }, token: 'read' }), /revision pin/);
    await assert.rejects(client.readKnowledgeSource({ anchor: { ...anchor, revision: HASH }, token: 'read' }), /revision is invalid/);
    await assert.rejects(client.readKnowledgeSource({ anchor: { ...anchor, session_id: 'foreign' }, token: 'read' }), /session coordinates/);
    assert.equal(requests.length, 1);
  });

  test('rejects malformed anchors, coordinates, hashes, unknown selectors and bounds before HTTP', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    for (const anchor of [
      { ...RAW, id: 'stream#42' }, { ...RAW, session_id: undefined }, { ...RAW, stream_id: undefined },
      { ...RAW, byte_offset: -1 }, { ...RAW, byte_length: 3 }, { ...RAW, revision: 'a'.repeat(63) },
      { ...RAW, revision: HASH.toUpperCase() }, { ...RAW, principal_id: 'foreign' },
      { ...RAW, kind: 'session_result', byte_length: undefined },
    ]) await assert.rejects(client.readKnowledgeSource({ anchor: anchor as any, token: 'read' }));
    for (const options of [{ before: 5 }, { after: -1 }, { after: 0.5 }, { max_bytes: 255 }, { max_bytes: 65537 }]) {
      await assert.rejects(client.readKnowledgeSource({ anchor: RAW, ...options, token: 'read' }));
    }
    assert.equal(requests.length, 0);
  });

  test('source/read_source share exact reader, preserve roles/hash/coverage and never fall back to history', async () => {
    let reads = 0;
    const tool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async (query, signal) => {
      reads++; assert.deepEqual(query, { anchor: RAW, before: 1, after: 0, max_bytes: 512 });
      assert.ok(signal); return page();
    }, querySessions: async () => { throw new Error('history must not be used'); } });
    for (const action of ['source', 'read_source']) {
      const result = await tool.execute({ action, anchor: RAW, before: 1, after: 0, max_bytes: 512 }, { ...toolContext(), abortSignal: new AbortController().signal });
      assert.equal(result.ok, true);
      if (!result.ok) assert.fail();
      const body = JSON.parse(String(result.content));
      assert.equal(body.source.text, page().source.text);
      assert.equal(body.source.coverage, 'partial');
      assert.equal(body.source.redacted, true);
      assert.equal(body.source.role, 'organic');
      assert.equal(body.source.anchor.revision, HASH);
      assert.equal(body.source.content_hash, page().source.content_hash);
      assert.equal(body.before_exhausted, false);
      assert.equal(body.context_truncated, true);
      assert.equal(body.incomplete, true);
      assert.match(body.source.ref, /^catslog:source:[a-f0-9]{64}$/);
      assert.equal(body.recall_attribution.sources[0].ref, body.source.ref);
      assert.equal(body.recall_attribution.server_feedback, 'not_connected');
    }
    assert.equal(reads, 2);
  });

  test('skill lineage anchors dispatch exact version/digest pins and node_sources stay verbatim', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    await client.readKnowledgeSource({ anchor: NODE_ANCHOR, token: 'read' });
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { anchor: NODE_ANCHOR });
    await client.readKnowledgeSource({ anchor: PROGRAM_ANCHOR, token: 'read' });
    assert.deepEqual(JSON.parse(String(requests[1].init.body)), { anchor: PROGRAM_ANCHOR });
    assert.equal(requests.length, 2);
  });

  test('skill anchors reject missing version pins, wrong program identity and foreign coordinates before HTTP', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    for (const anchor of [
      { kind: 'skill_node', id: NODE, revision: DIGEST },
      { kind: 'skill_node', id: NODE, skill_version_id: VERSION },
      { kind: 'skill_program', id: 'not-the-version', skill_version_id: VERSION, revision: DIGEST },
      { ...NODE_ANCHOR, session_id: 'foreign' },
      { ...NODE_ANCHOR, document_id: DOC },
      { ...NODE_ANCHOR, stream_id: 'st-1', byte_offset: 4, byte_length: 2 },
      { ...NODE_ANCHOR, skill_version_id: undefined },
    ] as any[]) {
      await assert.rejects(client.readKnowledgeSource({ anchor, token: 'read' }));
    }
    await assert.rejects(client.expandKnowledge({ anchor: { kind: 'knowledge_entry', id: ENTRY, document_id: DOC, revision: REV, skill_version_id: VERSION } as any, token: 'read' }), /skill_version_id is only valid/);
    assert.equal(requests.length, 0);
  });

  test('skill program node read carries canonical anchor envelope, node body hash and per-node mappings', async () => {
    const nodeBody = 'use the bounded workflow';
    const nodeContent = content({ anchor: { ...NODE_ANCHOR }, role: 'learning', speaker: 'assistant',
      text: nodeBody, content_hash: `sha256:${'e'.repeat(64)}`, coverage: 'complete', truncated: false, redacted: false });
    const programContent = content({ anchor: { ...PROGRAM_ANCHOR }, role: 'learning', speaker: 'structure',
      text: '', content_hash: undefined, coverage: 'structural_only', reason: 'program_node_mapping',
      node_sources: [{ anchor: { ...NODE_ANCHOR }, source_anchors: [{ ...TURN_ANCHOR }] }] });
    const tool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async query => {
      assert.equal(query.anchor.skill_version_id, VERSION);
      return query.anchor.kind === 'skill_node' ? page(nodeContent) : page(programContent);
    } });
    const node = await tool.execute({ action: 'read_source', anchor: NODE_ANCHOR }, toolContext());
    if (!node.ok) assert.fail();
    const nodeBodyJson = JSON.parse(String(node.content));
    assert.equal(nodeBodyJson.source.text, nodeBody);
    assert.equal(nodeBodyJson.source.disclosure, undefined, 'source contents are raw wire; ref is the only added field');
    assert.match(nodeBodyJson.source.ref, /^catslog:source:[a-f0-9]{64}$/);
    const { hashedRecallRef, canonicalKnowledgeSourceAnchor } = await import('../src/core/native-recall-attribution');
    const canonicalNode = canonicalKnowledgeSourceAnchor(NODE_ANCHOR);
    assert.equal(nodeBodyJson.source.ref, hashedRecallRef('source', [canonicalNode, nodeContent.content_hash]));
    assert.deepEqual(nodeBodyJson.recall_attribution.sources[0], {
      ref: nodeBodyJson.source.ref, anchor: canonicalNode,
      ref_content_hash: `sha256:${'e'.repeat(64)}`,
      disclosure: 'text', coverage: 'complete', role: 'learning', truncated: false, redacted: false,
      disclosed_text_hash: nodeBodyJson.recall_attribution.sources[0].disclosed_text_hash,
    });
    assert.ok(/^[a-f0-9]{64}$/.test(nodeBodyJson.recall_attribution.sources[0].disclosed_text_hash));
    // Program read: metadata only, per-node compressed mappings preserved exactly.
    const program = await tool.execute({ action: 'read_source', anchor: PROGRAM_ANCHOR }, toolContext());
    if (!program.ok) assert.fail();
    const programJson = JSON.parse(String(program.content));
    assert.equal(programJson.source.status, 'read');
    assert.equal(programJson.source.text, '');
    assert.deepEqual(programJson.source.node_sources, [{ anchor: canonicalKnowledgeSourceAnchor(NODE_ANCHOR), source_anchors: [TURN_ANCHOR] }]);
    // Pinned structural program metadata stays citable as metadata; no body is claimed.
    const programSources = programJson.recall_attribution.sources;
    assert.equal(programSources.length, 1);
    assert.equal(programSources[0].disclosure, 'metadata');
    assert.equal(programSources[0].coverage, 'structural_only');
    assert.equal(programSources[0].anchor.skill_version_id, VERSION);
    // Absent historical mappings stay an explicit truthful gap.
    const absent = await tool.execute({ action: 'read_source', anchor: NODE_ANCHOR }, toolContext());
    void absent;
    const unsupported = content({ anchor: { ...NODE_ANCHOR }, text: '', content_hash: undefined,
      coverage: 'structural_only', status: 'unsupported' as any, reason: 'node_source_mapping_not_captured' });
    const gapTool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async () => page(unsupported) });
    const gap = await gapTool.execute({ action: 'read_source', anchor: NODE_ANCHOR }, toolContext());
    if (!gap.ok) assert.fail();
    const gapJson = JSON.parse(String(gap.content));
    assert.equal(gapJson.source.status, 'unsupported');
    assert.equal(gapJson.source.reason, 'node_source_mapping_not_captured');
    assert.equal(gapJson.source.ref, undefined);
    assert.deepEqual(gapJson.recall_attribution.sources, []);
  });

  test('skill source envelopes pass the feedback outbox whole-event gate with skill_version_id intact', async () => {
    const { feedbackEvent } = await import('../src/core/native-recall-feedback-outbox');
    const { hashedRecallRef, canonicalKnowledgeSourceAnchor } = await import('../src/core/native-recall-attribution');
    const canonicalNode = canonicalKnowledgeSourceAnchor(NODE_ANCHOR);
    const ref = hashedRecallRef('source', [canonicalNode, `sha256:${'e'.repeat(64)}`]);
    const event = feedbackEvent({
      event_id: 'evt-skill', trace_id: 'recall-skill', kind: 'branch_source', outcome: 'completed',
      occurred_at_ms: 1, observed: [{ ref, anchor: canonicalNode, ref_content_hash: `sha256:${'e'.repeat(64)}`,
        disclosure: 'text', coverage: 'complete', role: 'learning' }], delivered: [{ ref, disclosure: 'text' }],
      cited: [], retained: [], citation_semantics: 'explicit_ref_match_not_causal_use',
      delivery_semantics: 'branch_summary_with_refs_not_source_body',
      retained_semantics: 'final_explicit_ref_match_not_semantic_adoption', lifecycle: 'turn_local_no_carryover',
    });
    assert.ok(event, 'skill_version_id must survive canonicalKnowledgeSourceAnchor passthrough');
    assert.equal(event!.observed[0].anchor.skill_version_id, VERSION);
    assert.equal(event!.observed[0].anchor.kind, 'skill_node');
  });

  test('status gaps and unsupported rich result/graph have no invented source ref or text', async () => {
    for (const status of ['missing', 'revoked', 'stale', 'unsupported'] as const) {
      const gap = content({ status, text: '', content_hash: undefined, coverage: 'structural_only' });
      const tool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async () => page(gap) });
      const result = await tool.execute({ action: 'source', anchor: RAW }, toolContext());
      assert.ok(result.ok);
      if (!result.ok) assert.fail();
      const body = JSON.parse(String(result.content));
      assert.equal(body.source.status, status);
      assert.equal(body.source.ref, undefined);
      assert.deepEqual(body.recall_attribution.sources, []);
    }
    const client = new CatscoLogAgentClient('https://logs.example.test');
    await client.readKnowledgeSource({ anchor: { kind: 'graph_node', id: 'gn-1', session_id: 's-1' }, token: 'read' });
    await client.readKnowledgeSource({ anchor: { ...RAW, kind: 'session_result', byte_length: 42 }, token: 'read' });
    assert.equal(requests.length, 2, 'unsupported is an explicit server status, never alias to raw');
  });

  test('learning structural metadata and knowledge pinned source stay distinct', async () => {
    const learning = content({ anchor: { kind: 'learning_node', id: 'ln-1', session_id: 'learning-1', revision: HASH },
      role: 'learning', speaker: 'structure', text: '', content_hash: undefined, coverage: 'structural_only', node_kind: 'action',
      source_anchors: [RAW], selected_anchors: [{ ...RAW, byte_offset: 456 }] });
    const knowledge = content({ anchor: { kind: 'knowledge_entry', id: ENTRY, document_id: DOC, revision: REV },
      role: 'knowledge', speaker: 'knowledge', occurred_at: null });
    const tool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async () => ({ ...page(knowledge), before: [learning] }) });
    const result = await tool.execute({ action: 'source', anchor: knowledge.anchor }, toolContext());
    if (!result.ok) assert.fail();
    const body = JSON.parse(String(result.content));
    assert.equal(body.source.ref, `catslog:knowledge:${DOC}:${REV}:${ENTRY}`);
    assert.equal(body.source.occurred_at, null);
    assert.equal(body.before[0].node_kind, 'action');
    assert.equal(body.before[0].text, '');
    assert.deepEqual(body.before[0].source_anchors, [RAW]);
    assert.deepEqual(body.before[0].selected_anchors, [{ ...RAW, byte_offset: 456 }]);
    assert.deepEqual(body.recall_attribution.sources.map((source: any) => source.disclosure), ['text', 'metadata']);
  });

  test('resolved expand endpoints are citable metadata, without claiming source body was read', async () => {
    const anchor = { kind: 'knowledge_entry' as const, id: ENTRY, document_id: DOC, revision: REV };
    const edge: any = { remote: anchor, remote_status: 'resolved', link: { id: 'link-1', kind: 'related', source: anchor, target: anchor } };
    const tool = new CatsLogKnowledgeRecallTool({ expandKnowledge: async () => ({ edges: [edge], exhausted: true }) });
    const result = await tool.execute({ action: 'expand', anchor }, toolContext());
    if (!result.ok) assert.fail();
    const body = JSON.parse(String(result.content));
    assert.equal(body.edges[0].remote_ref, `catslog:knowledge:${DOC}:${REV}:${ENTRY}`);
    assert.equal(body.recall_attribution.sources[0].disclosure, 'metadata');
    assert.equal(body.recall_attribution.sources[0].coverage, 'structural_only');
  });

  test('malformed pin and negative byte offset stay invalid on native seam; unavailable never returns empty success', async () => {
    let reads = 0;
    const tool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async () => { reads++; return page(); } });
    for (const anchor of [{ ...RAW, revision: 12 }, { ...RAW, byte_offset: -1 }]) {
      const result = await tool.execute({ action: 'source', anchor }, toolContext());
      assert.equal(result.ok, false);
      if (result.ok) assert.fail();
      assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
    }
    assert.equal(reads, 0);
    const result = await new CatsLogKnowledgeRecallTool({}).execute({ action: 'source', anchor: RAW }, toolContext());
    assert.equal(result.ok, false);
    if (result.ok) assert.fail();
    assert.equal(result.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');
  });
});

describe('source provider capability lifecycle', () => {
  const previousFetch = globalThis.fetch;
  let root: string;
  let env: NodeJS.ProcessEnv;
  const state = { schemaVersion: 1, deviceId: 'device-test', skillToken: 'synthetic-old-read', uploaded: {},
    skillTokenExpiresAt: new Date(Date.now() + 3600000).toISOString() };
  const save = (value: any) => { fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/catsco-log-agent-state.json'), JSON.stringify(value)); };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-provider-'));
    env = { XIAOBA_USER_DATA_DIR: root, DOTENV_CONFIG_PATH: path.join(root, 'missing.env'), CATSCO_LOG_API_BASE_URL: 'https://logs.example.test' };
    save(state);
  });
  afterEach(() => { globalThis.fetch = previousFetch; fs.rmSync(root, { recursive: true, force: true }); });

  test('kill switch and restricted role block all network; branch disable does not block explicit source read', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(page()); }) as any;
    for (const gates of [{ CATSLOG_KNOWLEDGE_RECALL_ENABLED: '0' }, { XIAOBA_ROLE: 'inspector-cat' }]) {
      await assert.rejects(new CatsLogMemoryProvider(root, { env: { ...env, ...gates } }).readKnowledgeSource({ anchor: RAW }), /disabled/);
    }
    assert.equal(calls, 0);
    await new CatsLogMemoryProvider(root, { env: { ...env, CATSLOG_MEMORY_ENABLED: '0' } }).readKnowledgeSource({ anchor: RAW });
    assert.equal(calls, 1);
  });

  test('safe source URL survives restart and unsafe URL stays same-origin default', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => { urls.push(String(url)); return Response.json(page()); }) as any;
    save({ ...state, knowledgeSourceReadUrl: '/custom/source/read' });
    await new CatsLogMemoryProvider(root, { env }).readKnowledgeSource({ anchor: RAW });
    await new CatsLogMemoryProvider(root, { env }).readKnowledgeSource({ anchor: RAW });
    save({ ...state, knowledgeSourceReadUrl: 'https://foreign.example/source' });
    await new CatsLogMemoryProvider(root, { env }).readKnowledgeSource({ anchor: RAW });
    assert.deepEqual(urls, ['https://logs.example.test/custom/source/read', 'https://logs.example.test/custom/source/read',
      'https://logs.example.test/catsco/agent/knowledge/source/read']);
  });

  test('401 invalidates source capability, bootstraps once, then persists canonical source URL', async () => {
    env.CATSCO_USER_TOKEN = 'synthetic-user-token';
    const calls: string[] = [];
    globalThis.fetch = (async (url: any, init: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/bootstrap')) return Response.json({ user_id: 'u', device_id: 'device-test', token: 'synthetic-upload',
        skill_token: 'synthetic-fresh-read', skill_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
        knowledge_source_read_url: '/new/source/read', upload_url: '/catsco/logs/upload' });
      if ((init.headers as any).Authorization === 'Bearer synthetic-old-read') return Response.json({ error: 'unauthorized' }, { status: 401 });
      assert.equal((init.headers as any).Authorization, 'Bearer synthetic-fresh-read');
      return Response.json(page());
    }) as any;
    await new CatsLogMemoryProvider(root, { env }).readKnowledgeSource({ anchor: RAW });
    assert.equal(calls.filter(url => url.endsWith('/bootstrap')).length, 1);
    assert.ok(calls.at(-1)?.endsWith('/new/source/read'));
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'data/catsco-log-agent-state.json'), 'utf8'));
    assert.equal(persisted.knowledgeSourceReadUrl, '/new/source/read');
  });
});

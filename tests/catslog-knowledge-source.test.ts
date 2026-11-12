import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { collectExecutionMemoryInputs } from '../src/core/execution-memory-bindings';
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

describe('source v1 wire', () => {
  const previousFetch = globalThis.fetch;
  let requests: Array<{ url: string; init: RequestInit }>;
  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (url: any, init: RequestInit) => {
      requests.push({ url: String(url), init });
      const request = JSON.parse(String(init.body));
      const responsePage = request.anchor?.kind === 'source_memory_projection_node'
        ? page(content({ anchor: request.anchor, status: 'unsupported', text: '', coverage: 'structural_only' })) : page();
      return Response.json(responsePage);
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

  test('source route accepts and round-trips output projection node IDs exactly', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const anchor = { kind: 'source_memory_projection_node' as const, id: `output-${'a'.repeat(64)}`, revision: HASH,
      source_projection_ref: 'ref_' + 'b'.repeat(64) };
    await client.readKnowledgeSource({ anchor, max_bytes: 256, token: 'read' });
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { anchor, max_bytes: 256 });
    assert.equal(requests.length, 1);
  });

  test('source route canonicalizes prefixed projection revision pins before transport', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const anchor = { kind: 'source_memory_projection_node' as const, id: `output-${'a'.repeat(64)}`,
      revision: `sha256:${HASH}`, source_projection_ref: 'ref_' + 'b'.repeat(64) };
    const result = await client.readKnowledgeSource({ anchor, max_bytes: 256, token: 'read' });
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { anchor: { ...anchor, revision: HASH }, max_bytes: 256 });
    assert.equal(result.source.anchor.revision, HASH);
    assert.equal(anchor.revision, `sha256:${HASH}`, 'normalization does not mutate the caller pin');
    assert.equal(requests.length, 1);
  });

  test('source route continues to round-trip legacy bare projection node IDs', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const anchor = { kind: 'source_memory_projection_node' as const, id: 'a'.repeat(64), revision: HASH,
      source_projection_ref: 'ref_' + 'b'.repeat(64) };
    await client.readKnowledgeSource({ anchor, max_bytes: 256, token: 'read' });
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), { anchor, max_bytes: 256 });
    assert.equal(requests.length, 1);
  });
  test('source route rejects malformed output node IDs without weakening other pins', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const anchor = { kind: 'source_memory_projection_node' as const, id: `output-${'a'.repeat(64)}`, revision: HASH,
      source_projection_ref: 'ref_' + 'b'.repeat(64) };
    for (const id of [`output-${'a'.repeat(63)}`, `output-${'A'.repeat(64)}`, `output-${'a'.repeat(64)}-suffix`, 'output-not-hex', 'A'.repeat(64)]) {
      await assert.rejects(client.readKnowledgeSource({ anchor: { ...anchor, id }, token: 'read' }));
    }
    await assert.rejects(client.readKnowledgeSource({ anchor: { ...anchor, revision: `output-${HASH}` }, token: 'read' }));
    await assert.rejects(client.readKnowledgeSource({ anchor: { ...anchor, source_projection_ref: 'smp_' + 'b'.repeat(64) }, token: 'read' }));
    assert.equal(requests.length, 0);
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

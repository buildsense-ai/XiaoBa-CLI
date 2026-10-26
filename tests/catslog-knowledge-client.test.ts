import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';

// knowledge/1: real server identity widths, including the akr- prefix.
const DOC = 'akd-' + 'a'.repeat(24);
const ENTRY = 'ake-' + 'b'.repeat(24);
const REV = 'akr-' + 'c'.repeat(64);
const PREVIOUS = 'akr-' + 'd'.repeat(64);
const REMOTE = { kind: 'knowledge_entry' as const, id: 'ake-' + 'e'.repeat(24), document_id: 'akd-' + 'f'.repeat(24), revision: PREVIOUS };
const ANCHOR = { kind: 'knowledge_entry' as const, id: ENTRY, document_id: DOC, revision: REV };
const TOKEN = 'synthetic-skill-token';

describe('CatscoLogAgentClient knowledge routes', () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<{ url: string; init: RequestInit }>;
  let responder: (url: string, init: RequestInit) => { status: number; body: string; contentType?: string };
  const searchPage = {
    hits: [{ document_id: DOC, day: '2026-10-07', entry_id: ENTRY, title: 'Sparse attention windowing', status: 'active', revision: REV,
      follow_on: { has_later: true, expand_cursor: 'eyJvZmZzZXQiOjF9' } }],
    next_cursor: 'cursor-Ω-01', exhausted: false,
  };

  beforeEach(() => {
    calls = [];
    responder = () => ({ status: 200, body: '{}' });
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      const response = responder(String(url), init);
      return new Response(response.body, { status: response.status,
        headers: { 'content-type': response.contentType ?? 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });
  const client = () => new CatscoLogAgentClient('https://logs.example.test');
  const wire = () => JSON.parse(String(calls.at(-1)!.init.body));

  test('search posts the trimmed query and returns the real identity page verbatim', async () => {
    responder = () => ({ status: 200, body: JSON.stringify(searchPage) });
    const page = await client().searchKnowledge({ query: '  sparse attention  ', limit: 20, cursor: 'cursor-Ω-01',
      date_from: '2026-10-01', date_to: '2026-10-07', statuses: ['active', 'draft'], include_draft: true, token: TOKEN });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://logs.example.test/catsco/agent/knowledge/search');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(wire(), { query: 'sparse attention', limit: 20, cursor: 'cursor-Ω-01', date_from: '2026-10-01',
      date_to: '2026-10-07', statuses: ['active', 'draft'], include_draft: true });
    assert.deepEqual(page, searchPage);
  });

  test('search → revision-pinned read → expand dispatches the complete 68-byte revision unchanged', async () => {
    const readPage = { document_id: DOC, revision: REV, previous_revision: PREVIOUS, day: '2026-10-07',
      generated_at: '2026-10-07T22:14:09Z', generated_by: 'knowledge-daily-worker',
      entries: [{ id: ENTRY, title: 'Sparse attention windowing', text: 'full entry text', status: 'active' }], exhausted: true };
    responder = url => ({ status: 200, body: JSON.stringify(url.endsWith('/search') ? searchPage
      : url.endsWith('/read') ? readPage : { edges: [{ remote: REMOTE, remote_status: 'resolved' }], exhausted: true }) });
    const transport = client();
    const hit = (await transport.searchKnowledge({ query: 'sparse attention', token: TOKEN })).hits[0];
    const result = await transport.readKnowledge({ document_id: hit.document_id, revision: hit.revision, entry_id: hit.entry_id, limit: 1, token: TOKEN });
    assert.equal(result.format, 'json');
    if (result.format !== 'json') assert.fail('expected JSON');
    assert.deepEqual(result.page, readPage);
    assert.equal(wire().revision, REV);
    const page = await transport.expandKnowledge({ anchor: { kind: 'knowledge_entry', id: hit.entry_id, document_id: hit.document_id, revision: hit.revision },
      direction: 'in', kinds: ['corrects'], limit: 20, token: TOKEN });
    assert.equal(page.edges[0].remote_status, 'resolved');
    assert.deepEqual(wire().anchor, ANCHOR);
    assert.equal(Buffer.byteLength(REV), 68);
    assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['search', 'read', 'expand']);
  });

  test('read okf returns raw markdown without clipping', async () => {
    const okf = `# 2026-10-07\n\n## <a id="${ENTRY}"></a> Entry\n\nText with <yaml>& specials\n`;
    responder = () => ({ status: 200, body: okf, contentType: 'text/markdown; charset=utf-8' });
    const result = await client().readKnowledge({ document_id: DOC, revision: REV, format: 'okf', token: TOKEN });
    assert.deepEqual(result, { format: 'okf', body: okf });
    assert.equal(wire().format, 'okf');
  });

  test('read okf rejects a JSON content type', async () => {
    responder = () => ({ status: 200, body: '{"entries":[]}', contentType: 'application/json' });
    await assert.rejects(() => client().readKnowledge({ document_id: DOC, format: 'okf', token: TOKEN }), /unexpected OKF content type/);
  });

  test('include_draft explicit false reaches the wire', async () => {
    responder = () => ({ status: 200, body: JSON.stringify({ hits: [], exhausted: true }) });
    await client().searchKnowledge({ query: 'x', include_draft: false, token: TOKEN });
    assert.equal(wire().include_draft, false);
  });

  test('expand preserves typed identity domains and rejects foreign coordinates', async () => {
    responder = () => ({ status: 200, body: JSON.stringify({ edges: [{ link: { id: 'akl-' + 'd'.repeat(64), kind: 'supplements', source: REMOTE, target: ANCHOR }, remote: REMOTE, remote_status: 'resolved' }], exhausted: true }) });
    const transport = client();
    await transport.expandKnowledge({ anchor: ANCHOR, direction: 'both', kinds: ['supplements', 'corrects'], limit: 100, token: TOKEN });
    assert.deepEqual(wire().anchor, ANCHOR);
    assert.deepEqual(wire().kinds, ['supplements', 'corrects']);
    await assert.rejects(() => transport.expandKnowledge({ anchor: { kind: 'knowledge_entry', id: ENTRY }, token: TOKEN }), /document_id is required/);
    await assert.rejects(() => transport.expandKnowledge({ anchor: { kind: 'graph_node', id: 'gn-1', session_id: 's-1', stream_id: 'st-1', byte_offset: 4 }, token: TOKEN }), /stream coordinates/);
    await assert.rejects(() => transport.expandKnowledge({ anchor: { kind: 'graph_node', id: 'stream/file.jsonl#12' }, token: TOKEN }), /anchor.id is invalid/);
    await assert.rejects(() => transport.expandKnowledge({ anchor: { kind: 'bogus' as any, id: 'x' }, token: TOKEN }), /anchor.kind is invalid/);
    assert.equal(calls.length, 1);
  });

  test('revision generic domain accepts Go limit 128 and rejects 129 before HTTP in both routes', async () => {
    const transport = client();
    await transport.readKnowledge({ document_id: DOC, revision: 'r'.repeat(128), token: TOKEN });
    await transport.expandKnowledge({ anchor: { kind: 'graph_node', id: 'gn-1', session_id: 's-1', revision: 'r'.repeat(128) }, token: TOKEN });
    assert.equal(calls.length, 2);
    await assert.rejects(() => transport.readKnowledge({ document_id: DOC, revision: 'r'.repeat(129), token: TOKEN }), /revision is invalid/);
    await assert.rejects(() => transport.expandKnowledge({ anchor: { kind: 'graph_node', id: 'gn-1', session_id: 's-1', revision: 'r'.repeat(129) }, token: TOKEN }), /revision is invalid/);
    assert.equal(calls.length, 2);
  });

  test('structured validation errors fire before HTTP', async () => {
    const transport = client();
    await assert.rejects(() => transport.searchKnowledge({ query: '   ', token: TOKEN }), /query is required/);
    await assert.rejects(() => transport.searchKnowledge({ query: 'x'.repeat(4097), token: TOKEN }), /at most 4096 bytes/);
    await assert.rejects(() => transport.searchKnowledge({ query: 'x', limit: 51, token: TOKEN }), /between 1 and 50/);
    await assert.rejects(() => transport.readKnowledge({ document_id: 'kd x!', token: TOKEN }), /document_id is invalid/);
    await assert.rejects(() => transport.searchKnowledge({ query: 'x', cursor: 'a\u0000b', token: TOKEN }), /cursor is invalid/);
    await assert.rejects(() => transport.searchKnowledge({ query: 'x', date_from: '2026-13-01', token: TOKEN }), /YYYY-MM-DD/);
    await assert.rejects(() => transport.searchKnowledge({ query: 'x' }), /capability token is missing/);
    assert.equal(calls.length, 0);
  });

  test('server errors keep status/detail and omit token', async () => {
    responder = () => ({ status: 404, body: JSON.stringify({ error: 'not_found' }) });
    await assert.rejects(() => client().searchKnowledge({ query: 'x', token: TOKEN }), (error: any) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /not_found/);
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!calls[0].url.includes(TOKEN));
      return true;
    });
  });

  test('abort signal is forwarded to fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async (_url: any, init: any) => {
      if (init.signal.aborted) throw new DOMException('This operation was aborted', 'AbortError');
      return new Response(JSON.stringify(searchPage));
    }) as typeof fetch;
    await assert.rejects(() => client().searchKnowledge({ query: 'x', token: TOKEN, signal: controller.signal }), /abort/i);
  });
});

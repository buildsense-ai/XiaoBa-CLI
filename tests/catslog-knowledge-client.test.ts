import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';

/**
 * Focused transport tests for the CatsLog daily-knowledge routes
 * (POST /catsco/agent/knowledge/search|read|expand), contract knowledge/1.
 * fetch is stubbed; every assertion pins the exact wire shape so a DTO fork
 * or a scope-selector leak fails loudly.
 */

type FetchLog = {
  url: string;
  init: RequestInit | undefined;
};

describe('CatscoLogAgentClient knowledge routes', () => {
  const originalFetch = globalThis.fetch;
  let calls: FetchLog[];
  let responder: (url: string, init: RequestInit | undefined) => { status: number; body: string; contentType?: string };

  beforeEach(() => {
    calls = [];
    responder = () => ({ status: 200, body: '{}' });
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      const response = responder(String(url), init);
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': response.contentType ?? 'application/json' },
      });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const searchPage = {
    hits: [
      {
        document_id: 'akd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        day: '2026-10-07',
        entry_id: 'ake-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
        title: 'Sparse attention windowing',
        status: 'active',
        revision: 'akr-cccccccccccccccccccccccccccccc1',
        follow_on: { has_later: true, expand_cursor: 'eyJvZmZzZXQiOjF9' },
      },
    ],
    next_cursor: 'cursor-Ω-01',
    exhausted: false,
  };

  test('search posts the trimmed query and returns the page verbatim', async () => {
    responder = () => ({ status: 200, body: JSON.stringify(searchPage) });
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const page = await client.searchKnowledge({
      query: '  sparse attention  ',
      limit: 20,
      cursor: 'cursor-Ω-01',
      date_from: '2026-10-01',
      date_to: '2026-10-07',
      statuses: ['active', 'draft'],
      include_draft: true,
      token: 'skill-token-1',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://logs.example.test/catsco/agent/knowledge/search');
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer skill-token-1');
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.query, 'sparse attention');
    assert.equal(body.limit, 20);
    // Cursors pass through byte-exact, including non-ASCII.
    assert.equal(body.cursor, 'cursor-Ω-01');
    assert.deepEqual(body.statuses, ['active', 'draft']);
    // Daily-corpus default: drafts included (fresh daily knowledge is draft;
    // the store would otherwise exclude it), status stays visible client-side.
    assert.equal(body.include_draft, true);
    // No scope selectors may ever appear on the wire.
    assert.ok(!('scope' in body) && !('principal_id' in body) && !('agent_id' in body));
    assert.equal(page.hits.length, 1);
    assert.equal(page.hits[0].entry_id, 'ake-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1');
    assert.equal(page.next_cursor, 'cursor-Ω-01');
    assert.equal(page.exhausted, false);
  });

  test('read json returns the ReadPage wrapped with format=json', async () => {
    const readPage = {
      document_id: 'akd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      revision: 'akr-cccccccccccccccccccccccccccccc2',
      previous_revision: 'akr-cccccccccccccccccccccccccccccc1',
      day: '2026-10-07',
      generated_at: '2026-10-07T22:14:09Z',
      generated_by: 'knowledge-daily-worker',
      entries: [{
        id: 'ake-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
        title: 'Sparse attention windowing',
        text: 'full entry text',
        status: 'active',
        source_anchors: [{
          kind: 'session_query', id: 'sq-1', session_id: 's-123', stream_id: 'st-9', byte_offset: 4096,
        }],
      }],
      next_cursor: '',
      exhausted: true,
    };
    responder = () => ({ status: 200, body: JSON.stringify(readPage) });
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const result = await client.readKnowledge({
      document_id: 'akd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      revision: 'akr-cccccccccccccccccccccccccccccc1',
      entry_id: 'ake-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
      limit: 50,
      token: 'skill-token-1',
    });
    assert.equal(result.format, 'json');
    assert.equal(result.format === 'json' && result.page.revision, 'akr-cccccccccccccccccccccccccccccc2');
    assert.equal(result.format === 'json' && result.page.entries[0].text, 'full entry text');
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.document_id, 'akd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
    assert.equal(body.revision, 'akr-cccccccccccccccccccccccccccccc1');
    assert.ok(!('format' in body));
  });

  test('read okf returns the raw markdown body without clipping', async () => {
    const okf = '# 2026-10-07\n\n## <a id="ake-1"></a> Entry\n\nText with <yaml>& specials\n';
    responder = () => ({
      status: 200,
      body: okf,
      contentType: 'text/markdown; charset=utf-8',
    });
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const result = await client.readKnowledge({
      document_id: 'akd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      format: 'okf',
      token: 'skill-token-1',
    });
    assert.equal(result.format, 'okf');
    assert.equal(result.format === 'okf' && result.body, okf);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.format, 'okf');
  });

  test('read okf rejects a JSON content type instead of parsing a clipped page', async () => {
    responder = () => ({ status: 200, body: '{"entries":[]}', contentType: 'application/json' });
    const client = new CatscoLogAgentClient('https://logs.example.test');
    await assert.rejects(
      () => client.readKnowledge({ document_id: 'akd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', format: 'okf', token: 't' }),
      /unexpected OKF content type/,
    );
  });

  test('include_draft is a real opt-out: explicit false is honored', async () => {
    responder = () => ({ status: 200, body: JSON.stringify({ hits: [], exhausted: true }) });
    const client = new CatscoLogAgentClient('https://logs.example.test');
    await client.searchKnowledge({ query: 'x', include_draft: false, token: 't' });
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.include_draft, false);
  });

  test('expand validates the typed anchor identity domains', async () => {
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        edges: [{
          link: {
            id: 'akl-dddddddddddddddddddddddddddddd1',
            kind: 'supplements',
            source: { kind: 'knowledge_entry', id: 'ake-2', document_id: 'akd-other', revision: 'akr-2' },
            target: { kind: 'knowledge_entry', id: 'ake-1', document_id: 'akd-1', revision: 'akr-1' },
          },
          remote: { kind: 'knowledge_entry', id: 'ake-2', document_id: 'akd-other', revision: 'akr-2' },
          remote_status: 'resolved',
        }],
        exhausted: true,
      }),
    });
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const page = await client.expandKnowledge({
      anchor: { kind: 'knowledge_entry', id: 'ake-1', document_id: 'akd-1', revision: 'akr-1' },
      direction: 'both',
      kinds: ['supplements', 'corrects'],
      limit: 100,
      token: 'skill-token-1',
    });
    assert.equal(page.edges[0].remote_status, 'resolved');
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.anchor.kind, 'knowledge_entry');
    assert.deepEqual(body.kinds, ['supplements', 'corrects']);

    // knowledge_entry anchors require document_id.
    await assert.rejects(
      () => client.expandKnowledge({ anchor: { kind: 'knowledge_entry', id: 'ake-1' }, token: 't' }),
      /document_id is required/,
    );
    // Non-session anchors must not carry stream coordinates.
    await assert.rejects(
      () => client.expandKnowledge({
        anchor: { kind: 'graph_node', id: 'gn-1', session_id: 's-1', stream_id: 'st-1', byte_offset: 4 },
        token: 't',
      }),
      /stream coordinates/,
    );
    // Branch-ref-style IDs are mechanically rejected by the charset rule.
    await assert.rejects(
      () => client.expandKnowledge({ anchor: { kind: 'graph_node', id: 'stream/file.jsonl#12' }, token: 't' }),
      /anchor.id is invalid/,
    );
    await assert.rejects(
      () => client.expandKnowledge({ anchor: { kind: 'bogus', id: 'x' }, token: 't' }),
      /anchor.kind is invalid/,
    );
  });

  test('structured validation errors fire before any HTTP call', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    await assert.rejects(() => client.searchKnowledge({ query: '   ', token: 't' }), /query is required/);
    await assert.rejects(
      () => client.searchKnowledge({ query: 'x'.repeat(4 * 1024 + 1), token: 't' }),
      /at most 4096 bytes/,
    );
    await assert.rejects(() => client.searchKnowledge({ query: 'x', limit: 51, token: 't' }), /between 1 and 50/);
    await assert.rejects(() => client.readKnowledge({ document_id: 'kd x!', token: 't' }), /document_id is invalid/);
    await assert.rejects(
      () => client.searchKnowledge({ query: 'x', cursor: 'a\u0000b', token: 't' }),
      /cursor is invalid/,
    );
    await assert.rejects(() => client.searchKnowledge({ query: 'x', date_from: '2026-13-01', token: 't' }), /YYYY-MM-DD/);
    await assert.rejects(() => client.searchKnowledge({ query: 'x' }), /capability token is missing/);
    assert.equal(calls.length, 0);
  });

  test('server errors keep status and detail, never the token', async () => {
    responder = () => ({ status: 404, body: JSON.stringify({ error: 'not_found' }) });
    const client = new CatscoLogAgentClient('https://logs.example.test');
    try {
      await client.searchKnowledge({ query: 'x', token: 'super-secret-skill-token' });
      assert.fail('expected rejection');
    } catch (error: any) {
      assert.equal(error.status, 404);
      assert.match(error.message, /not_found/);
      assert.ok(!error.message.includes('super-secret-skill-token'));
      assert.ok(!String(calls[0].url).includes('super-secret-skill-token'));
    }
  });

  test('abort signal is forwarded to fetch', async () => {
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async (_url: any, init: any) => {
      // Honor the signal the way undici does.
      if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
      return new Response(JSON.stringify(searchPage), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
    await assert.rejects(
      () => client.searchKnowledge({ query: 'x', token: 't', signal: controller.signal }),
      /abort/i,
    );
  });
});

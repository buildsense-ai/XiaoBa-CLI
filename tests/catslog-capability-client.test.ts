import { describe, test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CatscoLogAgentClient,
  isSafeCatsLogOpaqueIdentifier,
  isSafeCatsLogSkillHandle,
} from '../src/utils/catsco-log-agent-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('CatsLog capability client', () => {
  test('matches CatsLog opaque identifier semantics while rejecting path and secret shapes', () => {
    assert.equal(isSafeCatsLogSkillHandle('@private-skill'), true);
    assert.equal(isSafeCatsLogSkillHandle('-private-skill'), true);
    assert.equal(isSafeCatsLogOpaqueIdentifier('transition-42'), true);
    assert.equal(isSafeCatsLogSkillHandle('../private-skill'), false);
    assert.equal(isSafeCatsLogSkillHandle('https://evil.example'), false);
    assert.equal(isSafeCatsLogOpaqueIdentifier('ghp_secret-token', 512), false);
  });

  test('maps every Agent-facing endpoint to bounded requests and separate tokens', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('/skills?')) return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      if (url.endsWith('/skill-graph')) return new Response(JSON.stringify({ nodes: [], edges: [] }), { status: 200 });
      if (url.endsWith('/sessions')) return new Response(JSON.stringify({ records: [] }), { status: 200 });
      if (url.endsWith('/memory/retrieve')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith('/memory/recall')) return new Response(JSON.stringify({ session_available: true }), { status: 200 });
      if (url.endsWith('/memory/notes')) return new Response(JSON.stringify({ id: 'note-1' }), { status: 201 });
      if (url.includes('/outcomes')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const client = new CatscoLogAgentClient('https://logs.example.test');
    await client.readSkills({
      token: 'skill-token', search: 'release', includeContent: true, includeTrace: 'summary', limit: 3,
    });
    await client.readSkillGraph({ token: 'skill-token', handle: 'release#stable', depth: 1, includeEvidence: true });
    await client.querySessions({ token: 'skill-token', sessionId: 's-1', latest: true, sessionSummary: true, limit: 5 });
    await client.querySessions({ token: 'skill-token', searchAny: ['rollback', 'deploy', 'nginx'], latest: true, limit: 20 });
    await client.retrieveSkillMemory({ token: 'skill-token', memoryUrl: '/catsco/agent/memory/retrieve', task: 'release', routeId: 'r-1', hop: 1, edgeKey: 'e-1' });
    await client.recallMemory({ token: 'skill-token', memoryRecallUrl: '/catsco/agent/memory/recall', search: 'rollback', includeNotes: true });
    await client.reportSkillOutcome({
      token: 'skill-token', skillsUrl: '/catsco/agent/skills/', handle: 'release#stable', revision: 3,
      outcome: 'failed', retrievalReceipt: 'receipt-opaque', routeId: 'r-1', hop: 1, edgeKey: 'e-1',
      feedback: { code: 'outdated', summary: 'old', tags: ['release'] },
    });
    await client.createMemoryNote({
      memoryWriteToken: 'write-token', memoryNotesUrl: '/catsco/agent/memory/notes', kind: 'fact',
      content: 'owner', includeContent: false, sourceRefs: ['stream#1'], requestId: 'req-1',
    });

    assert.equal(requests.length, 8);
    assert.match(requests[0].url, /\/skills\?search=release&include_content=true&include_trace=summary&limit=3$/);
    assert.match(requests[1].url, /\/skill-graph\?handle=release%23stable&depth=1&include_evidence=true$/);
    assert.equal(requests[2].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[2].init.body)), {
      session_id: 's-1', latest: true, session_summary: true, limit: 5,
    });
    assert.equal(requests[3].init.method, 'POST');
    assert.equal(requests[4].init.method, 'POST');
    assert.equal(requests[5].init.method, 'POST');
    assert.match(requests[6].url, /\/skills\/release%23stable\/outcomes$/);
    assert.equal((requests[6].init.headers as Record<string, string>).Authorization, 'Bearer skill-token');
    assert.equal((requests[7].init.headers as Record<string, string>).Authorization, 'Bearer write-token');
    assert.deepEqual(JSON.parse(String(requests[6].init.body)), {
      revision: 3,
      outcome: 'failed',
      retrieval_receipt: 'receipt-opaque',
      route_id: 'r-1',
      hop: 1,
      edge_key: 'e-1',
      feedback: { code: 'outdated', summary: 'old', tags: ['release'] },
    });
    assert.deepEqual(JSON.parse(String(requests[7].init.body)), {
      kind: 'fact', content: 'owner', source_refs: ['stream#1'], request_id: 'req-1', include_content: false,
    });
  });

  test('sends search_any OR keywords on the session query without any UID selector', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new CatscoLogAgentClient('https://logs.example.test');
    await client.querySessions({ token: 'skill-token', searchAny: ['rollback', 'nginx mount'], latest: true, limit: 20 });
    await client.querySessions({ token: 'skill-token', searchAny: ['  ', ''], search: 'solo term' });
    await client.querySessions({
      token: 'skill-token',
      searchAny: ['😀'.repeat(64)], // exactly 64 code points (128 UTF-16 units)
    });

    // OR keywords map to search_any verbatim (the client never silently
    // trims); blank-only entries collapse away; no UID selector may be sent.
    assert.deepEqual(bodies[0], { search_any: ['rollback', 'nginx mount'], latest: true, limit: 20 });
    assert.deepEqual(bodies[1], { search: 'solo term' });
    assert.deepEqual(bodies[2], { search_any: ['😀'.repeat(64)] });
    for (const body of bodies) {
      assert.equal('uid' in body, false);
      assert.equal('uids' in body, false);
    }
    await assert.rejects(
      client.querySessions({ token: 'skill-token', searchAny: 'rollback' as any }),
      /searchAny must be an array/,
    );
    // The wire contract is enforced client-side as a structured error —
    // never a silent trim and never a raw server 400.
    await assert.rejects(
      client.querySessions({ token: 'skill-token', searchAny: ['k'.repeat(65)] }),
      /at most 64 Unicode code points \(got 65\)/,
    );
    await assert.rejects(
      client.querySessions({ token: 'skill-token', searchAny: ['😀'.repeat(65)] }),
      /at most 64 Unicode code points \(got 65\)/,
    );
    await assert.rejects(
      client.querySessions({ token: 'skill-token', searchAny: ['bad\u0001term'] }),
      /control characters/,
    );
    // C1 control code points (U+0080–U+009F) mirror Go unicode.IsControl —
    // especially U+0085 (NEL), which server whitespace handling would treat
    // as a line break inside a literal term. Rejected before any HTTP call.
    await assert.rejects(
      client.querySessions({ token: 'skill-token', searchAny: ['nel\u0085term'] }),
      /control characters \(C0, DEL, C1\)/,
    );
    await assert.rejects(
      client.querySessions({ token: 'skill-token', searchAny: ['csi\u009Cterm'] }),
      /control characters \(C0, DEL, C1\)/,
    );
    assert.equal(bodies.length, 3);
  });

  test('sends required branch sources using server wire names, including legacy aliases', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ status: 'ok', branches: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new CatscoLogAgentClient('https://logs.example.test');
    await client.branch({ token: 'skill-token', queryText: 'grp_4423 artifact-publish' });
    await client.branch({ token: 'skill-token', queryText: 'release', sources: ['memory', 'session', 'skill', 'memory'] });
    assert.deepEqual(bodies[0], {
      query_text: 'grp_4423 artifact-publish', sources: ['agent_memory', 'session_graph', 'skill'],
    });
    assert.deepEqual(bodies[1], {
      query_text: 'release', sources: ['agent_memory', 'session_graph', 'skill'],
    });
    await assert.rejects(
      client.branch({ token: 'skill-token', queryText: 'release', sources: ['unknown'] }),
      /sources must be/,
    );
    assert.equal(bodies.length, 2);
  });

  test('turns a conditional 304 into an explicit not_modified result', async () => {
    let seenHeader = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seenHeader = String((init.headers as Record<string, string>)?.['If-None-Match'] || '');
      return new Response(null, { status: 304, headers: { ETag: 'etag-2' } });
    }) as typeof fetch;
    const result = await new CatscoLogAgentClient('https://logs.example.test').readSkills({
      token: 'skill-token', ifNoneMatch: 'etag-1',
    });
    assert.equal(seenHeader, 'etag-1');
    assert.deepEqual(result, { not_modified: true, etag: 'etag-2' });
  });

  test('supports conditional POST reads and rejects successful non-JSON envelopes', async () => {
    const seen: Array<{ url: string; etag: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push({
        url: String(input),
        etag: String((init.headers as Record<string, string>)?.['If-None-Match'] || ''),
      });
      return new Response(null, { status: 304, headers: { ETag: 'etag-next' } });
    }) as typeof fetch;
    const client = new CatscoLogAgentClient('https://logs.example.test');
    const skillMemory = await client.retrieveSkillMemory({ token: 'skill-token', task: 'release', ifNoneMatch: 'etag-old' });
    const recall = await client.recallMemory({ token: 'skill-token', search: 'release', ifNoneMatch: 'etag-old' });
    assert.deepEqual(skillMemory, { not_modified: true, etag: 'etag-next' });
    assert.deepEqual(recall, { not_modified: true, etag: 'etag-next' });
    assert.deepEqual(seen.map(item => item.etag), ['etag-old', 'etag-old']);

    globalThis.fetch = (async () => new Response('not-json', { status: 200 })) as typeof fetch;
    await assert.rejects(
      client.readSkills({ token: 'skill-token' }),
      /invalid JSON response/,
    );
  });

  test('rejects unsafe outcome handles before making a request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await assert.rejects(
      new CatscoLogAgentClient('https://logs.example.test').reportSkillOutcome({
        token: 'skill-token', handle: '../escape', revision: 1, outcome: 'failed',
      }),
      /handle is invalid/,
    );
    assert.equal(called, false);
  });

  test('rejects malformed note metadata before making a request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ id: 'note-1' }), { status: 201 });
    }) as typeof fetch;
    await assert.rejects(
      new CatscoLogAgentClient('https://logs.example.test').createMemoryNote({
        token: 'write-token', kind: 'fact', content: 'owner', requestId: 42 as any,
      }),
      /request_id is invalid/,
    );
    await assert.rejects(
      new CatscoLogAgentClient('https://logs.example.test').createMemoryNote({
        token: 'write-token', kind: 'fact', content: 'owner', validFrom: '2026-08-28T00:00:00',
      }),
      /valid_from is invalid/,
    );
    assert.equal(called, false);
  });
});

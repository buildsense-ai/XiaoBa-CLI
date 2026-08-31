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

    assert.equal(requests.length, 7);
    assert.match(requests[0].url, /\/skills\?search=release&include_content=true&include_trace=summary&limit=3$/);
    assert.match(requests[1].url, /\/skill-graph\?handle=release%23stable&depth=1&include_evidence=true$/);
    assert.equal(requests[2].init.method, 'POST');
    assert.equal(requests[3].init.method, 'POST');
    assert.equal(requests[4].init.method, 'POST');
    assert.match(requests[5].url, /\/skills\/release%23stable\/outcomes$/);
    assert.equal((requests[5].init.headers as Record<string, string>).Authorization, 'Bearer skill-token');
    assert.equal((requests[6].init.headers as Record<string, string>).Authorization, 'Bearer write-token');
    assert.deepEqual(JSON.parse(String(requests[5].init.body)), {
      revision: 3,
      outcome: 'failed',
      retrieval_receipt: 'receipt-opaque',
      route_id: 'r-1',
      hop: 1,
      edge_key: 'e-1',
      feedback: { code: 'outdated', summary: 'old', tags: ['release'] },
    });
    assert.deepEqual(JSON.parse(String(requests[6].init.body)), {
      kind: 'fact', content: 'owner', source_refs: ['stream#1'], request_id: 'req-1', include_content: false,
    });
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

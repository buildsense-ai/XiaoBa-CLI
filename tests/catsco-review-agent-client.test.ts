import { describe, test, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { CatscoReviewAgentClient } from '../src/utils/catsco-review-agent-client';

const originalFetch = globalThis.fetch;

describe('catsco review agent client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends bearer token and query params to review API', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers || {};
      return new Response(JSON.stringify({
        page: { limit: 7, offset: 0, count: 0 },
        failures: [],
      }), { status: 200 });
    }) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token');
    await client.failures(7, '2026-05-20T00:00:00Z');

    const url = new URL(capturedUrl);
    assert.equal(url.origin, 'https://logs.example.test:8000');
    assert.equal(url.pathname, '/catsco/review/failures');
    assert.equal(url.searchParams.get('limit'), '7');
    assert.equal(url.searchParams.get('offset'), '0');
    assert.equal(url.searchParams.get('uploaded_from'), '2026-05-20T00:00:00Z');
    assert.equal(capturedHeaders.Authorization, 'Bearer review-token');
    assert.equal(capturedHeaders.Accept, 'application/json');
  });

  test('encodes session ids for entries and turns', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith('/entries')) {
        return new Response(JSON.stringify({ page: { limit: 10, offset: 0, count: 0 }, entries: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ page: { limit: 10, offset: 0, count: 0 }, turns: [] }), { status: 200 });
    }) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token');
    await client.entries('session/a b', 10);
    await client.turns('session/a b', 10);

    assert.equal(paths[0], '/catsco/review/sessions/session%2Fa%20b/entries');
    assert.equal(paths[1], '/catsco/review/sessions/session%2Fa%20b/turns');
  });

  test('surfaces API error detail without leaking token', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: 'not allowed' }), { status: 401 })) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'secret-review-token');
    await assert.rejects(
      () => client.summary(),
      (error: any) => {
        assert.match(error.message, /not allowed/);
        assert.equal(error.message.includes('secret-review-token'), false);
        return true;
      },
    );
  });

  test('retries transient failures and respects response size guard', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ detail: 'busy' }), {
          status: 503,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({
        upload_count: 0,
        parsed_upload_count: 0,
        failed_upload_count: 0,
        session_count: 0,
        turn_count: 0,
        ai_call_count: 0,
        tool_call_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }), { status: 200 });
    }) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token', {
      maxRetries: 1,
      maxResponseBytes: 1024,
    });
    await client.summary();
    assert.equal(attempts, 2);

    globalThis.fetch = (async () => new Response('x'.repeat(20), { status: 200 })) as any;
    const guardedClient = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token', {
      maxResponseBytes: 10,
    });
    await assert.rejects(() => guardedClient.summary(), /too large/);
  });
});

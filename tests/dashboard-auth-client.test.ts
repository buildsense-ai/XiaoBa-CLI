import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';

const dashboardHtml = readFileSync(join(process.cwd(), 'dashboard/index.html'), 'utf8');

function extractDashboardAuthClient(): string {
  const start = dashboardHtml.indexOf("const DASHBOARD_API_KEY_STORAGE_KEY = 'catsco.dashboardApiKey';");
  const end = dashboardHtml.indexOf('    function formatDashboardApiError', start);
  assert.ok(start >= 0, 'dashboard auth client start marker should exist');
  assert.ok(end > start, 'dashboard auth client end marker should exist');
  return dashboardHtml.slice(start, end);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function authFailure(): Response {
  return new Response(JSON.stringify({ code: 'dashboard_auth_required' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dashboard auth client', () => {
  test('a stale concurrent 401 does not clear a newly entered API key', async () => {
    const storage = new Map<string, string>();
    const initialResponses = [deferred<Response>(), deferred<Response>()];
    const requests: Array<{ url: string; apiKey: string }> = [];
    let initialRequestCount = 0;
    let promptCount = 0;

    const nativeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const apiKey = headers.get('X-API-Key') ?? '';
      requests.push({ url, apiKey });
      if (!apiKey && initialRequestCount < initialResponses.length) {
        return initialResponses[initialRequestCount++].promise;
      }
      return new Response(JSON.stringify({ ok: apiKey === 'correct-key' }), {
        status: apiKey === 'correct-key' ? 200 : 403,
        headers: { 'content-type': 'application/json' },
      });
    };

    const window = {
      location: new URL('http://127.0.0.1:3800/'),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      prompt: () => {
        promptCount += 1;
        return 'correct-key';
      },
      fetch: nativeFetch,
    };

    vm.runInNewContext(extractDashboardAuthClient(), {
      window,
      API: '',
      URL,
      Request,
      Response,
      Headers,
      Promise,
    });

    const first = window.fetch('/api/first');
    const stale = window.fetch('/api/stale');

    initialResponses[0].resolve(authFailure());
    assert.equal((await first).status, 200);
    assert.equal(storage.get('catsco.dashboardApiKey'), 'correct-key');

    initialResponses[1].resolve(authFailure());
    assert.equal((await stale).status, 200);

    assert.equal(promptCount, 1);
    assert.equal(storage.get('catsco.dashboardApiKey'), 'correct-key');
    assert.deepEqual(requests.map(request => request.apiKey), [
      '',
      '',
      'correct-key',
      'correct-key',
    ]);
  });
});

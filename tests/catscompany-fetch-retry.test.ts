import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { fetchWithRetry, isTransientFetchError } from '../src/catscompany/client';

describe('catscompany fetch retry', () => {
  const realFetch = global.fetch;
  let calls = 0;
  let behaviour: (() => Promise<Response>)[] = [];

  beforeEach(() => {
    calls = 0;
    behaviour = [];
    (global as any).fetch = async () => {
      const step = behaviour[calls] ?? behaviour[behaviour.length - 1];
      calls += 1;
      return step();
    };
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  function transportFailure(code = 'ECONNRESET'): Promise<Response> {
    const error = new TypeError('fetch failed');
    (error as any).cause = { code };
    return Promise.reject(error);
  }

  const ok = () => Promise.resolve(new Response('{}', { status: 200 }));

  test('treats a closed pooled socket as transient, an ordinary error as not', () => {
    const reset = new TypeError('fetch failed');
    (reset as any).cause = { code: 'ECONNRESET' };
    assert.equal(isTransientFetchError(reset), true);
    assert.equal(isTransientFetchError(new TypeError('fetch failed')), true);
    assert.equal(isTransientFetchError(new Error('CatsCompany agent context history failed: 500')), false);
    assert.equal(isTransientFetchError(new Error('session_fork_http_404')), false);
  });

  test('retries once when the transport failed before any response', async () => {
    behaviour = [() => transportFailure(), ok];
    const response = await fetchWithRetry('https://example.invalid/api/messages', {}, { baseDelayMs: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 2, 'the second attempt should have been made');
  });

  test('surfaces the failure when every attempt fails', async () => {
    behaviour = [() => transportFailure(), () => transportFailure()];
    await assert.rejects(
      fetchWithRetry('https://example.invalid/api/messages', {}, { baseDelayMs: 1 }),
      /fetch failed/,
    );
    assert.equal(calls, 2);
  });

  test('never retries a non-transient error', async () => {
    behaviour = [() => Promise.reject(new Error('CatsCompany agent context history failed: 401'))];
    await assert.rejects(
      fetchWithRetry('https://example.invalid/api/messages', {}, { baseDelayMs: 1 }),
      /history failed: 401/,
    );
    assert.equal(calls, 1);
  });

  test('never retries an aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    behaviour = [() => transportFailure()];
    await assert.rejects(
      fetchWithRetry('https://example.invalid/api/messages', { signal: controller.signal }, { baseDelayMs: 1 }),
    );
    assert.equal(calls, 1);
  });
});
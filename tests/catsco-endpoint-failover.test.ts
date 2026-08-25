import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FALLBACK_CATSCO_HTTP_BASE_URL,
  FALLBACK_CATSCO_WS_URL,
  PRIMARY_CATSCO_HTTP_BASE_URL,
  catsCoHttpBaseUrlCandidates,
  catsCoServerUrlCandidates,
  fallbackCatsCoHttpBaseUrl,
  fallbackCatsCoServerUrl,
  isCatsCoNetworkFailure,
} from '../src/catscompany/endpoint-failover';

test('keeps cc canonical and derives only the explicit cn fallback', () => {
  assert.equal(fallbackCatsCoHttpBaseUrl(PRIMARY_CATSCO_HTTP_BASE_URL), FALLBACK_CATSCO_HTTP_BASE_URL);
  assert.equal(fallbackCatsCoServerUrl('wss://app.catsco.cc/v0/channels'), FALLBACK_CATSCO_WS_URL);
  assert.deepEqual(catsCoHttpBaseUrlCandidates(PRIMARY_CATSCO_HTTP_BASE_URL), [
    PRIMARY_CATSCO_HTTP_BASE_URL,
    FALLBACK_CATSCO_HTTP_BASE_URL,
  ]);
  assert.deepEqual(catsCoServerUrlCandidates('wss://app.catsco.cc/v0/channels'), [
    'wss://app.catsco.cc/v0/channels',
    FALLBACK_CATSCO_WS_URL,
  ]);
});

test('does not derive a fallback for arbitrary endpoints', () => {
  assert.equal(fallbackCatsCoHttpBaseUrl('https://example.test'), undefined);
  assert.equal(fallbackCatsCoServerUrl('wss://example.test/v0/channels'), undefined);
  assert.deepEqual(catsCoHttpBaseUrlCandidates('https://example.test'), ['https://example.test']);
});

test('only network failures are eligible for failover', () => {
  assert.equal(isCatsCoNetworkFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })), true);
  assert.equal(isCatsCoNetworkFailure(Object.assign(new Error('bad credentials'), { status: 401 })), false);
});

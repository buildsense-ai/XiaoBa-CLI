import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCatsCoAppHttpOrigin,
  isCatsCoWebSocketEndpoint,
  isCatsRelayApiBase,
} from '../src/utils/catsco-domains';

test('accepts both CatsCo app domains while rejecting lookalikes', () => {
  assert.equal(isCatsCoAppHttpOrigin('https://app.catsco.cc'), true);
  assert.equal(isCatsCoAppHttpOrigin('https://app.catsco.cn/path'), true);
  assert.equal(isCatsCoAppHttpOrigin('https://evil-app.catsco.cn'), false);
  assert.equal(isCatsCoAppHttpOrigin('http://app.catsco.cn'), false);
});

test('accepts both production websocket endpoints with the canonical path', () => {
  assert.equal(isCatsCoWebSocketEndpoint('wss://app.catsco.cc/v0/channels'), true);
  assert.equal(isCatsCoWebSocketEndpoint('wss://app.catsco.cn/v0/channels/'), true);
  assert.equal(isCatsCoWebSocketEndpoint('wss://app.catsco.cn/v1/channels'), false);
  assert.equal(isCatsCoWebSocketEndpoint('wss://evil.catsco.cn/v0/channels'), false);
});

test('classifies both Relay domains independent of endpoint path', () => {
  assert.equal(isCatsRelayApiBase('https://relay.catsco.cc/v1'), true);
  assert.equal(isCatsRelayApiBase('https://relay.catsco.cn/anthropic/v1/messages'), true);
  assert.equal(isCatsRelayApiBase('https://relay.catsco.cn.evil.example/v1'), false);
  assert.equal(isCatsRelayApiBase('not-a-url/https://relay.catsco.cn/v1'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catsCoDomainFamily,
  catsCoEndpointCandidates,
  catsCoUrlForFamily,
  isCatsCoAppHttpOrigin,
  isCatsCoWebSocketEndpoint,
  isCatsRelayApiBase,
  siblingCatsCoUrl,
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
  assert.equal(isCatsCoWebSocketEndpoint('ws://app.catsco.cn/v0/channels'), false);
  assert.equal(isCatsCoWebSocketEndpoint('wss://app.catsco.cn/v1/channels'), false);
  assert.equal(isCatsCoWebSocketEndpoint('wss://evil.catsco.cn/v0/channels'), false);
});

test('classifies both Relay domains independent of endpoint path', () => {
  assert.equal(isCatsRelayApiBase('https://relay.catsco.cc/v1'), true);
  assert.equal(isCatsRelayApiBase('https://relay.catsco.cn/anthropic/v1/messages'), true);
  assert.equal(isCatsRelayApiBase('https://relay.catsco.cn.evil.example/v1'), false);
  assert.equal(isCatsRelayApiBase('not-a-url/https://relay.catsco.cn/v1'), false);
});

test('classifies the cc and cn domain families for supported hosts only', () => {
  assert.equal(catsCoDomainFamily('https://app.catsco.cc'), 'cc');
  assert.equal(catsCoDomainFamily('wss://app.catsco.cn/v0/channels'), 'cn');
  assert.equal(catsCoDomainFamily('https://relay.catsco.cn/v1'), 'cn');
  assert.equal(catsCoDomainFamily('https://APP.CatsCo.CC'), 'cc');
  assert.equal(catsCoDomainFamily('https://app.catsco.cc.evil.example'), undefined);
  assert.equal(catsCoDomainFamily('https://catsco.cc'), undefined);
  assert.equal(catsCoDomainFamily('https://evil-catsco.cn'), undefined);
  assert.equal(catsCoDomainFamily('not-a-url'), undefined);
  assert.equal(catsCoDomainFamily(''), undefined);
});

test('siblingCatsCoUrl swaps cc and cn siblings without touching other hosts', () => {
  assert.equal(siblingCatsCoUrl('https://app.catsco.cc'), 'https://app.catsco.cn');
  assert.equal(siblingCatsCoUrl('https://app.catsco.cc/'), 'https://app.catsco.cn');
  assert.equal(siblingCatsCoUrl('wss://app.catsco.cc/v0/channels'), 'wss://app.catsco.cn/v0/channels');
  assert.equal(siblingCatsCoUrl('https://relay.catsco.cn/v1'), 'https://relay.catsco.cc/v1');
  assert.equal(siblingCatsCoUrl('https://app.catsco.cc:8443/x?y=1'), 'https://app.catsco.cn:8443/x?y=1');
  assert.equal(siblingCatsCoUrl('https://example.com'), undefined);
  assert.equal(siblingCatsCoUrl('https://app.catsco.cn.evil.example'), undefined);
  assert.equal(siblingCatsCoUrl('not-a-url'), undefined);
  assert.equal(siblingCatsCoUrl(''), undefined);
});

test('catsCoUrlForFamily swaps only when the target family applies', () => {
  assert.equal(catsCoUrlForFamily('wss://app.catsco.cc/v0/channels', 'cn'), 'wss://app.catsco.cn/v0/channels');
  assert.equal(catsCoUrlForFamily('wss://app.catsco.cn/v0/channels', 'cc'), 'wss://app.catsco.cc/v0/channels');
  assert.equal(catsCoUrlForFamily('wss://app.catsco.cn/v0/channels', 'cn'), undefined);
  assert.equal(catsCoUrlForFamily('wss://app.catsco.cc/v0/channels', undefined), undefined);
  assert.equal(catsCoUrlForFamily('https://custom.example', 'cn'), undefined);
});

test('catsCoEndpointCandidates keeps the configured endpoint first and adds the sibling fallback', () => {
  assert.deepEqual(
    catsCoEndpointCandidates('wss://app.catsco.cc/v0/channels'),
    ['wss://app.catsco.cc/v0/channels', 'wss://app.catsco.cn/v0/channels'],
  );
  assert.deepEqual(
    catsCoEndpointCandidates('wss://app.catsco.cc/v0/channels', 'cc'),
    ['wss://app.catsco.cc/v0/channels', 'wss://app.catsco.cn/v0/channels'],
  );
  assert.deepEqual(
    catsCoEndpointCandidates('wss://app.catsco.cc/v0/channels', 'cn'),
    ['wss://app.catsco.cn/v0/channels', 'wss://app.catsco.cc/v0/channels'],
  );
  assert.deepEqual(
    catsCoEndpointCandidates('  wss://app.catsco.cn/v0/channels/  ', 'cn'),
    ['wss://app.catsco.cn/v0/channels', 'wss://app.catsco.cc/v0/channels'],
  );
  assert.deepEqual(
    catsCoEndpointCandidates('wss://custom.example/v0/channels', 'cn'),
    ['wss://custom.example/v0/channels'],
  );
  assert.deepEqual(catsCoEndpointCandidates('', 'cn'), []);
});

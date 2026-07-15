import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { provisionCatsRelayCatalogRuntime } from '../src/catscompany/relay-model-bootstrap';

describe('CatsCo default relay model bootstrap', () => {
  test('materializes MiniMax M3 and creates a relay key for a fresh device', async () => {
    const requests: Array<{ path: string; method?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, method: init?.method });
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          base_url: 'https://relay.example.test',
          self_service_enabled: true,
          endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.example.test/anthropic' }],
        });
      }
      if (url.pathname === '/api/relay/key' && init?.method === 'GET') {
        return Response.json({ configured: false });
      }
      if (url.pathname === '/api/relay/key' && init?.method === 'POST') {
        return Response.json({ key: { key: 'sk-fresh-device-relay-key' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    }) as typeof fetch;

    const runtime = await provisionCatsRelayCatalogRuntime({
      botId: 'bot-1',
      modelId: 'minimax-m3',
      auth: {
        token: 'user-token',
        uid: 'user-1',
        displayName: 'Alice',
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
      },
      fetchImpl,
    });

    assert.equal(runtime.modelId, 'minimax-m3');
    assert.equal(runtime.model, 'MiniMax-M3');
    assert.equal(runtime.provider, 'anthropic');
    assert.equal(runtime.apiBase, 'https://relay.example.test/anthropic');
    assert.equal(runtime.contextWindowTokens, 1_000_000);
    assert.equal(runtime.apiKey, 'sk-fresh-device-relay-key');
    assert.deepStrictEqual(requests, [
      { path: '/api/relay/config', method: 'GET' },
      { path: '/api/relay/key', method: 'GET' },
      { path: '/api/relay/key', method: 'POST' },
    ]);
  });
});

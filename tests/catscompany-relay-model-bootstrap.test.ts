import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  provisionCatsRelayCatalogRuntime,
  refreshCatsRelayCatalogRuntimeCapabilities,
} from '../src/catscompany/relay-model-bootstrap';

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
      if (url.pathname === '/v1/models') {
        return Response.json({
          object: 'list',
          data: [{
            id: 'MiniMax-M3',
            capabilities: {
              vision: true,
              tool_calling: true,
              streaming: true,
              input_modalities: ['text', 'image'],
            },
          }],
        });
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
    assert.deepStrictEqual(runtime.capabilities, { vision: true, toolCalling: true, streaming: true });
    assert.equal(runtime.capabilitiesSource, 'relay-models');
    assert.ok(runtime.capabilitiesCheckedAt);
    assert.deepStrictEqual(requests, [
      { path: '/api/relay/config', method: 'GET' },
      { path: '/api/relay/key', method: 'GET' },
      { path: '/api/relay/key', method: 'POST' },
      { path: '/api.json', method: undefined },
      { path: '/v1/models', method: 'GET' },
    ]);
  });

  test('replaces stale GPT vision=false runtime metadata from the relay catalog', async () => {
    const fetchImpl = (async () => Response.json({
      data: [{
        id: 'gpt-5.6-terra',
        capabilities: { vision: true, tool_calling: true, streaming: true },
      }],
    })) as typeof fetch;

    const runtime = await refreshCatsRelayCatalogRuntimeCapabilities({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: 'bot-1',
      modelId: 'gpt-5.6-terra',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-relay-key',
      model: 'gpt-5.6-terra',
      contextWindowTokens: 1_000_000,
      openaiApiMode: 'responses',
      capabilities: { vision: false, toolCalling: true, streaming: true },
    }, fetchImpl);

    assert.equal(runtime.capabilities?.vision, true);
    assert.equal(runtime.capabilitiesSource, 'relay-models');
    assert.ok(runtime.capabilitiesCheckedAt);
  });

  test('replaces legacy GPT vision=false from static catalog metadata when relay metadata is unavailable', async () => {
    const runtime = await refreshCatsRelayCatalogRuntimeCapabilities({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: 'bot-1',
      modelId: 'gpt-5.6-terra',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-relay-key',
      model: 'gpt-5.6-terra',
      contextWindowTokens: 1_000_000,
      openaiApiMode: 'responses',
      capabilities: { vision: false, toolCalling: true, streaming: true },
    }, (async () => new Response('temporarily unavailable', { status: 503 })) as typeof fetch);

    assert.equal(runtime.capabilities?.vision, true);
    assert.equal(runtime.capabilities?.toolCalling, true);
    assert.equal(runtime.capabilitiesSource, 'static');
  });

  test('uses models.dev when relay model metadata omits input modalities', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'models.dev') {
        return Response.json({
          openai: {
            models: {
              'gpt-5.6-terra': {
                id: 'gpt-5.6-terra',
                modalities: { input: ['text', 'image', 'pdf'] },
              },
            },
          },
        });
      }
      return new Response('relay models unavailable', { status: 503 });
    }) as typeof fetch;

    const runtime = await refreshCatsRelayCatalogRuntimeCapabilities({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: 'bot-1',
      modelId: 'gpt-5.6-terra',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-relay-key',
      model: 'gpt-5.6-terra',
      contextWindowTokens: 1_000_000,
      openaiApiMode: 'responses',
      capabilities: { vision: false, toolCalling: true, streaming: true },
    }, fetchImpl);

    assert.equal(runtime.capabilities?.vision, true);
    assert.equal(runtime.capabilitiesSource, 'models-dev');
    assert.ok(runtime.capabilitiesCheckedAt);
  });
});

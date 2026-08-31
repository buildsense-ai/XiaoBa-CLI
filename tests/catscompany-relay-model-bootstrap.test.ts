import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  provisionCatsRelayCatalogRuntime,
  refreshCatsRelayCatalogRuntimeCapabilities,
  retargetCatsRelayCatalogRuntime,
} from '../src/catscompany/relay-model-bootstrap';
import { relayModelProfileFromRuntimeDescriptor } from '../src/utils/relay-model-profiles';

describe('CatsCo default relay model bootstrap', () => {
  test('accepts a new cloud catalog model without a shipped local profile', () => {
    const profile = relayModelProfileFromRuntimeDescriptor('new-model-2026', {
      catalogModelId: 'new-model-2026',
      model: 'provider-new-model',
      provider: 'anthropic',
      contextWindowTokens: 128_000,
      capabilities: { vision: false, toolCalling: true, streaming: true },
    });
    assert.equal(profile?.id, 'new-model-2026');
    assert.equal(profile?.preferredProvider, 'anthropic');
    assert.equal(profile?.contextWindowTokens, 128_000);
    assert.equal(profile?.model, 'provider-new-model');
  });

  test('materializes GLM 5.3 Flash from the cloud catalog with max reasoning', async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          base_url: 'https://relay.example.test',
          self_service_enabled: true,
          endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.example.test/anthropic' }],
          models: [{ id: 'glm-5.3-flash', enabled: true }],
        });
      }
      if (url.pathname === '/api/relay/key' && init?.method === 'GET') {
        return Response.json({ key: { key: 'sk-glm-test-key', state: 'active' } });
      }
      if (url.pathname === '/v1/models') {
        return Response.json({ data: [{
          id: 'glm-5.3-flash',
          capabilities: { vision: true, tool_calling: true, streaming: true },
        }] });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    }) as typeof fetch;

    const runtime = await provisionCatsRelayCatalogRuntime({
      botId: 'bot-glm',
      modelId: 'glm-5.3-flash',
      reasoningEffort: 'max',
      auth: {
        token: 'user-token',
        uid: 'user-1',
        displayName: 'Alice',
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
      },
      fetchImpl,
    });

    assert.equal(runtime.modelId, 'glm-5.3-flash');
    assert.equal(runtime.model, 'glm-5.3-flash');
    assert.equal(runtime.provider, 'anthropic');
    assert.equal(runtime.apiBase, 'https://relay.example.test/anthropic');
    assert.equal(runtime.reasoningEffort, 'max');
    assert.equal(runtime.contextWindowTokens, 1_000_000);
    assert.deepStrictEqual(runtime.capabilities, { vision: true, toolCalling: true, streaming: true });
  });

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

  test('cloud context window wins over the local profile for catalog models', async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          base_url: 'https://relay.example.test',
          self_service_enabled: true,
          endpoints: [{ protocol: 'OpenAI-compatible', base_url: 'https://relay.example.test/v1' }],
        });
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { key: 'sk-relay-key' } });
      }
      if (url.pathname === '/v1/models') {
        return Response.json({
          data: [{ id: 'gpt-5.6-sol', capabilities: { vision: true, tool_calling: true, streaming: true } }],
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    }) as typeof fetch;

    const runtime = await provisionCatsRelayCatalogRuntime({
      botId: 'bot-1',
      modelId: 'gpt-5.6-sol',
      // 模拟服务器下发权威 context window（200k），必须覆盖本地 profile 的 256k。
      contextWindowTokens: 200_000,
      auth: {
        token: 'user-token',
        uid: 'user-1',
        displayName: 'Alice',
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
      },
      fetchImpl,
    });

    assert.equal(runtime.modelId, 'gpt-5.6-sol');
    assert.equal(runtime.provider, 'openai');
    assert.equal(runtime.apiBase, 'https://relay.example.test/v1');
    assert.equal(runtime.contextWindowTokens, 200_000);
  });

  test('replaces stale GPT vision=false runtime metadata from the relay catalog', async () => {    const fetchImpl = (async () => Response.json({
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

  test('retargets an existing owner relay credential across provider protocols', () => {
    const runtime = retargetCatsRelayCatalogRuntime({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: 'bot-1',
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-existing-owner-key',
      model: 'gpt-5.6-sol',
      contextWindowTokens: 1_000_000,
      openaiApiMode: 'responses',
    }, 'deepseek-v4-flash', 'max');

    assert.equal(runtime.modelId, 'deepseek-v4-flash');
    assert.equal(runtime.provider, 'openai');
    assert.equal(runtime.apiBase, 'https://relay.example.test/v1');
    assert.equal(runtime.apiKey, 'sk-existing-owner-key');
    assert.equal(runtime.model, 'deepseek-v4-flash');
    assert.equal(runtime.reasoningEffort, 'max');
    assert.equal(runtime.openaiApiMode, 'responses');
    assert.deepStrictEqual(runtime.capabilities, {
      toolCalling: true,
      vision: true,
      streaming: true,
    });
    assert.equal(runtime.capabilitiesSource, 'static');
  });

  test('uses an existing owner relay credential when a long-running bot has no account login', async () => {
    let requested = false;
    const runtime = await provisionCatsRelayCatalogRuntime({
      botId: 'bot-1',
      modelId: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      auth: {
        ownerUid: 'owner-1',
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
        botUid: 'bot-1',
        apiKey: 'bot-api-key',
      },
      existingRuntime: {
        schema: 'xiaoba.bot-catalog-model-runtime.v1',
        botId: 'bot-1',
        ownerUid: 'owner-1',
        modelId: 'minimax-m3',
        provider: 'anthropic',
        apiBase: 'https://relay.example.test/anthropic',
        apiKey: 'sk-existing-owner-key',
        model: 'MiniMax-M3',
        contextWindowTokens: 1_000_000,
      },
      fetchImpl: (async (input: string | URL | Request) => {
        requested = true;
        assert.equal(new URL(String(input)).pathname, '/v1/models');
        return Response.json({ data: [{ id: 'gpt-5.6-terra' }] });
      }) as typeof fetch,
    });

    assert.equal(requested, true);
    assert.equal(runtime.modelId, 'gpt-5.6-terra');
    assert.equal(runtime.apiBase, 'https://relay.example.test/v1');
    assert.equal(runtime.apiKey, 'sk-existing-owner-key');
    assert.equal(runtime.openaiApiMode, 'responses');
    assert.equal(runtime.reasoningEffort, 'xhigh');
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

  test('rejects a cached relay credential owned by another account', async () => {
    await assert.rejects(() => provisionCatsRelayCatalogRuntime({
      botId: 'bot-1',
      modelId: 'gpt-5.6-terra',
      auth: {
        ownerUid: 'owner-b',
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
        botUid: 'bot-1',
        apiKey: 'bot-api-key',
      },
      existingRuntime: {
        schema: 'xiaoba.bot-catalog-model-runtime.v1',
        botId: 'bot-1',
        ownerUid: 'owner-a',
        modelId: 'minimax-m3',
        provider: 'anthropic',
        apiBase: 'https://relay.example.test/anthropic',
        apiKey: 'sk-owner-a',
        model: 'MiniMax-M3',
        contextWindowTokens: 1_000_000,
      },
      fetchImpl: (async () => Response.json({ data: [] })) as typeof fetch,
    }), /unbound relay credential/);
  });

  test('rejects cross-protocol retargeting for a non-standard relay path', () => {
    assert.throws(() => retargetCatsRelayCatalogRuntime({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: 'bot-1',
      ownerUid: 'owner-1',
      modelId: 'minimax-m3',
      provider: 'anthropic',
      apiBase: 'https://private-relay.example.test/proxy/models',
      apiKey: 'sk-private-relay',
      model: 'MiniMax-M3',
      contextWindowTokens: 1_000_000,
    }, 'gpt-5.6-terra'), /cannot be retargeted across protocols/);
  });

  test('rejects an invalid cached relay key before applying a retargeted model', async () => {
    await assert.rejects(() => provisionCatsRelayCatalogRuntime({
      botId: 'bot-1',
      modelId: 'gpt-5.6-terra',
      auth: {
        ownerUid: 'owner-1',
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
        botUid: 'bot-1',
        apiKey: 'bot-api-key',
      },
      existingRuntime: {
        schema: 'xiaoba.bot-catalog-model-runtime.v1',
        botId: 'bot-1',
        ownerUid: 'owner-1',
        modelId: 'minimax-m3',
        provider: 'anthropic',
        apiBase: 'https://relay.example.test/anthropic',
        apiKey: 'sk-revoked',
        model: 'MiniMax-M3',
        contextWindowTokens: 1_000_000,
      },
      fetchImpl: (async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
    }), /relay credential was rejected/);
  });

  test('retarget preserves discovered capabilities instead of resetting them to static', () => {
    const runtime = retargetCatsRelayCatalogRuntime({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: 'bot-1',
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-existing-owner-key',
      model: 'gpt-5.6-sol',
      contextWindowTokens: 1_000_000,
      openaiApiMode: 'responses',
      capabilities: { vision: true, toolCalling: true, streaming: false },
      capabilitiesSource: 'relay-models',
      capabilitiesCheckedAt: '2026-01-01T00:00:00.000Z',
    }, 'deepseek-v4-flash', 'max');

    assert.equal(runtime.modelId, 'deepseek-v4-flash');
    assert.equal(runtime.capabilitiesSource, 'relay-models');
    assert.deepStrictEqual(runtime.capabilities, { vision: true, toolCalling: true, streaming: false });
    assert.equal(runtime.capabilitiesCheckedAt, '2026-01-01T00:00:00.000Z');
  });

});

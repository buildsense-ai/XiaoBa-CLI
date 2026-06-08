import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  ChannelAgentBindingResolver,
  resolveChannelAgentBindingOptions,
} from '../src/core/channel-agent-binding-resolver';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ChannelAgentBindingResolver', () => {
  test('only enables when explicitly enabled and a binding base URL is configured', () => {
    assert.equal(new ChannelAgentBindingResolver({ enabled: true }).enabled, false);
    assert.equal(new ChannelAgentBindingResolver({
      enabled: true,
      httpBaseUrl: 'https://app.catsco.cc/',
    }).enabled, true);
  });

  test('resolves env options with CatsCo and CatsCompany names', () => {
    const catsco = resolveChannelAgentBindingOptions({
      CATSCO_CHANNEL_BINDING_HTTP_BASE_URL: 'https://app.catsco.cc/',
      CATSCO_CHANNEL_AGENT_BINDING_ENABLED: 'true',
      CATSCO_CHANNEL_AGENT_BINDING_REQUIRED: 'yes',
      CATSCO_CHANNEL_BINDING_TOKEN: 'secret',
      CATSCO_CHANNEL_BINDING_TIMEOUT_MS: '1200',
    });
    assert.deepEqual(catsco, {
      httpBaseUrl: 'https://app.catsco.cc/',
      token: 'secret',
      enabled: true,
      required: true,
      timeoutMs: 1200,
    });

    const legacy = resolveChannelAgentBindingOptions({
      CATSCOMPANY_CHANNEL_BINDING_HTTP_BASE_URL: 'https://legacy.catsco.cc',
      CATSCOMPANY_CHANNEL_AGENT_BINDING_ENABLED: '1',
    });
    assert.equal(legacy.httpBaseUrl, 'https://legacy.catsco.cc');
    assert.equal(legacy.enabled, true);
  });

  test('sends channel identity query with bearer token and maps bound response', async () => {
    const calls: Array<{ url: URL; auth?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: new URL(String(input)),
        auth: String(init?.headers && (init.headers as Record<string, string>).Authorization || ''),
      });
      return new Response(JSON.stringify({
        bound: true,
        agent_uid: 43,
        agent_id: 'usr43',
        agent_body_id: 'body-contract',
        owner_uid: 7,
        identity_trust: 'server_canonical',
        identity_source: 'channel_agent_binding',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const resolver = new ChannelAgentBindingResolver({
      enabled: true,
      httpBaseUrl: 'https://app.catsco.cc/',
      token: 'secret',
    });
    const resolved = await resolver.resolve({
      channel: 'feishu',
      channelAppId: 'cli_app',
      channelUserId: 'ou_user',
      channelConversationId: 'oc_chat',
      channelConversationType: 'p2p',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/api/channel-agent-bindings/resolve');
    assert.equal(calls[0].url.searchParams.get('channel'), 'feishu');
    assert.equal(calls[0].url.searchParams.get('channel_app_id'), 'cli_app');
    assert.equal(calls[0].url.searchParams.get('channel_user_id'), 'ou_user');
    assert.equal(calls[0].url.searchParams.get('channel_conversation_id'), 'oc_chat');
    assert.equal(calls[0].url.searchParams.get('channel_conversation_type'), 'p2p');
    assert.equal(calls[0].auth, 'Bearer secret');
    assert.deepEqual(resolved, {
      bound: true,
      agentUid: 43,
      ownerUid: 7,
      agentId: 'usr43',
      agentBodyId: 'body-contract',
      identityTrust: 'server_canonical',
      identitySource: 'channel_agent_binding',
    });
  });

  test('returns unbound and rejects malformed bound responses', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ bound: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const resolver = new ChannelAgentBindingResolver({
      enabled: true,
      httpBaseUrl: 'https://app.catsco.cc',
    });
    assert.deepEqual(await resolver.resolve({
      channel: 'weixin',
      channelUserId: 'openid',
    }), { bound: false });

    globalThis.fetch = (async () => new Response(JSON.stringify({ bound: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(
      resolver.resolve({ channel: 'weixin', channelUserId: 'openid' }),
      /missing agent_id/,
    );
  });
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE,
  CATSCO_RUNTIME_MUTATION_GRANT_SCOPE,
  getUsableCatsCoRuntimeActivationAckCredential,
  issueCatsCoRuntimeCredential,
  provisionCatsCoRuntimeCredential,
} from '../src/catscompany/runtime-credential';
import type { CatsCompanyConfig } from '../src/catscompany/types';
import type { CatsCoAuthSnapshot } from '../src/catscompany/local-config';

describe('CatsCo Runtime credential provisioning', () => {
  const config: CatsCompanyConfig = {
    serverUrl: 'wss://app.catsco.cc/v0/channels',
    httpBaseUrl: 'https://app.catsco.cc',
    apiKey: 'bot-api-key',
    botUid: '42',
    bodyId: 'body-prod-1',
    installationId: 'install-prod-1',
    ownerUserId: '7',
  };
  const auth: CatsCoAuthSnapshot = {
    token: 'owner-user-token',
    uid: '7',
    httpBaseUrl: 'https://app.catsco.cc',
    serverUrl: 'wss://app.catsco.cc/v0/channels',
  };

  test('issues an owner-authorized credential for the exact Runtime binding', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({
        bot_uid: 42,
        body_id: 'body-prod-1',
        installation_id: 'install-prod-1',
        scopes: ['skill_mutation:grant'],
        credential: 'runtime-credential',
        expires_at: Date.now() + 86_400_000,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const issued = await issueCatsCoRuntimeCredential({
      httpBaseUrl: 'https://app.catsco.cc/',
      userToken: 'owner-user-token',
      botUid: '42',
      bodyId: 'body-prod-1',
      installationId: 'install-prod-1',
      fetchImpl,
    });

    assert.equal(captured?.url, 'https://app.catsco.cc/api/bots/runtime-credential');
    assert.equal((captured?.init?.headers as Record<string, string>).Authorization, 'Bearer owner-user-token');
    assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
      bot_uid: 42,
      body_id: 'body-prod-1',
      installation_id: 'install-prod-1',
    });
    assert.equal(issued.credential, 'runtime-credential');
    assert.deepEqual(issued.scopes, ['skill_mutation:grant']);
  });

  test('rejects a credential response bound to another Runtime', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      bot_uid: 42,
      body_id: 'body-other',
      installation_id: 'install-prod-1',
      scopes: ['skill_mutation:grant'],
      credential: 'runtime-credential',
      expires_at: Date.now() + 86_400_000,
    }), { status: 201, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    await assert.rejects(
      issueCatsCoRuntimeCredential({
        httpBaseUrl: 'https://app.catsco.cc',
        userToken: 'owner-user-token',
        botUid: '42',
        bodyId: 'body-prod-1',
        installationId: 'install-prod-1',
        fetchImpl,
      }),
      /invalid Runtime credential binding/,
    );
  });

  test('requests activation ACK scope only when explicitly enabled and verifies the response', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        bot_uid: 42,
        body_id: 'body-prod-1',
        installation_id: 'install-prod-1',
        scopes: [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE, CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE],
        credential: 'runtime-credential-with-ack',
        expires_at: Date.now() + 86_400_000,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const issued = await issueCatsCoRuntimeCredential({
      httpBaseUrl: 'https://app.catsco.cc',
      userToken: 'owner-user-token',
      botUid: '42',
      bodyId: 'body-prod-1',
      installationId: 'install-prod-1',
      scopes: [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE, CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE],
      fetchImpl,
    });

    assert.deepEqual(requestBody?.scopes, [
      CATSCO_RUNTIME_MUTATION_GRANT_SCOPE,
      CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE,
    ]);
    assert.deepEqual(issued.scopes, requestBody?.scopes);

    await assert.rejects(
      issueCatsCoRuntimeCredential({
        httpBaseUrl: 'https://app.catsco.cc',
        userToken: 'owner-user-token',
        botUid: '42',
        bodyId: 'body-prod-1',
        installationId: 'install-prod-1',
        scopes: [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE, CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE],
        fetchImpl: (async () => new Response(JSON.stringify({
          bot_uid: 42,
          body_id: 'body-prod-1',
          installation_id: 'install-prod-1',
          scopes: [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE],
          credential: 'grant-only-credential',
          expires_at: Date.now() + 86_400_000,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
      }),
      /invalid Runtime credential binding/,
    );
  });

  test('automatically provisions only for the locally authenticated owner', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return new Response(JSON.stringify({
        bot_uid: 42,
        body_id: 'body-prod-1',
        installation_id: 'install-prod-1',
        scopes: ['skill_mutation:grant'],
        credential: 'runtime-credential',
        expires_at: Date.now() + 86_400_000,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const provisioned = await provisionCatsCoRuntimeCredential(config, auth, { fetchImpl });
    const friend = await provisionCatsCoRuntimeCredential(config, { ...auth, uid: '8' }, { fetchImpl });

    assert.equal(provisioned.runtimeCredential, 'runtime-credential');
    assert.ok(Number(provisioned.runtimeCredentialExpiresAt) > Date.now());
    assert.equal(friend.runtimeCredential, undefined);
    assert.equal(requests, 1);
  });

  test('reissues a dedicated ACK credential instead of reusing an existing grant-only credential', async () => {
    let requests = 0;
    const existing = {
      ...config,
      runtimeCredential: 'existing-grant-only-credential',
      runtimeCredentialExpiresAt: Date.now() + 86_400_000,
    };
    const provisioned = await provisionCatsCoRuntimeCredential(existing, auth, {
      scopes: [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE, CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE],
      fetchImpl: (async () => {
        requests += 1;
        return new Response(JSON.stringify({
          bot_uid: 42,
          body_id: 'body-prod-1',
          installation_id: 'install-prod-1',
          scopes: [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE, CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE],
          credential: 'dedicated-activation-ack-credential',
          expires_at: Date.now() + 86_400_000,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    });

    assert.equal(requests, 1);
    assert.equal(provisioned.runtimeCredential, 'existing-grant-only-credential');
    assert.equal(
      getUsableCatsCoRuntimeActivationAckCredential(provisioned),
      'dedicated-activation-ack-credential',
    );
  });

  test('fails closed on a server with only an existing grant-only credential', async () => {
    let requests = 0;
    const existing = { ...config, runtimeCredential: 'server-grant-only-credential' };
    const provisioned = await provisionCatsCoRuntimeCredential(existing, {
      httpBaseUrl: 'https://app.catsco.cc',
      serverUrl: 'wss://app.catsco.cc/v0/channels',
    }, {
      scopes: [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE, CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE],
      fetchImpl: (async () => {
        requests += 1;
        throw new Error('must not request without an owner session');
      }) as typeof fetch,
    });

    assert.equal(provisioned, existing);
    assert.equal(requests, 0);
    assert.equal(getUsableCatsCoRuntimeActivationAckCredential(provisioned), undefined);
  });

  test('refuses to start from an expired dedicated ACK credential', () => {
    assert.equal(getUsableCatsCoRuntimeActivationAckCredential({
      runtimeActivationAckCredential: 'expired-activation-ack-credential',
      runtimeActivationAckCredentialExpiresAt: 1_000,
    }, 1_001), undefined);
  });

  test('preserves an explicitly provisioned server credential without an owner session', async () => {
    let requested = false;
    const explicit = { ...config, runtimeCredential: 'server-managed-credential' };
    const result = await provisionCatsCoRuntimeCredential(explicit, {
      httpBaseUrl: 'https://app.catsco.cc',
      serverUrl: 'wss://app.catsco.cc/v0/channels',
    }, {
      fetchImpl: (async () => {
        requested = true;
        throw new Error('should not request');
      }) as typeof fetch,
    });
    assert.equal(result, explicit);
    assert.equal(requested, false);
  });
});

import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareBoundBotDefinition } from '../src/bot-definition/activation';
import { redactCloudBotModelError } from '../src/bot-definition/cloud-client';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import {
  FileBotCatalogModelRuntimeRepository,
  FileBotCloudCatalogModelRuntimeRepository,
  FileBotCloudModelOverrideRepository,
  FileBotCustomModelProfileRepository,
  FileBotDefinitionRepository,
} from '../src/bot-definition/repository';
import { resolveActiveBotLLMConfig } from '../src/bot-definition/llm-config-resolver';
import { BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';

describe('BotDefinition activation', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('materializes the selected catalog model before connector preflight instead of mixing stale legacy material', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-activation-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-activation-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {
      CATSCO_MODEL_SOURCE: 'relay',
      CATSCO_RELAY_LLM_PROVIDER: 'anthropic',
      CATSCO_RELAY_LLM_API_BASE: 'https://relay.example.test/anthropic',
      CATSCO_RELAY_LLM_MODEL: 'deepseek-v4-flash',
      CATSCO_RELAY_LLM_API_KEY: 'sk-stale-deepseek-material',
    } as NodeJS.ProcessEnv;

    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
      },
      account: { token: 'user-token', uid: 'user-1', displayName: 'Alice' },
      currentBot: {
        uid: 'bot-bravo',
        apiKey: 'bot-bravo-key',
        boundByUserUid: 'user-1',
        bindingSource: 'test',
      },
      device: { deviceId: 'device-1', bodyId: 'body-1', installationId: 'install-1' },
    });
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-bravo',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method || 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          self_service_enabled: true,
          base_url: 'https://relay.example.test',
          endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.example.test/anthropic' }],
        });
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { state: 'active', key: 'sk-bravo-relay-material' } });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
    });

    assert.equal(prepared?.botId, 'bot-bravo');
    assert.equal(prepared?.materializedCatalogRuntime, true);
    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('bot-bravo');
    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.equal(runtime?.model, 'MiniMax-M3');
    assert.equal(runtime?.apiKey, 'sk-bravo-relay-material');
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.model, 'MiniMax-M3');
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.apiKey, 'sk-bravo-relay-material');
    assert.equal(env.CATSCO_RELAY_LLM_API_KEY, undefined);
    assert.deepStrictEqual(requests, [
      'GET /api/bot/model-config',
      'GET /api/relay/config',
      'GET /api/relay/key',
    ]);
  });

  test('applies and acknowledges a cloud-selected model after its local runtime is ready', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-model-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-model-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'user-token', uid: '7', displayName: 'Alice' },
      currentBot: {
        uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test',
      },
    });
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '43',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });

    const requests: Array<{ method: string; path: string; body?: any; authorization?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({
        method: init?.method || 'GET',
        path: url.pathname,
        body,
        authorization: new Headers(init?.headers).get('Authorization') || undefined,
      });
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 43,
          configured: true,
          desired: { model_id: 'deepseek-v4-flash', reasoning_effort: 'max', revision: 2 },
        });
      }
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          self_service_enabled: true,
          base_url: 'https://relay.example.test',
          endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.example.test/anthropic' }],
        });
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { state: 'active', key: 'sk-cloud-model' } });
      }
      if (url.pathname === '/api/bot/model-config/ack') {
        return Response.json({ status: 'applied' });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({ runtimeRoot, simulatedCloudRoot, env, fetchImpl });

    assert.equal(prepared?.cloudRevision, 2);
    assert.deepStrictEqual(prepared?.definition.model, {
      kind: 'catalog', modelId: 'deepseek-v4-flash', reasoningEffort: 'max',
    });
    const runtime = new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).read('43');
    assert.equal(runtime?.modelId, 'deepseek-v4-flash');
    assert.equal(runtime?.reasoningEffort, 'max');
    assert.equal(new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('43'), undefined);
    const ack = requests.find(item => item.path === '/api/bot/model-config/ack');
    assert.deepStrictEqual(ack?.body, {
      revision: 2,
      model_id: 'deepseek-v4-flash',
      reasoning_effort: 'max',
    });
    assert.equal(requests.find(item => item.path === '/api/bot/model-config')?.authorization, 'ApiKey bot-api-key');
    assert.equal(ack?.authorization, 'ApiKey bot-api-key');
    assert.equal(requests.find(item => item.path === '/api/relay/config')?.authorization, 'Bearer user-token');
  });

  test('materializes a cloud-selected GPT-5.6 model through OpenAI Responses', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-gpt56-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-gpt56-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'user-token', uid: '7', displayName: 'Alice' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });

    let ackBody: any;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 43,
          configured: true,
          desired: { model_id: 'gpt-5.6-terra', reasoning_effort: 'xhigh', revision: 5 },
        });
      }
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          self_service_enabled: true,
          base_url: 'https://relay.example.test',
          models: [{ id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', enabled: true }],
          endpoints: [{ protocol: 'OpenAI-compatible', base_url: 'https://relay.example.test/v1' }],
        });
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { state: 'active', key: 'sk-cloud-gpt56' } });
      }
      if (url.pathname === '/api/bot/model-config/ack') {
        ackBody = JSON.parse(String(init?.body));
        return Response.json({ status: 'applied' });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({ runtimeRoot, simulatedCloudRoot, env, fetchImpl });
    const runtime = new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).read('43');

    assert.equal(prepared?.cloudRevision, 5);
    assert.equal(runtime?.provider, 'openai');
    assert.equal(runtime?.openaiApiMode, 'responses');
    assert.equal(runtime?.model, 'gpt-5.6-terra');
    assert.equal(runtime?.reasoningEffort, 'xhigh');
    assert.deepStrictEqual(ackBody, {
      revision: 5,
      model_id: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh',
    });
  });

  test('prepares an exact runtime reload selection without polling or acknowledging early', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-runtime-reload-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-runtime-reload-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'user-token', uid: '7' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });
    const requestedPaths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          self_service_enabled: true,
          base_url: 'https://relay.example.test',
          models: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', enabled: true }],
          endpoints: [{ protocol: 'OpenAI-compatible', base_url: 'https://relay.example.test/v1' }],
        });
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { state: 'active', key: 'sk-runtime-reload' } });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      auth: createCatsCoLocalConfigService({ runtimeRoot, env }).getAuthState(),
      fetchImpl,
      cloudSelection: { modelId: 'gpt-5.6-luna', reasoningEffort: 'medium', revision: 8 },
      acknowledgeCloudSelection: false,
    });

    assert.equal(prepared?.cloudRevision, 8);
    assert.equal(requestedPaths.includes('/api/bot/model-config'), false);
    assert.equal(requestedPaths.includes('/api/bot/model-config/ack'), false);
  });

  test('keeps the last runnable local model when a cloud selection cannot be applied', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-model-fallback-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-model-fallback-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'user-token', uid: '7' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '43',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).write({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: '43',
      modelId: 'minimax-m3',
      provider: 'anthropic',
      apiBase: 'https://relay.example.test/anthropic',
      apiKey: 'sk-existing',
      model: 'MiniMax-M3',
      contextWindowTokens: 1_000_000,
    });
    let failureAck: any;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({ uid: 43, configured: true, desired: { model_id: 'unknown-model', revision: 4 } });
      }
      if (url.pathname === '/api/bot/model-config/ack') {
        failureAck = JSON.parse(String(init?.body));
        return Response.json({ status: 'failed' });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({ runtimeRoot, simulatedCloudRoot, env, fetchImpl });

    assert.deepStrictEqual(prepared?.definition.model, { kind: 'catalog', modelId: 'minimax-m3' });
    assert.equal(new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('43')?.apiKey, 'sk-existing');
    assert.equal(failureAck.revision, 4);
    assert.equal(failureAck.model_id, 'unknown-model');
    assert.match(failureAck.error, /Unknown CatsCo relay model/);
  });

  test('redacts a cloud custom model API key from runtime errors', () => {
    const selection = {
      kind: 'custom' as const,
      modelId: 'private-model',
      revision: 3,
      customModel: {
        kind: 'custom' as const,
        protocol: 'openai-responses' as const,
        apiBase: 'https://models.example.test/v1',
        model: 'private-model',
        apiKey: 'sk-secret-value',
        contextWindowTokens: 128000,
      },
    };
    assert.equal(
      redactCloudBotModelError(new Error('request failed for sk-secret-value'), selection),
      'request failed for [REDACTED]',
    );
  });

  test('applies an encrypted-at-server custom model without requesting relay runtime material', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-custom-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-custom-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'user-token', uid: '7' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });

    const requests: Array<{ path: string; body?: any }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 43,
          configured: true,
          desired: {
            kind: 'custom',
            model_id: 'private-reasoner',
            reasoning_effort: 'high',
            revision: 9,
            custom: {
              protocol: 'openai-responses',
              api_base: 'https://models.example.test/v1/',
              model: 'private-reasoner',
              api_key: 'sk-runtime-only-secret',
              context_window_tokens: 256000,
              max_tokens: 8192,
              temperature: 0.4,
              reasoning_effort: 'high',
            },
          },
        });
      }
      if (url.pathname === '/api/bot/model-config/ack') {
        return Response.json({ status: 'applied' });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({ runtimeRoot, simulatedCloudRoot, env, fetchImpl });
    const resolved = resolveActiveBotLLMConfig({ runtimeRoot, env });

    assert.equal(prepared?.cloudRevision, 9);
    assert.deepStrictEqual(prepared?.definition.model, {
      kind: 'custom',
      protocol: 'openai-responses',
      apiBase: 'https://models.example.test/v1',
      model: 'private-reasoner',
      apiKey: 'sk-runtime-only-secret',
      contextWindowTokens: 256000,
      maxTokens: 8192,
      temperature: 0.4,
      reasoningEffort: 'high',
    });
    assert.equal(resolved?.source, 'custom_definition');
    assert.equal(resolved?.config.openaiApiMode, 'responses');
    assert.equal(resolved?.config.apiKey, 'sk-runtime-only-secret');
    assert.equal(requests.some(item => item.path === '/api/relay/config' || item.path === '/api/relay/key'), false);
    assert.deepStrictEqual(requests.find(item => item.path === '/api/bot/model-config/ack')?.body, {
      revision: 9,
      kind: 'custom',
      model_id: 'private-reasoner',
      reasoning_effort: 'high',
    });
  });

  test('rejects an incomplete cloud custom model and preserves the previous local definition', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-invalid-cloud-custom-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-invalid-cloud-custom-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });
    const previous = { kind: 'catalog' as const, modelId: 'minimax-m3' };
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '43',
      model: previous,
    });
    new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).write({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: '43',
      modelId: 'minimax-m3',
      provider: 'anthropic',
      apiBase: 'https://relay.example.test/anthropic',
      apiKey: 'sk-existing',
      model: 'MiniMax-M3',
      contextWindowTokens: 1_000_000,
    });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 43,
          configured: true,
          desired: {
            kind: 'custom', model_id: 'private-model', revision: 10,
            custom: {
              protocol: 'openai-responses', api_base: 'https://models.example.test/v1',
              model: 'private-model', api_key: '', context_window_tokens: 128000,
            },
          },
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({ runtimeRoot, simulatedCloudRoot, env, fetchImpl });
    assert.deepStrictEqual(prepared?.definition.model, previous);
    assert.equal(prepared?.cloudRevision, undefined);
  });

  test('does not replace an existing local custom model until the owner enables cloud management', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-model-opt-in-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-model-opt-in-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });
    const customModel = {
      kind: 'custom' as const,
      protocol: 'openai-responses' as const,
      apiBase: 'https://custom.example.test/v1',
      apiKey: 'sk-local-custom',
      model: 'custom-model',
      contextWindowTokens: 128_000,
    };
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '43',
      model: customModel,
    });
    let acknowledged = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 43,
          configured: false,
          desired: { model_id: 'minimax-m3', reasoning_effort: '', revision: 0 },
        });
      }
      if (url.pathname === '/api/bot/model-config/ack') acknowledged = true;
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({ runtimeRoot, simulatedCloudRoot, env, fetchImpl });

    assert.deepStrictEqual(prepared?.definition.model, customModel);
    assert.equal(prepared?.cloudRevision, undefined);
    assert.equal(acknowledged, false);
  });

  test('keeps local model state separate across cloud apply, restart, and return to device local', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-overlay-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-overlay-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });
    const localModel = {
      kind: 'custom' as const,
      protocol: 'openai-responses' as const,
      apiBase: 'https://local.example.test/v1',
      model: 'local-model',
      apiKey: 'sk-local-model',
      contextWindowTokens: 128_000,
    };
    const localDefinition = { schema: BOT_DEFINITION_SCHEMA, botId: '43', model: localModel } as const;
    const definitions = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    definitions.writeCanonical(localDefinition);

    const cloudModel = {
      kind: 'custom' as const,
      protocol: 'openai-responses' as const,
      apiBase: 'https://cloud.example.test/v1',
      model: 'cloud-model',
      apiKey: 'sk-cloud-model',
      contextWindowTokens: 256_000,
      reasoningEffort: 'high' as const,
    };
    const cloudPrepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      cloudSelection: {
        kind: 'custom', modelId: 'cloud-model', revision: 11,
        reasoningEffort: 'high', customModel: cloudModel,
      },
      acknowledgeCloudSelection: false,
    });

    assert.equal(cloudPrepared?.cloudRevision, 11);
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.model, 'cloud-model');
    assert.deepStrictEqual(definitions.readCanonical('43'), localDefinition);
    assert.deepStrictEqual(definitions.readCache('43'), localDefinition);
    assert.deepStrictEqual(new FileBotCustomModelProfileRepository({ runtimeRoot }).read('43')?.model, localModel);
    assert.equal(new FileBotCloudModelOverrideRepository({ runtimeRoot }).read('43')?.model.kind, 'custom');

    const restartPrepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl: (async () => Response.json({ error: 'temporary outage' }, { status: 500 })) as typeof fetch,
      acknowledgeCloudSelection: false,
    });
    assert.equal(restartPrepared?.definition.model.kind, 'custom');
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.model, 'cloud-model');

    const localPrepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      cloudSelection: { kind: 'local', modelId: 'local', revision: 12 },
      acknowledgeCloudSelection: false,
    });
    assert.equal(localPrepared?.cloudRevision, 12);
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.model, 'local-model');
    assert.equal(new FileBotCloudModelOverrideRepository({ runtimeRoot }).read('43'), undefined);
    assert.deepStrictEqual(definitions.readCanonical('43'), localDefinition);
    assert.deepStrictEqual(new FileBotCustomModelProfileRepository({ runtimeRoot }).read('43')?.model, localModel);
  });

  test('restores the untouched local catalog runtime after a cloud catalog round trip', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-catalog-roundtrip-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-catalog-roundtrip-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'user-token', uid: '7' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });
    const definitions = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    definitions.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '43',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    const localRuntimes = new FileBotCatalogModelRuntimeRepository({ runtimeRoot });
    localRuntimes.write({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: '43',
      modelId: 'minimax-m3',
      provider: 'anthropic',
      apiBase: 'https://relay.example.test/anthropic',
      apiKey: 'sk-local-relay',
      model: 'MiniMax-M3',
      contextWindowTokens: 1_000_000,
    });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          self_service_enabled: true,
          base_url: 'https://relay.example.test',
          endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.example.test/anthropic' }],
        });
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { state: 'active', key: 'sk-cloud-relay' } });
      }
      if (url.pathname === '/api/bot/model-config/ack') {
        return Response.json({ status: 'applied' });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      cloudSelection: { kind: 'catalog', modelId: 'deepseek-v4-flash', reasoningEffort: 'max', revision: 20 },
    });
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.model, 'deepseek-v4-flash');
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.apiKey, 'sk-cloud-relay');
    assert.equal(localRuntimes.read('43')?.apiKey, 'sk-local-relay');

    await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      cloudSelection: { kind: 'local', modelId: 'local', revision: 21 },
    });
    const restored = resolveActiveBotLLMConfig({ runtimeRoot, env });
    assert.equal(restored?.config.model, 'MiniMax-M3');
    assert.equal(restored?.config.apiKey, 'sk-local-relay');
    assert.equal(localRuntimes.read('43')?.apiKey, 'sk-local-relay');
  });

  test('keeps the cloud override when returning to a local catalog model cannot prepare its runtime', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-local-rollback-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-local-rollback-canonical-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {} as NodeJS.ProcessEnv;
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'user-token', uid: '7' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
    });
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '43',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    const cloudModel = {
      kind: 'custom' as const,
      protocol: 'openai-responses' as const,
      apiBase: 'https://cloud.example.test/v1',
      model: 'cloud-model',
      apiKey: 'sk-cloud-model',
      contextWindowTokens: 256_000,
    };
    new FileBotCloudModelOverrideRepository({ runtimeRoot }).write({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '43',
      model: cloudModel,
    });

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl: (async () => Response.json({ error: 'relay temporarily unavailable' }, { status: 503 })) as typeof fetch,
      cloudSelection: { kind: 'local', modelId: 'local', revision: 22 },
      acknowledgeCloudSelection: false,
    });

    assert.match(prepared?.cloudApplyError || '', /relay temporarily unavailable/);
    assert.equal(prepared?.cloudRevision, undefined);
    assert.deepStrictEqual(new FileBotCloudModelOverrideRepository({ runtimeRoot }).read('43')?.model, cloudModel);
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.model, 'cloud-model');
    assert.equal(new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('43'), undefined);
  });
});

import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareBoundBotDefinition } from '../src/bot-definition/activation';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import {
  FileBotCatalogModelRuntimeRepository,
  FileBotCloudCatalogModelRuntimeRepository,
  FileBotDefinitionRepository,
} from '../src/bot-definition/repository';
import { resolveActiveBotLLMConfig } from '../src/bot-definition/llm-config-resolver';
import { BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';

/**
 * 覆盖完整性测试：验证"云端自定义配置项是否真的完整覆盖本地"。
 *
 * 重点覆盖新协议 /api/bot/definition（reconcileStartup 分支）：
 *  - catalog 模型：modelId / reasoningEffort / contextWindowTokens 应全部跟随云端
 *  - custom 模型：protocol / apiBase / model / apiKey / contextWindowTokens /
 *    maxTokens / temperature / reasoningEffort 应全部跟随云端
 *  - 与旧协议 cloudSelection 分支做行为对齐（后者已完整处理 contextWindowTokens）
 */
describe('BotDefinition cloud configuration coverage', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function makeEnv(runtimeRoot: string): NodeJS.ProcessEnv {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-app-'));
    roots.push(appRoot);
    fs.mkdirSync(path.join(appRoot, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'prompts', 'system-prompt.md'), 'bundled v1\n', 'utf-8');
    return { XIAOBA_APP_ROOT: appRoot, XIAOBA_USER_DATA_DIR: runtimeRoot } as NodeJS.ProcessEnv;
  }

  function bindBot(runtimeRoot: string, env: NodeJS.ProcessEnv): void {
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      account: { token: 'owner-token', uid: '7', displayName: 'Alice' },
      currentBot: { uid: '43', apiKey: 'bot-api-key', boundByUserUid: '7', bindingSource: 'test' },
      device: { deviceId: 'device-1', bodyId: 'body-1', installationId: 'install-1' },
    });
  }

  function relayConfig() {
    return Response.json({
      self_service_enabled: true,
      base_url: 'https://relay.example.test',
      models: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', enabled: true }],
      endpoints: [{ protocol: 'OpenAI-compatible', base_url: 'https://relay.example.test/v1' }],
    });
  }

  test('reconcileStartup keeps cloud catalog contextWindowTokens on an existing matching runtime', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-ctx-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-ctx-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = makeEnv(runtimeRoot);
    bindBot(runtimeRoot, env);

    // 模拟旧设备：持久化的普通 catalog runtime 是 100 万（历史漂移值）。
    // reconcileStartup 分支读的是 readCatalogRuntime（普通仓库）。
    new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).write({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: '43',
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-existing-relay-key',
      model: 'gpt-5.6-sol',
      contextWindowTokens: 1_000_000,
      reasoningEffort: 'xhigh',
      openaiApiMode: 'responses',
      capabilities: { vision: true, toolCalling: true, streaming: true },
      capabilitiesSource: 'relay-models',
      capabilitiesCheckedAt: new Date().toISOString(),
    });

    // 云端新协议 definition 下发权威 context window 256000。
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/definition') {
        return Response.json({
          uid: 43,
          configured: true,
          revision: 12,
          definition: {
            schema: BOT_DEFINITION_SCHEMA,
            botId: '43',
            model: {
              kind: 'catalog',
              modelId: 'gpt-5.6-sol',
              contextWindowTokens: 256000,
              reasoningEffort: 'xhigh',
            },
            prompt: { selected: 'default' },
          },
        });
      }
      if (url.pathname === '/api/bot/definition/ack') {
        return Response.json({ status: 'applied' });
      }
      if (url.pathname === '/api/bot/definition/skills') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      if (url.pathname === '/v1/models') {
        return Response.json({
          data: [{ id: 'gpt-5.6-sol', capabilities: { vision: true, tool_calling: true, streaming: true } }],
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      prepareSkills: false,
    });
    assert.equal(prepared?.botId, '43');

    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('43');
    assert.equal(runtime?.modelId, 'gpt-5.6-sol');
    // 云端权威 contextWindowTokens 必须覆盖本地旧值 100 万
    assert.equal(runtime?.contextWindowTokens, 256_000);
    assert.equal(runtime?.apiKey, 'sk-existing-relay-key');
  });

  test('reconcileStartup applies cloud catalog contextWindowTokens when materializing fresh', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-fresh-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-fresh-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = makeEnv(runtimeRoot);
    bindBot(runtimeRoot, env);

    // 云端 definition 下发 262144（与本地 profile 默认 256000 不同），应优先云端。
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/definition') {
        return Response.json({
          uid: 43,
          configured: true,
          revision: 7,
          definition: {
            schema: BOT_DEFINITION_SCHEMA,
            botId: '43',
            model: {
              kind: 'catalog',
              modelId: 'gpt-5.6-sol',
              contextWindowTokens: 262144,
              reasoningEffort: 'xhigh',
            },
            prompt: { selected: 'default' },
          },
        });
      }
      if (url.pathname === '/api/bot/definition/ack') {
        return Response.json({ status: 'applied' });
      }
      if (url.pathname === '/api/bot/definition/skills') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      if (url.pathname === '/api/relay/config') {
        return relayConfig();
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { state: 'active', key: 'sk-fresh' } });
      }
      if (url.pathname === '/v1/models') {
        return Response.json({
          data: [{ id: 'gpt-5.6-sol', capabilities: { vision: true, tool_calling: true, streaming: true } }],
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      prepareSkills: false,
    });
    assert.equal(prepared?.botId, '43');
    assert.equal(prepared?.materializedCatalogRuntime, true);

    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('43');
    assert.equal(runtime?.modelId, 'gpt-5.6-sol');
    // 云端权威 contextWindowTokens=262144 必须生效（而非本地 profile 默认 256000）
    assert.equal(runtime?.contextWindowTokens, 262_144);
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.contextWindowTokens, 262_144);
  });

  test('reconcileStartup applies full cloud custom model fields', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-custom-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-custom-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = makeEnv(runtimeRoot);
    bindBot(runtimeRoot, env);

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/definition') {
        return Response.json({
          uid: 43,
          configured: true,
          revision: 9,
          definition: {
            schema: BOT_DEFINITION_SCHEMA,
            botId: '43',
            model: {
              kind: 'custom',
              protocol: 'openai-responses',
              apiBase: 'https://models.example.test/v1/',
              model: 'private-reasoner',
              apiKey: 'sk-runtime-only-secret',
              contextWindowTokens: 128000,
              maxTokens: 8192,
              temperature: 0.4,
              reasoningEffort: 'high',
            },
            prompt: { selected: 'default' },
          },
        });
      }
      if (url.pathname === '/api/bot/definition/ack') {
        return Response.json({ status: 'applied' });
      }
      if (url.pathname === '/api/bot/definition/skills') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      prepareSkills: false,
    });
    const resolved = resolveActiveBotLLMConfig({ runtimeRoot, env });

    assert.equal(prepared?.cloudRevision, 9);
    assert.equal(resolved?.source, 'custom_definition');
    assert.deepStrictEqual(prepared?.definition.model, {
      kind: 'custom',
      protocol: 'openai-responses',
      apiBase: 'https://models.example.test/v1',
      model: 'private-reasoner',
      apiKey: 'sk-runtime-only-secret',
      contextWindowTokens: 128000,
      maxTokens: 8192,
      temperature: 0.4,
      reasoningEffort: 'high',
    });
    assert.equal(resolved?.config.apiKey, 'sk-runtime-only-secret');
    assert.equal(resolved?.config.contextWindowTokens, 128000);
    assert.equal(resolved?.config.maxTokens, 8192);
    assert.equal(resolved?.config.temperature, 0.4);
    assert.equal(resolved?.config.reasoningEffort, 'high');
  });

  test('catalog definition exposes contextWindowTokens and reasoningEffort to the local cache', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-cache-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-cache-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = makeEnv(runtimeRoot);
    bindBot(runtimeRoot, env);

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/definition') {
        return Response.json({
          uid: 43,
          configured: true,
          revision: 3,
          definition: {
            schema: BOT_DEFINITION_SCHEMA,
            botId: '43',
            model: {
              kind: 'catalog',
              modelId: 'gpt-5.6-terra',
              contextWindowTokens: 256000,
              reasoningEffort: 'xhigh',
            },
            prompt: { selected: 'default' },
          },
        });
      }
      if (url.pathname === '/api/bot/definition/ack') {
        return Response.json({ status: 'applied' });
      }
      if (url.pathname === '/api/bot/definition/skills') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
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
        return Response.json({ key: { state: 'active', key: 'sk-cache-relay' } });
      }
      if (url.pathname === '/v1/models') {
        return Response.json({
          data: [{ id: 'gpt-5.6-terra', capabilities: { vision: true, tool_calling: true, streaming: true } }],
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      prepareSkills: false,
    });

    const cached = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).readCache('43');
    assert.equal(cached?.model.kind, 'catalog');
    assert.equal(cached?.model.modelId, 'gpt-5.6-terra');
    assert.equal(cached?.model.contextWindowTokens, 256000);
    assert.equal(cached?.model.reasoningEffort, 'xhigh');
    assert.equal(prepared?.definition.model.kind, 'catalog');
    assert.equal(prepared?.definition.model.contextWindowTokens, 256000);
  });

  test('reuses an ownerless legacy runtime when no user token is present and writes ownerUid', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-ownerless-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-ownerless-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = makeEnv(runtimeRoot);
    // 绑定 bot：boundByUserUid=536（owner），但无 account token（worker 场景）
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      currentBot: {
        uid: '537',
        apiKey: 'bot-api-key',
        boundByUserUid: '536',
        bindingSource: 'production-recovery',
      },
    });

    // 模拟旧版本物化的 runtime：无 ownerUid 字段（grep ownerUid=0）
    new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).write({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: '537',
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-legacy-relay-key',
      model: 'gpt-5.6-sol',
      contextWindowTokens: 256000,
      reasoningEffort: 'xhigh',
      openaiApiMode: 'responses',
      capabilities: { vision: true, toolCalling: true, streaming: true },
      capabilitiesSource: 'relay-models',
    });

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      // 云端切到 deepseek-v4-flash（本地无缓存模型）
      if (url.pathname === '/api/bot/definition') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 537,
          configured: true,
          desired: {
            kind: 'catalog',
            model_id: 'deepseek-v4-flash',
            reasoning_effort: 'max',
            context_window_tokens: 1000000,
            revision: 15,
          },
        });
      }
      // 复用旧凭据的校验：relay /v1/models 应返回 200
      if (url.pathname === '/v1/models' || url.pathname.endsWith('/models')) {
        return Response.json({
          data: [{ id: 'deepseek-v4-flash', capabilities: { vision: true, tool_calling: true, streaming: true } }],
        });
      }
      if (url.pathname === '/api/bot/definition/ack') {
        return Response.json({ status: 'applied' });
      }
      if (url.pathname === '/api/bot/model-config/ack') {
        return Response.json({ status: 'applied' });
      }
      if (url.pathname === '/api/bot/definition/skills') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      prepareSkills: false,
    });
    assert.equal(prepared?.botId, '537');

    // 复用成功：新模型 runtime 物化，且补写了 ownerUid=536
    const runtime = new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).read('537');
    assert.equal(runtime?.modelId, 'deepseek-v4-flash');
    assert.equal(runtime?.apiKey, 'sk-legacy-relay-key');
    assert.equal(runtime?.ownerUid, '536');
    assert.equal(runtime?.contextWindowTokens, 1_000_000);
  });

  test('reused runtime does not inherit the old model context window when the cloud omits it', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-noctx-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-noctx-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = makeEnv(runtimeRoot);
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      currentBot: { uid: '537', apiKey: 'bot-api-key', boundByUserUid: '536', bindingSource: 'production-recovery' },
    });

    // 旧模型 gpt-5.6-sol 的 runtime 携带漂移窗口 100 万，且无 ownerUid。
    new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).write({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: '537',
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-legacy-relay-key',
      model: 'gpt-5.6-sol',
      contextWindowTokens: 1_000_000,
      reasoningEffort: 'xhigh',
      openaiApiMode: 'responses',
      capabilities: { vision: true, toolCalling: true, streaming: true },
      capabilitiesSource: 'relay-models',
    });

    // 云端切到 deepseek-v4-flash 但不下发 context_window_tokens（旧服务器行为）。
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/definition') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 537,
          configured: true,
          desired: { kind: 'catalog', model_id: 'deepseek-v4-flash', reasoning_effort: 'max', revision: 15 },
        });
      }
      if (url.pathname === '/v1/models' || url.pathname.endsWith('/models')) {
        return Response.json({
          data: [{ id: 'deepseek-v4-flash', capabilities: { vision: true, tool_calling: true, streaming: true } }],
        });
      }
      if (url.pathname === '/api/bot/model-config/ack') {
        return Response.json({ status: 'applied' });
      }
      if (url.pathname === '/api/bot/definition/skills') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
      prepareSkills: false,
    });
    assert.equal(prepared?.botId, '537');

    const runtime = new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).read('537');
    assert.equal(runtime?.modelId, 'deepseek-v4-flash');
    // deepseek 本地 profile 标准窗口是 100 万，但绝不能继承旧 gpt runtime 的漂移值。
    assert.equal(runtime?.contextWindowTokens, 1_000_000);
  });

  test('rejects reuse when the runtime belongs to a different owner', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-otherowner-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cov-otherowner-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = makeEnv(runtimeRoot);
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
      currentBot: { uid: '537', apiKey: 'bot-api-key', boundByUserUid: '536', bindingSource: 'production-recovery' },
    });

    // runtime 明确归属另一个 owner（999），必须拒绝复用。
    new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).write({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: '537',
      ownerUid: '999',
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      apiBase: 'https://relay.example.test/v1',
      apiKey: 'sk-other-owner-key',
      model: 'gpt-5.6-sol',
      contextWindowTokens: 256000,
      reasoningEffort: 'xhigh',
      openaiApiMode: 'responses',
      capabilities: { vision: true, toolCalling: true, streaming: true },
      capabilitiesSource: 'relay-models',
    });

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/bot/definition') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      if (url.pathname === '/api/bot/model-config') {
        return Response.json({
          uid: 537,
          configured: true,
          desired: { kind: 'catalog', model_id: 'deepseek-v4-flash', reasoning_effort: 'max', revision: 15 },
        });
      }
      if (url.pathname === '/api/bot/definition/skills') {
        return Response.json({ error: 'not deployed' }, { status: 404 });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    // 无 token、runtime 归属他人 → 复用被拒绝，报"需要登录"。
    await assert.rejects(
      () => prepareBoundBotDefinition({
        runtimeRoot,
        simulatedCloudRoot,
        env,
        fetchImpl,
        prepareSkills: false,
      }),
      /account login is required before an unbound relay credential can be reused/,
    );
    // 保持不变（仍属 999 的旧模型），未复用为 deepseek
    const runtime = new FileBotCloudCatalogModelRuntimeRepository({ runtimeRoot }).read('537');
    assert.equal(runtime?.modelId, 'gpt-5.6-sol');
    assert.equal(runtime?.ownerUid, '999');
  });
});

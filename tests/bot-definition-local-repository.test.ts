import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { ConfigManager } from '../src/utils/config';
import { FileBotCatalogModelRuntimeRepository, FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { resolveActiveBotLLMConfig } from '../src/bot-definition/llm-config-resolver';
import {
  botModelDefinitionFromLocalProfile,
  createBotDefinitionSyncService,
  readLocalModelProfile,
} from '../src/bot-definition/service';
import {
  BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
  BOT_DEFINITION_SCHEMA,
  type BotDefinition,
} from '../src/bot-definition/types';

const managedEnvKeys = [
  'XIAOBA_USER_DATA_DIR',
  'XIAOBA_BUNDLED_EXECUTABLES_DIR',
  'XIAOBA_BOT_DEFINITION_SIMULATED_CLOUD_DIR',
  'CATSCO_MODEL_SOURCE',
  'CATSCO_CUSTOM_LLM_PROVIDER',
  'CATSCO_CUSTOM_LLM_API_BASE',
  'CATSCO_CUSTOM_LLM_MODEL',
  'CATSCO_CUSTOM_LLM_API_KEY',
  'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS',
  'CATSCO_CUSTOM_LLM_REASONING_EFFORT',
  'CATSCO_CUSTOM_LLM_OPENAI_API_MODE',
  'CATSCO_RELAY_LLM_MODEL',
  'CATSCO_RELAY_LLM_API_BASE',
  'CATSCO_RELAY_LLM_API_KEY',
  'CATSCO_RELAY_LLM_VISION_CAPABLE',
  'CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE',
  'GAUZ_LLM_PROVIDER',
  'GAUZ_LLM_API_BASE',
  'GAUZ_LLM_API_KEY',
  'GAUZ_LLM_MODEL',
  'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
  'GAUZ_LLM_CONTEXT_TOKENS',
  'GAUZ_LLM_TEMPERATURE',
  'GAUZ_LLM_REASONING_EFFORT',
  'GAUZ_LLM_OPENAI_API_MODE',
  'XIAOBA_CONFIG_PATH',
];

describe('BotDefinition local simulation', () => {
  let runtimeRoot: string;
  let simulatedCloudRoot: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-definition-runtime-'));
    simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-definition-cloud-'));
    originalEnv = {};
    for (const key of managedEnvKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of managedEnvKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(simulatedCloudRoot, { recursive: true, force: true });
  });

  function bindCurrentBot(botId = 'bot-alpha'): void {
    createCatsCoLocalConfigService({ runtimeRoot, env: {} as NodeJS.ProcessEnv }).save({
      version: 1,
      currentBot: {
        uid: botId,
        apiKey: 'bot-api-key',
        boundByUserUid: 'user-alpha',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-alpha',
        bodyId: 'body-alpha',
        installationId: 'install-alpha',
      },
    });
  }

  test('publishes a custom model on local change and refreshes the local cache', () => {
    bindCurrentBot();
    const env = {
      CATSCO_MODEL_SOURCE: 'custom',
      CATSCO_CUSTOM_LLM_PROVIDER: 'anthropic',
      CATSCO_CUSTOM_LLM_API_BASE: 'https://models.example.test/v1/messages',
      CATSCO_CUSTOM_LLM_MODEL: 'claude-custom',
      CATSCO_CUSTOM_LLM_API_KEY: 'sk-custom-secret',
      CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS: '272000',
    } as NodeJS.ProcessEnv;
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, env });

    const result = service.publishCurrentBoundBot();
    assert.equal(result?.direction, 'bootstrap_to_simulated_cloud');
    assert.deepStrictEqual(result?.definition.model, {
      kind: 'custom',
      protocol: 'anthropic',
      apiBase: 'https://models.example.test/v1/messages',
      model: 'claude-custom',
      apiKey: 'sk-custom-secret',
      contextWindowTokens: 272000,
    });

    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    assert.deepStrictEqual(repository.readCanonical('bot-alpha'), result?.definition);
    assert.deepStrictEqual(repository.readCache('bot-alpha'), result?.definition);
  });

  test('pull uses canonical data over stale cache and does not overwrite canonical data', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const canonical: BotDefinition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'gpt-5.6-terra' },
    };
    repository.writeCanonical(canonical);
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'old-model' },
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot });

    const result = service.pullOrBootstrap('bot-alpha');
    assert.equal(result?.direction, 'simulated_cloud_to_local');
    assert.deepStrictEqual(result?.definition, canonical);
    assert.deepStrictEqual(repository.readCanonical('bot-alpha'), canonical);
    assert.deepStrictEqual(repository.readCache('bot-alpha'), canonical);
  });

  test('ignores a malformed canonical record instead of applying a partial model', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const canonicalPath = repository.getCanonicalPath('bot-alpha');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, JSON.stringify({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'custom', model: 'missing-required-fields' },
    }));

    assert.equal(repository.readCanonical('bot-alpha'), undefined);
  });

  test('catalog definition stores only the model identifier', () => {
    const profile = readLocalModelProfile(runtimeRoot, {
      CATSCO_MODEL_SOURCE: 'relay',
      CATSCO_RELAY_LLM_MODEL: 'gpt-5.6-terra',
      CATSCO_RELAY_LLM_API_KEY: 'sk-relay-key-not-in-definition',
    } as NodeJS.ProcessEnv);
    assert.deepStrictEqual(botModelDefinitionFromLocalProfile(profile!), {
      kind: 'catalog',
      modelId: 'gpt-5.6-terra',
    });
  });

  test('explicit custom source remains custom even when it uses a relay gateway URL', () => {
    const profile = readLocalModelProfile(runtimeRoot, {
      CATSCO_MODEL_SOURCE: 'custom',
      CATSCO_CUSTOM_LLM_PROVIDER: 'openai',
      CATSCO_CUSTOM_LLM_API_BASE: 'https://relay.catsco.cc/v1',
      CATSCO_CUSTOM_LLM_MODEL: 'third-party-model',
      CATSCO_CUSTOM_LLM_API_KEY: 'sk-third-party-key',
      CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS: '200000',
    } as NodeJS.ProcessEnv);
    assert.deepStrictEqual(botModelDefinitionFromLocalProfile(profile!), {
      kind: 'custom',
      protocol: 'openai-chat-completions',
      apiBase: 'https://relay.catsco.cc/v1',
      model: 'third-party-model',
      apiKey: 'sk-third-party-key',
      contextWindowTokens: 200000,
    });
  });

  test('cached custom definition overrides stale legacy model variables at runtime', () => {
    bindCurrentBot();
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const definition: BotDefinition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: {
        kind: 'custom',
        protocol: 'openai-responses',
        apiBase: 'https://new-model.example.test/v1',
        model: 'gpt-new',
        apiKey: 'sk-new-secret',
        contextWindowTokens: 272000,
        reasoningEffort: 'high',
      },
    };
    repository.writeCache(definition);
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    process.env.XIAOBA_BUNDLED_EXECUTABLES_DIR = path.join(simulatedCloudRoot, 'bundled-executables');
    process.env.GAUZ_LLM_PROVIDER = 'anthropic';
    process.env.GAUZ_LLM_API_BASE = 'https://stale.example.test/v1';
    process.env.GAUZ_LLM_MODEL = 'stale-model';
    process.env.GAUZ_LLM_API_KEY = 'stale-key';

    const config = ConfigManager.getConfigReadonly();
    assert.equal(config.provider, 'openai');
    assert.equal(config.apiUrl, 'https://new-model.example.test/v1');
    assert.equal(config.model, 'gpt-new');
    assert.equal(config.apiKey, 'sk-new-secret');
    assert.equal(config.contextWindowTokens, 272000);
    assert.equal(config.openaiApiMode, 'responses');
    assert.equal(config.reasoningEffort, 'high');

  });

  test('cached catalog runtime overrides stale legacy environment variables at runtime', () => {
    bindCurrentBot();
    const definitions = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    definitions.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'catalog-gpt-5' },
    });
    new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).write({
      schema: BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
      botId: 'bot-alpha',
      modelId: 'catalog-gpt-5',
      provider: 'anthropic',
      apiBase: 'https://relay.example.test/anthropic',
      apiKey: 'sk-device-relay-material',
      model: 'gpt-5-catalog-runtime',
      contextWindowTokens: 272000,
      reasoningEffort: 'high',
      openaiApiMode: 'chat_completions',
    });
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    process.env.GAUZ_LLM_PROVIDER = 'openai';
    process.env.GAUZ_LLM_API_BASE = 'https://stale.example.test/v1';
    process.env.GAUZ_LLM_MODEL = 'stale-model';
    process.env.GAUZ_LLM_API_KEY = 'stale-key';

    const config = ConfigManager.getConfigReadonly();
    assert.equal(config.provider, 'anthropic');
    assert.equal(config.apiUrl, 'https://relay.example.test/anthropic');
    assert.equal(config.model, 'gpt-5-catalog-runtime');
    assert.equal(config.apiKey, 'sk-device-relay-material');
    assert.equal(config.contextWindowTokens, 272000);
    assert.equal(config.reasoningEffort, 'high');
  });

  test('catalog runtime performs a one-time migration only when the legacy model matches the Definition', () => {
    bindCurrentBot();
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'catalog-gpt-5' },
    });
    const env = {
      CATSCO_MODEL_SOURCE: 'relay',
      CATSCO_RELAY_LLM_PROVIDER: 'anthropic',
      CATSCO_RELAY_LLM_API_BASE: 'https://relay.example.test/anthropic',
      CATSCO_RELAY_LLM_MODEL: 'catalog-gpt-5',
      CATSCO_RELAY_LLM_API_KEY: 'sk-legacy-relay-material',
      CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS: '272000',
      CATSCO_RELAY_LLM_REASONING_EFFORT: 'high',
      CATSCO_RELAY_LLM_VISION_CAPABLE: 'false',
      CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE: 'true',
    } as NodeJS.ProcessEnv;

    createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, env }).pullOrBootstrap('bot-alpha');
    const first = resolveActiveBotLLMConfig({ runtimeRoot, env });
    assert.equal(first?.source, 'catalog_runtime');
    assert.equal(first?.config.apiKey, 'sk-legacy-relay-material');
    assert.deepStrictEqual(first?.config.modelCapabilities, { vision: false, toolCalling: true });
    const stored = new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('bot-alpha');
    assert.equal(stored?.modelId, 'catalog-gpt-5');
    assert.equal(stored?.apiKey, 'sk-legacy-relay-material');
    assert.deepStrictEqual(stored?.capabilities, { vision: false, toolCalling: true });

    const second = resolveActiveBotLLMConfig({
      runtimeRoot,
      env: {
        ...env,
        CATSCO_RELAY_LLM_API_KEY: 'sk-stale-after-migration',
      } as NodeJS.ProcessEnv,
    });
    assert.equal(second?.config.apiKey, 'sk-legacy-relay-material');
  });

  test('normalizes a relay-facing legacy model name to the catalog id during migration', () => {
    bindCurrentBot();
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    const env = {
      CATSCO_MODEL_SOURCE: 'relay',
      CATSCO_RELAY_LLM_PROVIDER: 'anthropic',
      CATSCO_RELAY_LLM_API_BASE: 'https://relay.example.test/anthropic',
      CATSCO_RELAY_LLM_MODEL: 'MiniMax-M3',
      CATSCO_RELAY_LLM_API_KEY: 'sk-minimax-legacy-material',
    } as NodeJS.ProcessEnv;

    createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, env }).pullOrBootstrap('bot-alpha');

    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('bot-alpha');
    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.equal(runtime?.model, 'MiniMax-M3');
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.apiKey, 'sk-minimax-legacy-material');
  });

  test('normalizes an existing catalog runtime alias when it is read', () => {
    const runtimeRepository = new FileBotCatalogModelRuntimeRepository({ runtimeRoot });
    runtimeRepository.write({
      schema: BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
      botId: 'bot-alpha',
      modelId: 'MiniMax-M3',
      provider: 'anthropic',
      apiBase: 'https://relay.example.test/anthropic',
      apiKey: 'sk-minimax-legacy-runtime',
      model: 'MiniMax-M3',
      contextWindowTokens: 200000,
      reasoningEffort: 'high',
    });

    const runtime = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot })
      .readCatalogRuntime('bot-alpha');
    const persisted = runtimeRepository.read('bot-alpha');

    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.equal(runtime?.model, 'MiniMax-M3');
    assert.equal(persisted?.modelId, 'minimax-m3');
    assert.equal(persisted?.model, 'MiniMax-M3');
  });

  test('does not attach a stale legacy relay profile to a different catalog model', () => {
    bindCurrentBot();
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'current-catalog-model' },
    });
    const env = {
      CATSCO_MODEL_SOURCE: 'relay',
      CATSCO_RELAY_LLM_PROVIDER: 'anthropic',
      CATSCO_RELAY_LLM_API_BASE: 'https://relay.example.test/anthropic',
      CATSCO_RELAY_LLM_MODEL: 'stale-catalog-model',
      CATSCO_RELAY_LLM_API_KEY: 'sk-stale-relay-material',
    } as NodeJS.ProcessEnv;

    createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, env }).pullOrBootstrap('bot-alpha');

    assert.equal(new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('bot-alpha'), undefined);
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env }), undefined);
  });

  test('captures legacy model settings once, then removes only model keys', () => {
    bindCurrentBot();
    const configPath = path.join(runtimeRoot, 'legacy-config.json');
    fs.writeFileSync(path.join(runtimeRoot, '.env'), [
      'CATSCO_USER_TOKEN=user-token-must-remain',
      'CATSCO_MODEL_SOURCE=custom',
      'CATSCO_CUSTOM_LLM_PROVIDER=openai',
      'CATSCO_CUSTOM_LLM_API_BASE=https://models.example.test/v1',
      'CATSCO_CUSTOM_LLM_MODEL=portable-model',
      'CATSCO_CUSTOM_LLM_API_KEY=sk-portable',
      'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS=272000',
      'GAUZ_LLM_TEMPERATURE=0.2',
      '',
    ].join('\n'));
    fs.writeFileSync(configPath, JSON.stringify({
      apiKey: 'stale-config-key',
      model: 'stale-config-model',
      catscompany: { enabled: true },
    }));
    const env = {
      XIAOBA_CONFIG_PATH: configPath,
      CATSCO_MODEL_SOURCE: 'custom',
      CATSCO_CUSTOM_LLM_PROVIDER: 'openai',
      CATSCO_CUSTOM_LLM_API_BASE: 'https://models.example.test/v1',
      CATSCO_CUSTOM_LLM_MODEL: 'portable-model',
      CATSCO_CUSTOM_LLM_API_KEY: 'sk-portable',
      CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS: '272000',
      GAUZ_LLM_TEMPERATURE: '0.2',
    } as NodeJS.ProcessEnv;

    const result = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, env })
      .pullOrBootstrapCurrentBoundBot();

    assert.equal(result?.definition.model.kind, 'custom');
    if (result?.definition.model.kind === 'custom') {
      assert.equal(result.definition.model.temperature, 0.2);
    }
    const envContents = fs.readFileSync(path.join(runtimeRoot, '.env'), 'utf-8');
    assert.match(envContents, /CATSCO_USER_TOKEN=user-token-must-remain/);
    assert.doesNotMatch(envContents, /CATSCO_(MODEL_SOURCE|CUSTOM_LLM_)|GAUZ_LLM_/);
    assert.equal(env.CATSCO_CUSTOM_LLM_API_KEY, undefined);
    const cleanedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(cleanedConfig.apiKey, undefined);
    assert.equal(cleanedConfig.model, undefined);
    assert.deepStrictEqual(cleanedConfig.catscompany, { enabled: true });
  });
});

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import express from 'express';
import type { Server } from 'http';
import { createApiRouter } from '../src/dashboard/routes/api';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { FileBotCatalogModelRuntimeRepository, FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';

describe('dashboard typed settings API', () => {
  let testRoot: string;
  let originalCwd: string;
  let server: Server | undefined;
  let baseUrl: string;
  const envKeys = [
    'GAUZ_LLM_PROVIDER',
    'GAUZ_LLM_API_BASE',
    'GAUZ_LLM_API_KEY',
    'GAUZ_LLM_MODEL',
    'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
    'GAUZ_LLM_CONTEXT_TOKENS',
    'GAUZ_LLM_REASONING_EFFORT',
    'GAUZ_LLM_OPENAI_API_MODE',
    'CATSCO_MODEL_SOURCE',
    'CATSCO_CUSTOM_LLM_PROVIDER',
    'CATSCO_CUSTOM_LLM_API_BASE',
    'CATSCO_CUSTOM_LLM_API_KEY',
    'CATSCO_CUSTOM_LLM_MODEL',
    'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS',
    'CATSCO_CUSTOM_LLM_REASONING_EFFORT',
    'CATSCO_CUSTOM_LLM_OPENAI_API_MODE',
    'CATSCO_RELAY_LLM_PROVIDER',
    'CATSCO_RELAY_LLM_API_BASE',
    'CATSCO_RELAY_LLM_API_KEY',
    'CATSCO_RELAY_LLM_MODEL',
    'CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS',
    'CATSCO_RELAY_LLM_REASONING_EFFORT',
    'CATSCO_RELAY_LLM_OPENAI_API_MODE',
    'CATSCO_RELAY_LLM_VISION_CAPABLE',
    'CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE',
    'CATSCO_HTTP_BASE_URL',
    'CATSCO_SERVER_URL',
    'CATSCO_USER_TOKEN',
    'CATSCO_USER_UID',
    'CATSCO_USER_NAME',
    'CATSCO_USER_DISPLAY_NAME',
    'CATSCO_BOT_UID',
    'CATSCO_API_KEY',
    'CATSCO_DEVICE_ID',
    'CATSCO_BODY_ID',
    'CATSCO_INSTALLATION_ID',
    'CATSCOMPANY_HTTP_BASE_URL',
    'CATSCOMPANY_USER_TOKEN',
    'CATSCOMPANY_USER_UID',
    'CATSCOMPANY_USER_NAME',
    'CATSCOMPANY_USER_DISPLAY_NAME',
    'CATSCOMPANY_BOT_UID',
    'CATSCOMPANY_API_KEY',
    'CATSCOMPANY_SERVER_URL',
    'CATSCOMPANY_DEVICE_ID',
    'CATSCOMPANY_BODY_ID',
    'CATSCOMPANY_INSTALLATION_ID',
    'XIAOBA_USER_DATA_DIR',
    'XIAOBA_CONFIG_PATH',
  ];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-settings-api-'));
    process.chdir(testRoot);

    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({ getAll: () => [] } as any));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    process.chdir(originalCwd);
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('GET /settings returns secret presence without leaking secret values', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1',
      'GAUZ_LLM_API_KEY=sk-super-secret',
      'GAUZ_LLM_MODEL=claude-test',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/settings`);
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const apiKey = data.fields.find((field: any) => field.id === 'model.apiKey');
    const model = data.fields.find((field: any) => field.id === 'model.model');

    assert.equal(response.status, 200);
    assert.equal(apiKey.present, true);
    assert.equal(apiKey.last4, undefined);
    assert.equal(apiKey.value, undefined);
    assert.equal(model.value, 'claude-test');
    assert.equal(text.includes('sk-super-secret'), false);
    assert.equal(text.includes('"last4"'), false);
  });

  test('GET /settings omits secret suffixes for short secrets', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'GAUZ_LLM_API_KEY=abc',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/settings`);
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const apiKey = data.fields.find((field: any) => field.id === 'model.apiKey');

    assert.equal(response.status, 200);
    assert.equal(apiKey.present, true);
    assert.equal(apiKey.last4, undefined);
    assert.equal(text.includes('abc'), false);
  });

  test('GET /settings preserves a bound custom model served through the relay gateway', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: {
        uid: 'custom-relay-gateway-bot',
        apiKey: 'catsco-bot-api-key',
        boundByUserUid: 'user-custom-relay-gateway',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-custom-relay-gateway',
        bodyId: 'body-custom-relay-gateway',
        installationId: 'install-custom-relay-gateway',
      },
    });
    createBotDefinitionSyncService({ runtimeRoot: testRoot }).publish('custom-relay-gateway-bot', {
      kind: 'custom',
      protocol: 'openai-responses',
      apiBase: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-sol',
      apiKey: 'sk-custom-relay-gateway',
      contextWindowTokens: 256_000,
      reasoningEffort: 'default',
    });

    const response = await fetch(`${baseUrl}/api/settings`);
    const text = await response.text();
    const data = JSON.parse(text) as any;

    assert.equal(response.status, 200, text);
    assert.equal(data.modelStartup.source, 'custom');
    assert.equal(data.modelStartup.effective.model, 'gpt-5.6-sol');
    assert.equal(data.modelStartup.custom.configured, true);
    assert.equal(data.modelStartup.custom.model, 'gpt-5.6-sol');
    assert.equal(data.modelStartup.relay.configured, false);
    assert.equal(text.includes('sk-custom-relay-gateway'), false);
  });

  test('PUT /cats/config/preferences persists close button behavior', async () => {
    const initialResponse = await fetch(`${baseUrl}/api/cats/config`);
    const initial = await initialResponse.json() as any;
    assert.equal(initialResponse.status, 200);
    assert.equal(initial.preferences.closeToTray, true);

    const response = await fetch(`${baseUrl}/api/cats/config/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closeToTray: false }),
    });
    const data = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.preferences.closeToTray, false);

    const config = createCatsCoLocalConfigService({ runtimeRoot: testRoot }).load();
    assert.equal(config.preferences?.closeToTray, false);
  });

  test('GET /settings sanitizes URL credentials and query values before display', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'GAUZ_LLM_API_BASE=https://user:pass@model.example.test/v1/messages?token=secret#frag',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/settings`);
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const apiBase = data.fields.find((field: any) => field.id === 'model.apiBase');

    assert.equal(response.status, 200);
    assert.equal(apiBase.value, 'https://model.example.test/v1/messages');
    assert.equal(text.includes('user:pass'), false);
    assert.equal(text.includes('token=secret'), false);
  });

  test('GET /settings exposes fixed custom model context window tiers', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'GAUZ_LLM_CONTEXT_WINDOW_TOKENS=256000',
      'GAUZ_LLM_REASONING_EFFORT=max',
      'GAUZ_LLM_OPENAI_API_MODE=responses',
      'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS=256000',
      'CATSCO_CUSTOM_LLM_REASONING_EFFORT=high',
      'CATSCO_CUSTOM_LLM_OPENAI_API_MODE=responses',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/settings`);
    const data = await response.json() as any;
    const contextWindow = data.fields.find((field: any) => field.id === 'model.contextWindowTokens');

    assert.equal(response.status, 200);
    assert.equal(contextWindow.value, '256000');
    assert.deepStrictEqual(contextWindow.options, ['128000', '200000', '256000', '512000', '1000000']);
    const reasoningEffort = data.fields.find((field: any) => field.id === 'model.reasoningEffort');
    assert.equal(reasoningEffort.value, 'max');
    assert.deepStrictEqual(reasoningEffort.options, ['default', 'high', 'max', 'disabled']);
    assert.equal(data.modelStartup.custom.contextWindowTokens, 256000);
    assert.equal(data.modelStartup.effective.reasoningEffort, 'max');
    assert.equal(data.modelStartup.custom.reasoningEffort, 'high');
    const openaiApiMode = data.fields.find((field: any) => field.id === 'model.openaiApiMode');
    assert.equal(openaiApiMode.value, 'responses');
    assert.deepStrictEqual(openaiApiMode.options, ['chat_completions', 'responses']);
    assert.equal(data.modelStartup.effective.openaiApiMode, 'responses');
    assert.equal(data.modelStartup.custom.openaiApiMode, 'responses');
  });

  test('GET /settings reports the effective ConfigManager custom model when legacy env is empty', async () => {
    const configPath = path.join(testRoot, 'runtime-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      provider: 'openai',
      apiUrl: 'https://model.example.test/v1',
      apiKey: 'sk-effective-custom-secret',
      model: 'gpt-5.6-sol',
      contextWindowTokens: 256_000,
      openaiApiMode: 'responses',
    }));
    process.env.XIAOBA_CONFIG_PATH = configPath;

    const response = await fetch(`${baseUrl}/api/settings`);
    const text = await response.text();
    const settings = JSON.parse(text) as any;

    assert.equal(response.status, 200, text);
    assert.equal(settings.modelStartup.source, 'custom');
    assert.equal(settings.modelStartup.effective.configured, true);
    assert.equal(settings.modelStartup.effective.model, 'gpt-5.6-sol');
    assert.equal(settings.modelStartup.custom.configured, true);
    assert.equal(settings.modelStartup.custom.model, 'gpt-5.6-sol');
    assert.equal(text.includes('sk-effective-custom-secret'), false);
  });

  test('GET /settings carries legacy relay reasoning effort into startup snapshot', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'GAUZ_LLM_API_KEY=sk-bf-relay-secret',
      'GAUZ_LLM_MODEL=deepseek-v4-flash',
      'GAUZ_LLM_REASONING_EFFORT=max',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/settings`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.modelStartup.source, 'relay');
    assert.equal(data.modelStartup.effective.reasoningEffort, 'max');
    assert.equal(data.modelStartup.relay.reasoningEffort, 'max');
  });

  test('PUT /settings writes allowlisted model settings and refreshes process env', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.provider': 'anthropic',
          'model.apiBase': 'https://model.example.test/v1/messages',
          'model.model': 'MiniMax-M2.7-highspeed',
          'model.contextWindowTokens': '512000',
          'model.reasoningEffort': 'max',
          'model.apiKey': { action: 'replace', value: 'sk-new-secret' },
        },
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.deepStrictEqual(data.updated.sort(), [
      'GAUZ_LLM_API_BASE',
      'GAUZ_LLM_API_KEY',
      'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
      'GAUZ_LLM_MODEL',
      'GAUZ_LLM_PROVIDER',
      'GAUZ_LLM_REASONING_EFFORT',
    ].sort());
    assert.equal(text.includes('sk-new-secret'), false);
    assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-new-secret');
    assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '512000');
    assert.equal(parsed.GAUZ_LLM_REASONING_EFFORT, 'max');
    assert.equal(parsed.CATSCO_MODEL_SOURCE, 'custom');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_PROVIDER, 'anthropic');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_API_BASE, 'https://model.example.test/v1/messages');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_MODEL, 'MiniMax-M2.7-highspeed');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_API_KEY, 'sk-new-secret');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS, '512000');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_REASONING_EFFORT, 'max');
    assert.equal(process.env.GAUZ_LLM_API_KEY, 'sk-new-secret');
    assert.equal(process.env.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '512000');
    assert.equal(process.env.GAUZ_LLM_REASONING_EFFORT, 'max');

    const statusResponse = await fetch(`${baseUrl}/api/status/details`);
    const status = await statusResponse.json() as any;
    assert.equal(status.provider, 'anthropic');
    assert.equal(status.model, 'MiniMax-M2.7-highspeed');
  });

  test('PUT /settings publishes the bound bot model definition without exposing its API key', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: {
        uid: 'bot-definition-test',
        apiKey: 'catsco-bot-api-key',
        boundByUserUid: 'user-definition-test',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-definition-test',
        bodyId: 'body-definition-test',
        installationId: 'install-definition-test',
      },
    });

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.provider': 'openai',
          'model.apiBase': 'https://model.example.test/v1',
          'model.model': 'gpt-portable',
          'model.contextWindowTokens': '256000',
          'model.apiKey': { action: 'replace', value: 'sk-portable-secret' },
        },
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const definitionPath = path.join(
      testRoot,
      'data',
      'bot-definition-simulated-cloud',
      'bots',
      'bot-definition-test.json',
    );

    assert.equal(response.status, 200, text);
    assert.ok(data.botDefinitionSync, text);
    const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf-8')) as any;
    assert.equal(data.botDefinitionSync.botId, 'bot-definition-test');
    assert.equal(data.botDefinitionSync.direction, 'local_to_simulated_cloud');
    assert.equal(data.botDefinitionSync.model.kind, 'custom');
    assert.equal(data.botDefinitionSync.model.model, 'gpt-portable');
    assert.equal(data.connectorRestarted, false);
    assert.equal(data.connectorStarted, false);
    assert.equal(text.includes('sk-portable-secret'), false);
    assert.equal(definition.model.apiKey, 'sk-portable-secret');
  });

  test('GET /settings keeps a bound custom Definition custom on the CatsCo relay host', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: {
        uid: 'custom-relay-host-bot',
        apiKey: 'catsco-bot-api-key',
        boundByUserUid: 'user-definition-test',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-definition-test',
        bodyId: 'body-definition-test',
        installationId: 'install-definition-test',
      },
    });
    createBotDefinitionSyncService({ runtimeRoot: testRoot }).publish('custom-relay-host-bot', {
      kind: 'custom',
      protocol: 'openai-responses',
      apiBase: 'https://relay.catsco.cc/v1',
      model: 'gpt-5.6-sol',
      apiKey: 'sk-custom-relay-host-secret',
      contextWindowTokens: 256_000,
    });

    const response = await fetch(`${baseUrl}/api/settings`);
    const text = await response.text();
    const data = JSON.parse(text) as any;

    assert.equal(response.status, 200, text);
    assert.equal(data.modelStartup.source, 'custom');
    assert.equal(data.modelStartup.custom.configured, true);
    assert.equal(data.modelStartup.custom.model, 'gpt-5.6-sol');
    assert.equal(data.modelStartup.relay.configured, false);
    assert.equal(text.includes('sk-custom-relay-host-secret'), false);
  });

  test('bound bot keeps its custom profile while relay is active and background saves do not replace the active source', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: {
        uid: 'profile-isolation-bot',
        apiKey: 'catsco-bot-api-key',
        boundByUserUid: 'profile-isolation-user',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-profile-isolation',
        bodyId: 'body-profile-isolation',
        installationId: 'install-profile-isolation',
      },
    });
    const definitions = createBotDefinitionSyncService({ runtimeRoot: testRoot });
    definitions.publish('profile-isolation-bot', {
      kind: 'custom',
      protocol: 'openai-responses',
      apiBase: 'https://custom.example.test/v1',
      model: 'gpt-custom-original',
      apiKey: 'sk-custom-original',
      contextWindowTokens: 256_000,
      reasoningEffort: 'max',
    });
    definitions.storeCatalogRuntime({
      schema: 'xiaoba.bot-catalog-model-runtime.v1',
      botId: 'profile-isolation-bot',
      modelId: 'minimax-m3',
      provider: 'anthropic',
      apiBase: 'https://relay.catsco.cc/anthropic',
      apiKey: 'sk-relay-only',
      model: 'MiniMax-M3',
      contextWindowTokens: 1_000_000,
      reasoningEffort: 'high',
    });
    definitions.publish('profile-isolation-bot', { kind: 'catalog', modelId: 'minimax-m3' });

    const relaySettingsResponse = await fetch(`${baseUrl}/api/settings`);
    const relaySettingsText = await relaySettingsResponse.text();
    const relaySettings = JSON.parse(relaySettingsText) as any;
    const relayModelField = relaySettings.fields.find((field: any) => field.id === 'model.model');

    assert.equal(relaySettingsResponse.status, 200, relaySettingsText);
    assert.equal(relaySettings.modelStartup.source, 'relay');
    assert.equal(relaySettings.modelStartup.effective.model, 'MiniMax-M3');
    assert.equal(relaySettings.modelStartup.custom.configured, true);
    assert.equal(relaySettings.modelStartup.custom.model, 'gpt-custom-original');
    assert.equal(relayModelField.value, 'gpt-custom-original');
    assert.equal(relaySettingsText.includes('sk-custom-original'), false);
    assert.equal(relaySettingsText.includes('sk-relay-only'), false);

    const autoSaveResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activateConnector: false,
        modelProfileSource: 'custom',
        settings: {
          'model.provider': 'openai',
          'model.openaiApiMode': 'responses',
          'model.apiBase': 'https://custom.example.test/v1',
          'model.model': 'gpt-custom-draft',
          'model.contextWindowTokens': '512000',
          'model.reasoningEffort': 'high',
          'model.apiKey': { action: 'keep' },
        },
      }),
    });
    const autoSaveText = await autoSaveResponse.text();
    const activeAfterAutoSave = new FileBotDefinitionRepository({ runtimeRoot: testRoot }).readCache('profile-isolation-bot');

    assert.equal(autoSaveResponse.status, 200, autoSaveText);
    assert.equal(activeAfterAutoSave?.model.kind, 'catalog');
    if (activeAfterAutoSave?.model.kind === 'catalog') {
      assert.equal(activeAfterAutoSave.model.modelId, 'minimax-m3');
    }

    const savedSettingsResponse = await fetch(`${baseUrl}/api/settings`);
    const savedSettingsText = await savedSettingsResponse.text();
    const savedSettings = JSON.parse(savedSettingsText) as any;
    assert.equal(savedSettings.modelStartup.source, 'relay');
    assert.equal(savedSettings.modelStartup.effective.model, 'MiniMax-M3');
    assert.equal(savedSettings.modelStartup.custom.model, 'gpt-custom-draft');
    assert.equal(savedSettings.modelStartup.custom.contextWindowTokens, 512_000);

    const applyResponse = await fetch(`${baseUrl}/api/model-source/custom/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activateConnector: false }),
    });
    const applyText = await applyResponse.text();
    const activeAfterApply = new FileBotDefinitionRepository({ runtimeRoot: testRoot }).readCache('profile-isolation-bot');

    assert.equal(applyResponse.status, 200, applyText);
    assert.equal(activeAfterApply?.model.kind, 'custom');
    if (activeAfterApply?.model.kind === 'custom') {
      assert.equal(activeAfterApply.model.model, 'gpt-custom-draft');
      assert.equal(activeAfterApply.model.apiKey, 'sk-custom-original');
      assert.notEqual(activeAfterApply.model.apiKey, 'sk-relay-only');
    }
    assert.equal(applyText.includes('sk-custom-original'), false);
    assert.equal(applyText.includes('sk-relay-only'), false);
  });

  test('PUT /settings uses the explicit runtime data root for bound bot state and Definition storage', async () => {
    const runtimeRoot = path.join(testRoot, 'electron-user-data');
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    createCatsCoLocalConfigService({ runtimeRoot }).save({
      version: 1,
      currentBot: {
        uid: 'runtime-root-bot',
        apiKey: 'catsco-bot-api-key',
        boundByUserUid: 'user-definition-test',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-definition-test',
        bodyId: 'body-definition-test',
        installationId: 'install-definition-test',
      },
    });

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.provider': 'openai',
          'model.apiBase': 'https://model.example.test/v1',
          'model.model': 'gpt-runtime-root',
          'model.contextWindowTokens': '256000',
          'model.apiKey': { action: 'replace', value: 'sk-runtime-root-secret' },
        },
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const definitionPath = path.join(
      runtimeRoot,
      'data',
      'bot-definition-cache',
      'bots',
      'runtime-root-bot.json',
    );
    const runtimeEnv = dotenv.parse(fs.readFileSync(path.join(runtimeRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(data.botDefinitionSync?.botId, 'runtime-root-bot');
    assert.equal(JSON.parse(fs.readFileSync(definitionPath, 'utf-8')).model.model, 'gpt-runtime-root');
    assert.equal(runtimeEnv.CATSCO_CUSTOM_LLM_MODEL, undefined);
    assert.equal(runtimeEnv.GAUZ_LLM_MODEL, undefined);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
    assert.equal(text.includes('sk-runtime-root-secret'), false);
  });

  test('PUT /model/reasoning-effort updates a bound custom Definition without changing legacy env', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: {
        uid: 'bound-reasoning-test',
        apiKey: 'catsco-bot-api-key',
        boundByUserUid: 'user-definition-test',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-definition-test',
        bodyId: 'body-definition-test',
        installationId: 'install-definition-test',
      },
    });
    createBotDefinitionSyncService({ runtimeRoot: testRoot }).publish('bound-reasoning-test', {
      kind: 'custom',
      protocol: 'openai-chat-completions',
      apiBase: 'https://model.example.test/v1',
      model: 'gpt-portable',
      apiKey: 'sk-portable-secret',
      contextWindowTokens: 256_000,
      reasoningEffort: 'default',
    });
    fs.writeFileSync(path.join(testRoot, '.env'), 'GAUZ_LLM_REASONING_EFFORT=max\n');

    const response = await fetch(`${baseUrl}/api/model/reasoning-effort`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: 'high' }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const definitionPath = path.join(
      testRoot,
      'data',
      'bot-definition-cache',
      'bots',
      'bound-reasoning-test.json',
    );
    const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf-8')) as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(data.source, 'custom');
    assert.equal(data.previousReasoningEffort, 'default');
    assert.equal(data.reasoningEffort, 'high');
    assert.equal(definition.model.reasoningEffort, 'high');
    assert.equal(env.GAUZ_LLM_REASONING_EFFORT, undefined);
    assert.equal(data.botDefinitionSync.direction, 'local_to_simulated_cloud');
  });

  test('PUT /model/reasoning-effort updates the active relay source without touching custom startup', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_MODEL_SOURCE=relay',
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'GAUZ_LLM_API_KEY=sk-bf-relay-secret',
      'GAUZ_LLM_MODEL=deepseek-v4-flash',
      'GAUZ_LLM_REASONING_EFFORT=high',
      'CATSCO_RELAY_LLM_PROVIDER=anthropic',
      'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'CATSCO_RELAY_LLM_API_KEY=sk-bf-relay-secret',
      'CATSCO_RELAY_LLM_MODEL=deepseek-v4-flash',
      'CATSCO_RELAY_LLM_REASONING_EFFORT=high',
      'CATSCO_CUSTOM_LLM_PROVIDER=openai',
      'CATSCO_CUSTOM_LLM_API_BASE=https://api.deepseek.com/v1',
      'CATSCO_CUSTOM_LLM_API_KEY=sk-custom-secret',
      'CATSCO_CUSTOM_LLM_MODEL=deepseek-chat',
      'CATSCO_CUSTOM_LLM_REASONING_EFFORT=max',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/model/reasoning-effort`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: 'disabled' }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(data.ok, true);
    assert.equal(data.source, 'relay');
    assert.equal(data.previousReasoningEffort, 'high');
    assert.equal(data.reasoningEffort, 'disabled');
    assert.equal(parsed.GAUZ_LLM_REASONING_EFFORT, 'disabled');
    assert.equal(parsed.CATSCO_RELAY_LLM_REASONING_EFFORT, 'disabled');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_REASONING_EFFORT, 'max');
  });

  test('PUT /model/reasoning-effort respects custom source even when custom API base is relay gateway', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_MODEL_SOURCE=custom',
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/v1',
      'GAUZ_LLM_API_KEY=sk-custom-via-relay',
      'GAUZ_LLM_MODEL=deepseek-v4-flash',
      'GAUZ_LLM_REASONING_EFFORT=high',
      'CATSCO_CUSTOM_LLM_PROVIDER=openai',
      'CATSCO_CUSTOM_LLM_API_BASE=https://relay.catsco.cc/v1',
      'CATSCO_CUSTOM_LLM_API_KEY=sk-custom-via-relay',
      'CATSCO_CUSTOM_LLM_MODEL=deepseek-v4-flash',
      'CATSCO_CUSTOM_LLM_REASONING_EFFORT=high',
      'CATSCO_RELAY_LLM_PROVIDER=anthropic',
      'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'CATSCO_RELAY_LLM_API_KEY=sk-bf-relay-secret',
      'CATSCO_RELAY_LLM_MODEL=MiniMax-M2.7',
      'CATSCO_RELAY_LLM_REASONING_EFFORT=max',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/model/reasoning-effort`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: 'disabled' }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(data.ok, true);
    assert.equal(data.source, 'custom');
    assert.equal(data.previousReasoningEffort, 'high');
    assert.equal(data.reasoningEffort, 'disabled');
    assert.equal(parsed.GAUZ_LLM_REASONING_EFFORT, 'disabled');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_REASONING_EFFORT, 'disabled');
    assert.equal(parsed.CATSCO_RELAY_LLM_REASONING_EFFORT, 'max');
  });

  test('custom startup settings stay separate from relay startup and can be reactivated', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_MODEL_SOURCE=relay',
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'GAUZ_LLM_API_KEY=sk-bf-relay-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7',
      'CATSCO_RELAY_LLM_PROVIDER=anthropic',
      'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'CATSCO_RELAY_LLM_API_KEY=sk-bf-relay-secret',
      'CATSCO_RELAY_LLM_MODEL=MiniMax-M2.7',
      'CATSCO_CUSTOM_LLM_PROVIDER=openai',
      'CATSCO_CUSTOM_LLM_API_BASE=https://api.deepseek.com/v1',
      'CATSCO_CUSTOM_LLM_API_KEY=sk-custom-secret',
      'CATSCO_CUSTOM_LLM_MODEL=deepseek-chat',
      '',
    ].join('\n'));

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    const settingsText = await settingsResponse.text();
    const settings = JSON.parse(settingsText) as any;
    const apiBase = settings.fields.find((field: any) => field.id === 'model.apiBase');
    const apiKey = settings.fields.find((field: any) => field.id === 'model.apiKey');

    assert.equal(settingsResponse.status, 200, settingsText);
    assert.equal(settings.modelStartup.source, 'relay');
    assert.equal(settings.modelStartup.relay.configured, true);
    assert.equal(settings.modelStartup.custom.configured, true);
    assert.equal(apiBase.value, 'https://api.deepseek.com/v1');
    assert.equal(apiKey.present, true);
    assert.equal(settingsText.includes('sk-bf-relay-secret'), false);
    assert.equal(settingsText.includes('sk-custom-secret'), false);

    const applyResponse = await fetch(`${baseUrl}/api/model-source/custom/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activateConnector: true }),
    });
    const applyText = await applyResponse.text();
    const applyData = JSON.parse(applyText) as any;
    const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(applyResponse.status, 200, applyText);
    assert.equal(applyData.ok, true);
    assert.equal(applyData.source, 'custom');
    assert.equal(applyData.model, 'deepseek-chat');
    assert.equal(applyText.includes('sk-custom-secret'), false);
    assert.equal(parsed.CATSCO_MODEL_SOURCE, 'custom');
    assert.equal(parsed.GAUZ_LLM_PROVIDER, 'openai');
    assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://api.deepseek.com/v1');
    assert.equal(parsed.GAUZ_LLM_MODEL, 'deepseek-chat');
    assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-custom-secret');
    assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '128000');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS, '128000');
    assert.equal(parsed.CATSCO_RELAY_LLM_API_KEY, 'sk-bf-relay-secret');
    assert.equal(parsed.CATSCO_RELAY_LLM_MODEL, 'MiniMax-M2.7');
  });

  test('custom startup source is preserved when it uses a relay gateway endpoint', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_MODEL_SOURCE=custom',
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/v1',
      'GAUZ_LLM_API_KEY=sk-custom-relay-secret',
      'GAUZ_LLM_MODEL=MiniMax-M3',
      'CATSCO_CUSTOM_LLM_PROVIDER=openai',
      'CATSCO_CUSTOM_LLM_API_BASE=https://relay.catsco.cc/v1',
      'CATSCO_CUSTOM_LLM_API_KEY=sk-custom-relay-secret',
      'CATSCO_CUSTOM_LLM_MODEL=MiniMax-M3',
      'CATSCO_RELAY_LLM_PROVIDER=anthropic',
      'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'CATSCO_RELAY_LLM_API_KEY=sk-bf-relay-secret',
      'CATSCO_RELAY_LLM_MODEL=MiniMax-M3',
      '',
    ].join('\n'));

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    const settingsText = await settingsResponse.text();
    const settings = JSON.parse(settingsText) as any;

    assert.equal(settingsResponse.status, 200, settingsText);
    assert.equal(settings.modelStartup.source, 'custom');
    assert.equal(settings.modelStartup.custom.configured, true);
    assert.equal(settings.modelStartup.custom.model, 'MiniMax-M3');
    assert.equal(settings.modelStartup.custom.apiBase, 'https://relay.catsco.cc/v1');
    assert.equal(settings.modelStartup.relay.configured, true);
    assert.equal(settingsText.includes('sk-custom-relay-secret'), false);
    assert.equal(settingsText.includes('sk-bf-relay-secret'), false);
  });

  test('POST /model-source/custom/apply does not echo unsafe custom API base details', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_CUSTOM_LLM_PROVIDER=openai',
      'CATSCO_CUSTOM_LLM_API_BASE=https://user:pass@api.deepseek.com/v1?token=secret#frag',
      'CATSCO_CUSTOM_LLM_API_KEY=sk-custom-secret',
      'CATSCO_CUSTOM_LLM_MODEL=deepseek-chat',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/model-source/custom/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activateConnector: false }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;

    assert.equal(response.status, 200, text);
    assert.equal(data.apiBase, 'https://api.deepseek.com/v1');
    assert.equal(text.includes('user:pass'), false);
    assert.equal(text.includes('token=secret'), false);
    assert.equal(text.includes('sk-custom-secret'), false);
  });

  test('saving custom settings with keep does not copy the relay key into custom startup', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_MODEL_SOURCE=relay',
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'GAUZ_LLM_API_KEY=sk-bf-relay-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7',
      'CATSCO_RELAY_LLM_PROVIDER=anthropic',
      'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'CATSCO_RELAY_LLM_API_KEY=sk-bf-relay-secret',
      'CATSCO_RELAY_LLM_MODEL=MiniMax-M2.7',
      'CATSCO_CUSTOM_LLM_PROVIDER=openai',
      'CATSCO_CUSTOM_LLM_API_BASE=https://api.deepseek.com/v1',
      'CATSCO_CUSTOM_LLM_API_KEY=sk-custom-secret',
      'CATSCO_CUSTOM_LLM_MODEL=deepseek-chat',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.provider': 'openai',
          'model.openaiApiMode': 'responses',
          'model.apiBase': 'https://api.deepseek.com/v1',
          'model.model': 'deepseek-chat-v2',
          'model.contextWindowTokens': '512000',
          'model.apiKey': { action: 'keep' },
        },
      }),
    });
    const text = await response.text();
    const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(parsed.CATSCO_MODEL_SOURCE, 'custom');
    assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-custom-secret');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_API_KEY, 'sk-custom-secret');
    assert.equal(parsed.CATSCO_RELAY_LLM_API_KEY, 'sk-bf-relay-secret');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_MODEL, 'deepseek-chat-v2');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_OPENAI_API_MODE, 'responses');
    assert.equal(parsed.GAUZ_LLM_OPENAI_API_MODE, 'responses');
    assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '512000');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS, '512000');
  });

  test('saving incomplete custom settings keeps active relay startup intact', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_MODEL_SOURCE=relay',
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'GAUZ_LLM_API_KEY=sk-bf-relay-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7',
      'CATSCO_RELAY_LLM_PROVIDER=anthropic',
      'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'CATSCO_RELAY_LLM_API_KEY=sk-bf-relay-secret',
      'CATSCO_RELAY_LLM_MODEL=MiniMax-M2.7',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.provider': 'openai',
          'model.apiBase': 'https://api.deepseek.com/v1',
          'model.model': 'deepseek-chat',
          'model.apiKey': { action: 'keep' },
        },
      }),
    });
    const text = await response.text();
    const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(parsed.CATSCO_MODEL_SOURCE, 'relay');
    assert.equal(parsed.GAUZ_LLM_PROVIDER, 'anthropic');
    assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
    assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M2.7');
    assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-relay-secret');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_PROVIDER, 'openai');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_API_BASE, 'https://api.deepseek.com/v1');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_MODEL, 'deepseek-chat');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_API_KEY, undefined);
  });

  test('PUT /settings supports secret keep and clear without round-tripping value', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'GAUZ_LLM_API_KEY=sk-existing-secret',
      '',
    ].join('\n'));
    process.env.GAUZ_LLM_API_KEY = 'sk-existing-secret';

    const keepResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.apiKey': { action: 'keep' },
        },
      }),
    });
    const keepData = await keepResponse.json() as any;
    assert.equal(keepResponse.status, 200);
    assert.deepStrictEqual(keepData.kept, ['model.apiKey']);
    assert.equal(dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8')).GAUZ_LLM_API_KEY, 'sk-existing-secret');

    const clearResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.apiKey': { action: 'clear' },
        },
      }),
    });
    const clearData = await clearResponse.json() as any;
    assert.equal(clearResponse.status, 200);
    assert.deepStrictEqual(clearData.cleared, ['GAUZ_LLM_API_KEY']);
    assert.equal(dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8')).GAUZ_LLM_API_KEY, undefined);
    assert.equal(process.env.GAUZ_LLM_API_KEY, undefined);
  });

  test('PUT /settings rejects unknown settings and newline injection', async () => {
    const unknownResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'raw.env': 'SHOULD_NOT_WRITE',
        },
      }),
    });
    const unknown = await unknownResponse.json() as any;
    assert.equal(unknownResponse.status, 400);
    assert.match(unknown.error, /Unknown dashboard setting/);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);

    const newlineResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.model': 'safe-model\nEVIL=1',
        },
      }),
    });
    const newline = await newlineResponse.json() as any;
    assert.equal(newlineResponse.status, 400);
    assert.match(newline.error, /must not contain newlines/);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);

    const unsafeUrlResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.apiBase': 'https://user:pass@model.example.test/v1/messages?token=secret',
        },
      }),
    });
    const unsafeUrl = await unsafeUrlResponse.json() as any;
    assert.equal(unsafeUrlResponse.status, 400);
    assert.match(unsafeUrl.error, /must not include credentials, query, or fragment/);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);

    const invalidContextResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.contextWindowTokens': '999999',
        },
      }),
    });
    const invalidContext = await invalidContextResponse.json() as any;
    assert.equal(invalidContextResponse.status, 400);
    assert.match(invalidContext.error, /model\.contextWindowTokens must be one of/);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
  });

  test('legacy /config masks sensitive values and rejects unsafe writes', async () => {
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'WEIXIN_TOKEN=wx-secret-token',
      'EXTERNAL_API_KEY=external-secret',
      'DATABASE_URL=postgres://user:pass@localhost:5432/app',
      'SENTRY_DSN=https://token@example.ingest.sentry.io/123',
      '',
    ].join('\n'));

    const configResponse = await fetch(`${baseUrl}/api/config`);
    const configText = await configResponse.text();
    const config = JSON.parse(configText) as any;
    assert.equal(config.WEIXIN_TOKEN, '****oken');
    assert.equal(config.EXTERNAL_API_KEY, '****cret');
    assert.equal(config.DATABASE_URL, '****/app');
    assert.equal(config.SENTRY_DSN, '****/123');
    assert.equal(configText.includes('wx-secret-token'), false);
    assert.equal(configText.includes('external-secret'), false);
    assert.equal(configText.includes('user:pass'), false);
    assert.equal(configText.includes('token@example'), false);

    const unsafeKeyResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ UNLISTED_KEY: 'value' }),
    });
    assert.equal(unsafeKeyResponse.status, 400);

    const newlineResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ GAUZ_LLM_MODEL: 'model\nINJECTED=1' }),
    });
    assert.equal(newlineResponse.status, 400);
    assert.equal(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8').includes('INJECTED=1'), false);

    const backupWriteResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ GAUZ_LLM_BACKUP_API_KEY: 'new-backup-secret' }),
    });
    const backupWrite = await backupWriteResponse.json() as any;
    assert.equal(backupWriteResponse.status, 400);
    assert.match(backupWrite.error, /Unknown config key/);
    assert.equal(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8').includes('new-backup-secret'), false);

    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_MODEL_SOURCE=relay',
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_API_BASE=https://api.deepseek.com/v1',
      'GAUZ_LLM_API_KEY=sk-custom-secret',
      'GAUZ_LLM_MODEL=deepseek-chat',
      'CATSCO_RELAY_LLM_PROVIDER=anthropic',
      'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'CATSCO_RELAY_LLM_API_KEY=sk-bf-relay-secret',
      'CATSCO_RELAY_LLM_MODEL=MiniMax-M2.7',
      '',
    ].join('\n'));
    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    const settingsText = await settingsResponse.text();
    const settings = JSON.parse(settingsText) as any;
    assert.equal(settingsResponse.status, 200, settingsText);
    assert.equal(settings.modelStartup.source, 'custom');
  });

  test('POST /cats/relay/model-config/apply creates a relay key and writes Anthropic settings', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCount = 0;

    catsApp.get('/api/relay/config', (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer user-token');
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'OpenAI-compatible', base_url: 'https://relay.catsco.cc/v1' },
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: true });
    });
    catsApp.post('/api/relay/key', (req, res) => {
      createCount += 1;
      assert.equal(req.body.name, 'CatsCo user 38');
      res.json({
        configured: true,
        key: {
          id: 'vk-test',
          name: req.body.name,
          prefix: 'sk-bf-d0',
          state: 'active',
          key: 'sk-bf-secret-created-once',
          api_key: 'sk-bf-secondary-secret',
          secret: 'relay-secret-value',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'evil-token-ignored',
          httpBaseUrl: 'http://127.0.0.1:1',
        }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.ok, true);
      assert.equal(data.provider, 'anthropic');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/anthropic');
      assert.equal(data.model, 'MiniMax-M3');
      assert.equal(data.createdKey, true);
      assert.equal(data.key.key, undefined);
      assert.equal(data.key.api_key, undefined);
      assert.equal(data.key.secret, undefined);
      assert.equal(text.includes('sk-bf-secret-created-once'), false);
      assert.equal(text.includes('sk-bf-secondary-secret'), false);
      assert.equal(text.includes('relay-secret-value'), false);
      assert.equal(createCount, 1);
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'anthropic');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M3');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-secret-created-once');
      assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '1000000');
      assert.equal(parsed.GAUZ_LLM_REASONING_EFFORT, 'high');
      assert.equal(parsed.CATSCO_MODEL_SOURCE, 'relay');
      assert.equal(parsed.CATSCO_RELAY_LLM_PROVIDER, 'anthropic');
      assert.equal(parsed.CATSCO_RELAY_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(parsed.CATSCO_RELAY_LLM_MODEL, 'MiniMax-M3');
      assert.equal(parsed.CATSCO_RELAY_LLM_API_KEY, 'sk-bf-secret-created-once');
      assert.equal(parsed.CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS, '1000000');
      assert.equal(parsed.CATSCO_RELAY_LLM_REASONING_EFFORT, 'high');
      assert.equal(process.env.GAUZ_LLM_PROVIDER, 'anthropic');

      const customResponse = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            'model.provider': 'openai',
            'model.apiBase': 'https://api.deepseek.com/v1',
            'model.model': 'deepseek-chat',
            'model.apiKey': { action: 'replace', value: 'sk-custom-model-key' },
          },
        }),
      });
      assert.equal(customResponse.status, 200);
      const switched = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));
      assert.equal(switched.GAUZ_LLM_PROVIDER, 'openai');
      assert.equal(switched.GAUZ_LLM_API_BASE, 'https://api.deepseek.com/v1');
      assert.equal(switched.GAUZ_LLM_MODEL, 'deepseek-chat');
      assert.equal(switched.GAUZ_LLM_API_KEY, 'sk-custom-model-key');
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply writes selected relay model with CatsCo Anthropic settings', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer user-token');
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'OpenAI-compatible', base_url: 'https://relay.catsco.cc/v1' },
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'minimax-m2.7',
            label: 'MiniMax M2.7',
            model: 'MiniMax-M2.7',
            provider: 'anthropic',
            protocol: 'Anthropic-compatible',
            base_url: 'https://relay.catsco.cc/anthropic',
            enabled: true,
            default: true,
          },
          {
            id: 'deepseek-v4-flash',
            label: 'DeepSeek V4 Flash',
            model: 'DeepSeek-V4-Flash',
            provider: 'openai',
            protocol: 'OpenAI-compatible',
            base_url: 'https://relay.catsco.cc/v1',
            enabled: true,
            quota_class: 'flash-low',
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: false });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      res.json({
        key: {
          id: 'vk-openai',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-o1',
          state: 'active',
          key: 'sk-bf-openai-compatible',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'deepseek-v4-flash', reasoningEffort: 'max' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      assert.equal(response.status, 200, text);
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(data.provider, 'openai');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/v1');
      assert.equal(data.model, 'deepseek-v4-flash');
      assert.equal(data.reasoningEffort, 'max');
      assert.equal(data.selectedModel.id, 'deepseek-v4-flash');
      assert.equal(data.selectedModel.base_url, 'https://relay.catsco.cc/v1');
      assert.equal(data.selectedModel.sdk_label, 'OpenAI SDK');
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'openai');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/v1');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'deepseek-v4-flash');
      assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '1000000');
      assert.equal(parsed.GAUZ_LLM_REASONING_EFFORT, 'max');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-openai-compatible');
      assert.equal(parsed.CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS, '1000000');
      assert.equal(parsed.CATSCO_RELAY_LLM_REASONING_EFFORT, 'max');
      assert.equal(parsed.CATSCO_RELAY_LLM_VISION_CAPABLE, 'false');
      assert.equal(parsed.CATSCO_RELAY_LLM_TOOL_CALLING_CAPABLE, 'true');
      assert.equal(data.selectedModel.context_window_tokens, 1000000);
      assert.equal(data.selectedModel.context_label, '1M');
      assert.equal(data.selectedModel.capabilities.vision, false);
      assert.equal(data.selectedModel.capabilities.tool_calling, true);
      assert.equal(text.includes('sk-bf-openai-compatible'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply rejects internal GLM ids from the public relay catalog', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCalled = false;
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'glm-5.1',
            label: 'GLM 5.1',
            model: 'glm-5.1',
            provider: 'anthropic',
            enabled: true,
            default: true,
          },
          {
            id: 'zhipu-5.1',
            label: 'GLM 5.1',
            model: 'zhipu-5.1',
            provider: 'anthropic',
            enabled: true,
          },
          {
            id: 'minimax-m2.7',
            label: 'MiniMax M2.7',
            model: 'MiniMax-M2.7',
            provider: 'anthropic',
            enabled: true,
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: false });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.json({
        key: {
          id: 'vk-internal',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-in',
          state: 'active',
          key: 'sk-bf-internal-secret',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const catalogResponse = await fetch(`${baseUrl}/api/cats/relay/model-config`);
      const catalogText = await catalogResponse.text();
      const catalogData = JSON.parse(catalogText) as any;
      assert.equal(catalogResponse.status, 200, catalogText);
      assert.deepStrictEqual(
        catalogData.models.map((model: any) => model.id),
        ['minimax-m2.7'],
      );
      assert.equal(catalogText.includes('GLM 5.1'), false);
      assert.equal(catalogText.includes('zhipu-5.1'), false);

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'glm-5.1' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      assert.equal(response.status, 400, text);
      assert.match(data.error, /未知 CatsCo 中转模型/);
      assert.equal(createCalled, false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply normalizes known relay model aliases before writing startup config', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'minimax-m3',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'minimax-m3',
            label: 'MiniMax M3',
            model: 'minimax-m3',
            enabled: true,
            default: true,
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: false });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      res.json({
        key: {
          id: 'vk-m3',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-m3',
          state: 'active',
          key: 'sk-bf-m3-secret',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'minimax-m3' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      assert.equal(response.status, 200, text);
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(data.model, 'MiniMax-M3');
      assert.equal(data.selectedModel.model, 'MiniMax-M3');
      assert.equal(data.selectedModel.id, 'minimax-m3');
      assert.equal(data.selectedModel.capabilities.vision, true);
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M3');
      assert.equal(parsed.CATSCO_RELAY_LLM_MODEL, 'MiniMax-M3');
      assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '1000000');
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply locks known model catalog entries to their relay profile endpoint', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'deepseek-v4-flash',
            label: 'DeepSeek V4 Flash',
            model: 'deepseek-v4-flash',
            provider: 'openai',
            base_url: 'https://wrong.example.test/anthropic',
            enabled: true,
            default: true,
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: false });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      res.json({
        key: {
          id: 'vk-deepseek',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-ds',
          state: 'active',
          key: 'sk-bf-deepseek-secret',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'deepseek-v4-flash' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.apiBase, 'https://relay.catsco.cc/v1');
      assert.equal(data.selectedModel.base_url, 'https://relay.catsco.cc/v1');
      assert.equal(data.selectedModel.sdk_label, 'OpenAI SDK');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/v1');
      assert.equal(text.includes('wrong.example.test'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply defaults a fresh setup to MiniMax M3', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'claude-3-5-haiku-20241007',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: false });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      res.json({
        key: {
          id: 'vk-minimax',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-mm',
          state: 'active',
          key: 'sk-bf-minimax-secret',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.model, 'MiniMax-M3');
      assert.equal(data.selectedModel.id, 'minimax-m3');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M3');
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply starts a stopped connector when activation is requested', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'minimax-m3',
            label: 'MiniMax M3',
            model: 'MiniMax-M3',
            provider: 'anthropic',
            enabled: true,
            default: true,
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: false });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      res.json({
        key: {
          id: 'vk-minimax',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-mx',
          state: 'active',
          key: 'sk-bf-minimax-secret',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const catsAddress = catsServer.address();
    if (!catsAddress || typeof catsAddress === 'string') throw new Error('cats server did not bind');

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'stopped',
    };
    let startCalled = 0;
    let restartCalled = 0;
    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      start: (name: string) => {
        assert.equal(name, 'catscompany');
        startCalled += 1;
        service.status = 'running';
        return service;
      },
      restart: (name: string) => {
        assert.equal(name, 'catscompany');
        restartCalled += 1;
        return service;
      },
    } as any));
    const dashboardServer = await listen(dashboardApp);
    const dashboardAddress = dashboardServer.address();
    if (!dashboardAddress || typeof dashboardAddress === 'string') throw new Error('dashboard server did not bind');
    const dashboardBaseUrl = `http://127.0.0.1:${dashboardAddress.port}`;

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_BOT_UID = '110';
      process.env.CATSCO_API_KEY = 'cats_svc_test';
      process.env.CATSCO_SERVER_URL = 'wss://app.catsco.cc/v0/channels';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${catsAddress.port}`;
      createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
        version: 1,
        endpoints: {
          httpBaseUrl: `http://127.0.0.1:${catsAddress.port}`,
          serverUrl: 'wss://app.catsco.cc/v0/channels',
        },
        account: {
          token: 'user-token',
          uid: '38',
        },
        currentBot: {
          uid: '110',
          name: 'CatsCo',
          username: 'catsco_38',
          apiKey: 'cats_svc_test',
          boundByUserUid: '38',
          bindingSource: 'test',
        },
        device: {
          deviceId: 'body-settings',
          bodyId: 'body-settings',
          installationId: 'body-settings',
        },
      });

      const response = await fetch(`${dashboardBaseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'minimax-m3', activateConnector: true }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot: testRoot }).read('110');

      assert.equal(response.status, 200, text);
      assert.equal(data.model, 'MiniMax-M3');
      assert.equal(data.connectorStarted, true);
      assert.equal(data.connectorRestarted, false);
      assert.equal(data.connectorStartBlocked, false);
      assert.match(data.message, /已启动 CatsCompany connector/);
      assert.equal(startCalled, 1);
      assert.equal(restartCalled, 0);
      assert.equal(runtime?.modelId, 'minimax-m3');
      assert.equal(runtime?.model, 'MiniMax-M3');
      assert.equal(text.includes('sk-bf-minimax-secret'), false);
    } finally {
      await new Promise<void>(resolve => dashboardServer.close(() => resolve()));
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply rejects unknown relay model ids before key changes', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCalled = false;
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
      });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.status(500).json({ error: 'create should not be called' });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'not-a-real-relay-model' }),
      });
      const data = await response.json() as any;

      assert.equal(response.status, 400);
      assert.match(data.error, /未知 CatsCo 中转模型/);
      assert.equal(createCalled, false);
      assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply respects an explicitly disabled model catalog', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCalled = false;
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: '',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
        models: [
          {
            id: 'minimax-m2.7',
            model: 'MiniMax-M2.7',
            provider: 'anthropic',
            enabled: false,
          },
        ],
      });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.status(500).json({ error: 'create should not be called' });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'minimax-m2.7' }),
      });
      const data = await response.json() as any;

      assert.equal(response.status, 503);
      assert.match(data.error, /暂未提供可用模型/);
      assert.equal(createCalled, false);
      assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('GET /cats/relay/model-config reflects the current selected relay model', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer user-token');
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'minimax-m2.7',
            label: 'MiniMax M2.7',
            model: 'MiniMax-M2.7',
            provider: 'anthropic',
            base_url: 'https://relay.catsco.cc/anthropic',
            enabled: true,
            default: true,
          },
          {
            id: 'deepseek-v4-flash',
            label: 'DeepSeek V4 Flash',
            model: 'DeepSeek-V4-Flash',
            provider: 'anthropic',
            base_url: 'https://relay.catsco.cc/anthropic',
            enabled: true,
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        key: {
          id: 'vk-existing',
          prefix: 'sk-bf-old...cret',
          state: 'active',
          key: 'sk-bf-should-not-leak',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      fs.writeFileSync(path.join(testRoot, '.env'), [
        'GAUZ_LLM_PROVIDER=anthropic',
        'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
        'GAUZ_LLM_API_KEY=sk-bf-old-local-secret',
        'GAUZ_LLM_MODEL=deepseek-v4-flash',
        '',
      ].join('\n'));
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config`);
      const text = await response.text();
      const data = JSON.parse(text) as any;

      assert.equal(response.status, 200, text);
      assert.equal(data.provider, 'anthropic');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/anthropic');
      assert.equal(data.model, 'deepseek-v4-flash');
      assert.equal(data.selectedModel.id, 'deepseek-v4-flash');
      assert.equal(data.selectedModel.sdk_label, 'Anthropic SDK');
      assert.equal(data.reasoningEffort, 'high');
      assert.equal(data.configured, true);
      assert.equal(data.key.prefix, 'sk-bf-old...cret');
      assert.equal(text.includes('sk-bf-should-not-leak'), false);
      assert.equal(text.includes('sk-bf-old-local-secret'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('GET /cats/relay/model-config preserves partial unknown relay capabilities', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'custom-vision',
        self_service_enabled: false,
        endpoints: [
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'custom-vision',
            label: 'Custom Vision',
            model: 'custom-vision',
            enabled: true,
            default: true,
            capabilities: {
              vision: 'true',
              streaming: 0,
            },
          },
        ],
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config?modelId=custom-vision`);
      const text = await response.text();
      const data = JSON.parse(text) as any;

      assert.equal(response.status, 200, text);
      assert.deepStrictEqual(data.selectedModel.capabilities, {
        vision: true,
        streaming: false,
      });
      assert.equal('tool_calling' in data.selectedModel.capabilities, false);
      assert.deepStrictEqual(data.models[0].capabilities, data.selectedModel.capabilities);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('GET /cats/relay/model-config lets upstream capabilities override local relay profiles', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'minimax-m3',
        self_service_enabled: false,
        endpoints: [
          { protocol: 'OpenAI-compatible', base_url: 'https://relay.catsco.cc/v1' },
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'minimax-m3',
            label: 'MiniMax M3',
            model: 'MiniMax-M3',
            provider: 'openai',
            protocol: 'OpenAI-compatible',
            enabled: true,
            capabilities: {
              vision: false,
              tool_calling: false,
            },
          },
        ],
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config?modelId=minimax-m3`);
      const text = await response.text();
      const data = JSON.parse(text) as any;

      assert.equal(response.status, 200, text);
      assert.equal(data.selectedModel.provider, 'openai');
      assert.equal(data.selectedModel.base_url, 'https://relay.catsco.cc/v1');
      assert.equal(data.selectedModel.sdk_label, 'OpenAI SDK');
      assert.deepStrictEqual(data.selectedModel.capabilities, {
        tool_calling: false,
        vision: false,
        streaming: true,
      });
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply sanitizes upstream error payloads', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.status(500).json({
        error: 'upstream failure',
        key: 'sk-bf-should-not-leak',
        token: 'user-token-should-not-leak',
        reason: 'bad key sk-bf-should-not-leak in upstream message',
        raw: 'Authorization: ApiKey cats_svc_should_not_leak token=secret-value refresh_token=refresh-secret CATSCO_USER_TOKEN=user-secret client_secret=client-secret x_api_key=api-secret',
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'anthropic' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;

      assert.equal(response.status, 500);
      assert.equal(data.error, 'upstream failure');
      assert.deepStrictEqual(data.data, {
        error: 'upstream failure',
        reason: 'bad key [redacted-key] in upstream message',
        raw: 'Authorization: [redacted-token] token=[redacted-token] refresh_token=[redacted-token] CATSCO_USER_TOKEN=[redacted-token] client_secret=[redacted-token] x_api_key=[redacted-token]',
      });
      assert.equal(text.includes('sk-bf-should-not-leak'), false);
      assert.equal(text.includes('user-token-should-not-leak'), false);
      assert.equal(text.includes('cats_svc_should_not_leak'), false);
      assert.equal(text.includes('secret-value'), false);
      assert.equal(text.includes('refresh-secret'), false);
      assert.equal(text.includes('client-secret'), false);
      assert.equal(text.includes('api-secret'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply sanitizes relay key rotation errors', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-old...cret',
          state: 'active',
        },
      });
    });
    catsApp.post('/api/relay/key/rotate', (_req, res) => {
      res.status(409).json({
        error: 'Authorization: ApiKey cats_svc_rotate_should_not_leak refresh_token=rotate-secret',
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'anthropic', rotateExisting: true }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;

      assert.equal(response.status, 409);
      assert.equal(data.action, 'rotate_required');
      assert.equal(data.error, 'Authorization: [redacted-token] refresh_token=[redacted-token]');
      assert.equal(data.key.prefix, 'sk-bf-old...cret');
      assert.equal(text.includes('cats_svc_rotate_should_not_leak'), false);
      assert.equal(text.includes('rotate-secret'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply reuses local relay key when switching models', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCalled = false;
    let rotateCalled = false;

    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [
          { protocol: 'OpenAI-compatible', base_url: 'https://relay.catsco.cc/v1' },
          { protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' },
        ],
        models: [
          {
            id: 'minimax-m2.7',
            label: 'MiniMax M2.7',
            model: 'MiniMax-M2.7',
            provider: 'anthropic',
            protocol: 'Anthropic-compatible',
            base_url: 'https://relay.catsco.cc/anthropic',
            enabled: true,
            default: true,
          },
          {
            id: 'deepseek-v4-flash',
            label: 'DeepSeek V4 Flash',
            model: 'DeepSeek-V4-Flash',
            provider: 'anthropic',
            protocol: 'Anthropic-compatible',
            base_url: 'https://relay.catsco.cc/anthropic',
            enabled: true,
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-old...cret',
          state: 'active',
        },
      });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.status(500).json({ error: 'create should not be called' });
    });
    catsApp.post('/api/relay/key/rotate', (_req, res) => {
      rotateCalled = true;
      res.status(500).json({ error: 'rotate should not be called' });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      fs.writeFileSync(path.join(testRoot, '.env'), [
        'GAUZ_LLM_PROVIDER=anthropic',
        'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
        'GAUZ_LLM_API_KEY=sk-bf-old-local-secret',
        'GAUZ_LLM_MODEL=MiniMax-M2.7',
        '',
      ].join('\n'));
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'deepseek-v4-flash' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.provider, 'anthropic');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/anthropic');
      assert.equal(data.model, 'deepseek-v4-flash');
      assert.equal(data.createdKey, false);
      assert.equal(data.rotatedKey, false);
      assert.equal(data.key.prefix, 'sk-bf-old...cret');
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'anthropic');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'deepseek-v4-flash');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-old-local-secret');
      assert.equal(text.includes('sk-bf-old-local-secret'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply reveals existing relay key before prompting rotation', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let revealCalled = false;
    let createCalled = false;
    let rotateCalled = false;

    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: { id: 'vk-existing', name: 'existing', prefix: 'sk-bf-cu...cret', state: 'active' },
      });
    });
    catsApp.post('/api/relay/key/reveal', (_req, res) => {
      revealCalled = true;
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-cu...cret',
          state: 'active',
          key: 'sk-bf-current-secret',
        },
      });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.status(500).json({ error: 'create should not be called' });
    });
    catsApp.post('/api/relay/key/rotate', (_req, res) => {
      rotateCalled = true;
      res.status(500).json({ error: 'rotate should not be called' });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'minimax-m2.7' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.createdKey, false);
      assert.equal(data.rotatedKey, false);
      assert.equal(data.revealedKey, true);
      assert.equal(revealCalled, true);
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-current-secret');
      assert.equal(text.includes('sk-bf-current-secret'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply reuses stored relay key while custom startup is active', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCalled = false;
    let rotateCalled = false;

    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
        models: [
          {
            id: 'minimax-m2.7',
            label: 'MiniMax M2.7',
            model: 'MiniMax-M2.7',
            provider: 'anthropic',
            protocol: 'Anthropic-compatible',
            base_url: 'https://relay.catsco.cc/anthropic',
            enabled: true,
            default: true,
          },
        ],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-old...cret',
          state: 'active',
        },
      });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.status(500).json({ error: 'create should not be called' });
    });
    catsApp.post('/api/relay/key/rotate', (_req, res) => {
      rotateCalled = true;
      res.status(500).json({ error: 'rotate should not be called' });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      fs.writeFileSync(path.join(testRoot, '.env'), [
        'CATSCO_MODEL_SOURCE=custom',
        'GAUZ_LLM_PROVIDER=openai',
        'GAUZ_LLM_API_BASE=https://api.deepseek.com/v1',
        'GAUZ_LLM_API_KEY=sk-custom-secret',
        'GAUZ_LLM_MODEL=deepseek-chat',
        'CATSCO_CUSTOM_LLM_PROVIDER=openai',
        'CATSCO_CUSTOM_LLM_API_BASE=https://api.deepseek.com/v1',
        'CATSCO_CUSTOM_LLM_API_KEY=sk-custom-secret',
        'CATSCO_CUSTOM_LLM_MODEL=deepseek-chat',
        'CATSCO_RELAY_LLM_PROVIDER=anthropic',
        'CATSCO_RELAY_LLM_API_BASE=https://relay.catsco.cc/anthropic',
        'CATSCO_RELAY_LLM_API_KEY=sk-bf-old-local-secret',
        'CATSCO_RELAY_LLM_MODEL=MiniMax-M2.7',
        '',
      ].join('\n'));
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'minimax-m2.7' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.model, 'MiniMax-M2.7');
      assert.equal(data.createdKey, false);
      assert.equal(data.rotatedKey, false);
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.CATSCO_MODEL_SOURCE, 'relay');
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'anthropic');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M2.7');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-old-local-secret');
      assert.equal(parsed.CATSCO_RELAY_LLM_MODEL, 'MiniMax-M2.7');
      assert.equal(parsed.CATSCO_RELAY_LLM_API_KEY, 'sk-bf-old-local-secret');
      assert.equal(parsed.CATSCO_CUSTOM_LLM_MODEL, 'deepseek-chat');
      assert.equal(parsed.CATSCO_CUSTOM_LLM_API_KEY, 'sk-custom-secret');
      assert.equal(text.includes('sk-bf-old-local-secret'), false);
      assert.equal(text.includes('sk-custom-secret'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply rejects masked local relay keys', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCalled = false;
    let rotateCalled = false;

    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-old...cret',
          state: 'active',
        },
      });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.status(500).json({ error: 'create should not be called' });
    });
    catsApp.post('/api/relay/key/rotate', (_req, res) => {
      rotateCalled = true;
      res.status(500).json({ error: 'rotate should not be called' });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      fs.writeFileSync(path.join(testRoot, '.env'), [
        'GAUZ_LLM_PROVIDER=anthropic',
        'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
        'GAUZ_LLM_API_KEY=sk-bf-old...cret',
        'GAUZ_LLM_MODEL=MiniMax-M2.7',
        '',
      ].join('\n'));
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'anthropic' }),
      });
      const data = await response.json() as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 409);
      assert.equal(data.action, 'rotate_required');
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-old...cret');
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply requires a verifiable relay key prefix before reusing local key', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    let createCalled = false;
    let rotateCalled = false;

    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-old',
          state: 'active',
        },
      });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      createCalled = true;
      res.status(500).json({ error: 'create should not be called' });
    });
    catsApp.post('/api/relay/key/rotate', (_req, res) => {
      rotateCalled = true;
      res.status(500).json({ error: 'rotate should not be called' });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      fs.writeFileSync(path.join(testRoot, '.env'), [
        'GAUZ_LLM_PROVIDER=anthropic',
        'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
        'GAUZ_LLM_API_KEY=sk-bf-different-local-secret',
        'GAUZ_LLM_MODEL=MiniMax-M2.7',
        '',
      ].join('\n'));
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'anthropic' }),
      });
      const data = await response.json() as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 409);
      assert.equal(data.action, 'rotate_required');
      assert.equal(data.key.prefix, 'sk-bf-old');
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-different-local-secret');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply refuses to overwrite existing relay key without rotation', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-old',
          state: 'active',
        },
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'anthropic' }),
      });
      const data = await response.json() as any;

      assert.equal(response.status, 409);
      assert.equal(data.action, 'rotate_required');
      assert.equal(data.key.prefix, 'sk-bf-old');
      assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply explains upstream relay key rotation failures', async () => {
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => {
      res.json({
        base_url: 'https://relay.catsco.cc',
        default_model: 'MiniMax-M2.7',
        self_service_enabled: true,
        endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.catsco.cc/anthropic' }],
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({
        configured: true,
        key: {
          id: 'vk-existing',
          name: 'existing',
          prefix: 'sk-bf-old...cret',
          state: 'active',
        },
      });
    });
    catsApp.post('/api/relay/key/rotate', (_req, res) => {
      res.status(502).json({
        error: 'bifrost request failed',
        detail: 'upstream sk-bf-sensitive-secret failed',
      });
    });
    const catsServer = await listen(catsApp);
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');

    try {
      fs.writeFileSync(path.join(testRoot, '.env'), [
        'GAUZ_LLM_PROVIDER=anthropic',
        'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
        'GAUZ_LLM_API_KEY=sk-bf-different-local-secret',
        'GAUZ_LLM_MODEL=MiniMax-M2.7',
        '',
      ].join('\n'));
      process.env.CATSCO_USER_TOKEN = 'user-token';
      process.env.CATSCO_USER_UID = '38';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/api/cats/relay/model-config/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: 'anthropic', rotateExisting: true }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 502);
      assert.equal(data.action, 'relay_key_reset_required');
      assert.match(data.error, /CatsCo 中转 Key 重新生成失败/);
      assert.match(data.error, /bifrost request failed/);
      assert.match(data.error, /点击“撤销”删除当前 Key/);
      assert.match(data.error, /系统会自动创建并写入新的 Key/);
      assert.match(data.data.detail, /\[redacted-key\]/);
      assert.equal(text.includes('sk-bf-sensitive-secret'), false);
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-different-local-secret');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M2.7');
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

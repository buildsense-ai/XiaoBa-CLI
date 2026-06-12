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
    'CATSCO_MODEL_SOURCE',
    'CATSCO_CUSTOM_LLM_PROVIDER',
    'CATSCO_CUSTOM_LLM_API_BASE',
    'CATSCO_CUSTOM_LLM_API_KEY',
    'CATSCO_CUSTOM_LLM_MODEL',
    'CATSCO_CUSTOM_LLM_CONTEXT_WINDOW_TOKENS',
    'CATSCO_RELAY_LLM_PROVIDER',
    'CATSCO_RELAY_LLM_API_BASE',
    'CATSCO_RELAY_LLM_API_KEY',
    'CATSCO_RELAY_LLM_MODEL',
    'CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS',
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

  test('PUT /settings writes allowlisted model settings and refreshes process env', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'model.provider': 'anthropic',
          'model.apiBase': 'https://model.example.test/v1/messages',
          'model.model': 'MiniMax-M2.7-highspeed',
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
      'GAUZ_LLM_MODEL',
      'GAUZ_LLM_PROVIDER',
    ].sort());
    assert.equal(text.includes('sk-new-secret'), false);
    assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-new-secret');
    assert.equal(parsed.CATSCO_MODEL_SOURCE, 'custom');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_PROVIDER, 'anthropic');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_API_BASE, 'https://model.example.test/v1/messages');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_MODEL, 'MiniMax-M2.7-highspeed');
    assert.equal(parsed.CATSCO_CUSTOM_LLM_API_KEY, 'sk-new-secret');
    assert.equal(process.env.GAUZ_LLM_API_KEY, 'sk-new-secret');

    const statusResponse = await fetch(`${baseUrl}/api/status`);
    const status = await statusResponse.json() as any;
    assert.equal(status.provider, 'anthropic');
    assert.equal(status.model, 'MiniMax-M2.7-highspeed');
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
          'model.apiBase': 'https://api.deepseek.com/v1',
          'model.model': 'deepseek-chat-v2',
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
      assert.equal(data.model, 'MiniMax-M2.7');
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
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M2.7');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-secret-created-once');
      assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '204800');
      assert.equal(parsed.CATSCO_MODEL_SOURCE, 'relay');
      assert.equal(parsed.CATSCO_RELAY_LLM_PROVIDER, 'anthropic');
      assert.equal(parsed.CATSCO_RELAY_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(parsed.CATSCO_RELAY_LLM_MODEL, 'MiniMax-M2.7');
      assert.equal(parsed.CATSCO_RELAY_LLM_API_KEY, 'sk-bf-secret-created-once');
      assert.equal(parsed.CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS, '204800');
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
        body: JSON.stringify({ modelId: 'deepseek-v4-flash' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      assert.equal(response.status, 200, text);
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(data.provider, 'openai');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/v1');
      assert.equal(data.model, 'deepseek-v4-flash');
      assert.equal(data.selectedModel.id, 'deepseek-v4-flash');
      assert.equal(data.selectedModel.base_url, 'https://relay.catsco.cc/v1');
      assert.equal(data.selectedModel.sdk_label, 'OpenAI SDK');
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'openai');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/v1');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'deepseek-v4-flash');
      assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '1000000');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-openai-compatible');
      assert.equal(parsed.CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS, '1000000');
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

  test('POST /cats/relay/model-config/apply supports fallback GLM catalog for older CatsCompany config', async () => {
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
      });
    });
    catsApp.get('/api/relay/key', (_req, res) => {
      res.json({ configured: false });
    });
    catsApp.post('/api/relay/key', (_req, res) => {
      res.json({
        key: {
          id: 'vk-glm',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-gl',
          state: 'active',
          key: 'sk-bf-glm-secret',
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
        body: JSON.stringify({ modelId: 'glm-5.1' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      assert.equal(response.status, 200, text);
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(data.provider, 'anthropic');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/anthropic');
      assert.equal(data.model, 'glm-5.1');
      assert.equal(data.selectedModel.id, 'glm-5.1');
      assert.equal(data.selectedModel.sdk_label, 'Anthropic SDK');
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'anthropic');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'glm-5.1');
      assert.equal(parsed.GAUZ_LLM_CONTEXT_WINDOW_TOKENS, '200000');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-glm-secret');
      assert.equal(parsed.CATSCO_RELAY_LLM_CONTEXT_WINDOW_TOKENS, '200000');
      assert.equal(data.selectedModel.context_window_tokens, 200000);
      assert.equal(data.selectedModel.capabilities.vision, false);
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
            id: 'glm-5.1',
            label: 'GLM 5.1',
            model: 'glm-5.1',
            provider: 'anthropic',
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
          id: 'vk-glm',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-gl',
          state: 'active',
          key: 'sk-bf-glm-secret',
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
        body: JSON.stringify({ modelId: 'glm-5.1' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.apiBase, 'https://relay.catsco.cc/anthropic');
      assert.equal(data.selectedModel.base_url, 'https://relay.catsco.cc/anthropic');
      assert.equal(data.selectedModel.sdk_label, 'Anthropic SDK');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(text.includes('wrong.example.test'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply keeps fallback MiniMax independent from legacy default_model', async () => {
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
      assert.equal(data.model, 'MiniMax-M2.7');
      assert.equal(data.selectedModel.id, 'minimax-m2.7');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M2.7');
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
            id: 'glm-5.1',
            label: 'GLM 5.1',
            model: 'glm-5.1',
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
          id: 'vk-glm',
          name: 'CatsCo user 38',
          prefix: 'sk-bf-gl',
          state: 'active',
          key: 'sk-bf-glm-secret',
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
        body: JSON.stringify({ modelId: 'glm-5.1', activateConnector: true }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.model, 'glm-5.1');
      assert.equal(data.connectorStarted, true);
      assert.equal(data.connectorRestarted, false);
      assert.equal(data.connectorStartBlocked, false);
      assert.match(data.message, /已启动 CatsCompany connector/);
      assert.equal(startCalled, 1);
      assert.equal(restartCalled, 0);
      assert.equal(parsed.GAUZ_LLM_MODEL, 'glm-5.1');
      assert.equal(text.includes('sk-bf-glm-secret'), false);
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
          {
            id: 'glm-5.1',
            label: 'GLM 5.1',
            model: 'glm-5.1',
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
        body: JSON.stringify({ modelId: 'glm-5.1' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.model, 'glm-5.1');
      assert.equal(data.createdKey, false);
      assert.equal(data.rotatedKey, false);
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.CATSCO_MODEL_SOURCE, 'relay');
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'anthropic');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/anthropic');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'glm-5.1');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-old-local-secret');
      assert.equal(parsed.CATSCO_RELAY_LLM_MODEL, 'glm-5.1');
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

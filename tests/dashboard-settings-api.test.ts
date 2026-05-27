import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import express from 'express';
import type { Server } from 'http';
import { createApiRouter } from '../src/dashboard/routes/api';

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
    'CATSCO_HTTP_BASE_URL',
    'CATSCO_SERVER_URL',
    'CATSCOMPANY_HTTP_BASE_URL',
    'CATSCOMPANY_SERVER_URL',
    'CATSCO_LOCAL_CONFIG_PATH',
    'CATSCO_CONFIG_PATH',
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

  test('GET and PUT /settings use typed CatsCo local endpoint config', async () => {
    fs.mkdirSync(path.join(testRoot, '.xiaoba'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.xiaoba', 'catsco.json'), JSON.stringify({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://typed.catsco.example',
        serverUrl: 'wss://typed.catsco.example/v0/channels',
      },
    }), 'utf-8');
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'CATSCO_HTTP_BASE_URL=https://env.catsco.example',
      'CATSCO_SERVER_URL=wss://env.catsco.example/v0/channels',
      '',
    ].join('\n'));

    const getResponse = await fetch(`${baseUrl}/api/settings`);
    const getData = await getResponse.json() as any;
    const httpBase = getData.fields.find((field: any) => field.id === 'catsco.httpBaseUrl');
    const wsUrl = getData.fields.find((field: any) => field.id === 'catsco.wsUrl');
    assert.equal(getResponse.status, 200);
    assert.equal(httpBase.value, 'https://typed.catsco.example/');
    assert.equal(wsUrl.value, 'wss://typed.catsco.example/v0/channels');

    const putResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          'catsco.httpBaseUrl': 'https://new.catsco.example',
          'catsco.wsUrl': 'wss://new.catsco.example/v0/channels',
        },
      }),
    });
    const putData = await putResponse.json() as any;
    const localConfig = JSON.parse(fs.readFileSync(path.join(testRoot, '.xiaoba', 'catsco.json'), 'utf-8'));
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(putResponse.status, 200);
    assert.equal(putData.updated.includes('CATSCO_HTTP_BASE_URL'), true);
    assert.equal(putData.updated.includes('CATSCO_SERVER_URL'), true);
    assert.equal(localConfig.endpoints.httpBaseUrl, 'https://new.catsco.example');
    assert.equal(localConfig.endpoints.serverUrl, 'wss://new.catsco.example/v0/channels');
    assert.equal(env.CATSCO_HTTP_BASE_URL, 'https://new.catsco.example');
    assert.equal(env.CATSCOMPANY_SERVER_URL, 'wss://new.catsco.example/v0/channels');
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
    assert.equal(process.env.GAUZ_LLM_API_KEY, 'sk-new-secret');

    const statusResponse = await fetch(`${baseUrl}/api/status`);
    const status = await statusResponse.json() as any;
    assert.equal(status.provider, 'anthropic');
    assert.equal(status.model, 'MiniMax-M2.7-highspeed');
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
  });
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

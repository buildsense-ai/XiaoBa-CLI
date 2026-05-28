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
    'CATSCO_USER_TOKEN',
    'CATSCO_USER_UID',
    'CATSCO_USER_NAME',
    'CATSCO_USER_DISPLAY_NAME',
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

  test('POST /cats/relay/model-config/apply writes OpenAI-compatible relay settings', async () => {
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
        body: JSON.stringify({ protocol: 'openai' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.provider, 'openai');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/v1');
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'openai');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/v1');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M2.7');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-openai-compatible');
      assert.equal(text.includes('sk-bf-openai-compatible'), false);
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
        reason: 'test-only',
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
      assert.deepStrictEqual(data.data, { error: 'upstream failure', reason: 'test-only' });
      assert.equal(text.includes('sk-bf-should-not-leak'), false);
      assert.equal(text.includes('user-token-should-not-leak'), false);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
    }
  });

  test('POST /cats/relay/model-config/apply reuses local relay key when switching protocols', async () => {
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
        body: JSON.stringify({ protocol: 'openai' }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 200, text);
      assert.equal(data.provider, 'openai');
      assert.equal(data.apiBase, 'https://relay.catsco.cc/v1');
      assert.equal(data.createdKey, false);
      assert.equal(data.rotatedKey, false);
      assert.equal(data.key.prefix, 'sk-bf-old...cret');
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.GAUZ_LLM_PROVIDER, 'openai');
      assert.equal(parsed.GAUZ_LLM_API_BASE, 'https://relay.catsco.cc/v1');
      assert.equal(parsed.GAUZ_LLM_MODEL, 'MiniMax-M2.7');
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-old-local-secret');
      assert.equal(text.includes('sk-bf-old-local-secret'), false);
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
        body: JSON.stringify({ protocol: 'anthropic' }),
      });
      const data = await response.json() as any;
      const parsed = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

      assert.equal(response.status, 409);
      assert.equal(data.action, 'rotate_required');
      assert.equal(data.key.prefix, undefined);
      assert.equal(createCalled, false);
      assert.equal(rotateCalled, false);
      assert.equal(parsed.GAUZ_LLM_API_KEY, 'sk-bf-old-local-secret');
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
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

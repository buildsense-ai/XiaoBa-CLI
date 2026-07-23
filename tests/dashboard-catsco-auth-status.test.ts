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
import { resolveActiveBotLLMConfig } from '../src/bot-definition/llm-config-resolver';
import { BOT_CATALOG_MODEL_RUNTIME_SCHEMA, BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';

describe('dashboard CatsCo account status', () => {
  let testRoot: string;
  let originalCwd: string;
  let dashboardServer: Server | undefined;
  let catsServer: Server | undefined;
  let dashboardBaseUrl: string;
  let catsBaseUrl: string;
  const envKeys = [
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
    'GAUZ_LLM_PROVIDER',
    'GAUZ_LLM_API_BASE',
    'GAUZ_LLM_API_KEY',
    'GAUZ_LLM_MODEL',
    'GAUZ_LLM_REASONING_EFFORT',
    'CATSCO_MODEL_SOURCE',
    'CATSCO_CUSTOM_LLM_PROVIDER',
    'CATSCO_CUSTOM_LLM_API_BASE',
    'CATSCO_CUSTOM_LLM_API_KEY',
    'CATSCO_CUSTOM_LLM_MODEL',
    'CATSCO_CUSTOM_LLM_REASONING_EFFORT',
    'CATSCO_RELAY_LLM_PROVIDER',
    'CATSCO_RELAY_LLM_API_BASE',
    'CATSCO_RELAY_LLM_API_KEY',
    'CATSCO_RELAY_LLM_MODEL',
    'CATSCO_RELAY_LLM_REASONING_EFFORT',
    'CATSCOMPANY_HTTP_BASE_URL',
    'CATSCOMPANY_SERVER_URL',
    'CATSCOMPANY_USER_TOKEN',
    'CATSCOMPANY_USER_UID',
    'CATSCOMPANY_USER_NAME',
    'CATSCOMPANY_USER_DISPLAY_NAME',
    'CATSCOMPANY_BOT_UID',
    'CATSCOMPANY_API_KEY',
    'CATSCOMPANY_DEVICE_ID',
    'CATSCOMPANY_BODY_ID',
    'CATSCOMPANY_INSTALLATION_ID',
    'CATSCO_ALLOW_LOCAL_ENDPOINTS',
    'CATSCOMPANY_ALLOW_LOCAL_ENDPOINTS',
  ];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-catsco-auth-'));
    process.chdir(testRoot);

    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CATSCO_ALLOW_LOCAL_ENDPOINTS = '1';

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({
      getAll: () => [],
      getService: () => null,
    } as any));
    dashboardServer = await listen(app);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);
  });

  afterEach(async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }
    if (catsServer) {
      await close(catsServer);
      catsServer = undefined;
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

  test('GET /cats/status treats rejected CatsCompany token as logged out', async () => {
    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.status(401).json({ error: 'invalid token' });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=stale-user-token',
      'CATSCO_USER_UID=38',
      'CATSCO_BOT_UID=110',
      'CATSCO_API_KEY=agent-api-key',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.tokenPresent, true);
    assert.equal(data.connected, false);
    assert.equal(data.configured, false);
    assert.equal(data.authStatus, 'invalid');
    assert.match(data.authError, /重新登录/);
    assert.equal(data.user, null);
    assert.equal(data.topicId, '');
  });

  test('PUT /settings immediately restarts a running connector after a bound custom model update', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: {
        uid: '117',
        name: 'Friday',
        apiKey: 'cats-agent-key',
        boundByUserUid: '116',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-model-switch',
        bodyId: 'body-model-switch',
        installationId: 'install-model-switch',
      },
    });

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'running',
    };
    let restartCalled = 0;
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      restart: (name: string) => {
        assert.equal(name, 'catscompany');
        restartCalled += 1;
        return service;
      },
    } as any));
    dashboardServer = await listen(app);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    const response = await fetch(`${dashboardBaseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activateConnector: true,
        settings: {
          'model.provider': 'openai',
          'model.openaiApiMode': 'responses',
          'model.apiBase': 'https://relay.catsco.cc/v1',
          'model.model': 'gpt-5.6-sol',
          'model.contextWindowTokens': '256000',
          'model.apiKey': { action: 'replace', value: 'sk-custom-model-secret' },
        },
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const definition = new FileBotDefinitionRepository({ runtimeRoot: testRoot }).readCache('117');

    assert.equal(response.status, 200, text);
    assert.equal(data.connectorRestarted, true);
    assert.equal(data.connectorStarted, false);
    assert.equal(data.connectorStartBlocked, false);
    assert.equal(restartCalled, 1);
    assert.equal(definition?.model.kind, 'custom');
    assert.equal(definition?.model.model, 'gpt-5.6-sol');
    assert.equal(text.includes('sk-custom-model-secret'), false);
  });

  test('PUT /settings does not restart a connector for background auto-save', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: {
        uid: '118',
        name: 'Saturday',
        apiKey: 'cats-agent-key',
        boundByUserUid: '116',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-auto-save',
        bodyId: 'body-auto-save',
        installationId: 'install-auto-save',
      },
    });

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'running',
    };
    let restartCalled = 0;
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      restart: () => {
        restartCalled += 1;
        return service;
      },
    } as any));
    const localServer = await listen(app);

    try {
      const response = await fetch(`${serverBaseUrl(localServer)}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activateConnector: false,
          settings: {
            'model.provider': 'openai',
            'model.openaiApiMode': 'responses',
            'model.apiBase': 'https://relay.catsco.cc/v1',
            'model.model': 'gpt-5.6-sol-preview',
            'model.contextWindowTokens': '256000',
            'model.apiKey': { action: 'replace', value: 'sk-custom-model-secret' },
          },
        }),
      });
      const data = await response.json() as any;

      assert.equal(response.status, 200);
      assert.equal(data.connectorRestarted, false);
      assert.equal(data.connectorStarted, false);
      assert.equal(restartCalled, 0);
    } finally {
      await close(localServer);
    }
  });

  test('POST /cats/connector/start requires an existing bot binding', async () => {
    const response = await fetch(`${dashboardBaseUrl}/api/cats/connector/start`, {
      method: 'POST',
    });
    const data = await response.json() as any;

    assert.equal(response.status, 409);
    assert.match(data.error, /No CatsCo bot is bound/);
  });

  test('POST /cats/connector/start starts the bound Definition without legacy model setup', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://app.catsco.cc',
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'user-token',
        uid: '38',
      },
      currentBot: {
        uid: '320',
        name: 'Friday',
        apiKey: 'cats_svc_test',
        boundByUserUid: '38',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-connector-start',
        bodyId: 'body-connector-start',
        installationId: 'install-connector-start',
      },
    });
    new FileBotDefinitionRepository({ runtimeRoot: testRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '320',
      model: {
        kind: 'custom',
        protocol: 'openai-responses',
        apiBase: 'https://relay.catsco.cc/v1',
        model: 'gpt-5.6-sol',
        apiKey: 'sk-custom-secret',
        contextWindowTokens: 256_000,
      },
    });

    const service = {
      name: 'catscompany',
      label: 'CatsCompany',
      status: 'stopped',
      command: process.execPath,
    };
    let startCalled = 0;
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => name === 'catscompany' ? service : undefined,
      start: (name: string) => {
        assert.equal(name, 'catscompany');
        startCalled += 1;
        service.status = 'running';
        return service;
      },
    } as any));
    const localServer = await listen(app);

    try {
      const response = await fetch(`${serverBaseUrl(localServer)}/api/cats/connector/start`, {
        method: 'POST',
      });
      const text = await response.text();
      const data = JSON.parse(text) as any;
      const definition = new FileBotDefinitionRepository({ runtimeRoot: testRoot }).readCanonical('320');

      assert.equal(response.status, 200, text);
      assert.equal(data.ok, true);
      assert.equal(data.connectorStarted, true);
      assert.equal(startCalled, 1);
      assert.equal(definition?.model.kind, 'custom');
      assert.equal(definition?.model.kind === 'custom' ? definition.model.model : '', 'gpt-5.6-sol');
      assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
    } finally {
      await close(localServer);
    }
  });

  test('GET /cats/status validates the shared CatsCompany account token', async () => {
    await startCatsServer((req, res) => {
      assert.equal(req.header('authorization'), 'Bearer valid-user-token');
      if (req.path === '/api/me') {
        return res.json({ uid: 42, username: 'webuser', display_name: 'Web User' });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCOMPANY_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCOMPANY_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCOMPANY_USER_TOKEN=valid-user-token',
      'CATSCOMPANY_USER_UID=38',
      'CATSCOMPANY_BOT_UID=110',
      'CATSCOMPANY_API_KEY=agent-api-key',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.connected, true);
    assert.equal(data.configured, false);
    assert.equal(data.bodyConfigured, false);
    assert.equal(data.unconfirmedBotBinding, true);
    assert.equal(data.authStatus, 'valid');
    assert.deepStrictEqual(data.user, {
      uid: '42',
      username: 'webuser',
      display_name: 'Web User',
    });
    assert.equal(data.topicId, '');
  });

  test('GET /cats/status reports ready chat only after a confirmed local body binding', async () => {
    await startCatsServer((req, res) => {
      assert.equal(req.header('authorization'), 'Bearer valid-user-token');
      if (req.path === '/api/me') {
        return res.json({ uid: 42, username: 'webuser', display_name: 'Web User' });
      }
      if (req.path === '/api/bots/body-status') {
        assert.equal(req.query.uid, '110');
        return res.json({ body_id: 'body-local', active: true });
      }
      return res.status(404).json({ error: 'not found' });
    });
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'valid-user-token',
        uid: '42',
        username: 'webuser',
        displayName: 'Web User',
      },
      currentBot: {
        uid: '110',
        name: 'CatsCo',
        username: 'catsco_42',
        apiKey: 'agent-api-key',
        boundByUserUid: '42',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'body-local',
        bodyId: 'body-local',
        installationId: 'body-local',
      },
    });
    createBotDefinitionSyncService({ runtimeRoot: testRoot }).acceptCloud('110', {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.connected, true);
    assert.equal(data.configured, true);
    assert.equal(data.bodyConfigured, true);
    assert.equal(data.chatReady, true);
    assert.equal(data.unconfirmedBotBinding, false);
    assert.equal(data.botUid, '110');
    assert.equal(data.bodyStatus.state, 'online');
    assert.deepStrictEqual(data.cloudModelOverride, {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
    assert.equal(data.topicId, 'p2p_42_110');
  });

  test('GET /cats/status does not report conflict for an inactive historical body', async () => {
    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 42, username: 'webuser', display_name: 'Web User' });
      }
      if (req.path === '/api/bots/body-status') {
        return res.json({ body_id: 'body-from-old-installation', active: false });
      }
      return res.status(404).json({ error: 'not found' });
    });
    saveConfirmedLocalBinding('body-local');

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.bodyStatus.state, 'offline');
    assert.equal(data.bodyStatus.active, false);
    assert.equal(data.bodyStatus.platformBodyId, 'body-from-old-installation');
    assert.equal(data.bodyStatus.conflictReason, undefined);
    assert.equal(data.chatReady, true);
  });

  test('GET /cats/status keeps a real active-body conflict blocking', async () => {
    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 42, username: 'webuser', display_name: 'Web User' });
      }
      if (req.path === '/api/bots/body-status') {
        return res.json({ body_id: 'body-from-other-installation', active: true });
      }
      return res.status(404).json({ error: 'not found' });
    });
    saveConfirmedLocalBinding('body-local');

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.bodyStatus.state, 'conflict');
    assert.equal(data.bodyStatus.active, true);
    assert.equal(data.bodyStatus.conflictReason, 'active_lease_owned_by_other_body');
    assert.equal(data.chatReady, false);
  });

  test('POST /cats/auth/login writes both CatsCo and CatsCompany env aliases', async () => {
    await startCatsServer((req, res) => {
      if (req.path === '/api/auth/login') {
        assert.deepStrictEqual(req.body, {
          account: 'demo@example.com',
          password: 'passw0rd',
          persistent: true,
        });
        return res.json({
          token: 'new-user-token',
          uid: 77,
          username: 'demo',
          display_name: 'Demo User',
        });
      }
      return res.status(404).json({ error: 'not found' });
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        account: 'demo@example.com',
        password: 'passw0rd',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(env.CATSCO_USER_TOKEN, 'new-user-token');
    assert.equal(env.CATSCOMPANY_USER_TOKEN, 'new-user-token');
    assert.equal(env.CATSCO_USER_UID, '77');
    assert.equal(env.CATSCOMPANY_USER_UID, '77');
    assert.equal(env.CATSCO_USER_DISPLAY_NAME, 'Demo User');
    assert.equal(env.CATSCOMPANY_USER_DISPLAY_NAME, 'Demo User');
    const persisted = createCatsCoLocalConfigService({ runtimeRoot: testRoot }).load();
    assert.equal(persisted.account?.token, 'new-user-token');
    assert.equal(persisted.account?.uid, '77');
  });

  test('POST /cats/auth/register requests a persistent token after registration', async () => {
    const requests: string[] = [];
    await startCatsServer((req, res) => {
      requests.push(req.path);
      if (req.path === '/api/auth/register') {
        assert.deepStrictEqual(req.body, {
          email: 'new@example.com',
          username: 'new-user',
          password: 'passw0rd',
          code: '123456',
        });
        return res.json({ ok: true });
      }
      if (req.path === '/api/auth/login') {
        assert.deepStrictEqual(req.body, {
          account: 'new@example.com',
          password: 'passw0rd',
          persistent: true,
        });
        return res.json({
          token: 'registered-user-token',
          uid: 78,
          username: 'new-user',
          display_name: 'New User',
        });
      }
      return res.status(404).json({ error: 'not found' });
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        email: 'new@example.com',
        username: 'new-user',
        password: 'passw0rd',
        code: '123456',
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.deepStrictEqual(requests, ['/api/auth/register', '/api/auth/login']);
    const persisted = createCatsCoLocalConfigService({ runtimeRoot: testRoot }).load();
    assert.equal(persisted.account?.token, 'registered-user-token');
    assert.equal(persisted.account?.uid, '78');
  });

  test('POST /cats/desktop-connect exchanges a web login code and persists CatsCo account aliases', async () => {
    await startCatsServer((req, res) => {
      if (req.path === '/api/desktop-connect/exchange') {
        assert.deepStrictEqual(req.body, { code: 'one-time-code' });
        return res.json({
          token: 'desktop-user-token',
          uid: 91,
          username: 'desktop',
          display_name: 'Desktop User',
          http_base_url: catsBaseUrl,
          server_url: 'wss://app.catsco.cc/v0/channels',
        });
      }
      return res.status(404).json({ error: 'not found' });
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/desktop-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'one-time-code',
        httpBaseUrl: catsBaseUrl,
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.user.uid, '91');
    assert.equal(env.CATSCO_USER_TOKEN, 'desktop-user-token');
    assert.equal(env.CATSCOMPANY_USER_TOKEN, 'desktop-user-token');
    assert.equal(env.CATSCO_USER_UID, '91');
    assert.equal(env.CATSCOMPANY_USER_DISPLAY_NAME, 'Desktop User');
  });

  test('POST /cats/desktop-connect rejects an untrusted requested base before exchange', async () => {
    const response = await fetch(`${dashboardBaseUrl}/api/cats/desktop-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'one-time-code',
        httpBaseUrl: 'https://evil.example',
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 400);
    assert.match(data.error, /Untrusted CatsCo HTTP endpoint/);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
  });

  test('POST /cats/desktop-connect rejects untrusted exchange endpoints before persisting', async () => {
    await startCatsServer((req, res) => {
      if (req.path === '/api/desktop-connect/exchange') {
        return res.json({
          token: 'desktop-user-token',
          uid: 91,
          username: 'desktop',
          display_name: 'Desktop User',
          http_base_url: 'https://evil.example',
          server_url: 'wss://app.catsco.cc/v0/channels',
        });
      }
      return res.status(404).json({ error: 'not found' });
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/desktop-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'one-time-code',
        httpBaseUrl: catsBaseUrl,
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 400);
    assert.match(data.error, /Untrusted CatsCo HTTP endpoint/);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
  });

  test('POST /cats/setup creates a relay key, writes model config, and starts connector for a new account', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'stopped',
    };
    let startCalled = 0;
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
    } as any));
    dashboardServer = await listen(dashboardApp);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        assert.equal(req.header('authorization'), 'Bearer user-token');
        return res.json({ uid: 88, username: 'fresh', display_name: 'Fresh User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({ bots: [] });
      }
      if (req.path === '/api/bots' && req.method === 'POST') {
        return res.json({
          uid: 188,
          username: req.body.username,
          display_name: req.body.display_name,
          api_key: 'cats-agent-key',
        });
      }
      if (req.path === '/api/friends/request') {
        return res.json({ ok: true });
      }
      if (req.path === '/api/friends/accept') {
        assert.equal(req.header('authorization'), 'ApiKey cats-agent-key');
        return res.json({ ok: true });
      }
      if (req.path === '/api/relay/config') {
        return res.json({
          base_url: 'https://relay.catsco.cc',
          self_service_enabled: true,
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
              id: 'minimax-m3',
              label: 'MiniMax M3',
              model: 'MiniMax-M3',
              provider: 'anthropic',
              protocol: 'Anthropic-compatible',
              base_url: 'https://relay.catsco.cc/anthropic',
              enabled: true,
            },
          ],
        });
      }
      if (req.path === '/api/relay/key' && req.method === 'GET') {
        return res.json({ key: null });
      }
      if (req.path === '/api/relay/key' && req.method === 'POST') {
        assert.equal(req.body.name, 'Fresh User');
        return res.json({
          key: {
            id: 'relay-key-1',
            name: req.body.name,
            prefix: 'sk-bf-fr',
            state: 'active',
            key: 'sk-bf-fresh-secret',
          },
        });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=user-token',
      'CATSCO_USER_UID=88',
      'CATSCO_USER_NAME=fresh',
      'CATSCO_USER_DISPLAY_NAME=Fresh User',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        relayModelId: 'minimax-m3',
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));
    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot: testRoot }).read('188');

    assert.equal(response.status, 200, text);
    assert.equal(data.ok, true);
    assert.equal(data.botSelectionSource, 'created-default');
    assert.equal(data.relayModelSetup.ok, true);
    assert.equal(data.relayModelSetup.model, 'MiniMax-M3');
    assert.equal(data.relayModelSetup.reasoningEffort, 'high');
    assert.equal(data.relayModelSetup.createdKey, true);
    assert.equal(text.includes('sk-bf-fresh-secret'), false);
    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.equal(runtime?.provider, 'anthropic');
    assert.equal(runtime?.apiBase, 'https://relay.catsco.cc/anthropic');
    assert.equal(runtime?.model, 'MiniMax-M3');
    assert.equal(runtime?.apiKey, 'sk-bf-fresh-secret');
    assert.equal(runtime?.reasoningEffort, 'high');
    assert.equal(env.CATSCO_BOT_UID, '188');
    assert.equal(env.CATSCO_API_KEY, 'cats-agent-key');
    assert.equal(startCalled, 1);
    assert.equal(data.service.status, 'running');
  });

  test('POST /cats/setup reuses an existing owned bot instead of creating a default bot', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'stopped',
    };
    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      start: () => {
        service.status = 'running';
        return service;
      },
    } as any));
    dashboardServer = await listen(dashboardApp);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    let createBotCalls = 0;
    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 88, username: 'fresh', display_name: 'Fresh User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({
          bots: [{
            id: 188,
            uid: 188,
            username: 'existing-agent',
            display_name: 'Existing Agent',
            api_key: 'existing-agent-key',
          }],
        });
      }
      if (req.path === '/api/bots' && req.method === 'POST') {
        createBotCalls += 1;
        return res.status(500).json({ error: 'should not create bot' });
      }
      if (req.path === '/api/friends/request') {
        return res.json({ ok: true });
      }
      if (req.path === '/api/friends/accept') {
        assert.equal(req.header('authorization'), 'ApiKey existing-agent-key');
        return res.json({ ok: true });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=user-token',
      'CATSCO_USER_UID=88',
      'CATSCO_USER_NAME=fresh',
      'CATSCO_USER_DISPLAY_NAME=Fresh User',
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/messages',
      'GAUZ_LLM_API_KEY=sk-test',
      'GAUZ_LLM_MODEL=test-model',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        setupRelayModel: false,
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(data.ok, true);
    assert.equal(data.botSelectionSource, 'first-owned-bot');
    assert.equal(data.bot.uid, '188');
    assert.equal(data.bot.display_name, 'Existing Agent');
    assert.equal(env.CATSCO_BOT_UID, '188');
    assert.equal(env.CATSCO_API_KEY, 'existing-agent-key');
    assert.equal(createBotCalls, 0);
  });

  test('POST /cats/setup reuses the last selected bot before the first owned bot', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'stopped',
    };
    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      start: () => {
        service.status = 'running';
        return service;
      },
    } as any));
    dashboardServer = await listen(dashboardApp);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    let createBotCalls = 0;
    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 88, username: 'fresh', display_name: 'Fresh User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({
          bots: [
            { uid: 188, username: 'first-agent', display_name: 'First Agent', api_key: 'first-agent-key' },
            { uid: 199, username: 'last-agent', display_name: 'Last Agent', api_key: 'last-agent-key' },
          ],
        });
      }
      if (req.path === '/api/bots' && req.method === 'POST') {
        createBotCalls += 1;
        return res.status(500).json({ error: 'should not create bot' });
      }
      if (req.path === '/api/friends/request') {
        return res.json({ ok: true });
      }
      if (req.path === '/api/friends/accept') {
        assert.equal(req.header('authorization'), 'ApiKey last-agent-key');
        return res.json({ ok: true });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=user-token',
      'CATSCO_USER_UID=88',
      'CATSCO_USER_NAME=fresh',
      'CATSCO_USER_DISPLAY_NAME=Fresh User',
      'CATSCO_BOT_UID=199',
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/messages',
      'GAUZ_LLM_API_KEY=sk-test',
      'GAUZ_LLM_MODEL=test-model',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        setupRelayModel: false,
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 200, text);
    assert.equal(data.ok, true);
    assert.equal(data.botSelectionSource, 'last-used');
    assert.equal(data.bot.uid, '199');
    assert.equal(data.bot.display_name, 'Last Agent');
    assert.equal(env.CATSCO_BOT_UID, '199');
    assert.equal(env.CATSCO_API_KEY, 'last-agent-key');
    assert.equal(createBotCalls, 0);
  });

  test('POST /cats/bind-bot restores the active binding when target preflight is blocked', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: 'xiaoba-command-that-does-not-exist',
      args: [],
      status: 'running',
    };
    let restartCalled = 0;
    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      restart: () => {
        restartCalled += 1;
        return service;
      },
    } as any));
    dashboardServer = await listen(dashboardApp);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 88, username: 'fresh', display_name: 'Fresh User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({
          bots: [{ uid: 199, username: 'target-agent', display_name: 'Target Agent', api_key: 'target-agent-key' }],
        });
      }
      if (req.path === '/api/friends/request' || req.path === '/api/friends/accept') {
        return res.json({ ok: true });
      }
      return res.status(404).json({ error: 'not found' });
    });

    const localConfig = createCatsCoLocalConfigService({ runtimeRoot: testRoot });
    localConfig.save({
      version: 1,
      endpoints: { httpBaseUrl: catsBaseUrl, serverUrl: 'wss://app.catsco.cc/v0/channels' },
      account: { token: 'user-token', uid: '88', username: 'fresh', displayName: 'Fresh User' },
      currentBot: { uid: '188', name: 'Active Agent', apiKey: 'active-agent-key' },
      device: { deviceId: 'device-1', bodyId: 'body-1', installationId: 'install-1' },
    });

    const definitions = new FileBotDefinitionRepository({ runtimeRoot: testRoot });
    const targetDefinition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId: '199',
      model: { kind: 'catalog' as const, modelId: 'minimax-m3' },
    };
    definitions.writeCanonical(targetDefinition);
    definitions.writeCache(targetDefinition);
    new FileBotCatalogModelRuntimeRepository({ runtimeRoot: testRoot }).write({
      schema: BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
      botId: '199',
      modelId: 'minimax-m3',
      provider: 'anthropic',
      apiBase: 'https://relay.example.test/anthropic',
      apiKey: 'sk-target-runtime',
      model: 'MiniMax-M3',
      contextWindowTokens: 200000,
      reasoningEffort: 'high',
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/bind-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botUid: '199', setupRelayModel: false }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 400);
    assert.equal(data.error, 'CatsCo connector preflight blocked');
    assert.equal(data.data?.preflight?.status, 'blocked');
    assert.equal(data.data?.preflight?.blockingChecks.includes('runtime.command'), true);
    assert.equal(localConfig.load().currentBot?.uid, '188');
    assert.equal(restartCalled, 0);
  });

  test('PUT /model/reasoning-effort accepts and normalizes a legacy catalog runtime alias', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      currentBot: { uid: '188', name: 'Catalog Agent', apiKey: 'catalog-agent-key' },
      device: { deviceId: 'device-1', bodyId: 'body-1', installationId: 'install-1' },
    });
    const definitions = new FileBotDefinitionRepository({ runtimeRoot: testRoot });
    const definition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId: '188',
      model: { kind: 'catalog' as const, modelId: 'minimax-m3' },
    };
    definitions.writeCanonical(definition);
    definitions.writeCache(definition);
    const runtimeRepository = new FileBotCatalogModelRuntimeRepository({ runtimeRoot: testRoot });
    runtimeRepository.write({
      schema: BOT_CATALOG_MODEL_RUNTIME_SCHEMA,
      botId: '188',
      modelId: 'MiniMax-M3',
      provider: 'anthropic',
      apiBase: 'https://relay.example.test/anthropic',
      apiKey: 'sk-legacy-runtime',
      model: 'MiniMax-M3',
      contextWindowTokens: 200000,
      reasoningEffort: 'high',
    });

    const response = await fetch(`${dashboardBaseUrl}/api/model/reasoning-effort`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: 'max' }),
    });
    const data = await response.json() as any;
    const runtime = runtimeRepository.read('188');

    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.source, 'relay');
    assert.equal(data.reasoningEffort, 'max');
    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.equal(runtime?.model, 'MiniMax-M3');
    assert.equal(runtime?.reasoningEffort, 'max');
  });

  test('POST /cats/bind-bot writes relay model config before starting an existing bot binding', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'stopped',
    };
    let startCalled = 0;
    let relayKeyCreated = 0;
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
    } as any));
    dashboardServer = await listen(dashboardApp);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        assert.equal(req.header('authorization'), 'Bearer user-token');
        return res.json({ uid: 88, username: 'fresh', display_name: 'Fresh User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({
          bots: [{ uid: 188, username: 'catsco_88', display_name: 'CatsCo Existing', api_key: 'cats-agent-key' }],
        });
      }
      if (req.path === '/api/friends/request' || req.path === '/api/friends/accept') {
        return res.json({ ok: true });
      }
      if (req.path === '/api/relay/config') {
        return res.json({
          base_url: 'https://relay.catsco.cc',
          self_service_enabled: true,
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
              id: 'minimax-m3',
              label: 'MiniMax M3',
              model: 'MiniMax-M3',
              provider: 'anthropic',
              protocol: 'Anthropic-compatible',
              base_url: 'https://relay.catsco.cc/anthropic',
              enabled: true,
            },
          ],
        });
      }
      if (req.path === '/api/relay/key' && req.method === 'GET') {
        return res.json({ key: null });
      }
      if (req.path === '/api/relay/key' && req.method === 'POST') {
        relayKeyCreated += 1;
        assert.equal(req.body.name, 'Fresh User');
        return res.json({
          key: {
            id: 'relay-key-existing-bot',
            name: req.body.name,
            prefix: 'sk-bf-ex',
            state: 'active',
            key: 'sk-bf-existing-bot-secret',
          },
        });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=user-token',
      'CATSCO_USER_UID=88',
      'CATSCO_USER_NAME=fresh',
      'CATSCO_USER_DISPLAY_NAME=Fresh User',
    ]);
    const definitionRepository = new FileBotDefinitionRepository({ runtimeRoot: testRoot });
    definitionRepository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '188',
      model: { kind: 'catalog', modelId: 'minimax-m2.7' },
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/bind-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        botUid: '188',
        relayModelId: 'minimax-m3',
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));
    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot: testRoot }).read('188');
    const definition = definitionRepository.readCanonical('188');
    const resolved = resolveActiveBotLLMConfig({ runtimeRoot: testRoot });

    assert.equal(response.status, 200, text);
    assert.equal(data.ok, true);
    assert.equal(data.relayModelSetup.ok, true);
    assert.equal(data.relayModelSetup.model, 'MiniMax-M3');
    assert.equal(data.relayModelSetup.reasoningEffort, 'high');
    assert.equal(data.relayModelSetup.createdKey, true);
    assert.equal(text.includes('sk-bf-existing-bot-secret'), false);
    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.equal(runtime?.provider, 'anthropic');
    assert.equal(runtime?.apiBase, 'https://relay.catsco.cc/anthropic');
    assert.equal(runtime?.model, 'MiniMax-M3');
    assert.equal(runtime?.apiKey, 'sk-bf-existing-bot-secret');
    assert.equal(runtime?.reasoningEffort, 'high');
    assert.deepStrictEqual(definition?.model, { kind: 'catalog', modelId: 'minimax-m3' });
    assert.equal(resolved?.config.model, 'MiniMax-M3');
    assert.equal(relayKeyCreated, 1);
    assert.equal(env.CATSCO_BOT_UID, '188');
    assert.equal(env.CATSCO_API_KEY, 'cats-agent-key');
    assert.equal(startCalled, 1);
    assert.equal(data.service.status, 'running');
  });

  test('POST /cats/setup restarts a running connector after writing relay model config', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'running',
    };
    let restartCalled = 0;
    let startCalled = 0;
    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      start: () => {
        startCalled += 1;
        return service;
      },
      restart: (name: string) => {
        assert.equal(name, 'catscompany');
        restartCalled += 1;
        service.status = 'running';
        return service;
      },
    } as any));
    dashboardServer = await listen(dashboardApp);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 88, username: 'fresh', display_name: 'Fresh User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({ bots: [{ uid: 188, username: 'catsco_88', display_name: 'CatsCo', api_key: 'cats-agent-key' }] });
      }
      if (req.path === '/api/friends/request' || req.path === '/api/friends/accept') {
        return res.json({ ok: true });
      }
      if (req.path === '/api/relay/config') {
        return res.json({
          base_url: 'https://relay.catsco.cc',
          self_service_enabled: true,
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
              id: 'minimax-m3',
              label: 'MiniMax M3',
              model: 'MiniMax-M3',
              provider: 'anthropic',
              protocol: 'Anthropic-compatible',
              base_url: 'https://relay.catsco.cc/anthropic',
              enabled: true,
            },
          ],
        });
      }
      if (req.path === '/api/relay/key' && req.method === 'GET') {
        return res.json({ key: null });
      }
      if (req.path === '/api/relay/key' && req.method === 'POST') {
        return res.json({ key: { id: 'relay-key-1', prefix: 'sk-bf-fr', state: 'active', key: 'sk-bf-fresh-secret' } });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=user-token',
      'CATSCO_USER_UID=88',
      'CATSCO_USER_NAME=fresh',
    ]);
    const definitionRepository = new FileBotDefinitionRepository({ runtimeRoot: testRoot });
    definitionRepository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: '188',
      model: { kind: 'catalog', modelId: 'minimax-m2.7' },
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        relayModelId: 'minimax-m3',
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot: testRoot }).read('188');
    const definition = definitionRepository.readCanonical('188');
    const resolved = resolveActiveBotLLMConfig({ runtimeRoot: testRoot });

    assert.equal(response.status, 200, text);
    assert.equal(data.relayModelSetup.modelId, 'minimax-m3');
    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.deepStrictEqual(definition?.model, { kind: 'catalog', modelId: 'minimax-m3' });
    assert.equal(resolved?.config.model, 'MiniMax-M3');
    assert.equal(data.connectorRestarted, true);
    assert.equal(data.connectorStarted, false);
    assert.equal(restartCalled, 1);
    assert.equal(startCalled, 0);
    assert.equal(text.includes('sk-bf-fresh-secret'), false);
  });

  test('POST /cats/setup stops before starting connector when relay key rotation is required', async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }

    const service = {
      name: 'catscompany',
      label: 'CatsCo agent',
      command: process.execPath,
      args: [],
      status: 'stopped',
    };
    let startCalled = 0;
    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({
      getAll: () => [service],
      getService: (name: string) => (name === 'catscompany' ? service : undefined),
      start: () => {
        startCalled += 1;
        service.status = 'running';
        return service;
      },
    } as any));
    dashboardServer = await listen(dashboardApp);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);

    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 88, username: 'fresh', display_name: 'Fresh User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({ bots: [{ uid: 188, username: 'catsco_88', display_name: 'CatsCo', api_key: 'cats-agent-key' }] });
      }
      if (req.path === '/api/friends/request' || req.path === '/api/friends/accept') {
        return res.json({ ok: true });
      }
      if (req.path === '/api/relay/config') {
        return res.json({
          base_url: 'https://relay.catsco.cc',
          self_service_enabled: true,
          models: [{
            id: 'minimax-m2.7',
            model: 'MiniMax-M2.7',
            provider: 'anthropic',
            protocol: 'Anthropic-compatible',
            base_url: 'https://relay.catsco.cc/anthropic',
            enabled: true,
            default: true,
          }],
        });
      }
      if (req.path === '/api/relay/key' && req.method === 'GET') {
        return res.json({ key: { id: 'relay-key-1', prefix: 'sk-bf-other', state: 'active' } });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=user-token',
      'CATSCO_USER_UID=88',
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://relay.catsco.cc/anthropic',
      'GAUZ_LLM_API_KEY=sk-bf-old-local-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 409);
    assert.equal(data.action, 'rotate_required');
    assert.equal(data.relayModelSetup.ok, false);
    assert.equal(startCalled, 0);
    assert.equal(service.status, 'stopped');
    assert.equal(env.GAUZ_LLM_API_KEY, 'sk-bf-old-local-secret');
  });

  test('POST /cats/auth/login reports remote CatsCompany network failures clearly', async () => {
    const response = await fetch(`${dashboardBaseUrl}/api/cats/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: 'http://127.0.0.1:9',
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        account: 'demo@example.com',
        password: 'passw0rd',
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 502);
    assert.match(data.error, /CatsCo\/CatsCompany 服务/);
    assert.equal(data.data.host, '127.0.0.1:9');
  });

  async function startCatsServer(handler: express.RequestHandler): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(handler);
    catsServer = await listen(app);
    catsBaseUrl = serverBaseUrl(catsServer);
  }

  function saveConfirmedLocalBinding(bodyId: string): void {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'valid-user-token',
        uid: '42',
        username: 'webuser',
        displayName: 'Web User',
      },
      currentBot: {
        uid: '110',
        name: 'CatsCo',
        username: 'catsco_42',
        apiKey: 'agent-api-key',
        boundByUserUid: '42',
        bindingSource: 'test',
      },
      device: {
        deviceId: `device-for-${bodyId}`,
        bodyId,
        installationId: `installation-for-${bodyId}`,
      },
    });
  }

  function writeEnv(lines: string[]): void {
    fs.writeFileSync(path.join(testRoot, '.env'), `${lines.join('\n')}\n`);
  }
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function serverBaseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

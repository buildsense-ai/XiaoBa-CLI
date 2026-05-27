import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import express from 'express';
import type { Server } from 'http';
import { createApiRouter } from '../src/dashboard/routes/api';

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
    'CATSCO_LOCAL_CONFIG_PATH',
    'CATSCO_CONFIG_PATH',
    'GAUZ_LLM_PROVIDER',
    'GAUZ_LLM_API_BASE',
    'GAUZ_LLM_API_KEY',
    'GAUZ_LLM_MODEL',
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

  test('GET /cats/status validates account token but downgrades env-only bot binding', async () => {
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
    assert.equal(data.accountConnected, true);
    assert.equal(data.bodyConfigured, false);
    assert.equal(data.connectorReady, true);
    assert.equal(data.chatReady, false);
    assert.equal(data.requiresBotRebind, true);
    assert.equal(data.authStatus, 'valid');
    assert.deepStrictEqual(data.user, {
      uid: '42',
      username: 'webuser',
      display_name: 'Web User',
    });
    assert.equal(data.botUid, null);
    assert.equal(data.topicId, '');
  });

  test('GET /cats/status reports matching platform body status', async () => {
    const seenRequests: string[] = [];
    await startCatsServer((req, res) => {
      seenRequests.push(`${req.method} ${req.path}`);
      assert.equal(req.header('authorization'), 'Bearer valid-user-token');
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots/body-status') {
        assert.equal(req.query.uid, '110');
        return res.json({
          bot_uid: 110,
          active: true,
          body_id: 'body-local',
          connected_at: '2026-05-26T10:00:00Z',
        });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeCatsLocalConfig({
      version: 1,
      endpoints: {
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'valid-user-token',
        uid: '77',
        username: 'demo',
        displayName: 'Demo User',
      },
      currentBot: {
        uid: '110',
        name: 'CatsCo (Test Mac)',
        username: 'catsco_77_device_x',
        apiKey: 'agent-api-key',
        boundByUserUid: '77',
        bindingSource: 'explicit-bind',
        boundAt: '2026-05-26T09:00:00Z',
      },
      device: {
        deviceId: 'body-local',
        bodyId: 'body-local',
        installationId: 'body-local',
      },
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.connected, true);
    assert.equal(data.configured, true);
    assert.equal(data.bodyId, 'body-local');
    assert.deepStrictEqual(data.bodyStatus, {
      state: 'online',
      active: true,
      localBodyId: 'body-local',
      platformBodyId: 'body-local',
      connectedAt: '2026-05-26T10:00:00Z',
      checkedAt: data.bodyStatus.checkedAt,
    });
    assert.match(data.bodyStatus.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(seenRequests, [
      'GET /api/me',
      'GET /api/bots/body-status',
    ]);
  });

  test('GET /cats/status marks a different active platform body as conflict', async () => {
    await startCatsServer((req, res) => {
      assert.equal(req.header('authorization'), 'Bearer valid-user-token');
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots/body-status') {
        return res.json({
          bot_uid: 110,
          active: true,
          body_id: 'body-other',
          connected_at: '2026-05-26T10:00:00Z',
        });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeCatsLocalConfig({
      version: 1,
      endpoints: {
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'valid-user-token',
        uid: '77',
      },
      currentBot: {
        uid: '110',
        name: 'CatsCo (Test Mac)',
        apiKey: 'agent-api-key',
        boundByUserUid: '77',
        bindingSource: 'explicit-bind',
      },
      device: {
        deviceId: 'body-local',
        bodyId: 'body-local',
        installationId: 'body-local',
      },
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.bodyStatus.state, 'conflict');
    assert.equal(data.bodyStatus.localBodyId, 'body-local');
    assert.equal(data.bodyStatus.platformBodyId, 'body-other');
  });

  test('GET /cats/status marks body status auth failures as blocking binding errors', async () => {
    await startCatsServer((req, res) => {
      assert.equal(req.header('authorization'), 'Bearer valid-user-token');
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots/body-status') {
        return res.status(403).json({ error: 'not your bot' });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeCatsLocalConfig({
      version: 1,
      endpoints: {
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'valid-user-token',
        uid: '77',
      },
      currentBot: {
        uid: '110',
        name: 'CatsCo (Test Mac)',
        apiKey: 'agent-api-key',
        boundByUserUid: '77',
        bindingSource: 'explicit-bind',
      },
      device: {
        deviceId: 'body-local',
        bodyId: 'body-local',
        installationId: 'body-local',
      },
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.configured, true);
    assert.equal(data.chatReady, false);
    assert.equal(data.bodyStatus.state, 'auth_error');
    assert.match(data.bodyStatus.error, /owner|绑定|agent/i);
  });

  test('GET /cats/status keeps old platform body status failures as non-blocking unknown', async () => {
    await startCatsServer((req, res) => {
      assert.equal(req.header('authorization'), 'Bearer valid-user-token');
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots/body-status') {
        return res.status(404).json({ error: 'not found' });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeCatsLocalConfig({
      version: 1,
      endpoints: {
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'valid-user-token',
        uid: '77',
      },
      currentBot: {
        uid: '110',
        name: 'CatsCo (Test Mac)',
        apiKey: 'agent-api-key',
        boundByUserUid: '77',
        bindingSource: 'explicit-bind',
      },
      device: {
        deviceId: 'body-local',
        bodyId: 'body-local',
        installationId: 'body-local',
      },
    });

    const response = await fetch(`${dashboardBaseUrl}/api/cats/status`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.configured, true);
    assert.equal(data.chatReady, true);
    assert.equal(data.bodyStatus.state, 'unknown');
    assert.match(data.bodyStatus.error, /not found/);
  });

  test('POST /cats/auth/login writes both CatsCo and CatsCompany env aliases', async () => {
    await startCatsServer((req, res) => {
      if (req.path === '/api/auth/login') {
        assert.deepStrictEqual(req.body, { account: 'demo@example.com', password: 'passw0rd' });
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
    const localConfig = readCatsLocalConfig();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(env.CATSCO_USER_TOKEN, 'new-user-token');
    assert.equal(env.CATSCOMPANY_USER_TOKEN, 'new-user-token');
    assert.equal(env.CATSCO_USER_UID, '77');
    assert.equal(env.CATSCOMPANY_USER_UID, '77');
    assert.equal(env.CATSCO_USER_DISPLAY_NAME, 'Demo User');
    assert.equal(env.CATSCOMPANY_USER_DISPLAY_NAME, 'Demo User');
    assert.equal(localConfig.endpoints.httpBaseUrl, catsBaseUrl);
    assert.equal(localConfig.endpoints.serverUrl, 'wss://app.catsco.cc/v0/channels');
    assert.equal(localConfig.account.token, 'new-user-token');
    assert.equal(localConfig.account.uid, '77');
    assert.equal(localConfig.account.displayName, 'Demo User');
  });

  test('POST /cats/auth/logout clears process env even when no .env file exists', async () => {
    process.env.CATSCO_USER_TOKEN = 'memory-user-token';
    process.env.CATSCO_USER_UID = '77';
    process.env.CATSCOMPANY_USER_TOKEN = 'memory-user-token';
    process.env.CATSCOMPANY_USER_UID = '77';

    const response = await fetch(`${dashboardBaseUrl}/api/cats/auth/logout`, { method: 'POST' });
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.removed.includes('CATSCO_USER_TOKEN'), true);
    assert.equal(data.removed.includes('CATSCOMPANY_USER_TOKEN'), true);
    assert.equal(process.env.CATSCO_USER_TOKEN, undefined);
    assert.equal(process.env.CATSCO_USER_UID, undefined);
    assert.equal(process.env.CATSCOMPANY_USER_TOKEN, undefined);
    assert.equal(process.env.CATSCOMPANY_USER_UID, undefined);
  });

  test('POST /cats/create-bot creates an explicit bot without binding it', async () => {
    await startCatsServer((req, res) => {
      assert.equal(req.header('authorization'), 'Bearer valid-user-token');
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots' && req.method === 'POST') {
        assert.match(req.body.username, /^catsco_77_device_[a-z0-9]+$/);
        assert.equal(req.body.display_name, 'CatsCo (Test Mac)');
        return res.json({
          uid: 110,
          username: req.body.username,
          display_name: req.body.display_name,
          api_key: 'created-api-key',
        });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=valid-user-token',
      'CATSCO_USER_UID=77',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/create-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        deviceName: 'Test Mac',
        botDisplayName: 'CatsCo (Test Mac)',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));
    const localConfig = readCatsLocalConfig();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.bot.uid, '110');
    assert.match(data.deviceId, /^device_[a-f0-9]{12}$/);
    assert.equal(env.CATSCO_DEVICE_ID, data.deviceId);
    assert.equal(env.CATSCOMPANY_DEVICE_ID, data.deviceId);
    assert.equal(env.CATSCO_BOT_UID, undefined);
    assert.equal(env.CATSCO_API_KEY, undefined);
    assert.equal(localConfig.device.deviceId, data.deviceId);
    assert.equal(localConfig.device.bodyId, data.deviceId);
    assert.equal(localConfig.currentBot, undefined);
  });

  test('POST /cats/bind-bot binds one bot identity to the current device', async () => {
    const seenRequests: string[] = [];
    await startCatsServer((req, res) => {
      seenRequests.push(`${req.method} ${req.path}`);
      if (req.path === '/api/me') {
        assert.equal(req.header('authorization'), 'Bearer valid-user-token');
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        assert.equal(req.header('authorization'), 'Bearer valid-user-token');
        return res.json({
          bots: [{ id: 110, username: 'catsco_77_device_x', display_name: 'CatsCo (Test Mac)' }],
        });
      }
      if (req.path === '/api/bots/api-key') {
        assert.equal(req.header('authorization'), 'Bearer valid-user-token');
        assert.equal(req.query.uid, '110');
        return res.json({ api_key: 'agent-api-key' });
      }
      if (req.path === '/api/friends/request') {
        assert.equal(req.header('authorization'), 'Bearer valid-user-token');
        assert.deepStrictEqual(req.body, { user_id: 110, message: 'Connect CatsCo desktop agent' });
        return res.json({ ok: true });
      }
      if (req.path === '/api/friends/accept') {
        assert.equal(req.header('authorization'), 'ApiKey agent-api-key');
        assert.deepStrictEqual(req.body, { user_id: 77 });
        return res.json({ ok: true });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=valid-user-token',
      'CATSCO_USER_UID=77',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/bind-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        botUid: '110',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));
    const localConfig = readCatsLocalConfig();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.bot.uid, '110');
    assert.equal(data.topicId, 'p2p_77_110');
    assert.equal(env.CATSCO_BOT_UID, '110');
    assert.equal(env.CATSCOMPANY_BOT_UID, '110');
    assert.equal(env.CATSCO_API_KEY, 'agent-api-key');
    assert.equal(env.CATSCOMPANY_API_KEY, 'agent-api-key');
    assert.match(env.CATSCO_BODY_ID, /^device_[a-f0-9]{12}$/);
    assert.equal(env.CATSCO_INSTALLATION_ID, env.CATSCO_BODY_ID);
    assert.equal(env.CATSCOMPANY_BODY_ID, env.CATSCO_BODY_ID);
    assert.equal(env.CATSCOMPANY_INSTALLATION_ID, env.CATSCO_BODY_ID);
    assert.equal(localConfig.account.uid, '77');
    assert.equal(localConfig.currentBot.uid, '110');
    assert.equal(localConfig.currentBot.name, 'CatsCo (Test Mac)');
    assert.equal(localConfig.currentBot.username, 'catsco_77_device_x');
    assert.equal(localConfig.currentBot.apiKey, 'agent-api-key');
    assert.equal(localConfig.currentBot.boundByUserUid, '77');
    assert.equal(localConfig.currentBot.bindingSource, 'explicit-bind');
    assert.equal(localConfig.device.deviceId, env.CATSCO_BODY_ID);
    assert.equal(localConfig.device.bodyId, env.CATSCO_BODY_ID);
    const configResponse = await fetch(`${dashboardBaseUrl}/api/cats/config`);
    const configData = await configResponse.json() as any;
    assert.equal(configResponse.status, 200);
    assert.equal(configData.hasAccount, true);
    assert.equal(configData.hasBot, true);
    assert.equal(configData.account.uid, '77');
    assert.equal(configData.currentBot.uid, '110');
    assert.equal(configData.currentBot.name, 'CatsCo (Test Mac)');
    assert.equal(configData.currentBot.boundByUserUid, '77');
    assert.equal(configData.currentBot.bindingSource, 'explicit-bind');
    assert.equal(configData.device.deviceId, env.CATSCO_BODY_ID);
    assert.deepStrictEqual(seenRequests, [
      'GET /api/me',
      'GET /api/bots',
      'GET /api/bots/api-key',
      'POST /api/friends/request',
      'POST /api/friends/accept',
    ]);
  });

  test('POST /cats/setup creates or reuses only a device-scoped bot', async () => {
    const seenRequests: string[] = [];
    await startCatsServer((req, res) => {
      seenRequests.push(`${req.method} ${req.path}`);
      if (req.path === '/api/me') {
        assert.equal(req.header('authorization'), 'Bearer valid-user-token');
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({
          bots: [
            { id: 108, username: 'xiaoba_77', display_name: 'XiaoBa' },
            { id: 109, username: 'catsco_77', display_name: 'CatsCo' },
          ],
        });
      }
      if (req.path === '/api/bots' && req.method === 'POST') {
        assert.match(req.body.username, /^catsco_77_device_[a-f0-9]{12}$/);
        assert.equal(req.body.display_name, 'CatsCo (Test Mac)');
        return res.json({
          uid: 110,
          username: req.body.username,
          display_name: req.body.display_name,
          api_key: 'created-device-api-key',
        });
      }
      if (req.path === '/api/friends/request') {
        assert.deepStrictEqual(req.body, { user_id: 110, message: 'Connect CatsCo desktop agent' });
        return res.json({ ok: true });
      }
      if (req.path === '/api/friends/accept') {
        assert.equal(req.header('authorization'), 'ApiKey created-device-api-key');
        assert.deepStrictEqual(req.body, { user_id: 77 });
        return res.json({ ok: true });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=valid-user-token',
      'CATSCO_USER_UID=77',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        deviceName: 'Test Mac',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));
    const localConfig = readCatsLocalConfig();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.bot.uid, '110');
    assert.equal(data.bot.display_name, 'CatsCo (Test Mac)');
    assert.equal(env.CATSCO_BOT_UID, '110');
    assert.equal(env.CATSCO_API_KEY, 'created-device-api-key');
    assert.equal(localConfig.currentBot.uid, '110');
    assert.equal(localConfig.currentBot.bindingSource, 'legacy-setup');
    assert.equal(localConfig.currentBot.boundByUserUid, '77');
    assert.deepStrictEqual(seenRequests, [
      'GET /api/me',
      'GET /api/bots',
      'POST /api/bots',
      'POST /api/friends/request',
      'POST /api/friends/accept',
    ]);
  });

  test('POST /cats/setup rejects explicit botUid so old callers cannot bind a shared bot', async () => {
    const seenRequests: string[] = [];
    await startCatsServer((req, res) => {
      seenRequests.push(`${req.method} ${req.path}`);
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      return res.status(500).json({ error: 'setup should stop before bot lookup' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=valid-user-token',
      'CATSCO_USER_UID=77',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        botUid: '109',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 409);
    assert.match(data.error, /bind-bot/);
    assert.equal(env.CATSCO_BOT_UID, undefined);
    assert.equal(env.CATSCO_API_KEY, undefined);
    assert.equal(fs.existsSync(path.join(testRoot, '.xiaoba', 'catsco.json')), false);
    assert.deepStrictEqual(seenRequests, [
      'GET /api/me',
    ]);
  });

  test('POST /cats/bind-bot preflights before writing bot binding', async () => {
    await restartDashboardWithServiceManager({
      getAll: () => [service('catscompany', 'CatsCo agent')],
      getService: () => service('catscompany', 'CatsCo agent'),
      start: () => {
        throw new Error('should not start when preflight is blocked');
      },
      getLogs: () => [],
    } as any);
    const seenRequests: string[] = [];
    await startCatsServer((req, res) => {
      seenRequests.push(`${req.method} ${req.path}`);
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({
          bots: [{ id: 110, username: 'catsco_77_device_x', display_name: 'CatsCo (Test Mac)' }],
        });
      }
      if (req.path === '/api/bots/api-key') {
        return res.json({ api_key: 'agent-api-key' });
      }
      if (req.path === '/api/friends/request' || req.path === '/api/friends/accept') {
        return res.status(500).json({ error: 'friend binding should not run before preflight passes' });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=valid-user-token',
      'CATSCO_USER_UID=77',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/bind-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        botUid: '110',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 400);
    assert.equal(data.error, 'CatsCo connector preflight blocked');
    assert.equal(data.data.preflight.status, 'blocked');
    assert.equal(data.data.preflight.blockingChecks.includes('model.custom.credential'), true);
    assert.equal(env.CATSCO_BOT_UID, undefined);
    assert.equal(env.CATSCO_API_KEY, undefined);
    assert.equal(fs.existsSync(path.join(testRoot, '.xiaoba', 'catsco.json')), false);
    assert.deepStrictEqual(seenRequests, [
      'GET /api/me',
      'GET /api/bots',
      'GET /api/bots/api-key',
    ]);
  });

  test('POST /cats/bind-bot rolls local config back when connector start fails', async () => {
    let startCalls = 0;
    await restartDashboardWithServiceManager({
      getAll: () => [service('catscompany', 'CatsCo agent')],
      getService: () => service('catscompany', 'CatsCo agent'),
      start: () => {
        startCalls += 1;
        throw new Error('spawn failed');
      },
      getLogs: () => [],
    } as any);
    await startCatsServer((req, res) => {
      if (req.path === '/api/me') {
        return res.json({ uid: 77, username: 'demo', display_name: 'Demo User' });
      }
      if (req.path === '/api/bots' && req.method === 'GET') {
        return res.json({
          bots: [{ id: 110, username: 'catsco_77_device_x', display_name: 'CatsCo (Test Mac)' }],
        });
      }
      if (req.path === '/api/bots/api-key') {
        return res.json({ api_key: 'agent-api-key' });
      }
      if (req.path === '/api/friends/request' || req.path === '/api/friends/accept') {
        return res.json({ ok: true });
      }
      return res.status(404).json({ error: 'not found' });
    });
    writeEnv([
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/messages',
      'GAUZ_LLM_API_KEY=sk-readiness-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7-highspeed',
      `CATSCO_HTTP_BASE_URL=${catsBaseUrl}`,
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_USER_TOKEN=valid-user-token',
      'CATSCO_USER_UID=77',
    ]);

    const response = await fetch(`${dashboardBaseUrl}/api/cats/bind-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpBaseUrl: catsBaseUrl,
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        botUid: '110',
      }),
    });
    const data = await response.json() as any;
    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));

    assert.equal(response.status, 500);
    assert.equal(data.error, 'spawn failed');
    assert.equal(startCalls, 1);
    assert.equal(env.CATSCO_BOT_UID, undefined);
    assert.equal(env.CATSCO_API_KEY, undefined);
    assert.equal(env.GAUZ_LLM_API_KEY, 'sk-readiness-secret');
    assert.equal(fs.existsSync(path.join(testRoot, '.xiaoba', 'catsco.json')), false);
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

  test('PUT /cats/config/preferences persists typed CatsCo preferences', async () => {
    const response = await fetch(`${dashboardBaseUrl}/api/cats/config/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoConnect: false,
        switchConfirmEnabled: false,
      }),
    });
    const data = await response.json() as any;
    const localConfig = readCatsLocalConfig();

    assert.equal(response.status, 200);
    assert.deepStrictEqual(data.preferences, {
      autoConnect: false,
      switchConfirmEnabled: false,
    });
    assert.deepStrictEqual(localConfig.preferences, {
      autoConnect: false,
      switchConfirmEnabled: false,
    });

    const configResponse = await fetch(`${dashboardBaseUrl}/api/cats/config`);
    const configData = await configResponse.json() as any;
    assert.equal(configData.preferences.autoConnect, false);
    assert.equal(configData.preferences.switchConfirmEnabled, false);
  });

  async function startCatsServer(handler: express.RequestHandler): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(handler);
    catsServer = await listen(app);
    catsBaseUrl = serverBaseUrl(catsServer);
  }

  async function restartDashboardWithServiceManager(serviceManager: any): Promise<void> {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(serviceManager));
    dashboardServer = await listen(app);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);
  }

  function service(name: string, label: string): any {
    return {
      name,
      label,
      command: process.execPath,
      args: ['dist/index.js', name],
      status: 'stopped',
    };
  }

  function writeEnv(lines: string[]): void {
    fs.writeFileSync(path.join(testRoot, '.env'), `${lines.join('\n')}\n`);
  }

  function writeCatsLocalConfig(config: any): void {
    const configDir = path.join(testRoot, '.xiaoba');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'catsco.json'), JSON.stringify(config, null, 2));
  }

  function readCatsLocalConfig(): any {
    return JSON.parse(fs.readFileSync(path.join(testRoot, '.xiaoba', 'catsco.json'), 'utf-8'));
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

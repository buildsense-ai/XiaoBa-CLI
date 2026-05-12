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
    'CATSCOMPANY_HTTP_BASE_URL',
    'CATSCOMPANY_SERVER_URL',
    'CATSCOMPANY_USER_TOKEN',
    'CATSCOMPANY_USER_UID',
    'CATSCOMPANY_USER_NAME',
    'CATSCOMPANY_USER_DISPLAY_NAME',
    'CATSCOMPANY_BOT_UID',
    'CATSCOMPANY_API_KEY',
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
    assert.equal(data.configured, true);
    assert.equal(data.authStatus, 'valid');
    assert.deepStrictEqual(data.user, {
      uid: '42',
      username: 'webuser',
      display_name: 'Web User',
    });
    assert.equal(data.topicId, 'p2p_42_110');
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

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(env.CATSCO_USER_TOKEN, 'new-user-token');
    assert.equal(env.CATSCOMPANY_USER_TOKEN, 'new-user-token');
    assert.equal(env.CATSCO_USER_UID, '77');
    assert.equal(env.CATSCOMPANY_USER_UID, '77');
    assert.equal(env.CATSCO_USER_DISPLAY_NAME, 'Demo User');
    assert.equal(env.CATSCOMPANY_USER_DISPLAY_NAME, 'Demo User');
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

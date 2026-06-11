import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { createApiRouter } from '../src/dashboard/routes/api';
import type { ServiceInfo } from '../src/dashboard/service-manager';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';

describe('dashboard device connector pairing link API', () => {
  let originalCwd: string;
  let testRoot: string;
  let server: Server | undefined;
  let baseUrl: string;
  let originalFetch: typeof fetch;
  let fetchCalls: Array<{ url: string; body: any }>;
  let service: ServiceInfo;
  let startCalls: string[];
  const originalEnv: Record<string, string | undefined> = {};
  const envKeys = ['XIAOBA_CONFIG_PATH', 'XIAOBA_RUNTIME_PROFILE_PATH'];

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-device-link-api-'));
    process.chdir(testRoot);
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
    }
    process.env.XIAOBA_CONFIG_PATH = path.join(testRoot, 'config.json');
    process.env.XIAOBA_RUNTIME_PROFILE_PATH = path.join(testRoot, 'runtime-profile.json');

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      fetchCalls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        connector_token: 'connector-token-1',
        expires_in: 3600,
        device: {
          device_id: 'dev-1',
          installation_id: 'install-1',
          display_name: 'Office PC',
          owner_user_id: 'user-1',
          capabilities: ['read_file', 'glob', 'grep'],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    service = {
      name: 'device-connector',
      label: 'CatsCo Device Connector',
      command: 'node',
      args: ['dist/index.js', 'device-connector'],
      status: 'stopped',
    };
    startCalls = [];
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({
      getAll: () => [service],
      getService: () => service,
      start: (name: string) => {
        startCalls.push(name);
        service = { ...service, status: 'running', pid: 1001, startedAt: Date.now() };
        return service;
      },
      restart: (name: string) => {
        startCalls.push(`restart:${name}`);
        service = { ...service, status: 'running', pid: 1002, startedAt: Date.now() };
        return service;
      },
      stop: () => service,
      getLogs: () => [],
    } as any));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    process.chdir(originalCwd);
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('pairs and starts the saved connector without echoing the pairing code', async () => {
    const response = await originalFetch(`${baseUrl}/api/cats/device-connector/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'PAIR123456',
        http_base_url: 'https://app.catsco.cc',
        server_url: 'wss://app.catsco.cc/v0/channels',
      }),
    });
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.deepEqual(startCalls, ['device-connector']);
    assert.equal(fetchCalls[0].url, 'https://app.catsco.cc/api/device-connectors/enroll');
    assert.equal(fetchCalls[0].body.pairing_code, 'PAIR123456');
    assert.equal(fetchCalls[0].body.capabilities.includes('execute_shell'), false);
    assert.equal(body.connectorStarted, true);
    assert.equal(JSON.stringify(body).includes('PAIR123456'), false);

    const local = createCatsCoLocalConfigService({ runtimeRoot: testRoot }).load();
    assert.equal(local.deviceConnector?.token, 'connector-token-1');
    assert.equal(local.deviceConnector?.deviceId, 'dev-1');
    assert.deepEqual(local.deviceConnector?.capabilities, ['read_file', 'glob', 'grep']);
  });

  test('restarts the connector when pairing arrives while it is already running', async () => {
    service = { ...service, status: 'running', pid: 999 };

    const response = await originalFetch(`${baseUrl}/api/cats/device-connector/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'PAIR654321' }),
    });
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.deepEqual(startCalls, ['restart:device-connector']);
    assert.equal(body.connectorRestarted, true);
  });

  test('rejects malformed pairing codes before calling the platform', async () => {
    const response = await originalFetch(`${baseUrl}/api/cats/device-connector/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad code with spaces' }),
    });

    assert.equal(response.status, 400);
    assert.equal(fetchCalls.length, 0);
    assert.deepEqual(startCalls, []);
  });

  test('auto-starts an already paired connector on desktop launch', async () => {
    createCatsCoLocalConfigService({ runtimeRoot: testRoot }).writeDeviceConnectorEnrollment({
      httpBaseUrl: 'https://app.catsco.cc',
      serverUrl: 'wss://app.catsco.cc/v0/channels',
    }, {
      token: 'saved-token',
      deviceId: 'saved-device',
      installationId: 'saved-install',
      capabilities: ['read_file', 'glob', 'grep'],
    });

    const response = await originalFetch(`${baseUrl}/api/cats/device-connector/ensure-running`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.deepEqual(startCalls, ['device-connector']);
    assert.equal(body.connectorStarted, true);
  });

  test('does not auto-start before a device is paired', async () => {
    const response = await originalFetch(`${baseUrl}/api/cats/device-connector/ensure-running`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await response.json() as any;

    assert.equal(response.status, 409);
    assert.equal(body.reason, 'DEVICE_CONNECTOR_NOT_PAIRED');
    assert.deepEqual(startCalls, []);
  });
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

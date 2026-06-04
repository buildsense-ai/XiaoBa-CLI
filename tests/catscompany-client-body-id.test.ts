import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { CatsClient } from '../src/catscompany/client';

describe('CatsCompany client body identity', () => {
  const servers: WebSocketServer[] = [];
  const httpServers: Server[] = [];
  const identityEnvKeys = [
    'CATSCO_BODY_ID',
    'CATSCOMPANY_BODY_ID',
    'CATSCO_DEVICE_ID',
    'CATSCOMPANY_DEVICE_ID',
    'CATSCO_INSTALLATION_ID',
    'CATSCOMPANY_INSTALLATION_ID',
  ];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of identityEnvKeys) {
      originalEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
    for (const server of httpServers.splice(0)) {
      server.close();
    }
    for (const key of identityEnvKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  function clearIdentityEnv(): void {
    for (const key of identityEnvKeys) {
      delete process.env[key];
    }
  }

  test('sends body identity headers during websocket connect', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    const headersPromise = new Promise<Record<string, string | string[] | undefined>>(resolve => {
      server.once('connection', (socket, request) => {
        resolve(request.headers);
        socket.close();
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-test',
      installationId: 'install-test',
    });
    client.on('error', () => undefined);

    client.connect();
    const headers = await headersPromise;
    client.disconnect();

    assert.equal(headers['x-api-key'], 'cc-test-key');
    assert.equal(headers['x-catsco-body-id'], 'body-test');
    assert.equal(headers['x-catsco-installation-id'], 'install-test');
  });

  test('fails before connecting when body id is missing', () => {
    clearIdentityEnv();
    const client = new CatsClient({
      serverUrl: 'ws://127.0.0.1:1',
      apiKey: 'cc-test-key',
    });

    assert.throws(() => client.connect(), /bodyId missing/);
  });

  test('registers device capabilities through CatsCompany HTTP API', async () => {
    const requestPromise = new Promise<{ url?: string; method?: string; headers: Record<string, string | string[] | undefined>; body: any }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ url: req.url, method: req.method, headers: req.headers, body });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ device: { deviceId: body.device_id } }));
        });
      });
      httpServers.push(server);
      server.listen(0, '127.0.0.1', () => {
        void (async () => {
          const address = server.address() as AddressInfo;
          const client = new CatsClient({
            serverUrl: 'ws://127.0.0.1:1/v0/channels',
            httpBaseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: 'cc-test-key',
            bodyId: 'body-test',
            installationId: 'install-test',
          });
          await client.registerDevice({
            device_id: 'install-test',
            display_name: 'Test Device',
            body_id: 'body-test',
            installation_id: 'install-test',
            status: 'online',
            capabilities: ['read_file', 'send_file'],
          });
        })().catch(reject);
      });
    });

    const request = await requestPromise;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/devices/register');
    assert.equal(request.headers.authorization, 'ApiKey cc-test-key');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(request.body, {
      device_id: 'install-test',
      display_name: 'Test Device',
      body_id: 'body-test',
      installation_id: 'install-test',
      status: 'online',
      capabilities: ['read_file', 'send_file'],
    });
  });
});

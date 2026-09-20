import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { CatsClient } from '../src/catscompany/client';

describe('CatsCompany client endpoint failover', () => {
  const servers: WebSocketServer[] = [];
  const netServers: NetServer[] = [];
  const httpServers: HttpServer[] = [];
  const sockets: WsSocket[] = [];
  const clients: CatsClient[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      try {
        client.disconnect();
      } catch {
        // Cleanup is best-effort; the test may have already torn the client down.
      }
    }
    for (const socket of sockets.splice(0)) {
      try {
        socket.terminate();
      } catch {
        // The socket may already be closed; cleanup is best-effort.
      }
    }
    for (const server of servers.splice(0)) {
      server.close();
    }
    for (const server of netServers.splice(0)) {
      server.close();
    }
    for (const server of httpServers.splice(0)) {
      server.close();
    }
  });

  async function withTimeout<T>(promise: Promise<T>, timeoutMs = 4000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function trackClient(client: CatsClient): CatsClient {
    clients.push(client);
    return client;
  }

  async function startHandshakeServer(): Promise<{ url: string; connectionCount: () => number }> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    let count = 0;
    server.on('connection', socket => {
      count += 1;
      sockets.push(socket);
      socket.on('message', (data: Buffer) => {
        let message: any;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message?.hi && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({
            ctrl: { code: 200, id: '1', params: { build: 'catscompany', uid: '7001', name: 'failover-bot' } },
          }));
        }
      });
    });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    return { url: `ws://127.0.0.1:${address.port}/v0/channels`, connectionCount: () => count };
  }

  async function reserveDeadPort(): Promise<number> {
    const server = createNetServer();
    netServers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  }

  async function reserveForbiddenUpgradePort(): Promise<number> {
    const server = createHttpServer((_req, res) => {
      res.statusCode = 403;
      res.end('forbidden');
    });
    server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    httpServers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  test('switches to the sibling endpoint after the configured endpoint fails to connect', async () => {
    const live = await startHandshakeServer();
    const deadPort = await reserveDeadPort();
    const deadUrl = `ws://127.0.0.1:${deadPort}/v0/channels`;
    const readyUrls: string[] = [];
    const client = trackClient(new CatsClient({
      serverUrl: deadUrl,
      endpointCandidates: [deadUrl, live.url],
      apiKey: 'cc-test-key',
      bodyId: 'body-failover',
      reconnectBaseDelayMs: 30,
      reconnectMaxDelayMs: 120,
      onEndpointReady: url => readyUrls.push(url),
    }));
    client.on('error', () => undefined);
    client.connect();
    await withTimeout(new Promise<void>(resolve => client.once('ready', () => resolve())));
    client.disconnect();

    assert.deepEqual(readyUrls, [live.url]);
    assert.equal(client.getActiveServerUrl(), live.url);
    assert.equal(live.connectionCount(), 1);
  });

  test('stays sticky on the working endpoint when the connection drops', async () => {
    const live = await startHandshakeServer();
    const deadPort = await reserveDeadPort();
    const deadUrl = `ws://127.0.0.1:${deadPort}/v0/channels`;
    const client = trackClient(new CatsClient({
      serverUrl: live.url,
      endpointCandidates: [live.url, deadUrl],
      apiKey: 'cc-test-key',
      bodyId: 'body-sticky',
      reconnectBaseDelayMs: 30,
      reconnectMaxDelayMs: 120,
    }));
    client.on('error', () => undefined);
    client.connect();
    await withTimeout(new Promise<void>(resolve => client.once('ready', () => resolve())));
    const firstSocket = sockets[0];
    assert.ok(firstSocket, 'expected a server-side socket');
    firstSocket.close();
    await withTimeout(new Promise<void>(resolve => client.once('ready', () => resolve())));
    client.disconnect();

    assert.equal(live.connectionCount(), 2);
    assert.equal(client.getActiveServerUrl(), live.url);
  });

  test('derives sibling candidates from a CatsCo url and applies the preferred family', () => {
    const client = trackClient(new CatsClient({
      serverUrl: 'wss://app.catsco.cc/v0/channels',
      apiKey: 'k',
      bodyId: 'b',
    }));
    assert.deepEqual(client.getEndpointCandidates(), [
      'wss://app.catsco.cc/v0/channels',
      'wss://app.catsco.cn/v0/channels',
    ]);
    const preferred = trackClient(new CatsClient({
      serverUrl: 'wss://app.catsco.cc/v0/channels',
      preferredDomainFamily: 'cn',
      apiKey: 'k',
      bodyId: 'b',
    }));
    assert.deepEqual(preferred.getEndpointCandidates(), [
      'wss://app.catsco.cn/v0/channels',
      'wss://app.catsco.cc/v0/channels',
    ]);
  });

  test('does not rotate endpoints when the server rejects the handshake with 403', async () => {
    const live = await startHandshakeServer();
    const authPort = await reserveForbiddenUpgradePort();
    const authUrl = `ws://127.0.0.1:${authPort}/v0/channels`;
    const client = trackClient(new CatsClient({
      serverUrl: authUrl,
      endpointCandidates: [authUrl, live.url],
      apiKey: 'cc-test-key',
      bodyId: 'body-auth',
      reconnectBaseDelayMs: 30,
      reconnectMaxDelayMs: 60,
    }));
    client.on('error', () => undefined);
    client.connect();
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    client.disconnect();

    assert.equal(live.connectionCount(), 0);
    assert.equal(client.getActiveServerUrl(), null);
  });

  test('friend-request accept follows the client HTTP base instead of a hardcoded default', async () => {
    const live = await startHandshakeServer();
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      requests.push(String(url));
      return { ok: true, json: async () => ({}) } as any;
    }) as any;
    try {
      const client = trackClient(new CatsClient({
        serverUrl: live.url,
        apiKey: 'cc-test-key',
        bodyId: 'body-friend',
      }));
      client.on('error', () => undefined);
      client.connect();
      await withTimeout(new Promise<void>(resolve => client.once('ready', () => resolve())));

      const socket = sockets[sockets.length - 1];
      assert.ok(socket, 'expected a server-side socket');
      socket.send(JSON.stringify({ pres: { what: 'friend_request', src: 4242 } }));
      for (let i = 0; i < 50 && requests.length === 0; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      client.disconnect();

      const expectedBase = live.url.replace('ws://', 'http://').replace(/\/v0\/channels$/, '');
      assert.deepEqual(requests, [`${expectedBase}/api/friends/accept`]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

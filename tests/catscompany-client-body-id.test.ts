import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { CatsClient, type CatsDeviceRpcMessage } from '../src/catscompany/client';

describe('CatsCompany client body identity', () => {
  const servers: WebSocketServer[] = [];
  const httpServers: HttpServer[] = [];
  const netServers: NetServer[] = [];
  const netSockets: Socket[] = [];
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
    for (const socket of netSockets.splice(0)) {
      socket.destroy();
    }
    for (const server of netServers.splice(0)) {
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

  async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
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

  test('retries when websocket upgrade handshake stalls', async () => {
    let connections = 0;
    const server = createNetServer(socket => {
      connections++;
      netSockets.push(socket);
      socket.on('error', () => undefined);
    });
    netServers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const secondConnection = new Promise<void>(resolve => {
      server.on('connection', () => {
        if (connections >= 2) resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-test',
      connectTimeoutMs: 30,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
    });
    client.on('error', () => undefined);

    try {
      client.connect();
      await withTimeout(secondConnection);
      assert.ok(connections >= 2);
    } finally {
      client.disconnect();
    }
  });

  test('reconnects when CatsCompany ready handshake is not received', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    let connections = 0;
    const socketClosed = new Promise<void>(resolve => {
      server.on('connection', socket => {
        connections++;
        if (connections === 1) {
          socket.once('close', () => resolve());
        }
      });
    });
    const secondConnection = new Promise<void>(resolve => {
      server.on('connection', () => {
        if (connections >= 2) resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-test',
      readyTimeoutMs: 30,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
    });
    client.on('error', () => undefined);
    client.connect();

    await withTimeout(socketClosed);
    await withTimeout(secondConnection);
    assert.ok(connections >= 2);
    client.disconnect();
  });

  test('keeps the process alive while waiting to reconnect', () => {
    const client = new CatsClient({
      serverUrl: 'ws://127.0.0.1:1',
      apiKey: 'cc-test-key',
      bodyId: 'body-test',
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 1000,
    });

    const internal = client as any;
    internal.scheduleReconnect();

    try {
      assert.equal(internal.reconnectTimer?.hasRef?.(), true);
    } finally {
      client.disconnect();
    }
  });

  test('includes local device registration in websocket hi', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    const hiPromise = new Promise<any>(resolve => {
      server.once('connection', socket => {
        socket.once('message', data => {
          resolve(JSON.parse(data.toString()));
          socket.close();
        });
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-test',
      installationId: 'install-test',
      deviceRegistration: {
        device_id: 'install-test',
        display_name: 'Test Device',
        body_id: 'body-test',
        installation_id: 'install-test',
        status: 'online',
        capabilities: ['read_file'],
      },
    });
    client.on('error', () => undefined);
    client.connect();

    const hi = await hiPromise;
    client.disconnect();

    assert.deepEqual(hi.hi.device, {
      device_id: 'install-test',
      display_name: 'Test Device',
      body_id: 'body-test',
      installation_id: 'install-test',
      status: 'online',
      capabilities: ['read_file'],
    });
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
            model_status: {
              source: 'relay',
              model: 'MiniMax-M3',
              updated_at: 1782790000000,
            },
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
      model_status: {
        source: 'relay',
        model: 'MiniMax-M3',
        updated_at: 1782790000000,
      },
    });
    assert.equal(request.body.apiUrl, undefined);
    assert.equal(request.body.apiKey, undefined);
  });

  test('loads agent context history with bot auth and a stable cursor', async () => {
    const requestPromise = new Promise<{ url?: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const server = createServer((req, res) => {
        resolve({ url: req.url, headers: req.headers });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          messages: [{
            seq: 41,
            topic_id: 'grp-test',
            content: 'hello',
            context_role: 'user',
            context_eligible: true,
          }],
          topic_id: 'grp-test',
          agent_uid: 63,
          has_more: true,
          next_before_id: 41,
        }));
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
          });
          const page = await client.getAgentContextHistory('grp-test', { beforeId: 88, limit: 25 });
          assert.equal(page.agent_uid, 63);
          assert.equal(page.has_more, true);
          assert.equal(page.next_before_id, 41);
          assert.equal(page.messages[0]?.context_role, 'user');
        })().catch(reject);
      });
    });

    const request = await requestPromise;
    const url = new URL(request.url || '/', 'http://localhost');
    assert.equal(url.pathname, '/api/messages');
    assert.equal(url.searchParams.get('topic_id'), 'grp-test');
    assert.equal(url.searchParams.get('agent_context'), '1');
    assert.equal(url.searchParams.get('latest'), '1');
    assert.equal(url.searchParams.get('limit'), '25');
    assert.equal(url.searchParams.get('before_id'), '88');
    assert.equal(request.headers.authorization, 'ApiKey cc-test-key');
  });

  test('rejects message history from servers without the safe agent context contract', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ messages: [{ seq: 1, content: 'legacy history' }] }));
    });
    httpServers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: 'ws://127.0.0.1:1/v0/channels',
      httpBaseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-test',
    });

    await assert.rejects(
      client.getAgentContextHistory('usr-test'),
      /does not support safe agent context history/,
    );
  });

  test('emits device rpc requests outside the regular message stream', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    server.once('connection', socket => {
      socket.once('message', () => {
        socket.send(JSON.stringify({
          device_rpc: {
            type: 'request',
            request_id: 'rpc-inbound-1',
            grant_id: 'grant-1',
            device_id: 'install-test',
            operation: 'ping',
          },
        }));
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

    let regularMessageSeen = false;
    client.on('message', () => {
      regularMessageSeen = true;
    });
    const requestPromise = new Promise<CatsDeviceRpcMessage>(resolve => {
      client.once('device_rpc_request', resolve);
    });

    client.connect();
    const request = await requestPromise;
    client.disconnect();

    assert.equal(request.request_id, 'rpc-inbound-1');
    assert.equal(request.operation, 'ping');
    assert.equal(regularMessageSeen, false);
  });

  test('sends device rpc requests and resolves matching results', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    const requestPromise = new Promise<any>(resolve => {
      server.once('connection', socket => {
        socket.on('message', data => {
          const msg = JSON.parse(data.toString());
          if (msg.hi) {
            socket.send(JSON.stringify({
              ctrl: {
                id: msg.hi.id,
                code: 200,
                params: {
                  build: 'catscompany',
                  ver: '0.1.0',
                  features: ['client_msg_id', 'device_rpc'],
                  uid: 'usr42',
                  name: 'Agent',
                },
              },
            }));
            return;
          }
          if (msg.device_rpc?.type === 'request') {
            resolve(msg.device_rpc);
            socket.send(JSON.stringify({ ctrl: { id: msg.device_rpc.id, code: 200, text: 'ok' } }));
            socket.send(JSON.stringify({
              device_rpc: {
                type: 'result',
                request_id: msg.device_rpc.request_id,
                result: { ok: true },
              },
            }));
          }
        });
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-agent',
      installationId: 'install-agent',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    const result = await client.sendDeviceRpcRequest({
      request_id: 'rpc-outbound-1',
      grant_id: 'grant-1',
      device_id: 'install-test',
      operation: 'ping',
      payload: { value: 1 },
    });
    const request = await requestPromise;
    client.disconnect();

    assert.equal(request.request_id, 'rpc-outbound-1');
    assert.equal(request.grant_id, 'grant-1');
    assert.equal(request.operation, 'ping');
    assert.deepEqual(result.result, { ok: true });
  });

  test('rejects device rpc request when ack fails after an early result', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    server.once('connection', socket => {
      socket.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.hi) {
          socket.send(JSON.stringify({
            ctrl: {
              id: msg.hi.id,
              code: 200,
              params: {
                build: 'catscompany',
                ver: '0.1.0',
                features: ['client_msg_id', 'device_rpc'],
                uid: 'usr42',
                name: 'Agent',
              },
            },
          }));
          return;
        }
        if (msg.device_rpc?.type === 'request') {
          socket.send(JSON.stringify({
            device_rpc: {
              type: 'result',
              request_id: msg.device_rpc.request_id,
              result: { ok: true },
            },
          }));
          socket.send(JSON.stringify({ ctrl: { id: msg.device_rpc.id, code: 500, text: 'nack after result' } }));
        }
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-agent',
      installationId: 'install-agent',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    await assert.rejects(
      () => client.sendDeviceRpcRequest({
        request_id: 'rpc-early-result-nack',
        grant_id: 'grant-1',
        device_id: 'install-test',
        operation: 'ping',
      }),
      /ack 500/
    );
    client.disconnect();
  });

  test('rejects device rpc results whose scope does not match the pending request', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    server.once('connection', socket => {
      socket.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.hi) {
          socket.send(JSON.stringify({
            ctrl: {
              id: msg.hi.id,
              code: 200,
              params: {
                build: 'catscompany',
                ver: '0.1.0',
                features: ['client_msg_id', 'device_rpc'],
                uid: 'usr42',
                name: 'Agent',
              },
            },
          }));
          return;
        }
        if (msg.device_rpc?.type === 'request') {
          socket.send(JSON.stringify({ ctrl: { id: msg.device_rpc.id, code: 200, text: 'ok' } }));
          socket.send(JSON.stringify({
            device_rpc: {
              type: 'result',
              request_id: msg.device_rpc.request_id,
              grant_id: 'wrong-grant',
              device_id: msg.device_rpc.device_id,
              operation: msg.device_rpc.operation,
              tool_name: msg.device_rpc.tool_name,
              result: { ok: true },
            },
          }));
        }
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-agent',
      installationId: 'install-agent',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    await assert.rejects(
      () => client.sendDeviceRpcRequest({
        request_id: 'rpc-scope-mismatch',
        grant_id: 'grant-1',
        device_id: 'install-test',
        operation: 'read_file',
        tool_name: 'read_file',
      }),
      /scope does not match/
    );
    client.disconnect();
  });

  test('rejects thin tool rpc results whose scope does not match the pending request', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    server.once('connection', socket => {
      socket.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.hi) {
          socket.send(JSON.stringify({
            ctrl: {
              id: msg.hi.id,
              code: 200,
              params: {
                build: 'catscompany',
                ver: '0.1.0',
                features: ['client_msg_id', 'thin_tool_rpc'],
                uid: 'usr42',
                name: 'Agent',
              },
            },
          }));
          return;
        }
        if (msg.thin_tool_rpc?.type === 'request') {
          socket.send(JSON.stringify({ ctrl: { id: msg.thin_tool_rpc.id, code: 200, text: 'ok' } }));
          socket.send(JSON.stringify({
            thin_tool_rpc: {
              type: 'result',
              request_id: msg.thin_tool_rpc.request_id,
              target_owner_user_id: msg.thin_tool_rpc.target_owner_user_id,
              target_device_id: msg.thin_tool_rpc.target_device_id,
              device_id: msg.thin_tool_rpc.target_device_id,
              tool_name: 'write_file',
              result: { ok: true },
            },
          }));
        }
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-agent',
      installationId: 'install-agent',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    await assert.rejects(
      () => client.sendThinToolRpcRequest({
        request_id: 'thin-scope-mismatch',
        target_owner_user_id: 'usr7',
        target_device_id: 'install-test',
        tool_name: 'read_file',
        payload: { args: { file_path: '/tmp/a.txt' } },
      }),
      /scope does not match/
    );
    client.disconnect();
  });

  test('rejects thin tool rpc results that omit pending request scope fields', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    server.once('connection', socket => {
      socket.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.hi) {
          socket.send(JSON.stringify({
            ctrl: {
              id: msg.hi.id,
              code: 200,
              params: {
                build: 'catscompany',
                ver: '0.1.0',
                features: ['client_msg_id', 'thin_tool_rpc'],
                uid: 'usr42',
                name: 'Agent',
              },
            },
          }));
          return;
        }
        if (msg.thin_tool_rpc?.type === 'request') {
          socket.send(JSON.stringify({ ctrl: { id: msg.thin_tool_rpc.id, code: 200, text: 'ok' } }));
          socket.send(JSON.stringify({
            thin_tool_rpc: {
              type: 'result',
              request_id: msg.thin_tool_rpc.request_id,
              result: { ok: true },
            },
          }));
        }
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-agent',
      installationId: 'install-agent',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    await assert.rejects(
      () => client.sendThinToolRpcRequest({
        request_id: 'thin-missing-scope',
        target_owner_user_id: 'usr7',
        target_device_id: 'install-test',
        tool_name: 'read_file',
        payload: { args: { file_path: '/tmp/a.txt' } },
      }),
      /scope does not match/
    );
    client.disconnect();
  });

  test('rejects pending thin tool rpc when websocket closes before result', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    server.once('connection', socket => {
      socket.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.hi) {
          socket.send(JSON.stringify({
            ctrl: {
              id: msg.hi.id,
              code: 200,
              params: {
                build: 'catscompany',
                ver: '0.1.0',
                features: ['client_msg_id', 'thin_tool_rpc'],
                uid: 'usr42',
                name: 'Agent',
              },
            },
          }));
          return;
        }
        if (msg.thin_tool_rpc?.type === 'request') {
          socket.send(JSON.stringify({ ctrl: { id: msg.thin_tool_rpc.id, code: 200, text: 'ok' } }));
          socket.close();
        }
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-agent',
      installationId: 'install-agent',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    await assert.rejects(
      () => client.sendThinToolRpcRequest({
        request_id: 'thin-close-before-result',
        target_owner_user_id: 'usr7',
        target_device_id: 'install-test',
        tool_name: 'read_file',
        payload: { args: { file_path: '/tmp/a.txt' } },
      }, 30000),
      /closed before receiving Thin Tool RPC result/
    );
    client.disconnect();
  });

  test('sends device rpc results with websocket ack', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    const resultPromise = new Promise<any>(resolve => {
      server.once('connection', socket => {
        socket.on('message', data => {
          const msg = JSON.parse(data.toString());
          if (msg.hi) {
            socket.send(JSON.stringify({
              ctrl: {
                id: msg.hi.id,
                code: 200,
                params: { build: 'catscompany', features: ['client_msg_id', 'device_rpc'], uid: 'usr7', name: 'Device' },
              },
            }));
            return;
          }
          if (msg.device_rpc?.type === 'result') {
            resolve(msg.device_rpc);
            socket.send(JSON.stringify({ ctrl: { id: msg.device_rpc.id, code: 200, text: 'ok' } }));
          }
        });
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-device',
      installationId: 'install-device',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    await client.sendDeviceRpcResult({
      request_id: 'rpc-result-1',
      result: { ok: true },
    });
    const result = await resultPromise;
    client.disconnect();

    assert.equal(result.request_id, 'rpc-result-1');
    assert.deepEqual(result.result, { ok: true });
  });

  test('sends device rpc progress with ack when server advertises device_rpc_progress', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    const progressPromise = new Promise<any>(resolve => {
      server.once('connection', socket => {
        socket.on('message', data => {
          const msg = JSON.parse(data.toString());
          if (msg.hi) {
            socket.send(JSON.stringify({
              ctrl: {
                id: msg.hi.id,
                code: 200,
                params: {
                  build: 'catscompany',
                  features: ['client_msg_id', 'device_rpc', 'device_rpc_progress'],
                  uid: 'usr-prog',
                  name: 'Progress',
                },
              },
            }));
            return;
          }
          if (msg.device_rpc?.type === 'progress') {
            resolve(msg.device_rpc);
            socket.send(JSON.stringify({ ctrl: { id: msg.device_rpc.id, code: 200, text: 'ok' } }));
          }
        });
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-progress',
      installationId: 'install-progress',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    await client.sendDeviceRpcProgress({
      request_id: 'rpc-progress-1',
      progress: { processed: 1, total: 2, completed: 1, failed: 0, skipped: 0, remaining: 1, provider: 'codex', phase: 'importing' },
    });
    const progress = await progressPromise;
    client.disconnect();

    assert.equal(progress.request_id, 'rpc-progress-1');
    assert.equal(progress.progress.phase, 'importing');
  });

  test('sends device rpc progress fire-and-forget when server lacks device_rpc_progress', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));

    const progressPromise = new Promise<any>(resolve => {
      server.once('connection', socket => {
        socket.on('message', data => {
          const msg = JSON.parse(data.toString());
          if (msg.hi) {
            // Legacy server: advertises device_rpc but NOT device_rpc_progress.
            socket.send(JSON.stringify({
              ctrl: {
                id: msg.hi.id,
                code: 200,
                params: {
                  build: 'catscompany',
                  features: ['client_msg_id', 'device_rpc'],
                  uid: 'usr-legacy',
                  name: 'Legacy',
                },
              },
            }));
            return;
          }
          if (msg.device_rpc?.type === 'progress') {
            resolve(msg.device_rpc);
            // Legacy server does NOT send a ctrl ack for progress.
          }
        });
      });
    });

    const address = server.address() as AddressInfo;
    const client = new CatsClient({
      serverUrl: `ws://127.0.0.1:${address.port}`,
      apiKey: 'cc-test-key',
      bodyId: 'body-legacy',
      installationId: 'install-legacy',
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => {
      client.once('ready', () => resolve());
      client.connect();
    });

    // Fire-and-forget: must resolve immediately without waiting for a server ack.
    const start = Date.now();
    await client.sendDeviceRpcProgress({
      request_id: 'rpc-progress-legacy',
      progress: { processed: 1, total: 2, completed: 1, failed: 0, skipped: 0, remaining: 1, provider: 'codex', phase: 'importing' },
    });
    const elapsed = Date.now() - start;
    const progress = await progressPromise;
    client.disconnect();

    assert.equal(progress.request_id, 'rpc-progress-legacy');
    assert.equal(progress.progress.phase, 'importing');
    // Must resolve well under the 10s ack timeout — no per-progress ack wait.
    assert.ok(elapsed < 2000, `fire-and-forget progress must not wait for ack (elapsed=${elapsed}ms)`);
  });
});

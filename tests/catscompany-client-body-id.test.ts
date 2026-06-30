import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { CatsClient, type CatsDeviceRpcMessage } from '../src/catscompany/client';

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
});

#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CatsClient, type MessageContext } from '../src/catscompany/client';
import { CatsCoDeviceConnector } from '../src/catscompany/device-connector';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const catsRepo = path.resolve(process.env.CATSCOMPANY_REPO || path.join(rootDir, '..', 'cats-company'));
const dbDsn = String(process.env.CATSCOMPANY_E2E_DB_DSN || '').trim();

if (!dbDsn) {
  console.log('[cross-repo:e2e] skipped: CATSCOMPANY_E2E_DB_DSN is not set');
  process.exit(0);
}

if (!fs.existsSync(path.join(catsRepo, 'go.mod'))) {
  throw new Error(`cats-company repo not found at ${catsRepo}`);
}

const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const tmpRoot = path.join(rootDir, 'tmp', `catsco-cross-repo-e2e-${runId}`);
const deviceRoot = path.join(tmpRoot, 'device');
fs.mkdirSync(deviceRoot, { recursive: true });

const sentinel = `catsco-cross-repo-e2e-${runId}`;
const sentinelFile = path.join(deviceRoot, 'sentinel.txt');
fs.writeFileSync(sentinelFile, `${sentinel}\n`, 'utf8');

let httpBaseUrl = '';
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let connector: CatsCoDeviceConnector | undefined;
let botClient: CatsClient | undefined;

main().catch(error => {
  console.error(`[cross-repo:e2e] failed: ${error?.message || error}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const httpPort = await findFreePort();
  const grpcPort = await findFreePort();
  httpBaseUrl = `http://127.0.0.1:${httpPort}`;
  const wsUrl = `ws://127.0.0.1:${httpPort}/v0/channels`;
  const configPath = path.join(tmpRoot, 'cats-company-e2e.conf');
  fs.writeFileSync(configPath, JSON.stringify({
    listen: `127.0.0.1:${httpPort}`,
    grpc_port: `127.0.0.1:${grpcPort}`,
    database: {
      driver: 'postgres',
      dsn: dbDsn,
      max_open_conns: 4,
      max_idle_conns: 2,
    },
    websocket: { path: '/v0/channels' },
    static: { dir: '' },
  }, null, 2), 'utf8');

  try {
    serverProcess = startCatsCompanyServer(configPath);
    await waitForReady(`${httpBaseUrl}/ready`, 45_000);

  const user = await api('POST', '/api/auth/register', {
    username: `e2e_user_${runId.slice(-10)}`,
    password: 'password123',
    display_name: 'E2E User',
  }, undefined, 201);

  const token = stringField(user, 'token');
  const userId = numberField(user, 'uid');
  assert(token, 'register response missing token');
  assert(userId > 0, 'register response missing uid');

  const bot = await api('POST', '/api/bots', {
    username: `e2e_agent_${runId.slice(-10)}`,
    password: 'password123',
    display_name: 'E2E Agent',
    model: 'e2e',
  }, token, 201);

  const botUid = numberField(bot, 'uid');
  const botApiKey = stringField(bot, 'api_key');
  assert(botUid > 0, 'create bot response missing uid');
  assert(botApiKey, 'create bot response missing api_key');

  const pairing = await api('POST', '/api/device-connectors/pairings', {
    device_name: 'E2E Device',
    capabilities: ['read_file', 'glob', 'grep'],
  }, token);

  const pairingCode = stringField(pairing, 'pairing_code');
  const pairingId = stringField(pairing, 'pairing_id');
  assert(pairingCode, 'pairing response missing pairing_code');
  assert(pairingId, 'pairing response missing pairing_id');

  const deviceId = `e2e-device-${runId.slice(-10)}`;
  const enrollment = await api('POST', '/api/device-connectors/enroll', {
    pairing_code: pairingCode,
    device_id: deviceId,
    installation_id: deviceId,
    device_name: 'E2E Device',
    capabilities: ['read_file', 'glob', 'grep'],
  });

  const connectorToken = stringField(enrollment, 'connector_token');
  assert(connectorToken, 'enroll response missing connector_token');

  const pairingStatus = await api('GET', `/api/device-connectors/pairings/${pairingId}`, undefined, token);
  assert(stringField(pairingStatus, 'status') === 'consumed', 'pairing was not consumed');

  connector = new CatsCoDeviceConnector({
    serverUrl: wsUrl,
    httpBaseUrl,
    authMode: 'device_connector',
    connectorToken,
    bodyId: deviceId,
    installationId: deviceId,
    deviceName: 'E2E Device',
    capabilities: ['read_file', 'glob', 'grep'],
  });
  await connector.start();
  await waitForRoutableDevice(token, deviceId, 20_000);

  botClient = new CatsClient({
    serverUrl: wsUrl,
    httpBaseUrl,
    apiKey: botApiKey,
    bodyId: `body-e2e-${runId.slice(-10)}`,
    installationId: `body-e2e-${runId.slice(-10)}`,
  });
  const botReady = waitForClientReady(botClient, 20_000);
  botClient.connect();
  await botReady;

  const openAgent = await api('POST', '/api/agents/open', {
    agent_uid: botUid,
  }, token);
  const topic = stringField(openAgent, 'topic');
  assert(topic, 'open agent response missing topic');

  const messagePromise = waitForMessageWithGrant(botClient, topic, 20_000);
  await api('POST', '/api/messages/send', {
    topic_id: topic,
    type: 'text',
    content: 'Please read my local sentinel file.',
  }, token);

  const incoming = await messagePromise;
  const identity = incoming.metadata?.catsco_identity as Record<string, unknown> | undefined;
  const grants = Array.isArray(identity?.device_grants) ? identity?.device_grants as Record<string, unknown>[] : [];
  const grant = grants[0];
  assert(grant, 'message metadata missing device grant');

  assert(stringField(grant, 'actorUserId') === `usr${userId}`, 'grant actor did not match user');
  assert(stringField(grant, 'agentId') === `usr${botUid}`, 'grant agent did not match bot');
  assert(stringField(grant, 'deviceId') === deviceId, 'grant device did not match connector');

  const result = await botClient.sendDeviceRpcRequest({
    request_id: `rpc-${runId}`,
    grant_id: stringField(grant, 'grantId'),
    session_key: stringField(grant, 'sessionKey'),
    topic_id: stringField(grant, 'topicId'),
    topic_type: stringField(grant, 'topicType'),
    actor_user_id: stringField(grant, 'actorUserId'),
    agent_id: stringField(grant, 'agentId'),
    agent_body_id: stringField(grant, 'agentBodyId'),
    device_id: stringField(grant, 'deviceId'),
    device_body_id: stringField(grant, 'deviceBodyId'),
    device_installation_id: stringField(grant, 'deviceInstallationId'),
    operation: 'read_file',
    tool_name: 'read_file',
    payload: { args: { file_path: sentinelFile, limit: 20 } },
  }, 20_000);

  const payload = result.result as Record<string, unknown> | undefined;
  assert(payload?.ok === true, `device RPC did not return ok=true: ${JSON.stringify(result)}`);
  assert(String(payload.content || '').includes(sentinel), 'device RPC result did not include sentinel content');

  const status = await api('GET', `/api/devices/rpc-status?agent_id=usr${botUid}`, undefined, token);
  assert(numberField(status, 'pending_count') === 0, `pending RPC was not cleared: ${JSON.stringify(status)}`);
  const statusText = JSON.stringify(status);
  assert(!statusText.includes(sentinelFile), 'rpc-status leaked local absolute file path');
  assert(!statusText.includes(sentinel), 'rpc-status leaked file content');

  await api('DELETE', `/api/devices/${encodeURIComponent(deviceId)}`, undefined, token);
  const devicesAfterDelete = await api('GET', '/api/devices', undefined, token);
  const remaining = Array.isArray(devicesAfterDelete.devices) ? devicesAfterDelete.devices : [];
  assert(!remaining.some((device: any) => device?.deviceId === deviceId && device?.routable), 'deleted device is still routable');

    console.log('[cross-repo:e2e] CatsCo full device RPC e2e passed');
  } finally {
    await connector?.destroy().catch(() => undefined);
    botClient?.disconnect();
    if (serverProcess) await stopProcess(serverProcess);
  }
}

function startCatsCompanyServer(configFile: string): ChildProcessWithoutNullStreams {
  const goCache = process.env.CATSCOMPANY_GOCACHE || path.join(catsRepo, '.gocache');
  fs.mkdirSync(goCache, { recursive: true });
  const child = spawn('go', ['run', './server/cmd', configFile], {
    cwd: catsRepo,
    env: {
      ...process.env,
      GOCACHE: goCache,
      OC_JWT_SECRET: process.env.OC_JWT_SECRET || `catsco-e2e-${runId}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  child.stdout.on('data', data => process.stdout.write(prefixLines('[cats-company] ', data.toString())));
  child.stderr.on('data', data => process.stderr.write(prefixLines('[cats-company] ', data.toString())));
  child.on('exit', code => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[cross-repo:e2e] cats-company server exited with code ${code}\n`);
    }
  });
  return child;
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `${res.status} ${await res.text().catch(() => '')}`;
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
    await sleep(500);
  }
  throw new Error(`server was not ready after ${timeoutMs}ms: ${lastError}`);
}

async function api(
  method: string,
  route: string,
  body?: unknown,
  token?: string,
  expected = 200,
): Promise<any> {
  const res = await fetch(`${httpBaseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (res.status !== expected) {
    throw new Error(`${method} ${route} returned ${res.status}, expected ${expected}: ${text}`);
  }
  return parsed;
}

async function waitForRoutableDevice(token: string, deviceId: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastDevices = '';
  while (Date.now() - started < timeoutMs) {
    const body = await api('GET', '/api/devices', undefined, token);
    const devices = Array.isArray(body.devices) ? body.devices : [];
    const device = devices.find((item: any) => item?.deviceId === deviceId);
    if (device?.active && device?.routeConnected && device?.routable) return;
    lastDevices = JSON.stringify(devices);
    await sleep(500);
  }
  throw new Error(`device ${deviceId} did not become routable: ${lastDevices}`);
}

async function waitForClientReady(client: CatsClient, timeoutMs: number): Promise<void> {
  await waitForEvent(client, 'ready', timeoutMs);
}

async function waitForMessageWithGrant(client: CatsClient, topic: string, timeoutMs: number): Promise<MessageContext> {
  const started = Date.now();
  return await new Promise<MessageContext>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for device grant message after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message: MessageContext) => {
      const identity = message.metadata?.catsco_identity as Record<string, unknown> | undefined;
      const grants = identity?.device_grants;
      if (message.topic === topic && Array.isArray(grants) && grants.length > 0) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off('message', onMessage);
      client.off('error', onError);
    };
    client.on('message', onMessage);
    client.on('error', onError);
    void started;
  });
}

async function waitForEvent(emitter: NodeJS.EventEmitter, event: string, timeoutMs: number): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${event} after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (...args: unknown[]) => {
      cleanup();
      resolve(args);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      emitter.off('error', onError);
    };
    emitter.once(event, onEvent);
    emitter.once('error', onError);
  });
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function stringField(record: any, key: string): string {
  return String(record?.[key] || '').trim();
}

function numberField(record: any, key: string): number {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function prefixLines(prefix: string, value: string): string {
  return value
    .split(/\r?\n/)
    .map((line, index, lines) => (line || index < lines.length - 1 ? `${prefix}${line}` : line))
    .join('\n');
}

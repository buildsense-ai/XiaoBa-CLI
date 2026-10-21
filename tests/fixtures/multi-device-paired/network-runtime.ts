// Opt-in deployed loopback-service probe. No LLM or production credentials.
// Uses actual CatsClient sockets, context parsers, RPC sender/receiver and tools.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CatsClient } from '../../../src/catscompany/client';
import { CatsCompanyBot } from '../../../src/catscompany/index';
import { createCatsCoMessageEnvelope, createExecutionScope } from '../../../src/catscompany/message-envelope';
import { extractCatsCoRuntimeContext } from '../../../src/catscompany/runtime-context';
import { extractCatsCoDeviceGrants } from '../../../src/catscompany/device-grants';
import { extractCatsCoDeviceSelection } from '../../../src/catscompany/device-selection';
import { ReadTool } from '../../../src/tools/read-tool';
import { WriteTool } from '../../../src/tools/write-tool';
import { ImportFileTool } from '../../../src/tools/import-file-tool';
import { SendFileTool } from '../../../src/tools/send-file-tool';
import { createCatsCoLocalDeviceGrant } from '../../../src/catscompany/local-file-grants';
import type { ToolExecutionContext } from '../../../src/types/tool';

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  assert.equal(input.base, 'http://127.0.0.1:19861');
  const accounts = input.accounts;
  const user = accounts['device-test-user'], other = accounts['device-test-other'], botConfig = accounts.bot;
  const scratch = path.join(process.cwd(), '.audit-tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'network-devices-'));
  const clients: CatsClient[] = [];
  const received: string[] = [];
  let holdA: ((request: any) => Promise<void>) | undefined;
  const ws = input.base.replace('http:', 'ws:') + '/v0/channels';
  async function api(url: string, token: string, method = 'GET', body?: unknown, expected = 200) {
    const response = await fetch(input.base + url, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = await response.json();
    assert.equal(response.status, expected, JSON.stringify(json));
    return json as any;
  }
  async function connect(client: CatsClient) {
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client readiness timeout')), 12_000);
      client.once('ready', () => { clearTimeout(timer); resolve(); });
      client.on('error', error => { clearTimeout(timer); reject(error); });
      client.connect();
    });
  }
  async function device(id: string, account: any) {
    const capabilities = ['read_file', 'write_file', 'send_file'];
    const pairing = await api('/api/device-connectors/pairings', account.token, 'POST', { device_name: id, capabilities });
    const enrolled = await api('/api/device-connectors/enroll', '', 'POST', {
      pairing_code: pairing.pairing_code, device_id: id, installation_id: id,
      device_name: id, os: 'windows', capabilities,
    });
    const directory = path.join(root, id);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'identity.txt'), `identity:${id}`);
    const client = new CatsClient({ serverUrl: ws, endpointCandidates: [ws],
      connectorToken: enrolled.connector_token, bodyId: id, installationId: id,
      deviceRegistration: { device_id: id, display_name: id, installation_id: id,
        body_id: id, runtime_role: 'desktop', os: 'windows', status: 'online', capabilities } });
    const receiver = Object.create(CatsCompanyBot.prototype) as any;
    receiver.bot = client;
    receiver.skillHubThinRpc = { supports: () => false };
    receiver.runtimeProfile = { workingDirectory: directory };
    receiver.localDeviceGrant = { kind: 'catscompany_body', source: 'catscompany',
      ownerUserId: `usr${account.uid}`, bodyId: id, installationId: id, deviceId: id, createdAt: Date.now() };
    client.on('thin_tool_rpc_request', async request => {
      // Test-harness containment only, NOT a claim that production tools have
      // this sandbox. The test never accepts arbitrary paths or shell commands.
      const args = request.payload?.args || {};
      assert.ok(['read_file', 'write_file', 'import_file'].includes(request.tool_name));
      assert.ok(['identity.txt', 'created.txt'].includes(args.file_path));
      received.push(id);
      if (id === 'network-device-a' && holdA) await holdA(request);
      await receiver.handleThinToolRpcRequest(request);
    });
    await connect(client);
    return { client, directory, enrolled };
  }
  try {
    const cloud = new CatsClient({ serverUrl: ws, endpointCandidates: [ws], apiKey: botConfig.apiKey,
      bodyId: botConfig.bodyId, installationId: botConfig.installationId, botUid: String(botConfig.uid) });
    await connect(cloud);
    const sender = Object.create(CatsCompanyBot.prototype) as any;
    sender.bot = cloud;
    const a = await device('network-device-a', user);
    const b = await device('network-device-b', user);
    await device('network-device-private', other);
    const topic = `p2p_${user.uid}_${botConfig.uid}`;
    const selectionPath = `/api/conversations/device-selection?topic_id=${topic}&agent_id=${botConfig.uid}`;
    async function choose(id: string) {
      const current = await api(selectionPath, user.token);
      assert.equal(current.devices.length, 2, 'other account device leaked');
      return api(selectionPath, user.token, 'POST', { device_id: id, expected_revision: current.revision });
    }
    async function context(): Promise<ToolExecutionContext> {
      let callback: (msg: any) => void;
      const pending = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { cloud.off('message', callback); reject(new Error('message delivery timeout')); }, 10_000);
        callback = msg => { if (msg.topic === topic && msg.senderId === `usr${user.uid}`) {
          clearTimeout(timer); cloud.off('message', callback); resolve(msg);
        } };
        cloud.on('message', callback);
      });
      await api('/api/messages/send', user.token, 'POST', { topic_id: topic, content: '读取我的文件', client_msg_id: `network-${Date.now()}-${Math.random()}` });
      const msg = await pending;
      const scope = createExecutionScope(createCatsCoMessageEnvelope({ topic: msg.topic, senderId: msg.senderId,
        text: msg.text, seq: msg.seq, metadata: msg.metadata, botUid: String(botConfig.uid) }));
      return { workingDirectory: root, surface: 'catscompany', executionScope: scope,
        targetRoutes: extractCatsCoRuntimeContext(msg.metadata, scope),
        deviceSelection: extractCatsCoDeviceSelection(msg.metadata, scope),
        deviceGrants: extractCatsCoDeviceGrants(msg.metadata, scope), thinToolRpc: sender.buildThinToolRpcTransport() };
    }
    const target = user.username;
    const initial = await api(selectionPath, user.token);
    // A repeat run must explicitly state its expected persisted selection,
    // rather than resetting the database or silently accepting any state.
    if (input.expectedInitialDeviceId !== undefined) {
      assert.equal(initial.status, 'selected');
      assert.equal(initial.selected_device_id, input.expectedInitialDeviceId);
      console.log('PASS: expected device selection survived the service/database restart');
    } else console.log('Initial selection retained for audit:', initial.status, initial.selected_device_id || '(none)');
    assert.equal(initial.devices.length, 2);
    console.log('PASS: real pairing and sockets, complete same-account directory; foreign account excluded');
    await choose('network-device-a');
    const ctxA = await context();
    const readA = await new ReadTool().execute({ file_path: 'identity.txt', target }, ctxA);
    assert.ok(readA.ok, JSON.stringify(readA)); assert.match(readA.content || '', /identity:network-device-a/);
    let arrival!: (request: any) => void;
    let release!: () => void;
    const arrived = new Promise<any>(resolve => { arrival = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    holdA = async request => { arrival(request); await released; };
    const inFlight = new ReadTool().execute({ file_path: 'identity.txt', target }, ctxA);
    const pendingA = await Promise.race([arrived, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('A dispatch did not arrive')), 10000); timer.unref();
    })]);
    await choose('network-device-b');
    await assert.rejects(b.client.sendThinToolRpcResult({ request_id: pendingA.request_id, device_id: 'network-device-a',
      result: { ok: true, content: 'spoofed B completion' } }));
    release(); holdA = undefined;
    const lateA = await inFlight;
    assert.ok(lateA.ok, JSON.stringify(lateA)); assert.match(lateA.content || '', /identity:network-device-a/);
    console.log('PASS: already-dispatched A completes as A after selecting B; B cannot claim its result');
    const beforeStale = received.length;
    const stale = await new WriteTool().execute({ file_path: 'created.txt', content: 'must-not-write', target }, ctxA);
    assert.equal(stale.ok, false); assert.equal(received.length, beforeStale);
    const ctxB = await context();
    const writeB = await new WriteTool().execute({ file_path: 'created.txt', content: 'only B', target }, ctxB);
    assert.ok(writeB.ok, JSON.stringify(writeB));
    assert.equal(fs.readFileSync(path.join(b.directory, 'created.txt'), 'utf8'), 'only B');
    assert.equal(fs.existsSync(path.join(a.directory, 'created.txt')), false);
    console.log('PASS: selected A read; switched B write landed only in B; stale A denied before receiver');
    // Explicit cross-account target and old wire (no grant) must be refused.
    const grant = ctxB.deviceGrants![0];
    const crossed = await cloud.sendThinToolRpcRequest({ request_id: `crossed-${Date.now()}`,
      grant_id: grant.grantId, session_key: grant.sessionKey, actor_user_id: grant.actorUserId,
      target_owner_user_id: `usr${other.uid}`, target_device_id: 'network-device-private',
      tool_name: 'read_file', payload: { args: { file_path: 'identity.txt' } } }, 10_000);
    assert.ok(crossed.error);
    const legacy = await cloud.sendThinToolRpcRequest({ request_id: `legacy-${Date.now()}`,
      target_owner_user_id: `usr${user.uid}`, target_device_id: 'network-device-b', tool_name: 'read_file',
      payload: { args: { file_path: 'identity.txt' } } }, 10_000);
    assert.equal(legacy.error?.code, 'device_authorization_required');
    assert.ok(!received.includes('network-device-private'));
    console.log('PASS: shared Bot cannot cross account; unscoped legacy wire is explicitly rejected');
    const countBeforeImport = received.length;
    const importedPath = path.join(root, 'imported-from-B.txt');
    ctxB.channel = { chatId: topic, reply: async () => {}, sendFile: async () => {},
      receiveUploadedFile: async uploaded => {
        const url = new URL(uploaded.url, input.base);
        assert.equal(url.origin, new URL(input.base).origin, 'isolated import attempted external storage');
        const download = await fetch(url, { signal: AbortSignal.timeout(10000) });
        assert.equal(download.status, 200);
        fs.writeFileSync(importedPath, Buffer.from(await download.arrayBuffer()));
        return importedPath;
      } };
    const imported = await new ImportFileTool().execute({ file_path: 'identity.txt', file_name: 'identity.txt', target }, ctxB);
    assert.ok(imported.ok, JSON.stringify(imported));
    assert.equal(fs.readFileSync(importedPath, 'utf8'), 'identity:network-device-b');
    assert.deepEqual(received.slice(countBeforeImport), ['network-device-b']);
    console.log('PASS: selected B import_file uses real upload/download; exact bytes from B, no A dispatch');
    let sentFileSeq = 0;
    ctxB.localDeviceGrant = createCatsCoLocalDeviceGrant({ bodyId: botConfig.bodyId,
      installationId: botConfig.installationId, deviceId: botConfig.installationId,
      ownerUserId: `usr${accounts['device-test-owner'].uid}` });
    ctxB.channel.sendFile = async (chatId, absolutePath, displayName) => {
      assert.equal(chatId, topic);
      assert.equal(path.resolve(absolutePath), importedPath);
      const upload = await cloud.uploadFile(absolutePath, 'file');
      sentFileSeq = await cloud.sendFile(topic, { ...upload, name: displayName || upload.name });
    };
    const sentFile = await new SendFileTool().execute({ file_path: importedPath, file_name: 'identity-from-B.txt' }, ctxB);
    assert.ok(sentFile.ok, JSON.stringify(sentFile)); assert.ok(sentFileSeq > 0);
    const messages = (await api('/api/messages?topic_id=' + topic + '&latest=true&limit=100', user.token)).messages;
    const fileMessage = messages.find((message: any) => Number(message.seq_id || message.id) === sentFileSeq);
    assert.ok(fileMessage, 'uploaded attachment not persisted in the user conversation');
    assert.match(JSON.stringify(fileMessage.content), /identity-from-B\.txt/);
    assert.equal(received.length, countBeforeImport + 1, 'send_file unexpectedly accessed a desktop again');
    console.log('PASS: imported B file is sent to the same chat through real send_file/upload/message persistence');
    b.client.disconnect();
    let unavailable = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const snapshot = await api(selectionPath, user.token);
      if (snapshot.status === 'unavailable') { unavailable = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(unavailable, 'selected B did not become unavailable');
    const offline = await context();
    const count = received.length;
    const denied = await new ReadTool().execute({ file_path: 'identity.txt', target }, offline);
    assert.equal(denied.ok, false); assert.equal(received.length, count);
    console.log('PASS: selected B disconnected; request did not fall back to live A');
    await api('/api/devices/network-device-b', user.token, 'DELETE');
    const replay = await fetch(input.base + '/api/device-connectors/register', { method: 'POST',
      headers: { Authorization: `DeviceConnector ${b.enrolled.connector_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: 'network-device-b', capabilities: ['read_file'] }) });
    assert.equal(replay.status, 403);
    const beforeReplay = received.length;
    const revoked = await new ReadTool().execute({ file_path: 'identity.txt', target }, ctxB);
    assert.equal(revoked.ok, false); assert.equal(received.length, beforeReplay);
    console.log('PASS: revoked B connector token cannot register again; retained B grant cannot execute');
    console.log('NETWORK ACCEPTANCE PASSED: deterministic instructions, real remote service/DB/sockets/local test files; no LLM or physical two-device acceptance.');
  } finally {
    clients.forEach(client => client.disconnect());
    for (const [id, account] of [['network-device-a', user], ['network-device-b', user], ['network-device-private', other]] as const) {
      await api('/api/devices/' + id, account.token, 'DELETE');
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { CatsCompanyBot } from '../src/catscompany';
import type { CatsDeviceRpcMessage } from '../src/catscompany/client';
import type { ScopedDeviceGrant } from '../src/types/session-identity';

function botWithDevice(captured: { result?: any }): any {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.localDeviceGrant = {
    kind: 'catscompany_body',
    source: 'catscompany',
    bodyId: 'body-device',
    installationId: 'install-device',
    deviceId: 'install-device',
    createdAt: Date.now(),
  };
  bot.bot = {
    sendDeviceRpcResult: async (result: any) => {
      captured.result = result;
    },
  };
  return bot;
}

function request(overrides: Partial<CatsDeviceRpcMessage> = {}): CatsDeviceRpcMessage {
  return {
    type: 'request',
    request_id: 'rpc-read-1',
    grant_id: 'grant-read-1',
    session_key: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topic_id: 'p2p_7_43',
    topic_type: 'p2p',
    actor_user_id: 'usr7',
    agent_id: 'usr43',
    agent_body_id: 'body-agent',
    device_id: 'install-device',
    device_body_id: 'body-device',
    device_installation_id: 'install-device',
    operation: 'read_file',
    tool_name: 'read_file',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    payload: {},
    ...overrides,
  };
}

function serverGrant(overrides: Partial<ScopedDeviceGrant> = {}): ScopedDeviceGrant {
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: 'grant-server-readonly',
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'metadata.catsco_identity',
    deviceId: 'install-remote',
    deviceDisplayName: 'Remote Laptop',
    deviceBodyId: 'body-remote',
    deviceInstallationId: 'install-remote',
    ownerUserId: 'usr7',
    sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-agent',
    operations: ['read_file', 'glob', 'grep'],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('CatsCompany Device RPC readonly tools', () => {
  test('maps CatsCo server grant fields into outbound readonly device_rpc requests', async () => {
    const captured: Array<{ request: any; timeoutMs?: number }> = [];
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.bot = {
      sendDeviceRpcRequest: async (requestPayload: any, timeoutMs?: number) => {
        captured.push({ request: requestPayload, timeoutMs });
        return {
          type: 'result',
          request_id: requestPayload.request_id,
          grant_id: requestPayload.grant_id,
          session_key: requestPayload.session_key,
          topic_id: requestPayload.topic_id,
          topic_type: requestPayload.topic_type,
          actor_user_id: requestPayload.actor_user_id,
          agent_id: requestPayload.agent_id,
          agent_body_id: requestPayload.agent_body_id,
          device_id: requestPayload.device_id,
          device_body_id: requestPayload.device_body_id,
          device_installation_id: requestPayload.device_installation_id,
          operation: requestPayload.operation,
          tool_name: requestPayload.tool_name,
          result: { ok: true, content: `remote ${requestPayload.tool_name}` },
        };
      },
    };

    const transport = bot.buildDeviceRpcTransport();
    const grant = serverGrant();
    const read = await transport.executeTool({
      toolName: 'read_file',
      operation: 'read_file',
      args: { file_path: 'catsco_attachment:quote.xlsx', limit: 20 },
      grant,
      timeoutMs: 12_345,
    });
    const glob = await transport.executeTool({
      toolName: 'glob',
      operation: 'glob',
      args: { pattern: '**/*.xlsx', path: 'catsco_attachment:project' },
      grant,
    });
    const grep = await transport.executeTool({
      toolName: 'grep',
      operation: 'grep',
      args: { pattern: '合同', path: 'catsco_attachment:project', output_mode: 'files' },
      grant,
    });

    assert.equal(read.ok, true);
    assert.equal(glob.ok, true);
    assert.equal(grep.ok, true);
    assert.equal(read.ok ? read.content : '', 'remote read_file');
    assert.equal(glob.ok ? glob.content : '', 'remote glob');
    assert.equal(grep.ok ? grep.content : '', 'remote grep');
    assert.deepEqual(captured.map(item => [item.request.tool_name, item.request.operation]), [
      ['read_file', 'read_file'],
      ['glob', 'glob'],
      ['grep', 'grep'],
    ]);

    const first = captured[0].request;
    assert.match(first.request_id, /^device_rpc_/);
    assert.equal(first.grant_id, grant.grantId);
    assert.equal(first.session_key, grant.sessionKey);
    assert.equal(first.topic_id, grant.topicId);
    assert.equal(first.topic_type, grant.topicType);
    assert.equal(first.actor_user_id, grant.actorUserId);
    assert.equal(first.agent_id, grant.agentId);
    assert.equal(first.agent_body_id, grant.agentBodyId);
    assert.equal(first.device_id, grant.deviceId);
    assert.equal(first.device_body_id, grant.deviceBodyId);
    assert.equal(first.device_installation_id, grant.deviceInstallationId);
    assert.equal(first.expires_at, grant.expiresAt);
    assert.deepEqual(first.payload, { args: { file_path: 'catsco_attachment:quote.xlsx', limit: 20 } });
    assert.equal(captured[0].timeoutMs, 12_345);
  });

  test('executes read_file on the target local device and returns a normalized result', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'device-rpc-read-'));
    const filePath = path.join(dir, 'notes.txt');
    fs.writeFileSync(filePath, 'hello from target device\n');

    await bot.handleDeviceRpcRequest(request({
      payload: { args: { file_path: filePath, limit: 5 } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.match(String(captured.result.result.content), /hello from target device/);
    assert.equal(captured.result.device_id, 'install-device');
  });

  test('rejects non-readonly Device RPC operations before local tool execution', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-shell-1',
      operation: 'execute_shell',
      tool_name: 'execute_shell',
      payload: { args: { command: 'echo unsafe' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'unsupported_operation');
    assert.match(captured.result.error.message, /read_file, glob, and grep/);
  });

  test('rejects Device RPC requests for another target device', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-wrong-device-1',
      device_id: 'other-device',
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'target_device_mismatch');
  });
});

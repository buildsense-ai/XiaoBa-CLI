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
    ownerUserId: 'usr7',
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
    owner_user_id: 'usr7',
    identity_source: 'metadata.catsco_identity',
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
    operations: ['read_file', 'resolve_common_directory', 'glob', 'grep', 'execute_shell'],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('CatsCompany Device RPC file tools', () => {
  test('maps CatsCo server grant fields into outbound device_rpc requests', async () => {
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
          owner_user_id: requestPayload.owner_user_id,
          identity_source: requestPayload.identity_source,
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
    const resolveDir = await transport.executeTool({
      toolName: 'resolve_common_directory',
      operation: 'resolve_common_directory',
      args: { directory: 'desktop' },
      grant,
    });
    const grep = await transport.executeTool({
      toolName: 'grep',
      operation: 'grep',
      args: { pattern: '合同', path: 'catsco_attachment:project', output_mode: 'files' },
      grant,
    });
    const shell = await transport.executeTool({
      toolName: 'execute_shell',
      operation: 'execute_shell',
      args: { command: 'echo remote-shell' },
      grant,
    });

    assert.equal(read.ok, true);
    assert.equal(glob.ok, true);
    assert.equal(resolveDir.ok, true);
    assert.equal(grep.ok, true);
    assert.equal(shell.ok, true);
    assert.equal(read.ok ? read.content : '', 'remote read_file');
    assert.equal(glob.ok ? glob.content : '', 'remote glob');
    assert.equal(resolveDir.ok ? resolveDir.content : '', 'remote resolve_common_directory');
    assert.equal(grep.ok ? grep.content : '', 'remote grep');
    assert.equal(shell.ok ? shell.content : '', 'remote execute_shell');
    assert.deepEqual(captured.map(item => [item.request.tool_name, item.request.operation]), [
      ['read_file', 'read_file'],
      ['glob', 'glob'],
      ['resolve_common_directory', 'resolve_common_directory'],
      ['grep', 'grep'],
      ['execute_shell', 'execute_shell'],
    ]);

    const first = captured[0].request;
    assert.match(first.request_id, /^device_rpc_/);
    assert.equal(first.grant_id, grant.grantId);
    assert.equal(first.session_key, grant.sessionKey);
    assert.equal(first.topic_id, grant.topicId);
    assert.equal(first.topic_type, grant.topicType);
    assert.equal(first.actor_user_id, grant.actorUserId);
    assert.equal(first.owner_user_id, grant.ownerUserId);
    assert.equal(first.identity_source, grant.identitySource);
    assert.equal(first.agent_id, grant.agentId);
    assert.equal(first.agent_body_id, grant.agentBodyId);
    assert.equal(first.device_id, grant.deviceId);
    assert.equal(first.device_body_id, grant.deviceBodyId);
    assert.equal(first.device_installation_id, grant.deviceInstallationId);
    assert.equal(first.expires_at, grant.expiresAt);
    assert.deepEqual(first.payload, { args: { file_path: 'catsco_attachment:quote.xlsx', limit: 20 } });
    assert.equal(captured[0].timeoutMs, 12_345);
  });

  test('executes resolve_common_directory on the target local device and returns a normalized result', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-resolve-directory-1',
      operation: 'resolve_common_directory',
      tool_name: 'resolve_common_directory',
      payload: { args: { directory: 'home' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.match(String(captured.result.result.content), /\[tool_target\]/);
    assert.match(String(captured.result.result.content), /target: selected_user_device/);
    assert.match(String(captured.result.result.content), /Resolved common directory:/);
    assert.match(String(captured.result.result.content), /kind: home/);
    assert.equal(captured.result.device_id, 'install-device');
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

  test('executes write_file on the target local device when RPC scope is valid', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'device-rpc-write-'));
    const filePath = path.join(dir, 'created.txt');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-write-1',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: filePath, content: 'hello from rpc' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'hello from rpc');
  });

  test('executes edit_file on the target local device when RPC scope is valid', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'device-rpc-edit-'));
    const filePath = path.join(dir, 'edit.txt');
    fs.writeFileSync(filePath, 'before');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-edit-1',
      operation: 'edit_file',
      tool_name: 'edit_file',
      payload: { args: { file_path: filePath, old_string: 'before', new_string: 'after' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'after');
  });

  test('rejects Device RPC requests missing owner identity', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-missing-owner-1',
      owner_user_id: '',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: path.join(process.cwd(), 'tmp', 'missing-owner.txt'), content: 'nope' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'invalid_request');
    assert.match(captured.result.error.message, /owner_user_id/);
  });

  test('rejects Device RPC requests for a different device owner', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const filePath = path.join(process.cwd(), 'tmp', 'wrong-owner.txt');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-wrong-owner-1',
      actor_user_id: 'usr8',
      owner_user_id: 'usr8',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: filePath, content: 'nope' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'PERMISSION_DENIED');
    assert.match(captured.result.error.message, /owner 不一致|设备 owner/);
    assert.equal(fs.existsSync(filePath), false);
  });

  test('rejects delegated Device RPC when owner and actor differ without channel identity source', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-bad-delegation-1',
      actor_user_id: 'usr100',
      owner_user_id: 'usr7',
      identity_source: 'metadata.catsco_identity',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: path.join(process.cwd(), 'tmp', 'bad-delegated.txt'), content: 'nope' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'invalid_request');
    assert.match(captured.result.error.message, /channel_identity_link/);
  });

  test('executes shell Device RPC operations on the selected local device', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-shell-1',
      operation: 'execute_shell',
      tool_name: 'execute_shell',
      payload: { args: { command: 'node -e "console.log(\'rpc-shell-ok\')"' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.match(String(captured.result.result.content), /rpc-shell-ok/);
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

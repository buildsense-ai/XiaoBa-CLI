import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { CatsCompanyBot } from '../src/catscompany';
import type { CatsDeviceRpcMessage } from '../src/catscompany/client';

function botWithDevice(captured: { result?: any }, options: {
  capabilities?: string[];
  allowWriteFile?: boolean;
  allowShell?: boolean;
} = {}): any {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.localDeviceGrant = {
    kind: 'catscompany_body',
    source: 'catscompany',
    bodyId: 'body-device',
    installationId: 'install-device',
    deviceId: 'install-device',
    createdAt: Date.now(),
  };
  bot.deviceRegistration = {
    device_id: 'install-device',
    display_name: 'Test Device',
    body_id: 'body-device',
    installation_id: 'install-device',
    status: 'online',
    capabilities: options.capabilities || ['read_file', 'glob', 'grep'],
  };
  bot.allowWriteFile = Boolean(options.allowWriteFile);
  bot.allowShell = Boolean(options.allowShell);
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

describe('CatsCompany Device RPC tools', () => {
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

  test('executes write_file on the target local device when explicitly granted', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured, {
      capabilities: ['read_file', 'glob', 'grep', 'write_file'],
      allowWriteFile: true,
    });
    const tmpRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'device-rpc-write-'));
    const filePath = path.join(dir, 'created.txt');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-write-1',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: filePath, content: 'hello from rpc write' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'hello from rpc write');
  });

  test('rejects write_file on the full runtime unless local capability is explicitly enabled', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'device-rpc-write-denied-'));
    const filePath = path.join(dir, 'created.txt');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-write-denied-1',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: filePath, content: 'blocked' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'PERMISSION_DENIED');
    assert.match(captured.result.error.message, /未注册远程 write_file 能力|未显式开启远程写文件能力/);
    assert.equal(fs.existsSync(filePath), false);
  });

  test('rejects unsupported Device RPC operations before local tool execution', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-send-file-1',
      operation: 'send_file',
      tool_name: 'send_file',
      payload: { args: { file_path: 'secret.txt' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'unsupported_operation');
    assert.match(captured.result.error.message, /read_file, glob, grep, write_file, and execute_shell/);
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

  test('returns a structured error when local Device RPC tool execution throws', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    bot.executeLocalDeviceRpcTool = async () => {
      throw new Error('boom from local tool');
    };

    await bot.handleDeviceRpcRequest(request({ request_id: 'rpc-throw-1' }));

    assert.ok(captured.result);
    assert.equal(captured.result.result, undefined);
    assert.equal(captured.result.error.code, 'tool_execution_error');
    assert.match(captured.result.error.message, /boom from local tool/);
    assert.equal(captured.result.grant_id, 'grant-read-1');
    assert.equal(captured.result.device_id, 'install-device');
  });
});

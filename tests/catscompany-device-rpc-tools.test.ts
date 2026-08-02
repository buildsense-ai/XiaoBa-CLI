import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CatsCompanyBot } from '../src/catscompany';
import type { CatsDeviceRpcMessage, CatsThinToolRpcMessage } from '../src/catscompany/client';
import type { ScopedDeviceGrant } from '../src/types/session-identity';

function botWithDevice(captured: {
  result?: any;
  thinResult?: any;
  thinResults?: any[];
  uploaded?: { path: string; type: string; bytes: Buffer };
}): any {
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
    supportsDeviceRpc: true,
    supportsThinToolRpc: true,
    supportsThinToolRpcAuthorityV1: true,
    sendDeviceRpcResult: async (result: any) => {
      captured.result = result;
    },
    sendThinToolRpcResult: async (result: any) => {
      captured.thinResult = result;
      captured.thinResults?.push(result);
    },
    uploadFile: async (filePath: string, type: string) => {
      const bytes = fs.readFileSync(filePath);
      captured.uploaded = { path: filePath, type, bytes };
      return {
        url: '/uploads/device-file.bin',
        name: path.basename(filePath),
        size: bytes.length,
      };
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

function thinRequest(overrides: Partial<CatsThinToolRpcMessage> = {}): CatsThinToolRpcMessage {
  return {
    type: 'request',
    request_id: 'thin-import-file-1',
    authority_version: 'v1',
    target_owner_user_id: 'usr7',
    target_device_id: 'install-device',
    grant_id: 'grant-thin-1',
    session_key: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topic_id: 'p2p_7_43',
    topic_type: 'p2p',
    actor_user_id: 'usr7',
    owner_user_id: 'usr7',
    identity_source: 'metadata.catsco_identity',
    agent_id: 'usr43',
    agent_body_id: 'body-agent',
    operation: 'send_file',
    device_id: 'install-device',
    device_body_id: 'body-device',
    device_installation_id: 'install-device',
    tool_name: 'import_file',
    expires_at: Date.now() + 60_000,
    payload: {},
    ...overrides,
  };
}

describe('CatsCompany Device RPC file tools', () => {
  let testRoot: string;

  before(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-device-rpc-tools-'));
    fs.mkdirSync(path.join(testRoot, 'tmp'), { recursive: true });
  });

  after(() => {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('materializes trusted remote upload metadata without publishing a chat attachment', async () => {
    let downloaded: any;
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.sender = {
      downloadFile: async (url: string, fileName: string, options: any) => {
        downloaded = { url, fileName, targetPath: options.targetPath };
        return options.targetPath;
      },
    };
    const channel = bot.buildChannel('p2p_7_43', { sessionKey: 'session:test' });
    const file = {
      url: '/uploads/files/exact.bin',
      name: 'exact.bin',
      size: 6,
      type: 'file' as const,
    };

    const localPath = await channel.receiveUploadedFile(file);

    assert.deepEqual(downloaded, {
      url: '/uploads/files/exact.bin',
      fileName: 'exact.bin',
      targetPath: localPath,
    });
    assert.match(localPath, /session_test[\\/].*_exact\.bin$/);
    assert.equal(channel.hasOutbound, false);
  });

  test('rejects non-CatsCo upload URLs before the agent downloads them', async () => {
    let downloads = 0;
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.sender = {
      downloadFile: async () => {
        downloads += 1;
        return 'should-not-exist';
      },
    };
    const channel = bot.buildChannel('p2p_7_43', { sessionKey: 'session:test' });

    await assert.rejects(() => channel.receiveUploadedFile({
      url: 'http://127.0.0.1/private',
      name: 'forged.bin',
      size: 1,
      type: 'file',
    }), /不是受信任的 CatsCo 上传地址/);
    assert.equal(downloads, 0);
  });

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

  test('forwards the validated grant envelope through thin tool RPC', async () => {
    let captured: any;
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.bot = {
      sendThinToolRpcRequest: async (payload: any, timeoutMs: number) => {
        captured = { payload, timeoutMs };
        return { type: 'result', request_id: payload.request_id, result: { ok: true, content: 'ok' } };
      },
    };
    const grant = serverGrant({ deviceId: 'install-device', deviceInstallationId: 'install-device' });
    const result = await bot.buildThinToolRpcTransport().executeTool({
      targetOwnerUserId: grant.ownerUserId,
      targetDeviceId: grant.deviceId,
      toolName: 'read_file',
      operation: 'read_file',
      grant,
      args: { file_path: 'notes.txt' },
      timeoutMs: 12_345,
    });

    assert.equal(result.ok, true);
    assert.equal(captured.payload.authority_version, 'v1');
    assert.equal(captured.payload.grant_id, grant.grantId);
    assert.equal(captured.payload.session_key, grant.sessionKey);
    assert.equal(captured.payload.actor_user_id, grant.actorUserId);
    assert.equal(captured.payload.owner_user_id, grant.ownerUserId);
    assert.equal(captured.payload.operation, 'read_file');
    assert.equal(captured.payload.device_id, grant.deviceId);
    assert.ok(captured.payload.expires_at <= grant.expiresAt);
    assert.equal(captured.timeoutMs, 12_345);
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
    assert.match(String(captured.result.result.content), /target: speaker_default/);
    assert.match(String(captured.result.result.content), /Resolved common directory:/);
    assert.match(String(captured.result.result.content), /kind: home/);
    assert.equal(captured.result.device_id, 'install-device');
  });

  test('executes read_file on the target local device and returns a normalized result', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(testRoot, 'tmp');
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

  test('uploads the original file bytes for a thin import_file request', async () => {
    const captured: { uploaded?: { path: string; type: string; bytes: Buffer } } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(testRoot, 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'thin-rpc-import-file-'));
    const filePath = path.join(dir, 'original.bin');
    const original = Buffer.from([0, 255, 1, 2, 3, 128]);
    fs.writeFileSync(filePath, original);
    const request = thinRequest({
      payload: { args: { file_path: filePath, file_name: 'download.bin' } },
    });

    const result = await bot.executeLocalThinToolRpcTool(request);

    assert.equal(result.ok, true);
    assert.deepEqual(captured.uploaded?.bytes, original);
    assert.equal(captured.uploaded?.path, filePath);
    assert.equal(captured.uploaded?.type, 'file');
    assert.deepEqual(result.uploadedFile, {
      url: '/uploads/device-file.bin',
      name: 'download.bin',
      size: original.length,
      type: 'file',
    });
  });

  test('fails closed for malformed, mismatched, expired, or unsupported thin RPC authority', () => {
    const bot = botWithDevice({});
    assert.equal(bot.validateThinToolRpcRequest(thinRequest()), undefined);

    const cases: Array<[string, Partial<CatsThinToolRpcMessage>, RegExp]> = [
      ['missing grant', { grant_id: undefined }, /grant_id/],
      ['wrong owner', { target_owner_user_id: 'usr8' }, /owner/],
      ['undelegated cross-user actor', { actor_user_id: 'usr8' }, /channel identity link/],
      ['wrong device', { target_device_id: 'other-device' }, /device/],
      ['expired', { expires_at: Date.now() - 1 }, /expired/],
      ['long expiry', { expires_at: Date.now() + 600_000 }, /expiry/],
      ['wrong operation', { operation: 'read_file' }, /pair/],
      ['unsupported tool', { tool_name: 'spawn_subagent' }, /pair/],
    ];
    for (const [name, overrides, pattern] of cases) {
      const result = bot.validateThinToolRpcRequest(thinRequest(overrides));
      assert.ok(result, name);
      assert.match(result.message, pattern, name);
    }
  });

  test('accepts only channel-linked group delegation at the thin RPC receiver', async () => {
    const captured: { thinResult?: any } = {};
    const bot = botWithDevice(captured);
    const groupDelegation = thinRequest({
      request_id: 'thin-group-delegation',
      session_key: 'session:v2:catscompany:group:room_7:agent:usr43',
      topic_id: 'room_7',
      topic_type: 'group',
      actor_user_id: 'usr8',
      identity_source: 'channel_identity_link',
      operation: 'resolve_common_directory',
      tool_name: 'resolve_common_directory',
      payload: { args: { directory: 'home' } },
    });

    assert.equal(bot.validateThinToolRpcRequest(groupDelegation), undefined);
    await bot.handleThinToolRpcRequest(groupDelegation);
    assert.equal(captured.thinResult?.error, undefined);
    assert.equal(captured.thinResult?.result?.ok, true);
  });

  test('does not expose or execute strict Thin RPC across an unnegotiated or stripped protocol', async () => {
    const captured: { thinResults?: any[] } = { thinResults: [] };
    const bot = botWithDevice(captured);
    let executions = 0;
    bot.executeLocalThinToolRpcTool = async () => {
      executions += 1;
      return { ok: true, content: 'must not execute' };
    };

    bot.bot.supportsThinToolRpcAuthorityV1 = false;
    assert.equal(bot.maybeBuildThinToolRpcTransport(), undefined);
    assert.ok(bot.maybeBuildDeviceRpcTransport());
    await bot.handleThinToolRpcRequest(thinRequest({ request_id: 'thin-unnegotiated' }));

    bot.bot.supportsThinToolRpcAuthorityV1 = true;
    await bot.handleThinToolRpcRequest(thinRequest({
      request_id: 'thin-legacy-source',
      authority_version: undefined,
    }));
    await bot.handleThinToolRpcRequest(thinRequest({
      request_id: 'thin-server-stripped',
      grant_id: undefined,
    }));

    assert.equal(executions, 0);
    assert.equal(captured.thinResults?.length, 3);
    assert.ok(captured.thinResults?.every(item => item.error));
  });

  test('executes one Thin RPC request_id at most once and rejects conflicting replay', async () => {
    const captured: { thinResults?: any[] } = { thinResults: [] };
    const bot = botWithDevice(captured);
    let executions = 0;
    bot.executeLocalThinToolRpcTool = async () => {
      executions += 1;
      return { ok: true, content: 'executed once' };
    };
    const original = thinRequest({
      request_id: 'thin-replay-once',
      payload: { args: { directory: 'home' } },
    });

    await Promise.all([
      bot.handleThinToolRpcRequest(original),
      bot.handleThinToolRpcRequest({ ...original }),
    ]);
    await bot.handleThinToolRpcRequest({
      ...original,
      payload: { args: { directory: 'temp' } },
    });

    assert.equal(executions, 1);
    assert.equal(captured.thinResults?.length, 3);
    assert.equal(captured.thinResults?.[0]?.result?.ok, true);
    assert.equal(captured.thinResults?.[1]?.result?.ok, true);
    assert.match(String(captured.thinResults?.[2]?.error?.message), /conflicting/);
  });

  test('keeps Thin RPC replay protection in flight and for five minutes after a long execution settles', async () => {
    const captured: { thinResults?: any[] } = { thinResults: [] };
    const bot = botWithDevice(captured);
    let executions = 0;
    const realDateNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    let finishExecution: (() => void) | undefined;
    const executionGate = new Promise<void>(resolve => {
      finishExecution = resolve;
    });
    bot.executeLocalThinToolRpcTool = async () => {
      executions += 1;
      await executionGate;
      return { ok: true, content: 'long execution finished' };
    };
    const original = thinRequest({
      request_id: 'thin-inflight-expiry',
      expires_at: fakeNow + 100,
      payload: { args: { command: 'long-running-operation' } },
    });

    try {
      const firstDelivery = bot.handleThinToolRpcRequest(original);
      fakeNow += 200;
      await bot.handleThinToolRpcRequest({
        ...original,
        expires_at: fakeNow + 60_000,
      });

      fakeNow += 300_001;
      finishExecution?.();
      await firstDelivery;

      await bot.handleThinToolRpcRequest({
        ...original,
        expires_at: fakeNow + 60_000,
      });

      assert.equal(executions, 1);
      assert.equal(captured.thinResults?.length, 3);
      assert.match(String(captured.thinResults?.[0]?.error?.message), /conflicting/);
      assert.equal(captured.thinResults?.[1]?.result?.ok, true);
      assert.match(String(captured.thinResults?.[2]?.error?.message), /conflicting/);
    } finally {
      Date.now = realDateNow;
      finishExecution?.();
    }
  });

  test('accepts import_file through authorized Device RPC and returns upload metadata', async () => {
    const captured: { result?: any; uploaded?: { path: string; type: string; bytes: Buffer } } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(testRoot, 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'device-rpc-import-file-'));
    const filePath = path.join(dir, 'report.txt');
    fs.writeFileSync(filePath, 'exact file content');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-import-file-1',
      operation: 'send_file',
      tool_name: 'import_file',
      payload: { args: { file_path: filePath, file_name: 'report.txt' } },
      expires_at: Date.now() + 5 * 60_000,
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.deepEqual(captured.uploaded?.bytes, Buffer.from('exact file content'));
    assert.deepEqual(captured.result.result.uploadedFile, {
      url: '/uploads/device-file.bin',
      name: 'report.txt',
      size: Buffer.byteLength('exact file content'),
      type: 'file',
    });
  });

  test('executes write_file on the target local device when RPC scope is valid', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const tmpRoot = path.join(testRoot, 'tmp');
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
    const tmpRoot = path.join(testRoot, 'tmp');
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

  test('executes Device RPC requests even when owner identity is omitted', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const filePath = path.join(testRoot, 'tmp', 'missing-owner.txt');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-missing-owner-1',
      owner_user_id: '',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: filePath, content: 'nope' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'nope');
  });

  test('executes Device RPC requests without owner mismatch checks after target delivery', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const filePath = path.join(testRoot, 'tmp', 'wrong-owner.txt');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-wrong-owner-1',
      actor_user_id: 'usr8',
      owner_user_id: 'usr8',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: filePath, content: 'nope' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'nope');
  });

  test('executes delegated Device RPC requests without channel identity permission checks after target delivery', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const filePath = path.join(testRoot, 'tmp', 'bad-delegated.txt');

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-bad-delegation-1',
      actor_user_id: 'usr100',
      owner_user_id: 'usr7',
      identity_source: 'metadata.catsco_identity',
      operation: 'write_file',
      tool_name: 'write_file',
      payload: { args: { file_path: filePath, content: 'nope' } },
    }));

    assert.ok(captured.result);
    assert.equal(captured.result.error, undefined);
    assert.equal(captured.result.result.ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'nope');
  });

  test('executes shell Device RPC operations on the selected local device', async () => {
    const captured: { result?: any } = {};
    const bot = botWithDevice(captured);
    const command = process.platform === 'win32'
      ? `& "${process.execPath}" -e "console.log('rpc-shell-ok')"`
      : `"${process.execPath}" -e "console.log('rpc-shell-ok')"`;

    await bot.handleDeviceRpcRequest(request({
      request_id: 'rpc-shell-1',
      operation: 'execute_shell',
      tool_name: 'execute_shell',
      payload: { args: { command } },
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

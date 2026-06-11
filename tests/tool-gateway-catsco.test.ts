import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/tools/read-tool';
import { WriteTool } from '../src/tools/write-tool';
import { EditTool } from '../src/tools/edit-tool';
import { GlobTool } from '../src/tools/glob-tool';
import { GrepTool } from '../src/tools/grep-tool';
import { SendFileTool } from '../src/tools/send-file-tool';
import { ShellTool } from '../src/tools/bash-tool';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
} from '../src/types/session-identity';
import type { DeviceRpcTransport, ToolExecutionContext } from '../src/types/tool';

function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    permissionsSource: 'server_canonical_message',
    identityTrust: 'server_canonical',
    isTrusted: true,
    ...overrides,
  };
}

function localDevice(overrides: Partial<ScopedLocalDeviceGrant> = {}): ScopedLocalDeviceGrant {
  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    bodyId: 'body-device',
    installationId: 'install-device',
    deviceId: 'install-device',
    createdAt: Date.now(),
    ...overrides,
  };
}

function deviceGrant(operations: ScopedDeviceGrant['operations'], overrides: Partial<ScopedDeviceGrant> = {}): ScopedDeviceGrant {
  const currentScope = scope();
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: 'device-grant-main',
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'metadata.catsco_identity',
    deviceId: 'install-device',
    deviceDisplayName: 'Test Device',
    deviceBodyId: 'body-device',
    deviceInstallationId: 'install-device',
    ownerUserId: currentScope.actorUserId,
    sessionKey: currentScope.sessionKey,
    topicId: currentScope.topicId,
    topicType: currentScope.topicType,
    actorUserId: currentScope.actorUserId,
    agentId: currentScope.agentId,
    agentBodyId: currentScope.agentBodyId,
    operations,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function deviceSelection(overrides: Partial<ScopedDeviceSelection> = {}): ScopedDeviceSelection {
  const currentScope = scope();
  return {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    selectionSource: 'single_active_device',
    sessionKey: currentScope.sessionKey,
    topicId: currentScope.topicId,
    topicType: currentScope.topicType,
    actorUserId: currentScope.actorUserId,
    agentId: currentScope.agentId,
    identityTrust: 'server_canonical',
    identitySource: 'metadata.catsco_identity',
    selectedDeviceId: 'install-device',
    selectedDeviceDisplayName: 'Test Device',
    selectedDeviceBodyId: 'body-device',
    selectedDeviceInstallationId: 'install-device',
    selectedDeviceOperations: ['read_file'],
    ...overrides,
  };
}

function context(root: string, options: {
  executionScope?: ExecutionScope;
  localDeviceGrant?: ScopedLocalDeviceGrant;
  deviceGrants?: ScopedDeviceGrant[];
  deviceSelection?: ScopedDeviceSelection;
  deviceRpc?: DeviceRpcTransport;
} = {}): ToolExecutionContext {
  return {
    workingDirectory: root,
    workspaceRoot: root,
    conversationHistory: [],
    sessionId: options.executionScope?.sessionKey,
    surface: 'catscompany',
    executionScope: options.executionScope ?? scope(),
    localDeviceGrant: options.localDeviceGrant ?? localDevice(),
    deviceGrants: options.deviceGrants,
    deviceSelection: options.deviceSelection,
    deviceRpc: options.deviceRpc,
  };
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-tool-gateway-'));
}

describe('CatsCo ToolGateway', () => {
  test('blocks regular read_file without a current user device grant', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'secret');

    const result = await new ReadTool().execute({ file_path: filePath }, context(root));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /没有允许当前设备执行 read_file/);
      assert.doesNotMatch(result.message, new RegExp(escapeRegExp(filePath)));
    }
  });

  test('allows regular read_file with a matching CatsCo user device grant', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'allowed content');

    const result = await new ReadTool().execute({ file_path: filePath }, context(root, {
      deviceGrants: [deviceGrant(['read_file'])],
    }));

    assert.equal(result.ok, true);
    assert.match(String(result.content), /allowed content/);
  });

  test('allows read_file when backend-selected device matches the current CatsCo device', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'selected content');

    const result = await new ReadTool().execute({ file_path: filePath }, context(root, {
      deviceGrants: [deviceGrant(['read_file'])],
      deviceSelection: deviceSelection(),
    }));

    assert.equal(result.ok, true);
    assert.match(String(result.content), /selected content/);
  });

  test('blocks device tools when backend requires device selection first', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'secret');

    const result = await new ReadTool().execute({ file_path: filePath }, context(root, {
      deviceGrants: [deviceGrant(['read_file'])],
      deviceSelection: deviceSelection({
        status: 'needs_selection',
        selectedDeviceId: undefined,
        selectedDeviceBodyId: undefined,
        selectedDeviceInstallationId: undefined,
      }),
    }));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /尚未选定/);
      assert.doesNotMatch(result.message, new RegExp(escapeRegExp(filePath)));
    }
  });

  test('blocks remote-selected device tools when Device RPC transport is unavailable', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'secret');

    const result = await new ReadTool().execute({ file_path: filePath }, context(root, {
      deviceGrants: [deviceGrant(['read_file'], {
        deviceId: 'other-device',
        deviceDisplayName: 'Other Device',
        deviceBodyId: 'body-other',
        deviceInstallationId: 'install-other',
      })],
      deviceSelection: deviceSelection({
        selectedDeviceId: 'other-device',
        selectedDeviceDisplayName: 'Other Device',
        selectedDeviceBodyId: 'body-other',
        selectedDeviceInstallationId: 'install-other',
      }),
    }));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /没有配置远程设备 RPC 通道/);
      assert.doesNotMatch(result.message, new RegExp(escapeRegExp(filePath)));
    }
  });

  test('routes read_file to the backend-selected remote device without local file access', async () => {
    const root = makeWorkspace();
    const requestedPath = path.join(root, 'missing-on-agent.txt');
    let rpcRequest: any;
    const result = await new ReadTool().execute({ file_path: requestedPath, limit: 20 }, context(root, {
      deviceGrants: [deviceGrant(['read_file'], {
        deviceId: 'other-device',
        deviceDisplayName: 'Other Device',
        deviceBodyId: 'body-other',
        deviceInstallationId: 'install-other',
      })],
      deviceSelection: deviceSelection({
        selectedDeviceId: 'other-device',
        selectedDeviceDisplayName: 'Other Device',
        selectedDeviceBodyId: 'body-other',
        selectedDeviceInstallationId: 'install-other',
        selectedDeviceOperations: ['read_file'],
      }),
      deviceRpc: {
        executeTool: async request => {
          rpcRequest = request;
          return { ok: true, content: 'remote file content' };
        },
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(String(result.content), 'remote file content');
    assert.equal(rpcRequest.toolName, 'read_file');
    assert.equal(rpcRequest.operation, 'read_file');
    assert.equal(rpcRequest.grant.deviceId, 'other-device');
    assert.deepEqual(rpcRequest.args, { file_path: requestedPath, limit: 20 });
  });

  test('routes glob and grep to the backend-selected remote device', async () => {
    const root = makeWorkspace();
    const calls: Array<{ toolName: string; operation: string; args: Record<string, unknown> }> = [];
    const deviceRpc: DeviceRpcTransport = {
      executeTool: async request => {
        calls.push({
          toolName: request.toolName,
          operation: request.operation,
          args: request.args,
        });
        return { ok: true, content: `remote ${request.toolName}` };
      },
    };
    const remoteContext = context(root, {
      deviceGrants: [
        deviceGrant(['glob'], {
          grantId: 'grant-glob',
          deviceId: 'other-device',
          deviceDisplayName: 'Other Device',
          deviceBodyId: 'body-other',
          deviceInstallationId: 'install-other',
        }),
        deviceGrant(['grep'], {
          grantId: 'grant-grep',
          deviceId: 'other-device',
          deviceDisplayName: 'Other Device',
          deviceBodyId: 'body-other',
          deviceInstallationId: 'install-other',
        }),
      ],
      deviceSelection: deviceSelection({
        selectedDeviceId: 'other-device',
        selectedDeviceDisplayName: 'Other Device',
        selectedDeviceBodyId: 'body-other',
        selectedDeviceInstallationId: 'install-other',
        selectedDeviceOperations: ['glob', 'grep'],
      }),
      deviceRpc,
    });

    const glob = await new GlobTool().execute({ pattern: '**/*.ts', path: '/remote/project' }, remoteContext);
    const grep = await new GrepTool().execute({ pattern: 'needle', path: '/remote/project', output_mode: 'files' }, remoteContext);

    assert.equal(glob.ok, true);
    assert.equal(grep.ok, true);
    assert.deepEqual(calls.map(call => [call.toolName, call.operation]), [
      ['glob', 'glob'],
      ['grep', 'grep'],
    ]);
    assert.deepEqual(calls[0].args, { pattern: '**/*.ts', path: '/remote/project' });
    assert.deepEqual(calls[1].args, { pattern: 'needle', path: '/remote/project', output_mode: 'files' });
  });

  test('redacts local absolute paths from successful CatsCo device file results', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    const outPath = path.join(root, 'out.txt');
    fs.writeFileSync(filePath, 'allowed content\nneedle');
    fs.writeFileSync(outPath, 'before');
    const ctx = context(root, {
      deviceGrants: [deviceGrant(['read_file', 'glob', 'grep', 'write_file', 'edit_file', 'send_file'])],
    });
    ctx.channel = {
      chatId: scope().topicId,
      reply: async () => {},
      sendFile: async () => {},
    };

    const read = await new ReadTool().execute({ file_path: filePath }, ctx);
    assert.equal(read.ok, true);
    assert.doesNotMatch(String(read.content), new RegExp(escapeRegExp(filePath)));

    const glob = await new GlobTool().execute({ pattern: '*.txt', path: root }, ctx);
    assert.equal(glob.ok, true);
    assert.match(String(glob.content), /notes\.txt/);
    assert.doesNotMatch(String(glob.content), new RegExp(escapeRegExp(root)));

    const grep = await new GrepTool().execute({ pattern: 'needle', path: filePath, output_mode: 'content' }, ctx);
    assert.equal(grep.ok, true);
    assert.match(String(grep.content), /needle/);
    assert.doesNotMatch(String(grep.content), new RegExp(escapeRegExp(root)));

    const write = await new WriteTool().execute({ file_path: outPath, content: 'after' }, ctx);
    assert.equal(write.ok, true);
    assert.doesNotMatch(String(write.content), new RegExp(escapeRegExp(outPath)));

    const edit = await new EditTool().execute({ file_path: outPath, old_string: 'after', new_string: 'done' }, ctx);
    assert.equal(edit.ok, true);
    assert.doesNotMatch(String(edit.content), new RegExp(escapeRegExp(outPath)));

    const send = await new SendFileTool().execute({ file_path: filePath, file_name: 'notes.txt' }, ctx);
    assert.equal(send.ok, true);
    assert.doesNotMatch(String(send.content), new RegExp(escapeRegExp(filePath)));
  });

  test('redacts local absolute paths from CatsCo device file failure results', async () => {
    const root = makeWorkspace();
    const missingPath = path.join(root, 'missing.txt');
    const ctx = context(root, {
      deviceGrants: [deviceGrant(['read_file', 'send_file'])],
    });

    const readDirectory = await new ReadTool().execute({ file_path: root }, ctx);
    assert.equal(readDirectory.ok, false);
    if (!readDirectory.ok) {
      assert.equal(readDirectory.errorCode, 'TOOL_EXECUTION_ERROR');
      assert.match(readDirectory.message, /Path is not a file/);
      assert.doesNotMatch(readDirectory.message, new RegExp(escapeRegExp(root)));
    }

    const sendMissing = await new SendFileTool().execute({ file_path: missingPath, file_name: 'missing.txt' }, ctx);
    assert.equal(sendMissing.ok, false);
    if (!sendMissing.ok) {
      assert.equal(sendMissing.errorCode, 'FILE_NOT_FOUND');
      assert.match(sendMissing.message, /File not found/);
      assert.doesNotMatch(sendMissing.message, new RegExp(escapeRegExp(missingPath)));
      assert.doesNotMatch(sendMissing.message, new RegExp(escapeRegExp(root)));
    }

    const sendDirectory = await new SendFileTool().execute({ file_path: root, file_name: 'root' }, ctx);
    assert.equal(sendDirectory.ok, false);
    if (!sendDirectory.ok) {
      assert.equal(sendDirectory.errorCode, 'TOOL_EXECUTION_ERROR');
      assert.match(sendDirectory.message, /Path is not a file/);
      assert.doesNotMatch(sendDirectory.message, new RegExp(escapeRegExp(root)));
    }
  });

  test('allows glob only when the CatsCo device grant includes glob operation', async () => {
    const root = makeWorkspace();
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');

    const denied = await new GlobTool().execute({ pattern: '*.txt' }, context(root, {
      deviceGrants: [deviceGrant(['read_file'])],
    }));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.message, /执行 glob/);

    const allowed = await new GlobTool().execute({ pattern: '*.txt' }, context(root, {
      deviceGrants: [deviceGrant(['glob'])],
    }));
    assert.equal(allowed.ok, true);
    assert.match(String(allowed.content), /a\.txt/);
  });

  test('blocks write_file until the server grants write_file for the current device', async () => {
    const root = makeWorkspace();
    const result = await new WriteTool().execute({ file_path: 'out.txt', content: 'hello' }, context(root, {
      deviceGrants: [deviceGrant(['read_file'])],
    }));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /执行 write_file/);
      assert.equal(fs.existsSync(path.join(root, 'out.txt')), false);
    }
  });

  test('blocks execute_shell in CatsCo sessions even when a grant contains execute_shell', async () => {
    const root = makeWorkspace();
    const result = await new ShellTool().execute({ command: 'echo hello' }, context(root, {
      deviceGrants: [deviceGrant(['execute_shell'])],
    }));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /暂不允许通过 execute_shell/);
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

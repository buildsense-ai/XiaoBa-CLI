import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/tools/read-tool';
import { WriteTool } from '../src/tools/write-tool';
import { GlobTool } from '../src/tools/glob-tool';
import { CommonDirectoryTool } from '../src/tools/common-directory-tool';
import type { ExecutionScope, ScopedDeviceSelection, ScopedLocalDeviceGrant } from '../src/types/session-identity';
import type { DeviceRpcTransport, ToolExecutionContext } from '../src/types/tool';

function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-agent',
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
    ownerUserId: 'agent-owner',
    bodyId: 'body-agent',
    installationId: 'agent-install',
    deviceId: 'agent-device',
    createdAt: Date.now(),
    ...overrides,
  };
}

function selection(overrides: Partial<ScopedDeviceSelection> = {}): ScopedDeviceSelection {
  const current = scope();
  return {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    sessionKey: current.sessionKey,
    topicId: current.topicId,
    topicType: current.topicType,
    actorUserId: current.actorUserId,
    agentId: current.agentId,
    identityTrust: 'server_canonical',
    selectedDeviceId: 'speaker-device',
    selectedDeviceDisplayName: 'Alice Laptop',
    selectedDeviceBodyId: 'speaker-body',
    selectedDeviceInstallationId: 'speaker-install',
    ...overrides,
  };
}

function context(root: string, options: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workingDirectory: root,
    workspaceRoot: root,
    conversationHistory: [],
    surface: 'catscompany',
    executionScope: scope(),
    localDeviceGrant: localDevice(),
    ...options,
  };
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-tool-gateway-'));
}

describe('CatsCo ToolGateway lightweight routing', () => {
  test('defaults target-capable tools to the agent computer without device grants', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'agent file');

    const read = await new ReadTool().execute({ file_path: filePath }, context(root));
    const write = await new WriteTool().execute({ file_path: 'created.txt', content: 'created locally' }, context(root));

    assert.equal(read.ok, true);
    assert.match(read.ok ? String(read.content) : '', /agent file/);
    assert.equal(write.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'created.txt'), 'utf8'), 'created locally');
  });

  test('does not redact absolute paths from local tool results', async () => {
    const root = makeWorkspace();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'needle');

    const read = await new ReadTool().execute({ file_path: filePath }, context(root));
    const glob = await new GlobTool().execute({ pattern: '*.txt', path: root }, context(root));

    assert.equal(read.ok, true);
    assert.match(read.ok ? String(read.content) : '', new RegExp(escapeRegExp(filePath)));
    assert.equal(glob.ok, true);
    assert.match(glob.ok ? String(glob.content) : '', new RegExp(escapeRegExp(root)));
  });

  test('routes to Device RPC only when target is speaker_default', async () => {
    const root = makeWorkspace();
    const calls: Array<{ toolName: string; args: Record<string, unknown>; grantId: string }> = [];
    const deviceRpc: DeviceRpcTransport = {
      executeTool: async request => {
        calls.push({ toolName: request.toolName, args: request.args, grantId: request.grant.grantId });
        return { ok: true, content: `remote ${request.toolName}` };
      },
    };
    const remoteContext = context(root, { deviceSelection: selection(), deviceRpc });

    const read = await new ReadTool().execute({ target: 'speaker_default', file_path: 'C:\\Users\\Alice\\Desktop\\note.txt' }, remoteContext);
    const dir = await new CommonDirectoryTool().execute({ target: 'speaker_default', directory: 'desktop' }, remoteContext);
    const glob = await new GlobTool().execute({ target: 'speaker_default', pattern: '*', path: 'C:\\Users\\Alice\\Desktop' }, remoteContext);

    assert.equal(read.ok, true);
    assert.equal(dir.ok, true);
    assert.equal(glob.ok, true);
    assert.deepEqual(calls.map(call => call.toolName), ['read_file', 'resolve_common_directory', 'glob']);
    assert.ok(calls.every(call => call.grantId.startsWith('lightweight_')));
  });

  test('speaker_default fails clearly when no selected device or RPC transport exists', async () => {
    const root = makeWorkspace();
    const noSelection = await new ReadTool().execute({ target: 'speaker_default', file_path: 'missing.txt' }, context(root));
    const noRpc = await new ReadTool().execute({ target: 'speaker_default', file_path: 'missing.txt' }, context(root, {
      deviceSelection: selection(),
    }));

    assert.equal(noSelection.ok, false);
    assert.equal(noRpc.ok, false);
    assert.match(noRpc.ok ? '' : noRpc.message, /RPC/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

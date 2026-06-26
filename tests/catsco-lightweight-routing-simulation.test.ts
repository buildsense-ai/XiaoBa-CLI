import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildRuntimeContextMessage, TRANSIENT_RUNTIME_CONTEXT_PREFIX } from '../src/core/runtime-context-builder';
import { GlobTool } from '../src/tools/glob-tool';
import { WriteTool } from '../src/tools/write-tool';
import { ShellTool } from '../src/tools/bash-tool';
import type { ExecutionScope, ScopedDeviceSelection, ScopedLocalDeviceGrant } from '../src/types/session-identity';
import type { DeviceRpcTransport, ToolExecutionContext } from '../src/types/tool';

function groupScope(): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'session:v2:catscompany:group:grp_demo%3Aactor%3Ausr8:agent:usr43',
    topicId: 'grp_demo',
    topicType: 'group',
    actorUserId: 'usr8',
    agentId: 'usr43',
    agentBodyId: 'body-agent',
    permissionsSource: 'server_canonical_message',
    identityTrust: 'server_canonical',
    isTrusted: true,
  };
}

function localDevice(): ScopedLocalDeviceGrant {
  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    ownerUserId: 'agent-owner',
    bodyId: 'body-agent',
    installationId: 'agent-install',
    deviceId: 'agent-device',
    createdAt: Date.now(),
  };
}

function speakerSelection(): ScopedDeviceSelection {
  const scope = groupScope();
  return {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    identityTrust: 'server_canonical',
    selectedDeviceId: 'bob-laptop',
    selectedDeviceDisplayName: 'Bob Laptop',
    selectedDeviceBodyId: 'bob-body',
    selectedDeviceInstallationId: 'bob-install',
  };
}

function context(root: string, deviceRpc?: DeviceRpcTransport): ToolExecutionContext {
  return {
    workingDirectory: root,
    workspaceRoot: root,
    conversationHistory: [],
    surface: 'catscompany',
    executionScope: groupScope(),
    localDeviceGrant: localDevice(),
    deviceSelection: speakerSelection(),
    deviceRpc,
  };
}

describe('CatsCo lightweight group routing simulation', () => {
  test('other user desktop uses speaker_default while bot desktop defaults to agent_self', async () => {
    const agentDesktop = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-agent-desktop-'));
    const bobDesktop = 'C:\\Users\\Bob\\Desktop';
    const remoteCalls: Array<{ toolName: string; args: Record<string, unknown>; grantId: string }> = [];
    let remoteHelloExists = false;
    const deviceRpc: DeviceRpcTransport = {
      executeTool: async request => {
        remoteCalls.push({ toolName: request.toolName, args: request.args, grantId: request.grant.grantId });
        if (request.toolName === 'glob') {
          return { ok: true, content: remoteHelloExists ? `${bobDesktop}\\hello-world.txt` : `${bobDesktop}\\before.txt` };
        }
        if (request.toolName === 'write_file') {
          remoteHelloExists = true;
          return { ok: true, content: `created ${request.args.file_path}` };
        }
        if (request.toolName === 'execute_shell') {
          remoteHelloExists = false;
          return { ok: true, content: `deleted ${bobDesktop}\\hello-world.txt` };
        }
        return { ok: true, content: 'ok' };
      },
    };
    const runtimeContext = buildRuntimeContextMessage({
      sessionKey: groupScope().sessionKey,
      executionScope: groupScope(),
      localDeviceGrant: localDevice(),
      deviceSelection: speakerSelection(),
      currentDirectory: agentDesktop,
    });
    assert.ok(runtimeContext);
    assert.ok(String(runtimeContext.content).startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX));
    const snapshot = JSON.parse(String(runtimeContext.content).slice(TRANSIENT_RUNTIME_CONTEXT_PREFIX.length).trim());
    assert.equal(snapshot.conversation.type, 'group');
    assert.equal(snapshot.conversation.currentSpeaker.id, 'usr8');
    assert.equal(snapshot.defaultTarget, 'agent_self');
    assert.deepEqual(snapshot.toolTargeting.targetParameterTools, [
      'resolve_common_directory',
      'glob',
      'grep',
      'read_file',
      'write_file',
      'edit_file',
      'execute_shell',
    ]);
    assert.equal(snapshot.executionTargets[0].id, 'agent_self');
    assert.equal(snapshot.executionTargets[1].id, 'speaker_default');

    const ctx = context(agentDesktop, deviceRpc);

    const remoteList = await new GlobTool().execute({ target: 'speaker_default', pattern: '*', path: bobDesktop }, ctx);
    const remoteCreate = await new WriteTool().execute({
      target: 'speaker_default',
      file_path: `${bobDesktop}\\hello-world.txt`,
      content: 'hello world',
    }, ctx);
    const remoteDelete = await new ShellTool().execute({
      target: 'speaker_default',
      command: `Remove-Item -LiteralPath "${bobDesktop}\\hello-world.txt" -Force`,
    }, ctx);

    assert.equal(remoteList.ok, true);
    assert.equal(remoteCreate.ok, true);
    assert.equal(remoteDelete.ok, true);
    assert.equal(remoteHelloExists, false);
    assert.deepEqual(remoteCalls.map(call => call.toolName), ['glob', 'write_file', 'execute_shell']);
    assert.ok(remoteCalls.every(call => call.grantId.startsWith('lightweight_')));
    assert.deepEqual(remoteCalls[0].args, { target: 'speaker_default', pattern: '*', path: bobDesktop });

    const localList = await new GlobTool().execute({ pattern: '*', path: agentDesktop }, ctx);
    const localPath = path.join(agentDesktop, 'hello-world.txt');
    const localCreate = await new WriteTool().execute({ file_path: localPath, content: 'hello world' }, ctx);
    assert.equal(fs.existsSync(localPath), true);
    const localDelete = await new ShellTool().execute({
      command: `node -e "require('fs').unlinkSync(process.argv[1])" "${localPath}"`,
    }, ctx);

    assert.equal(localList.ok, true);
    assert.equal(localCreate.ok, true);
    assert.equal(localDelete.ok, true);
    assert.equal(fs.existsSync(localPath), false);
    assert.deepEqual(remoteCalls.map(call => call.toolName), ['glob', 'write_file', 'execute_shell']);
  });
});

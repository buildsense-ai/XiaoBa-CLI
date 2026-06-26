import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_TOOL_NAMES } from '../src/tools/default-tool-names';
import { ToolManager } from '../src/tools/tool-manager';
import { AgentToolExecutor } from '../src/agents/agent-tool-executor';
import type { Tool, ToolExecutionContext } from '../src/types/tool';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalDeviceGrant,
} from '../src/types/session-identity';

function fakeTool(name: string, execute: Tool['execute']): Tool {
  return {
    definition: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
    execute,
  };
}

function catsScope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-local',
    permissionsSource: 'server_canonical_message',
    identityTrust: 'server_canonical',
    isTrusted: true,
    ...overrides,
  };
}

function catsLocalDevice(overrides: Partial<ScopedLocalDeviceGrant> = {}): ScopedLocalDeviceGrant {
  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    ownerUserId: 'usr7',
    bodyId: 'body-local',
    installationId: 'install-local',
    deviceId: 'install-local',
    createdAt: Date.now(),
    ...overrides,
  };
}

function catsDeviceGrant(
  scope: ExecutionScope,
  operations: ScopedDeviceGrant['operations'],
  overrides: Partial<ScopedDeviceGrant> = {},
): ScopedDeviceGrant {
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: 'device-grant-main',
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'metadata.catsco_identity',
    deviceId: 'install-local',
    deviceDisplayName: 'Local Device',
    deviceBodyId: 'body-local',
    deviceInstallationId: 'install-local',
    ownerUserId: scope.actorUserId,
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    agentBodyId: scope.agentBodyId,
    operations,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function catsDeviceSelection(
  scope: ExecutionScope,
  operations: ScopedDeviceGrant['operations'],
  overrides: Partial<ScopedDeviceSelection> = {},
): ScopedDeviceSelection {
  return {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    selectionSource: 'single_active_device',
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    identityTrust: 'server_canonical',
    identitySource: 'metadata.catsco_identity',
    selectedDeviceId: 'install-local',
    selectedDeviceDisplayName: 'Local Device',
    selectedDeviceBodyId: 'body-local',
    selectedDeviceInstallationId: 'install-local',
    selectedDeviceOperations: operations,
    ...overrides,
  };
}

describe('ToolManager', () => {
  test('registers all default tools when no enabled list is provided', () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager');

    assert.deepStrictEqual(
      manager.getToolDefinitions().map(definition => definition.name),
      DEFAULT_TOOL_NAMES,
    );
  });

  test('registers only enabled default tools when an enabled list is provided', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, {
      enabledToolNames: [
        'read_file',
        'execute_shell',
      ],
    });

    assert.deepStrictEqual(
      manager.getToolDefinitions().map(definition => definition.name),
      ['read_file', 'execute_shell'],
    );
    assert.equal(manager.getToolCount(), 2);
    assert.equal(manager.getTool('write_file'), undefined);

    const result = await manager.executeTool({
      id: 'call-disabled',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: '{}',
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'TOOL_NOT_FOUND');
    assert.match(result.content, /未找到工具 "write_file"/);
  });

  test('registers ask_parent only when explicitly enabled for subagents', async () => {
    const defaultManager = new ToolManager('/tmp/xiaoba-tool-manager');
    assert.equal(defaultManager.getTool('ask_parent'), undefined);

    const subAgentManager = new ToolManager('/tmp/xiaoba-tool-manager', {}, {
      enabledToolNames: ['read_file', 'ask_parent'],
    });

    assert.deepStrictEqual(
      subAgentManager.getToolDefinitions().map(definition => definition.name),
      ['read_file', 'ask_parent'],
    );

    const result = await subAgentManager.executeTool({
      id: 'call-ask-parent',
      type: 'function',
      function: {
        name: 'ask_parent',
        arguments: JSON.stringify({ question: '继续吗？' }),
      },
    }, [], {
      requestParentInput: async question => `收到问题：${question}`,
    });

    assert.equal(result.ok, true);
    assert.match(result.content, /收到问题：继续吗/);
  });

  test('strict local low-risk tools do not require confirmation', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    let confirmed = false;
    manager.registerTool(fakeTool('read_file', async () => ({ ok: true, content: 'read ok' })));

    const result = await manager.executeTool({
      id: 'call-read',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'a.txt' }) },
    }, [], {
      permissionProfile: 'strict',
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'read ok');
    assert.equal(confirmed, false);
  });

  test('strict local read outside the workspace requires confirmation', async () => {
    const workspace = path.resolve('/tmp/xiaoba-tool-manager');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('read_file', async () => {
      executed = true;
      return { ok: true, content: 'read ok' };
    }));

    const denied = await manager.executeTool({
      id: 'call-read-outside',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ file_path: path.resolve('/tmp/outside-secret.txt') }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async request => {
        assert.equal(request.toolName, 'read_file');
        assert.equal(request.risk, 'medium');
        return { approved: false, reason: '需要用户选择文件' };
      },
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, 'PERMISSION_DENIED');
    assert.equal(denied.content, '需要用户选择文件');
    assert.equal(executed, false);
  });

  test('strict local sensitive reads require high-risk confirmation', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    manager.registerTool(fakeTool('read_file', async () => ({ ok: true, content: 'read ok' })));

    const result = await manager.executeTool({
      id: 'call-read-env',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ file_path: '.env' }) },
    }, [], {
      permissionProfile: 'strict',
      confirmToolExecution: async request => {
        assert.equal(request.risk, 'high');
        return false;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
  });

  test('strict local glob absolute pattern outside workspace requires confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-outside-'));
    const outsidePattern = path.join(outside, '**', '*.json');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('glob', async () => {
      executed = true;
      return { ok: true, content: 'glob ok' };
    }));

    const result = await manager.executeTool({
      id: 'call-glob-absolute',
      type: 'function',
      function: { name: 'glob', arguments: JSON.stringify({ pattern: outsidePattern }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async request => {
        assert.equal(request.toolName, 'glob');
        assert.equal(request.risk, 'medium');
        return { approved: false, reason: '搜索范围不在当前工作区' };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(result.content, '搜索范围不在当前工作区');
    assert.equal(executed, false);
  });

  test('strict local write can create new ordinary workspace files without confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let confirmed = false;
    manager.registerTool(fakeTool('write_file', async () => ({ ok: true, content: 'write ok' })));

    const result = await manager.executeTool({
      id: 'call-write-new',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'new-note.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'write ok');
    assert.equal(confirmed, false);
  });

  test('strict local write waits for confirmation and respects denial', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('write_file', async () => {
      executed = true;
      return { ok: true, content: 'write ok' };
    }));

    const denied = await manager.executeTool({
      id: 'call-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async () => ({ approved: false, reason: '用户取消' }),
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, 'PERMISSION_DENIED');
    assert.equal(denied.content, '用户取消');
    assert.equal(executed, false);

    const approved = await manager.executeTool({
      id: 'call-write-2',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async request => {
        assert.equal(request.toolName, 'write_file');
        assert.equal(request.risk, 'medium');
        return true;
      },
    });

    assert.equal(approved.ok, true);
    assert.equal(approved.content, 'write ok');
    assert.equal(executed, true);
  });

  test('strict local write returns retryable confirmation request without provider', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-workspace-'));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    manager.registerTool(fakeTool('write_file', async () => ({ ok: true, content: 'write ok' })));

    const result = await manager.executeTool({
      id: 'call-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'NEEDS_CONFIRMATION');
    assert.equal(result.retryable, true);
    assert.match(String(result.content), /需要用户确认/);
  });

  test('strict local unknown tools require confirmation instead of defaulting to low risk', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('custom_mutating_tool', async () => {
      executed = true;
      return { ok: true, content: 'custom ok' };
    }));

    const result = await manager.executeTool({
      id: 'call-custom',
      type: 'function',
      function: { name: 'custom_mutating_tool', arguments: JSON.stringify({}) },
    }, [], { permissionProfile: 'strict' });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'NEEDS_CONFIRMATION');
    assert.equal(executed, false);
  });

  test('CatsCo context can create new ordinary home files without confirmation', async () => {
    const manager = new ToolManager('/tmp/xiaoba-tool-manager', {}, { enabledToolNames: [] });
    let confirmed = false;
    manager.registerTool(fakeTool('write_file', async () => ({ ok: true, content: 'catsco tool ran' })));
    const target = path.join(os.homedir(), `xiaoba-catsco-new-${Date.now()}.txt`);

    const result = await manager.executeTool({
      id: 'call-catsco-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: target, content: 'hello' }) },
    }, [], {
      surface: 'catscompany',
      permissionProfile: 'strict',
      workingDirectory: '/tmp/xiaoba-tool-manager',
      workspaceRoot: '/tmp/xiaoba-tool-manager',
      executionScope: catsScope(),
      localDeviceGrant: catsLocalDevice(),
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'catsco tool ran');
    assert.equal(confirmed, false);
  });

  test('CatsCo local owner self runs write edit send and shell without confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-workspace-'));
    const existing = path.join(workspace, 'a.txt');
    fs.writeFileSync(existing, 'old');
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    const executed: string[] = [];
    manager.registerTool(fakeTool('write_file', async () => {
      executed.push('write_file');
      return { ok: true, content: 'catsco overwrite ran' };
    }));
    manager.registerTool(fakeTool('edit_file', async () => {
      executed.push('edit_file');
      return { ok: true, content: 'catsco edit ran' };
    }));
    manager.registerTool(fakeTool('send_file', async () => {
      executed.push('send_file');
      return { ok: true, content: 'catsco send ran' };
    }));
    manager.registerTool(fakeTool('execute_shell', async () => {
      executed.push('execute_shell');
      return { ok: true, content: 'catsco shell ran' };
    }));
    let confirmed = false;
    const catsContext = {
      surface: 'catscompany' as const,
      permissionProfile: 'strict' as const,
      workingDirectory: workspace,
      workspaceRoot: workspace,
      executionScope: catsScope(),
      localDeviceGrant: catsLocalDevice(),
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    };

    const write = await manager.executeTool({
      id: 'call-catsco-overwrite',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: existing, content: 'hello' }) },
    }, [], catsContext);
    const edit = await manager.executeTool({
      id: 'call-catsco-edit',
      type: 'function',
      function: { name: 'edit_file', arguments: JSON.stringify({ file_path: existing, old_string: 'old', new_string: 'new' }) },
    }, [], catsContext);
    const send = await manager.executeTool({
      id: 'call-catsco-send',
      type: 'function',
      function: { name: 'send_file', arguments: JSON.stringify({ file_path: existing }) },
    }, [], catsContext);
    const shell = await manager.executeTool({
      id: 'call-catsco-shell',
      type: 'function',
      function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'Remove-Item -Recurse C:\\danger' }) },
    }, [], catsContext);

    assert.equal(write.ok, true);
    assert.equal(edit.ok, true);
    assert.equal(send.ok, true);
    assert.equal(shell.ok, true);
    assert.deepEqual(executed, ['write_file', 'edit_file', 'send_file', 'execute_shell']);
    assert.equal(confirmed, false);
  });

  test('CatsCo virtual employee local body runs shell without confirmation for non-owner actors', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-agent-body-'));
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('execute_shell', async () => {
      executed = true;
      return { ok: true, content: 'agent body shell ran' };
    }));
    let confirmed = false;

    const result = await manager.executeTool({
      id: 'call-catsco-agent-body-shell',
      type: 'function',
      function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'Remove-Item -Recurse C:\\danger' }) },
    }, [], {
      surface: 'catscompany',
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      executionScope: catsScope({
        actorUserId: 'usr100',
        sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
        topicId: 'p2p_100_43',
      }),
      localDeviceGrant: catsLocalDevice({ ownerUserId: 'usr7' }),
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'agent body shell ran');
    assert.equal(executed, true);
    assert.equal(confirmed, false);
  });

  test('CatsCo target context preserves explicit shell cwd strings from the target device', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-agent-body-'));
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    manager.registerTool(fakeTool('execute_shell', async () => {
      return { ok: true, content: 'agent body shell ran' };
    }));
    const cwdCases = ['/Users/alice/Desktop', 'remote/session/Desktop'];

    for (const [index, targetCwd] of cwdCases.entries()) {
      const result = await manager.executeTool({
        id: `call-catsco-agent-body-shell-cwd-${index}`,
        type: 'function',
        function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'echo ok', cwd: targetCwd }) },
      }, [], {
        surface: 'catscompany',
        permissionProfile: 'strict',
        workingDirectory: workspace,
        workspaceRoot: workspace,
        executionScope: catsScope({
          actorUserId: 'usr100',
          sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
          topicId: 'p2p_100_43',
        }),
        localDeviceGrant: catsLocalDevice({ ownerUserId: 'usr7' }),
      });

      assert.equal(result.ok, true);
      assert.match(result.targetContext || '', new RegExp(`cwd: ${escapeRegExp(targetCwd)}`));
      assert.doesNotMatch(result.targetContext || '', /xiaoba-catsco-agent-body-[^\n]+[\\/]Users[\\/]alice[\\/]Desktop/);
      assert.doesNotMatch(result.targetContext || '', new RegExp(`${escapeRegExp(workspace)}[\\\\/]remote[\\\\/]session[\\\\/]Desktop`));
    }
  });

  test('CatsCo lightweight shell contexts skip strict local confirmation', async () => {
    const cases: Array<{
      name: string;
      executionScope: ExecutionScope;
      localDeviceGrant: ScopedLocalDeviceGrant;
    }> = [
      {
        name: 'agent body mismatch',
        executionScope: catsScope({
          actorUserId: 'usr100',
          sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
          topicId: 'p2p_100_43',
          agentBodyId: 'body-other',
        }),
        localDeviceGrant: catsLocalDevice({ ownerUserId: 'usr7' }),
      },
      {
        name: 'untrusted identity',
        executionScope: catsScope({
          actorUserId: 'usr100',
          sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
          topicId: 'p2p_100_43',
          identityTrust: 'untrusted',
          isTrusted: false,
        }),
        localDeviceGrant: catsLocalDevice({ ownerUserId: 'usr7' }),
      },
      {
        name: 'non-CatsCo local device',
        executionScope: catsScope({
          actorUserId: 'usr100',
          sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
          topicId: 'p2p_100_43',
        }),
        localDeviceGrant: catsLocalDevice({
          ownerUserId: 'usr7',
          source: 'cli',
        } as Partial<ScopedLocalDeviceGrant>),
      },
      {
        name: 'missing local body id',
        executionScope: catsScope({
          actorUserId: 'usr100',
          sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
          topicId: 'p2p_100_43',
        }),
        localDeviceGrant: catsLocalDevice({
          ownerUserId: 'usr7',
          bodyId: undefined,
        } as Partial<ScopedLocalDeviceGrant>),
      },
    ];

    for (const item of cases) {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-non-agent-body-'));
      const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
      let executed = false;
      let confirmations = 0;
      manager.registerTool(fakeTool('execute_shell', async () => {
        executed = true;
        return { ok: true, content: 'ran without confirmation' };
      }));

      const result = await manager.executeTool({
        id: `call-catsco-shell-${item.name.replace(/\W+/g, '-')}`,
        type: 'function',
        function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'echo should-confirm' }) },
      }, [], {
        surface: 'catscompany',
        permissionProfile: 'strict',
        workingDirectory: workspace,
        workspaceRoot: workspace,
        executionScope: item.executionScope,
        localDeviceGrant: item.localDeviceGrant,
        confirmToolExecution: async () => {
          confirmations += 1;
          return false;
        },
      });

      assert.equal(result.ok, true, item.name);
      assert.equal(result.content, 'ran without confirmation', item.name);
      assert.equal(executed, true, item.name);
      assert.equal(confirmations, 0, item.name);
    }
  });

  test('CatsCo local owner self accepts numeric local owner ids from saved config', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-owner-id-'));
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('write_file', async () => {
      executed = true;
      return { ok: true, content: 'catsco write ran' };
    }));
    let confirmed = false;

    const result = await manager.executeTool({
      id: 'call-catsco-numeric-owner',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      surface: 'catscompany',
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      executionScope: catsScope({ actorUserId: 'usr7' }),
      localDeviceGrant: catsLocalDevice({ ownerUserId: '7' }),
      confirmToolExecution: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(executed, true);
    assert.equal(confirmed, false);
  });

  test('CatsCo server-authorized remote file tools skip local confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-remote-file-'));
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    const executed: string[] = [];
    const operations: ScopedDeviceGrant['operations'] = ['read_file', 'glob', 'grep', 'write_file', 'edit_file'];
    for (const operation of operations) {
      manager.registerTool(fakeTool(operation, async () => {
        executed.push(operation);
        return { ok: true, content: `remote ${operation} requested` };
      }));
    }

    const channelScope = catsScope({
      actorUserId: 'usr100',
      sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
      topicId: 'p2p_100_43',
      deviceOwnerUserId: 'usr100',
      deviceOwnerSource: 'channel_identity_link',
      channelSource: 'weixin',
    });
    let confirmations = 0;
    const remoteContext: Partial<ToolExecutionContext> = {
      surface: 'catscompany',
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      executionScope: channelScope,
      localDeviceGrant: catsLocalDevice({
        ownerUserId: 'usr9',
        bodyId: 'cloud-body',
        installationId: 'cloud-install',
        deviceId: 'cloud-install',
      }),
      deviceGrants: [catsDeviceGrant(channelScope, operations, {
        grantId: 'speaker-file-grant',
        identitySource: 'channel_identity_link',
        deviceId: 'speaker-device',
        deviceDisplayName: 'Speaker Laptop',
        deviceBodyId: 'speaker-body',
        deviceInstallationId: 'speaker-install',
        ownerUserId: 'usr100',
        actorUserId: 'usr100',
      })],
      deviceSelection: catsDeviceSelection(channelScope, operations, {
        selectedDeviceId: 'speaker-device',
        selectedDeviceDisplayName: 'Speaker Laptop',
        selectedDeviceBodyId: 'speaker-body',
        selectedDeviceInstallationId: 'speaker-install',
      }),
      deviceRpc: {
        executeTool: async () => ({ ok: true, content: 'remote ok' }),
      },
      confirmToolExecution: async () => {
        confirmations += 1;
        return false;
      },
    };

    const read = await manager.executeTool({
      id: 'call-remote-read',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'C:\\Users\\Alice\\Desktop\\note.txt' }),
      },
    }, [], remoteContext);
    const glob = await manager.executeTool({
      id: 'call-remote-glob',
      type: 'function',
      function: {
        name: 'glob',
        arguments: JSON.stringify({ pattern: '*', path: 'C:\\Users\\Alice\\Desktop' }),
      },
    }, [], remoteContext);
    const grep = await manager.executeTool({
      id: 'call-remote-grep',
      type: 'function',
      function: {
        name: 'grep',
        arguments: JSON.stringify({ pattern: 'needle', path: 'C:\\Users\\Alice\\Desktop', output_mode: 'files' }),
      },
    }, [], remoteContext);
    const write = await manager.executeTool({
      id: 'call-remote-write',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ file_path: 'C:\\Users\\Alice\\Desktop\\note.txt', content: 'hello' }),
      },
    }, [], remoteContext);
    const edit = await manager.executeTool({
      id: 'call-remote-edit',
      type: 'function',
      function: {
        name: 'edit_file',
        arguments: JSON.stringify({ file_path: 'C:\\Users\\Alice\\Desktop\\note.txt', old_string: 'hello', new_string: 'hi' }),
      },
    }, [], remoteContext);

    assert.equal(read.ok, true);
    assert.equal(read.content, 'remote read_file requested');
    assert.equal(write.ok, true);
    assert.equal(write.content, 'remote write_file requested');
    assert.equal(glob.ok, true);
    assert.equal(glob.content, 'remote glob requested');
    assert.equal(grep.ok, true);
    assert.equal(grep.content, 'remote grep requested');
    assert.equal(edit.ok, true);
    assert.equal(edit.content, 'remote edit_file requested');
    assert.deepEqual(executed, operations);
    assert.equal(confirmations, 0);
  });

  test('CatsCo server-authorized remote execute_shell skips local confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-remote-shell-'));
    const manager = new ToolManager(workspace, {}, { enabledToolNames: [] });
    let executed = false;
    manager.registerTool(fakeTool('execute_shell', async () => {
      executed = true;
      return { ok: true, content: 'remote shell requested' };
    }));

    const channelScope = catsScope({
      actorUserId: 'usr100',
      sessionKey: 'session:v2:catscompany:p2p:p2p_100_43:agent:usr43',
      topicId: 'p2p_100_43',
      deviceOwnerUserId: 'usr100',
      deviceOwnerSource: 'channel_identity_link',
      channelSource: 'weixin',
    });
    const remoteContext: Partial<ToolExecutionContext> = {
      surface: 'catscompany',
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      executionScope: channelScope,
      localDeviceGrant: catsLocalDevice({
        ownerUserId: 'usr9',
        bodyId: 'cloud-body',
        installationId: 'cloud-install',
        deviceId: 'cloud-install',
      }),
      deviceGrants: [catsDeviceGrant(channelScope, ['execute_shell'], {
        grantId: 'speaker-shell-grant',
        identitySource: 'channel_identity_link',
        deviceId: 'speaker-device',
        deviceDisplayName: 'Speaker Laptop',
        deviceBodyId: 'speaker-body',
        deviceInstallationId: 'speaker-install',
        ownerUserId: 'usr100',
        actorUserId: 'usr100',
      })],
      deviceSelection: catsDeviceSelection(channelScope, ['execute_shell'], {
        selectedDeviceId: 'speaker-device',
        selectedDeviceDisplayName: 'Speaker Laptop',
        selectedDeviceBodyId: 'speaker-body',
        selectedDeviceInstallationId: 'speaker-install',
      }),
      deviceRpc: {
        executeTool: async () => ({ ok: true, content: 'remote shell ok' }),
      },
    };
    let confirmations = 0;

    const result = await manager.executeTool({
      id: 'call-remote-shell',
      type: 'function',
      function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'echo remote-shell' }) },
    }, [], {
      ...remoteContext,
      confirmToolExecution: async () => {
        confirmations += 1;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.content, 'remote shell requested');
    assert.equal(executed, true);
    assert.equal(confirmations, 0);
  });

  test('AgentToolExecutor uses the same local confirmation gate', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-agent-workspace-'));
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
    let executed = false;
    const executor = new AgentToolExecutor([
      fakeTool('write_file', async () => {
        executed = true;
        return { ok: true, content: 'agent write ok' };
      }),
    ], workspace);

    const result = await executor.executeTool({
      id: 'agent-write',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'a.txt', content: 'hello' }) },
    }, [], {
      permissionProfile: 'strict',
      workingDirectory: workspace,
      workspaceRoot: workspace,
      confirmToolExecution: async () => false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(executed, false);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

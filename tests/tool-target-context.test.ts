import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildToolTargetContext, stripToolTargetContextForDisplay } from '../src/tools/tool-target-context';
import type { ToolExecutionContext } from '../src/types/tool';

const runtimeCwd = path.resolve('runtime-repo');

function catsContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workingDirectory: runtimeCwd,
    workspaceRoot: runtimeCwd,
    conversationHistory: [],
    surface: 'catscompany',
    executionScope: {
      source: 'catscompany',
      sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
      topicId: 'p2p_7_43',
      topicType: 'p2p',
      actorUserId: 'usr7',
      agentId: 'usr43',
      agentBodyId: 'body-agent',
      identityTrust: 'server_canonical',
      isTrusted: true,
    },
    localDeviceGrant: {
      kind: 'catscompany_body',
      source: 'catscompany',
      bodyId: 'body-agent',
      deviceId: 'install-agent',
      installationId: 'install-agent',
      ownerUserId: 'usr9',
      createdAt: Date.now(),
    },
    ...overrides,
  };
}

describe('tool target context', () => {
  test('labels virtual employee cloud runtime results', () => {
    const context = buildToolTargetContext(catsContext(), {
      toolName: 'execute_shell',
      operation: 'execute_shell',
      cwd: runtimeCwd,
      shell: 'powershell',
    });

    assert.ok(context);
    assert.match(context, /^\[tool_target\]/);
    assert.match(context, /target: virtual_employee_cloud_runtime/);
    assert.match(context, new RegExp(`cwd: ${escapeRegExp(runtimeCwd)}`));
    assert.match(context, /shell: powershell/);
  });

  test('preserves target-device POSIX cwd without host OS normalization', () => {
    const remoteCwd = '/Users/alice/Desktop';
    const context = buildToolTargetContext(catsContext(), {
      toolName: 'execute_shell',
      operation: 'execute_shell',
      cwd: remoteCwd,
    });

    assert.ok(context);
    assert.match(context, new RegExp(`cwd: ${escapeRegExp(remoteCwd)}`));
    assert.doesNotMatch(context, /runtime-repo[\\/]+Users[\\/]+alice[\\/]+Desktop/);
  });

  test('does not absolutize target-device cwd strings', () => {
    const remoteCwd = 'remote/session/Desktop';
    const context = buildToolTargetContext(catsContext(), {
      toolName: 'execute_shell',
      operation: 'execute_shell',
      cwd: remoteCwd,
    });

    assert.ok(context);
    assert.match(context, new RegExp(`cwd: ${escapeRegExp(remoteCwd)}`));
    assert.doesNotMatch(context, new RegExp(`cwd: ${escapeRegExp(runtimeCwd)}[\\\\/]remote[\\\\/]session[\\\\/]Desktop`));
  });

  test('labels Device RPC forwarded user-device results', () => {
    const context = buildToolTargetContext(catsContext({
      executionScope: {
        source: 'catscompany',
        sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
        topicId: 'p2p_7_43',
        topicType: 'p2p',
        actorUserId: 'usr7',
        agentId: 'usr43',
        agentBodyId: 'body-agent',
        permissionsSource: 'device_rpc_forward',
        identityTrust: 'server_canonical',
        isTrusted: true,
      },
      localDeviceGrant: {
        kind: 'catscompany_body',
        source: 'catscompany',
        bodyId: 'body-user-device',
        deviceId: 'install-user-device',
        installationId: 'install-user-device',
        ownerUserId: 'usr7',
        createdAt: Date.now(),
      },
      deviceSelection: {
        kind: 'user_device_selection',
        source: 'catscompany',
        status: 'selected',
        sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
        topicId: 'p2p_7_43',
        topicType: 'p2p',
        actorUserId: 'usr7',
        agentId: 'usr43',
        identityTrust: 'server_canonical',
        selectedDeviceId: 'install-user-device',
        selectedDeviceDisplayName: 'Alice Laptop',
      },
    }), {
      toolName: 'resolve_common_directory',
      operation: 'resolve_common_directory',
    });

    assert.ok(context);
    assert.match(context, /target: selected_user_device/);
    assert.match(context, /target_display_name: Alice Laptop/);
  });

  test('strips target context before CatsCo display', () => {
    const displayed = stripToolTargetContextForDisplay([
      '[tool_target]',
      'tool: execute_shell',
      'target: virtual_employee_cloud_runtime',
      '[/tool_target]',
      '',
      'Command succeeded:',
      '$ echo ok',
    ].join('\n'));

    assert.equal(displayed, 'Command succeeded:\n$ echo ok');
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolExecutionContext } from '../src/types/tool';
import {
  executeRouteIfRemote,
  resolveExecutionRoute,
} from '../src/tools/execution-router';
import { buildRuntimeContextMessage } from '../src/core/runtime-context-builder';
import { buildTargetRoutes } from '../src/catscompany/runtime-context';
import { ShellTool } from '../src/tools/bash-tool';

function catsContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workingDirectory: 'D:\\bot-workspace',
    workspaceRoot: 'D:\\bot-workspace',
    conversationHistory: [],
    surface: 'catscompany',
    executionScope: {
      source: 'catscompany',
      sessionKey: 'session:v2:catscompany:p2p:p2p_85_320:agent:usr320',
      topicId: 'p2p_85_320',
      topicType: 'p2p',
      actorUserId: 'usr85',
      agentId: 'usr320',
      identityTrust: 'server_canonical',
      isTrusted: true,
    },
    deviceGrants: [{
      kind: 'user_device_grant',
      source: 'catscompany',
      grantId: 'grant-1',
      status: 'active',
      identityTrust: 'server_canonical',
      identitySource: 'lightweight_test',
      deviceId: 'dev-alice-win',
      deviceDisplayName: 'usr85 device',
      deviceBodyId: 'body-alice-win',
      deviceInstallationId: 'install-alice-win',
      ownerUserId: 'usr85',
      sessionKey: 'session:v2:catscompany:p2p:p2p_85_320:agent:usr320',
      topicId: 'p2p_85_320',
      topicType: 'p2p',
      actorUserId: 'usr85',
      agentId: 'usr320',
      operations: ['read_file', 'send_file', 'glob', 'execute_shell'],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }],
    targetRoutes: buildTargetRoutes([{
      userId: 'usr85',
      userName: 'Alice',
      ownerUserId: 'usr85',
      deviceId: 'dev-alice-win',
      label: 'Alice 的电脑',
      os: 'windows',
      status: 'ready',
    }]),
    executionContext: {
      schema: 'xiaoba.execution_context.v1',
      conversation: {
        type: 'p2p',
        currentSpeaker: { id: 'usr85', name: 'Alice', role: 'user' },
        participants: [
          { id: 'usr85', name: 'Alice', role: 'user' },
          { id: 'usr320', name: 'XiaoBa', role: 'agent' },
        ],
      },
      executionTargets: [
        { id: 'agent_self', label: 'XiaoBa local computer', kind: 'agent_self', status: 'ready', cwd: 'D:\\bot-workspace' },
      ],
      defaultTarget: 'agent_self',
    },
    ...overrides,
  };
}

test('lightweight router defaults CatsCo tools to agent_self', () => {
  const route = resolveExecutionRoute(catsContext(), {
    toolName: 'glob',
    operation: 'glob',
  });

  assert.equal(route.ok, true);
  assert.equal(route.ok && route.mode, 'local');
  assert.equal(route.ok && route.target, 'agent_self');
});

test('username target routes through Thin Tool RPC, strips target args, and owns target context', async () => {
  let capturedArgs: Record<string, unknown> | undefined;
  let legacyCalled = false;
  const context = catsContext({
    thinToolRpc: {
      executeTool: async request => {
        capturedArgs = request.args;
        assert.equal(request.targetOwnerUserId, 'usr85');
        assert.equal(request.targetDeviceId, 'dev-alice-win');
        return {
          ok: true,
          content: [
            'remote preface',
            '[tool_target]',
            'tool: glob',
            'operation: glob',
            'target: agent_self',
            'target_display_name: receiver local',
            '[/tool_target]',
            'remote ok',
          ].join('\n'),
        };
      },
    },
    deviceRpc: {
      executeTool: async () => {
        legacyCalled = true;
        return { ok: true, content: 'legacy remote ok' };
      },
    },
  });
  const route = resolveExecutionRoute(context, {
    toolName: 'glob',
    operation: 'glob',
    target: 'Alice',
  });

  assert.equal(route.ok, true);
  assert.equal(route.ok && route.mode, 'remote');
  const result = await executeRouteIfRemote(
    context,
    route,
    'glob',
    'glob',
    { path: 'C:\\Users\\Alice\\Desktop', pattern: '*', target: 'Alice' },
  );

  assert.equal(legacyCalled, false);
  assert.deepEqual(capturedArgs, { path: 'C:\\Users\\Alice\\Desktop', pattern: '*' });
  assert.equal(result?.ok, true);
  assert.equal(result?.ok && result.content, 'remote preface\nremote ok');
  assert.match(result?.targetContext || '', /target: Alice/);
  assert.match(result?.targetContext || '', /target_display_name: Alice 的电脑/);
  assert.doesNotMatch(String(result?.ok && result.content), /target: agent_self/);
});

test('named runtime target falls back to negotiated Device RPC when authority-v1 Thin RPC is unavailable', async () => {
  let deviceCalls = 0;
  const context = catsContext({
    thinToolRpc: undefined,
    deviceRpc: {
      executeTool: async request => {
        deviceCalls += 1;
        assert.equal(request.targetDeviceId, 'dev-alice-win');
        return { ok: true, content: 'device fallback ok' };
      },
    },
  });
  const route = resolveExecutionRoute(context, {
    toolName: 'glob',
    operation: 'glob',
    target: 'Alice',
  });
  assert.equal(route.ok, true);

  const result = await executeRouteIfRemote(
    context,
    route,
    'glob',
    'glob',
    { path: '.', pattern: '*' },
  );
  assert.equal(deviceCalls, 1);
  assert.equal(result?.ok, true);
  assert.equal(result?.ok && result.content, 'device fallback ok');
});

test('runtime target routes are discovery hints and cannot authorize a remote operation', () => {
  const baseline = catsContext();
  const baseGrant = baseline.deviceGrants![0];
  const cases: Array<[string, Partial<ToolExecutionContext>]> = [
    ['missing grant', { deviceGrants: [] }],
    ['revoked grant', { deviceGrants: [{ ...baseGrant, status: 'revoked' }] }],
    ['expired grant', { deviceGrants: [{ ...baseGrant, expiresAt: Date.now() - 1 }] }],
    ['wrong operation', { deviceGrants: [{ ...baseGrant, operations: ['read_file'] }] }],
    ['wrong actor', { deviceGrants: [{ ...baseGrant, actorUserId: 'usr-other', ownerUserId: 'usr-other' }] }],
    ['legacy grant', { deviceGrants: [{ ...baseGrant, identityTrust: 'legacy_context' }] }],
  ];

  for (const [name, overrides] of cases) {
    const route = resolveExecutionRoute(catsContext(overrides), {
      toolName: 'glob',
      operation: 'glob',
      target: 'Alice',
    });
    assert.equal(route.ok, false, name);
    if (!route.ok) assert.equal(route.errorCode, 'PERMISSION_DENIED', name);
  }

  const wrongOwnerRoute = buildTargetRoutes([{
    userId: 'usr-other',
    userName: 'Alice',
    ownerUserId: 'usr-other',
    deviceId: baseGrant.deviceId,
    label: 'Alice 的电脑',
    os: 'windows',
    status: 'ready',
  }]);
  const wrongOwner = resolveExecutionRoute(catsContext({ targetRoutes: wrongOwnerRoute }), {
    toolName: 'glob',
    operation: 'glob',
    target: 'Alice',
  });
  assert.equal(wrongOwner.ok, false);
});

test('server-canonical group delegation still authorizes the named participant device', () => {
  const context = catsContext();
  const delegatedGrant = {
    ...context.deviceGrants![0],
    identitySource: 'channel_identity_link',
    ownerUserId: 'usr99',
    sessionKey: 'session:v2:catscompany:group:room_7:agent:usr320',
    topicId: 'room_7',
    topicType: 'group' as const,
  };
  const groupContext = catsContext({
    executionScope: {
      ...context.executionScope!,
      sessionKey: delegatedGrant.sessionKey,
      topicId: delegatedGrant.topicId,
      topicType: delegatedGrant.topicType,
    },
    deviceGrants: [delegatedGrant],
    thinToolRpc: {
      executeTool: async () => ({ ok: true, content: 'delegated remote ok' }),
    },
    targetRoutes: buildTargetRoutes([{
      userId: 'usr99',
      userName: 'Bob',
      ownerUserId: 'usr99',
      deviceId: delegatedGrant.deviceId,
      label: 'Bob 的电脑',
      os: 'windows',
      status: 'ready',
    }]),
  });

  const route = resolveExecutionRoute(groupContext, {
    toolName: 'glob',
    operation: 'glob',
    target: 'Bob',
  });

  assert.equal(route.ok, true);
  assert.equal(route.ok && route.mode, 'remote');
  assert.equal(route.ok && route.mode === 'remote' && route.targetOwnerUserId, 'usr99');
});

test('remote dispatch revalidates authority and tool/operation pairing', async () => {
  let rpcCalls = 0;
  const authorized = catsContext({
    thinToolRpc: {
      executeTool: async () => {
        rpcCalls += 1;
        return { ok: true, content: 'unexpected' };
      },
    },
  });
  const resolved = resolveExecutionRoute(authorized, {
    toolName: 'glob',
    operation: 'glob',
    target: 'Alice',
  });
  assert.equal(resolved.ok, true);

  const mismatched = await executeRouteIfRemote(
    authorized,
    resolved,
    'execute_shell',
    'glob',
    { command: 'echo no' },
  );
  assert.equal(mismatched?.ok, false);
  assert.equal(rpcCalls, 0);

  const forgedContext = { ...authorized, deviceGrants: [] };
  const forged = await executeRouteIfRemote(
    forgedContext,
    resolved,
    'glob',
    'glob',
    { path: '.', pattern: '*' },
  );
  assert.equal(forged?.ok, false);
  assert.equal(rpcCalls, 0);
});

test('legacy speaker_default fallback still uses Device RPC when runtime routes are unavailable', async () => {
  let capturedArgs: Record<string, unknown> | undefined;
  const context = catsContext({
    targetRoutes: undefined,
    deviceRpc: {
      executeTool: async request => {
        capturedArgs = request.args;
        assert.equal(request.targetDeviceId, 'dev-alice-win');
        return { ok: true, content: 'legacy remote ok' };
      },
    },
  });
  const route = resolveExecutionRoute(context, {
    toolName: 'glob',
    operation: 'glob',
    target: 'speaker_default',
  });

  const result = await executeRouteIfRemote(
    context,
    route,
    'glob',
    'glob',
    { path: 'C:\\Users\\Alice\\Desktop', pattern: '*', target: 'speaker_default' },
  );

  assert.equal(result?.ok, true);
  assert.equal(result?.ok && result.content, 'legacy remote ok');
  assert.deepEqual(capturedArgs, { path: 'C:\\Users\\Alice\\Desktop', pattern: '*' });
});

test('remote execute_shell routes before local dangerous command checks', async () => {
  let capturedCommand = '';
  const context = catsContext({
    thinToolRpc: {
      executeTool: async request => {
        capturedCommand = String(request.args.command || '');
        assert.equal(request.toolName, 'execute_shell');
        assert.equal(request.targetDeviceId, 'dev-alice-win');
        return { ok: true, content: 'remote shell ok' };
      },
    },
  });

  const result = await new ShellTool().execute({
    command: 'Remove-Item -Recurse -Force C:\\Temp\\xiaoba-routing-test',
    target: 'Alice',
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.content, 'remote shell ok');
  assert.equal(capturedCommand, 'Remove-Item -Recurse -Force C:\\Temp\\xiaoba-routing-test');
  assert.match(result.targetContext || '', /target: Alice/);
});

test('Device RPC receiver always executes locally and does not route again', () => {
  const route = resolveExecutionRoute(catsContext({
    deviceRpcReceiver: true,
    deviceRpc: {
      executeTool: async () => {
        throw new Error('must not be called');
      },
    },
  }), {
    toolName: 'glob',
    operation: 'glob',
    target: 'Alice',
  });

  assert.equal(route.ok, true);
  assert.equal(route.ok && route.mode, 'local');
});

test('runtime context injects short text with username targets instead of JSON', () => {
  const message = buildRuntimeContextMessage({
    sessionKey: 'session:v2:catscompany:p2p:p2p_85_320:agent:usr320',
    sessionType: 'catscompany',
    executionScope: {
      source: 'catscompany',
      sessionKey: 'session:v2:catscompany:p2p:p2p_85_320:agent:usr320',
      topicId: 'p2p_85_320',
      topicType: 'p2p',
      actorUserId: 'usr85',
      agentId: 'usr320',
      identityTrust: 'server_canonical',
      isTrusted: true,
    },
    targetRoutes: catsContext().targetRoutes,
  });

  assert.ok(message);
  assert.equal(message.role, 'system');
  assert.match(String(message.content), /\[transient_runtime_context\]/);
  assert.match(String(message.content), /Alice：Alice 的电脑，Windows/);
  assert.match(String(message.content), /target="Alice"/);
  assert.doesNotMatch(String(message.content), /"executionTargets"/);
});

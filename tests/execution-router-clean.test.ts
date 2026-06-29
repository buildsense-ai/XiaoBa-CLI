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
      deviceId: 'dev-user-85',
      deviceDisplayName: 'usr85 device',
      ownerUserId: 'usr85',
      sessionKey: 'session:v2:catscompany:p2p:p2p_85_320:agent:usr320',
      topicId: 'p2p_85_320',
      topicType: 'p2p',
      actorUserId: 'usr85',
      agentId: 'usr320',
      operations: ['glob'],
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

test('legacy speaker_default fallback still uses Device RPC when runtime routes are unavailable', async () => {
  let capturedArgs: Record<string, unknown> | undefined;
  const context = catsContext({
    targetRoutes: undefined,
    deviceRpc: {
      executeTool: async request => {
        capturedArgs = request.args;
        assert.equal(request.targetDeviceId, 'dev-user-85');
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

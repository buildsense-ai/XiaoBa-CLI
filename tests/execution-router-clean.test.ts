import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolExecutionContext } from '../src/types/tool';
import {
  executeRouteIfRemote,
  resolveExecutionRoute,
} from '../src/tools/execution-router';
import { buildRuntimeContextSnapshot } from '../src/core/runtime-context-builder';

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
    executionContext: {
      schema: 'xiaoba.execution_context.v1',
      conversation: {
        type: 'p2p',
        currentSpeaker: { id: 'usr85', name: 'usr85', role: 'user' },
        participants: [
          { id: 'usr85', name: 'usr85', role: 'user' },
          { id: 'usr320', name: 'XiaoBa', role: 'agent' },
        ],
      },
      executionTargets: [
        { id: 'agent_self', label: 'XiaoBa local computer', kind: 'agent_self', status: 'ready', cwd: 'D:\\bot-workspace' },
        { id: 'speaker_default', label: 'usr85 device', kind: 'participant', status: 'ready', userId: 'usr85' },
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

test('lightweight router sends speaker_default to Device RPC and strips target args', async () => {
  let capturedArgs: Record<string, unknown> | undefined;
  const context = catsContext({
    deviceRpc: {
      executeTool: async request => {
        capturedArgs = request.args;
        assert.equal(request.targetDeviceId, 'dev-user-85');
        return { ok: true, content: 'remote ok' };
      },
    },
  });
  const route = resolveExecutionRoute(context, {
    toolName: 'glob',
    operation: 'glob',
    target: 'speaker_default',
  });

  assert.equal(route.ok, true);
  assert.equal(route.ok && route.mode, 'remote');
  const result = await executeRouteIfRemote(
    context,
    route,
    'glob',
    'glob',
    { path: '/root/Desktop', pattern: '*', target: 'speaker_default' },
  );

  assert.deepEqual(capturedArgs, { path: '/root/Desktop', pattern: '*' });
  assert.deepEqual(result, { ok: true, content: 'remote ok' });
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
    target: 'speaker_default',
  });

  assert.equal(route.ok, true);
  assert.equal(route.ok && route.mode, 'local');
});

test('runtime execution context tells the model how to read my computer vs your computer', () => {
  const snapshot = buildRuntimeContextSnapshot({
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
    deviceGrants: [{
      kind: 'user_device_grant',
      source: 'catscompany',
      grantId: 'grant-1',
      status: 'active',
      identityTrust: 'server_canonical',
      deviceId: 'dev-user-85',
      deviceDisplayName: 'usr85 device',
      ownerUserId: 'usr85',
      sessionKey: 'session:v2:catscompany:p2p:p2p_85_320:agent:usr320',
      topicId: 'p2p_85_320',
      topicType: 'p2p',
      actorUserId: 'usr85',
      operations: ['glob'],
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }],
  });

  assert.ok(snapshot);
  assert.equal(snapshot.defaultTarget, 'agent_self');
  assert.equal(snapshot.executionTargets.some(target => target.id === 'speaker_default'), true);
  assert.match(snapshot.toolRules.join('\n'), /我的电脑/);
  assert.match(snapshot.toolRules.join('\n'), /你的电脑/);
});

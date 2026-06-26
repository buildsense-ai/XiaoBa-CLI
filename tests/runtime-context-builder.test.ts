import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession } from '../src/core/agent-session';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { TRANSIENT_RUNTIME_CONTEXT_PREFIX } from '../src/core/runtime-context-builder';
import { createDeviceGrant, createUserDevice } from '../src/core/device-grants';
import { createExecutionScopeFromRoute, createSessionRoute } from '../src/core/session-router';
import type { Message } from '../src/types';
import type {
  ExecutionScope,
  ScopedDeviceGrant,
  ScopedDeviceSelection,
  ScopedLocalFileGrant,
} from '../src/types/session-identity';

describe('runtime context builder', () => {
  test('injects structured runtime context before the latest user message and removes it from durable history', async () => {
    const builder = new TurnContextBuilder();
    const route = createSessionRoute({
      source: 'catscompany',
      topicType: 'group',
      topicId: 'grp_80',
      actorUserId: 'usr7',
      agentId: 'usr43',
      agentBodyId: 'body-main',
      messageId: 'grp_80:12',
      channelSeq: 12,
      identityTrust: 'server_canonical',
      identitySource: 'metadata.catsco_identity',
      legacySessionKey: 'cc_group:grp_80',
    });
    const executionScope = createExecutionScopeFromRoute(route);
    const grant = localGrant('C:\\secret\\tmp\\downloads\\contract.pdf');
    const userDeviceGrant = deviceGrant(executionScope);

    const durableMessages: Message[] = [
      { role: 'system', content: 'base system' },
      { role: 'user', content: '帮我查合同' },
    ];

    const result = await builder.build({
      sessionKey: route.sessionKey,
      sessionType: 'catscompany',
      sessionRoute: route,
      executionScope,
      localDeviceGrant: {
        kind: 'catscompany_body',
        source: 'catscompany',
        bodyId: 'body-main',
        deviceId: 'device-1',
        createdAt: Date.now(),
      },
      deviceGrants: [userDeviceGrant],
      deviceSelection: deviceSelection(executionScope),
      localFileGrants: [grant],
      durableMessages,
      runtimeFeedback: [],
      skillRuntime: emptySkillRuntime(),
    });

    assert.deepEqual(durableMessages.map(message => message.content), ['base system', '帮我查合同']);
    const runtimeIndex = result.messages.findIndex(isRuntimeContextMessage);
    const userIndex = result.messages.findIndex(message => message.role === 'user' && message.content === '帮我查合同');
    assert.ok(runtimeIndex >= 0, 'runtime context should be injected');
    assert.ok(runtimeIndex < userIndex, 'runtime context should appear before the latest user message');

    const snapshot = parseRuntimeContext(result.messages[runtimeIndex]);
    assert.equal(snapshot.schema, 'xiaoba.runtime_context.v1');
    assert.equal(snapshot.session.key, route.sessionKey);
    assert.equal(snapshot.session.topic.id, 'grp_80');
    assert.equal(snapshot.session.agent.id, 'usr43');
    assert.equal('bodyId' in snapshot.session.agent, false);
    assert.equal(snapshot.turn.actorUserId, 'usr7');
    assert.equal(snapshot.turn.identityTrust, 'server_canonical');
    assert.equal(snapshot.execution.scopeSource, 'execution_scope');
    assert.equal(snapshot.execution.localDevice.source, 'catscompany');
    assert.equal(snapshot.execution.localDevice.deviceId, 'device-1');
    assert.equal(snapshot.execution.agentRuntime.target, 'virtual_employee_cloud_runtime');
    assert.equal(snapshot.execution.agentRuntime.owner, 'agent_self');
    assert.equal(snapshot.execution.agentRuntime.localToolTarget, 'agent_cloud_runtime');
    assert.equal(snapshot.execution.agentRuntime.userDeviceDisplayNamesAreIdentity, false);
    assert.equal(snapshot.execution.agentRuntime.commonDirectoryPolicy, 'agent_cloud_runtime_data_root');
    assert.equal('bodyId' in snapshot.execution.localDevice, false);
    assert.equal(snapshot.execution.userDevices[0].grantId, 'device_grant_current');
    assert.equal(snapshot.execution.userDevices[0].deviceId, 'device-user-1');
    assert.equal(snapshot.execution.userDevices[0].displayName, 'User Laptop');
    assert.deepEqual(snapshot.execution.userDevices[0].operations, ['read_file', 'execute_shell']);
    assert.equal(snapshot.execution.userDevices[0].status, 'active');
    assert.equal(snapshot.execution.deviceSelection.status, 'selected');
    assert.equal(snapshot.execution.deviceSelection.selectionSource, 'single_active_device');
    assert.equal(snapshot.execution.deviceSelection.selectedDevice.deviceId, 'device-user-1');
    assert.equal(snapshot.execution.deviceSelection.selectedDevice.displayName, 'User Laptop');
    assert.deepEqual(snapshot.execution.deviceSelection.selectedDevice.operations, ['read_file']);
    assert.equal(snapshot.execution.localFiles[0].ref, 'catsco_attachment:contract');
    assert.equal(snapshot.execution.localFiles[0].fileName, 'contract.pdf');
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /C:\\secret/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /tmp[\\/]downloads/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /body-main/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /body-secret/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /"bodyId"/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /installation-main/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /deviceBodyId/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /deviceInstallationId/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /createdAt/);
    assert.doesNotMatch(result.messages[runtimeIndex].content as string, /mtimeMs/);

    const durable = builder.removeTransientMessages(result.messages);
    assert.equal(durable.some(isRuntimeContextMessage), false);
  });

  test('AgentSession sends runtime context to the provider every turn without persisting it', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-context-'));
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      const route = createSessionRoute({
        source: 'feishu',
        topicType: 'group',
        topicId: 'oc_group',
        actorUserId: 'alice',
        identityTrust: 'legacy_context',
        identitySource: 'feishu.event',
        legacySessionKey: 'group:oc_group',
      });
      const capturedRequests: Message[][] = [];
      const session = new AgentSession(route.sessionKey, buildMockServices({
        aiService: {
          async chatStream(messages: Message[]) {
            capturedRequests.push(messages.map(message => ({ ...message })));
            return {
              content: `reply ${capturedRequests.length}`,
              toolCalls: [],
              usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
            };
          },
        },
      }), 'feishu', route);
      session.setSystemPromptProvider(() => 'system prompt');

      await session.handleMessage('第一条', {
        sessionRoute: route,
        executionScope: createExecutionScopeFromRoute(route),
        deviceGrants: [deviceGrant(createExecutionScopeFromRoute(route), 'alice-device')],
      });

      const bobRoute = createSessionRoute({
        source: 'feishu',
        topicType: 'group',
        topicId: 'oc_group',
        actorUserId: 'bob',
        identityTrust: 'legacy_context',
        identitySource: 'feishu.event',
        legacySessionKey: 'group:oc_group',
      });
      await session.handleMessage('第二条', {
        sessionRoute: bobRoute,
        executionScope: createExecutionScopeFromRoute(bobRoute),
      });

      assert.equal(capturedRequests.length, 2);
      const firstContexts = capturedRequests[0].filter(isRuntimeContextMessage);
      const secondContexts = capturedRequests[1].filter(isRuntimeContextMessage);
      assert.equal(firstContexts.length, 1);
      assert.equal(secondContexts.length, 1);
      assert.equal(parseRuntimeContext(firstContexts[0]).turn.actorUserId, 'alice');
      assert.equal(parseRuntimeContext(firstContexts[0]).execution.userDevices[0].deviceId, 'alice-device');
      assert.equal(parseRuntimeContext(secondContexts[0]).turn.actorUserId, 'bob');
      assert.equal(parseRuntimeContext(secondContexts[0]).session.topic.id, 'oc_group');

      const retainedMessages = (session as any).messages as Message[];
      assert.equal(retainedMessages.some(isRuntimeContextMessage), false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });
});

function emptySkillRuntime(): any {
  return {
    reloadSkills: async () => undefined,
    buildSkillsListMessage: () => null,
  };
}

function isRuntimeContextMessage(message: Message): boolean {
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX);
}

function parseRuntimeContext(message: Message): any {
  const content = String(message.content || '');
  return JSON.parse(content.slice(TRANSIENT_RUNTIME_CONTEXT_PREFIX.length).trim());
}

function localGrant(filePath: string): ScopedLocalFileGrant {
  const now = Date.now();
  return {
    kind: 'catscompany_attachment',
    source: 'catscompany',
    attachmentRef: 'catsco_attachment:contract',
    filePath,
    fileName: 'contract.pdf',
    fileType: 'file',
    size: 100,
    mtimeMs: now,
    sessionKey: 'session:v2:catscompany:group:grp_80:agent:usr43',
    topicId: 'grp_80',
    topicType: 'group',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    deviceBodyId: 'body-main',
    identityTrust: 'server_canonical',
    operations: ['read_file', 'send_file'],
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

function deviceGrant(scope: ExecutionScope, deviceId = 'device-user-1'): ScopedDeviceGrant {
  const device = createUserDevice({
    source: scope.source,
    ownerUserId: scope.actorUserId,
    deviceId,
    displayName: 'User Laptop',
    bodyId: 'body-secret',
    installationId: 'installation-main',
    identityTrust: 'server_canonical',
    status: 'online',
    registeredAt: 1_000,
  });
  const grant = createDeviceGrant(scope, device, {
    grantId: 'device_grant_current',
    operations: ['read_file', 'execute_shell'],
    now: 2_000,
    ttlMs: 60_000,
  });
  assert.ok(grant);
  return grant;
}

function deviceSelection(scope: ExecutionScope): ScopedDeviceSelection {
  return {
    kind: 'user_device_selection',
    source: scope.source,
    status: 'selected',
    selectionSource: 'single_active_device',
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    identityTrust: scope.identityTrust,
    identitySource: 'metadata.catsco_identity',
    selectedDeviceId: 'device-user-1',
    selectedDeviceDisplayName: 'User Laptop',
    selectedDeviceBodyId: 'body-secret',
    selectedDeviceInstallationId: 'installation-main',
    selectedDeviceOperations: ['read_file'],
    createdAt: 2_000,
  };
}

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: {
      ...(overrides.aiService || {}),
    },
    toolManager: {
      getWorkspaceRoot: () => process.cwd(),
      getToolDefinitions: () => [],
      executeTool: async () => {
        throw new Error('not expected');
      },
    },
    skillManager: {
      getSkill: () => undefined,
      getUserInvocableSkills: () => [],
      getAutoInvocableSkills: () => [],
      findAutoInvocableSkillByText: () => undefined,
      loadSkills: async () => undefined,
    },
  };
}

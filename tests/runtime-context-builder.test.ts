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
  test('injects short transient runtime context before the latest user message and removes it from durable history', async () => {
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

    const runtimeText = String(result.messages[runtimeIndex].content || '');
    assert.match(runtimeText, /^\[transient_runtime_context\]/);
    assert.match(runtimeText, /\[\/transient_runtime_context\]$/);
    assert.match(runtimeText, /默认不要传 target/);
    assert.match(runtimeText, /你的电脑\/XiaoBa 的电脑\/bot 的电脑/);
    assert.doesNotMatch(runtimeText, /可在用户电脑执行的工具/);
    assert.doesNotMatch(runtimeText, /read_file, resolve_common_directory, glob, grep, write_file, edit_file, execute_shell/);
    assert.doesNotMatch(runtimeText, /xiaoba\.execution_context\.v1/);
    assert.doesNotMatch(runtimeText, /"conversation"/);
    assert.doesNotMatch(runtimeText, /C:\\secret/);
    assert.doesNotMatch(runtimeText, /body-main/);
    assert.doesNotMatch(runtimeText, /body-secret/);
    assert.doesNotMatch(runtimeText, /installation-main/);

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
      assert.equal(firstContexts.length, 0);
      assert.equal(secondContexts.length, 0);

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
    displayName: 'Alice laptop',
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
    selectedDeviceDisplayName: 'Alice laptop',
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

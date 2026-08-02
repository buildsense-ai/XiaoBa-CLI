import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession } from '../src/core/agent-session';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { GoalRuntime } from '../src/core/goal-runtime';
import {
  TRANSIENT_RUNTIME_CONTEXT_PREFIX,
  TRANSIENT_RUNTIME_TARGET_RULES_PREFIX,
} from '../src/core/runtime-context-builder';
import { getCatsCoAttachmentCacheSessionRoot } from '../src/catscompany/attachment-cache';
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
  test('injects typed Goal state before the latest user and removes it from durable history', async () => {
    const builder = new TurnContextBuilder();
    const goalRuntime = new GoalRuntime();
    goalRuntime.update({ objective: 'Verify provider-truth cache evidence.', status: 'active' });
    const result = await builder.build({
      sessionKey: 'goal-runtime-test',
      durableMessages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'continue' }],
      runtimeFeedback: [],
      skillRuntime: emptySkillRuntime(),
      goalRuntime,
      contextEpoch: 'episode-goal',
    });

    const goalIndex = result.messages.findIndex(message => message.__context?.source === 'goal_status');
    const userIndex = result.messages.findIndex(message => message.role === 'user' && message.content === 'continue');
    assert.ok(goalIndex >= 0);
    assert.ok(goalIndex < userIndex);
    assert.deepEqual(result.messages[goalIndex].__context, {
      schema: 'xiaoba.context_lifecycle.v1',
      source: 'goal_status',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence: 'transient',
      epoch: 'episode-goal',
    });
    assert.match(String(result.messages[goalIndex].content), /Verify provider-truth cache evidence\./);
    assert.equal(builder.removeTransientMessages(result.messages).some(
      message => message.__context?.source === 'goal_status',
    ), false);
  });

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
      contextEpoch: 'episode-runtime-context',
    });

    assert.deepEqual(durableMessages.map(message => message.content), ['base system', '帮我查合同']);
    const runtimeIndex = result.messages.findIndex(isRuntimeContextMessage);
    const targetRulesIndex = result.messages.findIndex(message => (
      message.__context?.source === 'runtime_target_rules'
    ));
    const stableRulesIndex = result.messages.findIndex(message => (
      message.__context?.source === 'runtime_observation_rules'
    ));
    const userIndex = result.messages.findIndex(message => message.role === 'user' && message.content === '帮我查合同');
    assert.ok(runtimeIndex >= 0, 'runtime context should be injected');
    assert.ok(targetRulesIndex >= 0, 'stable target rules should be injected');
    assert.ok(stableRulesIndex >= 0, 'stable runtime rules should be injected');
    assert.ok(stableRulesIndex < runtimeIndex, 'session-stable additions must precede episode context');
    assert.ok(targetRulesIndex < runtimeIndex, 'target rules must precede authorized device facts');
    assert.ok(runtimeIndex < userIndex, 'runtime context should appear before the latest user message');
    assert.deepEqual(result.messages[runtimeIndex].__context, {
      schema: 'xiaoba.context_lifecycle.v1',
      source: 'runtime_context',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence: 'transient',
      epoch: 'episode-runtime-context',
    });
    assert.deepEqual(result.messages[targetRulesIndex].__context, {
      schema: 'xiaoba.context_lifecycle.v1',
      source: 'runtime_target_rules',
      lifecycle: 'session',
      cacheScope: 'stable',
      persistence: 'transient',
    });

    const runtimeText = String(result.messages[runtimeIndex].content || '');
    assert.match(runtimeText, /^\[transient_runtime_context\]/);
    assert.match(runtimeText, /\[\/transient_runtime_context\]$/);
    assert.match(runtimeText, /可操作的用户电脑：/);
    assert.match(runtimeText, /target="speaker_default"/);
    assert.match(runtimeText, /已授权操作对应工具（仅当本轮提供该工具时可调用）：read_file/);
    assert.doesNotMatch(runtimeText, /execute_shell/);
    const targetRulesText = String(result.messages[targetRulesIndex].content || '');
    assert.ok(targetRulesText.startsWith(TRANSIENT_RUNTIME_TARGET_RULES_PREFIX));
    assert.ok(targetRulesText.includes(`当前会话附件缓存目录（XiaoBa 本地运行体）：${getCatsCoAttachmentCacheSessionRoot(route.sessionKey)}`));
    assert.match(targetRulesText, /用不带 target 的 glob 查看该目录/);
    assert.match(targetRulesText, /默认不要传 target/);
    assert.match(targetRulesText, /你的电脑\/XiaoBa 的电脑\/bot 的电脑/);
    assert.doesNotMatch(runtimeText, /xiaoba\.execution_context\.v1/);
    assert.doesNotMatch(runtimeText, /"conversation"/);
    assert.doesNotMatch(runtimeText, /C:\\secret/);
    assert.doesNotMatch(runtimeText, /body-main/);
    assert.doesNotMatch(runtimeText, /body-secret/);
    assert.doesNotMatch(runtimeText, /installation-main/);

    const durable = builder.removeTransientMessages(result.messages);
    assert.equal(durable.some(isRuntimeContextMessage), false);
  });

  test('keeps session-stable rules in the leading provider prefix across turns', async () => {
    const builder = new TurnContextBuilder();
    const route = createSessionRoute({
      source: 'catscompany',
      topicType: 'group',
      topicId: 'grp-prefix',
      actorUserId: 'usr7',
      agentId: 'usr43',
      agentBodyId: 'body-main',
      identityTrust: 'server_canonical',
      identitySource: 'metadata.catsco_identity',
      legacySessionKey: 'cc_group:grp-prefix',
    });
    const build = (durableMessages: Message[]) => builder.build({
      sessionKey: route.sessionKey,
      sessionType: 'catscompany',
      sessionRoute: route,
      executionScope: createExecutionScopeFromRoute(route),
      durableMessages,
      runtimeFeedback: [],
      skillRuntime: emptySkillRuntime(),
      contextEpoch: 'prefix-episode',
    });
    const first = await build([
      { role: 'system', content: 'primary system' },
      { role: 'user', content: 'turn one' },
    ]);
    const second = await build([
      { role: 'system', content: 'primary system' },
      { role: 'user', content: 'turn one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'turn two' },
    ]);
    const stablePrefix = (messages: Message[]) => messages.slice(0, 3).map(message => ({
      role: message.role,
      content: message.content,
      source: message.__context?.source,
    }));
    assert.deepEqual(stablePrefix(first.messages), stablePrefix(second.messages));
    assert.deepEqual(first.messages.slice(0, 3).map(message => message.__context?.source), [
      undefined,
      'runtime_observation_rules',
      'runtime_target_rules',
    ]);
  });

  test('reinjects session-stable rules before a dynamic checkpoint boundary', async () => {
    const builder = new TurnContextBuilder();
    const result = await builder.build({
      sessionKey: 'checkpoint-prefix-order',
      durableMessages: [
        { role: 'system', content: 'primary system' },
        {
          role: 'system',
          content: '[checkpoint_compaction_boundary] phase=mid_turn',
          __checkpointBoundary: true,
          __context: {
            schema: 'xiaoba.context_lifecycle.v1',
            source: 'compaction_boundary',
            lifecycle: 'episode',
            cacheScope: 'epoch',
            persistence: 'durable',
            epoch: 'episode-checkpoint',
          },
          __cacheScope: 'dynamic',
        },
        {
          role: 'user',
          content: 'continuation summary',
          __checkpointSummary: true,
        },
      ],
      runtimeFeedback: [],
      skillRuntime: emptySkillRuntime(),
      contextEpoch: 'episode-checkpoint',
    });

    const stableRulesIndex = result.messages.findIndex(message => (
      message.__context?.source === 'runtime_observation_rules'
    ));
    const boundaryIndex = result.messages.findIndex(message => message.__checkpointBoundary);
    assert.ok(stableRulesIndex > 0);
    assert.ok(stableRulesIndex < boundaryIndex);
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

  test('AgentSession ignores untrusted authority without poisoning the later canonical scope', () => {
    const route = createSessionRoute({
      source: 'catscompany',
      topicType: 'group',
      topicId: 'grp-authority-session',
      actorUserId: 'usr7',
      agentId: 'usr43',
      agentBodyId: 'body-main',
      channelSeq: 10,
      identityTrust: 'server_canonical',
      identitySource: 'metadata.catsco_identity',
      legacySessionKey: 'cc_group:grp-authority-session',
    });
    const trusted = createExecutionScopeFromRoute(route);
    const untrusted = { ...trusted, identityTrust: 'untrusted' as const, isTrusted: false };
    const session = new AgentSession(route.sessionKey, buildMockServices(), 'catscompany', route);
    assert.equal(session.updateDeviceAuthority({
      executionScope: untrusted,
      deviceGrantSnapshot: {
        kind: 'user_device_grant_snapshot',
        source: trusted.source,
        sessionKey: trusted.sessionKey,
        topicId: trusted.topicId,
        topicType: trusted.topicType,
        actorUserId: trusted.actorUserId,
        agentId: trusted.agentId,
        agentBodyId: trusted.agentBodyId,
        identityTrust: 'server_canonical',
        revision: 10,
        grants: [],
      },
    }), undefined);

    const grant = deviceGrant(trusted);
    const lease = session.updateDeviceAuthority({
      executionScope: trusted,
      deviceGrantSnapshot: {
        kind: 'user_device_grant_snapshot',
        source: trusted.source,
        sessionKey: trusted.sessionKey,
        topicId: trusted.topicId,
        topicType: trusted.topicType,
        actorUserId: trusted.actorUserId,
        agentId: trusted.agentId,
        agentBodyId: trusted.agentBodyId,
        identityTrust: 'server_canonical',
        revision: 10,
        grants: [grant],
      },
    });
    assert.equal(lease?.getCurrent().deviceGrants?.length, 1);
    session.updateDeviceAuthority({
      executionScope: { ...trusted, channelSeq: 11 },
    });
    assert.equal(lease?.getCurrent().deviceGrants?.length, 1);
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
  const now = Date.now();
  const grant = createDeviceGrant(scope, device, {
    grantId: 'device_grant_current',
    operations: ['read_file', 'execute_shell'],
    now,
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
    createdAt: Date.now(),
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

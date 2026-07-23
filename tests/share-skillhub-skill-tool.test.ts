import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ShareSkillHubSkillTool } from '../src/tools/share-skillhub-skill-tool';
import type { ToolExecutionContext } from '../src/types/tool';
import type {
  ExecutionScope,
  ScopedLocalDeviceGrant,
} from '../src/types/session-identity';

describe('ShareSkillHubSkillTool CatsCo permissions', () => {
  test('allows the local owner-self context to reach argument validation', async () => {
    const result = await new ShareSkillHubSkillTool().execute({}, catsContext({
      executionScope: catsScope({ actorUserId: 'usr7' }),
      localDeviceGrant: catsLocalDevice({ ownerUserId: 'usr7' }),
    }));

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('rejects an external CatsCo visitor before sharing', async () => {
    const result = await new ShareSkillHubSkillTool().execute(
      { skillName: 'private-local-skill' },
      catsContext({
        executionScope: catsScope({
          actorUserId: 'usr8',
          agentBodyId: 'body-remote',
        }),
        localDeviceGrant: catsLocalDevice({ ownerUserId: 'usr7' }),
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(result.retryable, false);
  });

  test('rejects a non-owner CatsCo agent even when it runs on the local body', async () => {
    const result = await new ShareSkillHubSkillTool().execute(
      { skillName: 'private-local-skill' },
      catsContext({
        executionScope: catsScope({
          actorUserId: 'usr8',
          agentBodyId: 'body-local',
        }),
        localDeviceGrant: catsLocalDevice({
          ownerUserId: 'usr7',
          bodyId: 'body-local',
        }),
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(result.retryable, false);
  });

  test('keeps non-CatsCo callers on the existing validation path', async () => {
    const result = await new ShareSkillHubSkillTool().execute({}, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
      surface: 'cli',
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });
});

function catsContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    workingDirectory: process.cwd(),
    conversationHistory: [],
    surface: 'catscompany',
    executionScope: catsScope(),
    localDeviceGrant: catsLocalDevice(),
    ...overrides,
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

function catsLocalDevice(
  overrides: Partial<ScopedLocalDeviceGrant> = {},
): ScopedLocalDeviceGrant {
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

import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';
import { createCatsCoMessageEnvelope, createExecutionScope } from '../src/catscompany/message-envelope';

function canonicalMetadata(actorUserId: string, topicId: string, agentId = 'usr43', bodyId = 'body-main') {
  return {
    catsco_identity: {
      actor: { user_id: actorUserId },
      agent: { agent_id: agentId, body_id: bodyId },
      topic: { topic_id: topicId, type: topicId.startsWith('grp_') ? 'group' : 'p2p', channel_seq: 12 },
      permissions: { source: 'server_canonical_message' },
    },
  };
}

function deviceGrant(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: 'device-grant-1',
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'metadata.catsco_identity',
    deviceId: 'alice-laptop',
    deviceDisplayName: 'Alice Laptop',
    deviceBodyId: 'body-device',
    deviceInstallationId: 'install-device',
    ownerUserId: 'usr7',
    sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    operations: ['read_file', 'send_file'],
    createdAt: 1_000,
    expiresAt: 601_000,
    ...overrides,
  };
}

function metadataWithDeviceGrants(actorUserId: string, topicId: string, grants: unknown[], agentId = 'usr43', bodyId = 'body-main') {
  const metadata = canonicalMetadata(actorUserId, topicId, agentId, bodyId);
  (metadata.catsco_identity as any).device_grants = grants;
  return metadata;
}

function metadataWithDeviceSelection(actorUserId: string, topicId: string, selection: Record<string, unknown>, agentId = 'usr43', bodyId = 'body-main') {
  const metadata = metadataWithDeviceGrants(actorUserId, topicId, [deviceGrant()], agentId, bodyId);
  (metadata.catsco_identity as any).device_selection = {
    kind: 'user_device_selection',
    source: 'catscompany',
    status: 'selected',
    sessionKey: `session:v2:catscompany:${topicId.startsWith('grp_') ? 'group' : 'p2p'}:${topicId}:agent:${agentId}`,
    topicId,
    topicType: topicId.startsWith('grp_') ? 'group' : 'p2p',
    actorUserId,
    agentId,
    selectedDevice: {
      deviceId: 'alice-laptop',
      displayName: 'Alice Laptop',
      bodyId: 'body-device',
      installationId: 'install-device',
      operations: ['read_file', 'send_file'],
    },
    ...selection,
  };
  return metadata;
}

function createHarness(options: { busy?: boolean } = {}) {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const handledTurns: Array<{ userMessage: unknown; options: any }> = [];
  const sessionKeys: string[] = [];
  const sessionInputs: any[] = [];
  let busy = options.busy ?? false;

  const session = {
    isBusy: () => busy,
    setBusy: (next: boolean) => {
      busy = next;
    },
    handleMessage: async (userMessage: unknown, handleOptions: any) => {
      handledTurns.push({ userMessage, options: handleOptions });
      return { visibleToUser: false, text: '' };
    },
    handleRuntimeObservation: async () => ({ visibleToUser: false, text: '' }),
  };

  bot.sessionManager = {
    getOrCreate: (input: any) => {
      sessionInputs.push(input);
      sessionKeys.push(typeof input === 'string' ? input : input.sessionKey);
      return session;
    },
    get: () => session,
  };
  bot.sender = {
    downloadFile: async () => null,
    sendTyping: () => undefined,
    reply: async () => undefined,
    sendFile: async () => undefined,
    sendText: async () => undefined,
    sendThinking: async () => undefined,
    sendToolUse: async () => undefined,
    sendToolResult: async () => undefined,
  };
  bot.pendingAnswers = new Map();
  bot.pendingAnswerBySession = new Map();
  bot.toolConfirmationApprovals = new Map();
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.botUid = 'usr43';

  return { bot, handledTurns, sessionKeys, sessionInputs, session };
}

describe('CatsCompany execution scope flow', () => {
  test('passes canonical execution scope from websocket message into session turn', async () => {
    const { bot, handledTurns, sessionKeys, sessionInputs } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '查合同',
      content: '查合同',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 12,
    });

    assert.deepEqual(sessionKeys, ['session:v2:catscompany:p2p:p2p_7_43:agent:usr43']);
    assert.equal(sessionInputs[0].version, 2);
    assert.equal(sessionInputs[0].legacySessionKey, 'cc_user:usr7');
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.sessionRoute.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(handledTurns[0].options.executionScope.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(handledTurns[0].options.executionScope.legacySessionKey, 'cc_user:usr7');
    assert.equal(handledTurns[0].options.executionScope.actorUserId, 'usr7');
    assert.equal(handledTurns[0].options.executionScope.agentId, 'usr43');
    assert.equal(handledTurns[0].options.executionScope.agentBodyId, 'body-main');
    assert.equal(handledTurns[0].options.executionScope.isTrusted, true);
  });

  test('keeps execution scope when a busy CatsCompany turn is queued then drained', async () => {
    const { bot, handledTurns, sessionKeys, session } = createHarness({ busy: true });

    await (bot as any).onMessage({
      topic: 'p2p_8_43',
      senderId: 'usr8',
      text: '继续查',
      content: '继续查',
      metadata: canonicalMetadata('usr8', 'p2p_8_43'),
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 0);
    session.setBusy(false);
    await (bot as any).drainMessageQueue('session:v2:catscompany:p2p:p2p_8_43:agent:usr43');

    assert.deepEqual(sessionKeys, [
      'session:v2:catscompany:p2p:p2p_8_43:agent:usr43',
      'session:v2:catscompany:p2p:p2p_8_43:agent:usr43',
    ]);
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.executionScope.actorUserId, 'usr8');
    assert.equal(handledTurns[0].options.executionScope.topicId, 'p2p_8_43');
    assert.equal(handledTurns[0].options.executionScope.isTrusted, true);
  });

  test('group turn isolates the session by current speaker while preserving actor in scope', async () => {
    const { bot, handledTurns, sessionKeys } = createHarness();

    await (bot as any).onMessage({
      topic: 'grp_80',
      senderId: 'usr7',
      text: '@usr43 看一下',
      content: '@usr43 看一下',
      metadata: canonicalMetadata('usr7', 'grp_80'),
      isGroup: true,
      seq: 12,
    });

    assert.deepEqual(sessionKeys, ['session:v2:catscompany:group:grp_80%3Aactor%3Ausr7:agent:usr43']);
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.executionScope.topicType, 'group');
    assert.equal(handledTurns[0].options.executionScope.topicId, 'grp_80');
    assert.equal(handledTurns[0].options.executionScope.actorUserId, 'usr7');
  });

  test('passes server canonical device grants into CatsCompany session turn', async () => {
    const { bot, handledTurns } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '读一下本机文件',
      content: '读一下本机文件',
      metadata: metadataWithDeviceGrants('usr7', 'p2p_7_43', [deviceGrant()]),
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.deviceGrants?.length, 1);
    assert.equal(handledTurns[0].options.deviceGrants[0].deviceId, 'alice-laptop');
    assert.deepEqual(handledTurns[0].options.deviceGrants[0].operations, ['read_file', 'send_file']);
  });

  test('passes server canonical device selection into CatsCompany session turn', async () => {
    const { bot, handledTurns } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '读一下本机文件',
      content: '读一下本机文件',
      metadata: metadataWithDeviceSelection('usr7', 'p2p_7_43', {
        selectionSource: 'explicit_mention',
      }),
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.deviceSelection?.status, 'selected');
    assert.equal(handledTurns[0].options.deviceSelection?.selectionSource, 'explicit_mention');
    assert.equal(handledTurns[0].options.deviceSelection?.selectedDeviceId, 'alice-laptop');
    assert.equal(handledTurns[0].options.deviceSelection?.selectedDeviceDisplayName, 'Alice Laptop');
    assert.equal(handledTurns[0].options.deviceSelection?.selectedDeviceBodyId, 'body-device');
    assert.deepEqual(handledTurns[0].options.deviceSelection?.selectedDeviceOperations, ['read_file', 'send_file']);
  });

  test('accepts device selection when CatsCo ids differ only by usr prefix', async () => {
    const { bot, handledTurns } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '移动端继续操作我的电脑',
      content: '移动端继续操作我的电脑',
      metadata: metadataWithDeviceSelection('usr7', 'p2p_7_43', {
        actorUserId: '7',
        agentId: '43',
      }),
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.deviceSelection?.actorUserId, 'usr7');
    assert.equal(handledTurns[0].options.deviceSelection?.agentId, 'usr43');
    assert.equal(handledTurns[0].options.deviceSelection?.selectedDeviceId, 'alice-laptop');
  });

  test('drops device selection that does not match the canonical execution scope', async () => {
    const { bot, handledTurns } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '读一下本机文件',
      content: '读一下本机文件',
      metadata: metadataWithDeviceSelection('usr7', 'p2p_7_43', {
        actorUserId: 'usr8',
      }),
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.deviceSelection, undefined);
  });

  test('drops device grants that do not match the canonical execution scope', async () => {
    const { bot, handledTurns } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '读一下本机文件',
      content: '读一下本机文件',
      metadata: metadataWithDeviceGrants('usr7', 'p2p_7_43', [
        deviceGrant({ actorUserId: 'usr8' }),
        deviceGrant({ agentBodyId: 'body-other' }),
      ]),
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.deviceGrants, undefined);
  });

  test('does not merge queued CatsCo group input from another actor into the current actor scope', () => {
    const { bot } = createHarness();
    const aliceScope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'grp_80',
      isGroup: true,
      senderId: 'alice',
      text: 'alice asks',
      metadata: canonicalMetadata('alice', 'grp_80'),
      botUid: 'usr43',
    }));
    const bobScope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'grp_80',
      isGroup: true,
      senderId: 'bob',
      text: 'bob asks',
      metadata: canonicalMetadata('bob', 'grp_80'),
      botUid: 'usr43',
    }));

    assert.notEqual(aliceScope.sessionKey, bobScope.sessionKey);

    bot.messageQueue.set(bobScope.sessionKey, [{
      userMessage: 'bob follow-up',
      topic: 'grp_80',
      senderId: 'bob',
      seq: 13,
      executionScope: bobScope,
      receivedAt: Date.now(),
      source: 'user',
    }]);

    assert.equal((bot as any).consumeQueuedUserInput(aliceScope.sessionKey, aliceScope), null);
    assert.equal(bot.messageQueue.get(bobScope.sessionKey)?.length, 1);

    const pendingForBob = (bot as any).consumeQueuedUserInput(bobScope.sessionKey, bobScope);
    assert.equal(pendingForBob, 'bob follow-up');
    assert.equal(bot.messageQueue.has(bobScope.sessionKey), false);
  });

  test('preserves device grants when queued CatsCompany user input is merged', () => {
    const { bot } = createHarness();
    const scope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: 'first',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      botUid: 'usr43',
    }));

    bot.messageQueue.set(scope.sessionKey, [{
      userMessage: '补充读取文件',
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 13,
      executionScope: scope,
      deviceGrants: [deviceGrant()],
      receivedAt: Date.now(),
      source: 'user',
    }]);

    const pending = (bot as any).consumeQueuedUserInput(scope.sessionKey, scope);
    assert.equal(typeof pending, 'object');
    assert.equal(pending.content, '补充读取文件');
    assert.equal(pending.deviceGrants.length, 1);
    assert.equal(pending.deviceGrants[0].deviceId, 'alice-laptop');
  });

  test('preserves latest device selection when queued CatsCompany user input is merged', () => {
    const { bot } = createHarness();
    const scope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: 'first',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      botUid: 'usr43',
    }));

    const selection = {
      kind: 'user_device_selection',
      source: 'catscompany',
      status: 'selected',
      sessionKey: scope.sessionKey,
      topicId: scope.topicId,
      topicType: scope.topicType,
      actorUserId: scope.actorUserId,
      agentId: scope.agentId,
      identityTrust: 'server_canonical',
      selectedDeviceId: 'alice-laptop',
      selectedDeviceDisplayName: 'Alice Laptop',
    };

    bot.messageQueue.set(scope.sessionKey, [{
      userMessage: '补充读取文件',
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 13,
      executionScope: scope,
      deviceSelection: selection,
      receivedAt: Date.now(),
      source: 'user',
    }]);

    const pending = (bot as any).consumeQueuedUserInput(scope.sessionKey, scope);
    assert.equal(typeof pending, 'object');
    assert.equal(pending.content, '补充读取文件');
    assert.equal(pending.deviceSelection.selectedDeviceId, 'alice-laptop');
  });

  test('reuses one CatsCo tool confirmation for the same run and risk level', async () => {
    const { bot } = createHarness();
    const prompts: string[] = [];
    bot.sender.reply = async (_topic: string, text: string) => {
      prompts.push(text);
    };

    const first = (bot as any).confirmCatsCoToolExecution('p2p_7_43', 'session-key', 'usr7', {
      toolName: 'read_file',
      risk: 'medium',
      reason: '读取工作区外路径',
      args: { file_path: 'C:\\Users\\alice\\Desktop' },
      runId: 'run-1',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = Array.from(bot.pendingAnswers.values())[0];
    pending.resolve('同意');
    (bot as any).clearPendingAnswerById(pending.id);
    assert.equal(await first, true);

    const second = await (bot as any).confirmCatsCoToolExecution('p2p_7_43', 'session-key', 'usr7', {
      toolName: 'glob',
      risk: 'medium',
      reason: '搜索同一任务路径',
      args: { path: 'C:\\Users\\alice\\Desktop' },
      runId: 'run-1',
    });

    assert.equal(second, true);
    assert.equal(prompts.length, 1);
  });

  test('asks again when a CatsCo tool chain upgrades risk in the same run', async () => {
    const { bot } = createHarness();
    const prompts: string[] = [];
    bot.sender.reply = async (_topic: string, text: string) => {
      prompts.push(text);
    };

    const first = (bot as any).confirmCatsCoToolExecution('p2p_7_43', 'session-key', 'usr7', {
      toolName: 'read_file',
      risk: 'medium',
      reason: '读取工作区外路径',
      args: { file_path: 'C:\\Users\\alice\\Desktop' },
      runId: 'run-risk-upgrade',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    let pending = Array.from(bot.pendingAnswers.values())[0];
    pending.resolve('同意');
    (bot as any).clearPendingAnswerById(pending.id);
    assert.equal(await first, true);

    const second = (bot as any).confirmCatsCoToolExecution('p2p_7_43', 'session-key', 'usr7', {
      toolName: 'execute_shell',
      risk: 'high',
      reason: '执行本机命令',
      args: { command: 'Remove-Item old.log' },
      runId: 'run-risk-upgrade',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    pending = Array.from(bot.pendingAnswers.values())[0];
    pending.resolve('确认执行');
    (bot as any).clearPendingAnswerById(pending.id);

    assert.equal(await second, true);
    assert.equal(prompts.length, 2);
  });

  test('CatsCo tool confirmation denial cancels the current run', async () => {
    const { bot } = createHarness();

    const denied = (bot as any).confirmCatsCoToolExecution('p2p_7_43', 'session-key', 'usr7', {
      toolName: 'execute_shell',
      risk: 'medium',
      reason: '命令会在本机执行',
      args: { command: 'dir' },
      runId: 'run-deny',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = Array.from(bot.pendingAnswers.values())[0];
    pending.resolve('取消');
    (bot as any).clearPendingAnswerById(pending.id);

    assert.deepEqual(await denied, {
      approved: false,
      reason: '用户未确认该工具操作，已取消本轮任务。',
      controlSignal: 'cancel_turn',
    });
  });
});

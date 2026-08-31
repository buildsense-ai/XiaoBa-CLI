import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';
import { createCatsCoMessageEnvelope, createExecutionScope } from '../src/catscompany/message-envelope';
import { SubAgentManager } from '../src/core/sub-agent-manager';

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

function nativeFeishuMetadata(actorUserId: string, topicId: string, agentId = 'usr43') {
  return {
    ...canonicalMetadata(actorUserId, topicId, agentId),
    source_channel: 'feishu',
    channel_native_group_binding_id: 17,
    channel_native_group_triggered: true,
  };
}

function expectedCatsCoSessionKey(actorUserId: string, topicId: string, agentId = 'usr43') {
  const topicType = topicId.startsWith('grp_') ? 'group' : 'p2p';
  if (topicType === 'group') return `cc_group:${topicId}`;
  void actorUserId;
  return `session:v2:catscompany:${topicType}:${encodeURIComponent(topicId)}:agent:${encodeURIComponent(agentId)}`;
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
    sessionKey: expectedCatsCoSessionKey(actorUserId, topicId, agentId),
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

function createHarness(options: {
  busy?: boolean;
  existingSession?: boolean;
  restoreStatus?: 'local_present' | 'restored' | 'empty' | 'skipped' | 'failed';
} = {}) {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  const handledTurns: Array<{ userMessage: unknown; options: any }> = [];
  const sessionKeys: string[] = [];
  const sessionInputs: any[] = [];
  const replies: string[] = [];
  const progressEvents: string[] = [];
  const clearedSessionMarkers: string[] = [];
  const injectedContext: string[] = [];
  const contextEvents: string[] = [];
  const savedContextCursors: Array<[string, number]> = [];
  let busy = options.busy ?? false;
  let remoteContextCursor = 0;

  const session = {
    isBusy: () => busy,
    setBusy: (next: boolean) => {
      busy = next;
    },
    handleMessage: async (userMessage: unknown, handleOptions: any) => {
      contextEvents.push('handle');
      handledTurns.push({ userMessage, options: handleOptions });
      return { visibleToUser: false, text: '' };
    },
    handleCommand: async (command: string) => command.toLowerCase() === 'clear'
      ? { handled: true, reply: '历史已清空' }
      : { handled: false },
    handleRuntimeObservation: async () => ({ visibleToUser: false, text: '' }),
    injectContext: (text: string) => {
      contextEvents.push('inject');
      injectedContext.push(text);
    },
    appendDurableContext: async (entries: Array<string | { content: string }>, cursorUpdate?: { source: string; cursor: number }) => {
      contextEvents.push('inject');
      injectedContext.push(...entries.map(entry => typeof entry === 'string' ? entry : entry.content));
      if (cursorUpdate) {
        remoteContextCursor = cursorUpdate.cursor;
        savedContextCursors.push([cursorUpdate.source, cursorUpdate.cursor]);
      }
      return true;
    },
    getRemoteContextCursor: () => remoteContextCursor,
    saveRemoteContextCursor: (source: string, cursor: number) => {
      remoteContextCursor = cursor;
      savedContextCursors.push([source, cursor]);
      return true;
    },
  };

  bot.sessionManager = {
    getOrCreate: (input: any) => {
      sessionInputs.push(input);
      sessionKeys.push(typeof input === 'string' ? input : input.sessionKey);
      return session;
    },
    get: () => options.existingSession === false ? null : session,
  };
  bot.sender = {
    downloadFile: async () => null,
    sendTyping: () => undefined,
    reply: async (_topic: string, text: string) => { replies.push(text); },
    sendFile: async () => undefined,
    sendText: async () => undefined,
    sendThinking: async (_topic: string, text: string) => { progressEvents.push(`thinking:${text}`); },
    sendToolUse: async (_topic: string, toolUseId: string) => { progressEvents.push(`tool_start:${toolUseId}`); },
    sendToolResult: async (_topic: string, toolUseId: string) => { progressEvents.push(`tool_end:${toolUseId}`); },
  };
  bot.pendingAttachments = new Map();
  bot.messageQueue = new Map();
  bot.sessionExecutionReservations = new Set();
  bot.sessionClearGenerations = new Map();
  bot.botUid = 'usr43';
  bot.bot = {
    getAgentContextHistory: async () => ({
      messages: [],
      topic_id: 'grp_80',
      agent_uid: 43,
      has_more: false,
      next_before_id: 0,
    }),
  };
  bot.cloudSessionRestorePromises = new Map();
  bot.cloudSessionRestoreAbortControllers = new Map();
  bot.subAgentCompletionBatches = new Map();
  bot.cloudSessionRestorer = {
    restoreIfMissing: async () => ({
      status: options.restoreStatus || 'empty',
      restoredMessages: 0,
      fetchedMessages: 0,
      compressed: false,
    }),
    markLocalSessionCleared: (sessionKey: string) => {
      clearedSessionMarkers.push(sessionKey);
      return true;
    },
  };

  return {
    bot,
    handledTurns,
    sessionKeys,
    sessionInputs,
    session,
    replies,
    progressEvents,
    clearedSessionMarkers,
    injectedContext,
    contextEvents,
    savedContextCursors,
  };
}

describe('CatsCompany execution scope flow', () => {
  test('drops an unmentioned large-group message before cloud restore or session creation', async () => {
    const { bot, handledTurns, sessionKeys } = createHarness();
    let restoreCalls = 0;
    bot.ensureCloudSessionRestored = async () => {
      restoreCalls++;
      return { status: 'local_present', fetched: 0, restored: 0, compressed: false };
    };

    await bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr7',
      text: '@usr43 只是正文，不是结构化 mention',
      content: '@usr43 只是正文，不是结构化 mention',
      metadata: canonicalMetadata('usr7', 'grp_80'),
      isGroup: true,
      mentions: [],
      memberCount: 4,
      seq: 11,
    });

    assert.equal(restoreCalls, 0);
    assert.deepEqual(sessionKeys, []);
    assert.deepEqual(handledTurns, []);
  });

  test('does not create a blank session when first cloud recovery fails', async () => {
    const { bot, handledTurns, sessionKeys, replies } = createHarness({
      existingSession: false,
      restoreStatus: 'failed',
    });

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '继续之前的工作',
      content: '继续之前的工作',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 12,
    });

    assert.deepEqual(sessionKeys, []);
    assert.equal(handledTurns.length, 0);
    assert.match(replies[0] || '', /没有新建空白上下文/);
  });

  test('a trigger waiting on another initial cloud restore performs incremental hydration later', async () => {
    const harness = createHarness({ existingSession: false });
    let finishRestore!: (result: any) => void;
    const restore = new Promise<any>(resolve => { finishRestore = resolve; });
    harness.bot.cloudSessionRestorePromises.set('cc_group:grp_80', restore);

    const waiting = harness.bot.ensureCloudSessionRestored({} as any, {
      sessionKey: 'cc_group:grp_80',
      topicType: 'group',
    } as any);
    finishRestore({
      status: 'restored',
      restoredMessages: 3,
      fetchedMessages: 3,
      compressed: false,
    });

    assert.deepEqual(await waiting, {
      status: 'local_present',
      restoredMessages: 0,
      fetchedMessages: 0,
      compressed: false,
    });
  });

  test('clear cancels an older initial cloud restore before the old trigger can run', async () => {
    for (const clearCommand of ['/clear', '/clear --all']) {
      const harness = createHarness({ existingSession: false });
      let finishRestore!: () => void;
      let restoreStarted!: () => void;
      let restoreSignal: AbortSignal | undefined;
      const restoreStartedPromise = new Promise<void>(resolve => { restoreStarted = resolve; });
      const restoreGate = new Promise<void>(resolve => { finishRestore = resolve; });
      harness.bot.cloudSessionRestorer.restoreIfMissing = async (request: { signal?: AbortSignal }) => {
        restoreSignal = request.signal;
        restoreStarted();
        await restoreGate;
        return {
          status: 'restored',
          restoredMessages: 3,
          fetchedMessages: 3,
          compressed: false,
        };
      };

      const oldTrigger = harness.bot.onMessage({
        topic: 'grp_80',
        senderId: 'usr8',
        text: '@usr43 old trigger',
        content: '@usr43 old trigger',
        metadata: nativeFeishuMetadata('usr8', 'grp_80'),
        isGroup: true,
        seq: 20,
      });
      await restoreStartedPromise;
      await harness.bot.onMessage({
        topic: 'grp_80',
        senderId: 'usr8',
        text: clearCommand,
        content: clearCommand,
        metadata: nativeFeishuMetadata('usr8', 'grp_80'),
        isGroup: true,
        seq: 21,
      });
      finishRestore();
      await oldTrigger;

      assert.equal(restoreSignal?.aborted, true, clearCommand);
      assert.equal(harness.handledTurns.length, 0, clearCommand);
    }
  });

  test('a message after clear starts a fresh restore without waiting for the aborted promise', async () => {
    const harness = createHarness({ existingSession: false });
    const restoreResolvers: Array<(result: any) => void> = [];
    harness.bot.cloudSessionRestorer.restoreIfMissing = async () => await new Promise(resolve => {
      restoreResolvers.push(resolve);
    });
    const route = {
      sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
      topicId: 'p2p_7_43',
      topicType: 'p2p',
      agentId: 'usr43',
    };

    const oldRestore = harness.bot.ensureCloudSessionRestored({ topic: 'p2p_7_43', seq: 12 } as any, route as any);
    await Promise.resolve();
    assert.equal(restoreResolvers.length, 1);

    await harness.bot.onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '/clear',
      content: '/clear',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 13,
    });

    const newRestore = harness.bot.ensureCloudSessionRestored({ topic: 'p2p_7_43', seq: 14 } as any, route as any);
    await Promise.resolve();
    assert.equal(restoreResolvers.length, 2);

    restoreResolvers[0]({ status: 'failed', restoredMessages: 0, fetchedMessages: 0, compressed: false });
    await oldRestore;
    assert.equal(harness.bot.cloudSessionRestorePromises.has(route.sessionKey), true);

    restoreResolvers[1]({ status: 'restored', restoredMessages: 2, fetchedMessages: 2, compressed: false });
    assert.equal((await newRestore).status, 'restored');
    assert.equal(harness.bot.cloudSessionRestorePromises.has(route.sessionKey), false);
  });

  test('clear discards a pending subagent completion batch', async () => {
    const harness = createHarness();
    const sessionKey = 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43';
    const timer = setTimeout(() => assert.fail('cleared batch timer must not fire'), 10_000);
    timer.unref?.();
    harness.bot.subAgentCompletionBatches.set(sessionKey, {
      topic: 'p2p_7_43',
      senderId: 'usr7',
      firstAt: Date.now(),
      clearGeneration: 0,
      items: new Map([['old', { observation: 'old result' }]]),
      timer,
    });

    await harness.bot.onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '/clear',
      content: '/clear',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 12,
    });

    assert.equal(harness.bot.subAgentCompletionBatches.has(sessionKey), false);
  });

  test('regular clear writes an empty sentinel while clear --all keeps files deleted', async () => {
    const regular = createHarness();
    await (regular.bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '/clear',
      content: '/clear',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 12,
    });
    assert.deepEqual(regular.clearedSessionMarkers, [
      'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    ]);

    const all = createHarness();
    await (all.bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '/clear --all',
      content: '/clear --all',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 13,
    });
    assert.deepEqual(all.clearedSessionMarkers, []);
  });

  test('regular clear reports a durable persistence failure instead of claiming success', async () => {
    const harness = createHarness();
    harness.bot.cloudSessionRestorer.markLocalSessionCleared = () => false;

    await (harness.bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '/clear',
      content: '/clear',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 12,
    });

    assert.match(harness.replies.at(-1) || '', /持久化失败.*重试 \/clear/);
  });

  test('text that only resembles a clear command remains a normal user message', async () => {
    const { bot, handledTurns, clearedSessionMarkers } = createHarness();

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: ' /clear',
      content: ' /clear',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 14,
    });

    assert.equal(handledTurns.length, 1);
    assert.deepEqual(clearedSessionMarkers, []);
  });

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
    assert.equal(sessionInputs[0].legacyRestoreKey, 'cc_user:usr7');
    assert.equal(sessionInputs[0].legacyCleanupKey, 'cc_user:usr7');
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.sessionRoute.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(handledTurns[0].options.executionScope.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(handledTurns[0].options.executionScope.legacySessionKey, 'cc_user:usr7');
    assert.equal(handledTurns[0].options.executionScope.legacyRestoreKey, 'cc_user:usr7');
    assert.equal(handledTurns[0].options.executionScope.legacyCleanupKey, 'cc_user:usr7');
    assert.equal(handledTurns[0].options.executionScope.actorUserId, 'usr7');
    assert.equal(handledTurns[0].options.executionScope.agentId, 'usr43');
    assert.equal(handledTurns[0].options.executionScope.agentBodyId, 'body-main');
    assert.equal(handledTurns[0].options.executionScope.isTrusted, true);
  });

  test('keeps execution scope when a busy CatsCompany turn is queued then drained', async () => {
    const { bot, handledTurns, sessionKeys, session } = createHarness({ busy: true });
    const ref = `acr_${'c'.repeat(43)}`;

    await (bot as any).onMessage({
      topic: 'p2p_8_43',
      senderId: 'usr8',
      text: '继续查',
      content: '继续查',
      metadata: {
        ...canonicalMetadata('usr8', 'p2p_8_43'),
        artifact_context_ref: ref,
      },
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
    assert.equal(handledTurns[0].options.artifactContextRef, ref);
  });

  test('keeps a drained user message queued when the session call rejects once', async () => {
    const harness = createHarness({ busy: true });
    let calls = 0;
    harness.session.handleMessage = async (userMessage: unknown, options: any) => {
      calls++;
      if (calls === 1) throw new Error('transient session failure');
      harness.handledTurns.push({ userMessage, options });
      return { visibleToUser: false, text: '' };
    };

    await harness.bot.onMessage({
      topic: 'p2p_8_43',
      senderId: 'usr8',
      text: '不能丢失的消息',
      content: '不能丢失的消息',
      metadata: canonicalMetadata('usr8', 'p2p_8_43'),
      isGroup: false,
      seq: 12,
    });
    harness.session.setBusy(false);
    const sessionKey = 'session:v2:catscompany:p2p:p2p_8_43:agent:usr43';
    await harness.bot.drainMessageQueue(sessionKey);
    assert.equal(harness.bot.messageQueue.get(sessionKey)?.length, 1);

    await harness.bot.drainMessageQueue(sessionKey);
    assert.equal(calls, 2);
    assert.equal(harness.handledTurns.length, 1);
    assert.equal(harness.bot.messageQueue.has(sessionKey), false);
  });

  test('retries direct subagent feedback through the queue after a rejected call', async () => {
    const harness = createHarness();
    let calls = 0;
    harness.session.handleRuntimeObservation = async () => {
      calls++;
      if (calls === 1) throw new Error('transient observation failure');
      return { visibleToUser: false, text: '' };
    };

    await harness.bot.handleSubAgentFeedback(
      'cc_group:grp_80',
      'grp_80',
      'usr8',
      '需要回流的普通 observation',
      createExecutionScope(createCatsCoMessageEnvelope({ topic: 'grp_80', senderId: 'usr8', text: 'observation' })),
    );

    assert.equal(calls, 2);
    assert.equal(harness.bot.messageQueue.has('cc_group:grp_80'), false);
  });

  test('falls back to a user-visible subagent result after model injection retries are exhausted', async () => {
    const harness = createHarness();
    let calls = 0;
    harness.session.handleRuntimeObservation = async () => {
      calls++;
      throw new Error('persistent observation failure');
    };
    const sessionKey = 'cc_group:grp_80';

    await harness.bot.handleSubAgentFeedback(
      sessionKey,
      'grp_80',
      'usr8',
      '需要保留的普通 observation',
      createExecutionScope(createCatsCoMessageEnvelope({ topic: 'grp_80', senderId: 'usr8', text: 'observation' })),
    );
    await harness.bot.drainMessageQueue(sessionKey);
    await harness.bot.drainMessageQueue(sessionKey);

    assert.equal(calls, 3);
    assert.match(harness.replies.at(-1) || '', /需要保留的普通 observation/);
    assert.equal(harness.bot.messageQueue.has(sessionKey), false);
  });

  test('bounds delivery-only subagent fallback retries when replies keep failing', async () => {
    const harness = createHarness();
    const sessionKey = 'cc_group:grp_80';
    let deliveryCalls = 0;
    harness.bot.sender.reply = async () => {
      deliveryCalls++;
      throw new Error('persistent delivery failure');
    };
    harness.bot.messageQueue.set(sessionKey, [{
      userMessage: '无法发送的子任务结果',
      topic: 'grp_80',
      senderId: 'usr8',
      seq: 0,
      executionScope: createExecutionScope(createCatsCoMessageEnvelope({
        topic: 'grp_80',
        senderId: 'usr8',
        text: 'observation',
      })),
      receivedAt: Date.now(),
      source: 'subagent_feedback',
      deliveryOnly: true,
    }]);

    await harness.bot.drainMessageQueue(sessionKey);
    await harness.bot.drainMessageQueue(sessionKey);
    await harness.bot.drainMessageQueue(sessionKey);

    assert.equal(deliveryCalls, 3);
    assert.equal(harness.bot.messageQueue.has(sessionKey), false);
  });

  test('notifies the user when direct incremental group history recovery fails', async () => {
    const harness = createHarness();
    harness.bot.bot.getAgentContextHistory = async () => {
      throw new Error('history unavailable');
    };

    await harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 回答上面的问题',
      content: '@usr43 回答上面的问题',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 20,
    });

    assert.equal(harness.handledTurns.length, 0);
    assert.equal(harness.replies.length, 1);
    assert.match(harness.replies[0] || '', /历史暂时恢复失败.*重新发送/);
  });

  test('notifies the user when queued incremental group history recovery fails', async () => {
    const harness = createHarness({ busy: true });
    harness.bot.bot.getAgentContextHistory = async () => {
      throw new Error('history unavailable');
    };

    await harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 回答上面的问题',
      content: '@usr43 回答上面的问题',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 20,
    });
    assert.deepEqual(harness.replies, []);

    harness.session.setBusy(false);
    await harness.bot.drainMessageQueue('cc_group:grp_80');

    assert.equal(harness.handledTurns.length, 0);
    assert.equal(harness.replies.length, 1);
    assert.match(harness.replies[0] || '', /历史暂时恢复失败.*重新发送/);
    assert.equal(harness.bot.messageQueue.has('cc_group:grp_80'), false);
  });

  test('hydrates a busy native Feishu trigger only when its queued turn executes', async () => {
    const harness = createHarness({ busy: true });
    let historyFetches = 0;
    harness.bot.bot.getAgentContextHistory = async (_topic: string, options: { beforeId?: number }) => {
      historyFetches++;
      assert.equal(options.beforeId, 20);
      return {
        messages: [{
          id: 19,
          seq_id: 19,
          from_uid: 8,
          content: '上面那句普通群消息',
          context_eligible: true,
          context_role: 'user',
          context_reason: 'participant_message',
          agent_uid: 43,
          agent_id: 'usr43',
          metadata: {
            catsco_identity: { actor: { display_name: '林益', user_id: 'usr8' } },
          },
        }],
        topic_id: 'grp_80',
        agent_uid: 43,
        has_more: false,
        next_before_id: 0,
      };
    };

    await harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 回答上面的问题',
      content: '@usr43 回答上面的问题',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 20,
    });

    assert.equal(historyFetches, 0);
    assert.deepEqual(harness.injectedContext, []);
    assert.deepEqual(harness.savedContextCursors, []);
    assert.equal(harness.handledTurns.length, 0);

    harness.session.setBusy(false);
    await harness.bot.drainMessageQueue('cc_group:grp_80');

    assert.equal(historyFetches, 1);
    assert.deepEqual(harness.injectedContext, ['[发言人: 林益]\n上面那句普通群消息']);
    assert.deepEqual(harness.savedContextCursors, [['catscompany.agent_context', 20]]);
    assert.deepEqual(harness.contextEvents, ['inject', 'handle']);
    assert.equal(harness.handledTurns.length, 1);
  });

  test('serializes native history hydration with subagent feedback for the same session', async () => {
    const harness = createHarness();
    let releaseHistory!: () => void;
    let historyStarted!: () => void;
    const historyStartedPromise = new Promise<void>(resolve => { historyStarted = resolve; });
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
    harness.bot.bot.getAgentContextHistory = async () => {
      historyStarted();
      await historyGate;
      return {
        messages: [{
          id: 19,
          seq_id: 19,
          from_uid: 8,
          content: '群里的普通发言',
          context_eligible: true,
          context_role: 'user',
          context_reason: 'participant_message',
          agent_uid: 43,
          agent_id: 'usr43',
        }],
        topic_id: 'grp_80',
        agent_uid: 43,
        has_more: false,
        next_before_id: 0,
      };
    };
    harness.session.handleRuntimeObservation = async () => {
      harness.contextEvents.push('observation');
      return { visibleToUser: false, text: '' };
    };

    const trigger = harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 总结一下',
      content: '@usr43 总结一下',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 20,
    });
    await historyStartedPromise;

    await harness.bot.handleSubAgentFeedback(
      'cc_group:grp_80',
      'grp_80',
      'usr8',
      '子任务补充结果',
      createExecutionScope(createCatsCoMessageEnvelope({ topic: 'grp_80', senderId: 'usr8', text: '子任务补充结果' })),
    );
    assert.deepEqual(harness.contextEvents, []);

    releaseHistory();
    await trigger;

    assert.deepEqual(harness.contextEvents, ['inject', 'handle', 'observation']);
  });

  test('does not let pending user input consume a queued native Feishu trigger', async () => {
    const harness = createHarness();
    let releaseFirstTurn!: () => void;
    let firstTurnStarted!: () => void;
    const firstTurnStartedPromise = new Promise<void>(resolve => { firstTurnStarted = resolve; });
    const firstTurnGate = new Promise<void>(resolve => { releaseFirstTurn = resolve; });
    let pendingInputProvider: (() => unknown) | undefined;
    harness.session.handleMessage = async (userMessage: unknown, options: any) => {
      harness.contextEvents.push('handle');
      harness.handledTurns.push({ userMessage, options });
      if (harness.handledTurns.length === 1) {
        pendingInputProvider = options.pendingUserInputProvider;
        firstTurnStarted();
        await firstTurnGate;
      }
      return { visibleToUser: false, text: '' };
    };

    const firstTurn = harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '先处理这个任务',
      content: '先处理这个任务',
      metadata: canonicalMetadata('usr8', 'grp_80'),
      isGroup: true,
      memberCount: 2,
      seq: 19,
    });
    await firstTurnStartedPromise;

    await harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 回答群里的讨论',
      content: '@usr43 回答群里的讨论',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 20,
    });

    assert.equal(pendingInputProvider?.(), null);
    assert.equal(harness.bot.messageQueue.get('cc_group:grp_80')?.length, 1);
    releaseFirstTurn();
    await firstTurn;

    assert.equal(harness.handledTurns.length, 2);
    assert.equal(harness.bot.messageQueue.has('cc_group:grp_80'), false);
  });

  test('clear and clear --all discard queued native triggers before they can hydrate', async () => {
    for (const clearCommand of ['/clear', '/clear --all']) {
      const harness = createHarness({ busy: true });
      let historyFetches = 0;
      harness.bot.bot.getAgentContextHistory = async () => {
        historyFetches++;
        throw new Error('cleared trigger must not fetch history');
      };

      await harness.bot.onMessage({
        topic: 'grp_80',
        senderId: 'usr8',
        text: '@usr43 old trigger',
        content: '@usr43 old trigger',
        metadata: nativeFeishuMetadata('usr8', 'grp_80'),
        isGroup: true,
        seq: 20,
      });
      await harness.bot.onMessage({
        topic: 'grp_80',
        senderId: 'usr8',
        text: clearCommand,
        content: clearCommand,
        metadata: nativeFeishuMetadata('usr8', 'grp_80'),
        isGroup: true,
        seq: 21,
      });

      harness.session.setBusy(false);
      await harness.bot.drainMessageQueue('cc_group:grp_80');
      assert.equal(historyFetches, 0, clearCommand);
      assert.equal(harness.handledTurns.length, 0, clearCommand);
      assert.equal(harness.bot.messageQueue.has('cc_group:grp_80'), false, clearCommand);
    }
  });

  test('clear prevents an already drained failing message from re-entering the queue', async () => {
    const harness = createHarness({ busy: true });
    let executionStarted!: () => void;
    let releaseExecution!: () => void;
    const executionStartedPromise = new Promise<void>(resolve => { executionStarted = resolve; });
    const executionGate = new Promise<void>(resolve => { releaseExecution = resolve; });
    harness.session.handleMessage = async () => {
      executionStarted();
      await executionGate;
      throw new Error('old turn failed after clear');
    };

    await harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 old queued trigger',
      content: '@usr43 old queued trigger',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 20,
    });

    harness.session.setBusy(false);
    const drain = harness.bot.drainMessageQueue('cc_group:grp_80');
    await executionStartedPromise;
    await harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '/clear',
      content: '/clear',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 21,
    });
    releaseExecution();
    await drain;

    assert.equal(harness.bot.messageQueue.has('cc_group:grp_80'), false);
    assert.deepEqual(harness.replies, ['历史已清空']);
  });

  test('clear keeps a stale turn from consuming new input or emitting callbacks after reset', async () => {
    const harness = createHarness();
    let oldTurnStarted!: () => void;
    let releaseOldTurn!: () => void;
    const oldTurnStartedPromise = new Promise<void>(resolve => { oldTurnStarted = resolve; });
    const oldTurnGate = new Promise<void>(resolve => { releaseOldTurn = resolve; });
    let oldPendingInputProvider: (() => unknown) | undefined;
    let handleCalls = 0;
    harness.session.handleMessage = async (userMessage: unknown, options: any) => {
      handleCalls++;
      harness.handledTurns.push({ userMessage, options });
      if (handleCalls === 1) {
        oldPendingInputProvider = options.pendingUserInputProvider;
        oldTurnStarted();
        await oldTurnGate;
        await options.callbacks.onRetry(1, 2, {});
        await options.callbacks.onAssistantText('stale tool prelude after clear');
        await options.callbacks.onThinking('stale thinking after clear');
        await options.callbacks.onToolStart('execute_shell', 'stale-tool', {});
        await options.callbacks.onToolEnd('execute_shell', 'stale-tool', 'stale result');
        return { visibleToUser: true, text: 'stale reply after clear' };
      }
      return { visibleToUser: false, text: '' };
    };

    const oldTurn = harness.bot.onMessage({
      topic: 'grp_80', senderId: 'usr8', text: '@usr43 old turn', content: '@usr43 old turn',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'), isGroup: true, seq: 20,
    });
    await oldTurnStartedPromise;
    await harness.bot.onMessage({
      topic: 'grp_80', senderId: 'usr8', text: '/clear', content: '/clear',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'), isGroup: true, seq: 21,
    });
    await harness.bot.onMessage({
      topic: 'grp_80', senderId: 'usr8', text: '@usr43 new turn', content: '@usr43 new turn',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'), isGroup: true, seq: 22,
    });

    assert.equal(oldPendingInputProvider?.(), null);
    assert.equal(harness.bot.messageQueue.get('cc_group:grp_80')?.length, 1);
    releaseOldTurn();
    await oldTurn;

    assert.deepEqual(harness.replies, ['历史已清空']);
    assert.deepEqual(harness.progressEvents, []);
    assert.equal(harness.handledTurns.length, 2);
    assert.match(String(harness.handledTurns[1].userMessage), /new turn/);
    assert.equal(harness.bot.messageQueue.has('cc_group:grp_80'), false);
  });

  test('clear prevents stale subagent feedback from being requeued after failure', async () => {
    const harness = createHarness();
    let feedbackStarted!: () => void;
    let releaseFeedback!: () => void;
    const feedbackStartedPromise = new Promise<void>(resolve => { feedbackStarted = resolve; });
    const feedbackGate = new Promise<void>(resolve => { releaseFeedback = resolve; });
    harness.session.handleRuntimeObservation = async () => {
      feedbackStarted();
      await feedbackGate;
      throw new Error('stale subagent feedback failed after clear');
    };

    const feedback = harness.bot.handleSubAgentFeedback(
      'cc_group:grp_80', 'grp_80', 'usr8', 'old feedback',
      createExecutionScope(createCatsCoMessageEnvelope({ topic: 'grp_80', senderId: 'usr8', text: 'old feedback' })),
    );
    await feedbackStartedPromise;
    await harness.bot.onMessage({
      topic: 'grp_80', senderId: 'usr8', text: '/clear', content: '/clear',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'), isGroup: true, seq: 21,
    });
    releaseFeedback();
    await feedback;

    assert.equal(harness.bot.messageQueue.has('cc_group:grp_80'), false);
    assert.deepEqual(harness.replies, ['历史已清空']);
  });

  test('clear rejects a subagent callback registered by the previous generation', async () => {
    const harness = createHarness();
    const sessionKey = 'cc_group:grp_80';
    harness.bot.registerSubAgentPlatformCallbacks(
      sessionKey,
      'grp_80',
      'usr8',
      createExecutionScope(createCatsCoMessageEnvelope({ topic: 'grp_80', senderId: 'usr8', text: 'parent turn' })),
    );
    const callbacks = (SubAgentManager.getInstance() as any).platformCallbacks.get(sessionKey);
    assert.ok(callbacks?.injectMessage);

    await harness.bot.onMessage({
      topic: 'grp_80', senderId: 'usr8', text: '/clear', content: '/clear',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'), isGroup: true, seq: 21,
    });
    await callbacks.injectMessage('late result from cleared subagent');

    assert.equal(harness.bot.messageQueue.has(sessionKey), false);
    assert.equal(harness.handledTurns.length, 0);
    assert.deepEqual(harness.replies, ['历史已清空']);
  });

  test('clear invalidates an in-flight hydration and lets a newer trigger run', async () => {
    const harness = createHarness();
    let releaseOldHistory!: () => void;
    let oldHistoryStarted!: () => void;
    const oldHistoryStartedPromise = new Promise<void>(resolve => { oldHistoryStarted = resolve; });
    const oldHistoryGate = new Promise<void>(resolve => { releaseOldHistory = resolve; });
    let releaseClearReply!: () => void;
    let clearReplyStarted!: () => void;
    const clearReplyStartedPromise = new Promise<void>(resolve => { clearReplyStarted = resolve; });
    const clearReplyGate = new Promise<void>(resolve => { releaseClearReply = resolve; });
    const fetchedBeforeIds: number[] = [];
    harness.bot.sender.reply = async (_topic: string, text: string) => {
      if (text === '历史已清空') {
        clearReplyStarted();
        await clearReplyGate;
      }
    };
    harness.bot.bot.getAgentContextHistory = async (_topic: string, options: { beforeId: number }) => {
      fetchedBeforeIds.push(options.beforeId);
      if (options.beforeId === 20) {
        oldHistoryStarted();
        await oldHistoryGate;
        return {
          messages: [{
            id: 19,
            seq_id: 19,
            from_uid: 8,
            content: 'must not be injected after clear',
            context_eligible: true,
            context_role: 'user',
            context_reason: 'participant_message',
            agent_uid: 43,
            agent_id: 'usr43',
          }],
          topic_id: 'grp_80',
          agent_uid: 43,
          has_more: false,
          next_before_id: 0,
        };
      }
      return {
        messages: [],
        topic_id: 'grp_80',
        agent_uid: 43,
        has_more: false,
        next_before_id: 0,
      };
    };

    const oldTrigger = harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 old trigger',
      content: '@usr43 old trigger',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 20,
    });
    await oldHistoryStartedPromise;
    const clear = harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '/clear',
      content: '/clear',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 21,
    });
    await clearReplyStartedPromise;
    await harness.bot.onMessage({
      topic: 'grp_80',
      senderId: 'usr8',
      text: '@usr43 new trigger',
      content: '@usr43 new trigger',
      metadata: nativeFeishuMetadata('usr8', 'grp_80'),
      isGroup: true,
      seq: 22,
    });

    releaseOldHistory();
    await oldTrigger;
    releaseClearReply();
    await clear;

    assert.deepEqual(fetchedBeforeIds, [20, 22]);
    assert.deepEqual(harness.injectedContext, []);
    assert.equal(harness.handledTurns.length, 1);
    assert.match(String(harness.handledTurns[0].userMessage), /new trigger/);
  });

  test('group turn uses legacy group session key while preserving actor in scope', async () => {
    const { bot, handledTurns, sessionKeys } = createHarness();

    await (bot as any).onMessage({
      topic: 'grp_80',
      senderId: 'usr7',
      text: '@usr43 看一下',
      content: '@usr43 看一下',
      metadata: canonicalMetadata('usr7', 'grp_80'),
      isGroup: true,
      mentions: ['usr43'],
      memberCount: 3,
      seq: 12,
    });

    assert.deepEqual(sessionKeys, ['cc_group:grp_80']);
    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.sessionRoute.sessionKey, 'cc_group:grp_80');
    assert.equal(handledTurns[0].options.sessionRoute.legacySessionKey, 'cc_group:grp_80');
    assert.equal(handledTurns[0].options.sessionRoute.legacyRestoreKey, 'cc_group:grp_80');
    assert.equal(handledTurns[0].options.sessionRoute.legacyCleanupKey, 'cc_group:grp_80');
    assert.equal(handledTurns[0].options.executionScope.sessionKey, 'cc_group:grp_80');
    assert.equal(handledTurns[0].options.executionScope.legacySessionKey, 'cc_group:grp_80');
    assert.equal(handledTurns[0].options.executionScope.legacyRestoreKey, 'cc_group:grp_80');
    assert.equal(handledTurns[0].options.executionScope.legacyCleanupKey, 'cc_group:grp_80');
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

  test('passes group device grants into CatsCompany session turn', async () => {
    const { bot, handledTurns } = createHarness();

    await (bot as any).onMessage({
      topic: 'grp_80',
      senderId: 'usr7',
      text: '在我的桌面创建文件夹',
      content: '在我的桌面创建文件夹',
      metadata: metadataWithDeviceGrants('usr7', 'grp_80', [
        deviceGrant({
          sessionKey: expectedCatsCoSessionKey('usr7', 'grp_80'),
          topicId: 'grp_80',
          topicType: 'group',
        }),
      ]),
      isGroup: true,
      memberCount: 2,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.executionScope.sessionKey, expectedCatsCoSessionKey('usr7', 'grp_80'));
    assert.equal(handledTurns[0].options.executionScope.topicId, 'grp_80');
    assert.equal(handledTurns[0].options.deviceGrants?.length, 1);
    assert.equal(handledTurns[0].options.deviceGrants[0].sessionKey, expectedCatsCoSessionKey('usr7', 'grp_80'));
    assert.equal(handledTurns[0].options.deviceGrants[0].topicId, 'grp_80');
    assert.equal(handledTurns[0].options.deviceGrants[0].actorUserId, 'usr7');
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

  test('forwards a trusted Artifact context ref only through current turn options', async () => {
    const { bot, handledTurns } = createHarness();
    const ref = `acr_${'a'.repeat(43)}`;
    const metadata = {
      ...canonicalMetadata('usr7', 'p2p_7_43'),
      artifact_context_ref: ref,
    };

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '分析这些',
      content: '分析这些',
      metadata,
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.artifactContextRef, ref);
    assert.equal('artifactContextRef' in handledTurns[0].options.executionScope, false);
    assert.doesNotMatch(JSON.stringify(handledTurns[0].userMessage), /acr_[A-Za-z0-9_-]{43}/);
  });

  test('forwards a trusted Artifact task ref only through current turn options', async () => {
    const { bot, handledTurns } = createHarness();
    const ref = `atr_${'t'.repeat(43)}`;
    const metadata = {
      ...canonicalMetadata('usr7', 'p2p_7_43'),
      artifact_task_ref: ref,
    };

    await (bot as any).onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '来自「项目风险台账」：分析选中的风险',
      content: '来自「项目风险台账」：分析选中的风险',
      metadata,
      isGroup: false,
      seq: 12,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.artifactTaskRef, ref);
    assert.equal('artifactTaskRef' in handledTurns[0].options.executionScope, false);
    assert.doesNotMatch(JSON.stringify(handledTurns[0].userMessage), /atr_[A-Za-z0-9_-]{43}/);
  });

  test('executes a replayed Artifact task ref only once', async () => {
    const { bot, handledTurns } = createHarness();
    const ref = `atr_${'r'.repeat(43)}`;
    const message = {
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '来自「项目风险台账」：分析选中的风险',
      content: '来自「项目风险台账」：分析选中的风险',
      metadata: {
        ...canonicalMetadata('usr7', 'p2p_7_43'),
        artifact_task_ref: ref,
      },
      isGroup: false,
      seq: 12,
    };

    await (bot as any).onMessage(message);
    await (bot as any).onMessage({ ...message, seq: 12 });

    assert.equal(handledTurns.length, 1);
    assert.equal(handledTurns[0].options.artifactTaskRef, ref);
  });

  test('deduplicates an Artifact task replay while its first turn is still running', async () => {
    const harness = createHarness();
    const ref = `atr_${'s'.repeat(43)}`;
    let releaseTurn!: () => void;
    let turnStarted!: () => void;
    const turnStartedPromise = new Promise<void>(resolve => { turnStarted = resolve; });
    const turnGate = new Promise<void>(resolve => { releaseTurn = resolve; });
    harness.session.handleMessage = async (userMessage: unknown, options: any) => {
      harness.handledTurns.push({ userMessage, options });
      turnStarted();
      await turnGate;
      return { visibleToUser: false, text: '' };
    };
    const message = {
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '来自「项目风险台账」：分析选中的风险',
      content: '来自「项目风险台账」：分析选中的风险',
      metadata: {
        ...canonicalMetadata('usr7', 'p2p_7_43'),
        artifact_task_ref: ref,
      },
      isGroup: false,
      seq: 12,
    };

    const first = (harness.bot as any).onMessage(message);
    await turnStartedPromise;
    await (harness.bot as any).onMessage({ ...message, seq: 12 });
    assert.equal(harness.handledTurns.length, 1);

    releaseTurn();
    await first;
    assert.equal(harness.handledTurns.length, 1);
  });

  test('keeps ordinary queued input out of an active Artifact task turn', async () => {
    const harness = createHarness();
    const taskRef = `atr_${'u'.repeat(43)}`;
    const taskStatuses: any[] = [];
    let releaseTaskTurn!: () => void;
    let taskTurnStarted!: () => void;
    const taskTurnStartedPromise = new Promise<void>(resolve => { taskTurnStarted = resolve; });
    const taskTurnGate = new Promise<void>(resolve => { releaseTaskTurn = resolve; });
    let pendingInputProvider: (() => unknown) | undefined;

    harness.bot.sender.sendTaskStatus = async (_topic: string, status: any) => {
      taskStatuses.push(status);
    };
    harness.session.handleMessage = async (userMessage: unknown, options: any) => {
      harness.handledTurns.push({ userMessage, options });
      if (harness.handledTurns.length === 1) {
        pendingInputProvider = options.pendingUserInputProvider;
        taskTurnStarted();
        await taskTurnGate;
      }
      return { visibleToUser: false, text: '' };
    };

    const taskTurn = harness.bot.onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '来自「项目风险台账」：分析选中的风险',
      content: '来自「项目风险台账」：分析选中的风险',
      metadata: {
        ...canonicalMetadata('usr7', 'p2p_7_43'),
        artifact_task_ref: taskRef,
      },
      isGroup: false,
      seq: 12,
    });
    await taskTurnStartedPromise;

    await harness.bot.onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '顺便再检查一下普通风险项',
      content: '顺便再检查一下普通风险项',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      isGroup: false,
      seq: 13,
    });

    assert.equal(pendingInputProvider?.(), null);
    const queued = harness.bot.messageQueue.get(expectedCatsCoSessionKey('usr7', 'p2p_7_43'));
    assert.equal(queued?.length, 1);
    assert.equal(queued?.[0].artifactTaskRef, undefined);

    releaseTaskTurn();
    await taskTurn;
    await Promise.all(Array.from(harness.bot.taskStatusTasks?.values?.() || []));

    assert.equal(harness.handledTurns.length, 2);
    assert.equal(harness.handledTurns[0].options.artifactTaskRef, taskRef);
    assert.equal(harness.handledTurns[1].options.artifactTaskRef, undefined);
    assert.equal('artifactTaskRef' in harness.handledTurns[1].options.executionScope, false);
    assert.match(String(harness.handledTurns[1].userMessage), /普通风险项/);
    assert.equal(harness.bot.messageQueue.has(expectedCatsCoSessionKey('usr7', 'p2p_7_43')), false);

    const taskRunIDs = new Set(taskStatuses
      .filter(status => status.artifact_task_ref === taskRef)
      .map(status => status.run_id));
    const ordinaryRunIDs = new Set(taskStatuses
      .filter(status => !status.artifact_task_ref)
      .map(status => status.run_id));
    assert.equal(taskRunIDs.size, 1);
    assert.equal(ordinaryRunIDs.size, 1);
    assert.notEqual([...taskRunIDs][0], [...ordinaryRunIDs][0]);
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

    assert.equal(aliceScope.sessionKey, bobScope.sessionKey);

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

  test('keeps a queued Artifact task for its own run instead of merging it into active input', () => {
    const { bot } = createHarness();
    const scope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: 'first',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      botUid: 'usr43',
    }));
    const taskRef = `atr_${'q'.repeat(43)}`;

    bot.messageQueue.set(scope.sessionKey, [{
      userMessage: '来自「项目风险台账」：生成处理方案',
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 13,
      executionScope: scope,
      artifactTaskRef: taskRef,
      receivedAt: Date.now(),
      source: 'user',
    }]);

    assert.equal((bot as any).consumeQueuedUserInput(scope.sessionKey, scope), null);
    assert.equal(bot.messageQueue.get(scope.sessionKey)?.[0].artifactTaskRef, taskRef);
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

  test('uses the latest queued Artifact context ref and can explicitly clear the previous one', () => {
    const { bot } = createHarness();
    const scope = createExecutionScope(createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: 'first',
      metadata: canonicalMetadata('usr7', 'p2p_7_43'),
      botUid: 'usr43',
    }));
    const firstRef = `acr_${'a'.repeat(43)}`;
    const secondRef = `acr_${'b'.repeat(43)}`;

    bot.messageQueue.set(scope.sessionKey, [{
      userMessage: '先看第一版',
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 13,
      executionScope: scope,
      artifactContextRef: firstRef,
      receivedAt: Date.now(),
      source: 'user',
    }, {
      userMessage: '以现在页面为准',
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 14,
      executionScope: scope,
      artifactContextRef: secondRef,
      receivedAt: Date.now() + 1,
      source: 'user',
    }]);

    const replaced = (bot as any).consumeQueuedUserInput(scope.sessionKey, scope);
    assert.equal(replaced.artifactContextRef, secondRef);
    assert.doesNotMatch(JSON.stringify(replaced.content), /acr_[A-Za-z0-9_-]{43}/);

    bot.messageQueue.set(scope.sessionKey, [{
      userMessage: '页面已经关掉了',
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 15,
      executionScope: scope,
      artifactContextRef: undefined,
      receivedAt: Date.now() + 2,
      source: 'user',
    }]);
    const cleared = (bot as any).consumeQueuedUserInput(scope.sessionKey, scope);
    assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'artifactContextRef'), true);
    assert.equal(cleared.artifactContextRef, undefined);
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

  test('ignores legacy Artifact page metadata instead of forwarding it into a turn', async () => {
    const { bot, handledTurns } = createHarness();
    const sentinel = 'LEGACY_ARTIFACT_PAGE_SENTINEL_7f31c2';
    const metadata = {
      ...canonicalMetadata('usr7', 'p2p_7_43'),
      artifact_context: {
        contract_version: 'catsco.artifact-context.v1',
        id: 'lesson-game',
        agent_uid: '43',
        title: 'Lesson game',
        kind: 'mini_app',
        url: 'https://agent-43.artifacts.catsco.fun/artifacts/lesson-game/latest/',
        topic_id: 'p2p_7_43',
        currently_visible: true,
        displayed_version: 2,
        latest_version: 3,
        page_context: {
          contract_version: 'catsco.artifact-page-context.v1',
          observed_at: '2026-08-14T03:00:00Z',
          selected_text: sentinel,
          semantic_context: { note: sentinel },
        },
      },
      artifact_page_context: {
        contract_version: 'catsco.artifact-page-context.v1',
        observed_at: '2026-08-14T03:00:00Z',
        selected_text: sentinel,
      },
    };

    await bot.onMessage({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: '分析右边这些',
      content: '分析右边这些',
      metadata,
      isGroup: false,
      seq: 31,
    });

    assert.equal(handledTurns.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(handledTurns[0].options, 'artifactContext'), false);
    assert.equal(JSON.stringify(handledTurns[0].options).includes(sentinel), false);
  });
});

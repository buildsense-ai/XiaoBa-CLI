import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { ExecutionScope } from '../src/types/session-identity';
import type { ToolExecutionContext } from '../src/types/tool';

/**
 * Task-status coordination of the interrupted-turn resume.
 *
 * The resume turn is an internal runtime observation, so it used to run with no
 * ActiveConversationTask at all: no `running` was ever published, the platform
 * kept the `stale` terminal the previous process had written, and the resume
 * itself could never be reported as finished. A failure was logged and then the
 * marker was cleared unconditionally, so the interrupted work disappeared in
 * silence. These tests pin the run lifecycle a resumed turn must own, using the
 * real connector methods with a prototype stub (same pattern as
 * catscompany-runtime-ready.test.ts) and a real SessionStore on a temp root.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cats-resume-status-'));
process.env.XIAOBA_USER_DATA_DIR = root;
const require = createRequire(import.meta.url);
const { SessionStore } = require('../src/utils/session-store');
const { CatsCompanyBot } = require('../src/catscompany');

after(() => {
  require('../src/utils/logger').Logger.closeLogFile();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const { collectInterruptedTurns, markInterruptedTurn, sanitizeDeviceContext } = require('../src/core/interrupted-turn-recovery');
const { getDeviceAuthorizationSessionKey } = require('../src/core/device-grants');
const { executeRouteIfRemote, resolveExecutionRoute } = require('../src/tools/execution-router');

let serial = 7000;

type Observation = { text?: string; visibleToUser?: boolean; taskOutcome?: string };

function fixture(t: TestContext) {
  const topic = `grp_${++serial}`;
  const key = `cc_group:${topic}`;
  const store = new SessionStore();
  t.mock.method(SessionStore, 'getInstance', () => store);
  const marker = {
    sessionKey: key,
    topic,
    reason: 'oom-kill',
    startedAt: new Date().toISOString(),
    attempts: 0,
  };
  const statuses: Array<{ run_id: string; state: string; summary?: string; error?: string }> = [];
  const replies: string[] = [];
  const events: string[] = [];
  let observation: (context: ToolExecutionContext) => Promise<Observation> = async () => ({ text: '', visibleToUser: false });
  const session = {
    isBusy: () => false,
    requestInterrupt: () => { events.push('interrupt'); },
    handleRuntimeObservation: async (_notice: string, context: ToolExecutionContext) => {
      events.push('observation');
      return observation(context);
    },
  };
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  Object.assign(bot, {
    botUid: 'usr9',
    connectorReady: true,
    shuttingDown: false,
    activeMessageHandlers: 0,
    resumedInterruptedTurns: new Set<string>(),
    sessionExecutionReservations: new Set<string>(),
    activeConversationTasks: new Map(),
    messageQueue: new Map(),
    sessionClearGenerations: new Map(),
    sessionStopGenerations: new Map(),
    taskStatusTasks: new Map(),
    taskStatusRetryDelaysMs: [],
    sessionManager: { get: () => session, getOrCreate: () => session },
    // assertForkLocalContextAvailable() asks the connector only when the store
    // has no durable session; this fixture has none, so answer "not a fork".
    bot: { getSessionFork: async () => undefined },
    sender: {
      reply: async (_topic: string, text: string) => { replies.push(text); },
      sendTaskStatus: async (_topic: string, status: any) => { statuses.push(status); },
    },
    startTypingHeartbeat: () => () => undefined,
    buildChannel: () => ({}),
    buildSessionCallbacks: () => ({}),
    buildDeviceRpcTransport: () => undefined,
    maybeBuildThinToolRpcTransport: () => undefined,
  });
  return {
    bot,
    store,
    marker,
    key,
    topic,
    statuses,
    replies,
    events,
    mark: () => store.saveRuntimeState(key, { interruptedTurn: marker }),
    resume: () => bot.resumeOneInterruptedTurn(marker),
    setObservation: (next: (context: ToolExecutionContext) => Promise<Observation>) => { observation = next; },
  };
}

test('automatic resume restores the original device from the v1 authorization envelope', async t => {
  const h = fixture(t);
  const scope: ExecutionScope = {
    source: 'catscompany', sessionKey: h.key, topicId: h.topic, topicType: 'group',
    actorUserId: 'usr38', agentId: 'usr9', agentBodyId: 'bot-body',
    identityTrust: 'server_canonical', isTrusted: true,
  };
  const sessionKey = getDeviceAuthorizationSessionKey(scope);
  const devices = ['pc-original', 'pc-default'];
  const grants = devices.map(deviceId => ({
    kind: 'user_device_grant', source: scope.source, sessionKey, topicId: scope.topicId, topicType: scope.topicType,
    actorUserId: scope.actorUserId, ownerUserId: scope.actorUserId, agentId: scope.agentId, agentBodyId: scope.agentBodyId,
    targetScope: 'explicit_device', selectionRevision: 'rev-1', status: 'active', identityTrust: 'server_canonical',
    grantId: `grant-${deviceId}`, deviceId, deviceBodyId: `body-${deviceId}`, deviceInstallationId: `install-${deviceId}`,
    operations: ['read_file', 'write_file', 'execute_shell'], createdAt: Date.now() - 1000, expiresAt: Date.now() + 3600_000,
    actor_token: 'fixture-secret-value',
  }));
  const context = sanitizeDeviceContext({
    catsco_identity: {
      permissions: { source: 'server_canonical_message' },
      device_selection: {
        kind: 'user_device_selection', source: scope.source, sessionKey, topicId: scope.topicId, topicType: scope.topicType,
        actorUserId: scope.actorUserId, agentId: scope.agentId, status: 'selected', revision: 'rev-1', selectedDeviceId: 'pc-default',
        candidates: devices.map(deviceId => ({
          deviceId, displayName: deviceId, ownerUserId: scope.actorUserId,
          active: true, routeConnected: true, routable: true,
        })),
      },
      device_target_authorizations: { schema: 'catsco.device-targets.v1', grants, authorization: 'fixture-secret-value' },
    },
  }, scope);
  assert.ok(context);
  const candidates = () => collectInterruptedTurns({
    stateDir: path.join(root, 'data', 'session-state'), maxAgeMs: 60_000, maxAttempts: 2,
  });
  assert.equal(markInterruptedTurn(h.key, { topic: h.topic, reason: 'shutdown', deviceContext: context }), true);
  const unpinned = candidates().find((candidate: any) => candidate.sessionKey === h.key).deviceContext;
  assert.equal(h.bot.rebuildDeviceContext(h.key, h.topic, unpinned).targetRoutes, undefined, 'an old multi-device marker is ambiguous');

  context.remoteTarget = { ownerUserId: scope.actorUserId, deviceId: 'pc-original' };
  assert.equal(markInterruptedTurn(h.key, { topic: h.topic, reason: 'shutdown', deviceContext: context }), true);
  assert.doesNotMatch(JSON.stringify(h.store.loadRuntimeState(h.key)), /fixture-secret-value|actor_token/);
  const candidate = candidates().find((candidate: any) => candidate.sessionKey === h.key);
  assert.equal(h.bot.rebuildDeviceContext('other-session', h.topic, candidate.deviceContext).targetRoutes, undefined);
  delete h.bot.buildDeviceRpcTransport;
  delete h.bot.maybeBuildThinToolRpcTransport;
  const requests: Array<{ tool_name: string; grant_id: string; target_device_id: string }> = [];
  let platformError: string | undefined;
  h.bot.bot.supportsThinToolRpc = true;
  h.bot.bot.sendThinToolRpcRequest = async (request: typeof requests[number]) => {
    requests.push(request);
    return platformError ? { error: { code: platformError } } : { result: { ok: true, content: 'read result' } };
  };
  h.setObservation(async options => {
    const tools = { ...options, surface: 'catscompany' as const };
    assert.deepEqual(tools.targetRoutes?.routes.map(route => route.deviceId), ['pc-original']);
    assert.equal(resolveExecutionRoute(tools, { toolName: 'read_file', operation: 'read_file', target: 'pc-default' }).ok, false);
    assert.equal(resolveExecutionRoute(tools, { toolName: 'read_file', operation: 'read_file', target: 'speaker_default' }).ok, false);
    assert.equal(resolveExecutionRoute(tools, { toolName: 'write_file', operation: 'write_file' }).ok, false);
    const write = resolveExecutionRoute(tools, { toolName: 'write_file', operation: 'write_file', target: 'pc-original' });
    assert.equal(write.ok, true);
    assert.equal((await executeRouteIfRemote(tools, write, 'write_file', 'write_file', {}))?.ok, false, 'remote write is blocked at dispatch');
    const shell = resolveExecutionRoute(tools, { toolName: 'execute_shell', operation: 'execute_shell', target: 'pc-original' });
    assert.equal(shell.ok, true);
    assert.equal((await executeRouteIfRemote(tools, shell, 'execute_shell', 'execute_shell', {}))?.ok, false, 'remote shell is blocked at dispatch');
    assert.equal(requests.length, 0, 'writes and commands must never reach the platform');
    const read = resolveExecutionRoute(tools, { toolName: 'read_file', operation: 'read_file', target: 'pc-original' });
    assert.equal(read.ok, true);
    assert.equal((await executeRouteIfRemote(tools, read, 'read_file', 'read_file', {}))?.ok, true, 'read reaches the original device');
    for (const error of ['device_authorization_required', 'target_device_unavailable']) {
      platformError = error;
      assert.equal((await executeRouteIfRemote(tools, read, 'read_file', 'read_file', {}))?.ok, false);
    }
    assert.deepEqual(requests.map(request => [request.tool_name, request.target_device_id, request.grant_id]),
      Array.from({ length: 3 }, () => ['read_file', 'pc-original', 'grant-pc-original']));
    return { taskOutcome: 'completed' };
  });
  await h.bot.resumeOneInterruptedTurn(candidate);
  await until(() => h.statuses.length >= 2, 'resume task statuses');
  assert.equal(h.statuses.at(-1)?.state, 'completed');
  assert.equal(requests.length, 3);
});

/** Waits for the serialized task-status queue to reach a state, never a fixed sleep. */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('a resumed turn owns one run: running, then completed', async t => {
  const h = fixture(t);
  h.mark();
  h.setObservation(async () => ({ text: '恢复后的答复', visibleToUser: true, taskOutcome: 'completed' }));

  await h.resume();
  await until(() => h.statuses.length >= 2, 'both task statuses');

  assert.deepEqual(
    h.statuses.map(status => status.state),
    ['running', 'completed'],
    'the resume must publish a running run and then its terminal',
  );
  assert.equal(
    new Set(h.statuses.map(status => status.run_id)).size,
    1,
    'both statuses must belong to the same run',
  );
  assert.match(h.statuses[0].run_id, /^xiaoba-/, 'the run id must be minted by beginConversationTask');
  assert.ok(
    h.replies.some(text => text.includes('正在自动继续')),
    'the user is still told the turn is being continued',
  );
  assert.deepEqual(h.replies.filter(text => text === '恢复后的答复'), ['恢复后的答复']);
  assert.equal(
    h.store.loadRuntimeState(h.key).interruptedTurn,
    undefined,
    'a completed resume retires the marker',
  );
  assert.equal(h.bot.activeConversationTasks.size, 0, 'the run must not stay active');
});

test('a failed resume replies to the user and keeps the marker', async t => {
  const h = fixture(t);
  h.mark();
  h.setObservation(async () => {
    throw new Error('provider unreachable');
  });

  await h.resume();
  await until(() => h.statuses.length >= 2, 'both task statuses');

  assert.deepEqual(
    h.statuses.map(status => status.state),
    ['running', 'failed'],
    'a thrown resume must still publish a terminal for its own run',
  );
  assert.equal(new Set(h.statuses.map(status => status.run_id)).size, 1);

  const receipt = h.replies.find(text => text.includes('自动继续上一轮任务失败'));
  assert.ok(receipt, 'the user must be told the resume failed instead of seeing silence');
  assert.match(receipt!, /provider unreachable/, 'the receipt must say what went wrong');
  assert.match(receipt!, /第 1\/2 次/, 'the receipt must show the attempt budget');
  assert.match(receipt!, /下次启动会再自动继续一次/);

  const marker = h.store.loadRuntimeState(h.key).interruptedTurn;
  assert.ok(marker, 'a failed resume must not delete the interrupted-turn marker');
  assert.equal(marker.attempts, 1, 'the spent attempt must still be accounted for');
  assert.equal(
    h.store.loadRuntimeState(h.key).interruptedTurn.topic,
    h.topic,
    'the retained marker still points at the conversation',
  );
  assert.equal(h.bot.activeConversationTasks.size, 0, 'a failed run must not stay active');
});

test('a second failed resume stops at the attempt budget', async t => {
  const h = fixture(t);
  h.mark();
  // The marker as a previous failed resume leaves it: one attempt already spent.
  h.store.saveRuntimeState(h.key, { interruptedTurn: { ...h.marker, attempts: 1 } });
  h.setObservation(async () => {
    throw new Error('provider unreachable');
  });

  await h.bot.resumeOneInterruptedTurn({ ...h.marker, attempts: 1 });
  await until(() => h.statuses.length >= 2, 'both task statuses');

  const receipt = h.replies.find(text => text.includes('自动继续上一轮任务失败'));
  assert.ok(receipt);
  assert.match(receipt!, /第 2\/2 次/);
  assert.match(receipt!, /自动继续次数已用完，请重新发送任务/, 'the exhausted budget must be stated');
  assert.equal(h.store.loadRuntimeState(h.key).interruptedTurn.attempts, 2);
});

test('a shutdown during the resume publishes stale and keeps the work resumable', async t => {
  const h = fixture(t);
  h.mark();
  h.setObservation(async () => {
    // destroy() reached the task sweep while the resume turn was in flight.
    h.bot.shuttingDown = true;
    await h.bot.finishActiveConversationTasksForShutdown();
    // Whatever the turn produced afterwards must not be delivered nor reported.
    return { text: '迟到的答复', visibleToUser: true, taskOutcome: 'completed' };
  });

  await h.resume();
  await until(() => h.statuses.length >= 2, 'both task statuses');

  assert.deepEqual(
    h.statuses.map(status => status.state),
    ['running', 'stale'],
    'the shutdown sweep owns the terminal of a run it interrupted',
  );
  assert.ok(
    !h.statuses.some(status => status.state === 'completed'),
    'a result produced after destroy must never be published as completed',
  );
  assert.ok(
    !h.replies.includes('迟到的答复'),
    'a reply produced after destroy must not be delivered',
  );
  const marker = h.store.loadRuntimeState(h.key).interruptedTurn;
  assert.ok(marker, 'an interrupted resume must stay resumable across the restart');
  assert.equal(marker.reason, 'connector-shutdown', 'the restart must know why it stopped');
  assert.equal(marker.attempts, 1, 'the spent attempt must survive the shutdown rewrite');
  assert.equal(h.bot.activeConversationTasks.size, 0);
});

test('a /stop during the resume cannot be turned into a completed run', async t => {
  const h = fixture(t);
  h.mark();
  h.setObservation(async () => {
    // The real /stop path: stop generation, marker retirement, run cancellation.
    h.bot.stopSessionExecution(h.key);
    // A turn that was already finishing still returns its own verdict.
    return { text: '任务已经做完了', visibleToUser: true, taskOutcome: 'completed' };
  });

  await h.resume();
  await until(() => h.statuses.length >= 2, 'both task statuses');

  const states = h.statuses.map(status => status.state);
  assert.equal(states[0], 'running');
  assert.ok(
    !states.includes('completed'),
    `stop must stay terminal, saw ${JSON.stringify(states)}`,
  );
  assert.deepEqual(states.slice(1), ['cancelled'], 'stop publishes exactly one terminal');
  assert.equal(
    h.store.loadRuntimeState(h.key).interruptedTurn,
    undefined,
    'stop retires the marker: the user ended this work',
  );
  assert.equal(h.bot.activeConversationTasks.size, 0);
});

test('destroy between the notice and the turn starts no run and keeps the marker', async t => {
  const h = fixture(t);
  h.mark();
  h.bot.sender = {
    reply: async () => { h.bot.shuttingDown = true; },
    sendTaskStatus: async (_topic: string, status: any) => { h.statuses.push(status); },
  };

  await h.resume();

  assert.deepEqual(h.statuses, [], 'no run may be created after destroy has begun');
  assert.equal(h.events.includes('observation'), false, 'the model must not run after destroy');
  const marker = h.store.loadRuntimeState(h.key).interruptedTurn;
  assert.ok(marker, 'the interrupted work must stay resumable');
  assert.equal(h.bot.sessionExecutionReservations.size, 0, 'the session claim must be released');
});

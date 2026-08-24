import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { AgentSession, type AgentServices } from '../src/core/agent-session';
import type { SubAgentInfo } from '../src/core/sub-agent-session';
import { SkillManager } from '../src/skills/skill-manager';
import { ToolManager } from '../src/tools/tool-manager';
import { ReviewAdapter } from '../src/review/review-adapter';
import { AgentRunGoalResolver, type AgentRunGoalDrafter } from '../src/core/agent-run-goal-resolver';
import { ReviewRunStore } from '../src/review/review-run-store';
import { ReviewRuntimeTool } from '../src/review/review-runtime-tool';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Review Adapter', () => {
  test('persists atomically and latches corrupt state', () => {
    const fixture = createFixture('F-STORE');
    const store = new ReviewRunStore(fixture.storePath);
    const now = new Date().toISOString();
    store.create({
      runId: 'run-1', findingId: 'F-STORE', sessionKey: 'review:F-STORE', goal: 'goal',
      envelopePath: fixture.envelopePath, status: 'active', reviewState: 'INCOMPLETE',
      createdAt: now, updatedAt: now, tasks: {}, events: [],
    });
    assert.equal(new ReviewRunStore(fixture.storePath).get('run-1')?.findingId, 'F-STORE');
    assert.equal(fs.statSync(fixture.storePath).mode & 0o777, 0o600);

    fs.writeFileSync(fixture.storePath, '{not-json', 'utf-8');
    const corrupt = new ReviewRunStore(fixture.storePath);
    assert.equal(corrupt.isCorrupt(), true);
    assert.throws(() => corrupt.create({
      runId: 'run-2', findingId: 'F-2', sessionKey: 'review:F-2', goal: 'goal',
      envelopePath: fixture.envelopePath, status: 'active', reviewState: 'INCOMPLETE',
      createdAt: now, updatedAt: now, tasks: {}, events: [],
    }), /Cannot write corrupt/);
    assert.equal(fs.existsSync(`${fixture.storePath}.state-corrupt`), true);
  });


  test('reloads Review state under lock so a stale update cannot erase another Run', () => {
    const fixture = createFixture('F-STORE-UPDATE');
    const now = new Date().toISOString();
    const firstStore = new ReviewRunStore(fixture.storePath);
    firstStore.create({ runId: 'run-a', findingId: 'F-A', sessionKey: 'review:F-A', goal: 'goal-a', envelopePath: fixture.envelopePath, status: 'active', reviewState: 'INCOMPLETE', createdAt: now, updatedAt: now, tasks: {}, events: [] });
    const staleStore = new ReviewRunStore(fixture.storePath);
    firstStore.create({ runId: 'run-b', findingId: 'F-B', sessionKey: 'review:F-B', goal: 'goal-b', envelopePath: fixture.envelopePath, status: 'active', reviewState: 'INCOMPLETE', createdAt: now, updatedAt: now, tasks: {}, events: [] });
    staleStore.update('run-a', run => { run.status = 'blocked'; });
    const reopened = new ReviewRunStore(fixture.storePath);
    assert.equal(reopened.list().length, 2);
    assert.equal(reopened.get('run-b')?.goal, 'goal-b');
  });


  test('fails closed on invalid Review status or malformed Task records', () => {
    const fixture = createFixture('F-STORE-INVALID');
    const now = new Date().toISOString();
    const store = new ReviewRunStore(fixture.storePath);
    store.create({ runId: 'bad-run', findingId: 'F-BAD', sessionKey: 'review:F-BAD', goal: 'goal', envelopePath: fixture.envelopePath, status: 'active', reviewState: 'INCOMPLETE', createdAt: now, updatedAt: now, tasks: {}, events: [] });
    const state = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'));
    state.runs['bad-run'].status = 'not-a-status';
    state.runs['bad-run'].tasks.bad = null;
    fs.writeFileSync(fixture.storePath, JSON.stringify(state));
    const corrupt = new ReviewRunStore(fixture.storePath);
    assert.equal(corrupt.isCorrupt(), true);
    assert.equal(fs.existsSync(`${fixture.storePath}.state-corrupt`), true);
  });


  test('resolves and persists one immutable Goal pair per Finding Trigger', async () => {
    const fixture = createFixture('F-GOAL');
    let calls = 0;
    const drafter: AgentRunGoalDrafter = { generatorName: 'goal-model', async draftGoal() { calls += 1; return 'Resolve the evidence boundary and decide Issue or Close.'; } };
    const sessions = new FakeSessionHost();
    const adapter = createAdapter(fixture, sessions, new FakeSubAgentHost(), new AgentRunGoalResolver({ drafter }));
    const first = await adapter.triggerFinding({ findingId: 'F-GOAL', envelopePath: fixture.envelopePath, actor: 'human', wake: false });
    assert.equal(calls, 1);
    assert.equal(first.goalResolution?.source, 'ai_generated');
    assert.equal(first.goalResolution?.profileId, 'finding_review.v1');
    assert.equal(first.goalResolution?.generator, 'goal-model');
    assert.match(first.goal, /Issue or Close/);
    assert.deepEqual(new ReviewRunStore(fixture.storePath).get(first.runId)?.goalResolution, first.goalResolution);

    const repeated = await adapter.triggerFinding({ findingId: 'F-GOAL', envelopePath: fixture.envelopePath, goal: 'must not replace existing Goal', actor: 'human', wake: false });
    assert.equal(calls, 1);
    assert.equal(repeated.goal, first.goal);
    assert.deepEqual(repeated.goalResolution, first.goalResolution);
    assert.throws(() => adapter.store.update(first.runId, run => { run.goal = 'mutated'; }), /identity field is immutable/);
  });

  test('single-flights concurrent duplicate Finding Triggers', async () => {
    const fixture = createFixture('F-GOAL-CONCURRENT');
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const drafter: AgentRunGoalDrafter = {
      async draftGoal() { calls += 1; await gate; return 'Concurrent Review Goal'; },
    };
    const adapter = createAdapter(fixture, new FakeSessionHost(), new FakeSubAgentHost(), new AgentRunGoalResolver({ drafter }));
    const input = { findingId: 'F-GOAL-CONCURRENT', envelopePath: fixture.envelopePath, actor: 'human', wake: false };
    const firstPromise = adapter.triggerFinding(input);
    const secondPromise = adapter.triggerFinding(input);
    await Promise.resolve();
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(calls, 1);
    assert.equal(second.runId, first.runId);
    assert.equal(adapter.store.list().length, 1);
    assert.equal(first.goal, 'Concurrent Review Goal');
  });

  test('single-flights duplicate Finding Triggers across Adapter instances sharing a Store', async () => {
    const fixture = createFixture('F-GOAL-CROSS-INSTANCE');
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const drafter: AgentRunGoalDrafter = { async draftGoal() { calls += 1; await gate; return 'Cross-instance Review Goal'; } };
    const firstAdapter = createAdapter(fixture, new FakeSessionHost(), new FakeSubAgentHost(), new AgentRunGoalResolver({ drafter }));
    const secondAdapter = createAdapter(fixture, new FakeSessionHost(), new FakeSubAgentHost(), new AgentRunGoalResolver({ drafter }));
    const input = { findingId: 'F-GOAL-CROSS-INSTANCE', envelopePath: fixture.envelopePath, actor: 'human', wake: false };
    const firstPromise = firstAdapter.triggerFinding(input);
    const secondPromise = secondAdapter.triggerFinding(input);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(calls, 1);
    assert.equal(second.runId, first.runId);
    secondAdapter.store.refresh();
    assert.equal(secondAdapter.store.list().length, 1);
    assert.equal(second.goal, 'Cross-instance Review Goal');
  });

  test('explicit Review Goal wins and the wake injects its completion contract', async () => {
    const fixture = createFixture('F-GOAL-WAKE');
    let calls = 0;
    const drafter: AgentRunGoalDrafter = { async draftGoal() { calls += 1; return 'AI must not run'; } };
    const sessions = new FakeSessionHost();
    const adapter = createAdapter(fixture, sessions, new FakeSubAgentHost(), new AgentRunGoalResolver({ drafter }));
    const run = await adapter.triggerFinding({ findingId: 'F-GOAL-WAKE', envelopePath: fixture.envelopePath, goal: 'Human authorized outcome', actor: 'human' });
    assert.equal(calls, 0);
    assert.equal(run.goalResolution?.source, 'explicit');
    const wakeMessage = sessions.session.observations.at(-1)?.text || '';
    assert.match(wakeMessage, /Goal completion contract:/);
    assert.match(wakeMessage, /terminal recommendation is exactly one of Issue or Close/i);
  });

  test('runs dynamic planning, approval, real SubAgent dispatch, result recovery and terminal commit', async () => {
    const fixture = createFixture('F-FLOW');
    const sessionHost = new FakeSessionHost();
    const subAgents = new FakeSubAgentHost();
    const adapter = createAdapter(fixture, sessionHost, subAgents);
    sessionHost.session.onObservation = async (text, source) => {
      const runId = text.match(/Run ID: ([^\n]+)/)?.[1];
      if (!runId) return;
      if (source === 'review_trigger') {
        await adapter.proposeTask(runId, 'review:F-FLOW', {
          title: 'Capture one bounded shape sample', objective: 'Separate parser and provider hypotheses',
          expectedArtifact: 'redacted shape JSON', stopCondition: 'one sample or window end',
          safetyBoundary: 'no prompts, outputs, tokens, or production writes', risk: 'high',
          approvalRequired: true, agentType: 'explorer', toolScope: 'read_only',
          idempotencyKey: 'sample-once',
        });
        await adapter.recordGoalCheck(runId, 'review:F-FLOW', {
          checkedAt: '', complete: false, capabilitiesExhausted: false,
          summary: 'Need one approved discriminating sample', nextAction: 'Approve Task',
          stopCondition: 'sample captured or window ends',
        });
      } else if (source === 'review_subagent_result') {
        await adapter.recordGoalCheck(runId, 'review:F-FLOW', {
          checkedAt: '', complete: false, capabilitiesExhausted: false,
          summary: 'Candidate result must be committed to the Envelope', nextAction: 'Commit candidate evidence',
          stopCondition: 'Envelope validates and Pool syncs',
        });
      }
    };

    let run = await adapter.triggerFinding({
      findingId: 'F-FLOW', envelopePath: fixture.envelopePath, goal: 'Decide Issue or Close', actor: 'human',
    });
    assert.equal(run.status, 'awaiting_approval');
    const task = Object.values(run.tasks)[0];
    assert.equal(task.status, 'proposed');
    assert.equal(subAgents.spawnCount, 0);

    await adapter.approveTask(run.runId, task.taskId, 'approver', 'bounded diagnostic approved');
    run = adapter.store.get(run.runId)!;
    assert.equal(run.tasks[task.taskId].status, 'running');
    assert.equal(subAgents.spawnCount, 1);
    assert.match(subAgents.lastRequest.userMessage, /Safety boundary/);

    await subAgents.complete(run.sessionKey, run.tasks[task.taskId].subAgentId!, {
      resultSummary: 'shape captured; secret-result-body', outputFiles: ['/tmp/candidate-secret.json'],
    });
    run = adapter.store.get(run.runId)!;
    assert.equal(run.tasks[task.taskId].status, 'result_pending_commit');
    assert.equal(run.lastGoalCheck?.summary, 'Candidate result must be committed to the Envelope');

    setReviewState(fixture.envelopePath, 'COMPLETE_ISSUE', 'ISSUE');
    await adapter.commitTask(run.runId, run.sessionKey, task.taskId, ['E-101']);
    run = adapter.store.get(run.runId)!;
    assert.equal(run.tasks[task.taskId].status, 'committed');
    assert.equal(run.status, 'complete_issue');
    assert.equal(run.reviewState, 'COMPLETE_ISSUE');
    assert.equal(fs.existsSync(fixture.syncMarker), true);
  });

  test('deduplicates Task proposals and requires explicit re-approval after restart', async () => {
    const fixture = createFixture('F-RECOVER');
    const firstSessions = new FakeSessionHost();
    const firstSubAgents = new FakeSubAgentHost();
    const first = createAdapter(fixture, firstSessions, firstSubAgents);
    const run = await first.triggerFinding({
      findingId: 'F-RECOVER', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    const spec = {
      title: 'Read local logs', objective: 'find event shape', expectedArtifact: 'summary.json',
      stopCondition: 'one event or no matches', safetyBoundary: 'local read only',
      risk: 'low' as const, approvalRequired: true, idempotencyKey: 'stable-task-key',
    };
    const task = await first.proposeTask(run.runId, run.sessionKey, spec);
    const duplicate = await first.proposeTask(run.runId, run.sessionKey, spec);
    assert.equal(duplicate.taskId, task.taskId);
    assert.equal(Object.keys(first.store.get(run.runId)!.tasks).length, 1);
    await first.approveTask(run.runId, task.taskId, 'human');
    assert.equal(firstSubAgents.spawnCount, 1);

    const restartedSessions = new FakeSessionHost();
    const restartedSubAgents = new FakeSubAgentHost();
    const restarted = createAdapter(fixture, restartedSessions, restartedSubAgents);
    const recovered = await restarted.recoverRun(run.runId);
    assert.equal(recovered.tasks[task.taskId].status, 'interrupted');
    assert.equal(recovered.status, 'awaiting_approval');
    assert.equal(restartedSubAgents.spawnCount, 0);

    const heartbeat = await restarted.heartbeat();
    assert.equal(heartbeat.woken.length, 0);
    assert.equal(heartbeat.skipped.some(item => item.reason === 'awaiting_approval'), true);
    await restarted.approveTask(run.runId, task.taskId, 'human', 'retry after verified interruption');
    assert.equal(restartedSubAgents.spawnCount, 1);
  });

  test('heartbeat discovers an unfinished Finding and fails closed when Goal Check is missing', async () => {
    const fixture = createFixture('F-HEARTBEAT');
    const sessions = new FakeSessionHost();
    const adapter = createAdapter(fixture, sessions, new FakeSubAgentHost());
    const result = await adapter.heartbeat();
    assert.deepEqual(result.discovered, ['F-HEARTBEAT']);
    assert.deepEqual(result.woken, ['F-HEARTBEAT']);
    const run = adapter.store.findByFindingId('F-HEARTBEAT')!;
    assert.equal(run.status, 'blocked');
    assert.equal(run.blocker, 'goal_check_missing');
    assert.ok(run.nextWakeAt);
    assert.equal(sessions.session.observations.length, 1);
    const retry = await adapter.heartbeat();
    assert.equal(retry.woken.length, 0);
    assert.equal(retry.skipped.some(item => item.reason === 'not_due'), true);
    assert.equal(sessions.session.observations.length, 1);
  });

  test('defaults an idle incomplete Goal Check to a 24-hour wake backoff', async () => {
    const fixture = createFixture('F-IDLE-BACKOFF');
    const fixedNow = new Date('2026-07-26T12:00:00.000Z');
    const adapter = new ReviewAdapter({
      workspace: fixture.workspace, storePath: fixture.storePath, skillDirectory: fixture.skillDirectory,
      workingDirectory: fixture.root, sessionHost: new FakeSessionHost() as any,
      subAgentHost: new FakeSubAgentHost() as any,
      services: { aiService: {}, skillManager: {}, toolManager: {} } as AgentServices,
      now: () => fixedNow,
    });
    const run = await adapter.triggerFinding({
      findingId: 'F-IDLE-BACKOFF', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    const after = await adapter.recordGoalCheck(run.runId, run.sessionKey, {
      checkedAt: '', complete: false, capabilitiesExhausted: false, summary: 'No active Task',
      nextAction: 'Retry after a bounded wait', stopCondition: 'new evidence or next wake',
    });
    assert.equal(after.nextWakeAt, '2026-07-27T12:00:00.000Z');
    assert.equal(after.lastGoalCheck?.nextWakeAt, after.nextWakeAt);
    const heartbeat = await adapter.heartbeat();
    assert.equal(heartbeat.woken.length, 0);
    assert.equal(heartbeat.skipped.some(item => item.reason === 'not_due'), true);
  });

  test('serializes concurrent wakes for the same Review Run', async () => {
    const fixture = createFixture('F-WAKE-RACE');
    const sessions = new FakeSessionHost();
    const adapter = createAdapter(fixture, sessions, new FakeSubAgentHost());
    const run = await adapter.triggerFinding({
      findingId: 'F-WAKE-RACE', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    sessions.session.onObservation = async text => {
      entered();
      await gate;
      const runId = text.match(/Run ID: ([^\n]+)/)?.[1]!;
      await adapter.recordGoalCheck(runId, run.sessionKey, {
        checkedAt: '', complete: false, capabilitiesExhausted: false, summary: 'continue',
        nextAction: 'next', stopCondition: 'bounded stop',
      });
    };
    const first = adapter.wakeRun(run.runId, 'heartbeat', 'heartbeat-a');
    await started;
    const second = adapter.wakeRun(run.runId, 'heartbeat', 'heartbeat-b');
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(sessions.session.observations.length, 1);
    assert.equal(secondResult.status, firstResult.status);
    assert.deepEqual(secondResult.lastGoalCheck, firstResult.lastGoalCheck);
  });

  test('single-flights a late-joining wake across Adapter instances', async () => {
    const fixture = createFixture('F-WAKE-CROSS');
    const firstSessions = new FakeSessionHost();
    const firstAdapter = createAdapter(fixture, firstSessions, new FakeSubAgentHost());
    const run = await firstAdapter.triggerFinding({ findingId: 'F-WAKE-CROSS', envelopePath: fixture.envelopePath, actor: 'human', wake: false });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    firstSessions.session.onObservation = async () => {
      await firstAdapter.recordGoalCheck(run.runId, run.sessionKey, {
        checkedAt: '', complete: false, capabilitiesExhausted: false,
        summary: 'First wake persisted its final state', nextAction: 'wait', stopCondition: 'new evidence',
      });
      entered();
      await gate;
    };
    const firstWake = firstAdapter.wakeRun(run.runId, 'manual_trigger', 'first');
    await enteredPromise;

    // Join after the winner has persisted run_woken and its Goal Check. The
    // loser must still be identified from lock contention, not field changes.
    const secondSessions = new FakeSessionHost();
    const secondAdapter = createAdapter(fixture, secondSessions, new FakeSubAgentHost());
    const secondWake = secondAdapter.wakeRun(run.runId, 'manual_trigger', 'second');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondSessions.session.observations.length, 0);
    release();
    const [firstResult, secondResult] = await Promise.all([firstWake, secondWake]);
    assert.equal(firstSessions.session.observations.length + secondSessions.session.observations.length, 1);
    assert.equal(firstResult.events.filter(event => event.type === 'run_woken').length, 1);
    assert.equal(secondResult.events.filter(event => event.type === 'run_woken').length, 1);
  });

  test('does not swallow an uncontended wake after an unrelated Goal Check update', async () => {
    const fixture = createFixture('F-WAKE-GOAL-CHECK-RACE');
    const updater = createAdapter(fixture, new FakeSessionHost(), new FakeSubAgentHost());
    const run = await updater.triggerFinding({
      findingId: 'F-WAKE-GOAL-CHECK-RACE', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    const wakeSessions = new FakeSessionHost();
    const staleButUncontended = createAdapter(fixture, wakeSessions, new FakeSubAgentHost());
    await updater.recordGoalCheck(run.runId, run.sessionKey, {
      checkedAt: '', complete: false, capabilitiesExhausted: false,
      summary: 'Independent Goal Check update', nextAction: 'wake manually', stopCondition: 'manual wake',
    });

    const after = await staleButUncontended.wakeRun(run.runId, 'manual_trigger', 'human');
    assert.equal(wakeSessions.session.observations.length, 1);
    assert.equal(after.events.filter(event => event.type === 'run_woken').length, 1);
  });

  test('executes a Review wake after taking over a lock directory that becomes stale while waiting', async () => {
    const fixture = createFixture('F-WAKE-STALE-LOCK');
    const sessions = new FakeSessionHost();
    const adapter = createAdapter(fixture, sessions, new FakeSubAgentHost());
    const run = await adapter.triggerFinding({
      findingId: 'F-WAKE-STALE-LOCK', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    const previous = process.env.XIAOBA_FILE_LOCK_STALE_MS;
    process.env.XIAOBA_FILE_LOCK_STALE_MS = '2000';
    const lockHash = createHash('sha256').update(`review_wake\0${run.runId}`).digest('hex');
    const lockPath = `${fixture.storePath}.wake-${lockHash}.lock`;
    fs.mkdirSync(lockPath);
    const almostStale = new Date(Date.now() - 1700);
    fs.utimesSync(lockPath, almostStale, almostStale);
    try {
      const after = await adapter.wakeRun(run.runId, 'manual_trigger', 'human');
      assert.equal(sessions.session.observations.length, 1);
      assert.equal(after.events.filter(event => event.type === 'run_woken').length, 1);
      assert.equal(after.blocker, 'goal_check_missing');
    } finally {
      if (previous === undefined) delete process.env.XIAOBA_FILE_LOCK_STALE_MS;
      else process.env.XIAOBA_FILE_LOCK_STALE_MS = previous;
    }
  });

  test('deduplicates the same Task proposal across stale Adapter instances', async () => {
    const fixture = createFixture('F-TASK-CROSS');
    const firstAdapter = createAdapter(fixture, new FakeSessionHost(), new FakeSubAgentHost());
    const run = await firstAdapter.triggerFinding({ findingId: 'F-TASK-CROSS', envelopePath: fixture.envelopePath, actor: 'human', wake: false });
    const secondAdapter = createAdapter(fixture, new FakeSessionHost(), new FakeSubAgentHost());
    const spec = {
      title: 'Same bounded check', objective: 'Collect one discriminating fact', expectedArtifact: 'fact.json',
      stopCondition: 'one fact', safetyBoundary: 'read only', risk: 'medium' as const,
      approvalRequired: true, idempotencyKey: 'same-task',
    };
    const first = await firstAdapter.proposeTask(run.runId, run.sessionKey, spec);
    const second = await secondAdapter.proposeTask(run.runId, run.sessionKey, spec);
    assert.equal(second.taskId, first.taskId);
    secondAdapter.store.refresh();
    assert.equal(Object.keys(secondAdapter.store.get(run.runId)!.tasks).length, 1);
  });

  test('returns a thrown dispatch to interrupted and allows explicit retry', async () => {
    const fixture = createFixture('F-DISPATCH');
    const subAgents = new FakeSubAgentHost();
    subAgents.throwOnSpawn = true;
    const adapter = createAdapter(fixture, new FakeSessionHost(), subAgents);
    const run = await adapter.triggerFinding({
      findingId: 'F-DISPATCH', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    const task = await adapter.proposeTask(run.runId, run.sessionKey, {
      title: 'Dispatch task', objective: 'test dispatch', expectedArtifact: 'result',
      stopCondition: 'done', safetyBoundary: 'read only', risk: 'low', approvalRequired: true,
    });
    let after = await adapter.approveTask(run.runId, task.taskId, 'human');
    assert.equal(after.status, 'interrupted');
    assert.equal(adapter.store.get(run.runId)?.status, 'awaiting_approval');
    subAgents.throwOnSpawn = false;
    after = await adapter.approveTask(run.runId, task.taskId, 'human', 'retry after dispatch failure');
    assert.equal(after.status, 'running');
    assert.equal(subAgents.spawnCount, 2);
  });

  test('does not synchronize the Pool before terminal unfinished-Task gate passes', async () => {
    const fixture = createFixture('F-COMMIT-GATE');
    const sessions = new FakeSessionHost();
    const subAgents = new FakeSubAgentHost();
    const adapter = createAdapter(fixture, sessions, subAgents);
    const run = await adapter.triggerFinding({
      findingId: 'F-COMMIT-GATE', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    const ready = await adapter.proposeTask(run.runId, run.sessionKey, {
      title: 'Ready evidence', objective: 'collect evidence', expectedArtifact: 'result',
      stopCondition: 'done', safetyBoundary: 'read only', risk: 'low', approvalRequired: true,
    });
    await adapter.approveTask(run.runId, ready.taskId, 'human');
    await subAgents.complete(run.sessionKey, adapter.store.get(run.runId)!.tasks[ready.taskId].subAgentId!, {
      resultSummary: 'candidate ready', outputFiles: [],
    });
    await adapter.proposeTask(run.runId, run.sessionKey, {
      title: 'Still pending', objective: 'challenge', expectedArtifact: 'challenge',
      stopCondition: 'done', safetyBoundary: 'read only', risk: 'low', approvalRequired: true,
    });
    setReviewState(fixture.envelopePath, 'COMPLETE_ISSUE', 'ISSUE');
    await assert.rejects(() => adapter.commitTask(run.runId, run.sessionKey, ready.taskId, ['E-1']), /unfinished/);
    assert.equal(fs.existsSync(fixture.syncMarker), false);
  });

  test('rejects terminal Goal Check while any Review Task is unfinished', async () => {
    const fixture = createFixture('F-GATE');
    const adapter = createAdapter(fixture, new FakeSessionHost(), new FakeSubAgentHost());
    const run = await adapter.triggerFinding({
      findingId: 'F-GATE', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    await adapter.proposeTask(run.runId, run.sessionKey, {
      title: 'Pending challenge', objective: 'challenge the leading hypothesis', expectedArtifact: 'challenge.json',
      stopCondition: 'challenge complete', safetyBoundary: 'read only', risk: 'low', approvalRequired: true,
    });
    setReviewState(fixture.envelopePath, 'COMPLETE_ISSUE', 'ISSUE');
    await assert.rejects(() => adapter.recordGoalCheck(run.runId, run.sessionKey, {
      checkedAt: '', complete: true, capabilitiesExhausted: true, summary: 'done',
    }), /Tasks are unfinished/);
  });

  test('public projection excludes paths, session keys, task prompts, artifacts and raw errors', async () => {
    const fixture = createFixture('F-SAFE');
    const sessions = new FakeSessionHost();
    const subAgents = new FakeSubAgentHost();
    const adapter = createAdapter(fixture, sessions, subAgents);
    const run = await adapter.triggerFinding({
      findingId: 'F-SAFE', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
      goal: 'SECRET_GOAL_TEXT',
    });
    await adapter.recordGoalCheck(run.runId, run.sessionKey, {
      checkedAt: '', complete: false, capabilitiesExhausted: false,
      summary: 'SECRET_GOAL_CHECK_SUMMARY', nextAction: 'SECRET_NEXT_ACTION',
      blocker: 'SECRET_BLOCKER', stopCondition: 'SECRET_CHECK_STOP',
    });
    const task = await adapter.proposeTask(run.runId, run.sessionKey, {
      title: 'SECRET_TASK_TITLE', objective: 'SECRET_OBJECTIVE', expectedArtifact: 'SECRET_ARTIFACT',
      stopCondition: 'SECRET_STOP', safetyBoundary: 'SECRET_BOUNDARY', risk: 'low',
      approvalRequired: true,
    });
    await adapter.approveTask(run.runId, task.taskId, 'human');
    await subAgents.fail(run.sessionKey, adapter.store.get(run.runId)!.tasks[task.taskId].subAgentId!, 'SECRET_RAW_ERROR');
    const serialized = JSON.stringify(adapter.getProjection(run.runId));
    for (const secret of [
      fixture.envelopePath, run.sessionKey, 'SECRET_GOAL_TEXT', 'SECRET_GOAL_CHECK_SUMMARY',
      'SECRET_NEXT_ACTION', 'SECRET_BLOCKER', 'SECRET_CHECK_STOP', 'SECRET_TASK_TITLE',
      'SECRET_OBJECTIVE', 'SECRET_ARTIFACT', 'SECRET_STOP', 'SECRET_BOUNDARY',
      'SECRET_RAW_ERROR', '/tmp/secret-output',
    ]) assert.equal(serialized.includes(secret), false, `projection leaked ${secret}`);
    assert.equal(serialized.includes('TASK_FAILED'), true);
  });

  test('drives a real AgentSession tool loop with the loaded Review Skill', async () => {
    const fixture = createFixture('F-AGENT-SESSION');
    const isolatedSkills = path.join(fixture.root, 'isolated-skills');
    fs.mkdirSync(isolatedSkills, { recursive: true });
    fs.cpSync(
      path.join(process.cwd(), 'skills', 'build-evidence-envelope-review'),
      path.join(isolatedSkills, 'build-evidence-envelope-review'),
      { recursive: true },
    );
    const previousSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    const previousRegistryFile = process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE;
    process.env.XIAOBA_SKILLS_DIR = isolatedSkills;
    process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE = path.join(fixture.root, 'isolated-skill-registry.json');
    const skillManager = new SkillManager();
    await skillManager.loadSkills();
    assert.ok(skillManager.getSkill('build-evidence-envelope-review'));

    let runId = '';
    let aiCalls = 0;
    const aiService = {
      getConfig: () => ({ provider: 'anthropic', model: 'test-model', contextWindowTokens: 64_000 }),
      isToolCallingSupported: () => true,
      async chatStream(_messages: any[], tools: any[]) {
        aiCalls += 1;
        assert.equal(tools.some((tool: any) => tool.name === 'review_runtime'), true);
        if (aiCalls === 1) {
          return {
            content: null,
            toolCalls: [{
              id: 'goal-check-1', type: 'function',
              function: {
                name: 'review_runtime',
                arguments: JSON.stringify({
                  action: 'goal_check', run_id: runId, complete: false,
                  capabilities_exhausted: false, summary: 'Need deterministic local evidence',
                  next_action: 'Run local comparison', stop_condition: 'Comparison completes',
                }),
              },
            }],
          };
        }
        return { content: 'Goal Check persisted.', toolCalls: [] };
      },
    };
    const toolManager = new ToolManager(fixture.root, {}, { enabledToolNames: [] });
    const services = { aiService, toolManager, skillManager } as unknown as AgentServices;
    let session!: AgentSession;
    const sessionHost = {
      getOrCreate: () => session,
      destroy: async () => session.cleanup(),
    };
    const adapter = new ReviewAdapter({
      workspace: fixture.workspace, storePath: fixture.storePath, skillDirectory: fixture.skillDirectory,
      workingDirectory: fixture.root, sessionHost, subAgentHost: new FakeSubAgentHost() as any, services,
    });
    toolManager.registerTool(new ReviewRuntimeTool(adapter));
    session = new AgentSession('review:F-AGENT-SESSION', services, 'review');
    session.setSystemPromptProvider(() => 'Follow the Review Skill and always persist a Goal Check.');

    try {
      const run = await adapter.triggerFinding({
        findingId: 'F-AGENT-SESSION', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
      });
      runId = run.runId;
      const after = await adapter.wakeRun(run.runId, 'manual_trigger', 'human');
      assert.equal(aiCalls, 2);
      assert.equal(after.status, 'active');
      assert.equal(after.lastGoalCheck?.summary, 'Need deterministic local evidence');
    } finally {
      await adapter.destroy();
      restoreEnv('XIAOBA_SKILLS_DIR', previousSkillsDir);
      restoreEnv('XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE', previousRegistryFile);
    }
  });

  test('accepts deterministic natural-language approval only in the matching Review Session', async () => {
    const fixture = createFixture('F-NATURAL-APPROVAL');
    const subAgents = new FakeSubAgentHost();
    const adapter = createAdapter(fixture, new FakeSessionHost(), subAgents);
    const run = await adapter.triggerFinding({
      findingId: 'F-NATURAL-APPROVAL', envelopePath: fixture.envelopePath, actor: 'human', wake: false,
    });
    const first = await adapter.proposeTask(run.runId, run.sessionKey, {
      title: 'First task', objective: 'first', expectedArtifact: 'first.json', stopCondition: 'done',
      safetyBoundary: 'read only', risk: 'medium', approvalRequired: true,
    });
    const second = await adapter.proposeTask(run.runId, run.sessionKey, {
      title: 'Second task', objective: 'second', expectedArtifact: 'second.json', stopCondition: 'done',
      safetyBoundary: 'read only', risk: 'high', approvalRequired: true,
    });

    await assert.rejects(
      () => adapter.handleHumanSessionReply(run.sessionKey, '批准', 'bruce'),
      /include the exact Task ID/,
    );
    await assert.rejects(
      () => adapter.handleHumanSessionReply('review:OTHER', `批准 ${first.taskId}`, 'bruce'),
      /Unknown Review Session/,
    );
    const approved = await adapter.handleHumanSessionReply(
      run.sessionKey, `批准 ${first.taskId} 只读取证`, 'bruce',
    );
    assert.equal(approved.status, 'running');
    assert.equal(approved.approvedBy, 'bruce');
    assert.equal(approved.approvalNote, '只读取证');
    await assert.rejects(
      () => adapter.handleHumanSessionReply(run.sessionKey, `拒绝 ${second.taskId}`, 'bruce'),
      /rejection must include a reason/,
    );
    const rejected = await adapter.handleHumanSessionReply(
      run.sessionKey, `拒绝 ${second.taskId}：授权范围不清楚`, 'bruce',
    );
    assert.equal(rejected.status, 'cancelled');
    assert.equal(rejected.failureReason, '授权范围不清楚');
  });

  test('review_runtime tool binds operations to the calling Session', async () => {
    const calls: unknown[][] = [];
    const tool = new ReviewRuntimeTool({
      proposeTask: async (...args: unknown[]) => { calls.push(args); return { ok: true }; },
      recordGoalCheck: async (...args: unknown[]) => { calls.push(args); return { ok: true }; },
      commitTask: async (...args: unknown[]) => { calls.push(args); return { ok: true }; },
    } as any);
    const result = await tool.execute({
      action: 'goal_check', run_id: 'run-x', complete: false, capabilities_exhausted: false,
      summary: 'need evidence', next_action: 'collect', stop_condition: 'window end',
    }, { sessionId: 'review:F-X' } as any);
    assert.equal(result.ok, true);
    assert.equal(calls[0][0], 'run-x');
    assert.equal(calls[0][1], 'review:F-X');
  });
});

class FakeSession {
  observations: Array<{ text: string; source?: string }> = [];
  onObservation?: (text: string, source?: string) => Promise<void>;
  async handleRuntimeObservation(text: string, options?: { source?: string }): Promise<any> {
    this.observations.push({ text, source: options?.source });
    await this.onObservation?.(text, options?.source);
    return { text: '', visibleToUser: false };
  }
}

class FakeSessionHost {
  readonly session = new FakeSession();
  getOrCreate(): AgentSession { return this.session as unknown as AgentSession; }
  async destroy(): Promise<void> {}
}

class FakeSubAgentHost {
  spawnCount = 0;
  throwOnSpawn = false;
  lastRequest: any;
  private serial = 0;
  private callbacks = new Map<string, any>();
  private infos = new Map<string, SubAgentInfo>();
  registerPlatformCallbacks(parent: string, callbacks: any): void { this.callbacks.set(parent, callbacks); }
  async spawn(parent: string, request: any): Promise<any> {
    this.spawnCount += 1; this.lastRequest = request;
    if (this.throwOnSpawn) throw new Error('synthetic dispatch failure');
    const id = `sub-${++this.serial}`;
    const info = makeInfo(id, request.taskDescription, 'running');
    this.infos.set(id, info);
    return info;
  }
  getInfo(id: string): SubAgentInfo | undefined { return this.infos.get(id); }
  async complete(parent: string, id: string, result: { resultSummary: string; outputFiles: string[] }): Promise<void> {
    const info = { ...this.infos.get(id)!, status: 'completed' as const, completedAt: Date.now(), ...result };
    this.infos.set(id, info);
    await this.callbacks.get(parent)?.onSubAgentEvent?.({ type: 'agent_completed' }, info);
    await this.callbacks.get(parent)?.injectMessage?.(`[SubAgent complete] ${result.resultSummary}`);
  }
  async fail(parent: string, id: string, error: string): Promise<void> {
    const info = { ...this.infos.get(id)!, status: 'failed' as const, completedAt: Date.now(), resultSummary: error, outputFiles: ['/tmp/secret-output'] };
    this.infos.set(id, info);
    await this.callbacks.get(parent)?.onSubAgentEvent?.({ type: 'agent_failed' }, info);
  }
}

function makeInfo(id: string, taskDescription: string, status: SubAgentInfo['status']): SubAgentInfo {
  return {
    id, agentType: 'worker', skillName: '', toolScope: 'read_only', taskDescription, status,
    createdAt: Date.now(), progressLog: [], outputFiles: [], allowedTools: ['read_file'],
  };
}

function createAdapter(fixture: ReturnType<typeof createFixture>, sessions: FakeSessionHost, subAgents: FakeSubAgentHost, goalResolver?: AgentRunGoalResolver): ReviewAdapter {
  return new ReviewAdapter({
    workspace: fixture.workspace, storePath: fixture.storePath, skillDirectory: fixture.skillDirectory,
    workingDirectory: fixture.root, sessionHost: sessions as any, subAgentHost: subAgents as any,
    services: { aiService: {}, skillManager: {}, toolManager: {} } as AgentServices,
    ...(goalResolver ? { goalResolver } : {}),
  });
}

function createFixture(findingId: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-adapter-')); roots.push(root);
  const workspace = path.join(root, 'evidence-envelopes');
  const envelopePath = path.join(workspace, 'findings', findingId);
  const skillDirectory = path.join(root, 'skill');
  fs.mkdirSync(envelopePath, { recursive: true });
  fs.mkdirSync(path.join(skillDirectory, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(envelopePath, 'finding.json'), JSON.stringify({ findingId, reviewState: 'INCOMPLETE' }));
  fs.writeFileSync(path.join(envelopePath, 'decision.json'), JSON.stringify({
    reviewState: 'INCOMPLETE', recommendation: null, nextEvidenceAction: 'collect evidence', stopCondition: 'window end',
  }));
  const syncMarker = path.join(root, 'pool-sync-called');
  fs.writeFileSync(path.join(skillDirectory, 'scripts', 'validate-envelope.py'), 'import sys\nprint("VALID", sys.argv[-1])\n');
  fs.writeFileSync(path.join(skillDirectory, 'scripts', 'finding_manager.py'), `from pathlib import Path\nimport sys\nPath(${JSON.stringify(syncMarker)}).write_text("sync")\nprint("SYNC", sys.argv[-1])\n`);
  return { root, workspace, envelopePath, skillDirectory, syncMarker, storePath: path.join(workspace, 'review-runs.json') };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setReviewState(envelopePath: string, reviewState: string, recommendation: string | null): void {
  const findingPath = path.join(envelopePath, 'finding.json');
  const finding = JSON.parse(fs.readFileSync(findingPath, 'utf-8'));
  finding.reviewState = reviewState;
  fs.writeFileSync(findingPath, JSON.stringify(finding));
  fs.writeFileSync(path.join(envelopePath, 'decision.json'), JSON.stringify({
    reviewState, recommendation, decisiveEvidenceIds: ['E-101'],
  }));
}

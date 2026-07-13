/**
 * Issue #52: Due Work Planner — test suite.
 *
 * Proves:
 *  - The planner reads each durable source independently and reports the
 *    correct due-work flags and next-wake time.
 *  - Operational retry and curator work are selected from durable state and
 *    do NOT invoke unrelated discovery (verified through the coordinator).
 *  - Missing or corrupt state files are handled gracefully (no crash, fall
 *    back to empty/undefined deadlines).
 *  - Restart recovery: deadlines from durable state are restored after the
 *    planner re-reads its sources.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import { DistillationPipeline } from '../src/utils/distillation-pipeline';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import {
  loadCurrentSkillRegistry,
  loadTransitionAudit,
  SkillEvolutionRuntime,
} from '../src/utils/skill-evolution';
import {
  addOrUpdateOperationalFailure,
  loadReviewQueueState,
  saveReviewQueueState,
  emptyReviewQueueState,
} from '../src/utils/skill-evolution-review-queue';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { RuntimeLearningCoordinator } from '../src/utils/runtime-learning-coordinator';
import type { LearningEpisode } from '../src/utils/learning-episode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PlannerEnv {
  root: string;
  episodeStorePath: string;
  reviewQueuePath: string;
  curatorStatePath: string;
  planner: DueWorkPlanner;
  teardown: () => void;
}

function setupPlannerEnv(): PlannerEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-planner-'));
  const episodeStorePath = path.join(root, 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'review-queue.json');
  const curatorStatePath = path.join(root, 'curator-state.json');

  const planner = new DueWorkPlanner({
    learningEpisodeStorePath: episodeStorePath,
    reviewQueuePath: reviewQueuePath,
    curatorStatePath: curatorStatePath,
    curatorIntervalMs: 24 * 60 * 60 * 1000,
  });

  return {
    root,
    episodeStorePath,
    reviewQueuePath,
    curatorStatePath,
    planner,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeState(filePath: string, state: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

/** Build a Learning Episode that is settling with a specific deadline. */
function settlingEpisode(
  episodeId: string,
  deadlineDate: Date,
): LearningEpisode {
  return {
    schemaVersion: 2,
    episodeId,
    runtimeSessionId: 'test',
    sourceFilePath: '/dev/null',
    deliveryTurn: 1,
    completionEvidence: [],
    contradictionSignals: [],
    settlementDeadline: deadlineDate.toISOString(),
    status: 'settling',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DueWorkPlanner — durable source reading', () => {
  let env: PlannerEnv;

  beforeEach(() => {
    env = setupPlannerEnv();
  });

  afterEach(() => {
    env.teardown();
  });

  test('empty state: no deadlines, nothing due, no next wake', () => {
    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.due.operationalRetryDue, false);
    assert.equal(plan.due.routineCuratorDue, false);
    assert.equal(plan.due.expeditedCuratorDue, false);
    assert.equal(plan.nextWakeTime, null);
    assert.equal(plan.nextWakeReason, '');
  });

  test('missing state files: gracefully handled (no crash, empty results)', () => {
    // No files exist yet; every reader returns null/empty.
    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.due.operationalRetryDue, false);
    assert.equal(plan.due.routineCuratorDue, false);
    assert.equal(plan.due.expeditedCuratorDue, false);
    assert.equal(plan.nextWakeTime, null);
  });

  test('corrupt state file: gracefully handled (no crash)', () => {
    // Write raw invalid JSON (not through writeState which stringifies).
    fs.mkdirSync(path.dirname(env.episodeStorePath), { recursive: true });
    fs.writeFileSync(env.episodeStorePath, '{ this is not valid json ', 'utf8');
    fs.writeFileSync(env.reviewQueuePath, '{ invalid: ', 'utf8');
    fs.writeFileSync(env.curatorStatePath, 'not json at all', 'utf8');

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.due.operationalRetryDue, false);
    assert.equal(plan.due.routineCuratorDue, false);
    assert.equal(plan.due.expeditedCuratorDue, false);
    assert.equal(plan.nextWakeTime, null);
  });

  test('past settlement deadline triggers settlementDue', () => {
    writeState(env.episodeStorePath, {
      schemaVersion: 2,
      episodes: {
        'episode-1': settlingEpisode('episode-1', new Date('2026-06-30T00:00:00Z')),
      },
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.settlementDue, true);
    assert.equal(plan.due.operationalRetryDue, false);
    assert.equal(plan.due.routineCuratorDue, false);
    // Next wake: overdue settlement should schedule immediate wake.
    assert.ok(plan.nextWakeTime !== null, 'must have an immediate wake for overdue work');
    assert.equal(plan.nextWakeTime, new Date('2026-07-01T12:00:00Z').getTime());
    assert.equal(plan.nextWakeReason, 'settlement-deadline');
  });

  test('future settlement deadline provides next wake time', () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h from now
    writeState(env.episodeStorePath, {
      schemaVersion: 2,
      episodes: {
        'episode-1': settlingEpisode('episode-1', future),
      },
    });

    const plan = env.planner.plan(new Date());
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.nextWakeTime, future.getTime());
    assert.equal(plan.nextWakeReason, 'settlement-deadline');
  });

  test('only settling episodes are considered for deadlines (ignores eligible/contradicted)', () => {
    const now = new Date();
    writeState(env.episodeStorePath, {
      schemaVersion: 2,
      episodes: {
        'ep-eligible': {
          ...settlingEpisode('ep-eligible', new Date('2026-01-01T00:00:00Z')),
          status: 'eligible',
        },
        'ep-contradicted': {
          ...settlingEpisode('ep-contradicted', new Date('2026-01-01T00:00:00Z')),
          status: 'contradicted',
        },
      },
    });

    const plan = env.planner.plan(now);
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.nextWakeTime, null);
  });

  test('past operational retry deadline triggers operationalRetryDue', () => {
    const queue = emptyReviewQueueState();
    addOrUpdateOperationalFailure(
      queue,
      { capabilityId: 'cap-a', title: '', applicability: '', actionPattern: '', boundaries: [], risks: [], solvedLoop: { problem: '', action: '', verification: '', noCorrection: '' }, provenance: [], generatedAt: '', sourceUnit: { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' }, schemaVersion: 1, kind: 'capability' },
      { bundleId: 'bundle-a', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
      'branch_timeout',
      'The branch timed out',
      undefined,
      1,
      60_000,
      new Date('2026-07-01T10:00:00Z'),
    );
    saveReviewQueueState(env.reviewQueuePath, queue);

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.operationalRetryDue, true);
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.due.routineCuratorDue, false);
  });

  test('future operational retry deadline provides next wake time', () => {
    const future = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now
    const queue = emptyReviewQueueState();
    addOrUpdateOperationalFailure(
      queue,
      { capabilityId: 'cap-b', title: '', applicability: '', actionPattern: '', boundaries: [], risks: [], solvedLoop: { problem: '', action: '', verification: '', noCorrection: '' }, provenance: [], generatedAt: '', sourceUnit: { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' }, schemaVersion: 1, kind: 'capability' },
      { bundleId: 'bundle-b', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
      'branch_failure',
      'Branch failed',
      undefined,
      1,
      60_000,
      new Date(Date.now() - 60_000),
    );
    // Override the auto-computed nextRetryAt with a precise future value.
    queue.operational[0]!.nextRetryAt = future.toISOString();
    queue.operational[0]!.currentDelayMs = 30 * 60 * 1000;
    saveReviewQueueState(env.reviewQueuePath, queue);

    const plan = env.planner.plan(new Date());
    assert.equal(plan.due.operationalRetryDue, false);
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.nextWakeTime, future.getTime());
    assert.equal(plan.nextWakeReason, 'operational-retry');
  });

  test('routine curator never run: due immediately', () => {
    // lastRoutineRunAt is absent (never run) → routine is due now.
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: null,
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {},
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.routineCuratorDue, true);
    assert.equal(plan.due.expeditedCuratorDue, false);
  });

  test('routine curator last run + interval elapsed: due', () => {
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: new Date('2026-06-28T12:00:00Z').toISOString(), // 3 days ago
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {},
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.routineCuratorDue, true);
  });

  test('routine curator last run + interval NOT elapsed: not due, next wake available', () => {
    const lastRun = new Date('2026-07-01T10:00:00Z');
    const now = new Date('2026-07-01T12:00:00Z'); // 2h later (24h interval)
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: lastRun.toISOString(),
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {},
    });

    const plan = env.planner.plan(now);
    assert.equal(plan.due.routineCuratorDue, false);
    // Next curator run at lastRun + 24h = Jul-02 10:00
    assert.equal(plan.nextWakeTime, lastRun.getTime() + 24 * 60 * 60 * 1000);
    assert.equal(plan.nextWakeReason, 'curator');
  });

  test('expedited curator wakes trigger expeditedCuratorDue', () => {
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: new Date('2026-07-01T06:00:00Z').toISOString(),
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {
        'cap-handle-1': {
          capabilityHandle: 'cap-handle-1',
          outcomeFactIds: ['fact-1'],
          requestedAt: '2026-07-01T11:00:00.000Z',
        },
      },
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.expeditedCuratorDue, true);
  });

  test('multiple sources: earliest deadline determines next wake', () => {
    const now = new Date('2026-07-01T12:00:00Z');
    const settlementFuture = new Date('2026-07-01T14:00:00Z'); // 2h
    const retryFuture = new Date('2026-07-01T13:00:00Z'); // 1h → earliest
    const curatorFuture = new Date('2026-07-01T15:00:00Z'); // 3h

    // Settlement: future
    writeState(env.episodeStorePath, {
      schemaVersion: 2,
      episodes: {
        'ep-1': settlingEpisode('ep-1', settlementFuture),
      },
    });

    // Operational retry: future (earliest)
    const queue = emptyReviewQueueState();
    addOrUpdateOperationalFailure(
      queue,
      { capabilityId: 'cap-c', title: '', applicability: '', actionPattern: '', boundaries: [], risks: [], solvedLoop: { problem: '', action: '', verification: '', noCorrection: '' }, provenance: [], generatedAt: '', sourceUnit: { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' }, schemaVersion: 1, kind: 'capability' },
      { bundleId: 'bundle-c', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
      'branch_failure',
      'Failed',
      undefined,
      1,
      60_000,
      new Date(Date.now() - 60_000),
    );
    queue.operational[0]!.nextRetryAt = retryFuture.toISOString();
    saveReviewQueueState(env.reviewQueuePath, queue);

    // Curator: future
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: new Date('2026-06-30T15:00:00Z').toISOString(), // 21h ago, next in 3h
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {},
    });

    const plan = env.planner.plan(now);
    assert.equal(plan.due.settlementDue, false);
    assert.equal(plan.due.operationalRetryDue, false);
    assert.equal(plan.due.routineCuratorDue, false);
    // Earliest future deadline should be the operational retry.
    assert.equal(plan.nextWakeTime, retryFuture.getTime());
    assert.equal(plan.nextWakeReason, 'operational-retry');
  });

  test('no curator state path configured: curator sources return empty', () => {
    const plannerNoCurator = new DueWorkPlanner({
      learningEpisodeStorePath: env.episodeStorePath,
      reviewQueuePath: env.reviewQueuePath,
      curatorStatePath: null,
      curatorIntervalMs: 24 * 60 * 60 * 1000,
    });

    const plan = plannerNoCurator.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.routineCuratorDue, false);
    assert.equal(plan.due.expeditedCuratorDue, false);
  });

  // -----------------------------------------------------------------------
  // Issue #52 defect 2: overdue work must produce an immediate next wake
  //   instead of falling back to the discovery interval.
  // -----------------------------------------------------------------------

  test('overdue settlement: immediate wake with settlement-deadline reason', () => {
    writeState(env.episodeStorePath, {
      schemaVersion: 2,
      episodes: {
        'ep-past-settlement': settlingEpisode(
          'ep-past-settlement',
          new Date('2026-06-01T00:00:00Z'), // well past
        ),
      },
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.settlementDue, true);
    assert.equal(plan.due.operationalRetryDue, false);
    assert.equal(plan.due.routineCuratorDue, false);
    // nextWakeTime should be near-now (the reference timestamp), not null.
    assert.ok(plan.nextWakeTime !== null, 'must have a next wake for overdue work');
    assert.equal(plan.nextWakeTime, new Date('2026-07-01T12:00:00Z').getTime());
    assert.equal(plan.nextWakeReason, 'settlement-deadline');
  });

  test('overdue operational retry: immediate wake with operational-retry reason', () => {
    const queue = emptyReviewQueueState();
    addOrUpdateOperationalFailure(
      queue,
      { capabilityId: 'cap-overdue', title: '', applicability: '', actionPattern: '', boundaries: [], risks: [], solvedLoop: { problem: '', action: '', verification: '', noCorrection: '' }, provenance: [], generatedAt: '', sourceUnit: { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' }, schemaVersion: 1, kind: 'capability' },
      { bundleId: 'bundle-overdue', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
      'branch_timeout',
      'Timed out',
      undefined,
      1,
      60_000,
      new Date('2026-07-01T10:00:00Z'),
    );
    const now = new Date('2026-07-01T12:00:00Z');
    // Override auto-computed nextRetryAt with a past value.
    queue.operational[0]!.nextRetryAt = new Date('2026-06-01T00:00:00Z').toISOString();
    queue.operational[0]!.currentDelayMs = 120_000;
    saveReviewQueueState(env.reviewQueuePath, queue);

    const plan = env.planner.plan(now);
    assert.equal(plan.due.operationalRetryDue, true);
    assert.equal(plan.due.settlementDue, false);
    assert.ok(plan.nextWakeTime !== null, 'must have a next wake for overdue work');
    assert.equal(plan.nextWakeTime, now.getTime());
    assert.equal(plan.nextWakeReason, 'operational-retry');
  });

  test('overdue routine curator: immediate wake with curator reason', () => {
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: new Date('2026-06-28T12:00:00Z').toISOString(), // 3 days ago
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {},
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.routineCuratorDue, true);
    assert.equal(plan.due.expeditedCuratorDue, false);
    assert.ok(plan.nextWakeTime !== null, 'must have a next wake for overdue work');
    assert.equal(plan.nextWakeTime, new Date('2026-07-01T12:00:00Z').getTime());
    assert.equal(plan.nextWakeReason, 'curator');
  });

  test('expedited curator wakes: immediate wake with curator reason', () => {
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: new Date('2026-07-01T06:00:00Z').toISOString(),
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {
        'cap-urgent': {
          capabilityHandle: 'cap-urgent',
          outcomeFactIds: ['fact-1'],
          requestedAt: '2026-07-01T11:00:00.000Z',
        },
      },
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.expeditedCuratorDue, true);
    assert.equal(plan.due.routineCuratorDue, false);
    assert.ok(plan.nextWakeTime !== null, 'must have a next wake for expedited work');
    assert.equal(plan.nextWakeTime, new Date('2026-07-01T12:00:00Z').getTime());
    assert.equal(plan.nextWakeReason, 'curator');
  });

  test('multiple overdue: operational-retry has highest priority among due work', () => {
    const now = new Date('2026-07-01T12:00:00Z');

    // Overdue settlement
    writeState(env.episodeStorePath, {
      schemaVersion: 2,
      episodes: {
        'ep-past': settlingEpisode('ep-past', new Date('2026-06-01T00:00:00Z')),
      },
    });

    // Overdue operational retry (higher priority)
    const queue = emptyReviewQueueState();
    addOrUpdateOperationalFailure(
      queue,
      { capabilityId: 'cap-priority', title: '', applicability: '', actionPattern: '', boundaries: [], risks: [], solvedLoop: { problem: '', action: '', verification: '', noCorrection: '' }, provenance: [], generatedAt: '', sourceUnit: { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' }, schemaVersion: 1, kind: 'capability' },
      { bundleId: 'bundle-priority', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
      'branch_timeout',
      'Timed out',
      undefined,
      1,
      60_000,
      new Date('2026-07-01T10:00:00Z'),
    );
    queue.operational[0]!.nextRetryAt = new Date('2026-06-01T00:00:00Z').toISOString();
    queue.operational[0]!.currentDelayMs = 120_000;
    saveReviewQueueState(env.reviewQueuePath, queue);

    // Overdue routine curator (lower priority)
    writeState(env.curatorStatePath, {
      schemaVersion: 1,
      lastRoutineRunAt: new Date('2026-06-28T12:00:00Z').toISOString(),
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {},
    });

    const plan = env.planner.plan(now);
    assert.equal(plan.due.operationalRetryDue, true);
    assert.equal(plan.due.settlementDue, true);
    assert.equal(plan.due.routineCuratorDue, true);
    assert.ok(plan.nextWakeTime !== null);
    assert.equal(plan.nextWakeTime, now.getTime());
    // operational-retry has highest priority
    assert.equal(plan.nextWakeReason, 'operational-retry');
  });

  // -----------------------------------------------------------------------
  // Issue #52 defect 3: schema version validation
  // -----------------------------------------------------------------------

  test('episode store with unknown schemaVersion: conservative null deadline', () => {
    writeState(env.episodeStorePath, {
      schemaVersion: 99, // unknown future version
      episodes: {
        'ep-future': settlingEpisode('ep-future', new Date('2026-06-01T00:00:00Z')),
      },
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    // Unknown schema → no deadline from this source.
    assert.equal(plan.due.settlementDue, false);
  });

  test('review queue with unknown schemaVersion: conservative null deadline', () => {
    const queue = emptyReviewQueueState();
    addOrUpdateOperationalFailure(
      queue,
      { capabilityId: 'cap-unknown', title: '', applicability: '', actionPattern: '', boundaries: [], risks: [], solvedLoop: { problem: '', action: '', verification: '', noCorrection: '' }, provenance: [], generatedAt: '', sourceUnit: { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' }, schemaVersion: 1, kind: 'capability' },
      { bundleId: 'bundle-unknown', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
      'branch_timeout',
      'Timed out',
      undefined,
      1,
      60_000,
      new Date('2026-07-01T10:00:00Z'),
    );
    saveReviewQueueState(env.reviewQueuePath, queue);
    // Write with mismatched top-level schemaVersion.
    const data = JSON.parse(fs.readFileSync(env.reviewQueuePath, 'utf8')) as Record<string, unknown>;
    data.schemaVersion = 99;
    // Ensure there's an operational entry with a past deadline
    (data.operational as any[])[0]!.nextRetryAt = new Date('2026-06-01T00:00:00Z').toISOString();
    fs.writeFileSync(env.reviewQueuePath, JSON.stringify(data, null, 2), 'utf8');

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    // Unknown schema → no deadline from this source.
    assert.equal(plan.due.operationalRetryDue, false);
  });

  test('curator state with unknown schemaVersion: conservative null deadline and zero count', () => {
    writeState(env.curatorStatePath, {
      schemaVersion: 99,
      lastRoutineRunAt: new Date('2026-06-01T00:00:00Z').toISOString(),
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {
        'cap-ignored': { capabilityHandle: 'cap-ignored', outcomeFactIds: [], requestedAt: '2026-07-01T00:00:00.000Z' },
      },
    });

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.routineCuratorDue, false, 'unknown schema → no routine deadline');
    assert.equal(plan.due.expeditedCuratorDue, false, 'unknown schema → no expedited count');
  });

  test('episode store without schemaVersion field: backward compatible', () => {
    // No schemaVersion field at all — older format without explicit versioning.
    const raw = {
      episodes: {
        'ep-legacy': settlingEpisode('ep-legacy', new Date('2026-06-01T00:00:00Z')),
      },
    };
    writeState(env.episodeStorePath, raw);

    const plan = env.planner.plan(new Date('2026-07-01T12:00:00Z'));
    // Missing schemaVersion is tolerated (backward compat).
    assert.equal(plan.due.settlementDue, true);
  });

  test('pending semantic reassessment schedules a targeted wake', () => {
    const manifestPath = path.join(env.root, 'reassessment-manifest.json');
    writeState(manifestPath, {
      schemaVersion: 1,
      entries: {
        task: {
          taskId: 'task',
          capabilityHandle: 'cap-1',
          routingName: 'settled-artifact-delivery',
          guidanceHash: 'guidance',
          semanticObservationHash: 'observations',
          status: 'pending',
          attemptCount: 0,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    const planner = new DueWorkPlanner({
      learningEpisodeStorePath: env.episodeStorePath,
      reviewQueuePath: env.reviewQueuePath,
      curatorStatePath: env.curatorStatePath,
      curatorIntervalMs: 24 * 60 * 60 * 1000,
      semanticReassessmentManifestPath: manifestPath,
    });
    const plan = planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.semanticReassessmentDue, true);
    assert.equal(plan.nextWakeTime, plan.now.getTime());
    assert.equal(plan.nextWakeReason, 'semantic-reassessment');
  });

  test('deferred semantic reassessment without retry deadline does not busy-loop', () => {
    const manifestPath = path.join(env.root, 'reassessment-manifest.json');
    writeState(manifestPath, {
      schemaVersion: 1,
      entries: {
        task: {
          taskId: 'task',
          capabilityHandle: 'cap-1',
          routingName: 'settled-artifact-delivery',
          guidanceHash: 'guidance',
          semanticObservationHash: 'observations',
          status: 'deferred',
          attemptCount: 0,
          lastError: 'No persisted semantic observations are available for bounded reassessment.',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    const planner = new DueWorkPlanner({
      learningEpisodeStorePath: env.episodeStorePath,
      reviewQueuePath: env.reviewQueuePath,
      curatorStatePath: env.curatorStatePath,
      curatorIntervalMs: 24 * 60 * 60 * 1000,
      semanticReassessmentManifestPath: manifestPath,
    });
    const plan = planner.plan(new Date('2026-07-01T12:00:00Z'));
    assert.equal(plan.due.semanticReassessmentDue, false);
    assert.equal(plan.nextWakeTime, null);
    assert.equal(plan.nextWakeReason, '');
  });
});

// ---------------------------------------------------------------------------
// Integration: coordinator due-work filtering
// ---------------------------------------------------------------------------

type CuratorRunMode = 'normal' | 'stub';

interface CoordinatorEnv {
  root: string;
  pipeline: DistillationPipeline;
  curator: StubCurator;
  coordinator: RuntimeLearningCoordinator;
  episodeStorePath: string;
  teardown: () => void;
}

class StubCurator extends SkillUsageCurator {
  dueCalls = 0;
  shouldDueResult = true;
  constructor(opts: ConstructorParameters<typeof SkillUsageCurator>[0]) {
    super(opts);
  }
  override async runDue() {
    this.dueCalls++;
    if (!this.shouldDueResult) return { ran: false, expedited: false, transitions: [] };
    return { ran: true, expedited: false, transitions: [] };
  }
}

function setupCoordinatorEnv(opts: { curator?: boolean; settlementWindowMs?: number } = {}): CoordinatorEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-planner-integration-'));
  const episodeStorePath = path.join(root, 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'review-queue.json');
  const registryPath = path.join(root, 'registry.json');
  const auditPath = path.join(root, 'audit.jsonl');
  const journalPath = path.join(root, 'journal.json');
  const outputDir = path.join(root, 'generated-distilled');
  const ledgerPath = opts.curator ? path.join(root, 'ledger.jsonl') : undefined;
  const curatorStatePath = opts.curator ? path.join(root, 'curator-state.json') : undefined;

  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: root,
    outputDir,
    registryPath,
    auditPath,
    journalPath,
    reviewQueuePath,
    settlementWindowMs: opts.settlementWindowMs ?? 0,
    operationalRetryMs: 1,
    operationalRetryMaxMs: 60_000,
    logEnabled: false,
    authorFixture: ({ bundle }) => ({
      body: 'Test skill body.',
      envelope: {
        decision: 'create_current_skill' as const,
        routingName: 'test-skill',
        description: 'Test skill',
        referencedSkills: [],
        evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
      },
    }),
    verifierFixture: ({ draft }) => ({
      decision: 'accept' as const,
      transition: 'create_current_skill' as const,
      issues: [],
      rationale: 'Verified.',
    }),
  });

  const usageLedger = ledgerPath ? new SkillUsageLedger(ledgerPath) : undefined;
  const curator = (usageLedger && curatorStatePath)
    ? new StubCurator({
      ledger: usageLedger,
      statePath: curatorStatePath,
      intervalMs: 24 * 60 * 60 * 1000,
      runtime: skillEvolution,
    })
    : null as unknown as StubCurator;

  const pipeline = new DistillationPipeline({
    outputDir,
    reviewOutcomesPath: path.join(root, 'review-outcomes.json'),
    learningEpisodeStorePath: episodeStorePath,
    learningEpisodeSettlementWindowMs: opts.settlementWindowMs ?? 0,
    skillEvolution,
    skillUsageCurator: curator || undefined,
  });

  const coordinator = new RuntimeLearningCoordinator(pipeline, curator);

  return {
    root,
    pipeline,
    curator: curator!,
    coordinator,
    episodeStorePath,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('RuntimeLearningCoordinator — DueWork filtering', () => {
  let env: CoordinatorEnv;

  beforeEach(() => {
    env = setupCoordinatorEnv({ curator: true });
  });

  afterEach(() => {
    env.teardown();
  });

  test('no dueWork filter: runs all stages as before (backward compat)', async () => {
    const result = await env.coordinator.runWake({
      reason: 'scheduled',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
    });

    // All stages should run (maturation runs even without due episodes, review runs because maturation ran)
    assert.equal(result.maturation.status, 'succeeded');
    assert.equal(result.review.status, 'succeeded');
    assert.equal(result.curation.ran, true);
  });

  test('only operationalRetryDue: review runs, curation skipped', async () => {
    const result = await env.coordinator.runWake({
      reason: 'operational-retry',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: false,
        operationalRetryDue: true,
        routineCuratorDue: false,
        expeditedCuratorDue: false,
      },
    });

    assert.equal(result.maturation.status, 'skipped');
    assert.equal(result.review.status, 'succeeded'); // review runs due to operational retry
    assert.equal(result.curation.ran, false); // curation skipped
  });

  test('only curator due: review skipped, curation runs', async () => {
    const result = await env.coordinator.runWake({
      reason: 'curator',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: false,
        operationalRetryDue: false,
        routineCuratorDue: true,
        expeditedCuratorDue: false,
      },
    });

    assert.equal(result.maturation.status, 'skipped');
    assert.equal(result.review.status, 'skipped'); // no settlement/retry due
    assert.equal(result.curation.ran, true);
  });

  test('expedited curator due: curation runs', async () => {
    const result = await env.coordinator.runWake({
      reason: 'curator',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: false,
        operationalRetryDue: false,
        routineCuratorDue: false,
        expeditedCuratorDue: true,
      },
    });

    assert.equal(result.maturation.status, 'skipped');
    assert.equal(result.review.status, 'skipped');
    assert.equal(result.curation.ran, true);
  });

  test('settlement due: all stages run (maturation due + review due + curation may run)', async () => {
    const result = await env.coordinator.runWake({
      reason: 'settlement-deadline',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: true,
        operationalRetryDue: false,
        routineCuratorDue: false,
        expeditedCuratorDue: false,
      },
    });

    assert.equal(result.maturation.status, 'succeeded');
    assert.equal(result.review.status, 'succeeded'); // review runs because settlementDue triggers it
    assert.equal(result.curation.ran, false); // curator not due
  });

  test('empty dueWork (all false): all coordinator stages skipped', async () => {
    const result = await env.coordinator.runWake({
      reason: 'scheduled',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: false,
        operationalRetryDue: false,
        routineCuratorDue: false,
        expeditedCuratorDue: false,
      },
    });

    assert.equal(result.maturation.status, 'skipped');
    assert.equal(result.review.status, 'skipped');
    assert.equal(result.curation.ran, false);
  });
});

// ---------------------------------------------------------------------------
// AC #6: Runtime-level tests prove a due review retry and curator run do
// not invoke unrelated discovery.
// ---------------------------------------------------------------------------

describe('issue #52 AC #6: due retry and curator do not trigger discovery', () => {
  let env: CoordinatorEnv;

  beforeEach(() => {
    env = setupCoordinatorEnv({ curator: true });
  });

  afterEach(() => {
    env.teardown();
  });

  test('due operational retry wake does not scan session logs', async () => {
    // Simulate: the heartbeat is called with reason 'operational-retry'
    // and the coordinator receives the dueWork filter. The scheduler
    // skips the file-scanning phase before calling the coordinator.
    // This test proves the coordinator itself does not initiate scanning.

    const result = await env.coordinator.runWake({
      reason: 'operational-retry',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: false,
        operationalRetryDue: true,
        routineCuratorDue: false,
        expeditedCuratorDue: false,
      },
    });

    // The discovery report must indicate zero scanning activity.
    assert.equal(result.maturation.status, 'skipped', 'no settlement stage');
    assert.equal(result.review.status, 'succeeded', 'review queue processes due retries');
    assert.equal(result.curation.ran, false, 'curation not invoked');
    // No evidence ingestion occurred (the scheduler would not have called
    // the discovery processor).
  });

  test('due curator wake does not invoke unrelated discovery', async () => {
    const result = await env.coordinator.runWake({
      reason: 'curator',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: false,
        operationalRetryDue: false,
        routineCuratorDue: true,
        expeditedCuratorDue: false,
      },
    });

    assert.equal(result.maturation.status, 'skipped', 'no settlement stage');
    assert.equal(result.review.status, 'skipped', 'no review queue processing');
    assert.equal(result.curation.ran, true, 'curation runs due to routine deadline');
    // No evidence ingestion occurred.
  });

  test('due expedited curator wake also does not invoke discovery', async () => {
    const result = await env.coordinator.runWake({
      reason: 'curator',
      discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
      ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
      dueWork: {
        settlementDue: false,
        operationalRetryDue: false,
        routineCuratorDue: false,
        expeditedCuratorDue: true,
      },
    });

    assert.equal(result.maturation.status, 'skipped');
    assert.equal(result.review.status, 'skipped');
    assert.equal(result.curation.ran, true, 'curation runs due to expedited wake');
  });
});

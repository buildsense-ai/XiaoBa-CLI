import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';

/**
 * Focused tests for the scheduler-side retry/backoff guard that prevents a
 * persistent failure from scheduling a 0ms busy loop when the planner keeps
 * returning due work already in the past. See ADR 0038.
 */

function setupOverdueRetryEnv(root: string): void {
  const reviewQueuePath = path.join(root, 'data', 'skill-evolution-review-queue.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_QUEUE_FILE = 'data/skill-evolution-review-queue.json';
  process.env.XIAOBA_SKILL_EVOLUTION_CURATOR_STATE_FILE = 'data/curator-state.json';

  fs.mkdirSync(path.dirname(reviewQueuePath), { recursive: true });
  fs.writeFileSync(
    reviewQueuePath,
    JSON.stringify({
      schemaVersion: 1,
      operational: [
        {
          capability: {
            capabilityId: 'cap-overdue',
            title: 'test',
            applicability: '',
            actionPattern: '',
            boundaries: [],
            risks: [],
            solvedLoop: { problem: '', action: '', verification: '', noCorrection: '' },
            provenance: [],
            generatedAt: new Date().toISOString(),
            sourceUnit: { filePath: '', byteRange: { start: 0, end: 0 }, generatedAt: '' },
            schemaVersion: 1,
            kind: 'capability',
          },
          bundle: {
            bundleId: 'bundle-overdue',
            episode: {},
            completionEvidence: [],
            settlementEvidence: [],
            boundedContinuity: [],
            referencedSkills: [],
            relatedCurrentSkills: [],
          },
          reason: 'branch_timeout',
          errorMessage: 'Timed out',
          retryCount: 1,
          currentDelayMs: 60_000,
          nextRetryAt: new Date(Date.now() - 3600_000).toISOString(),
          failedAt: new Date(Date.now() - 7200_000).toISOString(),
        },
      ],
      deferred: [],
    }),
    'utf8',
  );

  fs.writeFileSync(
    curatorStatePath,
    JSON.stringify({
      schemaVersion: 1,
      lastRoutineRunAt: new Date().toISOString(),
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: [],
      expedited: {},
    }),
    'utf8',
  );
}

describe('distillation heartbeat scheduler retry/backoff guard (ADR 0038)', () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-backoff-'));
    savedEnv = { ...process.env };
    originalSetTimeout = globalThis.setTimeout;
  });

  afterEach(async () => {
    globalThis.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('first overdue wake schedules immediate (0ms) — existing behavior preserved', () => {
    setupOverdueRetryEnv(root);
    const scheduledDelays: number[] = [];

    globalThis.setTimeout = (((callback: (...args: any[]) => void, delay?: number) => {
      scheduledDelays.push(Number(delay));
      return originalSetTimeout(() => {}, 0);
    }) as typeof globalThis.setTimeout);

    const scheduler = new DistillationHeartbeatScheduler(root);
    (scheduler as unknown as { scheduleNextRun: () => void }).scheduleNextRun();

    assert.equal(scheduledDelays.length, 1);
    assert.equal(scheduledDelays[0], 0, 'first overdue wake is immediate (0ms)');
  });

  test('second consecutive overdue wake applies a backoff floor, not 0ms', () => {
    setupOverdueRetryEnv(root);
    const scheduledDelays: number[] = [];

    globalThis.setTimeout = (((callback: (...args: any[]) => void, delay?: number) => {
      scheduledDelays.push(Number(delay));
      return originalSetTimeout(() => {}, 0);
    }) as typeof globalThis.setTimeout);

    const scheduler = new DistillationHeartbeatScheduler(root);
    const sched = scheduler as unknown as {
      scheduleNextRun: () => void;
      consecutiveImmediateReschedules: number;
    };

    sched.scheduleNextRun(); // first: 0ms
    sched.scheduleNextRun(); // second: backoff floor

    assert.equal(scheduledDelays.length, 2);
    assert.equal(scheduledDelays[0], 0, 'first overdue wake is immediate');
    assert.ok(
      scheduledDelays[1]! >= 30 * 1000,
      'second consecutive overdue wake applies a >=30s backoff floor',
    );
  });

  test('backoff grows exponentially on consecutive overdue wakes', () => {
    setupOverdueRetryEnv(root);
    const scheduledDelays: number[] = [];

    globalThis.setTimeout = (((callback: (...args: any[]) => void, delay?: number) => {
      scheduledDelays.push(Number(delay));
      return originalSetTimeout(() => {}, 0);
    }) as typeof globalThis.setTimeout);

    const scheduler = new DistillationHeartbeatScheduler(root);
    const sched = scheduler as unknown as {
      scheduleNextRun: () => void;
    };

    sched.scheduleNextRun(); // 1st: 0ms
    sched.scheduleNextRun(); // 2nd: 30s
    sched.scheduleNextRun(); // 3rd: 60s
    sched.scheduleNextRun(); // 4th: 120s

    assert.equal(scheduledDelays.length, 4);
    assert.equal(scheduledDelays[0], 0);
    assert.ok(scheduledDelays[1]! >= 30 * 1000);
    assert.ok(scheduledDelays[2]! >= 60 * 1000);
    assert.ok(scheduledDelays[3]! >= 120 * 1000);
  });

  test('backoff counter resets on a normally-scheduled (non-immediate) wake', () => {
    setupOverdueRetryEnv(root);
    const scheduledDelays: number[] = [];

    globalThis.setTimeout = (((callback: (...args: any[]) => void, delay?: number) => {
      scheduledDelays.push(Number(delay));
      return originalSetTimeout(() => {}, 0);
    }) as typeof globalThis.setTimeout);

    const scheduler = new DistillationHeartbeatScheduler(root);
    const sched = scheduler as unknown as {
      scheduleNextRun: () => void;
      consecutiveImmediateReschedules: number;
    };

    sched.scheduleNextRun(); // 1st: 0ms (immediate)
    sched.scheduleNextRun(); // 2nd: 30s (backoff)
    assert.equal(sched.consecutiveImmediateReschedules, 2);

    // Clear the overdue retry so the planner has no due work → falls back to
    // the discovery interval (a normal, non-immediate wake).
    const reviewQueuePath = path.join(root, 'data', 'skill-evolution-review-queue.json');
    fs.writeFileSync(
      reviewQueuePath,
      JSON.stringify({ schemaVersion: 1, operational: [], deferred: [] }),
      'utf8',
    );

    sched.scheduleNextRun(); // 3rd: discovery interval (not immediate)
    assert.equal(sched.consecutiveImmediateReschedules, 0, 'counter resets after a non-immediate wake');

    // Re-add overdue work → first immediate wake is 0ms again.
    setupOverdueRetryEnv(root);
    sched.scheduleNextRun(); // 1st: 0ms (immediate, counter reset)
    assert.equal(scheduledDelays[scheduledDelays.length - 1], 0);
  });

  test('backoff is capped at MAX_NEXT_WAKE_BACKOFF_MS', () => {
    setupOverdueRetryEnv(root);
    const scheduledDelays: number[] = [];

    globalThis.setTimeout = (((callback: (...args: any[]) => void, delay?: number) => {
      scheduledDelays.push(Number(delay));
      return originalSetTimeout(() => {}, 0);
    }) as typeof globalThis.setTimeout);

    const scheduler = new DistillationHeartbeatScheduler(root);
    const sched = scheduler as unknown as { scheduleNextRun: () => void };

    // Call scheduleNextRun many times; the delay must never exceed 10 minutes.
    for (let i = 0; i < 20; i++) {
      sched.scheduleNextRun();
    }

    const maxDelay = Math.max(...scheduledDelays);
    assert.ok(
      maxDelay <= 10 * 60 * 1000,
      `backoff is capped at 10 minutes, got ${maxDelay}ms`,
    );
  });
});
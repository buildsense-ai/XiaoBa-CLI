import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DistillationHeartbeatScheduler,
  HeartbeatRunResult,
  loadHeartbeatRecord,
} from '../src/utils/distillation-heartbeat-scheduler';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import { Logger } from '../src/utils/logger';
import { loadLogCursorState, getCursor } from '../src/utils/log-cursor-state';
import { DistillationUnit } from '../src/utils/distillation-unit';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(turn: number, session_id: string, session_type: string): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(2026, 0, 1, 0, 0, 0, turn * 1000).toISOString(),
    session_id,
    session_type,
    user: { text: `user input ${turn}` },
    assistant: { text: `assistant reply ${turn}`, tool_calls: [] },
    tokens: { prompt: 10, completion: 20 },
  };
}

function writeLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function appendLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');
}

interface TestEnv {
  root: string;
  logFile: string;
  stateFile: string;
  recordFile: string;
  scheduler: DistillationHeartbeatScheduler;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-distillation-heartbeat-'));
  const logFile = path.join(root, 'logs', 'sessions', 'chat', '2026-07-09', 'chat_cli.jsonl');
  const stateFile = path.join(root, 'data', 'distillation-cursor-state.json');
  const recordFile = path.join(root, 'data', 'distillation-heartbeat-record.json');

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    DISTILLATION_HEARTBEAT_STATE_FILE: process.env.DISTILLATION_HEARTBEAT_STATE_FILE,
    DISTILLATION_HEARTBEAT_RECORD_FILE: process.env.DISTILLATION_HEARTBEAT_RECORD_FILE,
    XIAOBA_ROLE: process.env.XIAOBA_ROLE,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.DISTILLATION_HEARTBEAT_STATE_FILE = stateFile;
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordFile;
  delete process.env.XIAOBA_ROLE;

  const scheduler = new DistillationHeartbeatScheduler(root);

  return {
    root,
    logFile,
    stateFile,
    recordFile,
    scheduler,
    restore: () => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (typeof value === 'string') {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      }
    },
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function restoreProcessEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DistillationHeartbeatScheduler', () => {
  describe('configuration', () => {
    test('defaults to a six-hour cadence and enabled', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-cfg-'));
      const saved = { ...process.env };
      try {
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        delete process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS;
        const config = getDistillationHeartbeatConfig(root);
        assert.equal(config.enabled, true);
        assert.equal(config.intervalHours, 6);
        assert.equal(config.skillEvolutionEnabled, true);
        assert.equal(
          config.needsReviewQueuePath,
          path.join(root, 'data', 'needs-review-queue-state.json'),
        );
        assert.equal(
          config.capabilityRegistryPath,
          path.join(root, 'data', 'capability-registry-state.json'),
        );
        assert.equal(
          config.workLogRoot,
          path.join(root, 'logs', 'branches', 'distillation'),
        );
      } finally {
        restoreProcessEnv(saved);
      }
    });

    test('resolves effective V3 policy values through the shared runtime config surface', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-v3-cfg-'));
      const saved = { ...process.env };
      try {
        process.env.XIAOBA_SKILL_EVOLUTION_SETTLEMENT_WINDOW_HOURS = '1.5';
        process.env.XIAOBA_SKILL_EVOLUTION_CURATOR_INTERVAL_HOURS = '12';
        process.env.XIAOBA_SKILL_EVOLUTION_REVIEWER_CONCURRENCY = '5';
        process.env.XIAOBA_SKILL_EVOLUTION_OPERATIONAL_RETRY_MINUTES = '2';
        process.env.XIAOBA_SKILL_EVOLUTION_OPERATIONAL_RETRY_MAX_HOURS = '4';
        process.env.XIAOBA_SKILL_EVOLUTION_AUTHOR_MODEL = 'author-fixture-model';
        process.env.XIAOBA_SKILL_EVOLUTION_VERIFIER_MODEL = 'verifier-fixture-model';

        const config = getDistillationHeartbeatConfig(root, process.env);
        assert.equal(config.skillEvolutionSettlementWindowHours, 1.5);
        assert.equal(config.skillEvolutionCuratorIntervalHours, 12);
        assert.equal(config.skillEvolutionReviewerConcurrency, 5);
        assert.equal(config.skillEvolutionOperationalRetryMinutes, 2);
        assert.equal(config.skillEvolutionOperationalRetryMaxHours, 4);
        assert.equal(config.skillEvolutionAuthorModel, 'author-fixture-model');
        assert.equal(config.skillEvolutionVerifierModel, 'verifier-fixture-model');
      } finally {
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('can be disabled through runtime configuration', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-cfg-'));
      const saved = { ...process.env };
      try {
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'false';
        assert.equal(
          DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(root),
          false,
        );
      } finally {
        restoreProcessEnv(saved);
      }
    });

    test('can explicitly preserve the V1 path through the V3 override', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-v3-toggle-'));
      const saved = { ...process.env };
      try {
        process.env.XIAOBA_SKILL_EVOLUTION_V3_ENABLED = 'false';
        assert.equal(getDistillationHeartbeatConfig(root).skillEvolutionEnabled, false);
      } finally {
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('can use a thirty-minute cadence for local testing', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-cfg-'));
      const saved = { ...process.env };
      try {
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_MINUTES = '30';
        delete process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS;

        const config = getDistillationHeartbeatConfig(root);
        assert.equal(config.intervalHours, 0.5);
      } finally {
        restoreProcessEnv(saved);
      }
    });

    test('accepts fractional hours for the thirty-minute test cadence', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-cfg-'));
      const saved = { ...process.env };
      try {
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '0.5';
        delete process.env.DISTILLATION_HEARTBEAT_INTERVAL_MINUTES;

        const config = getDistillationHeartbeatConfig(root);
        assert.equal(config.intervalHours, 0.5);
      } finally {
        restoreProcessEnv(saved);
      }
    });

    test('is guarded for inspector-cat role runtimes', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-cfg-'));
      const saved = { ...process.env };
      try {
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.XIAOBA_ROLE = 'inspector-cat';
        assert.equal(
          DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(root),
          false,
        );
      } finally {
        restoreProcessEnv(saved);
      }
    });
  });

  describe('scheduler trigger behavior', () => {
    test('preserves the discovery cadence when settlement deadline is later', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-discovery-cadence-'));
      const saved = { ...process.env };
      const originalSetTimeout = globalThis.setTimeout;
      const scheduledDelays: number[] = [];
      try {
        const storePath = path.join(root, 'data', 'learning-episodes.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_MINUTES = '30';
        delete process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS;
        process.env.XIAOBA_LEARNING_EPISODE_STORE_FILE = 'data/learning-episodes.json';
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, JSON.stringify({
          schemaVersion: 2,
          episodes: {
            'episode-later-deadline': {
              schemaVersion: 2,
              episodeId: 'episode-later-deadline',
              runtimeSessionId: 'later-deadline-runtime',
              sourceFilePath: path.join(root, 'logs', 'sessions', 'flashcards.jsonl'),
              deliveryTurn: 1,
              completionEvidence: [],
              contradictionSignals: [],
              settlementDeadline: new Date(Date.now() + 31 * 60 * 1000).toISOString(),
              status: 'settling',
            },
          },
        }), 'utf8');

        globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
          scheduledDelays.push(Number(delay));
          return originalSetTimeout(() => {}, 0);
        }) as typeof globalThis.setTimeout;

        const scheduler = new DistillationHeartbeatScheduler(root, () => {}, null, () => {});
        (scheduler as unknown as { scheduleNextRun: () => void }).scheduleNextRun();

        assert.deepEqual(scheduledDelays, [30 * 60 * 1000]);
        void scheduler.stop();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('planner schedules settlement-deadline wake ahead of discovery interval', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-planner-'));
      const saved = { ...process.env };
      const originalSetTimeout = globalThis.setTimeout;
      const scheduledDelays: number[] = [];
      const scheduledCallbacks: Array<() => Promise<void>> = [];
      try {
        const storePath = path.join(root, 'data', 'learning-episodes.json');
        const recordPath = path.join(root, 'data', 'heartbeat.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_MINUTES = '30';
        delete process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS;
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordPath;
        process.env.XIAOBA_LEARNING_EPISODE_STORE_FILE = 'data/learning-episodes.json';
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        const deadlineMs = 5 * 60 * 1000;
        const deadlineIso = new Date(Date.now() + deadlineMs).toISOString();
        fs.writeFileSync(storePath, JSON.stringify({
          schemaVersion: 2,
          episodes: {
            'episode-deadline': {
              schemaVersion: 2,
              episodeId: 'episode-deadline',
              runtimeSessionId: 'deadline-runtime',
              sourceFilePath: path.join(root, 'logs', 'sessions', 'flashcards.jsonl'),
              deliveryTurn: 1,
              completionEvidence: [],
              contradictionSignals: [],
              settlementDeadline: deadlineIso,
              status: 'settling',
            },
          },
        }), 'utf8');

        globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
          scheduledDelays.push(Number(delay));
          scheduledCallbacks.push(async () => {
            await callback();
          });
          return originalSetTimeout(() => {}, 0);
        }) as typeof globalThis.setTimeout;

        let runtimeWakeCalls = 0;
        const scheduler = new DistillationHeartbeatScheduler(
          root,
          () => {},
          null,
          null,
          null,
          async () => {
            runtimeWakeCalls++;
            return {
              maturation: { status: 'skipped', maturedEpisodes: 0, becameEligible: 0, becameContradicted: 0 },
              review: { status: 'skipped', reviewedEpisodes: 0, reviewedQueueEntries: 0, deferredQueueReviews: 0, operationalQueueReviews: 0, deferredRetries: 0, operationalRetries: 0, transitionsByKind: {} },
              curation: { status: 'skipped', ran: false, expedited: false, transitionsByKind: {} },
            };
          },
        );

        await scheduler.start();
        await new Promise(resolve => originalSetTimeout(resolve, 10));

        assert.equal(scheduledDelays.length, 1, 'startup installs one timer');
        assert.ok(
          scheduledDelays[0]! < 30 * 60 * 1000,
          'deadline delay must be shorter than the discovery interval',
        );

        await scheduledCallbacks[0]!();

        const record = loadHeartbeatRecord(recordPath);
        assert.equal(runtimeWakeCalls, 2, 'startup and deadline wake both run');
        assert.equal(record.lastReason, 'settlement-deadline', 'deadline wake is detected as settlement');
        assert.ok(record.runCount >= 2);

        await scheduler.stop();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('wakes at a settlement deadline even when discovery interval is still far away', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-settlement-deadline-'));
      const saved = { ...process.env };
      try {
        const storePath = path.join(root, 'data', 'learning-episodes.json');
        const recordPath = path.join(root, 'data', 'heartbeat.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_MINUTES = '30';
        delete process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS;
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordPath;
        process.env.XIAOBA_LEARNING_EPISODE_STORE_FILE = 'data/learning-episodes.json';
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, JSON.stringify({
          schemaVersion: 2,
          episodes: {
            'episode-deadline': {
              schemaVersion: 2,
              episodeId: 'episode-deadline',
              runtimeSessionId: 'deadline-runtime',
              sourceFilePath: path.join(root, 'logs', 'sessions', 'flashcards.jsonl'),
              deliveryTurn: 1,
              completionEvidence: [],
              contradictionSignals: [],
              settlementDeadline: new Date(Date.now() + 80).toISOString(),
              status: 'settling',
            },
          },
        }), 'utf8');

        let wakeCalls = 0;
        const deadlineAt = Date.now() + 80;
        const scheduler = new DistillationHeartbeatScheduler(
          root,
          () => {},
          null,
          () => {
            wakeCalls++;
            if (Date.now() >= deadlineAt) {
              const state = JSON.parse(fs.readFileSync(storePath, 'utf8')) as any;
              state.episodes['episode-deadline'].status = 'eligible';
              fs.writeFileSync(storePath, JSON.stringify(state), 'utf8');
            }
          },
        );
        await scheduler.start();
        await new Promise(resolve => setTimeout(resolve, 220));
        await scheduler.stop();

        const record = loadHeartbeatRecord(recordPath);
        assert.ok(wakeCalls >= 2, 'startup and deadline cycles should invoke the settlement seam');
        assert.ok(record.runCount >= 2, 'deadline wake should run independently of discovery cadence');
        assert.equal(record.lastReason, 'settlement-deadline');
      } finally {
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('runHeartbeat fires without a user turn and extracts Distillation Units from new appends', async () => {
      const env = setupEnv();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat'), makeTurn(2, 'cli', 'chat')]);

        const collected: DistillationUnit[] = [];
        const scheduler = new DistillationHeartbeatScheduler(env.root, unit => {
          collected.push(unit);
        });
        const result: HeartbeatRunResult = await scheduler.runHeartbeat('manual');

        assert.equal(result.ran, true);
        assert.equal(result.unitsProcessed, 1);
        assert.equal(result.advancedFiles, 1);
        assert.equal(collected.length, 1);
        assert.equal(collected[0].newTurns.length, 2);

        // Cursor advanced durably
        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        assert.equal(cursor.byteOffset, fs.statSync(env.logFile).size);
        assert.equal(cursor.status, 'completed');

        // Heartbeat recorded that it ran
        const record = loadHeartbeatRecord(env.recordFile);
        assert.ok(record.lastRunAt);
        assert.equal(record.runCount, 1);
        assert.equal(record.lastReason, 'manual');
        assert.equal(record.lastUnitsProcessed, 1);
      } finally {
        env.restore();
        env.teardown();
      }
    });

    test('only scans the session log subtree under the runtime logs root', async () => {
      const env = setupEnv();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat')]);
        const providerLog = path.join(
          env.root,
          'logs',
          'provider-messages',
          '2026-07-09',
          'provider.jsonl',
        );
        writeLog(providerLog, [{ entry_type: 'provider_messages', message: 'not a session turn' }]);

        const collected: DistillationUnit[] = [];
        const scheduler = new DistillationHeartbeatScheduler(env.root, unit => {
          collected.push(unit);
        });
        const result = await scheduler.runHeartbeat('manual');

        assert.equal(result.unitsProcessed, 1);
        assert.equal(collected.length, 1);

        const state = loadLogCursorState(env.stateFile);
        assert.ok(state.cursors[env.logFile]);
        assert.equal(state.cursors[providerLog], undefined);
      } finally {
        env.restore();
        env.teardown();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Issue #52 defect 2: overdue work must schedule immediate targeted wake
  //   with no discovery scan and no interval delay (scheduler level).
  // -----------------------------------------------------------------------

  describe('targeted wake for overdue work', () => {
    test('overdue operational retry schedules immediate targeted wake without discovery', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-overdue-retry-'));
      const saved = { ...process.env };
      const originalSetTimeout = globalThis.setTimeout;
      const scheduledDelays: number[] = [];
      const scheduledWakes: string[] = [];
      try {
        const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
        const recordPath = path.join(root, 'data', 'heartbeat.json');
        const curatorStatePath = path.join(root, 'data', 'curator-state.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordPath;
        process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_QUEUE_FILE = 'data/review-queue.json';
        process.env.XIAOBA_SKILL_EVOLUTION_CURATOR_STATE_FILE = 'data/curator-state.json';

        // Write an overdue operational retry entry.
        fs.mkdirSync(path.dirname(reviewQueuePath), { recursive: true });
        fs.writeFileSync(reviewQueuePath, JSON.stringify({
          schemaVersion: 1,
          operational: [{
            capability: {
              capabilityId: 'cap-overdue-retry',
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
            bundle: { bundleId: 'bundle-overdue', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
            reason: 'branch_timeout',
            errorMessage: 'Timed out',
            retryCount: 1,
            currentDelayMs: 60_000,
            nextRetryAt: new Date(Date.now() - 3600_000).toISOString(), // 1h ago (overdue)
            failedAt: new Date(Date.now() - 7200_000).toISOString(),
          }],
          deferred: [],
        }), 'utf8');

        // Write an empty curator state so the planner doesn't skip.
        fs.writeFileSync(curatorStatePath, JSON.stringify({
          schemaVersion: 1,
          lastRoutineRunAt: new Date().toISOString(),
          reviewedOutcomeFactIds: [],
          observedEpisodeIds: [],
          expedited: {},
        }), 'utf8');

        globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
          scheduledDelays.push(Number(delay));
          scheduledWakes.push('scheduled');
          return originalSetTimeout(() => {}, 0);
        }) as typeof globalThis.setTimeout;

        const scheduler = new DistillationHeartbeatScheduler(root);
        (scheduler as unknown as { scheduleNextRun: () => void }).scheduleNextRun();

        assert.equal(scheduledDelays.length, 1, 'must schedule one timer');
        assert.ok(
          scheduledDelays[0]! < 60 * 1000,
          'overdue retry must cause near-zero delay, not the 6h discovery interval',
        );
        assert.equal(scheduledDelays[0]!, 0, 'overdue retry schedules immediate (0ms) wake');

        void scheduler.stop();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('overdue curator work schedules immediate targeted wake without discovery', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-overdue-curator-'));
      const saved = { ...process.env };
      const originalSetTimeout = globalThis.setTimeout;
      const scheduledDelays: number[] = [];
      try {
        const curatorStatePath = path.join(root, 'data', 'curator-state.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.XIAOBA_SKILL_EVOLUTION_CURATOR_STATE_FILE = 'data/curator-state.json';

        // Write curator state where last routine run was 3 days ago (overdue).
        fs.mkdirSync(path.dirname(curatorStatePath), { recursive: true });
        fs.writeFileSync(curatorStatePath, JSON.stringify({
          schemaVersion: 1,
          lastRoutineRunAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
          reviewedOutcomeFactIds: [],
          observedEpisodeIds: [],
          expedited: {},
        }), 'utf8');

        globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
          scheduledDelays.push(Number(delay));
          return originalSetTimeout(() => {}, 0);
        }) as typeof globalThis.setTimeout;

        const scheduler = new DistillationHeartbeatScheduler(root);
        (scheduler as unknown as { scheduleNextRun: () => void }).scheduleNextRun();

        assert.equal(scheduledDelays.length, 1, 'must schedule one timer');
        assert.ok(
          scheduledDelays[0]! < 60 * 1000,
          'overdue curator must cause near-zero delay, not the 6h discovery interval',
        );
        assert.equal(scheduledDelays[0]!, 0, 'overdue curator schedules immediate (0ms) wake');

        void scheduler.stop();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('overdue settlement schedules immediate targeted wake without discovery', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-overdue-settlement-'));
      const saved = { ...process.env };
      const originalSetTimeout = globalThis.setTimeout;
      const scheduledDelays: number[] = [];
      try {
        const storePath = path.join(root, 'data', 'learning-episodes.json');
        const recordPath = path.join(root, 'data', 'heartbeat.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordPath;
        process.env.XIAOBA_LEARNING_EPISODE_STORE_FILE = 'data/learning-episodes.json';

        // Write an overdue settlement episode.
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, JSON.stringify({
          schemaVersion: 2,
          episodes: {
            'ep-overdue': {
              schemaVersion: 2,
              episodeId: 'ep-overdue',
              runtimeSessionId: 'overdue-runtime',
              sourceFilePath: '/dev/null',
              deliveryTurn: 1,
              completionEvidence: [],
              contradictionSignals: [],
              settlementDeadline: new Date(Date.now() - 3600_000).toISOString(), // 1h ago
              status: 'settling',
            },
          },
        }), 'utf8');

        globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
          scheduledDelays.push(Number(delay));
          return originalSetTimeout(() => {}, 0);
        }) as typeof globalThis.setTimeout;

        const scheduler = new DistillationHeartbeatScheduler(root);
        (scheduler as unknown as { scheduleNextRun: () => void }).scheduleNextRun();

        assert.equal(scheduledDelays.length, 1, 'must schedule one timer');
        assert.ok(
          scheduledDelays[0]! < 60 * 1000,
          'overdue settlement must cause near-zero delay, not the 6h discovery interval',
        );
        assert.equal(scheduledDelays[0]!, 0, 'overdue settlement schedules immediate (0ms) wake');

        void scheduler.stop();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('overdue operational retry wake skips session-log scan (proven via runHeartbeat)', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-overdue-scan-noscan-'));
      const saved = { ...process.env };
      try {
        const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
        const curatorStatePath = path.join(root, 'data', 'curator-state.json');
        const recordPath = path.join(root, 'data', 'heartbeat.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordPath;
        process.env.XIAOBA_SKILL_EVOLUTION_REVIEW_QUEUE_FILE = 'data/review-queue.json';
        process.env.XIAOBA_SKILL_EVOLUTION_CURATOR_STATE_FILE = 'data/curator-state.json';

        // Write an overdue operational retry entry.
        fs.mkdirSync(path.dirname(reviewQueuePath), { recursive: true });
        fs.writeFileSync(reviewQueuePath, JSON.stringify({
          schemaVersion: 1,
          operational: [{
            capability: {
              capabilityId: 'cap-retry-noscan',
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
            bundle: { bundleId: 'bundle-noscan', episode: {}, completionEvidence: [], settlementEvidence: [], boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [] },
            reason: 'branch_timeout',
            errorMessage: 'Timed out',
            retryCount: 1,
            currentDelayMs: 60_000,
            nextRetryAt: new Date(Date.now() - 3600_000).toISOString(),
            failedAt: new Date(Date.now() - 7200_000).toISOString(),
          }],
          deferred: [],
        }), 'utf8');

        // Empty curator state so the planner loads it.
        fs.writeFileSync(curatorStatePath, JSON.stringify({
          schemaVersion: 1,
          lastRoutineRunAt: new Date().toISOString(),
          reviewedOutcomeFactIds: [],
          observedEpisodeIds: [],
          expedited: {},
        }), 'utf8');

        // Create a session log with unprocessed content.
        const sessionLog = path.join(root, 'logs', 'sessions', 'chat', 'test.jsonl');
        fs.mkdirSync(path.dirname(sessionLog), { recursive: true });
        fs.writeFileSync(sessionLog, JSON.stringify(makeTurn(1, 'noscan', 'chat')) + '\n', 'utf8');

        let processorCalls = 0;
        const scheduler = new DistillationHeartbeatScheduler(root, () => {
          processorCalls++;
        });

        // Run heartbeat with operational-retry reason (targeted).
        const result = await scheduler.runHeartbeat('operational-retry');

        assert.equal(result.ran, true);
        assert.equal(result.unitsProcessed, 0, 'targeted wake must not process distillation units');
        assert.equal(
          result.discovery.scanned,
          false,
          'targeted wake must skip session-log scanning',
        );
        assert.equal(processorCalls, 0, 'processor must not be called');
      } finally {
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('overdue curator wake skips session-log scan (proven via runHeartbeat)', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-curator-noscan-'));
      const saved = { ...process.env };
      try {
        const curatorStatePath = path.join(root, 'data', 'curator-state.json');
        const recordPath = path.join(root, 'data', 'heartbeat.json');
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordPath;
        process.env.XIAOBA_SKILL_EVOLUTION_CURATOR_STATE_FILE = 'data/curator-state.json';

        // Write curator state with expedited wake request.
        fs.mkdirSync(path.dirname(curatorStatePath), { recursive: true });
        fs.writeFileSync(curatorStatePath, JSON.stringify({
          schemaVersion: 1,
          lastRoutineRunAt: new Date().toISOString(),
          reviewedOutcomeFactIds: [],
          observedEpisodeIds: [],
          expedited: {
            'cap-expedited': {
              capabilityHandle: 'cap-expedited',
              outcomeFactIds: ['fact-1'],
              requestedAt: new Date().toISOString(),
            },
          },
        }), 'utf8');

        // Create a session log with unprocessed content.
        const sessionLog = path.join(root, 'logs', 'sessions', 'chat', 'test.jsonl');
        fs.mkdirSync(path.dirname(sessionLog), { recursive: true });
        fs.writeFileSync(sessionLog, JSON.stringify(makeTurn(1, 'curator-noscan', 'chat')) + '\n', 'utf8');

        let processorCalls = 0;
        const scheduler = new DistillationHeartbeatScheduler(root, () => {
          processorCalls++;
        });

        // Run heartbeat with curator reason (targeted).
        const result = await scheduler.runHeartbeat('curator');

        assert.equal(result.ran, true);
        assert.equal(result.unitsProcessed, 0, 'targeted wake must not process distillation units');
        assert.equal(
          result.discovery.scanned,
          false,
          'targeted wake must skip session-log scanning',
        );
        assert.equal(processorCalls, 0, 'processor must not be called');
      } finally {
        restoreProcessEnv(saved);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('catch-up behavior', () => {
    test('a missed heartbeat catches up from stored Log Cursor state', async () => {
      const env = setupEnv();
      try {
        // Initial content present, but the first heartbeat is "missed" — we do
        // NOT run the scheduler, simulating the runtime being offline.
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat'), makeTurn(2, 'cli', 'chat')]);

        // While offline, more turns are appended.
        appendLog(env.logFile, [makeTurn(3, 'cli', 'chat'), makeTurn(4, 'cli', 'chat')]);

        // Now the runtime comes back and a single heartbeat fires. It must
        // process ALL unprocessed content from the durable cursor (which starts
        // at byte offset 0 — nothing has been processed yet).
        const collected: DistillationUnit[] = [];
        const scheduler = new DistillationHeartbeatScheduler(env.root, unit => {
          collected.push(unit);
        });
        const result = await scheduler.runHeartbeat('scheduled');

        assert.equal(result.ran, true);
        assert.equal(result.unitsProcessed, 1);
        // One file produced one unit covering all four appended turns
        assert.equal(collected.length, 1);
        assert.equal(collected[0].newTurns.length, 4);

        // Cursor now reflects the full file
        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        assert.equal(cursor.byteOffset, fs.statSync(env.logFile).size);
        assert.equal(cursor.processedTurnCount, 4);
        assert.equal(cursor.status, 'completed');

        const record = loadHeartbeatRecord(env.recordFile);
        assert.equal(record.runCount, 1);
        assert.equal(record.lastUnitsProcessed, 1);
      } finally {
        env.restore();
        env.teardown();
      }
    });

    test('catch-up across two missed cycles advances cursor incrementally', async () => {
      const env = setupEnv();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat')]);

        // First (missed) cycle would have processed turn 1. Instead we simulate
        // the runtime being offline: nothing runs. Then more content arrives.
        appendLog(env.logFile, [makeTurn(2, 'cli', 'chat')]);

        const scheduler = new DistillationHeartbeatScheduler(env.root, () => {});
        // First real run catches up turn 1 + turn 2 from a fresh cursor.
        const r1 = await scheduler.runHeartbeat('scheduled');
        assert.equal(r1.unitsProcessed, 1);

        // A second (also previously missed) cycle's worth of content arrives.
        appendLog(env.logFile, [makeTurn(3, 'cli', 'chat')]);

        // Next heartbeat catches up only the newly appended turn 3 from the
        // stored cursor — no duplicate processing of turns 1–2.
        let seenNewTurns: number[] = [];
        const scheduler2 = new DistillationHeartbeatScheduler(env.root, unit => {
          seenNewTurns = unit.newTurns.map(t => t.turn);
        });
        const r2 = await scheduler2.runHeartbeat('scheduled');
        assert.equal(r2.unitsProcessed, 1);
        assert.deepEqual(seenNewTurns, [3]);

        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        assert.equal(cursor.processedTurnCount, 3);
        assert.equal(cursor.byteOffset, fs.statSync(env.logFile).size);

        const record = loadHeartbeatRecord(env.recordFile);
        assert.equal(record.runCount, 2);
      } finally {
        env.restore();
        env.teardown();
      }
    });
  });

  describe('no-op behavior when no session log append exists', () => {
    test('second heartbeat produces no Distillation Unit and does not advance the cursor', async () => {
      const env = setupEnv();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat'), makeTurn(2, 'cli', 'chat')]);

        const scheduler = new DistillationHeartbeatScheduler(env.root, () => {});
        const r1 = await scheduler.runHeartbeat('manual');
        assert.equal(r1.unitsProcessed, 1);

        const cursorAfterFirst = getCursor(loadLogCursorState(env.stateFile), env.logFile);
        const offsetAfterFirst = cursorAfterFirst.byteOffset;

        // Re-run with no new appends — must be a no-op
        let processorCalls = 0;
        const scheduler2 = new DistillationHeartbeatScheduler(env.root, () => {
          processorCalls++;
        });
        const r2 = await scheduler2.runHeartbeat('scheduled');
        assert.equal(r2.unitsProcessed, 0);
        assert.equal(r2.advancedFiles, 0);
        assert.equal(processorCalls, 0);

        // Cursor unchanged
        const cursorAfterSecond = getCursor(loadLogCursorState(env.stateFile), env.logFile);
        assert.equal(cursorAfterSecond.byteOffset, offsetAfterFirst);
        assert.equal(cursorAfterSecond.processedTurnCount, 2);

        // Heartbeat record still records the (no-op) run
        const record = loadHeartbeatRecord(env.recordFile);
        assert.equal(record.runCount, 2);
        assert.equal(record.lastUnitsProcessed, 0);
        assert.equal(record.lastAdvancedFiles, 0);
      } finally {
        env.restore();
        env.teardown();
      }
    });

    test('heartbeat is a no-op when the logs root does not exist', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-empty-'));
      const saved = { ...process.env };
      try {
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
        process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_STATE_FILE = path.join(root, 'data', 'cursor.json');
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = path.join(root, 'data', 'record.json');
        delete process.env.XIAOBA_ROLE;

        const scheduler = new DistillationHeartbeatScheduler(root);
        const result = await scheduler.runHeartbeat('manual');
        assert.equal(result.ran, true);
        assert.equal(result.unitsProcessed, 0);
        assert.equal(result.advancedFiles, 0);

        // Record still written so catch-up audit shows the heartbeat fired
        const record = loadHeartbeatRecord(path.join(root, 'data', 'record.json'));
        assert.equal(record.runCount, 1);
        assert.equal(record.lastUnitsProcessed, 0);
      } finally {
        restoreProcessEnv(saved);
      }
    });
  });

  describe('disabled / guarded runtime', () => {
    test('runHeartbeat reports ran:false when disabled by config', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dh-disabled-'));
      const saved = { ...process.env };
      try {
        process.env.DISTILLATION_HEARTBEAT_ENABLED = 'false';
        process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
        process.env.DISTILLATION_HEARTBEAT_STATE_FILE = path.join(root, 'data', 'cursor.json');
        process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = path.join(root, 'data', 'record.json');
        delete process.env.XIAOBA_ROLE;

        const scheduler = new DistillationHeartbeatScheduler(root);
        const result = await scheduler.runHeartbeat('manual');
        assert.equal(result.ran, false);
        assert.equal(result.unitsProcessed, 0);
      } finally {
        restoreProcessEnv(saved);
      }
    });
  });
});

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import { DistillationPipeline } from '../src/utils/distillation-pipeline';
import { DistillationUnit, extractDistillationUnit } from '../src/utils/distillation-unit';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { getCursor, loadLogCursorState } from '../src/utils/log-cursor-state';
import {
  loadCurrentSkillRegistry,
  loadTransitionAudit,
  SkillEvolutionRuntime,
} from '../src/utils/skill-evolution';
import {
  findOperationalByBundleId,
  loadReviewQueueState,
} from '../src/utils/skill-evolution-review-queue';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';

// ---------------------------------------------------------------------------
// Issue #50 — Evidence Ingestion is decoupled from Capability Review.
//
// The highest runtime/scheduler wake seam is `DistillationHeartbeatScheduler
// .runHeartbeat`. The heartbeat processor is Evidence Ingestion (admission);
// Branch Promotion Review runs afterwards in the settlement-deadline wake hook.
// These tests prove the three acceptance properties:
//   (a) successful evidence admission + reviewer failure advances the cursor
//       and preserves retryable review state.
//   (b) source parsing / evidence-persistence failure leaves the cursor
//       unchanged and records retryable source failure state.
//   (c) replay across the admission/cursor-acknowledgement boundary is
//       idempotent and commits at most one Capability Transition.
// ---------------------------------------------------------------------------

function makeTurn(
  turn: number,
  sessionId: string,
  userText: string,
  assistantText: string,
  toolCalls: { id: string; name: string; arguments: any; result: string }[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 4, completion: 8 },
  };
}

// A delivery turn that produces artifact-delivery evidence (send_file with a
// non-failure result), followed by a positive-acceptance turn with no
// contradiction markers. This is the smallest solved loop that
// `extractLearningEpisodes` admits as one Learning Episode.
const DELIVERY_TURN = makeTurn(
  1,
  'cli',
  'Deliver a small report.',
  'Delivered the report.',
  [{ id: 'send-1', name: 'send_file', arguments: { path: 'report.md' }, result: 'report sent' }],
);
const ACCEPTANCE_TURN = makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.');

function writeLog(filePath: string, entries: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

type VerifierMode = 'approve' | 'timeout';

interface Env {
  root: string;
  logFile: string;
  stateFile: string;
  recordFile: string;
  episodeStorePath: string;
  reviewQueuePath: string;
  registryPath: string;
  auditPath: string;
  journalPath: string;
  outputDir: string;
  pipeline: DistillationPipeline;
  skillEvolution: SkillEvolutionRuntime;
  branchCalls: { author: number; verifier: number };
  makeScheduler: () => DistillationHeartbeatScheduler;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(verifierMode: VerifierMode = 'approve', opts: { episodeStoreDir?: string } = {}): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-ingestion-'));
  const skillsRoot = path.join(root, 'skills');
  const logFile = path.join(root, 'logs', 'sessions', 'chat', 'test.jsonl');
  const stateFile = path.join(root, 'data', 'cursor-state.json');
  const recordFile = path.join(root, 'data', 'heartbeat-record.json');
  const episodeStoreDir = opts.episodeStoreDir ?? path.join(root, 'episode-store');
  const episodeStorePath = path.join(episodeStoreDir, 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const outputDir = path.join(skillsRoot, 'generated-distilled');
  const branchCalls = { author: 0, verifier: 0 };

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    DISTILLATION_HEARTBEAT_STATE_FILE: process.env.DISTILLATION_HEARTBEAT_STATE_FILE,
    DISTILLATION_HEARTBEAT_RECORD_FILE: process.env.DISTILLATION_HEARTBEAT_RECORD_FILE,
    XIAOBA_ROLE: process.env.XIAOBA_ROLE,
    XIAOBA_SKILLS_DIR: process.env.XIAOBA_SKILLS_DIR,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.DISTILLATION_HEARTBEAT_STATE_FILE = stateFile;
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = recordFile;
  delete process.env.XIAOBA_ROLE;
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  process.env.XIAOBA_RUNTIME_ROOT = root;

  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: root,
    outputDir,
    registryPath,
    auditPath,
    journalPath,
    reviewQueuePath,
    settlementWindowMs: 0,
    operationalRetryMs: 1,
    operationalRetryMaxMs: 60_000,
    logEnabled: false,
    authorFixture: ({ bundle }) => {
      branchCalls.author++;
      return {
        body: 'Deliver a report when requested and wait for user verification.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'test-report-delivery',
          description: 'Deliver a report and wait for user verification.',
          referencedSkills: [],
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
        },
      };
    },
    verifierFixture: ({ draft }) => {
      branchCalls.verifier++;
      assert.equal(draft.envelope.routingName, 'test-report-delivery');
      if (verifierMode === 'timeout') {
        throw new Error('Model request timed out while validating the verifier completion.');
      }
      return {
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'The bounded report workflow is supported by the fixed artifact evidence.',
      };
    },
  });

  const pipeline = new DistillationPipeline({
    outputDir,
    reviewOutcomesPath: path.join(root, 'data', 'review-outcomes.json'),
    learningEpisodeStorePath: episodeStorePath,
    learningEpisodeSettlementWindowMs: 0,
    skillEvolution,
  });

  const makeScheduler = () =>
    new DistillationHeartbeatScheduler(
      root,
      // Issue #50: the heartbeat processor is Evidence Ingestion only.
      unit => pipeline.admitEvidence(unit),
      async () => {
        await pipeline.reviewSkillEvolutionQueueEntries();
      },
      // Branch Promotion Review runs after cursor acknowledgement, so its
      // failure must never rewind the Log Cursor.
      async () => {
        await pipeline.processSettledLearningEpisodes();
      },
    );

  return {
    root,
    logFile,
    stateFile,
    recordFile,
    episodeStorePath,
    reviewQueuePath,
    registryPath,
    auditPath,
    journalPath,
    outputDir,
    pipeline,
    skillEvolution,
    branchCalls,
    makeScheduler,
    restore: () => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
    },
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function cursorFor(env: Env) {
  return getCursor(loadLogCursorState(env.stateFile), env.logFile);
}

describe('issue #50: Evidence Ingestion decoupled from Capability Review', () => {
  let env: Env;

  beforeEach(() => {
    env = setupEnv('approve');
  });

  afterEach(() => {
    env.restore();
    try {
      fs.chmodSync(path.dirname(env.episodeStorePath), 0o700);
    } catch {
      // best-effort; dir may not exist
    }
    env.teardown();
  });

  // AC3: Branch Promotion Review failure after successful evidence admission
  // advances the Log Cursor, preserves the admitted episode, and records
  // retryable review work.
  test('(a) admission succeeds, reviewer fails: cursor still advances and retryable review state is preserved', async () => {
    env.restore();
    env = setupEnv('timeout');
    writeLog(env.logFile, [DELIVERY_TURN, ACCEPTANCE_TURN]);

    const scheduler = env.makeScheduler();
    const result = await scheduler.runHeartbeat('manual');

    assert.equal(result.ran, true);
    assert.equal(result.advancedFiles, 1, 'the admitted source range is acknowledged');

    // Cursor advanced to EOF and is completed despite the reviewer failure.
    const cursor = cursorFor(env);
    assert.equal(cursor.byteOffset, fs.statSync(env.logFile).size);
    assert.equal(cursor.status, 'completed', 'reviewer failure must not mark the cursor failed');

    // The episode was durably admitted and settled to eligible.
    const store = new LearningEpisodeStore(env.episodeStorePath).load();
    const episodes = Object.values(store.episodes);
    assert.equal(episodes.length, 1, 'exactly one Learning Episode was admitted');
    assert.equal(episodes[0]!.status, 'eligible', 'the admitted episode survived settlement');
    assert.ok(episodes[0]!.completionEvidence.some(ev => ev.kind === 'artifact-delivery'));

    // The reviewer was attempted (operational failure path) and the failure
    // was persisted as retryable review work, not a cursor failure.
    assert.ok(env.branchCalls.verifier >= 1, 'the Branch Promotion Reviewer was attempted');
    const queue = loadReviewQueueState(env.reviewQueuePath);
    const bundleId = `v3:learning-episode:${episodes[0]!.episodeId}`;
    assert.ok(findOperationalByBundleId(queue, bundleId), 'an operational retry entry was persisted for the episode bundleId');
    assert.ok(queue.operational[0]!.nextRetryAt, 'the retry entry carries a persisted nextRetryAt deadline');

    // No Capability Transition was committed while the reviewer is failing.
    assert.deepEqual(loadCurrentSkillRegistry(env.registryPath).capabilities, {}, 'no Current Skill is created while the reviewer is failing');
    assert.equal(loadTransitionAudit(env.auditPath).length, 0, 'no Transition Audit entry is written for a failing review');
  });

  // AC2: Source parsing or evidence-persistence failure leaves the Log Cursor
  // at the prior source position and records retryable source failure state.
  test('(b1) source parse failure leaves the cursor unchanged and failed', async () => {
    // Malformed JSON in the session log makes `extractDistillationUnit` throw.
    fs.mkdirSync(path.dirname(env.logFile), { recursive: true });
    fs.writeFileSync(env.logFile, '{ not valid json\n{ also broken\n', 'utf-8');

    const scheduler = env.makeScheduler();
    const result = await scheduler.runHeartbeat('manual');

    assert.equal(result.ran, true);
    assert.equal(result.advancedFiles, 0, 'no source range is acknowledged on parse failure');

    const cursor = cursorFor(env);
    assert.equal(cursor.byteOffset, 0, 'cursor stays at the prior offset for retry');
    assert.equal(cursor.status, 'failed', 'cursor records retryable source failure state');
    assert.ok(cursor.lastError, 'the source failure is recorded on the cursor');

    // No episode was admitted.
    assert.equal(Object.keys(new LearningEpisodeStore(env.episodeStorePath).load().episodes).length, 0);
  });

  // AC2 (continued): evidence-persistence failure leaves the cursor unchanged.
  test('(b2) evidence-persistence failure leaves the cursor unchanged and failed', async () => {
    fs.mkdirSync(path.dirname(env.episodeStorePath), { recursive: true });
    // Make the episode store directory read-only so the durable admission write
    // fails while the cursor state directory stays writable. This simulates an
    // evidence-persistence I/O failure after a successful source parse.
    fs.chmodSync(path.dirname(env.episodeStorePath), 0o500);
    writeLog(env.logFile, [DELIVERY_TURN, ACCEPTANCE_TURN]);

    const scheduler = env.makeScheduler();
    const result = await scheduler.runHeartbeat('manual');

    assert.equal(result.ran, true);
    assert.equal(result.advancedFiles, 0, 'no source range is acknowledged when admission is not durable');

    const cursor = cursorFor(env);
    assert.equal(cursor.byteOffset, 0, 'cursor stays at the prior offset for retry');
    assert.equal(cursor.status, 'failed', 'cursor records a retryable source failure');
    assert.ok(cursor.lastError, 'the evidence-persistence failure is recorded on the cursor');

    // Cursor state itself remained writable (the cursor failure was durable).
    assert.ok(fs.existsSync(env.stateFile), 'the cursor state file was still writable while episode persistence failed');
  });

  // AC5 + AC4: A crash/replay boundary after episode persistence but before
  // cursor acknowledgement is idempotent and commits at most one Capability
  // Transition.
  test('(c) replay after admission-before-ack is idempotent with at most one Capability Transition', async () => {
    writeLog(env.logFile, [DELIVERY_TURN, ACCEPTANCE_TURN]);

    // Simulate a crash AFTER durable episode admission but BEFORE cursor
    // acknowledgement: the episode store is populated directly from the same
    // source range, while the Log Cursor is left at byte offset 0.
    const extractionUnit: DistillationUnit = {
      filePath: env.logFile,
      newTurns: [DELIVERY_TURN, ACCEPTANCE_TURN],
      continuityTurns: [],
      byteRange: { start: 0, end: fs.statSync(env.logFile).size },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const preState = env.pipeline.admitEvidence(extractionUnit);
    const admittedId = preState.admittedEpisodeIds[0]!;
    assert.ok(admittedId, 'the pre-crash admission persisted one episode');
    assert.equal(
      Object.keys(new LearningEpisodeStore(env.episodeStorePath).load().episodes).length,
      1,
      'one episode is durable before the crash',
    );
    assert.equal(cursorFor(env).byteOffset, 0, 'cursor is still at the prior offset (crash before ack)');

    // Replay: the scheduler re-extracts the same source range and re-admits.
    const scheduler = env.makeScheduler();
    const r1 = await scheduler.runHeartbeat('manual');
    assert.equal(r1.advancedFiles, 1, 'the replayed source range is acknowledged');

    // Idempotent admission: still exactly one episode (no duplicate), cursor
    // now at EOF.
    const storeAfterReplay = new LearningEpisodeStore(env.episodeStorePath).load();
    const episodesAfterReplay = Object.values(storeAfterReplay.episodes);
    assert.equal(episodesAfterReplay.length, 1, 'replay did not duplicate the Learning Episode');
    assert.equal(episodesAfterReplay[0]!.episodeId, admittedId, 'the replayed episode is the same durable entity');
    assert.equal(cursorFor(env).byteOffset, fs.statSync(env.logFile).size, 'cursor advanced to EOF on replay');

    // At most one Capability Transition across admission + replay + review.
    const auditAfterReplay = loadTransitionAudit(env.auditPath);
    assert.equal(auditAfterReplay.length, 1, 'exactly one Capability Transition is committed for the admitted evidence');
    assert.equal(auditAfterReplay[0]!.transition, 'create_current_skill');
    assert.equal(Object.keys(loadCurrentSkillRegistry(env.registryPath).capabilities).length, 1, 'one Current Skill was created');

    // Second replay: cursor already at EOF, no new extraction, no new review,
    // no new transition.
    const r2 = await scheduler.runHeartbeat('scheduled');
    assert.equal(r2.unitsProcessed, 0);
    assert.equal(r2.advancedFiles, 0);
    assert.equal(loadTransitionAudit(env.auditPath).length, 1, 're-running the acknowledged boundary commits no additional transition');
    assert.equal(
      Object.keys(new LearningEpisodeStore(env.episodeStorePath).load().episodes).length,
      1,
      'no episode is duplicated on the second replay',
    );
  });
});
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { DistillationPipeline } from '../src/utils/distillation-pipeline';
import { DistillationUnit } from '../src/utils/distillation-unit';
import { LearningEpisode, LearningEpisodeStore } from '../src/utils/learning-episode';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { RuntimeLearningCoordinator } from '../src/utils/runtime-learning-coordinator';
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
  episodeId?: string,
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    ...(episodeId && { episode_id: episodeId }),
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

class TrackingCurator extends SkillUsageCurator {
  readonly observedEpisodeIds: string[] = [];

  override observeEpisode(episode: LearningEpisode) {
    this.observedEpisodeIds.push(episode.episodeId);
    return super.observeEpisode(episode);
  }
}

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
  ledgerPath?: string;
  curatorStatePath?: string;
  usageLedger?: SkillUsageLedger;
  curator?: TrackingCurator;
  pipeline: DistillationPipeline;
  skillEvolution: SkillEvolutionRuntime;
  branchCalls: { author: number; verifier: number };
  makeScheduler: () => DistillationHeartbeatScheduler;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(
  verifierMode: VerifierMode = 'approve',
  opts: { episodeStoreDir?: string; withCurator?: boolean; settlementWindowMs?: number } = {},
): Env {
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
  const ledgerPath = opts.withCurator ? path.join(root, 'data', 'skill-usage-ledger.jsonl') : undefined;
  const curatorStatePath = opts.withCurator ? path.join(root, 'data', 'curator-state.json') : undefined;
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

  const usageLedger = ledgerPath ? new SkillUsageLedger(ledgerPath) : undefined;
  const curator = ledgerPath && curatorStatePath
    ? new TrackingCurator({
      ledger: usageLedger!,
      statePath: curatorStatePath,
      intervalMs: 24 * 60 * 60 * 1000,
      runtime: skillEvolution,
    })
    : undefined;

  const pipeline = new DistillationPipeline({
    outputDir,
    reviewOutcomesPath: path.join(root, 'data', 'review-outcomes.json'),
    learningEpisodeStorePath: episodeStorePath,
    learningEpisodeSettlementWindowMs: opts.settlementWindowMs ?? 0,
    skillEvolution,
    skillUsageCurator: curator,
  });
  const runtimeLearningCoordinator = new RuntimeLearningCoordinator(pipeline, curator);

  const testPlanner = new DueWorkPlanner({
    learningEpisodeStorePath: episodeStorePath,
    reviewQueuePath,
    curatorStatePath: curatorStatePath ?? null,
    curatorIntervalMs: 24 * 60 * 60 * 1000,
  });

  const makeScheduler = () =>
    new DistillationHeartbeatScheduler(
      root,
      // Issue #50: the heartbeat processor is Evidence Ingestion only.
      unit => pipeline.admitEvidence(unit),
      null,
      null,
      null,
      context => runtimeLearningCoordinator.runWake(context),
      testPlanner,
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
    ledgerPath,
    curatorStatePath,
    usageLedger,
    curator,
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

function makeDeliveryUnit(filePath: string, episodeId: string, turnStart = 1): DistillationUnit {
  return {
    filePath,
    newTurns: [
      makeTurn(
        turnStart,
        'cli',
        'Deliver a small report.',
        'Delivered the report.',
        [{ id: `send-${turnStart}`, name: 'send_file', arguments: { path: 'report.md' }, result: 'report sent' }],
        episodeId,
      ),
      makeTurn(turnStart + 1, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.', [], episodeId),
    ],
    continuityTurns: [],
    byteRange: { start: 0, end: 200 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function seedGeneratedSkillLoad(env: Env, episodeId: string) {
  assert.ok(env.usageLedger, 'expected usage ledger');
  const generatedSkillPath = path.join(env.outputDir, 'cap-generated', 'SKILL.md');
  fs.mkdirSync(path.dirname(generatedSkillPath), { recursive: true });
  fs.writeFileSync(generatedSkillPath, '---\nname: generated-demo\ndescription: generated demo\n---\n\nGenerated guidance.\n', 'utf8');
  return env.usageLedger.recordGeneratedSkillLoad({
    runtimeSessionId: 'cli',
    episodeId,
    skill: {
      capabilityHandle: 'cap-generated',
      routingName: 'generated-demo',
      skillFilePath: generatedSkillPath,
      guidanceHash: 'generated-hash',
    },
  });
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
    if (env.ledgerPath) {
      try {
        if (fs.existsSync(env.ledgerPath)) fs.chmodSync(env.ledgerPath, 0o600);
        fs.chmodSync(path.dirname(env.ledgerPath), 0o700);
      } catch {
        // best-effort; dir may not exist
      }
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

  test('(a2) curator observation failure after durable admission does not block cursor ack and retries on the next wake', async () => {
    env.restore();
    env = setupEnv('approve', { withCurator: true });
    const episodeId = 'episode:curator-post-ack-retry';
    seedGeneratedSkillLoad(env, episodeId);
    writeLog(env.logFile, [
      makeTurn(1, 'cli', 'Deliver a small report.', 'Delivered the report.', [
        { id: 'send-1', name: 'send_file', arguments: { path: 'report.md' }, result: 'report sent' },
      ], episodeId),
      makeTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.', [], episodeId),
    ]);

    assert.ok(env.ledgerPath, 'expected ledger path');
    fs.chmodSync(env.ledgerPath, 0o400);

    const scheduler = env.makeScheduler();
    const first = await scheduler.runHeartbeat('manual');

    assert.equal(first.advancedFiles, 1, 'durable admission still acknowledges the cursor');
    assert.equal(cursorFor(env).status, 'completed', 'post-ack curator failure must not mark the cursor failed');
    assert.equal(
      env.usageLedger!.listFacts().filter(fact => fact.kind === 'episode-outcome').length,
      0,
      'the failed curator observation recorded no outcome facts yet',
    );

    fs.chmodSync(env.ledgerPath, 0o600);
    const second = await scheduler.runHeartbeat('scheduled');

    assert.equal(second.ran, true);
    const outcomes = env.usageLedger!.listFacts().filter(fact => fact.kind === 'episode-outcome');
    assert.equal(outcomes.length, 1, 'the post-ack observation retries on the next wake');
    assert.equal(outcomes[0]!.episodeId, episodeId);
    assert.equal(outcomes[0]!.outcome, 'verified-success');
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

  test('(b3) admission reports and post-ack observes only the episode touched by the new extraction', async () => {
    env.restore();
    env = setupEnv('approve', { withCurator: true });
    const oldEpisodeId = 'episode:pre-existing';
    const newEpisodeId = 'episode:new-admission';
    seedGeneratedSkillLoad(env, oldEpisodeId);
    seedGeneratedSkillLoad(env, newEpisodeId);

    const oldUnit = makeDeliveryUnit(path.join(env.root, 'logs', 'sessions', 'chat', 'old.jsonl'), oldEpisodeId, 1);
    const oldAdmission = env.pipeline.admitEvidence(oldUnit);
    assert.deepEqual(oldAdmission.admittedEpisodeIds, [oldEpisodeId]);
    await env.pipeline.processSettledLearningEpisodes(new Date('2026-01-01T00:10:00.000Z'), oldUnit);
    assert.deepEqual(env.curator!.observedEpisodeIds, [oldEpisodeId]);

    const newUnit = makeDeliveryUnit(env.logFile, newEpisodeId, 3);
    const newAdmission = env.pipeline.admitEvidence(newUnit);
    assert.deepEqual(newAdmission.admittedEpisodeIds, [newEpisodeId], 'only the new extraction episode is reported');
    await env.pipeline.processSettledLearningEpisodes(new Date('2026-01-01T00:20:00.000Z'), newUnit);

    assert.deepEqual(
      env.curator!.observedEpisodeIds,
      [oldEpisodeId, newEpisodeId],
      'the unrelated pre-existing episode is not re-observed during the new admission',
    );
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

  test('(d1) a discovery wake admits evidence and processes due work in one coordinated report', async () => {
    writeLog(env.logFile, [DELIVERY_TURN, ACCEPTANCE_TURN]);

    const scheduler = env.makeScheduler();
    const result = await scheduler.runHeartbeat('scheduled');

    assert.equal(result.discovery.scanned, true);
    assert.equal(result.discovery.filesScanned, 1);
    assert.equal(result.discovery.unitsProcessed, 1);
    assert.equal(result.ingestion.admittedEpisodes, 1);
    assert.equal(result.ingestion.contradictionSignals, 0);
    assert.equal(result.maturation.maturedEpisodes, 1);
    assert.equal(result.maturation.becameEligible, 1);
    assert.equal(result.review.reviewedEpisodes, 1);
    assert.equal(result.review.reviewedQueueEntries, 0);
    assert.equal(result.review.transitionsByKind.create_current_skill, 1);
    assert.equal(result.curation.ran, false);
  });

  test('(d2) a due settlement wake completes with zero session-log scans', async () => {
    env.restore();
    env = setupEnv('approve', { settlementWindowMs: 200 });
    const baseTime = Date.now();
    const freshDelivery = { ...DELIVERY_TURN, timestamp: new Date(baseTime).toISOString() };
    const freshAcceptance = { ...ACCEPTANCE_TURN, timestamp: new Date(baseTime + 1).toISOString() };
    writeLog(env.logFile, [freshDelivery, freshAcceptance]);

    const scheduler = env.makeScheduler();
    const discovery = await scheduler.runHeartbeat('manual');
    assert.equal(discovery.discovery.filesScanned, 1);
    assert.equal(discovery.ingestion.admittedEpisodes, 1);
    assert.equal(discovery.maturation.maturedEpisodes, 0, 'the first wake admits but does not settle early');
    assert.equal(discovery.review.reviewedEpisodes, 0);
    assert.equal(loadTransitionAudit(env.auditPath).length, 0);

    await new Promise(resolve => setTimeout(resolve, 260));

    const settlement = await scheduler.runHeartbeat('settlement-deadline');
    assert.equal(settlement.discovery.scanned, false, 'settlement wakes skip session-log discovery entirely');
    assert.equal(settlement.discovery.filesScanned, 0);
    assert.equal(settlement.unitsProcessed, 0);
    assert.equal(settlement.ingestion.admittedEpisodes, 0);
    assert.equal(settlement.maturation.maturedEpisodes, 1);
    assert.equal(settlement.maturation.becameEligible, 1);
    assert.equal(settlement.review.reviewedEpisodes, 1);
    assert.equal(settlement.review.transitionsByKind.create_current_skill, 1);
    assert.equal(cursorFor(env).byteOffset, fs.statSync(env.logFile).size, 'settlement review preserves the acknowledged cursor');
  });

  test('(d3) restart recovery retains due settlement work and reports it on startup', async () => {
    env.restore();
    env = setupEnv('approve', { settlementWindowMs: 120 });
    const baseTime = Date.now();
    const freshDelivery = { ...DELIVERY_TURN, timestamp: new Date(baseTime).toISOString() };
    const freshAcceptance = { ...ACCEPTANCE_TURN, timestamp: new Date(baseTime + 1).toISOString() };
    writeLog(env.logFile, [freshDelivery, freshAcceptance]);

    const firstScheduler = env.makeScheduler();
    const admitted = await firstScheduler.runHeartbeat('manual');
    assert.equal(admitted.ingestion.admittedEpisodes, 1);
    assert.equal(admitted.review.reviewedEpisodes, 0, 'the pre-deadline wake only admits evidence');
    assert.equal(loadTransitionAudit(env.auditPath).length, 0);

    await new Promise(resolve => setTimeout(resolve, 180));

    const restartedScheduler = env.makeScheduler();
    const recovered = await restartedScheduler.runHeartbeat('startup');

    assert.equal(recovered.maturation.maturedEpisodes, 1);
    assert.equal(recovered.review.reviewedEpisodes, 1);
    assert.equal(recovered.review.transitionsByKind.create_current_skill, 1);
    assert.equal(loadTransitionAudit(env.auditPath).length, 1, 'restart recovery commits the due settlement transition exactly once');
    assert.equal(Object.keys(loadCurrentSkillRegistry(env.registryPath).capabilities).length, 1);
  });

  test('(d4) queue review failure preserves settled review counts and reports review stage failure', async () => {
    writeLog(env.logFile, [DELIVERY_TURN, ACCEPTANCE_TURN]);
    env.pipeline.reviewSkillEvolutionQueueEntries = async () => {
      throw new Error('review queue state write failed');
    };

    const scheduler = env.makeScheduler();
    const result = await scheduler.runHeartbeat('manual');

    assert.equal(result.maturation.status, 'succeeded');
    assert.equal(result.maturation.maturedEpisodes, 1);
    assert.equal(result.review.status, 'failed');
    assert.match(result.review.errorMessage ?? '', /review queue state write failed/);
    assert.equal(result.review.reviewedEpisodes, 1, 'the settled episode review survives the later queue failure');
    assert.equal(result.review.reviewedQueueEntries, 0);
    assert.equal(result.review.transitionsByKind.create_current_skill, 1);
    assert.equal(loadTransitionAudit(env.auditPath).length, 1, 'the completed Capability Transition remains durable');
    assert.equal(cursorFor(env).byteOffset, fs.statSync(env.logFile).size, 'review-stage failure still preserves the acknowledged cursor');
  });

  test('(d5) curation failure preserves completed capability work and reports curation stage failure', async () => {
    env.restore();
    env = setupEnv('approve', { withCurator: true });
    writeLog(env.logFile, [DELIVERY_TURN, ACCEPTANCE_TURN]);

    assert.ok(env.curator, 'expected runtime curator');
    env.curator.runDue = async () => {
      throw new Error('EACCES: curation state write failed');
    };

    const scheduler = env.makeScheduler();
    const result = await scheduler.runHeartbeat('manual');

    assert.equal(result.maturation.status, 'succeeded');
    assert.equal(result.maturation.maturedEpisodes, 1);
    assert.equal(result.review.status, 'succeeded');
    assert.equal(result.review.reviewedEpisodes, 1);
    assert.equal(result.review.transitionsByKind.create_current_skill, 1);
    assert.equal(result.curation.status, 'failed');
    assert.match(result.curation.errorMessage ?? '', /curation state write failed/);
    assert.equal(result.curation.ran, false);
    assert.equal(loadTransitionAudit(env.auditPath).length, 1, 'curation failure must not undo the completed Capability Transition');
    assert.equal(Object.keys(loadCurrentSkillRegistry(env.registryPath).capabilities).length, 1);
    assert.equal(cursorFor(env).byteOffset, fs.statSync(env.logFile).size, 'curation failure still preserves the acknowledged cursor');
  });

});
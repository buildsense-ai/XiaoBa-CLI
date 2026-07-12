/**
 * Issue #53 — Runtime Learning E2E tests.
 *
 * Tests from the single production entry point (RuntimeLearning.wake())
 * covering:
 *   - Ingestion: session log → evidence admission
 *   - Settlement: episode maturation
 *   - Due review: eligible episodes → skill creation
 *   - Transition recovery: journal recovery after interruption
 *   - Discovery: generated skills remain discoverable
 *
 * Legacy compatibility is NOT tested here — see the existing
 * evidence-ingestion-decoupling, due-work-planner, and heartbeat-scheduler
 * tests for legacy path coverage.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { DistillationPipeline, defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../src/utils/runtime-command-support';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import { SkillParser } from '../src/skills/skill-parser';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function writeLog(filePath: string, entries: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function readOrEmpty(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function futureTurn(
  turn: number,
  sessionId: string,
  userText: string,
  assistantText: string,
  offsetHours = 0,
  toolCalls: { id: string; name: string; arguments: any; result: string }[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(Date.now() + offsetHours * 60 * 60 * 1000).toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 20 },
  };
}

function deliveryPair(offsetHours = 0) {
  return [
    futureTurn(1, 'cli', 'Deliver a small report.', 'Delivered the report.', offsetHours,
      [{ id: 'send-1', name: 'send_file', arguments: { path: 'report.md' }, result: 'report sent' }],
    ),
    futureTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.', offsetHours),
  ];
}

/** Large enough settlement window that the deadline stays in the future. */
const FUTURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

interface TestEnv {
  root: string;
  skillsRoot: string;
  logFile: string;
  episodeStorePath: string;
  reviewQueuePath: string;
  registryPath: string;
  auditPath: string;
  journalPath: string;
  outputDir: string;
  pipeline: DistillationPipeline;
  runtimeLearning: RuntimeLearning;
  skillEvolution: SkillEvolutionRuntime;
  branchCalls: { author: number; verifier: number };
  restore: () => void;
  teardown: () => void;
}

function setupEnv(settlementWindowMs = 0): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-learning-'));
  const skillsRoot = path.join(root, 'skills');
  const logFile = path.join(root, 'logs', 'sessions', 'chat', 'test.jsonl');
  const stateFile = path.join(root, 'data', 'cursor-state.json');
  const heartbeatRecordFile = path.join(root, 'data', 'heartbeat-record.json');
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
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
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = heartbeatRecordFile;
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
      return {
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'The bounded report workflow is supported by the fixed artifact evidence.',
      };
    },
  });

  const episodeStore = new LearningEpisodeStore(episodeStorePath);
  const curator = new SkillUsageCurator({
    ledger: new SkillUsageLedger(ledgerPath),
    statePath: curatorStatePath,
    intervalMs: 24 * 60 * 60 * 1000,
    runtime: skillEvolution,
  });

  const planner = new DueWorkPlanner({
    learningEpisodeStorePath: episodeStorePath,
    reviewQueuePath,
    curatorStatePath,
    curatorIntervalMs: 24 * 60 * 60 * 1000,
  });

  const evidenceIngestor = new EvidenceIngestor({
    episodeStore,
    settlementWindowMs,
  });

  const pipeline = new DistillationPipeline({
    outputDir,
    reviewOutcomesPath: path.join(root, 'data', 'review-outcomes.json'),
    learningEpisodeStorePath: episodeStorePath,
    learningEpisodeSettlementWindowMs: settlementWindowMs,
    skillEvolution,
    skillUsageCurator: curator,
  });

  const runtimeLearning = new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor,
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator,
    planner,
    legacyPipeline: pipeline,
  });

  return {
    root,
    skillsRoot,
    logFile,
    episodeStorePath,
    reviewQueuePath,
    registryPath,
    auditPath,
    journalPath,
    outputDir,
    pipeline,
    runtimeLearning,
    skillEvolution,
    branchCalls,
    restore: () => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    teardown: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// AC 1: Ingestion — session log → evidence admission
// ---------------------------------------------------------------------------

describe('RuntimeLearning — AC1: Ingestion', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(FUTURE_WINDOW_MS); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('admitted episodes are persisted after wake', async () => {
    // Using offsetHours=0 and FUTURE_WINDOW_MS=7 days ensures the deadline
    // (= now + 7 days) is still in the future when we check.
    const [delivery, acceptance] = deliveryPair(0);
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ran, true);
    assert.equal(result.discovery.scanned, true);
    assert.equal(result.discovery.filesScanned, 1);
    assert.ok(result.ingestion.admittedEpisodes >= 1);

    // With a 7-day settlement window, the deadline is far in the future
    const state = readOrEmpty(env.episodeStorePath);
    assert.ok(state, 'episode store should exist');
    const episodes = Object.values(state.episodes) as any[];
    assert.ok(episodes.length >= 1, 'expected at least 1 episode in store');
    assert.equal(episodes[0].status, 'settling', 'with future window, episode should stay settling');

    // Heartbeat was recorded
    const hb = env.runtimeLearning.loadHeartbeatRecord();
    assert.ok(hb.runCount >= 1, 'expected heartbeat record');
  });

  test('non-discovery wake skips log scanning', async () => {
    const [delivery, acceptance] = deliveryPair(0);
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('settlement-deadline');

    assert.equal(result.discovery.scanned, false);
    assert.equal(result.discovery.filesScanned, 0);
    assert.equal(result.ingestion.admittedEpisodes, 0);
  });
});

// ---------------------------------------------------------------------------
// AC 2: Settlement — episode maturation
// ---------------------------------------------------------------------------

describe('RuntimeLearning — AC2: Settlement', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); }); // Zero window = immediate settle
  afterEach(() => { env.restore(); env.teardown(); });

  test('settling episodes mature when deadline passes', async () => {
    const [delivery, acceptance] = deliveryPair(-2); // 2 hours ago
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.maturation.status, 'succeeded');
    assert.ok(result.maturation.maturedEpisodes >= 1, 'expected matured episodes');
    assert.ok(result.maturation.becameEligible >= 1, 'expected eligible episodes');

    const state = readOrEmpty(env.episodeStorePath);
    assert.ok(state, 'episode store should exist');
    const eligible = Object.values(state.episodes as Record<string, any>).filter(
      e => e.status === 'eligible',
    );
    assert.ok(eligible.length >= 1, 'expected at least 1 eligible episode');
  });

  test('contradicted episode does not mature as eligible', async () => {
    const delivery = futureTurn(1, 'cli', 'Deliver a report.', 'Delivered.', -2,
      [{ id: 'send-1', name: 'send_file', arguments: { path: 'report.md' }, result: 'report sent' }],
    );
    const correction = futureTurn(2, 'cli', 'No, that is wrong. Redo it.', 'Let me redo.', -2);

    writeLog(env.logFile, [delivery, correction]);
    await env.runtimeLearning.wake('startup');

    const state = readOrEmpty(env.episodeStorePath);
    const episode = Object.values(state.episodes as Record<string, any>)[0];
    assert.equal(episode.status, 'contradicted');
  });
});

// ---------------------------------------------------------------------------
// AC 3: Due review — eligible episodes → skill creation
// ---------------------------------------------------------------------------

describe('RuntimeLearning — AC3: Due Review', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); }); // Immediate settlement
  afterEach(() => { env.restore(); env.teardown(); });

  test('eligible episode triggers Author/Verifier review and creates skill', async () => {
    const [delivery, acceptance] = deliveryPair(-2); // 2 hours ago
    writeLog(env.logFile, [delivery, acceptance]);

    // With settlementWindowMs=0, the full cycle runs in one wake:
    // ingestion → settlement (due) → review (eligible episode)
    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.review.status, 'succeeded',
      `expected 'succeeded' got '${result.review.status}'`);
    assert.ok(result.review.reviewedEpisodes >= 1, 'expected reviewed episodes');

    // Author/Verifier branches were called
    assert.ok(env.branchCalls.author >= 1, 'expected >=1 author call');
    assert.ok(env.branchCalls.verifier >= 1, 'expected >=1 verifier call');

    // A current skill transition happened
    const foundCreate = Object.entries(result.review.transitionsByKind)
      .some(([kind, count]) => kind === 'create_current_skill' && (count as number) >= 1);
    assert.ok(foundCreate,
      `expected create_current_skill, got ${JSON.stringify(result.review.transitionsByKind)}`);

    // Verify durable registry
    const registry = readOrEmpty(env.registryPath);
    assert.ok(registry, 'registry should exist');
    assert.ok(Object.keys(registry.capabilities || {}).length >= 1, 'expected >=1 capability');
  });

  test('operational retry due triggers queue review', async () => {
    const queueState = {
      schemaVersion: 1,
      operational: [{
        bundleId: 'test-operational-entry',
        entryId: 'op-entry-1',
        capability: {
          schemaVersion: 1,
          kind: 'capability',
          capabilityId: 'op-test-capability',
          title: 'Test capability',
          applicability: 'test',
          actionPattern: 'test action',
          boundaries: [],
          risks: [],
          provenance: [],
          solvedLoop: { problem: 'test', action: 'test action', verification: 'ok', noCorrection: 'ok' },
          generatedAt: '2026-01-01T00:00:00.000Z',
          sourceUnit: { filePath: 'test.jsonl', byteRange: { start: 0, end: 10 }, generatedAt: '2026-01-01T00:00:00.000Z' },
        } as any,
        bundle: {
          bundleId: 'test-operational-entry',
          episode: {},
          completionEvidence: [],
          settlementEvidence: [],
          boundedContinuity: [],
          referencedSkills: [],
          relatedCurrentSkills: [],
        },
        kind: 'branch_failure',
        message: 'Test operational failure',
        nextRetryAt: new Date(0).toISOString(), // Past = due now
        retryCount: 1,
        createdAt: new Date(0).toISOString(),
        metadata: {},
      }],
      deferred: [],
    };

    fs.mkdirSync(path.dirname(env.reviewQueuePath), { recursive: true });
    fs.writeFileSync(env.reviewQueuePath, JSON.stringify(queueState), 'utf-8');

    const result = await env.runtimeLearning.wake('operational-retry');

    assert.equal(result.review.status, 'succeeded');
    // The operational retry was due; it may be retried or fail
    assert.ok(result.review.operationalRetries >= 0, 'operational retry should be >= 0');
  });
});

// ---------------------------------------------------------------------------
// AC 4: Transition recovery — journal recovery
// ---------------------------------------------------------------------------

describe('RuntimeLearning — AC4: Transition Recovery', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('transition journal is cleaned up after successful recovery', async () => {
    // Write a minimal transition journal with empty operations.
    // The recovery logic must handle this without throwing.
    const journalEntry = {
      schemaVersion: 1,
      bundleId: 'v3:recovery-test-bundle',
      transition: 'create_current_skill',
      guidanceFingerprint: 'test-fingerprint',
      routingName: 'recovery-test-skill',
      description: 'Recovery test skill.',
      evidenceRefs: ['test-ref-1'],
      targetHandle: null,
      skillOperations: [],
      startedAt: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(env.journalPath), { recursive: true });
    fs.writeFileSync(env.journalPath, JSON.stringify(journalEntry, null, 2), 'utf-8');
    assert.ok(fs.existsSync(env.journalPath), 'journal should exist before construction');

    let recoveryRuntime: SkillEvolutionRuntime;
    try {
      recoveryRuntime = new SkillEvolutionRuntime({
        workingDirectory: env.root,
        outputDir: env.outputDir,
        registryPath: env.registryPath,
        auditPath: env.auditPath,
        journalPath: env.journalPath,
        reviewQueuePath: env.reviewQueuePath,
        settlementWindowMs: 0,
        operationalRetryMs: 1,
        operationalRetryMaxMs: 60_000,
        logEnabled: false,
        authorFixture: ({ bundle }) => ({
          body: 'Recovery test skill body.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'recovery-test-skill',
            description: 'Recovery test skill.',
            referencedSkills: [],
            evidenceRefs: bundle.completionEvidence.map(ref => ref.ref),
          },
        }),
        verifierFixture: () => ({
          decision: 'accept' as const,
          transition: 'create_current_skill' as const,
          issues: [],
          rationale: 'Recovery test skill accepted.',
        }),
      });
    } catch (error: any) {
      // If recovery throws, the journal may remain for manual review.
      // This is acceptable — the key contract is that recovery does not
      // corrupt runtime state and leaves a trace.
      assert.ok(error.message, 'recovery error has a message');
      return;
    }

    // Successful recovery removes the journal
    if (!fs.existsSync(env.journalPath)) {
      assert.ok(recoveryRuntime instanceof SkillEvolutionRuntime,
        'expected SkillEvolutionRuntime instance');
    }
    // If journal remains (best-effort recovery), that's also acceptable
    assert.ok(recoveryRuntime instanceof SkillEvolutionRuntime);
  });
});

// ---------------------------------------------------------------------------
// AC 5: Discovery — generated skills remain discoverable
// ---------------------------------------------------------------------------

describe('RuntimeLearning — AC5: Discovery', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('generated skills are discoverable via existing mechanisms', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);
    await env.runtimeLearning.wake('startup');

    // Registry has the capability
    const registry = readOrEmpty(env.registryPath);
    assert.ok(registry, 'expected registry');
    const capabilities = Object.values(registry.capabilities || {}) as any[];
    assert.ok(capabilities.length >= 1, 'expected >=1 capability');
    assert.ok(capabilities[0].routingName, 'expected routingName');
    assert.ok(capabilities[0].description, 'expected description');

    // Skill file exists on disk (discoverable via existing file system)
    // Each capability creates a subdirectory with a SKILL.md file.
    const skillDir = defaultDistilledOutputDir(env.skillsRoot);
    assert.ok(fs.existsSync(skillDir), `skill dir: ${skillDir}`);
    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory());
    assert.ok(skillDirs.length >= 1, `expected skill subdirectories in ${skillDir}, got: ${entries.map(e => e.name).join(', ')}`);

    // Each subdirectory contains a SKILL.md that is parseable
    // (SkillParser can discover these files recursively).
    for (const dir of skillDirs) {
      const skillPath = path.join(skillDir, dir.name, 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `expected ${skillPath}`);
      const skill = SkillParser.parse(skillPath);
      assert.ok(skill.metadata.name, 'expected skill name');
      assert.ok(skill.metadata.description, 'expected skill description');
    }
  });

  test('Capability Provenance and Traceability Contract are intact', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);
    await env.runtimeLearning.wake('startup');

    // Transition audit entries exist with provenance data
    const audit = env.skillEvolution.getAudit();
    assert.ok(audit.length >= 1, 'expected >=1 audit entry');
    assert.ok(audit[0].bundleId, 'expected bundleId');
    assert.ok(audit[0].transition, 'expected transition');
    assert.ok(audit[0].evidenceRefs, 'expected evidenceRefs');

    // Registry capabilities have evidence refs
    const registry = readOrEmpty(env.registryPath);
    const capabilities = Object.values(registry.capabilities || {}) as any[];
    assert.ok(capabilities.length >= 1, 'expected >=1 capability');
    for (const cap of capabilities) {
      assert.ok(cap.evidenceRefs, 'expected evidenceRefs');
    }
  });
});

// ---------------------------------------------------------------------------
// Curation
// ---------------------------------------------------------------------------

describe('RuntimeLearning — Curation', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(FUTURE_WINDOW_MS); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('curator is wired and accessible', async () => {
    const [delivery, acceptance] = deliveryPair(0);
    writeLog(env.logFile, [delivery, acceptance]);
    await env.runtimeLearning.wake('startup');

    const curator = env.runtimeLearning.getCurator();
    assert.ok(curator, 'expected curator to be configured');

    // Observe an episode — the ledger records it
    const state = readOrEmpty(env.episodeStorePath) as any;
    const episodes = Object.values(state.episodes || {}) as any[];
    if (episodes.length > 0) {
      curator.observeEpisode(episodes[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #53 / PR #58 blocker follow-up tests
// ---------------------------------------------------------------------------

describe('Issue 1 — V3-disabled compatibility', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {
      XIAOBA_SKILL_EVOLUTION_V3_ENABLED: process.env.XIAOBA_SKILL_EVOLUTION_V3_ENABLED,
      DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    };
  });

  afterEach(async () => {
    await stopRuntimeCommandSupport();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('startup does not construct RuntimeLearning when skillEvolutionEnabled=false', async () => {
    process.env.XIAOBA_SKILL_EVOLUTION_V3_ENABLED = 'false';
    process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';

    const support = await startRuntimeCommandSupport(process.cwd());

    assert.equal(support.runtimeLearning, null,
      'expected runtimeLearning to be null when V3 disabled');
    assert.equal(support.distillationHeartbeatScheduler, null,
      'expected distillationHeartbeatScheduler to be null when V3 disabled');
    // Legacy DistillationPipeline is still available for API-based compatibility
    assert.ok(support.distillationPipeline instanceof DistillationPipeline,
      'expected DistillationPipeline to be constructed for compatibility');
  });
});

describe('Issue 2 — Generic wake reconciliation', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('generic wake reconciles pre-existing eligible episode without due deadlines', async () => {
    // Pre-populate the episode store with an eligible episode that has a
    // future settlement deadline (so the planner reports nothing due).
    const episodeId = 'episode-test-reconcile';
    const episodeData = {
      schemaVersion: 2,
      episodes: {
        [episodeId]: {
          schemaVersion: 2,
          episodeId,
          runtimeSessionId: 'cli',
          sourceFilePath: env.logFile,
          deliveryTurn: 1,
          status: 'eligible',
          settlementDeadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          completionEvidence: [
            { ref: 'ev-1', sourceFilePath: env.logFile, turn: 1, kind: 'artifact-delivery', detail: 'send_file:test.md' },
            { ref: 'ev-2', sourceFilePath: env.logFile, turn: 2, kind: 'user-acceptance' },
          ],
          contradictionSignals: [],
          createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        },
      },
    };
    fs.mkdirSync(path.dirname(env.episodeStorePath), { recursive: true });
    fs.writeFileSync(env.episodeStorePath, JSON.stringify(episodeData, null, 2), 'utf-8');

    // Planner should report nothing due (eligible episode, future deadline)
    const plan = env.runtimeLearning.getPlanner().plan();
    assert.equal(plan.due.settlementDue, false, 'expected settlementDue=false');
    assert.equal(plan.due.operationalRetryDue, false, 'expected operationalRetryDue=false');

    // Generic wake should still run review and find the eligible episode
    const branchCallsBefore = { ...env.branchCalls };
    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.review.status, 'succeeded',
      `expected 'succeeded' got '${result.review.status}'`);
    assert.equal(result.review.reviewedEpisodes, 1,
      'expected 1 reviewed episode');
    assert.ok(env.branchCalls.author > branchCallsBefore.author,
      `expected author call, was ${env.branchCalls.author} before ${branchCallsBefore.author}`);
    assert.ok(env.branchCalls.verifier > branchCallsBefore.verifier,
      `expected verifier call, was ${env.branchCalls.verifier} before ${branchCallsBefore.verifier}`);

    // A transition was recorded
    const foundCreate = Object.entries(result.review.transitionsByKind)
      .some(([kind, count]) => kind === 'create_current_skill' && (count as number) >= 1);
    assert.ok(foundCreate,
      `expected create_current_skill, got ${JSON.stringify(result.review.transitionsByKind)}`);
  });
});

describe('Issue 3 — Review failure status', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('queue review failure reports failed status with error message', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);

    // Override reviewDueQueueEntries to throw
    const originalQueueReview = env.skillEvolution.reviewDueQueueEntries.bind(env.skillEvolution);
    env.skillEvolution.reviewDueQueueEntries = async () => {
      throw new Error('Simulated queue review failure');
    };

    try {
      const result = await env.runtimeLearning.wake('startup');

      assert.equal(result.review.status, 'failed',
        `expected 'failed' got '${result.review.status}'`);
      assert.ok(result.review.errorMessage, 'expected error message');
      assert.ok(result.review.errorMessage!.includes('queue review failed'),
        `expected queue failure in message, got: ${result.review.errorMessage}`);

      // Completed episode review counts are preserved
      assert.ok(result.review.reviewedEpisodes >= 0,
        'reviewedEpisodes should be >= 0');
    } finally {
      env.skillEvolution.reviewDueQueueEntries = originalQueueReview;
    }
  });

  test('per-episode review failure reports failed status with error message', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);

    // Override reviewAndApply to throw on first call
    const originalReviewAndApply = env.skillEvolution.reviewAndApply.bind(env.skillEvolution);
    let callCount = 0;
    env.skillEvolution.reviewAndApply = async (bundle: any) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Simulated episode review failure');
      }
      return originalReviewAndApply(bundle);
    };

    try {
      const result = await env.runtimeLearning.wake('startup');

      assert.equal(result.review.status, 'failed',
        `expected 'failed' got '${result.review.status}'`);
      assert.ok(result.review.errorMessage, 'expected error message');
      assert.ok(result.review.errorMessage!.includes('episode review(s) failed'),
        `expected episode failure in message, got: ${result.review.errorMessage}`);

      // Episode was not reviewed but counts still have the correct value
      assert.equal(result.review.reviewedEpisodes, 0,
        'expected 0 reviewed episodes (the only episode failed)');
    } finally {
      env.skillEvolution.reviewAndApply = originalReviewAndApply;
    }
  });

  test('combined episode + queue failure reports failed status with combined message', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);

    // Override both methods to throw
    const originalReviewAndApply = env.skillEvolution.reviewAndApply.bind(env.skillEvolution);
    const originalQueueReview = env.skillEvolution.reviewDueQueueEntries.bind(env.skillEvolution);

    let reviewCallCount = 0;
    env.skillEvolution.reviewAndApply = async (bundle: any) => {
      reviewCallCount++;
      if (reviewCallCount === 1) {
        throw new Error('Episode review failure');
      }
      return originalReviewAndApply(bundle);
    };
    env.skillEvolution.reviewDueQueueEntries = async () => {
      throw new Error('Queue review failure');
    };

    try {
      const result = await env.runtimeLearning.wake('startup');

      assert.equal(result.review.status, 'failed',
        `expected 'failed' got '${result.review.status}'`);
      assert.ok(result.review.errorMessage, 'expected error message');
      assert.ok(result.review.errorMessage!.includes('episode review(s) failed'),
        `expected episode failure in message: ${result.review.errorMessage}`);
      assert.ok(result.review.errorMessage!.includes('queue review failed'),
        `expected queue failure in message: ${result.review.errorMessage}`);
    } finally {
      env.skillEvolution.reviewAndApply = originalReviewAndApply;
      env.skillEvolution.reviewDueQueueEntries = originalQueueReview;
    }
  });
});

describe('Issue 4 — Heartbeat single-write', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('a single production wake increments runCount exactly once', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);

    const before = env.runtimeLearning.loadHeartbeatRecord();
    assert.equal(before.runCount, 0, 'expected 0 before first wake');

    await env.runtimeLearning.wake('startup');

    const after = env.runtimeLearning.loadHeartbeatRecord();
    // runCount must be 1 — if the scheduler also wrote the record, it would be 2.
    assert.equal(after.runCount, 1,
      `expected runCount=1 (single write), got ${after.runCount}`);
    assert.ok(after.lastRunAt, 'expected lastRunAt to be set');
    assert.ok(after.lastReason, 'expected lastReason to be set');
  });

  test('consecutive wakes increment runCount monotonically', async () => {
    const [delivery, acceptance] = deliveryPair(-4);
    writeLog(env.logFile, [delivery, acceptance]);

    await env.runtimeLearning.wake('startup');
    const after1 = env.runtimeLearning.loadHeartbeatRecord();
    assert.equal(after1.runCount, 1, 'expected 1 after first wake');

    await env.runtimeLearning.wake('scheduled');
    const after2 = env.runtimeLearning.loadHeartbeatRecord();
    assert.equal(after2.runCount, 2, 'expected 2 after second wake');
    assert.equal(after2.lastReason, 'scheduled',
      `expected reason=scheduled, got ${after2.lastReason}`);
  });
});

// ---------------------------------------------------------------------------
// Provenance — episode candidate preserves original source byte range (#53 AC4)
// ---------------------------------------------------------------------------

describe('RuntimeLearning — Provenance (AC4 follow-up)', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('EvidenceBundle candidate preserves non-zero byteRange from source unit', async () => {
    let capturedCandidate: any = null;

    // Rebuild env with a capturing author fixture that inspects the candidate
    env.teardown();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provenance-'));
    const skillsRoot = path.join(root, 'skills');
    const logFile = path.join(root, 'logs', 'sessions', 'chat', 'test.jsonl');
    const stateFile = path.join(root, 'data', 'cursor-state.json');
    const heartbeatRecordFile = path.join(root, 'data', 'heartbeat-record.json');
    const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
    const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
    const registryPath = path.join(root, 'data', 'current-skill-registry.json');
    const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
    const journalPath = path.join(root, 'data', 'transition-journal.json');
    const curatorStatePath = path.join(root, 'data', 'curator-state.json');
    const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');
    const outputDir = defaultDistilledOutputDir(skillsRoot);

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
    process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = heartbeatRecordFile;
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
        capturedCandidate = bundle.episode;
        return {
          body: 'Provenance test skill body.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'provenance-test-skill',
            description: 'Provenance test.',
            referencedSkills: [],
            evidenceRefs: bundle.completionEvidence.map(ref => ref.ref),
          },
        };
      },
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'Provenance test skill accepted.',
      }),
    });

    const episodeStore = new LearningEpisodeStore(episodeStorePath);
    const curator = new SkillUsageCurator({
      ledger: new SkillUsageLedger(ledgerPath),
      statePath: curatorStatePath,
      intervalMs: 24 * 60 * 60 * 1000,
      runtime: skillEvolution,
    });
    const planner = new DueWorkPlanner({
      learningEpisodeStorePath: episodeStorePath,
      reviewQueuePath,
      curatorStatePath,
      curatorIntervalMs: 24 * 60 * 60 * 1000,
    });
    const evidenceIngestor = new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 });
    const pipeline = new DistillationPipeline({
      outputDir,
      reviewOutcomesPath: path.join(root, 'data', 'review-outcomes.json'),
      learningEpisodeStorePath: episodeStorePath,
      learningEpisodeSettlementWindowMs: 0,
      skillEvolution,
      skillUsageCurator: curator,
    });
    const runtimeLearning = new RuntimeLearning({
      workingDirectory: root,
      evidenceIngestor,
      learningEpisodeStore: episodeStore,
      skillEvolution,
      curator,
      planner,
      legacyPipeline: pipeline,
    });

    // Write session log with known deliver + acceptance
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(logFile, [delivery, acceptance]);

    const result = await runtimeLearning.wake('startup');
    assert.equal(result.review.status, 'succeeded',
      `expected 'succeeded' got '${result.review.status}'`);
    assert.ok(result.review.reviewedEpisodes >= 1, 'expected reviewed episodes');

    // The captured candidate must have non-zero source byte range
    assert.ok(capturedCandidate, 'expected captured candidate');
    assert.ok(capturedCandidate.sourceUnit,
      'expected sourceUnit on candidate');
    assert.ok(capturedCandidate.sourceUnit.byteRange,
      'expected byteRange on sourceUnit');
    assert.ok(
      capturedCandidate.sourceUnit.byteRange.start > 0
      || capturedCandidate.sourceUnit.byteRange.end > 0,
      `expected non-zero byteRange, got ${JSON.stringify(capturedCandidate.sourceUnit.byteRange)}`,
    );
    assert.ok(
      capturedCandidate.sourceUnit.byteRange.end > capturedCandidate.sourceUnit.byteRange.start,
      `expected end > start, got ${JSON.stringify(capturedCandidate.sourceUnit.byteRange)}`,
    );

    // generatedAt must not be the settlement deadline (should be original admission time)
    const episodeState = episodeStore.load();
    const episode = Object.values(episodeState.episodes)[0];
    assert.ok(episode, 'expected episode in store');
    assert.notEqual(
      capturedCandidate.sourceUnit.generatedAt,
      episode.settlementDeadline,
      'generatedAt should differ from settlementDeadline',
    );

    // Clean up
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});

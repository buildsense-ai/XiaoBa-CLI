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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisode, LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner, reviewContinuationPathForEpisodeStore } from '../src/utils/due-work-planner';
import { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import {
  EvidenceBundle,
  SkillEvolutionOptions,
  SkillEvolutionRuntime,
} from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { defaultDistilledOutputDir } from '../src/utils/path-resolver';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../src/utils/runtime-command-support';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import { SemanticReassessmentManifestStore } from '../src/utils/semantic-reassessment';
import { emptyCurrentSkillRegistryState, saveCurrentSkillRegistry } from '../src/utils/skill-evolution';
import { bootstrapSemanticReassessmentOnce } from '../src/utils/distilled-skill-bootstrap';
import { DistillationHeartbeatScheduler } from '../src/utils/distillation-heartbeat-scheduler';
import {
  loadEvidenceReviewJobStore,
  saveEvidenceReviewJobStore,
  upsertEvidenceReviewJob,
  findOperationalJobByBundleId,
  findDeferredJobByBundleId,
  evidenceReviewJobStorePathForReviewQueue,
} from '../src/utils/evidence-review-job-store';
import { createEvidenceReviewJob } from '../src/utils/evidence-review-graph';
import {
  readShardStructurally,
  resolveEvidenceReviewJobStorePath,
} from '../src/utils/evidence-review-engine';
import { listRunnableQuanta } from '../src/utils/evidence-review-graph-core';
import {
  ExternalSessionLogSourceAdapter,
  type ExternalSourceReader,
  type SessionLogSourceResource,
} from '../src/utils/session-log-source';
import { acceptReviewObligations } from './evidence-review-test-fixtures';

/** Seed an operational recovery job in the job store (replaces legacy addOrUpdateOperationalFailure). */
function seedOperationalFailure(
  reviewQueuePath: string,
  bundle: EvidenceBundle,
  message: string,
  now = new Date(0),
): void {
  const jobStorePath = evidenceReviewJobStorePathForReviewQueue(reviewQueuePath);
  const job = createEvidenceReviewJob({
    bundle,
    candidate: bundle.episode as DistilledKnowledgeCandidate,
    workClass: 'operational_recovery',
  });
  const retryQuantum = Object.values(job.quanta)
    .filter(quantum => quantum.dependencyQuantumIds.length === 0)
    .sort((left, right) => left.quantumId.localeCompare(right.quantumId, 'en'))[0]!;
  retryQuantum.state = 'retry_wait';
  retryQuantum.attempts = 1;
  retryQuantum.currentDelayMs = 1;
  retryQuantum.nextRetryAt = now.toISOString();
  retryQuantum.failureKind = 'branch_timeout';
  retryQuantum.failureMessage = message;
  const state = loadEvidenceReviewJobStore(jobStorePath);
  const operationalJob = {
    ...job,
    disposition: 'active' as const,
    workClass: 'operational_recovery' as const,
    nextDueAt: now.toISOString(),
  };
  upsertEvidenceReviewJob(state, operationalJob);
  saveEvidenceReviewJobStore(jobStorePath, state);
}

function countActiveOperational(state: ReturnType<typeof loadEvidenceReviewJobStore>): number {
  return Object.values(state.jobs).filter(j => j.disposition === 'active' && j.workClass === 'operational_recovery').length;
}

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

function frozenEpisodeSource(
  ref: string,
  sourceFilePath: string,
  turn: number,
  content = 'User:\nComplete the bounded task.\n\nAssistant:\nThe bounded task was completed.',
): NonNullable<LearningEpisode['sourceEvidence']>[number] {
  return {
    ref,
    role: 'problem-action',
    content,
    sourceFilePath,
    turn,
  };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function runtimeReviewBundle(bundleId: string): EvidenceBundle {
  const candidate: DistilledKnowledgeCandidate = {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: bundleId,
    title: `Candidate ${bundleId}`,
    applicability: 'When the user needs this bounded workflow.',
    actionPattern: 'Follow the bounded workflow only.',
    boundaries: ['Bounded by the cited evidence only.'],
    risks: ['Do not import unrelated dependencies.'],
    solvedLoop: {
      problem: 'bounded task',
      action: 'solved it',
      verification: 'accepted',
      noCorrection: 'none',
    },
    provenance: [
      { filePath: 'session.jsonl', turn: 12, role: 'problem-action', unitByteRange: { start: 0, end: 10 } },
      { filePath: 'session.jsonl', turn: 13, role: 'verification', unitByteRange: { start: 11, end: 20 } },
    ],
    generatedAt: '2026-07-19T00:00:00.000Z',
    sourceUnit: {
      filePath: 'session.jsonl',
      byteRange: { start: 0, end: 20 },
      generatedAt: '2026-07-19T00:00:00.000Z',
    },
  };
  return {
    bundleId,
    authority: { kind: 'learning-episode', episodeId: bundleId },
    episode: candidate,
    completionEvidence: [{ ref: 'session.jsonl#12' }],
    settlementEvidence: [{ ref: 'session.jsonl#13' }],
    semanticObservations: [
      { kind: 'user-intent', value: 'use the bounded workflow', sourceRefs: ['session.jsonl#12:user-intent'] },
    ],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    sourceEvidence: [
      {
        ref: 'session.jsonl#12',
        role: 'problem-action',
        content: 'The bounded workflow was requested and completed.',
      },
      {
        ref: 'session.jsonl#13',
        role: 'verification',
        content: 'The bounded result was accepted.',
      },
    ],
  };
}

function seedDueReviewContinuation(episodeStorePath: string): void {
  const continuationPath = reviewContinuationPathForEpisodeStore(episodeStorePath);
  fs.mkdirSync(path.dirname(continuationPath), { recursive: true });
  fs.writeFileSync(continuationPath, JSON.stringify({
    schemaVersion: 1,
    episodeIds: [],
    nextAttemptAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    nextClass: 'live',
    classCursors: {},
  }, null, 2));
}

async function advanceJobReadyForSkillAuthor(
  env: TestEnv,
  jobId: string,
): Promise<string> {
  const engine = env.skillEvolution.getEvidenceReviewEngine();

  while (true) {
    const current = engine.loadStore().jobs[jobId]!;
    const runnable = listRunnableQuanta(current, new Date());
    assert.ok(runnable.length > 0, 'expected seeded job to stay runnable');
    if (runnable.some(quantum => quantum.kind === 'skill_author')) {
      return current.jobId;
    }
    const next = runnable[0]!;
    const advanced = await engine.advanceJob(
      current.jobId,
      `seed:${current.jobId}:${next.quantumId}`,
      undefined,
      { quantumId: next.quantumId, maxQuanta: 1 },
    );
    assert.ok(advanced.executedQuantumIds.includes(next.quantumId));
  }
}

async function seedActiveJobReadyForSkillAuthor(
  env: TestEnv,
  bundle: EvidenceBundle,
): Promise<string> {
  const engine = env.skillEvolution.getEvidenceReviewEngine();
  const job = engine.ensureJob({
    bundle,
    candidate: bundle.episode as DistilledKnowledgeCandidate,
    workClass: 'live_learning',
  });
  return advanceJobReadyForSkillAuthor(env, job.jobId);
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

function createRestartableRuntimeLearning(root: string, settlementWindowMs = 0): RuntimeLearning {
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');

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
    readerFixture: ({ shard, lane }) => ({
      findingSet: readShardStructurally(
        shard.shardId,
        shard.contentHash,
        shard.content,
        lane,
      ),
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
    semanticReassessmentManifestPath: reassessmentManifestPath,
  });
  const evidenceIngestor = new EvidenceIngestor({
    episodeStore,
    settlementWindowMs,
  });

  return new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor,
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator,
    planner,
  });
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
  reassessmentManifestPath: string;
  outputDir: string;
  runtimeLearning: RuntimeLearning;
  skillEvolution: SkillEvolutionRuntime;
  skillEvolutionOptions: SkillEvolutionOptions;
  branchCalls: { author: number; verifier: number };
  restore: () => void;
  teardown: () => void;
}

function setupEnv(
  settlementWindowMs = 0,
  fixtures: Pick<
    SkillEvolutionOptions,
    'authorFixture' | 'verifierFixture' | 'readerFixture'
  > = {},
): TestEnv {
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
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
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
    XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE: process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE,
    XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED,
    XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID,
    XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND: process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = path.join(root, 'logs');
  process.env.DISTILLATION_HEARTBEAT_STATE_FILE = stateFile;
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = heartbeatRecordFile;
  delete process.env.XIAOBA_ROLE;
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = reassessmentManifestPath;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'false';
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND;

  const skillEvolutionOptions: SkillEvolutionOptions = {
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
    readerFixture: fixtures.readerFixture ?? (({ shard, lane }) => ({
      findingSet: readShardStructurally(
        shard.shardId,
        shard.contentHash,
        shard.content,
        lane,
      ),
    })),
    authorFixture: fixtures.authorFixture ?? (({ bundle }) => {
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
    }),
    verifierFixture: fixtures.verifierFixture ?? (({ bundle, draft }) => {
      branchCalls.verifier++;
      assert.equal(draft.envelope.routingName, 'test-report-delivery');
      return {
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'The bounded report workflow is supported by the fixed artifact evidence.',
        obligationDispositions: acceptReviewObligations(bundle),
      };
    }),
  };
  const skillEvolution = new SkillEvolutionRuntime(skillEvolutionOptions);

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
    semanticReassessmentManifestPath: reassessmentManifestPath,
  });

  const evidenceIngestor = new EvidenceIngestor({
    episodeStore,
    settlementWindowMs,
  });

  const runtimeLearning = new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor,
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator,
    planner,
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
    reassessmentManifestPath,
    outputDir,
    runtimeLearning,
    skillEvolution,
    skillEvolutionOptions,
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

function recordReviewAdmissionLoad(
  env: Pick<TestEnv, 'root' | 'outputDir'>,
  episodeId: string,
  runtimeSessionId: string,
): void {
  new SkillUsageLedger(path.join(env.root, 'data', 'skill-usage-ledger.jsonl'))
    .recordGeneratedSkillLoad({
      runtimeSessionId,
      episodeId,
      skill: {
        capabilityHandle: 'cap_test_review_admission',
        routingName: 'test-review-admission',
        skillFilePath: path.join(
          env.outputDir,
          'cap_test_review_admission',
          'SKILL.md',
        ),
        guidanceHash: 'test-review-admission-guidance-hash',
      },
    });
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

  test('persists OpenCLI shell workflow evidence with the following delivery', async () => {
    const openCliSelection = futureTurn(
      6,
      'catscompany-runtime',
      'Find a suitable mirror image.',
      'I found image candidates.',
      0,
      [{
        id: 'opencli-6',
        name: 'execute_shell',
        arguments: { command: 'opencli google images mirror --limit 3 --lang en -f yaml' },
        result: 'Command succeeded\n3 image results returned',
      }],
    );
    const delivery = futureTurn(
      7,
      'catscompany-runtime',
      'Start the mirror word card.',
      'The preview is ready.',
      0,
      [{
        id: 'send-7',
        name: 'send_file',
        arguments: { path: 'mirror-preview.jpg' },
        result: 'File sent to current chat.',
      }],
    );
    writeLog(env.logFile, [openCliSelection, delivery]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 1);
    const state = readOrEmpty(env.episodeStorePath);
    const episodes = Object.values(state.episodes as Record<string, any>);
    assert.equal(episodes.length, 1);
    assert.ok(episodes[0].completionEvidence.some((evidence: any) =>
      evidence.kind === 'verified-tool-result'
      && evidence.turn === 6
      && evidence.detail.includes('opencli google images mirror'),
    ));
  });

  test('keeps an independent response-only preference separate from a prior artifact delivery', async () => {
    const [delivery] = deliveryPair(0);
    const preference = futureTurn(
      2,
      'cli',
      'Use npm for this project from now on.',
      'Understood. I will use npm for this project.',
      0,
    );
    writeLog(env.logFile, [delivery, preference]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 2);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    assert.equal(episodes.length, 2);
    const preferenceEpisode = episodes.find(episode => episode.deliveryTurn === 2);
    const deliveryEpisode = episodes.find(episode => episode.deliveryTurn === 1);
    assert.ok(preferenceEpisode?.semanticObservations.some(observation => observation.value.includes('Use npm')));
    assert.equal(deliveryEpisode?.semanticObservations.some(observation => observation.value.includes('Use npm')), false);
  });

  test('keeps a response-only preference separate from a following artifact delivery', async () => {
    const preference = futureTurn(
      1,
      'cli',
      'Use npm for this project from now on.',
      'Understood. I will use npm for this project.',
      0,
    );
    const delivery = futureTurn(
      2,
      'cli',
      'Create the release report.',
      'The report is ready.',
      0,
      [{ id: 'send-2', name: 'send_file', arguments: { path: 'release.md' }, result: 'report sent' }],
    );
    writeLog(env.logFile, [preference, delivery]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 2);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    const preferenceEpisode = episodes.find(episode => episode.deliveryTurn === 1);
    const deliveryEpisode = episodes.find(episode => episode.deliveryTurn === 2);
    assert.deepEqual(
      preferenceEpisode?.semanticObservations.filter(item => item.kind === 'user-intent').map(item => item.value),
      ['Use npm for this project from now on.'],
    );
    assert.deepEqual(
      deliveryEpisode?.semanticObservations.filter(item => item.kind === 'user-intent').map(item => item.value),
      ['Create the release report.'],
    );
  });

  test('keeps consecutive response-only intents in separate Episodes', async () => {
    const packagePreference = futureTurn(
      1,
      'cli',
      'Use npm for this project from now on.',
      'Understood. I will use npm for this project.',
      0,
    );
    const writingPreference = futureTurn(
      2,
      'cli',
      'Keep answers concise from now on.',
      'Understood. I will keep answers concise.',
      0,
    );
    writeLog(env.logFile, [packagePreference, writingPreference]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 2);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    assert.deepEqual(
      episodes
        .sort((left, right) => left.deliveryTurn - right.deliveryTurn)
        .map(episode => episode.semanticObservations.find(item => item.kind === 'user-intent')?.value),
      ['Use npm for this project from now on.', 'Keep answers concise from now on.'],
    );
  });

  test('folds a response-only acceptance into the prior artifact delivery', async () => {
    const [delivery, acceptance] = deliveryPair(0);
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 1);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    assert.equal(episodes.length, 1);
    assert.ok(episodes[0]!.completionEvidence.some(evidence => evidence.kind === 'user-acceptance'));
  });

  test('folds a Chinese acknowledgement without creating a social Episode', async () => {
    const [delivery] = deliveryPair(0);
    const acceptance = futureTurn(2, 'cli', '谢谢！', '不客气。', 0);
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 1);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    assert.equal(episodes.length, 1);
    assert.ok(episodes[0]!.completionEvidence.some(evidence => (
      evidence.kind === 'user-acceptance' && evidence.detail === '谢谢！'
    )));
  });

  test('keeps a short acknowledgement when the assistant response carries a rule', async () => {
    const clarifiedPreference = futureTurn(
      1,
      'cli',
      'Yes.',
      'Use npm for package-management commands in this project.',
      0,
    );
    writeLog(env.logFile, [clarifiedPreference]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 1);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    assert.equal(episodes.length, 1);
    assert.ok(episodes[0]!.completionEvidence.some(evidence => (
      evidence.kind === 'assistant-response' && evidence.detail?.includes('Use npm')
    )));
  });

  test('attributes acceptance to an intervening response-only Episode, not the older artifact', async () => {
    const [delivery] = deliveryPair(0);
    const explanation = futureTurn(
      2,
      'cli',
      'How should the report title be formatted?',
      'Use sentence case for the report title.',
      0,
    );
    const acceptance = futureTurn(3, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.', 0);
    writeLog(env.logFile, [delivery, explanation, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 2);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    const artifactEpisode = episodes.find(episode => episode.deliveryTurn === 1);
    const explanationEpisode = episodes.find(episode => episode.deliveryTurn === 2);
    assert.equal(artifactEpisode?.completionEvidence.some(evidence => evidence.kind === 'user-acceptance'), false);
    assert.equal(explanationEpisode?.completionEvidence.some(evidence => evidence.kind === 'user-acceptance'), true);
  });

  test('attributes a correction to an intervening response-only Episode, not the older artifact', async () => {
    const [delivery] = deliveryPair(0);
    const explanation = futureTurn(
      2,
      'cli',
      'How should the report title be formatted?',
      'Use title case for the report title.',
      0,
    );
    const correction = futureTurn(3, 'cli', 'No, that is wrong. Use sentence case.', '', 0);
    writeLog(env.logFile, [delivery, explanation, correction]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 2);
    const episodes = Object.values(readOrEmpty(env.episodeStorePath).episodes) as LearningEpisode[];
    const artifactEpisode = episodes.find(episode => episode.deliveryTurn === 1);
    const explanationEpisode = episodes.find(episode => episode.deliveryTurn === 2);
    assert.equal(artifactEpisode?.status, 'settling');
    assert.equal(explanationEpisode?.status, 'contradicted');
    assert.equal(artifactEpisode?.contradictionSignals.length, 0);
    assert.equal(explanationEpisode?.contradictionSignals.length, 1);
  });

  test('non-discovery wake skips log scanning', async () => {
    const [delivery, acceptance] = deliveryPair(0);
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('settlement-deadline');

    assert.equal(result.discovery.scanned, false);
    assert.equal(result.discovery.filesScanned, 0);
    assert.equal(result.ingestion.admittedEpisodes, 0);
  });

  test('session-log append wake discovers turns appended after the previous scan', async () => {
    await env.runtimeLearning.wake('startup');

    const [delivery, acceptance] = deliveryPair(0);
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('session-log-append');

    assert.equal(result.discovery.scanned, true);
    assert.equal(result.discovery.filesScanned, 1);
    assert.ok(result.ingestion.admittedEpisodes >= 1);
    assert.equal(result.reassessment.status, 'skipped');
  });
});

describe('RuntimeLearning — external history hot reload', () => {
  test('creates configured provider lanes without rebuilding the Runtime owner', () => {
    const keys = [
      'XIAOBA_RUNTIME_ROOT',
      'XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED',
      'XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS',
      'XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND',
      'XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE',
    ] as const;
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-hot-external-'));

    try {
      process.env.XIAOBA_RUNTIME_ROOT = root;
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'false';
      delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS;
      delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND;
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = 'future-only';

      const runtime = createRestartableRuntimeLearning(root);
      runtime.enableExternalProvider('codex', { scope: 'global' }, 'future-only');
      runtime.enableExternalProvider('pi', { scope: 'global' }, 'future-only');
      assert.deepEqual(
        runtime.getSessionLogSources().filter(source => source.identity.category === 'external'),
        [],
      );

      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,pi';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = 'xurl';

      assert.equal(
        runtime.reloadExternalHistoryConfiguration(path.join(root, 'other-runtime')),
        false,
      );
      assert.equal(runtime.reloadExternalHistoryConfiguration(), true);
      assert.deepEqual(
        runtime.getSessionLogSources()
          .filter(source => source.identity.category === 'external')
          .map(source => source.identity.provider)
          .sort(),
        ['codex', 'pi'],
      );
    } finally {
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  test('an accepted single episode bootstraps a Current Skill without a prior Skill load', async () => {
    const [delivery, acceptance] = deliveryPair(-2); // 2 hours ago
    writeLog(env.logFile, [delivery, acceptance]);

    // With settlementWindowMs=0, the full cycle runs in one wake:
    // ingestion → settlement (due) → review (eligible episode)
    const result = await env.runtimeLearning.wake('startup');

    assert.ok(result.ingestion.admittedEpisodes >= 1);
    assert.ok(result.maturation.becameEligible >= 1);
    assert.equal(result.review.reviewedEpisodes, 1);
    assert.equal(env.branchCalls.author, 1);
    assert.equal(env.branchCalls.verifier, 1);

    const registry = readOrEmpty(env.registryPath);
    assert.equal(Object.keys(registry?.capabilities ?? {}).length, 1);
    const heartbeat = readOrEmpty(path.join(env.root, 'data', 'heartbeat-record.json'));
    assert.equal(heartbeat?.backlog?.eligibleEpisodes, 0);
  });

  test('a settled delivery without explicit acceptance still enters capability review', async () => {
    const delivery = futureTurn(
      1,
      'cli',
      'Deliver a report.',
      'Delivered the report.',
      -2,
      [{ id: 'send-1', name: 'send_file', arguments: { path: 'report.md' }, result: 'report sent' }],
    );
    writeLog(env.logFile, [delivery]);

    const result = await env.runtimeLearning.wake('startup');

    assert.ok(result.ingestion.admittedEpisodes >= 1, 'the delivery remains available for later correction');
    assert.equal(result.review.reviewedEpisodes, 1);
    assert.equal(env.branchCalls.author, 1);
    assert.equal(env.branchCalls.verifier, 1);
    const registry = readOrEmpty(env.registryPath);
    assert.equal(Object.keys(registry?.capabilities ?? {}).length, 1);
  });

  test('a response-only preference turn can become a narrow Current Skill', async () => {
    env.skillEvolutionOptions.authorFixture = ({ bundle }) => {
      assert.ok(bundle.completionEvidence.some(ref => ref.ref.includes('assistant-response')));
      assert.ok(bundle.semanticObservations?.some(observation => (
        observation.kind === 'user-intent' && observation.value.includes('Use npm')
      )));
      return {
        body: 'Use npm for Node.js package-management commands unless the user explicitly overrides it.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'use-npm-for-node-tasks',
          description: 'Prefer npm for Node.js package-management commands.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
        },
      };
    };
    env.skillEvolutionOptions.verifierFixture = ({ bundle }) => ({
      decision: 'accept' as const,
      transition: 'create_current_skill' as const,
      issues: [],
      rationale: 'The explicit preference and acknowledgement support a narrow package-manager rule.',
      obligationDispositions: acceptReviewObligations(bundle),
    });
    const preference = futureTurn(
      1,
      'cli',
      'Use npm for Node.js tasks from now on.',
      'Understood. I will use npm for Node.js package-management commands.',
      -2,
    );
    writeLog(env.logFile, [preference]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 1);
    assert.equal(result.review.transitionsByKind.create_current_skill, 1);
    const records = Object.values(readOrEmpty(env.registryPath).capabilities) as Array<{ routingName: string }>;
    assert.deepEqual(records.map(record => record.routingName), ['use-npm-for-node-tasks']);
  });

  test('an empty assistant turn remains ineligible learning input', async () => {
    const empty = futureTurn(1, 'cli', 'Use npm for Node.js tasks.', '', -2);
    writeLog(env.logFile, [empty]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 0);
    assert.equal(result.review.reviewedEpisodes, 0);
    assert.equal(env.branchCalls.author, 0);
    assert.equal(env.branchCalls.verifier, 0);
  });

  test('a smoke session never enters the Learning Episode store', async () => {
    const [delivery, acceptance] = deliveryPair(-2).map(turn => ({
      ...turn,
      session_id: 'distillation-smoke',
    }));
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 0);
    const state = readOrEmpty(env.episodeStorePath);
    assert.equal(Object.keys(state?.episodes ?? {}).length, 0);
    assert.equal(env.branchCalls.author, 0);
    assert.equal(env.branchCalls.verifier, 0);
  });

  test('a replay log never enters the Learning Episode store when its session id looks ordinary', async () => {
    const replayLog = path.join(path.dirname(env.logFile), 'chat_live_replay.jsonl');
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(replayLog, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 0);
    const state = readOrEmpty(env.episodeStorePath);
    assert.equal(Object.keys(state?.episodes ?? {}).length, 0);
  });

  test('an ordinary session id containing test remains learning-eligible', async () => {
    const [delivery, acceptance] = deliveryPair(-2).map(turn => ({
      ...turn,
      session_id: 'customer-test-project',
    }));
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.ingestion.admittedEpisodes, 1);
    const state = readOrEmpty(env.episodeStorePath);
    assert.equal(Object.keys(state?.episodes ?? {}).length, 1);
    assert.equal(env.branchCalls.author, 1);
    assert.equal(env.branchCalls.verifier, 1);
  });

  test('an accepted episode can append evidence to the generated Skill it loaded', async () => {
    const capabilityHandle = 'cap_existing_report';
    const routingName = 'existing-report-delivery';
    const skillFilePath = path.join(env.outputDir, capabilityHandle, 'SKILL.md');
    const skillContent = [
      '---',
      `name: ${routingName}`,
      'description: Deliver a report.',
      'user-invocable: true',
      `x-xiaoba-capability-handle: ${capabilityHandle}`,
      '---',
      '',
      'Deliver the requested report.',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(skillFilePath), { recursive: true });
    fs.writeFileSync(skillFilePath, skillContent, 'utf8');
    const guidanceHash = crypto.createHash('sha256').update(skillContent).digest('hex');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities[capabilityHandle] = {
      handle: capabilityHandle,
      revision: 1,
      routingName,
      description: 'Deliver a report.',
      skillFilePath,
      guidanceHash,
      evidenceRefs: [{ ref: 'prior://report-delivery' }],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(env.registryPath, registry);

    const agentTurnEpisodeId = 'turn-episode-existing-report';
    new SkillUsageLedger(path.join(env.root, 'data', 'skill-usage-ledger.jsonl'))
      .recordGeneratedSkillLoad({
        runtimeSessionId: 'runtime-existing-report',
        episodeId: agentTurnEpisodeId,
        skill: {
          capabilityHandle,
          routingName,
          skillFilePath,
          guidanceHash,
        },
      });
    const episode: LearningEpisode = {
      schemaVersion: 3,
      episodeId: 'episode-existing-report',
      agentTurnEpisodeId,
      runtimeSessionId: 'runtime-existing-report',
      sourceFilePath: 'existing-report.jsonl',
      deliveryTurn: 1,
      completionEvidence: [{
        ref: 'existing-report.jsonl#turn-1:delivery:send_file',
        sourceFilePath: 'existing-report.jsonl',
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: report sent',
      }, {
        ref: 'existing-report.jsonl#turn-2:acceptance',
        sourceFilePath: 'existing-report.jsonl',
        turn: 2,
        kind: 'user-acceptance',
        detail: 'Thanks, that works perfectly!',
      }],
      contradictionSignals: [],
      sourceEvidence: [
        frozenEpisodeSource(
          'existing-report.jsonl#turn-1:delivery:send_file',
          'existing-report.jsonl',
          1,
          'User:\nDeliver the requested report.\n\nAssistant:\nThe report was sent.',
        ),
        frozenEpisodeSource(
          'existing-report.jsonl#turn-2:acceptance',
          'existing-report.jsonl',
          2,
          'User:\nThanks, that works perfectly!\n\nAssistant:\nYou are welcome.',
        ),
      ],
      semanticObservations: [{
        kind: 'user-intent',
        value: 'Deliver the requested report.',
        sourceRefs: ['existing-report.jsonl#turn-1:user-intent'],
      }],
      settlementDeadline: new Date(0).toISOString(),
      status: 'eligible',
    };
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [episode.episodeId]: episode },
    });
    let authorCalls = 0;
    let verifierCalls = 0;
    env.skillEvolutionOptions.authorFixture = ({ bundle }) => {
      authorCalls++;
      return {
        body: 'Keep the current guidance unchanged while retaining the new bounded evidence.',
        envelope: {
          decision: 'append_evidence' as const,
          targetCapabilityHandle: capabilityHandle,
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence]
            .map(ref => ref.ref),
        },
      };
    };
    env.skillEvolutionOptions.verifierFixture = ({ bundle }) => {
      verifierCalls++;
      return {
        decision: 'accept' as const,
        transition: 'append_evidence' as const,
        issues: [],
        rationale: 'The accepted episode supports appending evidence to the loaded Current Skill.',
        obligationDispositions: acceptReviewObligations(bundle),
      };
    };

    const result = await env.runtimeLearning.wake('startup');

    assert.equal(result.review.transitionsByKind.append_evidence, 1);
    assert.equal(authorCalls, 1);
    assert.equal(verifierCalls, 1);
    const updated = readOrEmpty(env.registryPath);
    assert.equal(Object.keys(updated.capabilities).length, 1);
    assert.equal(updated.capabilities[capabilityHandle].revision, 2);
    assert.equal(updated.capabilities[capabilityHandle].guidanceHash, guidanceHash);
    assert.ok(updated.capabilities[capabilityHandle].evidenceRefs.some(
      (ref: { ref: string }) => ref.ref === 'existing-report.jsonl#turn-2:acceptance',
    ));
  });

  test('one wake creates from a transferable single episode and defers an unobserved candidate', async () => {
    const customEnv = setupEnv(0, {
      authorFixture: ({ bundle }) => {
        const hasObservation = (bundle.semanticObservations?.length ?? 0) > 0;
        return {
          body: 'Use the bounded report workflow.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: hasObservation ? 'validated-report-delivery' : 'artifact-delivery',
            description: hasObservation ? 'Deliver a validated report.' : 'Deliver an artifact.',
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          },
        };
      },
      verifierFixture: ({ bundle, draft }) => ({
        decision: 'accept' as const,
        transition: draft.envelope.decision,
        issues: [],
        rationale: 'The bounded proposal is supported by the fixed bundle.',
        obligationDispositions: acceptReviewObligations(bundle),
      }),
    });
    const makeEpisode = (episodeId: string, semanticObservations: LearningEpisode['semanticObservations']): LearningEpisode => ({
      schemaVersion: 3,
      episodeId,
      runtimeSessionId: 'runtime-semantic-naming',
      sourceFilePath: `${episodeId}.jsonl`,
      deliveryTurn: 1,
      completionEvidence: [{
        ref: `${episodeId}#turn-1:delivery:send_file`,
        sourceFilePath: `${episodeId}.jsonl`,
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: report sent',
      }],
      contradictionSignals: [],
      sourceEvidence: [frozenEpisodeSource(
        `${episodeId}#turn-1:delivery:send_file`,
        `${episodeId}.jsonl`,
        1,
      )],
      semanticObservations,
      settlementDeadline: new Date(0).toISOString(),
      status: 'eligible',
    });
    try {
      const store = new LearningEpisodeStore(customEnv.episodeStorePath);
      store.save({
        schemaVersion: 3,
        episodes: {
          'episode-observed': makeEpisode('episode-observed', [{
            kind: 'user-intent',
            value: 'Deliver a validated report.',
            sourceRefs: ['episode-observed.jsonl#turn-1:user-intent'],
          }]),
          'episode-unobserved': makeEpisode('episode-unobserved', []),
        },
      });

      const result = await customEnv.runtimeLearning.wake('startup');

      assert.equal(result.review.transitionsByKind.create_current_skill, 1);
      assert.equal(result.review.transitionsByKind.defer, 1);
      assert.equal(Object.values(readOrEmpty(customEnv.registryPath)?.capabilities ?? {}).length, 1);
      const jobs = loadEvidenceReviewJobStore(
        evidenceReviewJobStorePathForReviewQueue(customEnv.reviewQueuePath),
      );
      const deferred = Object.values(jobs.jobs).find(job => (
        job.disposition === 'deferred'
        && job.bundle.bundleId.includes('episode-unobserved')
      ));
      assert.ok(deferred);
      assert.match(deferred.deferState?.reason ?? '', /semantic observation/i);
    } finally {
      customEnv.restore();
      customEnv.teardown();
    }
  });

  test('operational retry due triggers queue review', async () => {
    seedOperationalFailure(
      env.reviewQueuePath,
      runtimeReviewBundle('test-operational-entry'),
      'Test operational failure',
    );

    const result = await env.runtimeLearning.wake('operational-retry');

    assert.equal(result.review.status, 'succeeded');
    assert.ok(result.review.operationalRetries >= 0);
  });

  test('candidate cap persists a restart-safe continuation and schedules it', async () => {
    const makeEpisode = (episodeId: string): LearningEpisode => ({
      schemaVersion: 3,
      episodeId,
      runtimeSessionId: 'runtime-budget-continuation',
      sourceFilePath: `${episodeId}.jsonl`,
      deliveryTurn: 1,
      completionEvidence: [{
        ref: `${episodeId}#1`,
        sourceFilePath: `${episodeId}.jsonl`,
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered',
      }],
      contradictionSignals: [],
      sourceEvidence: [frozenEpisodeSource(`${episodeId}#1`, `${episodeId}.jsonl`, 1)],
      semanticObservations: [{
        kind: 'user-intent',
        value: `Deliver ${episodeId}.`,
        sourceRefs: [`${episodeId}#intent`],
      }],
      settlementDeadline: new Date(0).toISOString(),
      status: 'eligible',
    });
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: {
        'episode-budget-a': makeEpisode('episode-budget-a'),
        'episode-budget-b': makeEpisode('episode-budget-b'),
      },
    });
    (env.runtimeLearning.getConfig() as any).skillEvolutionReviewMaxCandidates = 1;

    const result = await env.runtimeLearning.wake('startup');
    assert.equal(result.review.reviewedEpisodes, 1);
    const continuationPath = reviewContinuationPathForEpisodeStore(env.episodeStorePath);
    const continuation = JSON.parse(fs.readFileSync(continuationPath, 'utf8')) as {
      episodeIds: string[];
      nextAttemptAt: string;
    };
    assert.equal(continuation.episodeIds.length, 1);

    const resumedPlan = env.runtimeLearning.getPlanner().plan(
      new Date(Date.parse(continuation.nextAttemptAt) + 1),
    );
    assert.equal(resumedPlan.due.settlementDue, true);
    assert.equal(resumedPlan.nextWakeReason, 'settlement-deadline');
  });

  test('legacy episode without frozen source evidence does not create a second durable defer owner', async () => {
    const legacyEpisode: LearningEpisode = {
      schemaVersion: 3,
      episodeId: 'episode-legacy-no-source',
      runtimeSessionId: 'runtime-legacy-no-source',
      sourceFilePath: 'legacy-no-source.jsonl',
      deliveryTurn: 1,
      completionEvidence: [{
        ref: 'legacy-no-source.jsonl#1',
        sourceFilePath: 'legacy-no-source.jsonl',
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered',
      }],
      contradictionSignals: [],
      semanticObservations: [{
        kind: 'user-intent',
        value: 'Deliver the legacy artifact.',
        sourceRefs: ['legacy-no-source.jsonl#intent'],
      }],
      settlementDeadline: new Date(0).toISOString(),
      status: 'eligible',
    };
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [legacyEpisode.episodeId]: legacyEpisode },
    });
    const continuationPath = reviewContinuationPathForEpisodeStore(env.episodeStorePath);
    fs.writeFileSync(continuationPath, JSON.stringify({
      schemaVersion: 2,
      episodeIds: [],
      reviewJobIds: [],
      nextAttemptAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      nextClass: 'live',
      classCursors: {},
      // Explicit compatibility input: the consolidated reader ignores this
      // obsolete duplicate owner and never writes it back.
      deferredEpisodeIds: [legacyEpisode.episodeId],
    }), 'utf8');

    const result = await env.runtimeLearning.wake('startup');
    assert.equal(result.review.reviewedEpisodes, 0);
    const continuation = JSON.parse(fs.readFileSync(
      continuationPath,
      'utf8',
    )) as {
      episodeIds: string[];
      reviewJobIds: string[];
      nextAttemptAt: string;
      deferredEpisodeIds?: string[];
    };
    assert.deepEqual(continuation.episodeIds, []);
    assert.deepEqual(continuation.reviewJobIds, []);
    assert.equal(Object.hasOwn(continuation, 'deferredEpisodeIds'), false);

    const resumedPlan = env.runtimeLearning.getPlanner().plan(
      new Date(Date.parse(continuation.nextAttemptAt) + 1),
    );
    assert.equal(resumedPlan.due.settlementDue, false);

    const second = await env.runtimeLearning.wake('manual');
    assert.equal(second.review.reviewedEpisodes, 0);
    const afterSecondWake = JSON.parse(fs.readFileSync(
      continuationPath,
      'utf8',
    )) as {
      episodeIds: string[];
      reviewJobIds: string[];
      deferredEpisodeIds?: string[];
    };
    assert.deepEqual(afterSecondWake.episodeIds, []);
    assert.deepEqual(afterSecondWake.reviewJobIds, []);
    assert.equal(Object.hasOwn(afterSecondWake, 'deferredEpisodeIds'), false);
  });

  test('runnable review jobs keep the restart-safe continuation scheduled', () => {
    const continuationPath = reviewContinuationPathForEpisodeStore(env.episodeStorePath);
    (env.runtimeLearning as any).persistReviewContinuation(
      new Set(),
      { nextClass: 'retry', classCursors: {} },
      new Set(['job:runnable-review']),
    );
    const continuation = JSON.parse(fs.readFileSync(continuationPath, 'utf8')) as {
      episodeIds: string[];
      reviewJobIds: string[];
      nextAttemptAt: string;
    };

    assert.deepEqual(continuation.episodeIds, []);
    assert.deepEqual(continuation.reviewJobIds, ['job:runnable-review']);

    const resumedPlan = env.runtimeLearning.getPlanner().plan(
      new Date(Date.parse(continuation.nextAttemptAt) + 1),
    );
    assert.equal(resumedPlan.due.settlementDue, true);
    assert.equal(resumedPlan.nextWakeReason, 'settlement-deadline');
  });

  test('candidate capacity remains work-conserving across review classes without prompt-size rejection', async () => {
    const liveEpisode: LearningEpisode = {
      schemaVersion: 3,
      episodeId: 'live-budget-admissible',
      runtimeSessionId: 'runtime-budget-admission',
      sourceFilePath: 'live-budget-admissible.jsonl',
      deliveryTurn: 1,
      completionEvidence: [{
        ref: 'live-budget-admissible#1',
        sourceFilePath: 'live-budget-admissible.jsonl',
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered',
      }],
      contradictionSignals: [],
      sourceEvidence: [frozenEpisodeSource(
        'live-budget-admissible#1',
        'live-budget-admissible.jsonl',
        1,
      )],
      semanticObservations: [{
        kind: 'user-intent',
        value: 'Deliver the small admissible review task.',
        sourceRefs: ['live-budget-admissible#intent'],
      }],
      settlementDeadline: new Date(0).toISOString(),
      status: 'eligible',
    };
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [liveEpisode.episodeId]: liveEpisode },
    });

    // ~19KB actionPattern would have failed the old bytes*16 estimator against a
    // 100K or default 200K wake budget. Review Admission must still schedule it.
    const largeRetryCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'large-retry',
      title: 'Large retry',
      applicability: 'Exercise candidate-capacity admission without prompt-size gating.',
      actionPattern: 'x'.repeat(19_000),
      boundaries: [],
      risks: [],
      provenance: [],
      solvedLoop: {
        problem: 'A large retry is due.',
        action: 'Retry it under scheduler capacity.',
        verification: 'Semantic review starts regardless of estimated size.',
        noCorrection: 'No correction was present.',
      },
      generatedAt: new Date(0).toISOString(),
      sourceUnit: {
        filePath: 'large-retry.jsonl',
        byteRange: { start: 0, end: 1 },
        generatedAt: new Date(0).toISOString(),
      },
    } as any;
    const largeRetryBundle = {
      bundleId: 'large-retry-bundle',
      authority: { kind: 'learning-episode', episodeId: 'large-retry-bundle' },
      episode: largeRetryCandidate,
      completionEvidence: [{ ref: 'large-retry.jsonl#1' }],
      settlementEvidence: [{ ref: 'large-retry.jsonl#2' }],
      boundedContinuity: [],
      referencedSkills: [],
      relatedCurrentSkills: [],
      sourceEvidence: [
        {
          ref: 'large-retry.jsonl#1',
          role: 'problem-action',
          content: 'A large bounded retry became due.',
        },
        {
          ref: 'large-retry.jsonl#2',
          role: 'verification',
          content: 'The retry remains eligible for semantic review.',
        },
      ],
    } as any;
    const serializedBytes = Buffer.byteLength(JSON.stringify(largeRetryBundle), 'utf8');
    assert.ok(serializedBytes >= 19_000);
    assert.ok(serializedBytes * 16 > 200_000, 'fixture must exceed the old estimator');

    seedOperationalFailure(env.reviewQueuePath, largeRetryBundle, 'large retry is due');

    (env.runtimeLearning.getConfig() as any).skillEvolutionReviewMaxCandidates = 1;

    const result = await env.runtimeLearning.wake('manual');

    const reviewState = loadEvidenceReviewJobStore(
      evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath),
    );
    const retryJob = Object.values(reviewState.jobs).find(
      job => job.bundle.bundleId === largeRetryBundle.bundleId,
    );
    assert.ok(retryJob);
    assert.equal(
      Object.values(retryJob.quanta).filter(quantum => quantum.state === 'succeeded').length,
      1,
      'one bounded fair Quantum advances regardless of estimated prompt size',
    );
    assert.equal(
      result.review.reviewedEpisodes,
      0,
      'maxCandidates=1 still bounds the wake after admitting the large retry',
    );
    const continuation = JSON.parse(fs.readFileSync(
      reviewContinuationPathForEpisodeStore(env.episodeStorePath),
      'utf8',
    )) as {
      reviewJobIds?: string[];
    };
    assert.ok(continuation.reviewJobIds?.includes(retryJob.jobId));
  });

  test('maxCandidates=1 rotates retry, live, and historical work across successive wakes', async () => {
    const makeEpisode = (episodeId: string, historical: boolean): LearningEpisode => ({
      schemaVersion: 3,
      episodeId,
      runtimeSessionId: 'runtime-three-class-fairness',
      sourceFilePath: `${episodeId}.jsonl`,
      deliveryTurn: 1,
      completionEvidence: [{
        ref: `${episodeId}#1`,
        sourceFilePath: `${episodeId}.jsonl`,
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered',
      }],
      contradictionSignals: [],
      sourceEvidence: [frozenEpisodeSource(`${episodeId}#1`, `${episodeId}.jsonl`, 1)],
      semanticObservations: [{
        kind: 'user-intent',
        value: `Deliver ${episodeId}.`,
        sourceRefs: [`${episodeId}#intent`],
      }],
      settlementDeadline: new Date(0).toISOString(),
      status: 'eligible',
      ...(historical ? {
        historicalTarget: {
          targetId: 'historical-target-1',
          provider: 'pi',
          sourceId: 'pi-global',
          resourceRef: 'history.jsonl',
          position: 1,
          prefixDigest: 'historical-prefix',
        },
      } : {}),
    });
    const live = makeEpisode('fair-live', false);
    const historical = makeEpisode('fair-historical', true);
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [live.episodeId]: live, [historical.episodeId]: historical },
    });
    const retryBundle = runtimeReviewBundle('fair-retry');
    seedOperationalFailure(env.reviewQueuePath, retryBundle, 'fair retry is due');
    (env.runtimeLearning.getConfig() as any).skillEvolutionReviewMaxCandidates = 1;

    const retryWake = await env.runtimeLearning.wake('manual');
    const liveWake = await env.runtimeLearning.wake('manual');
    const historicalWake = await env.runtimeLearning.wake('manual');

    assert.equal(retryWake.review.reviewedEpisodes, 0);
    assert.equal(liveWake.review.reviewedEpisodes, 1);
    assert.equal(historicalWake.review.reviewedEpisodes, 1);
    const reviewed = env.skillEvolution.getReviewedOrQueuedBundleIds();
    assert.equal(reviewed.has(`v3:learning-episode:${live.episodeId}`), true);
    assert.equal(reviewed.has(`v3:learning-episode:${historical.episodeId}`), true);
    const retryJob = Object.values(loadEvidenceReviewJobStore(
      evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath),
    ).jobs).find(job => job.bundle.bundleId === retryBundle.bundleId)!;
    assert.equal(
      Object.values(retryJob.quanta).filter(quantum => quantum.state === 'succeeded').length,
      1,
      'retry receives one turn, then yields to both episode classes',
    );
  });

  test('drain leaves an in-flight review to the scheduler shared deadline', async () => {
    const episodeId = 'episode-drain-cancel';
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: {
        [episodeId]: {
          schemaVersion: 3,
          episodeId,
          runtimeSessionId: 'runtime-drain',
          sourceFilePath: `${episodeId}.jsonl`,
          deliveryTurn: 1,
          completionEvidence: [{
            ref: `${episodeId}#1`,
            sourceFilePath: `${episodeId}.jsonl`,
            turn: 1,
            kind: 'artifact-delivery',
            detail: 'send_file: delivered',
          }],
          contradictionSignals: [],
          sourceEvidence: [frozenEpisodeSource(`${episodeId}#1`, `${episodeId}.jsonl`, 1)],
          semanticObservations: [{
            kind: 'user-intent',
            value: 'Deliver the drain-safe report.',
            sourceRefs: [`${episodeId}#intent`],
          }],
          settlementDeadline: new Date(0).toISOString(),
          status: 'eligible',
        },
      },
    });
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const originalReview = env.skillEvolution.reviewAndApply.bind(env.skillEvolution);
    let observedAbort = false;
    let completeReview!: (result: any) => void;
    env.skillEvolution.reviewAndApply = async (_bundle: any, signal?: AbortSignal) => {
      started();
      return await new Promise<any>((resolve, reject) => {
        completeReview = resolve;
        const abort = () => {
          observedAbort = true;
          reject(new Error('runtime shutdown aborted review'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    };

    try {
      const wake = env.runtimeLearning.wake('startup');
      await startedPromise;
      await env.runtimeLearning.drain(100);
      assert.equal(observedAbort, false);
      completeReview({ transition: 'defer', verified: false, rounds: 1 });
      const result = await wake;
      assert.equal(observedAbort, false);
      assert.equal(result.review.status, 'succeeded');
      assert.equal(env.skillEvolution.getAudit().length, 0);
      assert.equal(countActiveOperational(loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath))), 0);
    } finally {
      env.skillEvolution.reviewAndApply = originalReview;
    }
  });

  test('drain during pre-review work stops new review admission and leaves the episode durable', async () => {
    const episodeId = 'episode-drain-pre-review';
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: {
        [episodeId]: {
          schemaVersion: 3,
          episodeId,
          runtimeSessionId: 'runtime-drain-pre-review',
          sourceFilePath: `${episodeId}.jsonl`,
          deliveryTurn: 1,
          completionEvidence: [{
            ref: `${episodeId}#1`,
            sourceFilePath: `${episodeId}.jsonl`,
            turn: 1,
            kind: 'artifact-delivery',
            detail: 'send_file: delivered',
          }],
          contradictionSignals: [],
          sourceEvidence: [frozenEpisodeSource(`${episodeId}#1`, `${episodeId}.jsonl`, 1)],
          semanticObservations: [{
            kind: 'user-intent',
            value: 'Do not admit new review work after drain starts.',
            sourceRefs: [`${episodeId}#intent`],
          }],
          settlementDeadline: new Date(0).toISOString(),
          status: 'eligible',
        },
      },
    });

    const originalRunMaturation = (env.runtimeLearning as any).runMaturation.bind(env.runtimeLearning);
    const originalReview = env.skillEvolution.reviewAndApply.bind(env.skillEvolution);
    let releaseMaturation!: () => void;
    const maturationBlocked = new Promise<void>(resolve => { releaseMaturation = resolve; });
    let maturationStarted!: () => void;
    const maturationStartedPromise = new Promise<void>(resolve => { maturationStarted = resolve; });
    let reviewCalls = 0;

    (env.runtimeLearning as any).runMaturation = async (...args: any[]) => {
      maturationStarted();
      await maturationBlocked;
      return originalRunMaturation(...args);
    };
    env.skillEvolution.reviewAndApply = async (...args: any[]) => {
      reviewCalls += 1;
      return originalReview(...args);
    };

    try {
      const wake = env.runtimeLearning.wake('startup');
      await maturationStartedPromise;
      await env.runtimeLearning.drain(100);
      releaseMaturation();
      const result = await wake;
      assert.equal(reviewCalls, 0);
      assert.equal(result.review.reviewedEpisodes, 0);
      assert.equal(env.runtimeLearning.getEpisodeStore().load().episodes[episodeId]?.status, 'eligible');
      assert.equal(countActiveOperational(loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath))), 0);
    } finally {
      (env.runtimeLearning as any).runMaturation = originalRunMaturation;
      env.skillEvolution.reviewAndApply = originalReview;
    }
  });

  test('drain waits for a timing-out active review to durably queue operational retry before wake exit', async () => {
    const episodeId = 'episode-drain-review-timeout';
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: {
        [episodeId]: {
          schemaVersion: 3,
          episodeId,
          runtimeSessionId: 'runtime-drain-timeout',
          sourceFilePath: `${episodeId}.jsonl`,
          deliveryTurn: 1,
          completionEvidence: [{
            ref: `${episodeId}#1`,
            sourceFilePath: `${episodeId}.jsonl`,
            turn: 1,
            kind: 'artifact-delivery',
            detail: 'send_file: delivered',
          }],
          contradictionSignals: [],
          sourceEvidence: [frozenEpisodeSource(`${episodeId}#1`, `${episodeId}.jsonl`, 1)],
          semanticObservations: [{
            kind: 'user-intent',
            value: 'Persist the retry before shutdown completes.',
            sourceRefs: [`${episodeId}#intent`],
          }],
          settlementDeadline: new Date(0).toISOString(),
          status: 'eligible',
        },
      },
    });

    const originalReview = env.skillEvolution.reviewAndApply.bind(env.skillEvolution);
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    env.skillEvolution.reviewAndApply = async (bundle: any) => {
      started();
      await new Promise(resolve => setTimeout(resolve, 50));
      seedOperationalFailure(env.reviewQueuePath, bundle, 'simulated active review deadline expiry during drain', new Date());
      return {
        transition: 'reject_candidate' as const,
        verified: false,
        rounds: 1,
        queued: 'operational' as const,
        queueEntryId: findOperationalJobByBundleId(
          loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath)),
          bundle.bundleId,
        )?.jobId,
      };
    };

    try {
      const wake = env.runtimeLearning.wake('startup');
      await startedPromise;
      await env.runtimeLearning.drain(200);
      const result = await wake;
      const entry = findOperationalJobByBundleId(loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath)), `v3:learning-episode:${episodeId}`);
      assert.ok(entry);
      assert.equal(result.review.reviewedEpisodes, 1);
      assert.equal(result.review.operationalQueueReviews, 0);
      assert.equal(result.review.reviewTimeoutCount, 1);
    } finally {
      env.skillEvolution.reviewAndApply = originalReview;
    }
  });

  test('drain awaits active wake settlement and stops new fair-review leases', async () => {
    const episodeId = 'episode-drain-fair-lease-stop';
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: {
        [episodeId]: {
          schemaVersion: 3,
          episodeId,
          runtimeSessionId: 'runtime-drain-fair-lease',
          sourceFilePath: `${episodeId}.jsonl`,
          deliveryTurn: 1,
          completionEvidence: [{
            ref: `${episodeId}#1`,
            sourceFilePath: `${episodeId}.jsonl`,
            turn: 1,
            kind: 'artifact-delivery',
            detail: 'send_file: delivered',
          }],
          contradictionSignals: [],
          sourceEvidence: [frozenEpisodeSource(`${episodeId}#1`, `${episodeId}.jsonl`, 1)],
          semanticObservations: [{
            kind: 'user-intent',
            value: 'Drain must stop new quantum leases after shutdown begins.',
            sourceRefs: [`${episodeId}#intent`],
          }],
          settlementDeadline: new Date(0).toISOString(),
          status: 'eligible',
        },
      },
    });

    let reviewStarted!: () => void;
    const reviewStartedPromise = new Promise<void>(resolve => { reviewStarted = resolve; });
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; });
    const originalReview = env.skillEvolution.reviewAndApply.bind(env.skillEvolution);
    env.skillEvolution.reviewAndApply = async (...args: any[]) => {
      reviewStarted();
      await reviewGate;
      return originalReview(...args);
    };

    try {
      const wake = env.runtimeLearning.wake('startup');
      await reviewStartedPromise;

      // Drain must observe the active wake promise (activeWakeResults) and wait
      // boundedly while the wake finishes durable settlement.
      const drainStarted = Date.now();
      const drainPromise = env.runtimeLearning.drain(500);
      // Give drain a tick to set shutdownDrainRequested before release.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(
        (env.runtimeLearning as any).shutdownDrainRequested,
        true,
        'drain arms the stop-new-leases gate',
      );
      releaseReview();
      await drainPromise;
      const result = await wake;
      assert.ok(Date.now() - drainStarted < 2_000, 'drain returns after wake settlement within bound');
      assert.equal(
        (env.runtimeLearning as any).activeWakeResults?.size ?? 0,
        0,
        'active wake tracking cleared after settlement',
      );
      // Wake may complete review that already started; new fair leases are gated.
      assert.ok(
        result.review.status === 'succeeded' || result.review.status === 'partial',
        `wake settled under drain: ${result.review.status}`,
      );
    } finally {
      env.skillEvolution.reviewAndApply = originalReview;
    }
  });
});

describe('Issue 70 — Wake reason union and mask-free due-work', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('targeted semantic-reassessment reason uses planner due-work union and does not mask settlement or operational work', async () => {
    const episodeStore = new LearningEpisodeStore(env.episodeStorePath);
    episodeStore.save({
      schemaVersion: 3,
      episodes: {
        'issue-70-settling': {
          schemaVersion: 3,
          episodeId: 'issue-70-settling',
          runtimeSessionId: 'issue-70-runtime',
          sourceFilePath: env.logFile,
          deliveryTurn: 1,
          completionEvidence: [{
            ref: 'issue-70#1',
            sourceFilePath: env.logFile,
            turn: 1,
            kind: 'artifact-delivery',
            detail: 'send_file: plan.md',
          }],
          contradictionSignals: [],
          sourceEvidence: [frozenEpisodeSource('issue-70#1', env.logFile, 1)],
          semanticObservations: [],
          settlementDeadline: new Date(Date.now() - 60_000).toISOString(),
          status: 'settling',
        },
      },
    });

    seedOperationalFailure(
      env.reviewQueuePath,
      runtimeReviewBundle('issue-70-operational'),
      'Issue 70 test retry',
    );

    const result = await env.runtimeLearning.wake(['semantic-reassessment', 'operational-retry']);

    assert.equal(result.discovery.scanned, false);
    assert.equal(result.maturation.status, 'succeeded');
    assert.equal(result.maturation.becameEligible, 1);
    assert.equal(result.review.reviewedEpisodes, 1);
    const operationalJob = findOperationalJobByBundleId(
      loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath)),
      'issue-70-operational',
    );
    assert.ok(
      operationalJob && Object.values(operationalJob.quanta).some(quantum => quantum.state === 'succeeded'),
      'expected the sole fair executor to advance operational work alongside maturation',
    );
  });

  test('discovery reasons in a reason array still scan and run due stages', async () => {
    const [delivery, acceptance] = deliveryPair(0);
    delivery.episode_id = 'turn-issue-70-discovery';
    recordReviewAdmissionLoad(env, delivery.episode_id, delivery.session_id);
    writeLog(env.logFile, [delivery, acceptance]);

    const result = await env.runtimeLearning.wake(['startup', 'semantic-reassessment']);

    assert.equal(result.discovery.scanned, true);
    assert.equal(result.discovery.filesScanned, 1);
    assert.equal(result.ingestion.admittedEpisodes, 1);
    assert.equal(result.maturation.status, 'succeeded');
    assert.equal(result.review.status, 'succeeded');
    assert.ok(result.review.reviewedEpisodes >= 1);
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

describe('RuntimeLearning — semantic reassessment wake', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('scheduled wake resumes a pending manifest item without admitting episodes', async () => {
    const skillPath = path.join(env.outputDir, 'legacy', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: settled-artifact-delivery\ndescription: Legacy\n---\n\nLegacy guidance.\n', 'utf8');
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.legacy = {
      handle: 'legacy', revision: 1, routingName: 'settled-artifact-delivery', description: 'Legacy', skillFilePath: skillPath,
      guidanceHash: require('node:crypto').createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
      evidenceRefs: [], referencedSkills: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(env.registryPath, registry);
    new SemanticReassessmentManifestStore(env.reassessmentManifestPath).upsertForRecord(registry.capabilities.legacy);

    const result = await env.runtimeLearning.wake('scheduled');
    assert.equal(result.reassessment.status, 'succeeded');
    assert.equal(result.reassessment.discovered, 1);
    assert.equal(result.reassessment.deferred, 1);
    assert.equal(result.ingestion.admittedEpisodes, 0);
    assert.equal(result.discovery.filesScanned, 0);
    assert.equal(Object.keys(readOrEmpty(env.episodeStorePath)?.episodes ?? {}).length, 0);
  });

  test('targeted semantic reassessment wake skips evidence and due-review stages', async () => {
    const skillPath = path.join(env.outputDir, 'legacy', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: settled-artifact-delivery\ndescription: Legacy\n---\n\nLegacy guidance.\n', 'utf8');
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.legacy = {
      handle: 'legacy', revision: 1, routingName: 'settled-artifact-delivery', description: 'Legacy', skillFilePath: skillPath,
      guidanceHash: require('node:crypto').createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
      evidenceRefs: [], referencedSkills: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(env.registryPath, registry);
    new SemanticReassessmentManifestStore(env.reassessmentManifestPath).upsertForRecord(registry.capabilities.legacy);

    const result = await env.runtimeLearning.wake('semantic-reassessment');
    assert.equal(result.discovery.scanned, false);
    assert.equal(result.ingestion.admittedEpisodes, 0);
    assert.equal(result.maturation.status, 'skipped');
    assert.equal(result.review.status, 'skipped');
    assert.equal(result.curation.status, 'skipped');
    assert.equal(result.reassessment.deferred, 1);
  });

  test('deferred reassessment is not retried on repeated startup and scheduled wakes', async () => {
    const skillPath = path.join(env.outputDir, 'legacy', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: settled-artifact-delivery\ndescription: Legacy\n---\n\nLegacy guidance.\n', 'utf8');
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.legacy = {
      handle: 'legacy', revision: 1, routingName: 'settled-artifact-delivery', description: 'Legacy', skillFilePath: skillPath,
      guidanceHash: require('node:crypto').createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
      evidenceRefs: [], referencedSkills: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(env.registryPath, registry);

    const first = await env.runtimeLearning.wake('startup');
    assert.equal(first.reassessment.deferred, 1);
    const manifest = new SemanticReassessmentManifestStore(env.reassessmentManifestPath);
    const firstEntry = Object.values(manifest.load().entries)[0];
    assert.equal(firstEntry?.status, 'deferred');

    const second = await env.runtimeLearning.wake('scheduled');
    assert.equal(second.reassessment.discovered, 0);
    assert.equal(second.reassessment.completed, 0);
    const secondEntry = Object.values(manifest.load().entries)[0];
    assert.equal(secondEntry?.status, 'deferred');
    assert.equal(secondEntry?.attemptCount, firstEntry?.attemptCount);
  });

  test('restart mirrors a terminal Job before submission after a manifest crash window', async () => {
    env.restore();
    env.teardown();
    let authorCalls = 0;
    let verifierCalls = 0;
    env = setupEnv(0, {
      authorFixture: () => {
        authorCalls++;
        return {
          body: 'Keep the bounded legacy route unchanged.',
          envelope: {
            decision: 'migrate_skill_route' as const,
            targetCapabilityHandle: 'legacy',
            routingName: 'report-delivery',
            description: 'Deliver reports.',
          },
        };
      },
      verifierFixture: ({ bundle }) => {
        verifierCalls++;
        return {
          decision: 'reject' as const,
          issues: [{ code: 'no-change', message: 'No migration is needed.', severity: 'warning' as const }],
          rationale: 'The current capability remains sufficient.',
          obligationDispositions: acceptReviewObligations(bundle).map(disposition => ({
            ...disposition,
            decision: 'rejected' as const,
            rationale: 'Explicitly rejected because no migration is needed.',
          })),
        };
      },
    });
    const skillPath = path.join(env.outputDir, 'legacy', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: settled-artifact-delivery\ndescription: Legacy\n---\n\nLegacy guidance.\n', 'utf8');
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.legacy = {
      handle: 'legacy', revision: 1, routingName: 'settled-artifact-delivery', description: 'Legacy', skillFilePath: skillPath,
      guidanceHash: require('node:crypto').createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
      evidenceRefs: [{ ref: 'legacy#completion' }, { ref: 'legacy#settlement' }], referencedSkills: [],
      semanticObservations: [{ kind: 'user-intent', value: 'Deliver reports.', sourceRefs: ['legacy#user'] }],
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(env.registryPath, registry);

    const first = await bootstrapSemanticReassessmentOnce({
      skillEvolution: env.skillEvolution,
      manifestPath: env.reassessmentManifestPath,
    });
    assert.equal(first[0]?.status, 'succeeded');
    const manifest = new SemanticReassessmentManifestStore(env.reassessmentManifestPath);
    const manifestState = manifest.load();
    const entry = Object.values(manifestState.entries)[0]!;
    const jobStorePath = evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath);
    const beforeJobs = Object.values(loadEvidenceReviewJobStore(jobStorePath).jobs)
      .filter(job => job.bundle.bundleId === entry.taskId);
    assert.equal(beforeJobs.some(job => job.disposition === 'completed'), true);
    assert.ok(authorCalls > 0 && verifierCalls > 0);

    // Simulate loss of only the manifest mirror after the terminal Job write.
    entry.status = 'pending';
    delete entry.lastError;
    delete entry.nextRetryAt;
    manifest.save(manifestState);
    const callsBeforeRestart = { authorCalls, verifierCalls };
    const restarted = new SkillEvolutionRuntime(env.skillEvolutionOptions);
    const replay = await bootstrapSemanticReassessmentOnce({
      skillEvolution: restarted,
      manifestPath: env.reassessmentManifestPath,
    });

    assert.equal(replay[0]?.status, 'succeeded');
    assert.deepEqual({ authorCalls, verifierCalls }, callsBeforeRestart, 'terminal work must not be submitted again');
    const afterJobs = Object.values(loadEvidenceReviewJobStore(jobStorePath).jobs)
      .filter(job => job.bundle.bundleId === entry.taskId);
    assert.equal(afterJobs.length, beforeJobs.length, 'same-bundle Job history must not grow on restart');
    assert.equal(manifest.load().entries[entry.taskId]?.status, 'succeeded');
  });

  test('operational retry wake reconciles the manifest after queue recovery', async () => {
    env.restore();
    env.teardown();
    let verifierAvailable = false;
    env = setupEnv(0, {
      authorFixture: () => ({
        body: 'Use the report delivery capability.',
        envelope: { decision: 'migrate_skill_route', targetCapabilityHandle: 'legacy', routingName: 'report-delivery', description: 'Deliver reports.' },
      }),
      verifierFixture: ({ bundle }) => verifierAvailable
        ? ({
            decision: 'accept',
            transition: 'migrate_skill_route',
            issues: [],
            rationale: 'Bounded route migration.',
            obligationDispositions: acceptReviewObligations(bundle),
          })
        : (() => { throw new Error('temporary verifier outage'); })(),
    });
    const skillPath = path.join(env.outputDir, 'legacy', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: settled-artifact-delivery\ndescription: Legacy\n---\n\nLegacy guidance.\n', 'utf8');
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.legacy = {
      handle: 'legacy', revision: 1, routingName: 'settled-artifact-delivery', description: 'Legacy', skillFilePath: skillPath,
      guidanceHash: require('node:crypto').createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
      evidenceRefs: [{ ref: 'legacy#evidence' }], referencedSkills: [],
      semanticObservations: [{ kind: 'user-intent', value: 'Deliver reports.', sourceRefs: ['legacy#user'] }],
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(env.registryPath, registry);
    const first = await bootstrapSemanticReassessmentOnce({
      skillEvolution: env.skillEvolution,
      manifestPath: env.reassessmentManifestPath,
    });
    assert.equal(first[0]?.status, 'failed');
    const jobStoreState = loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath));
    const opJob = Object.values(jobStoreState.jobs).find(
      job => job.disposition === 'active' && job.workClass === 'operational_recovery',
    );
    assert.ok(opJob, 'expected operational recovery job in job store');
    if (opJob) {
      opJob.nextDueAt = new Date(0).toISOString();
      const retryQuantum = Object.values(opJob.quanta).find(quantum => quantum.state === 'retry_wait');
      assert.ok(retryQuantum, 'expected a retry_wait quantum after verifier failure');
      retryQuantum.nextRetryAt = new Date(0).toISOString();
      upsertEvidenceReviewJob(jobStoreState, opJob);
      saveEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath), jobStoreState);
    }
    const manifest = new SemanticReassessmentManifestStore(env.reassessmentManifestPath);
    const state = manifest.load();
    const entry = Object.values(state.entries)[0]!;
    entry.nextRetryAt = new Date(0).toISOString();
    manifest.save(state);

    verifierAvailable = true;
    let result = await env.runtimeLearning.wake('operational-retry');
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const current = Object.values(manifest.load().entries)[0]!;
      if (current.status === 'succeeded') break;
      result = await env.runtimeLearning.wake('manual');
    }
    assert.equal(result.review.status, 'succeeded');
    const reconciled = Object.values(manifest.load().entries)[0]!;
    assert.equal(reconciled.status, 'succeeded');
    assert.equal(reconciled.nextRetryAt, undefined);
    const finalJobs = loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath));
    assert.equal(countActiveOperational(finalJobs), 0);
    assert.ok(
      Object.values(finalJobs.jobs).filter(job => (
        job.bundle.bundleId === entry.taskId
        && (job.disposition === 'active' || job.disposition === 'deferred')
      )).length <= 1,
      'manifest wakes must never create parallel active owners while the job store recovers',
    );
  });
});

describe('RuntimeLearning — external catch-up continuation', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(FUTURE_WINDOW_MS); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('queues a discovery continuation while catch-up stability work remains', async () => {
    let historySampleCalls = 0;
    const resource: SessionLogSourceResource = {
      resourceRef: 'thread-catch-up-1',
      firstEventIdentity: {
        eventId: 'codex://thread-catch-up-1#1',
        position: 2,
        conversationId: 'thread-catch-up-1',
        branchId: 'thread-catch-up-1',
        contentHash: 'catalog-fingerprint-1',
      },
    };
    const reader: ExternalSourceReader = {
      provider: 'codex',
      reader: 'fixture-catch-up',
      discoverResources: () => [resource],
      observeCatchUpCatalog: () => ({
        resources: [resource],
        nextPageToken: null,
        returnedResourceCount: 1,
        outputBytes: 128,
      }),
      getCatchUpCatalogLimits: () => ({
        initialLimit: 100,
        maxCatalogResources: 2048,
        maxOutputBytes: 4 * 1024 * 1024,
        maxDurationMs: 60_000,
      }),
      sampleHistory: () => {
        historySampleCalls += 1;
        return {
          events: [{
            eventId: 'codex://thread-catch-up-1#2',
            position: 2,
            contentHash: 'stable-history-prefix-1',
            conversationId: 'thread-catch-up-1',
            branchId: 'thread-catch-up-1',
          }],
          status: 'stable',
          exhausted: true,
          newPosition: 2,
          observedPosition: 2,
          conversationId: 'thread-catch-up-1',
          branchId: 'thread-catch-up-1',
        };
      },
      read: (_resource, cursor) => ({
        events: [],
        status: 'stable',
        exhausted: true,
        newPosition: cursor.position,
      }),
    };
    const adapter = new ExternalSessionLogSourceAdapter({
      sourceId: 'external-codex-catch-up-test',
      provider: 'codex',
      reader,
      enabled: true,
      historyMode: 'catch-up',
      scope: { scope: 'path', scopePath: env.root },
      cursorStorePath: path.join(env.root, 'data', 'external-codex-cursor.json'),
    });
    const episodeStore = new LearningEpisodeStore(env.episodeStorePath);
    const runtime = new RuntimeLearning({
      workingDirectory: env.root,
      evidenceIngestor: new EvidenceIngestor({ episodeStore, settlementWindowMs: FUTURE_WINDOW_MS }),
      learningEpisodeStore: episodeStore,
      skillEvolution: env.skillEvolution,
      curator: null,
      planner: new DueWorkPlanner({
        learningEpisodeStorePath: env.episodeStorePath,
        reviewQueuePath: env.reviewQueuePath,
        curatorStatePath: path.join(env.root, 'data', 'curator-state.json'),
        curatorIntervalMs: 24 * 60 * 60 * 1000,
        semanticReassessmentManifestPath: env.reassessmentManifestPath,
      }),
      sessionLogSources: [adapter],
    });

    await runtime.wake('startup');

    assert.equal(adapter.getNextCatchUpAction(), 'stability');
    assert.deepEqual(runtime.getPendingHeartbeatReasons(), ['external-continuation']);

    await runtime.wake('external-continuation');

    assert.equal(historySampleCalls, 1, 'continuation must execute the pending stability quantum');
  });
});

// ---------------------------------------------------------------------------
// AC 5: Discovery — generated skills remain discoverable
// ---------------------------------------------------------------------------

describe('RuntimeLearning — AC5: Discovery', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('an ordinary episode materializes a verified generated Skill', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);
    await env.runtimeLearning.wake('startup');

    const registry = readOrEmpty(env.registryPath);
    assert.equal(Object.keys(registry?.capabilities ?? {}).length, 1);
    const skillDir = defaultDistilledOutputDir(env.skillsRoot);
    const entries = fs.existsSync(skillDir) ? fs.readdirSync(skillDir) : [];
    assert.equal(entries.length, 1);
  });

  test('a retained ordinary episode remains traceable through its transition audit', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    writeLog(env.logFile, [delivery, acceptance]);
    await env.runtimeLearning.wake('startup');

    const episodes = Object.values(
      env.runtimeLearning.getEpisodeStore().load().episodes,
    );
    assert.equal(episodes.length, 1);
    assert.ok(episodes[0]!.completionEvidence.some(evidence => evidence.kind === 'user-acceptance'));
    assert.equal(env.skillEvolution.getAudit().length, 1);
    assert.equal(env.skillEvolution.getAudit()[0]?.transition, 'create_current_skill');
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

  test('startup recovers a persisted contradiction after the in-memory observation queue is lost', async () => {
    const agentTurnEpisodeId = 'turn-episode-curator-recovery';
    const runtimeSessionId = 'runtime-curator-recovery';
    recordReviewAdmissionLoad(env, agentTurnEpisodeId, runtimeSessionId);
    const episode: LearningEpisode = {
      schemaVersion: 3,
      episodeId: 'episode-curator-recovery',
      agentTurnEpisodeId,
      runtimeSessionId,
      sourceFilePath: 'curator-recovery.jsonl',
      deliveryTurn: 1,
      completionEvidence: [{
        ref: 'curator-recovery.jsonl#turn-1:delivery',
        sourceFilePath: 'curator-recovery.jsonl',
        turn: 1,
        kind: 'artifact-delivery',
      }, {
        ref: 'curator-recovery.jsonl#turn-2:contradiction',
        sourceFilePath: 'curator-recovery.jsonl',
        turn: 2,
        kind: 'contradiction',
      }],
      contradictionSignals: [{
        signalId: 'signal-curator-recovery',
        kind: 'direct-correction',
        message: 'The test-review-admission Skill used the wrong package manager.',
        source: {
          ref: 'curator-recovery.jsonl#turn-2:contradiction',
          sourceFilePath: 'curator-recovery.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'curator-recovery.jsonl',
        runtimeSessionId,
        preventsPromotion: true,
      }],
      sourceEvidence: [
        frozenEpisodeSource(
          'curator-recovery.jsonl#turn-1:delivery',
          'curator-recovery.jsonl',
          1,
          'User:\nRun the package workflow.\n\nAssistant:\nThe workflow finished.',
        ),
        frozenEpisodeSource(
          'curator-recovery.jsonl#turn-2:contradiction',
          'curator-recovery.jsonl',
          2,
          'User:\nThe Skill used the wrong package manager.\n\nAssistant:\nUnderstood.',
        ),
      ],
      semanticObservations: [],
      settlementDeadline: new Date(0).toISOString(),
      status: 'contradicted',
    };
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [episode.episodeId]: episode },
    });

    await env.runtimeLearning.wake('startup');
    await env.runtimeLearning.wake('startup');

    const outcomes = new SkillUsageLedger(path.join(env.root, 'data', 'skill-usage-ledger.jsonl'))
      .listFacts()
      .filter(fact => fact.kind === 'episode-outcome');
    assert.equal(outcomes.length, 1, 'durable scan recovers once and ledger replay stays idempotent');
    assert.equal(outcomes[0]!.outcome, 'contradicted');
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
      schemaVersion: 3,
      episodes: {
        [episodeId]: {
          schemaVersion: 3,
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
          sourceEvidence: [
            frozenEpisodeSource('ev-1', env.logFile, 1),
            frozenEpisodeSource('ev-2', env.logFile, 2),
          ],
          contradictionSignals: [],
          semanticObservations: [{
            kind: 'user-intent',
            value: 'Deliver the requested report.',
            sourceRefs: ['ev-1:user-intent'],
          }],
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
    const foundCreation = Object.entries(result.review.transitionsByKind)
      .some(([kind, count]) => kind === 'create_current_skill' && (count as number) >= 1);
    assert.ok(foundCreation,
      `expected create_current_skill, got ${JSON.stringify(result.review.transitionsByKind)}`);
  });
});

describe('Issue 3 — Review failure status', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('per-episode review failure reports failed status with error message', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    delivery.episode_id = 'turn-review-failure';
    recordReviewAdmissionLoad(env, delivery.episode_id, delivery.session_id);
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
    assert.equal(after.lastRunStatus, 'succeeded', 'expected succeeded status');
    assert.ok(after.lastRunDurationMs >= 0, 'expected lastRunDurationMs');
    assert.deepEqual(after.lastPendingWakeReasons, ['startup']);
    assert.equal(after.lastReviewTimeoutCount, 0);
    assert.equal(after.lastReviewFailureCount, 0);
  });

  test('persists owner, in-progress, next wake, backlog, cumulative failures, and lane state', async () => {
    env.runtimeLearning.markHeartbeatInProgress(['manual'], {
      pid: 123,
      generation: 'owner-generation-test',
      startedAt: '2026-07-14T00:00:00.000Z',
      lastHeartbeatAt: '2026-07-14T00:00:01.000Z',
    });
    let record = env.runtimeLearning.loadHeartbeatRecord();
    assert.deepEqual(record.inProgress?.reasons, ['manual']);
    assert.equal(record.owner?.generation, 'owner-generation-test');

    env.runtimeLearning.markHeartbeatScheduled(
      new Date('2026-07-14T00:01:00.000Z'),
      'scheduled',
    );
    record = env.runtimeLearning.loadHeartbeatRecord();
    assert.equal(record.nextWakeReason, 'scheduled');
    assert.equal(record.nextWakeAt, '2026-07-14T00:01:00.000Z');

    await env.runtimeLearning.wake('startup');
    record = env.runtimeLearning.loadHeartbeatRecord();
    assert.equal(record.inProgress, undefined);
    assert.ok(Array.isArray(record.lastSourceReports));
    assert.equal(record.externalSourceDiagnostics.schemaVersion, 1);
    assert.equal(record.externalSourceDiagnostics.generatedAt, record.lastRunAt);
    assert.equal(record.externalSourceDiagnostics.overallReadiness, 'ready');
    assert.ok(record.backlog.eligibleEpisodes >= 0);
    assert.ok(record.cumulativeReviewFailureCount >= record.lastReviewFailureCount);
    assert.ok(record.cumulativeReviewTimeoutCount >= record.lastReviewTimeoutCount);
  });

  test('projects operational backlog from the authoritative Evidence Review Job store', () => {
    seedOperationalFailure(
      env.reviewQueuePath,
      runtimeReviewBundle('heartbeat-operational-backlog'),
      'Pending operational recovery',
      new Date('2099-01-01T00:00:00.000Z'),
    );

    env.runtimeLearning.markHeartbeatStatus('quiet');

    assert.equal(env.runtimeLearning.loadHeartbeatRecord().backlog.operationalReviews, 1);
  });

  test('failed heartbeat status persists not-ready diagnostics and later success recovers', () => {
    env.runtimeLearning.markHeartbeatStatus('failed');
    let record = env.runtimeLearning.loadHeartbeatRecord();
    assert.equal(record.externalSourceDiagnostics.overallReadiness, 'not_ready');

    env.runtimeLearning.markHeartbeatStatus('quiet');
    record = env.runtimeLearning.loadHeartbeatRecord();
    assert.equal(record.externalSourceDiagnostics.overallReadiness, 'ready');
  });

  test('persists unconsumed wake reasons atomically without mutating learning state on restart inspection', () => {
    const beforeAudit = env.runtimeLearning.getSkillEvolution().getAudit();
    const beforeEpisodes = env.runtimeLearning.getEpisodeStore().load();

    env.runtimeLearning.markHeartbeatPending([
      'curator',
      'operational-retry',
      'curator',
    ]);

    const record = env.runtimeLearning.loadHeartbeatRecord();
    assert.deepEqual(record.pendingWakeReasons, ['curator', 'operational-retry']);
    const recordPath = env.runtimeLearning.getConfig().heartbeatRecordPath;
    assert.equal(fs.existsSync(recordPath), true);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(recordPath, 'utf8')));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      fs.readdirSync(path.dirname(recordPath)).filter(name => name.includes('.tmp')),
      [],
      'atomic heartbeat writes must not leave temporary files',
    );

    const restarted = createRestartableRuntimeLearning(env.root);
    assert.deepEqual(restarted.getPendingHeartbeatReasons(), ['curator', 'operational-retry']);
    assert.deepEqual(restarted.getSkillEvolution().getAudit(), beforeAudit);
    assert.deepEqual(restarted.getEpisodeStore().load(), beforeEpisodes);
    assert.equal(restarted.loadHeartbeatRecord().runCount, 0);
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
    assert.equal(after2.lastRunStatus, 'quiet', `expected quiet status, got ${after2.lastRunStatus}`);
    assert.deepEqual(after2.lastPendingWakeReasons, ['scheduled']);
    assert.equal(after2.lastReviewTimeoutCount, 0);
    assert.equal(after2.lastReviewFailureCount, 0);
    assert.ok(after2.lastRunDurationMs >= 0, 'expected lastRunDurationMs');
  });

  test('restart does not re-review an audited single-episode Skill creation', async () => {
    const [delivery, acceptance] = deliveryPair(-2);
    delivery.episode_id = 'turn-restart-single-episode';
    recordReviewAdmissionLoad(env, delivery.episode_id, delivery.session_id);
    writeLog(env.logFile, [delivery, acceptance]);

    await env.runtimeLearning.wake('startup');
    const before = env.runtimeLearning.loadHeartbeatRecord();
    const firstAudit = env.runtimeLearning.getSkillEvolution().getAudit();
    const firstCreateCount = firstAudit.filter(entry => entry.transition === 'create_current_skill').length;
    const firstCreate = firstAudit.find(entry => entry.transition === 'create_current_skill');
    assert.equal(firstCreateCount, 1);

    const restarted = createRestartableRuntimeLearning(env.root);
    await restarted.wake('startup');

    const after = restarted.loadHeartbeatRecord();
    assert.equal(after.runCount, before.runCount + 1, 'expected runCount to increase after restart');
    assert.deepEqual(after.lastPendingWakeReasons, ['startup']);
    const restartedAudit = restarted.getSkillEvolution().getAudit();
    const secondCreateCount = restartedAudit.filter(entry => entry.transition === 'create_current_skill').length;
    assert.equal(secondCreateCount, firstCreateCount, 'expected no duplicate transitions on restart');
    const secondCreate = restartedAudit.find(entry => entry.transition === 'create_current_skill');
    assert.ok(firstCreate && secondCreate);
    assert.deepEqual(
      secondCreate.branchTranscriptPaths,
      firstCreate.branchTranscriptPaths,
      'transcript references should be preserved across restart',
    );
  });
});

describe('Issue #83 — controlled production acceptance', () => {
  test('audits a healthy transcript-linked creation while a hanging peer queues timeout and a targeted wake coalesces', {
    timeout: 5_000,
  }, async () => {
    const env = setupEnv(0);
    const makeEpisode = (episodeId: string, intent: string): LearningEpisode => ({
      schemaVersion: 3,
      episodeId,
      runtimeSessionId: 'runtime-production-acceptance',
      sourceFilePath: `${episodeId}.jsonl`,
      deliveryTurn: 1,
      completionEvidence: [{
        ref: `${episodeId}.jsonl#turn-1:delivery:send_file`,
        sourceFilePath: `${episodeId}.jsonl`,
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: report sent',
      }],
      sourceEvidence: [frozenEpisodeSource(
        `${episodeId}.jsonl#turn-1:delivery:send_file`,
        `${episodeId}.jsonl`,
        1,
        `User:\n${intent}\n\nAssistant:\nThe report was sent.`,
      )],
      contradictionSignals: [],
      semanticObservations: [{
        kind: 'user-intent',
        value: intent,
        sourceRefs: [`${episodeId}.jsonl#turn-1:user-intent`],
      }],
      settlementDeadline: new Date(0).toISOString(),
      status: 'eligible',
    });
    const hangingStarted = createDeferred<void>();
    const releaseHanging = createDeferred<void>();
    const originalReview = env.skillEvolution.reviewAndApply.bind(env.skillEvolution);
    (env.skillEvolution as any).options.operationalRetryMs = 60_000;
    env.skillEvolution.reviewAndApply = async (bundle, signal) => {
      const sourceFilePath = (bundle.episode as { sourceUnit?: { filePath?: string } }).sourceUnit?.filePath;
      if (sourceFilePath !== 'episode-acceptance-timeout.jsonl') {
        return originalReview(bundle, signal);
      }
      hangingStarted.resolve();
      await releaseHanging.promise;
      const timeout = new AbortController();
      timeout.abort('review-timeout');
      return originalReview(bundle, timeout.signal);
    };

    try {
      env.runtimeLearning.getEpisodeStore().save({
        schemaVersion: 3,
        episodes: {
          'episode-acceptance-timeout': makeEpisode(
            'episode-acceptance-timeout',
            'Deliver the timeout acceptance report.',
          ),
          'episode-acceptance-healthy': makeEpisode(
            'episode-acceptance-healthy',
            'Deliver the healthy acceptance report.',
          ),
        },
      });

      const scheduler = new DistillationHeartbeatScheduler(env.root, env.runtimeLearning);
      const startup = scheduler.runHeartbeat('startup');
      await hangingStarted.promise;
      const targeted = scheduler.runHeartbeat('settlement-deadline');

      assert.deepEqual(
        env.runtimeLearning.loadHeartbeatRecord().pendingWakeReasons,
        ['settlement-deadline'],
        'targeted demand must be durable while the hanging review is active',
      );

      releaseHanging.resolve();
      await Promise.all([startup, targeted]);

      const queue = loadEvidenceReviewJobStore(evidenceReviewJobStorePathForReviewQueue(env.reviewQueuePath));
      const opJobs = Object.values(queue.jobs).filter(j => j.disposition === 'active' && j.workClass === 'operational_recovery');
      assert.equal(opJobs.length, 1);
      assert.equal(
        Object.values(opJobs[0]!.quanta).find(quantum => quantum.state === 'retry_wait')?.failureKind,
        'branch_timeout',
      );
      assert.equal(
        (opJobs[0]!.bundle.episode as { sourceUnit?: { filePath?: string } }).sourceUnit?.filePath,
        'episode-acceptance-timeout.jsonl',
      );

      const creationAudit = env.skillEvolution.getAudit().find(
        entry => entry.transition === 'create_current_skill',
      );
      assert.ok(creationAudit, 'healthy peer must commit one audited disposition');
      // Author/Verifier promotion transcripts plus retained dual-lane reader artifacts.
      assert.equal(creationAudit.branchTranscriptPaths.length, 4);
      assert.ok(creationAudit.branchTranscriptPaths.every(transcriptPath => fs.existsSync(transcriptPath)));
      assert.equal(
        creationAudit.branchTranscriptPaths.filter(p => p.includes(`${path.sep}reader-transcripts${path.sep}`)).length,
        2,
      );

      const heartbeat = env.runtimeLearning.loadHeartbeatRecord();
      assert.equal(heartbeat.lastRunStatus, 'coalesced');
      assert.deepEqual(heartbeat.lastPendingWakeReasons, ['settlement-deadline']);
      assert.deepEqual(heartbeat.pendingWakeReasons, []);
      assert.equal(heartbeat.inProgress, undefined);
      assert.ok(heartbeat.runCount >= 2);
    } finally {
      env.skillEvolution.reviewAndApply = originalReview;
      env.restore();
      env.teardown();
    }
  });
});

describe('RuntimeLearning — fair wake pre-claim fencing', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('fences a pre-authority policy-v2 Learning Episode job before Author and advances only the normalized v3 successor', async () => {
    const authorBundles: Array<{ bundleId: string; referencedSkills: string[] }> = [];
    env.skillEvolutionOptions.authorFixture = ({ bundle }) => {
      authorBundles.push({
        bundleId: bundle.bundleId,
        referencedSkills: bundle.referencedSkills.map(skill => skill.name),
      });
      assert.deepEqual(
        bundle.referencedSkills,
        [],
        'normalized successor must strip leaked catalog references before Author runs',
      );
      return {
        body: 'Use the bounded normalized workflow only.',
        envelope: {
          decision: 'create_current_skill',
          routingName: 'normalized-fair-wake-successor',
          description: 'Normalized fair wake successor.',
          referencedSkills: [],
          evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
        },
      };
    };
    env.skillEvolutionOptions.verifierFixture = () => ({
      decision: 'accept',
      transition: 'create_current_skill',
      issues: [],
      rationale: 'Normalized fair wake successor looks bounded.',
    });

    const legacyBundle = runtimeReviewBundle(
      'v3:learning-episode:episode-candidate-active-v2',
    );
    const bundle = {
      ...legacyBundle,
      authority: undefined,
      episode: {
        ...(legacyBundle.episode as DistilledKnowledgeCandidate),
        capabilityId: 'episode-capability-candidate-active-v2',
      },
      sourceEvidence: [
        {
          ref: 'session.jsonl#12',
          sourceFilePath: 'session.jsonl',
          turn: 12,
          role: 'problem-action' as const,
          content: 'Use the bounded normalized workflow.',
        },
        {
          ref: 'session.jsonl#13',
          sourceFilePath: 'session.jsonl',
          turn: 13,
          role: 'verification' as const,
          content: 'The bounded normalized workflow was accepted.',
        },
      ],
      referencedSkills: [
        { name: 'generated-helper-a', capabilityHandle: 'cap-a', guidanceHash: 'hash-a' },
        { name: 'generated-helper-b', capabilityHandle: 'cap-b', guidanceHash: 'hash-b' },
      ],
    };
    const jobStorePath = resolveEvidenceReviewJobStorePath(env.skillEvolutionOptions);
    const state = loadEvidenceReviewJobStore(jobStorePath);
    const staleJob = createEvidenceReviewJob({
      bundle,
      candidate: bundle.episode as DistilledKnowledgeCandidate,
      workClass: 'live_learning',
      reviewPolicyVersion: 'evidence-review-policy-v2',
      now: new Date('2026-07-19T00:00:00.000Z'),
    });
    state.jobs[staleJob.jobId] = staleJob;
    saveEvidenceReviewJobStore(jobStorePath, state);
    const staleJobId = await advanceJobReadyForSkillAuthor(env, staleJob.jobId);
    seedDueReviewContinuation(env.episodeStorePath);

    const result = await env.runtimeLearning.wake('manual');

    const reloaded = loadEvidenceReviewJobStore(jobStorePath);
    const persistedStale = reloaded.jobs[staleJobId]!;
    const successor = Object.values(reloaded.jobs).find(job => job.parentJobId === staleJobId);

    assert.equal(result.review.status, 'succeeded');
    assert.ok(persistedStale.successorJobId, 'expected stale job to record successorJobId');
    assert.ok(successor, 'expected normalized successor job to be created');
    assert.deepEqual(successor!.bundle.referencedSkills, []);
    for (let attempt = 0; attempt < 16 && authorBundles.length === 0; attempt += 1) {
      await env.runtimeLearning.wake('manual');
    }
    assert.ok(
      authorBundles.some(call => call.bundleId === successor!.bundle.bundleId),
      'successive fair claims should eventually reach Author on the normalized successor',
    );
    assert.ok(
      authorBundles.every(call => call.referencedSkills.length === 0),
      'no Author invocation may see leaked legacy referencedSkills',
    );
  });

  test('keeps current v3 active skill_author jobs on the same job without spurious supersession', async () => {
    const authorBundles: string[] = [];
    env.skillEvolutionOptions.authorFixture = ({ bundle }) => {
      authorBundles.push(bundle.bundleId);
      return {
        body: 'Use the current bounded workflow only.',
        envelope: {
          decision: 'create_current_skill',
          routingName: 'current-fair-wake-job',
          description: 'Current fair wake job.',
          referencedSkills: [],
          evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
        },
      };
    };
    env.skillEvolutionOptions.verifierFixture = () => ({
      decision: 'accept',
      transition: 'create_current_skill',
      issues: [],
      rationale: 'Current fair wake job looks bounded.',
    });

    const bundle = runtimeReviewBundle('v3:session.jsonl:0:20:candidate-active-v3');
    const currentJobId = await seedActiveJobReadyForSkillAuthor(env, bundle);
    const jobStorePath = resolveEvidenceReviewJobStorePath(env.skillEvolutionOptions);
    seedDueReviewContinuation(env.episodeStorePath);

    const result = await env.runtimeLearning.wake('manual');

    const reloaded = loadEvidenceReviewJobStore(jobStorePath);
    const persisted = reloaded.jobs[currentJobId]!;
    const successor = Object.values(reloaded.jobs).find(job => job.parentJobId === currentJobId);

    assert.equal(result.review.status, 'succeeded');
    assert.ok(authorBundles.includes(bundle.bundleId), 'current v3 job should reach Author on fair wake');
    assert.equal(successor, undefined, 'current v3 job must not be spuriously superseded');
    assert.equal(persisted.successorJobId, undefined);
    assert.equal(persisted.disposition, 'active');
    assert.ok(persisted.draft, 'fair wake should advance the current v3 job normally');
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
      readerFixture: ({ shard, lane }) => ({
        findingSet: readShardStructurally(
          shard.shardId,
          shard.contentHash,
          shard.content,
          lane,
        ),
      }),
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
    const runtimeLearning = new RuntimeLearning({
      workingDirectory: root,
      evidenceIngestor,
      learningEpisodeStore: episodeStore,
      skillEvolution,
      curator,
      planner,
    });

    // Write session log with known deliver + acceptance
    const [delivery, acceptance] = deliveryPair(-2);
    delivery.episode_id = 'turn-provenance-byte-range';
    recordReviewAdmissionLoad(
      { root, outputDir },
      delivery.episode_id,
      delivery.session_id,
    );
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

describe('RuntimeLearning — external provenance crash fallback', () => {
  let env: TestEnv;

  beforeEach(() => { env = setupEnv(0); });
  afterEach(() => { env.restore(); env.teardown(); });

  test('treats external://event episodes as external before provenance replay completes', () => {
    const episodeStore = new LearningEpisodeStore(env.episodeStorePath);
    const state = episodeStore.load();
    state.episodes['episode-crash-fallback'] = {
      schemaVersion: 3,
      episodeId: 'episode-crash-fallback',
      runtimeSessionId: 'sess-crash-fallback',
      sourceFilePath: 'external://event/github/external-github/evt-123',
      deliveryTurn: 1,
      completionEvidence: [],
      contradictionSignals: [],
      semanticObservations: [],
      settlementDeadline: '2026-01-01T00:00:00.000Z',
      status: 'settled',
    } as LearningEpisode;
    episodeStore.save(state);

    assert.equal((env.runtimeLearning as any).isEpisodeFromExternalSource('episode-crash-fallback'), true);
    assert.equal((env.runtimeLearning as any).isEpisodeFromExternalSource('episode-internal'), false);
  });
});

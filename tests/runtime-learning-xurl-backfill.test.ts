/**
 * Issue #90 — explicit backfill through the official xURL rendered Timeline
 * contract (ADR-0043) via the public RuntimeLearning seam.
 */

import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { RuntimeLearning } from '../src/utils/runtime-learning';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { loadReviewQueueState } from '../src/utils/skill-evolution-review-queue';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { ExternalSessionLogBackfillRequest, loadExternalSessionLogBackfillState } from '../src/utils/session-log-backfill';
import { XURL_TEST_HELPERS, XurlExternalBackfillSource } from '../src/utils/xurl-session-log-source';
import {
  CatalogPageSpec,
  FakeXurlScenario,
  ThreadSummarySpec,
  TimelineSpec,
  writeFakeXurl,
  writeScenario,
  readInvocationLog,
} from './helpers/xurl-rendered-fixtures';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface RuntimeFixture {
  readonly runtime: RuntimeLearning;
  readonly episodeStore: LearningEpisodeStore;
  readonly skillEvolution: SkillEvolutionRuntime;
}

interface TestEnv {
  readonly root: string;
  readonly reviewQueuePath: string;
  readonly logPath: string;
  readonly scenarioPath: string;
  readonly commandPath: string;
  createRuntime(options?: {
    authorFixture?: Parameters<typeof SkillEvolutionRuntime>[0]['authorFixture'];
    verifierFixture?: Parameters<typeof SkillEvolutionRuntime>[0]['verifierFixture'];
  }): RuntimeFixture;
  restore(): void;
}

const PROVIDER = 'codex';
const SOURCE_ID = 'codex-xurl-source';
const FP = (s: string) => `fp-${s}`;

test('official xurl explicit backfill succeeds and persists canonical rendered-Timeline identity', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, successScenario());
    const fixture = env.createRuntime({
      authorFixture: ({ bundle }) => ({
        body: 'Promote the xurl-backed external report delivery skill.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'xurl-explicit-backfill-report-delivery',
          description: 'Deliver reports from canonical xurl external turns.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          rationale: 'xurl explicit backfill reuses the ordinary runtime learning path',
        },
      }),
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'xurl explicit backfill accepted',
        registryReadSet: [],
      }),
    });

    const request = makeRequest({
      operationId: 'xurl-success',
      resourceRefs: ['conversation-success'],
      endPosition: 2,
    });
    const result = await fixture.runtime.runExternalBackfill(request, createSource(env, request));

    assert.equal(result.backfill.status, 'completed');
    assert.equal(result.review.status, 'succeeded');
    assert.equal(result.backfill.ingestedEvents, 1);
    assert.equal(result.backfill.admittedEpisodes, 0);
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 0);
    assert.equal(fixture.runtime.getEvidenceCapsuleStore().count(), 0);

    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.equal(state.resourceCursors['conversation-success']?.position, 2);
    const processedKey = Object.keys(state.processedEventIds)[0]!;
    assert.match(processedKey, /agents:\/\/codex\/conversation-success#1-2::2::/);
    assert.match(processedKey, /::conversation-success::branch-main::rev-success$/);
    assert.equal(
      state.processedEventIds[processedKey],
      XURL_TEST_HELPERS.computeContentHash([
        { role: 'User', content: 'Please generate and send the report.' },
        { role: 'Assistant', content: 'Done.' },
      ]),
    );

    const invocations = readInvocationLog(env.logPath);
    assert.deepEqual(invocations.map(item => item.action), ['version', 'query', 'read']);
    assert.equal(invocations[0]!.args[0], '--version');
    assert.equal(invocations[1]!.args[0], 'agents://codex?limit=100');
    assert.equal(invocations[2]!.args[0], 'agents://codex/conversation-success');
    assert.equal(JSON.stringify(invocations).includes('session-log-v1'), false);
  } finally {
    env.restore();
  }
});

test('malformed rendered catalog fails closed without operational retry entries', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: { rawStdout: '# markdown fallback is forbidden\n' },
    } satisfies FakeXurlScenario);
    const fixture = env.createRuntime();
    const request = makeRequest({ operationId: 'xurl-invalid-rendered-catalog' });

    const result = await fixture.runtime.runExternalBackfill(request, createSource(env, request));

    assert.equal(result.backfill.status, 'source_failed');
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 0);
    assert.equal(loadReviewQueueState(env.reviewQueuePath).operational.length, 0);
    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.equal(state.failures.length, 1);
    assert.match(state.failures[0]!.message, /frontmatter|rendered|catalog/i);
    const sourceFailure = fixture.runtime.getExternalSourceFailureState().get(SOURCE_ID);
    assert.equal(sourceFailure?.failureClass, 'protocol');
    assert.equal(sourceFailure?.requiresOperatorAction, true);
  } finally {
    env.restore();
  }
});

test('xurl timeout fails as a source failure without review retry pollution', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        delayMs: 250,
        catalog: catalogPage([thread('conversation-success', 'branch-main', 2, FP('success-2'), 'rev-success')]),
      },
    } satisfies FakeXurlScenario);
    const fixture = env.createRuntime();
    const request = makeRequest({ operationId: 'xurl-timeout' });

    const result = await fixture.runtime.runExternalBackfill(request, createSource(env, request, { timeoutMs: 50 }));

    assert.equal(result.backfill.status, 'source_failed');
    assert.equal(loadReviewQueueState(env.reviewQueuePath).operational.length, 0);
    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.match(state.failures[0]!.message, /timed out/i);
    const sourceFailure = fixture.runtime.getExternalSourceFailureState().get(SOURCE_ID);
    assert.equal(sourceFailure?.failureClass, 'transient');
    assert.ok(sourceFailure?.nextRetryAt);
  } finally {
    env.restore();
  }
});

test('xurl oversized output and non-zero exit fail closed', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: { rawStdout: 'x'.repeat(8_192) },
    } satisfies FakeXurlScenario);
    const fixture = env.createRuntime();
    const oversizedRequest = makeRequest({ operationId: 'xurl-oversized-output' });

    const oversized = await fixture.runtime.runExternalBackfill(
      oversizedRequest,
      createSource(env, oversizedRequest, { maxOutputBytes: 512 }),
    );

    assert.equal(oversized.backfill.status, 'source_failed');
    assert.equal(loadReviewQueueState(env.reviewQueuePath).operational.length, 0);
    const oversizedState = loadExternalSessionLogBackfillState(oversized.paths.stateFilePath)!;
    assert.match(oversizedState.failures[0]!.message, /output exceeded/i);

    writeScenario(env.scenarioPath, {
      discover: { exitCode: 23, stderr: 'permission denied' },
    } satisfies FakeXurlScenario);
    const exitRequest = makeRequest({ operationId: 'xurl-non-zero-exit' });
    const exited = await fixture.runtime.runExternalBackfill(exitRequest, createSource(env, exitRequest));

    assert.equal(exited.backfill.status, 'source_failed');
    const exitState = loadExternalSessionLogBackfillState(exited.paths.stateFilePath)!;
    assert.match(exitState.failures[0]!.message, /status 23/i);
  } finally {
    env.restore();
  }
});

test('page failure replays safely after restart and acknowledges only after the full page succeeds', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, pageScenario());
    const request = makeRequest({
      operationId: 'xurl-page-replay',
      resourceRefs: ['conversation-page'],
      endPosition: 4,
    });

    const failing = env.createRuntime({
      authorFixture: ({ bundle }) => ({
        body: 'Promote replayed xurl backfill evidence.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'xurl-page-replay-delivery',
          description: 'Recover replayed xurl evidence after a page failure.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          rationale: 'page replay remains idempotent before acknowledgement',
        },
      }),
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'replayed page accepted',
        registryReadSet: [],
      }),
    });

    const evidenceIngestor = (failing.runtime as unknown as { evidenceIngestor: { ingest: (unit: unknown) => unknown } }).evidenceIngestor;
    const originalIngest = evidenceIngestor.ingest.bind(evidenceIngestor);
    let ingestCalls = 0;
    evidenceIngestor.ingest = (unit) => {
      ingestCalls += 1;
      if (ingestCalls === 2) {
        throw new Error('simulated second-event ingestion failure');
      }
      return originalIngest(unit);
    };

    const first = await failing.runtime.runExternalBackfill(request, createSource(env, request));
    assert.equal(first.backfill.status, 'source_failed');
    const firstState = loadExternalSessionLogBackfillState(first.paths.stateFilePath)!;
    assert.equal(firstState.resourceCursors['conversation-page'], undefined, 'page cursor not acknowledged on failure');
    assert.ok(
      Object.keys(firstState.processedEventIds).some(key => key.includes('agents://codex/conversation-page#1-2')),
      'first stable event recorded for replay-safe deduplication',
    );
    assert.equal(Object.keys(firstState.processedEventIds).length, 1);

    const recovery = env.createRuntime({
      authorFixture: ({ bundle }) => ({
        body: 'Promote replayed xurl backfill evidence.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'xurl-page-replay-delivery',
          description: 'Recover replayed xurl evidence after a page failure.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          rationale: 'page replay remains idempotent before acknowledgement',
        },
      }),
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'replayed page accepted',
        registryReadSet: [],
      }),
    });

    const second = await recovery.runtime.runExternalBackfill(request, createSource(env, request));
    assert.equal(second.backfill.status, 'completed');
    assert.equal(second.backfill.duplicateEventsSkipped, 1);
    assert.equal(second.backfill.ingestedEvents, 1);
    assert.equal(Object.keys(recovery.episodeStore.load().episodes).length, 0);
    const secondState = loadExternalSessionLogBackfillState(second.paths.stateFilePath)!;
    assert.equal(secondState.resourceCursors['conversation-page']?.position, 4);
    assert.equal(Object.keys(secondState.processedEventIds).length, 2);
  } finally {
    env.restore();
  }
});

test('rerun is idempotent when the provider replays the same stable rendered page', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, successScenario());
    const fixture = env.createRuntime();
    const request = makeRequest({ operationId: 'xurl-idempotent-rerun', endPosition: 2 });
    const source = createSource(env, request, { maxOutputBytes: 4_096 });

    const first = await fixture.runtime.runExternalBackfill(request, source);
    const second = await fixture.runtime.runExternalBackfill(request, source);

    assert.equal(first.backfill.status, 'completed');
    assert.equal(second.backfill.status, 'completed');
    assert.equal(second.backfill.duplicateEventsSkipped, 1);
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 0);
    assert.equal(fixture.runtime.getEvidenceCapsuleStore().count(), 0);
  } finally {
    env.restore();
  }
});

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-xurl-'));
  tempRoots.push(root);

  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');
  const outputDir = defaultDistilledOutputDir(path.join(root, 'skills'));
  const logPath = path.join(root, 'tmp', 'xurl-invocations.jsonl');
  const scenarioPath = path.join(root, 'tmp', 'xurl-scenario.json');
  const commandPath = path.join(root, 'tmp', 'fake-xurl.cjs');

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    XIAOBA_SKILLS_DIR: process.env.XIAOBA_SKILLS_DIR,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
    XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE: process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE,
    XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED,
    XURL_SCENARIO_PATH: process.env.XURL_SCENARIO_PATH,
    XURL_LOG_PATH: process.env.XURL_LOG_PATH,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = reassessmentManifestPath;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';

  writeFakeXurl(commandPath);

  return {
    root,
    reviewQueuePath,
    logPath,
    scenarioPath,
    commandPath,
    createRuntime(options = {}) {
      const skillEvolution = new SkillEvolutionRuntime({
        workingDirectory: root,
        outputDir,
        registryPath,
        auditPath,
        journalPath,
        reviewQueuePath,
        settlementWindowMs: 0,
        operationalRetryMs: 0,
        operationalRetryMaxMs: 60_000,
        logEnabled: false,
        authorFixture: options.authorFixture,
        verifierFixture: options.verifierFixture,
      });
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
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
        settlementWindowMs: 0,
      });

      return {
        runtime: new RuntimeLearning({
          workingDirectory: root,
          evidenceIngestor,
          learningEpisodeStore: episodeStore,
          skillEvolution,
          curator,
          planner,
          sessionLogSources: [],
        }),
        episodeStore,
        skillEvolution,
      };
    },
    restore() {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function createSource(
  env: TestEnv,
  request: ExternalSessionLogBackfillRequest,
  overrides: Partial<{ timeoutMs: number; maxOutputBytes: number }> = {},
): XurlExternalBackfillSource {
  return new XurlExternalBackfillSource({
    command: env.commandPath,
    provider: request.provider,
    sourceId: request.sourceId,
    sourceLabel: 'Fake xurl source',
    env: {
      ...process.env,
      XURL_SCENARIO_PATH: env.scenarioPath,
      XURL_LOG_PATH: env.logPath,
    },
    timeoutMs: overrides.timeoutMs,
    maxOutputBytes: overrides.maxOutputBytes,
  });
}

function makeRequest(overrides: Partial<{
  operationId: string;
  provider: string;
  sourceId: string;
  resourceRefs: string[];
  startPosition: number;
  endPosition: number;
}> = {}): ExternalSessionLogBackfillRequest {
  return {
    operationId: overrides.operationId ?? 'xurl-backfill-op',
    triggeredBy: 'operator:test',
    provider: overrides.provider ?? PROVIDER,
    sourceId: overrides.sourceId ?? SOURCE_ID,
    range: {
      startPosition: overrides.startPosition ?? 0,
      endPosition: overrides.endPosition ?? 2,
      resourceRefs: overrides.resourceRefs ?? ['conversation-success'],
    },
    limits: {
      maxResources: 10,
      maxBytes: 1024 * 1024,
      maxElapsedMs: 60_000,
    },
  };
}

function successScenario(): FakeXurlScenario {
  return {
    version: 'xurl-test 1.0.0',
    discover: {
      catalog: catalogPage([
        thread('conversation-success', 'branch-main', 2, FP('success-2'), 'rev-success'),
      ]),
    },
    read: {
      'conversation-success': readSpec(
        timeline('conversation-success', 'branch-main', 2, FP('success-2'), [
          entry(1, 'User', 'Please generate and send the report.'),
          entry(2, 'Assistant', 'Done.'),
        ], 'rev-success'),
      ),
    },
  };
}

function pageScenario(): FakeXurlScenario {
  return {
    discover: {
      catalog: catalogPage([
        thread('conversation-page', 'branch-main', 4, FP('page-4'), 'rev-page'),
      ]),
    },
    read: {
      'conversation-page': readSpec(
        timeline('conversation-page', 'branch-main', 4, FP('page-4'), [
          entry(1, 'User', 'Generate the first report.'),
          entry(2, 'Assistant', 'First report delivered.'),
          entry(3, 'User', 'Generate the second report.'),
          entry(4, 'Assistant', 'Second report delivered.'),
        ], 'rev-page'),
      ),
    },
  };
}

function thread(threadId: string, branch: string, ordinal: number, fingerprint: string, revision?: string): ThreadSummarySpec {
  return { threadId, branch, ordinal, fingerprint, ...(revision ? { revision } : {}) };
}

function catalogPage(threads: ThreadSummarySpec[], next?: string): CatalogPageSpec {
  return { provider: PROVIDER, next: next ?? null, threads };
}

function timeline(
  threadId: string,
  branch: string,
  ordinal: number,
  fingerprint: string,
  entries: { ordinal: number; role: 'User' | 'Assistant' | 'Context Compacted'; content: string }[],
  revision?: string,
): TimelineSpec {
  return {
    provider: PROVIDER,
    threadId,
    branch,
    ordinal,
    fingerprint,
    entries,
    ...(revision ? { revision } : {}),
  };
}

function entry(ordinal: number, role: 'User' | 'Assistant' | 'Context Compacted', content: string) {
  return { ordinal, role, content } as const;
}

function readSpec(timelineSpec: TimelineSpec, head?: { ordinal: number; fingerprint: string }) {
  return { timeline: timelineSpec, ...(head ? { head } : {}) };
}

import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import {
  LearningEpisodeStore,
  type LearningEpisodeStoreOptions,
  type LearningEpisodeStoreState,
} from '../src/utils/learning-episode';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { RuntimeLearning } from '../src/utils/runtime-learning';
import { loadExternalCursorState } from '../src/utils/session-log-source';
import type { ExternalSessionLogBackfillRequest } from '../src/utils/session-log-backfill';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { XurlExternalBackfillSource } from '../src/utils/xurl-session-log-source';
import {
  ExternalProviderOverrideStore,
  resolveExternalProviderOverridePath,
} from '../src/utils/external-provider-controls';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import {
  ThreadSummarySpec,
  TimelineSpec,
  readInvocationLog,
  writeFakeXurl,
  writeScenario,
} from './helpers/xurl-rendered-fixtures';

const PROVIDER = 'codex';
const SOURCE_ID = 'external-codex';
const THREAD_ID = 'conversation-history';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary RuntimeLearning wake admits one stable xURL history through an immutable target', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      version: 'xurl-test 1.0.0',
      discover: {
        pages: {
          start: catalogPage([
            thread(THREAD_ID, 'branch-main', 4, 'fp-history-4'),
          ]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-history-4', [
            entry(1, 'User', 'How do I parse a JSONL file line by line in Node?'),
            entry(2, 'Assistant', 'Use a readline interface and validate each parsed record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    const fixture = env.createRuntime();
    const wake = await fixture.runtime.wake('startup');

    const external = wake.discovery.sources.find(source => source.sourceId === SOURCE_ID);
    assert.ok(external);
    assert.equal(external.unitsProcessed, 2);

    const state = loadExternalCursorState(cursorStorePath(env.root)) as ReturnType<typeof loadExternalCursorState> & {
      catchUpTargets?: Record<string, {
        readonly provider: string;
        readonly sourceId: string;
        readonly resourceRef: string;
        readonly position: number | null;
        readonly prefixDigest: string;
        readonly creationGeneration: number;
        readonly scopeFingerprint: string;
      }>;
      catchUpResources?: Record<string, {
        readonly status: string;
        readonly historicalCursor: { readonly position: number };
      }>;
    };
    const target = state.catchUpTargets?.[THREAD_ID];
    assert.ok(target, 'catch-up persists a per-thread target before admission');
    assert.deepEqual(
      {
        provider: target.provider,
        sourceId: target.sourceId,
        resourceRef: target.resourceRef,
        position: target.position,
        creationGeneration: target.creationGeneration,
      },
      {
        provider: PROVIDER,
        sourceId: SOURCE_ID,
        resourceRef: THREAD_ID,
        position: 4,
        creationGeneration: 1,
      },
    );
    assert.equal(
      target.prefixDigest,
      '29b60fc1c1514cc5a0b223030cd41a5236207b439e9c9cc34b191d121ef17257',
    );
    assert.match(target.scopeFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(state.catchUpResources?.[THREAD_ID]?.status, 'complete');
    assert.equal(state.catchUpResources?.[THREAD_ID]?.historicalCursor.position, 4);

    const episodes = Object.values(fixture.episodeStore.load().episodes);
    assert.ok(episodes.length > 0, 'historical evidence reaches the ordinary Learning Episode path');
    assert.ok(episodes.every(episode => episode.status !== 'historical-pending'));
    assert.ok(wake.review.reviewedEpisodes > 0, 'target reconciliation releases ordinary review');
    assert.equal(
      Object.keys(fixture.runtime.getSkillEvolution().getRegistry().capabilities).length,
      1,
      'the released historical episode reaches successful ordinary promotion',
    );
    assert.deepEqual(
      readInvocationLog(env.logPath).map(invocation => invocation.action),
      ['version', 'query', 'read', 'read', 'read', 'read'],
      'one thread uses two bounded observations for its target and replay-safe admission',
    );

    const immutableTarget = loadExternalCursorState(cursorStorePath(env.root)).catchUpTargets[THREAD_ID];
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 6, 'fp-history-6')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 6, 'fp-history-6', [
            entry(1, 'User', 'How do I parse a JSONL file line by line in Node?'),
            entry(2, 'Assistant', 'Use a readline interface and validate each parsed record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
            entry(5, 'User', 'Please send one more report.'),
            entry(6, 'Assistant', 'Done.'),
          ]),
        },
      },
    });
    const continuous = env.createRuntime();
    const continuousWake = await continuous.runtime.wake('scheduled');
    assert.equal(continuousWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 1);
    const afterAppend = loadExternalCursorState(cursorStorePath(env.root));
    assert.deepEqual(afterAppend.catchUpTargets[THREAD_ID], immutableTarget);
    assert.equal(afterAppend.cursors[THREAD_ID]?.cursor.position, 6);
  } finally {
    env.restore();
  }
});

test('an incomplete-only thread gets an empty target and its first completed turn stays continuous', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 1, 'fp-incomplete-1')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 1, 'fp-incomplete-1', [
            entry(1, 'User', 'Please deliver the report.'),
          ]),
        },
      },
    });

    const first = env.createRuntime();
    const firstWake = await first.runtime.wake('startup');
    assert.equal(firstWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    const afterEmpty = loadExternalCursorState(cursorStorePath(env.root));
    const emptyTarget = afterEmpty.catchUpTargets[THREAD_ID];
    assert.ok(emptyTarget);
    assert.equal(emptyTarget.empty, true);
    assert.equal(emptyTarget.position, null);
    assert.equal(
      emptyTarget.prefixDigest,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(afterEmpty.catchUpResources[THREAD_ID]?.status, 'complete');
    assert.equal(afterEmpty.cursors[THREAD_ID]?.cursor.position, 1);

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 2, 'fp-complete-2')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 2, 'fp-complete-2', [
            entry(1, 'User', 'Please deliver the report.'),
            entry(2, 'Assistant', 'Done. The report is ready.'),
          ]),
        },
      },
    });

    const restarted = env.createRuntime();
    const secondWake = await restarted.runtime.wake('scheduled');
    assert.equal(secondWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 1);
    const afterContinuous = loadExternalCursorState(cursorStorePath(env.root));
    assert.deepEqual(afterContinuous.catchUpTargets[THREAD_ID], emptyTarget, 'the fixed empty target is immutable');
    assert.equal(afterContinuous.cursors[THREAD_ID]?.cursor.position, 2);
    assert.ok(
      Object.values(restarted.episodeStore.load().episodes)
        .every(episode => episode.historicalTarget === undefined),
      'the first later completed event uses the continuous lane',
    );
  } finally {
    env.restore();
  }
});

test('a crash after the historical Episode write replays after restart without premature review or duplication', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-crash-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-crash-4', [
            entry(1, 'User', 'Please deliver a verified JSONL parser.'),
            entry(2, 'Assistant', 'Done. The parser validates every record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    let injectedCrash = false;
    const crashing = env.createRuntime({
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
      episodeStoreOptions: {
        atomicWrite(filePath, state) {
          atomicWriteEpisodeState(filePath, state);
          if (
            !injectedCrash
            && Object.values(state.episodes).some(episode => episode.status === 'historical-pending')
          ) {
            injectedCrash = true;
            throw new Error('simulated crash after durable historical Episode write');
          }
        },
      },
    });
    const crashedWake = await crashing.runtime.wake('startup');
    const crashedEpisodes = Object.values(crashing.episodeStore.load().episodes);
    assert.equal(crashedEpisodes.length, 1);
    assert.equal(crashedEpisodes[0]!.status, 'historical-pending');
    assert.equal(crashedWake.review.reviewedEpisodes, 0);
    assert.equal(crashing.runtime.getEvidenceCapsuleStore().count(), 0);
    const crashedState = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(crashedState.catchUpResources[THREAD_ID]?.status, 'historical-pending');
    assert.equal(crashedState.catchUpResources[THREAD_ID]?.historicalCursor.position, -1);

    const config = getDistillationHeartbeatConfig(env.root);
    const overrides = new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    });
    overrides.setProviderHistoryMode(PROVIDER, 'future-only');
    const paused = env.createRuntime({
      clock: () => new Date('2026-01-01T00:10:00.000Z'),
    });
    const pausedWake = await paused.runtime.wake('scheduled');
    assert.equal(pausedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    assert.equal(Object.values(paused.episodeStore.load().episodes)[0]?.status, 'historical-pending');
    assert.equal(loadExternalCursorState(cursorStorePath(env.root)).catchUpResources[THREAD_ID]?.historicalCursor.position, -1);

    overrides.setProviderHistoryMode(PROVIDER, 'catch-up');
    const restarted = env.createRuntime({
      clock: () => new Date('2026-01-01T00:20:00.000Z'),
    });
    const replayedWake = await restarted.runtime.wake('scheduled');
    const replayedEpisodes = Object.values(restarted.episodeStore.load().episodes);
    assert.equal(replayedEpisodes.length, 1, 'replay deduplicates the durable Episode');
    assert.notEqual(replayedEpisodes[0]!.status, 'historical-pending');
    assert.equal(restarted.runtime.getEvidenceCapsuleStore().count(), 1);
    assert.equal(replayedWake.review.reviewedEpisodes, 1);
    const completedState = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(completedState.catchUpResources[THREAD_ID]?.status, 'complete');
    assert.equal(completedState.catchUpResources[THREAD_ID]?.historicalCursor.position, 4);
  } finally {
    env.restore();
  }
});

test('a crash after target cursor completion reconciles historical-pending episodes on restart', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-reconcile-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-reconcile-4', [
            entry(1, 'User', 'How do I parse JSONL incrementally?'),
            entry(2, 'Assistant', 'Use readline and validate each record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    let injectedCrash = false;
    const crashing = env.createRuntime({
      episodeStoreOptions: {
        atomicWrite(filePath, state) {
          if (!injectedCrash && Object.values(state.episodes).some(episode => episode.status === 'eligible')) {
            injectedCrash = true;
            throw new Error('simulated crash before target reconciliation write');
          }
          atomicWriteEpisodeState(filePath, state);
        },
      },
    });
    const crashedWake = await crashing.runtime.wake('startup');
    assert.equal(crashedWake.review.reviewedEpisodes, 0);
    assert.equal(crashing.runtime.getEvidenceCapsuleStore().count(), 1);
    assert.equal(Object.values(crashing.episodeStore.load().episodes)[0]?.status, 'historical-pending');
    const completedCursor = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(completedCursor.catchUpResources[THREAD_ID]?.status, 'complete');
    assert.equal(completedCursor.catchUpResources[THREAD_ID]?.historicalCursor.position, 4);

    const restarted = env.createRuntime();
    const replayedWake = await restarted.runtime.wake('scheduled');
    assert.equal(replayedWake.review.reviewedEpisodes, 1);
    assert.equal(Object.values(restarted.episodeStore.load().episodes).length, 1);
    assert.notEqual(Object.values(restarted.episodeStore.load().episodes)[0]?.status, 'historical-pending');
    assert.equal(restarted.runtime.getEvidenceCapsuleStore().count(), 1);
  } finally {
    env.restore();
  }
});

test('catch-up completes normally when historical evidence yields no Learning Episode candidate', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 2, 'fp-no-candidate-2')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 2, 'fp-no-candidate-2', [
            entry(1, 'User', 'Please generate and send the report.'),
            entry(2, 'Assistant', 'Done.'),
          ]),
        },
      },
    });

    const fixture = env.createRuntime();
    const wake = await fixture.runtime.wake('startup');
    assert.equal(wake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 1);
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 0);
    assert.equal(fixture.runtime.getEvidenceCapsuleStore().count(), 0);
    assert.equal(wake.review.reviewedEpisodes, 0);
    const state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpTargets[THREAD_ID]?.position, 2);
    assert.equal(state.catchUpResources[THREAD_ID]?.status, 'complete');
    assert.equal(state.catchUpResources[THREAD_ID]?.historicalCursor.position, 2);
  } finally {
    env.restore();
  }
});

test('catch-up deduplicates prior continuous and later explicit-backfill observations without adding a retroactive gate', async () => {
  const env = setupEnv({ historyMode: 'future-only' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: { start: catalogPage([thread(THREAD_ID, 'branch-main', 0, 'fp-baseline-0')]) },
        catalog: catalogPage([thread(THREAD_ID, 'branch-main', 0, 'fp-baseline-0')]),
      },
    });
    await env.createRuntime().runtime.wake('startup');

    const completedScenario = {
      discover: {
        pages: { start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-dedup-4')]) },
        catalog: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-dedup-4')]),
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-dedup-4', [
            entry(1, 'User', 'How do I parse a JSONL file line by line in Node?'),
            entry(2, 'Assistant', 'Use readline and validate every parsed record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    };
    writeScenario(env.scenarioPath, completedScenario);
    const continuous = env.createRuntime();
    await continuous.runtime.wake('scheduled');
    const episodeIds = Object.keys(continuous.episodeStore.load().episodes);
    const capsuleCount = continuous.runtime.getEvidenceCapsuleStore().count();
    assert.equal(episodeIds.length, 1);
    assert.equal(capsuleCount, 1);
    assert.equal(continuous.episodeStore.load().episodes[episodeIds[0]!]!.historicalTarget, undefined);

    const config = getDistillationHeartbeatConfig(env.root);
    const overrides = new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    });
    overrides.setProviderHistoryMode(PROVIDER, 'catch-up');
    const catchUp = env.createRuntime();
    await catchUp.runtime.wake('scheduled');
    const afterCatchUp = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterCatchUp.catchUpResources[THREAD_ID]?.status, 'complete');
    assert.equal(afterCatchUp.catchUpResources[THREAD_ID]?.historicalCursor.position, 4);
    assert.deepEqual(Object.keys(catchUp.episodeStore.load().episodes), episodeIds);
    assert.equal(catchUp.runtime.getEvidenceCapsuleStore().count(), capsuleCount);
    assert.equal(catchUp.episodeStore.load().episodes[episodeIds[0]!]!.historicalTarget, undefined);

    const request: ExternalSessionLogBackfillRequest = {
      operationId: 'issue-98-cross-lane-dedup',
      triggeredBy: 'operator:test',
      provider: PROVIDER,
      sourceId: SOURCE_ID,
      range: {
        startPosition: 0,
        endPosition: 4,
        resourceRefs: [THREAD_ID],
      },
      limits: {
        maxResources: 1,
        maxBytes: 1024 * 1024,
        maxElapsedMs: 60_000,
      },
    };
    await catchUp.runtime.runExternalBackfill(request, new XurlExternalBackfillSource({
      command: env.commandPath,
      provider: PROVIDER,
      sourceId: SOURCE_ID,
    }));
    assert.deepEqual(Object.keys(catchUp.episodeStore.load().episodes), episodeIds);
    assert.equal(catchUp.runtime.getEvidenceCapsuleStore().count(), capsuleCount);
  } finally {
    env.restore();
  }
});

test('missing history configuration remains future-only and imports no existing xURL history', async () => {
  const env = setupEnv({ historyMode: null });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-future-only-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-future-only-4', [
            entry(1, 'User', 'Historical request.'),
            entry(2, 'Assistant', 'Historical response.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });
    const fixture = env.createRuntime();
    const wake = await fixture.runtime.wake('startup');
    assert.equal(wake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 0);
    const state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.cursors[THREAD_ID]?.cursor.position, 4);
    assert.deepEqual(state.catchUpTargets, {});
    assert.deepEqual(state.catchUpResources, {});
    const config = getDistillationHeartbeatConfig(env.root);
    assert.equal(config.externalSessionLogHistoryMode, 'future-only');
    assert.equal(
      config.externalSessionLogHistoryModeDiagnostic,
      'External history mode is not configured; using future-only.',
    );
  } finally {
    env.restore();
  }
});

interface TestEnv {
  readonly root: string;
  readonly scenarioPath: string;
  readonly commandPath: string;
  readonly logPath: string;
  createRuntime(options?: {
    clock?: () => Date;
    episodeStoreOptions?: LearningEpisodeStoreOptions;
  }): { runtime: RuntimeLearning; episodeStore: LearningEpisodeStore };
  restore(): void;
}

function setupEnv(options: { historyMode?: 'future-only' | 'catch-up' | null } = {}): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-xurl-catch-up-'));
  tempRoots.push(root);

  const dataRoot = path.join(root, 'data');
  const reviewQueuePath = path.join(dataRoot, 'review-queue.json');
  const registryPath = path.join(dataRoot, 'current-skill-registry.json');
  const auditPath = path.join(dataRoot, 'transition-audit.jsonl');
  const journalPath = path.join(dataRoot, 'transition-journal.json');
  const reassessmentManifestPath = path.join(dataRoot, 'reassessment-manifest.json');
  const curatorStatePath = path.join(dataRoot, 'curator-state.json');
  const ledgerPath = path.join(dataRoot, 'skill-usage-ledger.jsonl');
  const outputDir = defaultDistilledOutputDir(path.join(root, 'skills'));
  const logPath = path.join(root, 'tmp', 'xurl-invocations.jsonl');
  const scenarioPath = path.join(root, 'tmp', 'xurl-scenario.json');
  const commandPath = path.join(root, 'tmp', 'fake-xurl.cjs');

  const changedEnv = [
    'DISTILLATION_HEARTBEAT_ENABLED',
    'DISTILLATION_HEARTBEAT_LOG_ROOT',
    'XIAOBA_SKILLS_DIR',
    'XIAOBA_RUNTIME_ROOT',
    'XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE',
    'XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED',
    'XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER',
    'XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID',
    'XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND',
    'XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE',
    'XURL_SCENARIO_PATH',
    'XURL_LOG_PATH',
  ] as const;
  const savedEnv = Object.fromEntries(changedEnv.map(key => [key, process.env[key]]));

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = reassessmentManifestPath;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER = PROVIDER;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID = SOURCE_ID;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = commandPath;
  if (options.historyMode === null) {
    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE;
  } else {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = options.historyMode ?? 'catch-up';
  }
  process.env.XURL_SCENARIO_PATH = scenarioPath;
  process.env.XURL_LOG_PATH = logPath;
  writeFakeXurl(commandPath);

  return {
    root,
    scenarioPath,
    commandPath,
    logPath,
    createRuntime(options = {}) {
      const episodeStorePath = path.join(dataRoot, 'learning-episodes.json');
      const episodeStore = new LearningEpisodeStore(episodeStorePath, options.episodeStoreOptions);
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
        authorFixture: ({ bundle }) => ({
          body: 'Parse JSONL incrementally and validate each record.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'parse-jsonl-incrementally',
            description: 'Parse JSONL safely with bounded incremental reads.',
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          },
        }),
        verifierFixture: () => ({
          decision: 'accept' as const,
          transition: 'create_current_skill' as const,
          issues: [],
          rationale: 'accepted',
          registryReadSet: [],
        }),
      });
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
      return {
        runtime: new RuntimeLearning({
          workingDirectory: root,
          evidenceIngestor: new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 }),
          learningEpisodeStore: episodeStore,
          skillEvolution,
          curator,
          planner,
          clock: options.clock,
        }),
        episodeStore,
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

function atomicWriteEpisodeState(filePath: string, state: LearningEpisodeStoreState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.test.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function cursorStorePath(root: string): string {
  return path.join(root, 'data', PROVIDER, `${SOURCE_ID}.json`);
}

function thread(threadId: string, branch: string, ordinal: number, fingerprint: string): ThreadSummarySpec {
  return { threadId, branch, ordinal, fingerprint };
}

function catalogPage(threads: ThreadSummarySpec[]) {
  return { provider: PROVIDER, next: null, threads };
}

function timeline(
  threadId: string,
  branch: string,
  ordinal: number,
  fingerprint: string,
  entries: TimelineSpec['entries'],
): TimelineSpec {
  return { provider: PROVIDER, threadId, branch, ordinal, fingerprint, entries };
}

function entry(
  ordinal: number,
  role: 'User' | 'Assistant' | 'Context Compacted',
  content: string,
) {
  return { ordinal, role, content };
}

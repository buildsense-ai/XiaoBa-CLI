import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getXurlVersion } from '../src/utils/xurl-compatibility';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { RuntimeLearning } from '../src/utils/runtime-learning';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import {
  ExternalSessionLogSourceAdapter,
  loadExternalCursorState,
  resolveExternalCursorStorePath,
} from '../src/utils/session-log-source';
import {
  materializeOfficialXurlSmokeFixtures,
  validateOfficialXurlSmokeFixtures,
} from './helpers/official-xurl-smoke-fixtures';
import { assertNoActiveHandles, establishAmbientBaseline } from '../src/utils/active-handle-assertions';
import { acquireExternalSourceProviderLock } from '../src/utils/external-source-provider-lock';

const ENABLED = /^(1|true|yes|on)$/i.test(process.env.XIAOBA_OFFICIAL_XURL_SMOKE ?? '');
const CATCH_UP_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.XIAOBA_OFFICIAL_XURL_CATCH_UP_SMOKE ?? '',
);
const COMMAND = process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND?.trim() ?? '';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('official xurl smoke (opt-in)', () => {
  const prerequisiteFailure = resolveSmokeSkipReason(ENABLED, 'XIAOBA_OFFICIAL_XURL_SMOKE');

  test('baseline, concurrent reads, serialized durable admission, and cleanup', {
    skip: prerequisiteFailure || false,
  }, async () => {
    establishAmbientBaseline();
    validateOfficialXurlSmokeFixtures();

    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-official-xurl-smoke-'));
    tempRoots.push(runtimeRoot);
    const fixtureRoots = materializeOfficialXurlSmokeFixtures(runtimeRoot);
    const savedEnv = { ...process.env };
    const originalExecFile = childProcess.execFile;
    const originalReadAsync = ExternalSessionLogSourceAdapter.prototype.readAsync;
    const activeChildren = new Set<childProcess.ChildProcess>();
    let maxActiveChildren = 0;

    (childProcess as typeof childProcess & {
      execFile: typeof childProcess.execFile;
    }).execFile = ((...args: Parameters<typeof childProcess.execFile>) => {
      const child = originalExecFile(...args);
      activeChildren.add(child);
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren.size);
      const cleanup = () => { activeChildren.delete(child); };
      child.once('error', cleanup);
      child.once('exit', cleanup);
      child.once('close', cleanup);
      return child;
    }) as typeof childProcess.execFile;

    try {
      configureSmokeEnvironment(runtimeRoot, fixtureRoots.env, ['codex', 'claude', 'pi'], 'future-only');
      let activeReadCalls = 0;
      let maxConcurrentReadCalls = 0;
      const awaitReadPeer = createReadOverlapBarrier();
      ExternalSessionLogSourceAdapter.prototype.readAsync = async function (...args) {
        activeReadCalls++;
        maxConcurrentReadCalls = Math.max(maxConcurrentReadCalls, activeReadCalls);
        try {
          await awaitReadPeer();
          return await originalReadAsync.apply(this, args);
        } finally {
          activeReadCalls--;
        }
      };
      const { runtime, episodeStore } = createSmokeRuntime(runtimeRoot);

      const coordinator = runtime.getExternalAdmissionCoordinator();
      const originalAdmitPage = coordinator.admitPage.bind(coordinator);
      let activeAdmissions = 0;
      let maxConcurrentAdmissions = 0;
      const admittedProviders: string[] = [];
      coordinator.admitPage = ((page, knownProviders) => {
        activeAdmissions++;
        maxConcurrentAdmissions = Math.max(maxConcurrentAdmissions, activeAdmissions);
        admittedProviders.push(page.providerId);
        try {
          return originalAdmitPage(page, knownProviders);
        } finally {
          activeAdmissions--;
        }
      }) as typeof coordinator.admitPage;

      const baseline = await runtime.wake('startup');
      assert.equal(Object.keys(episodeStore.load().episodes).length, 0, 'baseline must not admit historical episodes');
      assert.equal(runtime.getEvidenceCapsuleStore().count(), 0, 'baseline must not persist historical capsules');
      assert.equal(baseline.discovery.sources.filter(source => source.category === 'external').length, 3);

      for (const provider of ['codex', 'claude', 'pi'] as const) {
        const state = JSON.parse(fs.readFileSync(resolveExternalCursorStorePath({
          provider,
          sourceId: `external-${provider}`,
        }), 'utf8')) as { processedEventIds?: Record<string, string> };
        assert.equal(Object.keys(state.processedEventIds ?? {}).length, 0, `baseline must not acknowledge historical events for ${provider}`);
      }

      fixtureRoots.appendStableCompletedTurn('codex');
      fixtureRoots.appendStableCompletedTurn('claude');
      fixtureRoots.appendStableCompletedTurn('pi');

      const afterAppend = await runtime.wake('scheduled');
      assert.ok(maxConcurrentReadCalls > 1 || maxActiveChildren > 1, 'external reads should overlap under concurrency > 1');
      assert.equal(maxConcurrentAdmissions, 1, 'durable admissions must remain serialized');
      assert.ok(new Set(admittedProviders).size >= 2, 'at least two providers should admit durable work');
      assert.ok(Object.keys(episodeStore.load().episodes).length >= 1, 'official smoke should create a Learning Episode');
      assert.ok(runtime.getEvidenceCapsuleStore().count() >= 1, 'official smoke should create an Evidence Capsule');
      assert.equal(afterAppend.discovery.sources.filter(source => source.category === 'external').length, 3);

      await runtime.drain(1_000);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(activeReadCalls, 0, 'no read seam should remain active after drain');
      assert.equal(activeAdmissions, 0, 'no admission should remain active after drain');
      assert.equal(activeChildren.size, 0, 'no xurl child handles should remain after drain');
      assertProviderLocksReleased(runtimeRoot, ['codex', 'claude', 'pi']);
      assertNoActiveHandles();
    } finally {
      (childProcess as typeof childProcess & {
        execFile: typeof childProcess.execFile;
      }).execFile = originalExecFile;
      ExternalSessionLogSourceAdapter.prototype.readAsync = originalReadAsync;
      restoreEnvironment(savedEnv);
    }
  });

  const catchUpPrerequisiteFailure = resolveSmokeSkipReason(
    CATCH_UP_ENABLED,
    'XIAOBA_OFFICIAL_XURL_CATCH_UP_SMOKE',
  );

  test('catch-up admits sanitized history through public wakes and exits cleanly', {
    skip: catchUpPrerequisiteFailure || false,
  }, async () => {
    establishAmbientBaseline();
    validateOfficialXurlSmokeFixtures();

    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-official-xurl-catch-up-smoke-'));
    tempRoots.push(runtimeRoot);
    const fixtureRoots = materializeOfficialXurlSmokeFixtures(runtimeRoot);
    fixtureRoots.appendStableCompletedTurn('codex', 1);
    fixtureRoots.appendStableCompletedTurn('claude', 1);
    const savedEnv = { ...process.env };
    const originalExecFile = childProcess.execFile;
    const originalReadAsync = ExternalSessionLogSourceAdapter.prototype.readAsync;
    const activeChildren = new Set<childProcess.ChildProcess>();
    let maxActiveChildren = 0;

    (childProcess as typeof childProcess & {
      execFile: typeof childProcess.execFile;
    }).execFile = ((...args: Parameters<typeof childProcess.execFile>) => {
      const child = originalExecFile(...args);
      activeChildren.add(child);
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren.size);
      const cleanup = () => { activeChildren.delete(child); };
      child.once('error', cleanup);
      child.once('exit', cleanup);
      child.once('close', cleanup);
      return child;
    }) as typeof childProcess.execFile;

    try {
      configureSmokeEnvironment(runtimeRoot, fixtureRoots.env, ['codex', 'claude'], 'catch-up');
      let activeReadCalls = 0;
      let maxConcurrentReadCalls = 0;
      const awaitReadPeer = createReadOverlapBarrier();
      ExternalSessionLogSourceAdapter.prototype.readAsync = async function (...args) {
        activeReadCalls++;
        maxConcurrentReadCalls = Math.max(maxConcurrentReadCalls, activeReadCalls);
        try {
          await awaitReadPeer();
          return await originalReadAsync.apply(this, args);
        } finally {
          activeReadCalls--;
        }
      };
      const { runtime, episodeStore } = createSmokeRuntime(runtimeRoot);

      const coordinator = runtime.getExternalAdmissionCoordinator();
      const originalAdmitPage = coordinator.admitPage.bind(coordinator);
      let activeAdmissions = 0;
      let maxConcurrentAdmissions = 0;
      const admittedProviders = new Set<string>();
      coordinator.admitPage = ((page, knownProviders) => {
        activeAdmissions++;
        maxConcurrentAdmissions = Math.max(maxConcurrentAdmissions, activeAdmissions);
        admittedProviders.add(page.providerId);
        try {
          return originalAdmitPage(page, knownProviders);
        } finally {
          activeAdmissions--;
        }
      }) as typeof coordinator.admitPage;

      let appendedContinuousTurns = false;
      let caughtUp = false;
      for (let wakeNumber = 0; wakeNumber < 24; wakeNumber++) {
        await runtime.wake(wakeNumber === 0 ? 'startup' : 'scheduled');
        const states = ['codex', 'claude'].map(provider => loadProviderCursorState(provider));
        if (!appendedContinuousTurns && states.every(state => Object.keys(state.catchUpTargets).length > 0)) {
          fixtureRoots.appendStableCompletedTurn('codex', 2);
          fixtureRoots.appendStableCompletedTurn('claude', 2);
          appendedContinuousTurns = true;
        }
        caughtUp = states.every(state => state.catchUpCatalog.active?.status === 'caught-up');
        if (
          caughtUp
          && appendedContinuousTurns
          && (maxConcurrentReadCalls > 1 || maxActiveChildren > 1)
          && admittedProviders.size >= 2
        ) break;
      }

      const historicalEpisodes = Object.values(episodeStore.load().episodes)
        .filter(episode => episode.historicalTarget !== undefined);
      assert.equal(caughtUp, true, 'bounded public wakes should complete both provider catch-up generations');
      assert.ok(historicalEpisodes.length >= 1, 'historical evidence should create ordinary Learning Episodes');
      assert.ok(runtime.getEvidenceCapsuleStore().count() >= 1, 'historical evidence should create Evidence Capsules');
      assert.ok(maxConcurrentReadCalls > 1 || maxActiveChildren > 1, 'provider reads should overlap');
      assert.equal(maxConcurrentAdmissions, 1, 'durable admissions must remain serialized');
      assert.ok(admittedProviders.size >= 2, 'at least two providers should admit evidence');

      const diagnostics = runtime.loadHeartbeatRecord().externalSourceDiagnostics;
      assert.equal(diagnostics.overallReadiness, 'ready');
      for (const provider of ['codex', 'claude']) {
        const diagnostic = diagnostics.providers.find(entry => entry.provider === provider);
        assert.equal(diagnostic?.historyMode, 'catch-up');
        assert.equal(diagnostic?.catchUpState, 'caught_up');
        assert.equal(diagnostic?.sourceHealth, 'healthy');
      }

      await runtime.drain(1_000);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(activeReadCalls, 0, 'no read seam should remain active after drain');
      assert.equal(activeAdmissions, 0, 'no admission should remain active after drain');
      assert.equal(activeChildren.size, 0, 'no xurl child handles should remain after drain');
      assertProviderLocksReleased(runtimeRoot, ['codex', 'claude']);
      assertNoActiveHandles();
    } finally {
      (childProcess as typeof childProcess & {
        execFile: typeof childProcess.execFile;
      }).execFile = originalExecFile;
      ExternalSessionLogSourceAdapter.prototype.readAsync = originalReadAsync;
      restoreEnvironment(savedEnv);
    }
  });
});

function resolveSmokeSkipReason(enabled: boolean, flagName: string): string | null {
  if (!enabled) {
    return `${flagName} is disabled`;
  }
  if (!COMMAND) {
    return 'XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND is not set';
  }
  const diagnostic = getXurlVersion(COMMAND);
  if (diagnostic.source !== 'cli') {
    return `installed xurl command is unavailable: ${COMMAND}`;
  }
  try {
    validateOfficialXurlSmokeFixtures();
  } catch (error) {
    return `official xurl smoke fixtures are invalid: ${String(error)}`;
  }
  return null;
}

function configureSmokeEnvironment(
  runtimeRoot: string,
  fixtureEnv: Record<string, string>,
  providers: readonly string[],
  historyMode: 'future-only' | 'catch-up',
): void {
  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.XIAOBA_RUNTIME_ROOT = runtimeRoot;
  process.env.XIAOBA_SKILLS_DIR = path.join(runtimeRoot, 'skills');
  process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = path.join(
    runtimeRoot,
    'data',
    'reassessment-manifest.json',
  );
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = providers.join(',');
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = historyMode;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = COMMAND;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '3';
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID;
  Object.assign(process.env, fixtureEnv);
}

function createSmokeRuntime(runtimeRoot: string): {
  runtime: RuntimeLearning;
  episodeStore: LearningEpisodeStore;
} {
  const reviewQueuePath = path.join(runtimeRoot, 'data', 'review-queue.json');
  const reassessmentManifestPath = path.join(runtimeRoot, 'data', 'reassessment-manifest.json');
  const curatorStatePath = path.join(runtimeRoot, 'data', 'curator-state.json');
  const episodeStorePath = path.join(runtimeRoot, 'data', 'learning-episodes.json');
  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: runtimeRoot,
    outputDir: defaultDistilledOutputDir(path.join(runtimeRoot, 'skills')),
    registryPath: path.join(runtimeRoot, 'data', 'current-skill-registry.json'),
    auditPath: path.join(runtimeRoot, 'data', 'transition-audit.jsonl'),
    journalPath: path.join(runtimeRoot, 'data', 'transition-journal.json'),
    reviewQueuePath,
    settlementWindowMs: 0,
    operationalRetryMs: 0,
    operationalRetryMaxMs: 60_000,
    logEnabled: false,
    authorFixture: ({ bundle }) => ({
      body: 'Promote an official-xurl smoke capability.',
      envelope: {
        decision: 'create_current_skill' as const,
        routingName: 'official-xurl-smoke-delivery',
        description: 'Deliver work learned from official xurl smoke inputs.',
        evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
        rationale: 'deterministic acceptance for official xurl smoke',
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
  const episodeStore = new LearningEpisodeStore(episodeStorePath);
  const curator = new SkillUsageCurator({
    ledger: new SkillUsageLedger(path.join(runtimeRoot, 'data', 'skill-usage-ledger.jsonl')),
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
      workingDirectory: runtimeRoot,
      evidenceIngestor: new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 }),
      learningEpisodeStore: episodeStore,
      skillEvolution,
      curator,
      planner,
    }),
    episodeStore,
  };
}

function loadProviderCursorState(provider: string) {
  return loadExternalCursorState(resolveExternalCursorStorePath({
    provider,
    sourceId: `external-${provider}`,
  }));
}

function restoreEnvironment(savedEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assertProviderLocksReleased(runtimeRoot: string, providers: readonly string[]): void {
  for (const provider of providers) {
    const lock = acquireExternalSourceProviderLock({
      runtimeRoot: path.join(runtimeRoot, 'data'),
      provider,
      operation: 'official-xurl-smoke-cleanup-check',
    });
    assert.equal(lock.acquired, true, `provider lock should be released for ${provider}`);
    if (lock.acquired) lock.release();
  }
}

function createReadOverlapBarrier(timeoutMs = 200): () => Promise<void> {
  let generation = 0;
  const waiters = new Map<number, Array<() => void>>();
  return async () => {
    const current = generation;
    const peers = waiters.get(current) ?? [];
    if (peers.length > 0) {
      generation++;
      waiters.delete(current);
      for (const release of peers) release();
      return;
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        const pending = waiters.get(current);
        if (pending) {
          waiters.set(current, pending.filter(release => release !== releaseSelf));
        }
        if (generation === current) generation++;
        resolve();
      }, timeoutMs);
      const releaseSelf = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.set(current, [releaseSelf]);
    });
  };
}

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
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import {
  ExternalProviderOverrideStore,
  resolveExternalProviderOverridePath,
} from '../src/utils/external-provider-controls';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import { loadExternalCursorState } from '../src/utils/session-log-source';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
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
}

interface TestEnv {
  readonly root: string;
  readonly scenarioPath: string;
  readonly logPath: string;
  readonly commandPath: string;
  readonly internalLogPath: string;
  createRuntime(): RuntimeFixture;
  restore(): void;
}

const PROVIDER = 'codex';
const SOURCE_ID = 'external-codex';
const FP = (s: string) => `fp-${s}`;

test('future-only enablement is metadata-only and internal lane remains independent', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      version: 'xurl-test 1.0.0',
      discover: {
        pages: {
          start: catalogPage([thread('conversation-main', 'branch-main', 1, FP('main-1'))]),
        },
      },
    });
    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Please deliver the internal result.', 'Done.'),
      turn(2, 'internal-session', 'Thanks.', 'You are welcome.'),
    ]);

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');

    const externalReport = result.discovery.sources.find(source => source.sourceId === SOURCE_ID);
    const internalReport = result.discovery.sources.find(source => source.sourceId === 'internal-xiaoba');
    assert.ok(externalReport);
    assert.ok(internalReport);
    assert.equal(externalReport!.enabled, true);
    assert.equal(externalReport!.unitsProcessed, 0);
    assert.ok(internalReport!.unitsProcessed >= 1);

    const state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.activation?.initialDiscoveryCompleted, true);
    assert.equal(state.cursors['conversation-main']?.cursor.position, 1);
    assert.equal(Object.keys(state.processedEventIds).length, 0);

    // First enablement is metadata-only: only the documented query command runs
    // (version + catalog query). No read or head is issued and no evidence is created.
    const invocations = readInvocationLog(env.logPath);
    assert.deepEqual(invocations.map(item => item.action), ['version', 'query']);
    assert.equal(invocations[0]!.args[0], '--version');
    assert.equal(invocations[1]!.args[0], `agents://${PROVIDER}?limit=50`);
  } finally {
    env.restore();
  }
});

test('path-scoped providers query the documented agents:///... URI with the provider filter', async () => {
  const env = setupEnv();
  try {
    createOverrideStore(env.root).enableProvider(PROVIDER, {
      scope: 'path',
      scopePath: '/workspace/smoke-project',
    });
    writeScenario(env.scenarioPath, {
      version: 'xurl-test 1.0.0',
      discover: {
        pages: {
          start: catalogPage([thread('conversation-main', 'branch-main', 1, FP('main-1'))]),
        },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const invocations = readInvocationLog(env.logPath);
    assert.deepEqual(invocations.map(item => item.action), ['version', 'query']);
    assert.equal(invocations[1]!.args[0], 'agents:///workspace/smoke-project?providers=codex&limit=50');
  } finally {
    env.restore();
  }
});

test('scope narrowing preserves out-of-scope resource state across restart', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([
            thread('conversation-in', 'branch-in', 2, FP('in-2')),
            thread('conversation-out', 'branch-out', 4, FP('out-4')),
          ]),
        },
      },
    });

    await env.createRuntime().runtime.wake('startup');
    const baselineState = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(baselineState.resources['conversation-out']?.resource.resourceRef, 'conversation-out');
    assert.equal(baselineState.cursors['conversation-out']?.cursor.position, 4);

    createOverrideStore(env.root).enableProvider(PROVIDER, {
      scope: 'path',
      scopePath: '/workspace/narrowed-project',
    });
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread('conversation-in', 'branch-in', 2, FP('in-2'))]),
        },
      },
    });

    await env.createRuntime().runtime.wake('scheduled');
    await env.createRuntime().runtime.wake('scheduled');

    const afterNarrow = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterNarrow.resources['conversation-out']?.resource.resourceRef, 'conversation-out');
    assert.equal(afterNarrow.resources['conversation-out']?.lifecycleStatus, 'active');
    assert.equal(afterNarrow.cursors['conversation-out']?.cursor.position, 4);

    const afterRestart = env.createRuntime();
    await afterRestart.runtime.wake('scheduled');
    const persisted = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(persisted.resources['conversation-out']?.resource.resourceRef, 'conversation-out');
    assert.equal(persisted.resources['conversation-out']?.lifecycleStatus, 'active');
    assert.equal(persisted.cursors['conversation-out']?.cursor.position, 4);
  } finally {
    env.restore();
  }
});

test('scope expansion baselines newly included history without historical admission', async () => {
  const env = setupEnv();
  try {
    createOverrideStore(env.root).enableProvider(PROVIDER, {
      scope: 'path',
      scopePath: '/workspace/narrow-path',
    });
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread('conversation-in', 'branch-in', 2, FP('in-2'))]),
        },
      },
    });

    await env.createRuntime().runtime.wake('startup');

    createOverrideStore(env.root).enableProvider(PROVIDER, { scope: 'global' });
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([
            thread('conversation-in', 'branch-in', 2, FP('in-2')),
            thread('conversation-new', 'branch-new', 4, FP('new-4')),
          ]),
        },
      },
      read: {
        'conversation-in': readSpec(
          timeline('conversation-in', 'branch-in', 2, FP('in-2'), [
            entry(1, 'User', 'Existing request'),
            entry(2, 'Assistant', 'Existing response.'),
          ]),
        ),
        'conversation-new': readSpec(
          timeline('conversation-new', 'branch-new', 4, FP('new-4'), [
            entry(1, 'User', 'Historical request 1'),
            entry(2, 'Assistant', 'Historical response 1.'),
            entry(3, 'User', 'Historical request 2'),
            entry(4, 'Assistant', 'Historical response 2.'),
          ]),
        ),
      },
    });

    const expanded = env.createRuntime();
    await expanded.runtime.wake('scheduled');
    const afterExpand = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterExpand.cursors['conversation-new']?.cursor.position, 4);
    assert.equal(Object.keys(afterExpand.processedEventIds).length, 0, 'scope expansion must not admit historical events');
    assert.equal(Object.keys(expanded.episodeStore.load().episodes).length, 0);

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([
            thread('conversation-in', 'branch-in', 2, FP('in-2')),
            thread('conversation-new', 'branch-new', 6, FP('new-6')),
          ]),
        },
      },
      read: {
        'conversation-in': readSpec(
          timeline('conversation-in', 'branch-in', 2, FP('in-2'), [
            entry(1, 'User', 'Existing request'),
            entry(2, 'Assistant', 'Existing response.'),
          ]),
        ),
        'conversation-new': readSpec(
          timeline('conversation-new', 'branch-new', 6, FP('new-6'), [
            entry(1, 'User', 'Historical request 1'),
            entry(2, 'Assistant', 'Historical response 1.'),
            entry(3, 'User', 'Historical request 2'),
            entry(4, 'Assistant', 'Historical response 2.'),
            entry(5, 'User', 'Please deliver the new report.'),
            entry(6, 'Assistant', 'Done step 3.'),
          ]),
        ),
      },
    });

    const admitting = env.createRuntime();
    await admitting.runtime.wake('scheduled');
    const afterAdmit = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterAdmit.cursors['conversation-new']?.cursor.position, 6);
    assert.equal(Object.keys(afterAdmit.processedEventIds).length, 1, 'only the newly appended range should be admitted');
    assert.equal(
      Object.keys(afterAdmit.processedEventFingerprints).length,
      1,
      'scope expansion should preserve only the newly admitted stable fingerprint',
    );
  } finally {
    env.restore();
  }
});

test('discovery pagination state survives restart and completes independently from event progress', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread('conversation-a', 'branch-a', 0, FP('a-0'))], 'page-2'),
          'page-2': catalogPage([thread('conversation-b', 'branch-b', 0, FP('b-0'))]),
        },
      },
      read: {
        'conversation-a': readSpec(timeline('conversation-a', 'branch-a', 0, FP('a-0'), [])),
        'conversation-b': readSpec(timeline('conversation-b', 'branch-b', 0, FP('b-0'), [])),
      },
    });

    const first = env.createRuntime();
    await first.runtime.wake('startup');
    const afterFirst = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterFirst.discovery?.nextPageToken, 'page-2');
    assert.ok(afterFirst.resources['conversation-a']);
    assert.ok(!afterFirst.resources['conversation-b']);

    const second = env.createRuntime();
    await second.runtime.wake('scheduled');
    const afterSecond = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterSecond.discovery?.nextPageToken, null);
    assert.ok(afterSecond.resources['conversation-a']);
    assert.ok(afterSecond.resources['conversation-b']);
  } finally {
    env.restore();
  }
});

test('incremental continuation preserves branch isolation and bounded same-branch continuity', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([
            thread('conversation-main', 'branch-main', 0, FP('main-0')),
            thread('conversation-side', 'branch-side', 0, FP('side-0')),
          ]),
        },
      },
      read: {
        'conversation-main': readSpec(
          timeline('conversation-main', 'branch-main', 4, FP('main-4'), [
            entry(1, 'User', 'Main branch step 1'),
            entry(2, 'Assistant', 'Done main step 1.'),
            entry(3, 'User', 'Main branch step 2'),
            entry(4, 'Assistant', 'Done main step 2.'),
          ]),
        ),
        'conversation-side': readSpec(
          timeline('conversation-side', 'branch-side', 2, FP('side-2'), [
            entry(1, 'User', 'Side branch step 1'),
            entry(2, 'Assistant', 'Done side step 1.'),
          ]),
        ),
      },
    });

    const first = env.createRuntime();
    await first.runtime.wake('startup');

    const second = env.createRuntime();
    const secondWake = await second.runtime.wake('scheduled');
    const secondExternal = secondWake.discovery.sources.find(source => source.sourceId === SOURCE_ID);
    assert.ok(secondExternal);
    assert.equal(secondExternal!.unitsProcessed, 3);

    const state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.resources['conversation-main']?.continuityTail.length, 2);
    assert.equal(state.resources['conversation-side']?.continuityTail.length, 1);
    assert.equal(state.resources['conversation-main']?.resource.firstEventIdentity?.branchId, 'branch-main');
    assert.equal(state.resources['conversation-side']?.resource.firstEventIdentity?.branchId, 'branch-side');
  } finally {
    env.restore();
  }
});

test('pending tail stays unacknowledged until a second stable observation admits it', async () => {
  const env = setupEnv();
  try {
    // First two wakes observe an incomplete tail (User with no Assistant): the
    // reader reports pending, the cursor never advances, and nothing is admitted.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread('conversation-main', 'branch-main', 0, FP('main-0'))]),
        },
      },
      read: {
        'conversation-main': readSpec(
          timeline('conversation-main', 'branch-main', 1, FP('main-pending-1'), [
            entry(1, 'User', 'Step 1'),
          ]),
        ),
      },
    });

    const first = env.createRuntime();
    await first.runtime.wake('startup');
    const pendingRuntime = env.createRuntime();
    await pendingRuntime.runtime.wake('scheduled');
    const pendingState = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(pendingState.cursors['conversation-main']?.cursor.position, 0);
    assert.equal(Object.keys(pendingState.processedEventIds).length, 0);
    const pendingExternal = (await pendingRuntime.runtime.wake('scheduled')).discovery.sources
      .find(source => source.sourceId === SOURCE_ID);
    assert.ok(pendingExternal);
    assert.notEqual(pendingExternal!.status, 'failed');

    // A later complete User-to-Assistant turn with a matching head observation is admitted.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread('conversation-main', 'branch-main', 0, FP('main-0'))]),
        },
      },
      read: {
        'conversation-main': readSpec(
          timeline('conversation-main', 'branch-main', 2, FP('main-stable-2'), [
            entry(1, 'User', 'Step 1'),
            entry(2, 'Assistant', 'Done step 1.'),
          ]),
        ),
      },
    });

    const admitted = env.createRuntime();
    await admitted.runtime.wake('scheduled');
    const admittedState = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(admittedState.cursors['conversation-main']?.cursor.position, 2);
    assert.equal(Object.keys(admittedState.processedEventIds).length, 1);
  } finally {
    env.restore();
  }
});

test('a mutated tail between observations stays pending without counting as a provider failure', async () => {
  const env = setupEnv();
  try {
    // The primary read renders a complete turn, but the head observation reports a
    // different fingerprint: the tail is still mutating, so the reader reports
    // pending, the cursor stays, and the lane is not marked failed.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread('conversation-main', 'branch-main', 0, FP('main-0'))]),
        },
      },
      read: {
        'conversation-main': readSpec(
          timeline('conversation-main', 'branch-main', 2, FP('main-read-1'), [
            entry(1, 'User', 'Step 1'),
            entry(2, 'Assistant', 'Done step 1.'),
          ]),
          { ordinal: 2, fingerprint: FP('main-read-2') },
        ),
      },
    });

    const first = env.createRuntime();
    await first.runtime.wake('startup');
    const second = env.createRuntime();
    const secondWake = await second.runtime.wake('scheduled');
    const external = secondWake.discovery.sources.find(source => source.sourceId === SOURCE_ID);
    assert.ok(external);
    assert.notEqual(external!.status, 'failed');
    const state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.cursors['conversation-main']?.cursor.position, 0);
    assert.equal(Object.keys(state.processedEventIds).length, 0);
  } finally {
    env.restore();
  }
});

test('restart replay is idempotent for an already-admitted stable event', async () => {
  const env = setupEnv();
  try {
    const stableRead: FakeXurlScenario = {
      discover: {
        pages: {
          start: catalogPage([thread('conversation-main', 'branch-main', 0, FP('main-0'))]),
        },
      },
      read: {
        'conversation-main': readSpec(
          timeline('conversation-main', 'branch-main', 2, FP('main-stable-2'), [
            entry(1, 'User', 'Step 1'),
            entry(2, 'Assistant', 'Done step 1.'),
          ]),
        ),
      },
    };
    writeScenario(env.scenarioPath, stableRead);

    const first = env.createRuntime();
    await first.runtime.wake('startup');
    const admitting = env.createRuntime();
    await admitting.runtime.wake('scheduled');
    const afterAdmit = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterAdmit.cursors['conversation-main']?.cursor.position, 2);
    assert.equal(Object.keys(afterAdmit.processedEventIds).length, 1);
    const episodesAfterAdmit = Object.keys(admitting.episodeStore.load().episodes).length;

    // Re-running the same wake with the same stable Timeline does not create a
    // duplicate episode or advance the cursor past the already-admitted range.
    const replay = env.createRuntime();
    await replay.runtime.wake('scheduled');
    const afterReplay = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterReplay.cursors['conversation-main']?.cursor.position, 2);
    assert.equal(Object.keys(afterReplay.processedEventIds).length, 1);
    assert.equal(Object.keys(replay.episodeStore.load().episodes).length, episodesAfterAdmit);
  } finally {
    env.restore();
  }
});

test('internal heartbeat remains healthy when the selected xurl provider fails', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: { rawStdout: '# not a valid rendered catalog\n' },
    });
    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Please deliver the internal result.', 'Done.'),
      turn(2, 'internal-session', 'Thanks.', 'You are welcome.'),
    ]);

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');
    const external = result.discovery.sources.find(source => source.sourceId === SOURCE_ID);
    const internal = result.discovery.sources.find(source => source.sourceId === 'internal-xiaoba');
    assert.ok(external);
    assert.ok(internal);
    assert.equal(external!.status, 'failed');
    assert.ok(internal!.unitsProcessed >= 1);
  } finally {
    env.restore();
  }
});

test('activation blocking is durable when the catalog exceeds the activation limit', async () => {
  const env = setupEnv({ maxActivationCatalog: 1 });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([
            thread('conversation-a', 'branch-a', 0, FP('a-0')),
            thread('conversation-b', 'branch-b', 0, FP('b-0')),
          ]),
        },
      },
    });
    writeInternalLog(env.internalLogPath, [turn(1, 'internal-session', 'Internal work.', 'Done.')]);

    const first = env.createRuntime();
    const firstResult = await first.runtime.wake('startup');
    const firstState = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(firstState.activation?.activationBlocked, true);
    assert.equal(firstState.activation?.initialDiscoveryCompleted, false);
    assert.equal(Object.keys(firstState.processedEventIds).length, 0);
    assert.equal(Object.keys(firstState.cursors).length, 0);

    // A later wake must not partially admit: the blocked flag persists.
    const second = env.createRuntime();
    const secondResult = await second.runtime.wake('scheduled');
    const secondState = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(secondState.activation?.activationBlocked, true);
    assert.equal(Object.keys(secondState.processedEventIds).length, 0);
    const external = secondResult.discovery.sources.find(source => source.sourceId === SOURCE_ID);
    assert.ok(external);
    // Internal heartbeat remains independent of the blocked external provider.
    const internal = secondResult.discovery.sources.find(source => source.sourceId === 'internal-xiaoba');
    assert.ok(internal);
    void firstResult;
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function setupEnv(options: { maxActivationCatalog?: number } = {}): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-xurl-continuous-'));
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
  const internalLogPath = path.join(root, 'logs', 'sessions', 'internal-session.jsonl');

  const savedEnv: Record<string, string | undefined> = {
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_INTERVAL_HOURS: process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
    XIAOBA_SKILLS_DIR: process.env.XIAOBA_SKILLS_DIR,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
    XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE: process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE,
    XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED,
    XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID,
    XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND: process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND,
    XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_CATALOG: process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_CATALOG,
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
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = PROVIDER;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER = PROVIDER;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID = SOURCE_ID;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = commandPath;
  if (options.maxActivationCatalog !== undefined) {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_CATALOG = String(options.maxActivationCatalog);
  } else {
    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_CATALOG;
  }

  writeFakeXurl(commandPath);
  process.env.XURL_SCENARIO_PATH = scenarioPath;
  process.env.XURL_LOG_PATH = logPath;

  return {
    root,
    scenarioPath,
    logPath,
    commandPath,
    internalLogPath,
    createRuntime() {
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
          body: 'Promote a deterministic xurl continuous skill.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'xurl-continuous-delivery',
            description: 'Deliver work learned from bounded xurl continuous events.',
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
            rationale: 'deterministic acceptance for continuous xurl wake tests',
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

function cursorStorePath(root: string): string {
  return path.join(root, 'data', PROVIDER, `${SOURCE_ID}.json`);
}

function createOverrideStore(root: string): ExternalProviderOverrideStore {
  const config = getDistillationHeartbeatConfig(root);
  return new ExternalProviderOverrideStore({
    stateFilePath: resolveExternalProviderOverridePath(config),
  });
}

function writeInternalLog(filePath: string, entries: SessionTurnLogEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function turn(turnNumber: number, sessionId: string, userText: string, assistantText: string): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn: turnNumber,
    timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: [] },
    tokens: { prompt: 10, completion: 10 },
  };
}

function thread(threadId: string, branch: string, ordinal: number, fingerprint: string, revision?: string): ThreadSummarySpec {
  return { threadId, branch, ordinal, fingerprint, ...(revision ? { revision } : {}) };
}

function catalogPage(
  threads: ThreadSummarySpec[],
  next?: string,
): { provider: string; next: string | null; threads: ThreadSummarySpec[] } {
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
  return { provider: PROVIDER, threadId, branch, ordinal, fingerprint, entries, ...(revision ? { revision } : {}) };
}

function entry(ordinal: number, role: 'User' | 'Assistant' | 'Context Compacted', content: string): { ordinal: number; role: 'User' | 'Assistant' | 'Context Compacted'; content: string } {
  return { ordinal, role, content };
}

function readSpec(tl: TimelineSpec, head?: { ordinal: number; fingerprint: string }): { timeline: TimelineSpec; head?: { ordinal: number; fingerprint: string } } {
  return { timeline: tl, ...(head ? { head } : {}) };
}

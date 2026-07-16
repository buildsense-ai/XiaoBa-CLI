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
import {
  RuntimeLearning,
  type DiscoveryWakeQuotas,
} from '../src/utils/runtime-learning';
import {
  ExternalSessionLogSourceAdapter,
  loadExternalCursorState,
  type SessionLogSourceAdapter,
  type SessionLogSourceReadResult,
  type SessionLogSourceResource,
  type SourceWorkBudget,
} from '../src/utils/session-log-source';
import type { ExternalSessionLogBackfillRequest } from '../src/utils/session-log-backfill';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import {
  XurlExternalBackfillSource,
  XurlExternalSourceReader,
} from '../src/utils/xurl-session-log-source';
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

interface ExternalEpisodeProvenanceFixture {
  readonly episodeToEvent: Record<string, string>;
  readonly eventToEpisodes: Record<string, string[]>;
}

class CrashOnceOnAcknowledgeAdapter extends ExternalSessionLogSourceAdapter {
  private shouldCrash = true;

  override acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    if (this.shouldCrash) {
      this.shouldCrash = false;
      throw new Error('simulated crash before cursor acknowledgement');
    }
    super.acknowledge(resource, result);
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary RuntimeLearning wakes admit one stable xURL history through an immutable target', async () => {
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
    const actionsByWake: string[][] = [];
    const sourceStateByWake: string[] = [];
    let priorInvocationCount = 0;
    let wake = await fixture.runtime.wake('startup');
    for (let wakeNumber = 0; wakeNumber < 4; wakeNumber++) {
      if (wakeNumber > 0) wake = await fixture.runtime.wake('scheduled');
      const invocations = readInvocationLog(env.logPath);
      actionsByWake.push(
        invocations.slice(priorInvocationCount).map(invocation => invocation.action),
      );
      priorInvocationCount = invocations.length;
      const state = loadExternalCursorState(cursorStorePath(env.root));
      const progress = state.catchUpResources[THREAD_ID];
      sourceStateByWake.push(
        progress?.status === 'target-pending'
          ? `target-pending:${progress.pendingSample ? 'sampled' : 'unsampled'}`
          : (progress?.status ?? state.catchUpCatalog.active?.status ?? 'idle'),
      );
    }

    assert.deepEqual(
      actionsByWake,
      [
        ['version', 'query'],
        ['read'],
        ['read', 'read'],
        ['read', 'read'],
      ],
      'the one catch-up action remains bounded while donated continuous capacity stays timely',
    );
    assert.deepEqual(
      sourceStateByWake,
      [
        'target-pending:unsampled',
        'target-pending:sampled',
        'historical-pending',
        'complete',
      ],
      'each wake derives exactly one inventory, stability observation, or due page from schema-v5 source state',
    );
    assert.equal(
      fs.existsSync(path.join(env.root, 'data', 'external-catch-up-scheduler-state.json')),
      false,
      'catch-up reuses source and admission-coordinator durability instead of a second scheduler state',
    );

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
    const initialInvocations = readInvocationLog(env.logPath).map(invocation => invocation.action);
    assert.equal(initialInvocations.filter(action => action === 'query').length, 1);
    assert.equal(initialInvocations.filter(action => action === 'read').length, 5);

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

test('official xURL catch-up inventory is metadata-only and defers Timeline sampling', async () => {
  const env = setupEnv({
    catchUpCatalogInitialLimit: 2,
    catchUpCatalogMaxResources: 4,
  });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        rawStdout: [
          '---',
          'uri: agents://codex?limit=2',
          'provider: codex',
          'version: xurl-test 1.0.0',
          'queried_at: 2026-01-01T00:00:00.000Z',
          'next:',
          '---',
          '',
          '# Threads',
          '- Matched: `1`',
          '',
          '## 1. `agents://codex/conversation-history`',
          '- Provider: `codex`',
          '- Thread ID: `conversation-history`',
          '- Updated At: `2026-01-01T00:00:00.000Z`',
          '',
        ].join('\n'),
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 2, 'fp-history-2', [
            entry(1, 'User', 'Inventory must not read this Timeline.'),
            entry(2, 'Assistant', 'Timeline sampling is a later bounded action.'),
          ]),
        },
      },
    });

    await env.createRuntime().runtime.wake('startup');

    assert.deepEqual(
      readInvocationLog(env.logPath).map(invocation => invocation.action),
      ['version', 'query'],
    );
    const state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpCatalog.active?.status, 'draining');
    assert.equal(state.catchUpResources[THREAD_ID]?.status, 'target-pending');
    assert.equal(state.catchUpTargets[THREAD_ID], undefined);
  } finally {
    env.restore();
  }
});

test('official xURL catch-up resumes an expanding-limit generation across Runtime restarts', async () => {
  const env = setupEnv({
    catchUpCatalogInitialLimit: 1,
    catchUpCatalogMaxResources: 4,
  });
  try {
    const resources = [
      thread('conversation-a', 'branch-main', 1, 'fp-a-1'),
      thread('conversation-b', 'branch-main', 1, 'fp-b-1'),
      thread('conversation-c', 'branch-main', 1, 'fp-c-1'),
    ];
    writeScenario(env.scenarioPath, {
      discover: {
        byLimit: {
          '1': catalogPage(resources.slice(0, 1)),
          '2': catalogPage(resources.slice(0, 2)),
          '4': catalogPage(resources),
        },
      },
      read: Object.fromEntries(resources.map(resource => [
        resource.threadId,
        {
          timeline: timeline(
            resource.threadId,
            resource.branch,
            resource.ordinal,
            resource.fingerprint,
            [entry(1, 'User', `Incomplete request for ${resource.threadId}.`)],
          ),
        },
      ])),
    });

    await env.createRuntime().runtime.wake('startup');
    let state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpCatalog.active?.generation, 1);
    assert.equal(state.catchUpCatalog.active?.requestedLimit, 2);

    await env.createRuntime().runtime.wake('scheduled');
    state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpCatalog.active?.generation, 1);
    assert.equal(state.catchUpCatalog.active?.requestedLimit, 4);

    await env.createRuntime().runtime.wake('scheduled');
    state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpCatalog.active?.status, 'draining');
    assert.equal(state.catchUpCatalog.active?.lastObservationCount, 3);
    assert.deepEqual(
      Object.fromEntries(Object.entries(state.catchUpResources).map(([resourceRef, resource]) => (
        [resourceRef, resource.observedGeneration]
      ))),
      {
        'conversation-a': 1,
        'conversation-b': 1,
        'conversation-c': 1,
      },
    );
    const queryUris = readInvocationLog(env.logPath)
      .filter(invocation => invocation.action === 'query')
      .map(invocation => invocation.args[0]);
    assert.deepEqual(queryUris, [
      'agents://codex?limit=1',
      'agents://codex?limit=2',
      'agents://codex?limit=4',
    ]);
    assert.ok(queryUris.every(uri => !uri.includes('cursor=')));
    await wakeUntilState(
      env.root,
      () => env.createRuntime().runtime.wake('scheduled'),
      current => current.catchUpCatalog.active?.status === 'caught-up',
    );
    state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpCatalog.active?.status, 'caught-up');
  } finally {
    env.restore();
  }
});

test('official xURL catch-up blocks durably when the catalog cap cannot prove exhaustion', async () => {
  const env = setupEnv({
    catchUpCatalogInitialLimit: 1,
    catchUpCatalogMaxResources: 2,
  });
  try {
    const resources = [
      thread('conversation-a', 'branch-main', 1, 'fp-a-1'),
      thread('conversation-b', 'branch-main', 1, 'fp-b-1'),
    ];
    writeScenario(env.scenarioPath, {
      discover: {
        byLimit: {
          '1': catalogPage(resources.slice(0, 1)),
          '2': catalogPage(resources),
        },
      },
      read: Object.fromEntries(resources.map(resource => [
        resource.threadId,
        {
          timeline: timeline(
            resource.threadId,
            resource.branch,
            1,
            resource.fingerprint,
            [entry(1, 'User', 'Incomplete catalog-cap fixture.')],
          ),
        },
      ])),
    });

    await env.createRuntime().runtime.wake('startup');
    await env.createRuntime().runtime.wake('scheduled');
    const blocked = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(blocked.catchUpCatalog.active?.status, 'catch-up-blocked');
    assert.match(blocked.catchUpCatalog.active?.blockedReason ?? '', /configured limit/);
    assert.equal(blocked.catchUpCatalog.active?.completedAt, undefined);
    const queriesBeforeRestart = readInvocationLog(env.logPath)
      .filter(invocation => invocation.action === 'query').length;

    await env.createRuntime().runtime.wake('scheduled');
    const restarted = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(restarted.catchUpCatalog.active?.status, 'catch-up-blocked');
    assert.equal(
      readInvocationLog(env.logPath).filter(invocation => invocation.action === 'query').length,
      queriesBeforeRestart,
      'a blocked generation does not restart or query a truncated catalog',
    );
  } finally {
    env.restore();
  }
});

test('a later generation discovers a new resource without redefining completed targets', async () => {
  const env = setupEnv({
    catchUpCatalogInitialLimit: 1,
    catchUpCatalogMaxResources: 4,
  });
  try {
    const threadA = thread('conversation-a', 'main', 1, 'fp-a-1');
    const threadB = thread('conversation-b', 'main', 1, 'fp-b-1');
    const read = {
      'conversation-a': {
        timeline: timeline('conversation-a', 'main', 1, 'fp-a-1', [
          entry(1, 'User', 'Incomplete first-generation fixture.'),
        ]),
      },
      'conversation-b': {
        timeline: timeline('conversation-b', 'main', 1, 'fp-b-1', [
          entry(1, 'User', 'Incomplete second-generation fixture.'),
        ]),
      },
    };
    writeScenario(env.scenarioPath, {
      discover: {
        byLimit: {
          '1': catalogPage([threadA]),
          '2': catalogPage([threadA]),
        },
      },
      read,
    });
    await env.createRuntime().runtime.wake('startup');
    await wakeUntilState(
      env.root,
      () => env.createRuntime().runtime.wake('scheduled'),
      current => current.catchUpCatalog.active?.status === 'caught-up',
    );
    const generationOne = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(generationOne.catchUpCatalog.active?.status, 'caught-up');
    const immutableTargetA = generationOne.catchUpTargets['conversation-a'];
    assert.ok(immutableTargetA);

    writeScenario(env.scenarioPath, {
      discover: {
        byLimit: {
          '1': catalogPage([threadA]),
          '2': catalogPage([threadA, threadB]),
          '4': catalogPage([threadA, threadB]),
        },
      },
      read,
    });
    await env.createRuntime().runtime.wake('scheduled');
    let generationTwo = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(generationTwo.catchUpCatalog.lastCompleted?.generation, 1);
    assert.equal(generationTwo.catchUpCatalog.active?.generation, 2);
    assert.equal(generationTwo.catchUpTargets['conversation-b'], undefined);

    await wakeUntilState(
      env.root,
      () => env.createRuntime().runtime.wake('scheduled'),
      current => current.catchUpCatalog.active?.generation === 2
        && current.catchUpCatalog.active.status === 'caught-up',
    );
    generationTwo = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(generationTwo.catchUpCatalog.active?.generation, 2);
    assert.equal(generationTwo.catchUpCatalog.active?.status, 'caught-up');
    assert.deepEqual(generationTwo.catchUpTargets['conversation-a'], immutableTargetA);
    assert.equal(generationTwo.catchUpTargets['conversation-b']?.creationGeneration, 2);
  } finally {
    env.restore();
  }
});

test('a moving expanding catalog retains every resource observed by the generation', async () => {
  const env = setupEnv({
    catchUpCatalogInitialLimit: 1,
    catchUpCatalogMaxResources: 4,
  });
  try {
    const threadA = thread('conversation-a', 'main', 1, 'fp-a-1');
    const threadB = thread('conversation-b', 'main', 1, 'fp-b-1');
    const threadC = thread('conversation-c', 'main', 1, 'fp-c-1');
    const resources = [threadA, threadB, threadC];
    writeScenario(env.scenarioPath, {
      discover: {
        byLimit: {
          '1': catalogPage([threadA]),
          '2': catalogPage([threadB, threadC]),
          '4': catalogPage([threadB, threadC]),
        },
      },
      read: Object.fromEntries(resources.map(resource => [
        resource.threadId,
        {
          timeline: timeline(resource.threadId, 'main', 1, resource.fingerprint, [
            entry(1, 'User', `Incomplete moving-catalog fixture for ${resource.threadId}.`),
          ]),
        },
      ])),
    });

    await env.createRuntime().runtime.wake('startup');
    await env.createRuntime().runtime.wake('scheduled');
    let state = loadExternalCursorState(cursorStorePath(env.root));
    assert.notEqual(state.catchUpCatalog.active?.status, 'caught-up');
    assert.equal(state.catchUpResources['conversation-a']?.observedGeneration, 1);

    await wakeUntilState(
      env.root,
      () => env.createRuntime().runtime.wake('scheduled'),
      current => current.catchUpCatalog.active?.status === 'caught-up',
    );
    state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpCatalog.active?.status, 'caught-up');
    assert.deepEqual(Object.keys(state.catchUpTargets).sort(), [
      'conversation-a',
      'conversation-b',
      'conversation-c',
    ]);
  } finally {
    env.restore();
  }
});

test('official xURL catch-up persists output and duration cap failures', async () => {
  const outputEnv = setupEnv({ catchUpCatalogMaxOutputBytes: 1 });
  try {
    writeScenario(outputEnv.scenarioPath, {
      discover: {
        pages: { start: catalogPage([thread('conversation-output', 'main', 0, 'fp-output')]) },
      },
    });
    await outputEnv.createRuntime().runtime.wake('startup');
    const outputBlocked = loadExternalCursorState(cursorStorePath(outputEnv.root));
    assert.equal(outputBlocked.catchUpCatalog.active?.status, 'catch-up-blocked');
    assert.match(outputBlocked.catchUpCatalog.active?.blockedReason ?? '', /output exceeded limit/);
  } finally {
    outputEnv.restore();
  }

  const durationEnv = setupEnv({
    catchUpCatalogInitialLimit: 1,
    catchUpCatalogMaxResources: 2,
    catchUpCatalogMaxDurationMs: 1,
  });
  try {
    writeScenario(durationEnv.scenarioPath, {
      discover: {
        byLimit: {
          '1': catalogPage([thread('conversation-duration', 'main', 1, 'fp-duration')]),
        },
      },
      read: {
        'conversation-duration': {
          timeline: timeline('conversation-duration', 'main', 1, 'fp-duration', [
            entry(1, 'User', 'Incomplete duration fixture.'),
          ]),
        },
      },
    });
    await durationEnv.createRuntime({
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    }).runtime.wake('startup');
    await durationEnv.createRuntime({
      clock: () => new Date('2026-01-01T00:00:00.010Z'),
    }).runtime.wake('scheduled');
    const durationBlocked = loadExternalCursorState(cursorStorePath(durationEnv.root));
    assert.equal(durationBlocked.catchUpCatalog.active?.status, 'catch-up-blocked');
    assert.match(durationBlocked.catchUpCatalog.active?.blockedReason ?? '', /duration exceeded limit/);
  } finally {
    durationEnv.restore();
  }
});

test('future-only scope narrowing does not read a preserved out-of-scope resource', async () => {
  const env = setupEnv({ historyMode: 'future-only' });
  try {
    const threadA = thread('conversation-a', 'branch-main', 0, 'fp-a-0');
    const threadB = thread('conversation-b', 'branch-main', 0, 'fp-b-0');
    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage([threadA, threadB]) } },
    });
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');
    assert.equal(loadExternalCursorState(cursorStorePath(env.root)).cursors['conversation-b']?.cursor.position, 0);

    const config = getDistillationHeartbeatConfig(env.root);
    new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    }).enableProvider(PROVIDER, {
      scope: 'path',
      scopePath: '/project/a',
    }, 'future-only');
    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage([threadA]) } },
      read: {
        'conversation-a': {
          timeline: timeline('conversation-a', 'branch-main', 1, 'fp-a-1', [
            entry(1, 'User', 'Still working in project A.'),
          ]),
        },
        'conversation-b': {
          timeline: timeline('conversation-b', 'branch-main', 2, 'fp-b-2', [
            entry(1, 'User', 'This completed turn is outside the narrowed scope.'),
            entry(2, 'Assistant', 'It must remain unread while project A is selected.'),
          ]),
        },
      },
    });

    const narrowedWake = await fixture.runtime.wake('scheduled');
    assert.equal(narrowedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    assert.equal(
      loadExternalCursorState(cursorStorePath(env.root)).cursors['conversation-b']?.cursor.position,
      0,
    );
    const readsAfterNarrowing = readInvocationLog(env.logPath)
      .filter(invocation => invocation.action === 'read')
      .map(invocation => invocation.args[0]);
    assert.ok(!readsAfterNarrowing.includes('agents://codex/conversation-b'));
  } finally {
    env.restore();
  }
});

test('mode and scope change invalidates the active generation while preserving paused targets', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: { start: catalogPage([thread('conversation-a', 'branch-main', 4, 'fp-a-4')]) },
      },
      read: {
        'conversation-a': {
          timeline: timeline('conversation-a', 'branch-main', 4, 'fp-a-4', [
            entry(1, 'User', 'Implement the first scoped parser.'),
            entry(2, 'Assistant', 'The first scoped parser is complete.'),
            entry(3, 'User', 'Verify the first scoped parser.'),
            entry(4, 'Assistant', 'The first scoped parser is verified.'),
          ]),
        },
      },
    });
    const fixture = env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 1 },
    });
    await fixture.runtime.wake('startup');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('scheduled');
    const beforePause = loadExternalCursorState(cursorStorePath(env.root));
    const targetA = beforePause.catchUpTargets['conversation-a'];
    assert.ok(targetA);
    assert.equal(beforePause.catchUpResources['conversation-a']?.historicalCursor.position, 2);

    const config = getDistillationHeartbeatConfig(env.root);
    const overrides = new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    });
    overrides.enableProvider(PROVIDER, {
      scope: 'path',
      scopePath: '/project/b',
    }, 'future-only');
    writeScenario(env.scenarioPath, {
      discover: {
        pages: { start: catalogPage([thread('conversation-b', 'branch-main', 2, 'fp-b-2')]) },
      },
      read: {
        'conversation-b': {
          timeline: timeline('conversation-b', 'branch-main', 2, 'fp-b-2', [
            entry(1, 'User', 'Implement the second scoped parser.'),
            entry(2, 'Assistant', 'The second scoped parser is complete.'),
          ]),
        },
      },
    });

    const pausedWake = await fixture.runtime.wake('scheduled');
    assert.equal(pausedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    const paused = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(paused.catchUpCatalog.active?.status, 'invalidated');
    assert.deepEqual(paused.catchUpTargets['conversation-a'], targetA);
    assert.equal(paused.catchUpResources['conversation-a']?.historicalCursor.position, 2);
    assert.equal(paused.cursors['conversation-b']?.cursor.position, 2, 'future-only expansion baselines history');
    assert.equal(paused.catchUpTargets['conversation-b'], undefined);

    overrides.setProviderHistoryMode(PROVIDER, 'catch-up');
    const resumedWake = await wakeUntilState(
      env.root,
      () => fixture.runtime.wake('scheduled'),
      current => current.catchUpResources['conversation-b']?.status === 'complete',
    );
    assert.ok(resumedWake);
    assert.equal(resumedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 1);
    const resumed = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(resumed.catchUpCatalog.active?.generation, 2);
    assert.equal(resumed.catchUpResources['conversation-b']?.status, 'complete');
    assert.deepEqual(resumed.catchUpTargets['conversation-a'], targetA);
    assert.equal(resumed.catchUpResources['conversation-a']?.historicalCursor.position, 2);
  } finally {
    env.restore();
  }
});

test('mode and scope changes discard an in-flight old-configuration read without acknowledgement', async () => {
  const env = setupEnv({
    catchUpCatalogInitialLimit: 2,
    catchUpCatalogMaxResources: 4,
  });
  try {
    const history = timeline(THREAD_ID, 'branch-main', 4, 'fp-in-flight-4', [
      entry(1, 'User', 'Implement the first bounded page.'),
      entry(2, 'Assistant', 'The first bounded page is complete.'),
      entry(3, 'User', 'Implement the second bounded page.'),
      entry(4, 'Assistant', 'The second bounded page is complete.'),
    ]);
    writeScenario(env.scenarioPath, {
      discover: {
        pages: { start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-in-flight-4')]) },
      },
      read: { [THREAD_ID]: { timeline: history } },
    });
    const fixture = env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 1 },
    });

    await fixture.runtime.wake('startup'); // inventory
    await fixture.runtime.wake('scheduled'); // first target observation
    await fixture.runtime.wake('scheduled'); // matching observation
    await fixture.runtime.wake('scheduled'); // first page
    const before = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(before.catchUpResources[THREAD_ID]?.historicalCursor.position, 2);
    const readsBefore = readInvocationLog(env.logPath)
      .filter(invocation => invocation.action === 'read').length;

    writeScenario(env.scenarioPath, {
      discover: {
        pages: { start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-in-flight-4')]) },
      },
      read: { [THREAD_ID]: { timeline: history, delayMs: 250 } },
    });
    const inFlightWake = fixture.runtime.wake('scheduled');
    await waitForInvocationCount(env.logPath, 'read', readsBefore + 1);

    const config = getDistillationHeartbeatConfig(env.root);
    new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    }).enableProvider(PROVIDER, {
      scope: 'path',
      scopePath: '/project/b',
    }, 'future-only');

    const discarded = await inFlightWake;
    assert.equal(discarded.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    const after = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(after.catchUpResources[THREAD_ID]?.historicalCursor.position, 2);
  } finally {
    env.restore();
  }
});

test('provider and global disable preserve an unfinished generation until re-enabled', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: { start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-disable-4')]) },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-disable-4', [
            entry(1, 'User', 'Implement the durable disable fixture.'),
            entry(2, 'Assistant', 'The durable disable fixture is implemented.'),
            entry(3, 'User', 'Verify the durable disable fixture.'),
            entry(4, 'Assistant', 'The durable disable fixture is verified.'),
          ]),
        },
      },
    });
    const initialRuntime = env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 1 },
    }).runtime;
    await initialRuntime.wake('startup');
    await initialRuntime.wake('scheduled');
    await initialRuntime.wake('scheduled');
    await initialRuntime.wake('scheduled');
    const pending = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(pending.catchUpResources[THREAD_ID]?.historicalCursor.position, 2);

    const config = getDistillationHeartbeatConfig(env.root);
    const overrides = new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    });
    overrides.disableProvider(PROVIDER);
    await env.createRuntime().runtime.wake('scheduled');
    let paused = loadExternalCursorState(cursorStorePath(env.root));
    assert.deepEqual(paused.catchUpCatalog, pending.catchUpCatalog);
    assert.deepEqual(paused.catchUpTargets, pending.catchUpTargets);
    assert.deepEqual(paused.catchUpResources, pending.catchUpResources);

    overrides.enableProvider(PROVIDER, undefined, 'catch-up');
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'false';
    await env.createRuntime().runtime.wake('scheduled');
    paused = loadExternalCursorState(cursorStorePath(env.root));
    assert.deepEqual(paused.catchUpCatalog, pending.catchUpCatalog);
    assert.deepEqual(paused.catchUpTargets, pending.catchUpTargets);
    assert.deepEqual(paused.catchUpResources, pending.catchUpResources);

    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    const resumedWake = await env.createRuntime().runtime.wake('scheduled');
    assert.equal(resumedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 1);
    const resumed = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(resumed.catchUpResources[THREAD_ID]?.status, 'complete');
    assert.equal(resumed.catchUpResources[THREAD_ID]?.historicalCursor.position, 4);
  } finally {
    env.restore();
  }
});

test('known future-only resources continue while catch-up inventory expands', async () => {
  const env = setupEnv({
    historyMode: 'future-only',
    catchUpCatalogInitialLimit: 1,
    catchUpCatalogMaxResources: 4,
  });
  try {
    const baselineA = thread('conversation-a', 'main', 0, 'fp-a-0');
    const baselineB = thread('conversation-b', 'main', 0, 'fp-b-0');
    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage([baselineA, baselineB]) } },
    });
    await env.createRuntime().runtime.wake('startup');

    const config = getDistillationHeartbeatConfig(env.root);
    new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    }).setProviderHistoryMode(PROVIDER, 'catch-up');
    writeScenario(env.scenarioPath, {
      discover: {
        byLimit: {
          '1': catalogPage([thread('conversation-a', 'main', 2, 'fp-a-2')]),
          '2': catalogPage([thread('conversation-a', 'main', 2, 'fp-a-2')]),
        },
      },
      read: {
        'conversation-a': {
          timeline: timeline('conversation-a', 'main', 2, 'fp-a-2', [
            entry(1, 'User', 'Historical work for A.'),
            entry(2, 'Assistant', 'Historical work for A is complete.'),
          ]),
        },
        'conversation-b': {
          timeline: timeline('conversation-b', 'main', 2, 'fp-b-2', [
            entry(1, 'User', 'Live work for known resource B.'),
            entry(2, 'Assistant', 'Live work for known resource B is complete.'),
          ]),
        },
      },
    });

    const wake = await env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 2 },
      externalSourceBudget: {
        maxResourcesPerWake: 2,
        maxBytesPerWake: 1024 * 1024,
        maxElapsedMsPerWake: 30_000,
      },
    }).runtime.wake('scheduled');
    assert.equal(wake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 2);
    let state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpResources['conversation-a']?.status, 'target-pending');
    assert.equal(state.cursors['conversation-b']?.cursor.position, 2);
    assert.equal(state.catchUpTargets['conversation-b'], undefined);
    await wakeUntilState(
      env.root,
      () => env.createRuntime({
        discoveryQuotas: { maxAdmittedEpisodesPerWake: 2 },
        externalSourceBudget: {
          maxResourcesPerWake: 2,
          maxBytesPerWake: 1024 * 1024,
          maxElapsedMsPerWake: 30_000,
        },
      }).runtime.wake('scheduled'),
      current => current.catchUpResources['conversation-a']?.status === 'complete',
    );
    state = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(state.catchUpResources['conversation-a']?.status, 'complete');
  } finally {
    env.restore();
  }
});

test('a long single-thread history advances in bounded pages across ordinary wakes', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 10, 'fp-long-history-10')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 10, 'fp-long-history-10', [
            entry(1, 'User', 'Implement parser one and verify its output.'),
            entry(2, 'Assistant', 'Done. Parser one is implemented and verified.'),
            entry(3, 'User', 'Implement parser two and verify its output.'),
            entry(4, 'Assistant', 'Done. Parser two is implemented and verified.'),
            entry(5, 'User', 'Implement parser three and verify its output.'),
            entry(6, 'Assistant', 'Done. Parser three is implemented and verified.'),
            entry(7, 'User', 'Implement parser four and verify its output.'),
            entry(8, 'Assistant', 'Done. Parser four is implemented and verified.'),
            entry(9, 'User', 'Implement parser five and verify its output.'),
            entry(10, 'Assistant', 'Done. Parser five is implemented and verified.'),
          ]),
        },
      },
    });

    const fixture = env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 2 },
      externalSourceBudget: {
        maxResourcesPerWake: 1,
        maxBytesPerWake: 4_096,
        maxElapsedMsPerWake: 30_000,
      },
    });

    await fixture.runtime.wake('startup');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('scheduled');

    const cursorPositions: number[] = [];
    const processedPerWake: number[] = [];
    for (let wakeNumber = 0; wakeNumber < 3; wakeNumber++) {
      const wake = await fixture.runtime.wake('scheduled');
      const external = wake.discovery.sources.find(source => source.sourceId === SOURCE_ID);
      assert.ok(external);
      assert.ok(external.unitsProcessed <= 2, 'one wake never admits more than its remaining event quota');
      assert.ok(wake.ingestion.admittedEpisodes <= 2, 'one wake never exceeds its admission quota');
      assert.ok((external.accounting?.bytes ?? 0) <= 4_096, 'one wake never exceeds its byte quota');
      processedPerWake.push(external.unitsProcessed);
      cursorPositions.push(
        loadExternalCursorState(cursorStorePath(env.root))
          .catchUpResources[THREAD_ID]?.historicalCursor.position ?? -1,
      );
    }

    assert.deepEqual(processedPerWake, [2, 2, 1]);
    assert.deepEqual(cursorPositions, [4, 8, 10]);
    const completed = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(completed.catchUpResources[THREAD_ID]?.status, 'complete');
    assert.equal(Object.keys(completed.processedEventIds).length, 5, 'each historical event is acknowledged once');
  } finally {
    env.restore();
  }
});

test('catch-up slices a single thread by the remaining external byte budget', async () => {
  const env = setupEnv();
  try {
    const request = 'Implement and verify the bounded parser behavior. '.repeat(8);
    const response = 'Done. The bounded parser behavior is implemented and verified. '.repeat(8);
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 8, 'fp-byte-pages-8')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 8, 'fp-byte-pages-8', [
            entry(1, 'User', request),
            entry(2, 'Assistant', response),
            entry(3, 'User', request),
            entry(4, 'Assistant', response),
            entry(5, 'User', request),
            entry(6, 'Assistant', response),
            entry(7, 'User', request),
            entry(8, 'Assistant', response),
          ]),
        },
      },
    });

    const maxBytesPerWake = 2_048;
    const fixture = env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 10 },
      externalSourceBudget: {
        maxResourcesPerWake: 1,
        maxBytesPerWake,
        maxElapsedMsPerWake: 30_000,
      },
    });

    const cursorPositions: number[] = [];
    for (let wakeNumber = 0; wakeNumber < 8; wakeNumber++) {
      const wake = await fixture.runtime.wake(wakeNumber === 0 ? 'startup' : 'scheduled');
      const external = wake.discovery.sources.find(source => source.sourceId === SOURCE_ID);
      assert.ok(external);
      assert.ok((external.accounting?.bytes ?? 0) <= maxBytesPerWake);
      const state = loadExternalCursorState(cursorStorePath(env.root));
      const position = state.catchUpResources[THREAD_ID]?.historicalCursor.position ?? -1;
      if (position > (cursorPositions.at(-1) ?? -1)) cursorPositions.push(position);
      if (state.catchUpResources[THREAD_ID]?.status === 'complete') break;
    }

    assert.ok(cursorPositions.length > 1, 'the byte budget requires more than one resumable page');
    assert.equal(cursorPositions.at(-1), 8);
  } finally {
    env.restore();
  }
});

test('one running Runtime pauses and resumes catch-up from durable history-mode changes', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-mode-refresh-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-mode-refresh-4', [
            entry(1, 'User', 'How do I parse JSONL incrementally?'),
            entry(2, 'Assistant', 'Use readline and validate each record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    const fixture = env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 1 },
    });
    await fixture.runtime.wake('startup');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('scheduled');
    const afterFirstPage = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(afterFirstPage.catchUpResources[THREAD_ID]?.historicalCursor.position, 2);
    assert.equal(afterFirstPage.catchUpResources[THREAD_ID]?.status, 'historical-pending');

    const config = getDistillationHeartbeatConfig(env.root);
    const overrides = new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    });
    overrides.setProviderHistoryMode(PROVIDER, 'future-only');

    const pausedWake = await fixture.runtime.wake('scheduled');
    assert.equal(pausedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    const paused = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(paused.catchUpResources[THREAD_ID]?.historicalCursor.position, 2);
    assert.equal(paused.catchUpResources[THREAD_ID]?.status, 'historical-pending');

    overrides.setProviderHistoryMode(PROVIDER, 'catch-up');
    const resumedWake = await fixture.runtime.wake('scheduled');
    assert.equal(resumedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 1);
    const resumed = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(resumed.catchUpResources[THREAD_ID]?.historicalCursor.position, 4);
    assert.equal(resumed.catchUpResources[THREAD_ID]?.status, 'complete');
  } finally {
    env.restore();
  }
});

test('wake-boundary provider refresh does not replace injected source adapters', async () => {
  const env = setupEnv();
  try {
    let discoveries = 0;
    const injected: SessionLogSourceAdapter = {
      identity: {
        sourceId: 'fixture-external',
        label: 'Fixture External Source',
        category: 'external',
        provider: 'fixture-provider',
        reader: 'fixture',
      },
      isEnabled: () => true,
      discoverResources: () => {
        discoveries += 1;
        return [];
      },
      read: () => {
        throw new Error('fixture has no resources to read');
      },
      acknowledge: () => undefined,
      markFailed: () => undefined,
    };
    const fixture = env.createRuntime({ sessionLogSources: [injected] });

    const config = getDistillationHeartbeatConfig(env.root);
    new ExternalProviderOverrideStore({
      stateFilePath: resolveExternalProviderOverridePath(config),
    }).setProviderHistoryMode(PROVIDER, 'future-only');

    await fixture.runtime.wake('scheduled');
    assert.equal(discoveries, 1);
    assert.deepEqual(fixture.runtime.getSessionLogSources(), [injected]);
  } finally {
    env.restore();
  }
});

test('a restart after target persistence resumes admission from the fixed target', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-target-restart-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-target-restart-4', [
            entry(1, 'User', 'How do I parse JSONL incrementally?'),
            entry(2, 'Assistant', 'Use readline and validate each record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    const interrupted = env.createRuntime({
      discoveryQuotas: { maxAdmittedEpisodesPerWake: 0 },
    });
    await interrupted.runtime.wake('startup');
    await interrupted.runtime.wake('scheduled');
    const firstWake = await interrupted.runtime.wake('scheduled');
    assert.equal(firstWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 0);
    const targetOnly = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(targetOnly.catchUpTargets[THREAD_ID]?.position, 4);
    assert.equal(targetOnly.catchUpResources[THREAD_ID]?.historicalCursor.position, -1);
    assert.equal(targetOnly.catchUpResources[THREAD_ID]?.status, 'historical-pending');
    assert.equal(Object.keys(interrupted.episodeStore.load().episodes).length, 0);

    const restarted = env.createRuntime();
    const resumedWake = await restarted.runtime.wake('scheduled');
    assert.equal(resumedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 2);
    const completed = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(completed.catchUpTargets[THREAD_ID]?.targetId, targetOnly.catchUpTargets[THREAD_ID]?.targetId);
    assert.equal(completed.catchUpResources[THREAD_ID]?.historicalCursor.position, 4);
    assert.equal(completed.catchUpResources[THREAD_ID]?.status, 'complete');
  } finally {
    env.restore();
  }
});

test('a Capsule persistence failure replays without provenance or cursor acknowledgement', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-capsule-replay-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-capsule-replay-4', [
            entry(1, 'User', 'How do I parse JSONL incrementally?'),
            entry(2, 'Assistant', 'Use readline and validate each record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    const crashing = env.createRuntime({
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const config = getDistillationHeartbeatConfig(env.root);
    const provenancePath = path.join(path.dirname(config.learningEpisodeStorePath), 'external-source-provenance.json');
    fs.mkdirSync(config.evidenceCapsulePath, { recursive: true });

    await crashing.runtime.wake('startup');
    await crashing.runtime.wake('scheduled');
    await crashing.runtime.wake('scheduled');
    const failedWake = await crashing.runtime.wake('scheduled');
    assert.equal(failedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.status, 'failed');
    const episodeIds = Object.keys(crashing.episodeStore.load().episodes);
    assert.equal(episodeIds.length, 1, 'Episode is durable before Capsule persistence');
    fs.rmSync(config.evidenceCapsulePath, { recursive: true, force: true });
    assert.equal(crashing.runtime.getEvidenceCapsuleStore().count(), 0);
    assert.equal(fs.existsSync(provenancePath), false, 'provenance cannot become durable before its Capsule');
    assert.equal(
      loadExternalCursorState(cursorStorePath(env.root)).catchUpResources[THREAD_ID]?.historicalCursor.position,
      -1,
    );

    const restarted = env.createRuntime({
      clock: () => new Date('2026-01-01T01:00:00.000Z'),
    });
    assert.equal(restarted.runtime.retryExternalSourceFailure(PROVIDER, SOURCE_ID), true);
    const replayedWake = await restarted.runtime.wake('scheduled');
    assert.equal(replayedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 2);
    assert.deepEqual(Object.keys(restarted.episodeStore.load().episodes), episodeIds);
    assert.equal(restarted.runtime.getEvidenceCapsuleStore().count(), 1);
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as ExternalEpisodeProvenanceFixture;
    assert.deepEqual(Object.keys(provenance.episodeToEvent), episodeIds);
    assert.equal(loadExternalCursorState(cursorStorePath(env.root)).catchUpResources[THREAD_ID]?.status, 'complete');
  } finally {
    env.restore();
  }
});

test('a provenance persistence crash replays the durable Episode and Capsule before cursor acknowledgement', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-provenance-replay-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-provenance-replay-4', [
            entry(1, 'User', 'How do I parse JSONL incrementally?'),
            entry(2, 'Assistant', 'Use readline and validate each record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    const crashing = env.createRuntime({
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const config = getDistillationHeartbeatConfig(env.root);
    const provenancePath = path.join(path.dirname(config.learningEpisodeStorePath), 'external-source-provenance.json');
    fs.mkdirSync(provenancePath, { recursive: true });

    await crashing.runtime.wake('startup');
    await crashing.runtime.wake('scheduled');
    await crashing.runtime.wake('scheduled');
    await crashing.runtime.wake('scheduled');
    const episodeIds = Object.keys(crashing.episodeStore.load().episodes);
    assert.equal(episodeIds.length, 1);
    assert.equal(crashing.runtime.getEvidenceCapsuleStore().count(), 1);
    assert.equal(
      loadExternalCursorState(cursorStorePath(env.root)).catchUpResources[THREAD_ID]?.historicalCursor.position,
      -1,
    );
    fs.rmSync(provenancePath, { recursive: true, force: true });

    const restarted = env.createRuntime({
      clock: () => new Date('2026-01-01T01:00:00.000Z'),
    });
    assert.equal(restarted.runtime.retryExternalSourceFailure(PROVIDER, SOURCE_ID), true);
    const replayedWake = await restarted.runtime.wake('scheduled');
    assert.equal(replayedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 2);
    assert.deepEqual(Object.keys(restarted.episodeStore.load().episodes), episodeIds);
    assert.equal(restarted.runtime.getEvidenceCapsuleStore().count(), 1);
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as ExternalEpisodeProvenanceFixture;
    assert.deepEqual(Object.keys(provenance.episodeToEvent), episodeIds);
    assert.equal(loadExternalCursorState(cursorStorePath(env.root)).catchUpResources[THREAD_ID]?.status, 'complete');
  } finally {
    env.restore();
  }
});

test('a cursor acknowledgement crash replays without duplicating Episode, Capsule, or provenance', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage([thread(THREAD_ID, 'branch-main', 4, 'fp-cursor-replay-4')]),
        },
      },
      read: {
        [THREAD_ID]: {
          timeline: timeline(THREAD_ID, 'branch-main', 4, 'fp-cursor-replay-4', [
            entry(1, 'User', 'How do I parse JSONL incrementally?'),
            entry(2, 'Assistant', 'Use readline and validate each record.'),
            entry(3, 'User', 'Thanks, that works perfectly!'),
            entry(4, 'Assistant', 'Glad it helped.'),
          ]),
        },
      },
    });

    let now = new Date('2026-01-01T00:00:00.000Z');
    const adapter = new CrashOnceOnAcknowledgeAdapter({
      sourceId: SOURCE_ID,
      provider: PROVIDER,
      reader: new XurlExternalSourceReader({
        command: env.commandPath,
        provider: PROVIDER,
        sourceId: SOURCE_ID,
      }),
      cursorStorePath: cursorStorePath(env.root),
      enabled: true,
      historyMode: 'catch-up',
      now: () => now,
    });
    const fixture = env.createRuntime({
      clock: () => now,
      sessionLogSources: [adapter],
    });

    await fixture.runtime.wake('startup');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('scheduled');
    const failedWake = await fixture.runtime.wake('scheduled');
    assert.equal(failedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.status, 'failed');
    const episodeIds = Object.keys(fixture.episodeStore.load().episodes);
    assert.equal(episodeIds.length, 1);
    assert.equal(fixture.runtime.getEvidenceCapsuleStore().count(), 1);
    const config = getDistillationHeartbeatConfig(env.root);
    const provenancePath = path.join(path.dirname(config.learningEpisodeStorePath), 'external-source-provenance.json');
    const beforeReplay = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as ExternalEpisodeProvenanceFixture;
    assert.deepEqual(Object.keys(beforeReplay.episodeToEvent), episodeIds);
    assert.equal(
      loadExternalCursorState(cursorStorePath(env.root)).catchUpResources[THREAD_ID]?.historicalCursor.position,
      -1,
    );

    now = new Date('2026-01-01T01:00:00.000Z');
    const replayedWake = await fixture.runtime.wake('scheduled');
    assert.equal(replayedWake.discovery.sources.find(source => source.sourceId === SOURCE_ID)?.unitsProcessed, 2);
    assert.deepEqual(Object.keys(fixture.episodeStore.load().episodes), episodeIds);
    assert.equal(fixture.runtime.getEvidenceCapsuleStore().count(), 1);
    const afterReplay = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as ExternalEpisodeProvenanceFixture;
    assert.deepEqual(afterReplay, beforeReplay);
    const completed = loadExternalCursorState(cursorStorePath(env.root));
    assert.equal(completed.catchUpResources[THREAD_ID]?.historicalCursor.position, 4);
    assert.equal(completed.catchUpResources[THREAD_ID]?.status, 'complete');
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
    await first.runtime.wake('startup');
    await first.runtime.wake('scheduled');
    const firstWake = await first.runtime.wake('scheduled');
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
    await crashing.runtime.wake('startup');
    await crashing.runtime.wake('scheduled');
    await crashing.runtime.wake('scheduled');
    const crashedWake = await crashing.runtime.wake('scheduled');
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
    await crashing.runtime.wake('startup');
    await crashing.runtime.wake('scheduled');
    await crashing.runtime.wake('scheduled');
    const crashedWake = await crashing.runtime.wake('scheduled');
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
    await fixture.runtime.wake('startup');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('scheduled');
    const wake = await fixture.runtime.wake('scheduled');
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
    await wakeUntilState(
      env.root,
      () => catchUp.runtime.wake('scheduled'),
      current => current.catchUpResources[THREAD_ID]?.status === 'complete',
    );
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
    discoveryQuotas?: Partial<DiscoveryWakeQuotas>;
    externalSourceBudget?: SourceWorkBudget;
    sessionLogSources?: readonly SessionLogSourceAdapter[];
  }): { runtime: RuntimeLearning; episodeStore: LearningEpisodeStore };
  restore(): void;
}

function setupEnv(options: {
  historyMode?: 'future-only' | 'catch-up' | null;
  catchUpCatalogInitialLimit?: number;
  catchUpCatalogMaxResources?: number;
  catchUpCatalogMaxOutputBytes?: number;
  catchUpCatalogMaxDurationMs?: number;
} = {}): TestEnv {
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
    'XIAOBA_EXTERNAL_SESSION_LOG_XURL_CATCH_UP_INITIAL_LIMIT',
    'XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_CATALOG',
    'XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_OUTPUT_BYTES',
    'XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_DURATION_MS',
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
  if (options.catchUpCatalogInitialLimit !== undefined) {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_CATCH_UP_INITIAL_LIMIT = String(options.catchUpCatalogInitialLimit);
  }
  if (options.catchUpCatalogMaxResources !== undefined) {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_CATALOG = String(options.catchUpCatalogMaxResources);
  }
  if (options.catchUpCatalogMaxOutputBytes !== undefined) {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_OUTPUT_BYTES = String(options.catchUpCatalogMaxOutputBytes);
  }
  if (options.catchUpCatalogMaxDurationMs !== undefined) {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_DURATION_MS = String(options.catchUpCatalogMaxDurationMs);
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
          discoveryQuotas: options.discoveryQuotas,
          externalSourceBudget: options.externalSourceBudget,
          sessionLogSources: options.sessionLogSources,
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

async function wakeUntilState<T>(
  root: string,
  wake: () => Promise<T>,
  predicate: (state: ReturnType<typeof loadExternalCursorState>) => boolean,
  maxWakes = 24,
): Promise<T | null> {
  let result: T | null = null;
  for (let attempt = 0; attempt < maxWakes; attempt++) {
    if (predicate(loadExternalCursorState(cursorStorePath(root)))) return result;
    result = await wake();
  }
  if (predicate(loadExternalCursorState(cursorStorePath(root)))) return result;
  throw new Error(`catch-up state did not converge after ${maxWakes} wakes`);
}

async function waitForInvocationCount(
  logPath: string,
  action: string,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (readInvocationLog(logPath).filter(invocation => invocation.action === action).length >= expectedCount) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${expectedCount} ${action} invocations`);
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

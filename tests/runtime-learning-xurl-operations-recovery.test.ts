/**
 * Issue #90 — Harden official xURL rendered-Timeline External Source Work Lane
 * operations & recovery.
 *
 * Deterministic public-seam tests for:
 *   - Provider-scoped lock contention and provider isolation
 *   - Durable failure classes (permission, protocol, quarantine, transient)
 *   - Quarantine retry / skip recovery
 *   - Resource closure and reversible disablement
 *   - Graceful drain and diagnostics
 *   - Internal independence and discovery finalization
 *   - External failures never increment Operational Review Retry counters
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
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import {
  buildExternalEventDedupKey,
  loadExternalCursorState,
  saveExternalCursorState,
} from '../src/utils/session-log-source';
import { acquireExternalSourceProviderLock } from '../src/utils/external-source-provider-lock';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
  XURL_TEST_HELPERS,
  XurlExternalBackfillSource,
} from '../src/utils/xurl-session-log-source';
import {
  CatalogPageSpec,
  FakeXurlScenario,
  ThreadSummarySpec,
  TimelineSpec,
  readInvocationLog,
  writeFakeXurl,
  writeScenario,
} from './helpers/xurl-rendered-fixtures';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface TestEnv {
  readonly root: string;
  readonly scenarioPath: string;
  readonly logPath: string;
  readonly commandPath: string;
  readonly internalLogPath: string;
  createRuntime(): { runtime: RuntimeLearning; episodeStore: LearningEpisodeStore };
  restore(): void;
}

const FP = (s: string) => `fp-${s}`;

function setupEnv(options: { provider: string; sourceId: string }): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-ops-recovery-'));
  tempRoots.push(root);
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'registry.json');
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
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID,
    XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND: process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND,
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
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER = options.provider;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID = options.sourceId;
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = commandPath;

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
          body: 'Promote a deterministic xurl ops skill.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'xurl-ops-delivery',
            description: 'Deliver work learned from bounded xurl ops events.',
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
            rationale: 'deterministic acceptance for ops recovery tests',
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

function cursorStorePath(root: string, provider: string, sourceId: string): string {
  return path.join(root, 'data', provider, `${sourceId}.json`);
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

function catalogPage(provider: string, threads: ThreadSummarySpec[], next?: string): CatalogPageSpec {
  return { provider, next: next ?? null, threads };
}

function timeline(
  provider: string,
  threadId: string,
  branch: string,
  ordinal: number,
  fingerprint: string,
  entries: { ordinal: number; role: 'User' | 'Assistant' | 'Context Compacted'; content: string }[],
  revision?: string,
): TimelineSpec {
  return {
    provider,
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

function baselineScenario(provider: string, threadId: string, branch = 'branch-main', ordinal = 0): FakeXurlScenario {
  return {
    discover: {
      pages: {
        start: catalogPage(provider, [thread(threadId, branch, ordinal, FP(`${threadId}-${ordinal}`), `rev-${threadId}-${ordinal}`)]),
      },
    },
    read: {},
  };
}

function stableScenario(
  provider: string,
  threadId: string,
  branch: string,
  userText: string,
  assistantText: string,
  options: { ordinal?: number; fingerprint?: string; revision?: string; head?: { ordinal: number; fingerprint: string } } = {},
): FakeXurlScenario {
  const ordinal = options.ordinal ?? 2;
  const fingerprint = options.fingerprint ?? FP(`${threadId}-${ordinal}`);
  const revision = options.revision ?? `rev-${threadId}-${ordinal}`;
  return {
    discover: {
      pages: {
        start: catalogPage(provider, [thread(threadId, branch, ordinal, fingerprint, revision)]),
      },
    },
    read: {
      [threadId]: readSpec(
        timeline(provider, threadId, branch, ordinal, fingerprint, [
          entry(1, 'User', userText),
          entry(2, 'Assistant', assistantText),
        ], revision),
        options.head,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('lock contention: a continuous wake reports a provider lock held by another operation', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();

    const lockRoot = path.join(env.root, 'data');
    const competingLock = acquireExternalSourceProviderLock({
      runtimeRoot: lockRoot,
      provider: 'codex',
      operation: 'competing-process',
      sourceId: 'external-codex',
    });
    assert.ok(competingLock.acquired);

    const result = await fixture.runtime.wake('startup');
    const report = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report);
    assert.equal(report!.status, 'locked');
    assert.equal(report!.drainState, 'idle');
    assert.ok(result.discovery.sources.find(s => s.sourceId === 'internal-xiaoba'));

    competingLock.release();

    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.notEqual(report2!.status, 'locked');
  } finally {
    env.restore();
  }
});

test('lock contention: different providers remain isolated and sanitized identities do not collide', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage('codex', []) } },
      read: {},
    } satisfies FakeXurlScenario);

    const lockRoot = path.join(env.root, 'data');
    const otherLock = acquireExternalSourceProviderLock({
      runtimeRoot: lockRoot,
      provider: 'claude',
      operation: 'other-provider',
    });
    assert.ok(otherLock.acquired);

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');
    const report = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report);
    assert.notEqual(report!.status, 'locked');
    otherLock.release();

    const first = acquireExternalSourceProviderLock({
      runtimeRoot: lockRoot,
      provider: 'codex/team',
      operation: 'first-provider',
    });
    const second = acquireExternalSourceProviderLock({
      runtimeRoot: lockRoot,
      provider: 'codex-team',
      operation: 'second-provider',
    });
    try {
      assert.ok(first.acquired);
      assert.ok(second.acquired, 'different provider identities own different lock paths');
    } finally {
      if (second.acquired) second.release();
      if (first.acquired) first.release();
    }
  } finally {
    env.restore();
  }
});

test('failure classification: permission failure records class and suspends with backoff', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage('codex', [thread('conversation-main', 'branch-main', 0, FP('main-0'), 'rev-main-0')]) } },
      read: {
        'conversation-main': {
          exitCode: 1,
          stderr: 'Error: permission denied Bearer secret-token api_key=abc123 C:\\Users\\alice\\secret /Users/alice/secret',
        },
      },
    } satisfies FakeXurlScenario);
    await fixture.runtime.wake('scheduled');

    const state = fixture.runtime.getExternalSourceFailureState().get('external-codex');
    assert.ok(state);
    assert.equal(state!.failureClass, 'permission');
    assert.ok(state!.suspendedUntil);
    assert.ok(state!.nextRetryAt);
    assert.ok(state!.lastError);
    assert.equal(state!.lastError.includes('permission'), true);
    assert.doesNotMatch(state!.lastError!, /secret-token|abc123|alice/i);

    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.equal(report2!.status, 'backoff');
  } finally {
    env.restore();
  }
});

test('failure classification: malformed rendered timeline requires operator action and explicit retry', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage('codex', [thread('conversation-main', 'branch-main', 0, FP('main-0'), 'rev-main-0')]) } },
      read: {
        'conversation-main': {
          rawStdout: '# markdown fallback is forbidden\n',
        },
      },
    } satisfies FakeXurlScenario);
    await fixture.runtime.wake('scheduled');

    const state = fixture.runtime.getExternalSourceFailureState().get('external-codex');
    assert.ok(state);
    assert.equal(state!.failureClass, 'protocol');
    assert.ok(state!.requiresOperatorAction);
    assert.equal(state!.suspendedUntil, null);

    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.equal(report2!.status, 'backoff');
    assert.equal(report2!.failureClass, 'protocol');
    assert.equal(report2!.requiresOperatorAction, true);
    assert.equal(report2!.nextAction, 'repair_source_then_retry');

    writeScenario(env.scenarioPath, stableScenario('codex', 'conversation-main', 'branch-main', 'Retry task', 'Retry done.'));
    assert.equal(fixture.runtime.retryExternalSourceFailure('codex', 'external-codex'), true);
    const result3 = await fixture.runtime.wake('scheduled');
    const report3 = result3.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report3);
    assert.notEqual(report3!.status, 'backoff');
  } finally {
    env.restore();
  }
});

test('lock contention never overwrites a durable operator-action failure gate', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));

    const owner = env.createRuntime();
    await owner.runtime.wake('startup');
    const follower = env.createRuntime();

    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage('codex', [thread('conversation-main', 'branch-main', 0, FP('main-0'), 'rev-main-0')]) } },
      read: {
        'conversation-main': {
          exitCode: 1,
          stderr: 'Error: protocol version mismatch unsupported schema',
        },
      },
    } satisfies FakeXurlScenario);
    await owner.runtime.wake('scheduled');
    assert.equal(owner.runtime.getExternalSourceFailureState().get('external-codex')?.requiresOperatorAction, true);

    const lock = acquireExternalSourceProviderLock({
      runtimeRoot: path.join(env.root, 'data'),
      provider: 'codex',
      operation: 'owner-in-progress',
      sourceId: 'external-codex',
    });
    assert.ok(lock.acquired);
    try {
      const result = await follower.runtime.wake('scheduled');
      assert.equal(
        result.discovery.sources.find(source => source.sourceId === 'external-codex')?.status,
        'locked',
      );
    } finally {
      lock.release();
    }

    const restarted = env.createRuntime();
    const recovered = restarted.runtime.getExternalSourceFailureState().get('external-codex');
    assert.equal(recovered?.failureClass, 'protocol');
    assert.equal(recovered?.requiresOperatorAction, true);
  } finally {
    env.restore();
  }
});

test('source failure without a stable event identity never creates an event quarantine', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage('codex', [thread('conversation-main', 'branch-main', 0, FP('main-0'), 'rev-main-0')]) } },
      read: {
        'conversation-main': {
          exitCode: 1,
          stderr: 'Error: oversized event exceeds external evidence limit — quarantine required',
        },
      },
    } satisfies FakeXurlScenario);
    await fixture.runtime.wake('scheduled');

    assert.deepEqual(
      fixture.runtime.listExternalSourceQuarantines('codex', 'external-codex'),
      [],
      'command-level failure cannot name an event quarantine',
    );
    const sourceFailure = fixture.runtime.getExternalSourceFailureState().get('external-codex');
    assert.equal(sourceFailure?.requiresOperatorAction, true);
    assert.equal(sourceFailure?.eventId, undefined);

    assert.equal(
      fixture.runtime.retryExternalSourceFailure('codex', 'external-codex'),
      true,
      'operator can retry the source after repairing the command/provider',
    );

    writeScenario(env.scenarioPath, stableScenario('codex', 'conversation-main', 'branch-main', 'Retry task', 'Retry done.'));
    const retryWake = await fixture.runtime.wake('scheduled');
    const retryReport = retryWake.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(retryReport);
    assert.notEqual(retryReport!.status, 'backoff', 'source retry clears the durable operator-action gate');
    assert.equal(retryReport!.unitsProcessed, 1, 'the repaired source event is processed');
  } finally {
    env.restore();
  }
});

test('resource quarantine leaves another resource on the same provider operational', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const quarantinedRef = 'conversation-quarantined';
    const healthyRef = 'conversation-healthy';
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(quarantinedRef, 'branch-main', 0, FP('quarantined-0'), 'rev-quarantined-0'),
            thread(healthyRef, 'branch-main', 0, FP('healthy-0'), 'rev-healthy-0'),
          ]),
        },
      },
      read: {},
    } satisfies FakeXurlScenario);
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    const baseline = loadExternalCursorState(storePath);
    const sourceIdentity = baseline.sourceIdentities['external-codex']!;
    const eventIdentity = {
      eventId: `agents://codex/${quarantinedRef}#1-2`,
      position: 2,
      conversationId: quarantinedRef,
      branchId: 'branch-main',
      revision: 'rev-quarantined-2',
      contentHash: 'quarantined-content-hash',
    };
    const quarantineId = buildExternalEventDedupKey(sourceIdentity, eventIdentity);
    saveExternalCursorState(storePath, {
      ...baseline,
      quarantinedEvents: {
        ...baseline.quarantinedEvents,
        [quarantineId]: {
          quarantineId,
          resourceRef: quarantinedRef,
          sourceIdentity,
          identity: eventIdentity,
          failureClass: 'quarantine',
          message: 'stable event exceeds the bounded evidence limit',
          detectedAt: new Date().toISOString(),
          cursorPosition: 0,
        },
      },
      updatedAt: new Date().toISOString(),
    });

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(quarantinedRef, 'branch-main', 2, FP('quarantined-2'), 'rev-quarantined-2'),
            thread(healthyRef, 'branch-main', 2, FP('healthy-2'), 'rev-healthy-2'),
          ]),
        },
      },
      read: {
        [quarantinedRef]: readSpec(timeline(
          'codex',
          quarantinedRef,
          'branch-main',
          2,
          FP('quarantined-2'),
          [
            entry(1, 'User', 'This event remains quarantined.'),
            entry(2, 'Assistant', 'This event must not be admitted.'),
          ],
          'rev-quarantined-2',
        )),
        [healthyRef]: readSpec(timeline(
          'codex',
          healthyRef,
          'branch-main',
          2,
          FP('healthy-2'),
          [
            entry(1, 'User', 'Deliver the healthy provider-local task.'),
            entry(2, 'Assistant', 'The healthy provider-local task is delivered and verified.'),
          ],
          'rev-healthy-2',
        )),
      },
    } satisfies FakeXurlScenario);

    const wake = await fixture.runtime.wake('scheduled');
    const report = wake.discovery.sources.find(source => source.sourceId === 'external-codex');
    assert.ok(report);
    assert.notEqual(report.status, 'backoff');
    assert.equal(report.unitsProcessed, 1);
    const after = loadExternalCursorState(storePath);
    assert.equal(after.cursors[quarantinedRef]?.cursor.position, 0);
    assert.equal(after.cursors[healthyRef]?.cursor.position, 2);
    assert.ok(after.quarantinedEvents[quarantineId]);
  } finally {
    env.restore();
  }
});

test('transient backoff stays resource-local while healthy resources and Internal continue', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const failingRef = 'conversation-failing-a';
    const secondFailingRef = 'conversation-failing-b';
    const healthyRef = 'conversation-healthy';
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(failingRef, 'branch-main', 0, FP('failing-0'), 'rev-failing-0'),
            thread(secondFailingRef, 'branch-main', 0, FP('failing-b-0'), 'rev-failing-b-0'),
            thread(healthyRef, 'branch-main', 0, FP('healthy-0'), 'rev-healthy-0'),
          ]),
        },
      },
      read: {},
    } satisfies FakeXurlScenario);
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Deliver the Internal isolation result.', 'Internal result delivered.'),
    ]);
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(failingRef, 'branch-main', 2, FP('failing-2'), 'rev-failing-2'),
            thread(secondFailingRef, 'branch-main', 2, FP('failing-b-2'), 'rev-failing-b-2'),
            thread(healthyRef, 'branch-main', 2, FP('healthy-2'), 'rev-healthy-2'),
          ]),
        },
      },
      read: {
        [failingRef]: {
          exitCode: 1,
          stderr: 'Error: transient network timeout',
        },
        [secondFailingRef]: {
          exitCode: 1,
          stderr: 'Error: transient upstream timeout',
        },
        [healthyRef]: readSpec(timeline(
          'codex',
          healthyRef,
          'branch-main',
          2,
          FP('healthy-2'),
          [
            entry(1, 'User', 'Deliver the healthy resource while its sibling waits.'),
            entry(2, 'Assistant', 'The healthy resource is delivered and verified.'),
          ],
          'rev-healthy-2',
        )),
      },
    } satisfies FakeXurlScenario);

    const first = await fixture.runtime.wake('scheduled');
    const external = first.discovery.sources.find(source => source.sourceId === 'external-codex');
    const internal = first.discovery.sources.find(source => source.sourceId === 'internal-xiaoba');
    assert.ok(external);
    assert.ok(internal);
    assert.equal(external.unitsProcessed, 1);
    assert.equal(internal.unitsProcessed, 1);
    assert.equal(
      loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'))
        .cursors[healthyRef]?.cursor.position,
      2,
    );
    const failure = fixture.runtime.getExternalSourceFailureState().get('external-codex');
    assert.equal(failure?.failureClass, 'transient');
    assert.ok(
      failure?.resourceRef === failingRef || failure?.resourceRef === secondFailingRef,
    );
    assert.ok(failure?.nextRetryAt);
    assert.deepEqual(
      [...fixture.runtime.getExternalResourceFailureState('codex', 'external-codex').keys()].sort(),
      [failingRef, secondFailingRef],
    );

    const failedReadCountsBeforeRetry = new Map(
      [failingRef, secondFailingRef].map(resourceRef => [
        resourceRef,
        readInvocationLog(env.logPath)
          .filter(invocation => invocation.action === 'read' && invocation.args[0]?.includes(resourceRef))
          .length,
      ]),
    );
    const restarted = env.createRuntime();
    assert.deepEqual(
      [...restarted.runtime.getExternalResourceFailureState('codex', 'external-codex').keys()].sort(),
      [failingRef, secondFailingRef],
      'every resource-local deadline survives restart independently',
    );
    const second = await restarted.runtime.wake('scheduled');
    assert.notEqual(
      second.discovery.sources.find(source => source.sourceId === 'external-codex')?.status,
      'backoff',
      'one resource backoff does not pause the provider lane',
    );
    for (const resourceRef of [failingRef, secondFailingRef]) {
      assert.equal(
        readInvocationLog(env.logPath)
          .filter(invocation => invocation.action === 'read' && invocation.args[0]?.includes(resourceRef))
          .length,
        failedReadCountsBeforeRetry.get(resourceRef),
        `affected resource ${resourceRef} is not retried before its durable deadline`,
      );
    }
  } finally {
    env.restore();
  }
});

test('protocol failure pauses the provider before later resources while Internal remains operational', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const blockedRef = 'conversation-a-protocol';
    const unreadRef = 'conversation-b-unread';
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(blockedRef, 'branch-main', 0, FP('protocol-0'), 'rev-protocol-0'),
            thread(unreadRef, 'branch-main', 0, FP('unread-0'), 'rev-unread-0'),
          ]),
        },
      },
      read: {},
    } satisfies FakeXurlScenario);
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Deliver Internal work during provider repair.', 'Internal work delivered.'),
    ]);
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(blockedRef, 'branch-main', 2, FP('protocol-2'), 'rev-protocol-2'),
            thread(unreadRef, 'branch-main', 2, FP('unread-2'), 'rev-unread-2'),
          ]),
        },
      },
      read: {
        [blockedRef]: {
          rawStdout: '# malformed rendered timeline\n',
        },
        [unreadRef]: readSpec(timeline(
          'codex',
          unreadRef,
          'branch-main',
          2,
          FP('unread-2'),
          [
            entry(1, 'User', 'This event must wait for provider repair.'),
            entry(2, 'Assistant', 'This event must not be admitted in the blocked wake.'),
          ],
          'rev-unread-2',
        )),
      },
    } satisfies FakeXurlScenario);

    const wake = await fixture.runtime.wake('scheduled');
    const external = wake.discovery.sources.find(source => source.sourceId === 'external-codex');
    const internal = wake.discovery.sources.find(source => source.sourceId === 'internal-xiaoba');
    assert.ok(external);
    assert.ok(internal);
    assert.equal(external.unitsProcessed, 0);
    assert.equal(external.failureClass, 'protocol');
    assert.equal(external.requiresOperatorAction, true);
    assert.equal(internal.unitsProcessed, 1);
    assert.equal(
      loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'))
        .cursors[unreadRef]?.cursor.position,
      0,
      'provider-level protocol pause prevents later resource admission',
    );
    assert.equal(
      readInvocationLog(env.logPath)
        .filter(invocation => invocation.action === 'read' && invocation.args[0]?.includes(unreadRef))
        .length,
      0,
    );

    const blockedWake = await fixture.runtime.wake('scheduled');
    assert.equal(
      blockedWake.discovery.sources.find(source => source.sourceId === 'external-codex')?.status,
      'backoff',
    );
  } finally {
    env.restore();
  }
});

test('protocol repair gate follows the provider across restarted source identities', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex-a' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-provider-gate'));
    const firstSource = env.createRuntime();
    await firstSource.runtime.wake('startup');

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(
              'conversation-provider-gate',
              'branch-main',
              2,
              FP('provider-gate-2'),
              'rev-provider-gate-2',
            ),
          ]),
        },
      },
      read: {
        'conversation-provider-gate': {
          rawStdout: '# malformed rendered timeline\n',
        },
      },
    } satisfies FakeXurlScenario);
    await firstSource.runtime.wake('scheduled');
    assert.equal(
      firstSource.runtime.getExternalSourceFailure('codex', 'external-codex-a')?.failureClass,
      'protocol',
    );

    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID = 'external-codex-b';
    writeScenario(
      env.scenarioPath,
      stableScenario(
        'codex',
        'conversation-provider-gate',
        'branch-main',
        'Repair the provider protocol before reading through another source identity.',
        'The repaired provider protocol is verified.',
      ),
    );
    const restarted = env.createRuntime();
    const readsBeforeBlockedWake = readInvocationLog(env.logPath)
      .filter(invocation => invocation.action === 'read').length;

    const blocked = await restarted.runtime.wake('scheduled');
    const blockedReport = blocked.discovery.sources.find(
      source => source.sourceId === 'external-codex-b',
    );
    assert.equal(blockedReport?.status, 'backoff');
    assert.equal(blockedReport?.failureClass, 'protocol');
    assert.equal(
      readInvocationLog(env.logPath).filter(invocation => invocation.action === 'read').length,
      readsBeforeBlockedWake,
      'a new source identity cannot bypass its provider repair gate',
    );
    await assert.rejects(
      restarted.runtime.runExternalBackfill({
        operationId: 'issue-101-provider-gated-backfill',
        triggeredBy: 'operator:test',
        provider: 'codex',
        sourceId: 'external-codex-b',
        range: {
          startPosition: 1,
          endPosition: 2,
          resourceRefs: ['conversation-provider-gate'],
        },
        limits: {
          maxResources: 1,
          maxBytes: 1024 * 1024,
          maxElapsedMs: 60_000,
        },
      }, new XurlExternalBackfillSource({
        command: env.commandPath,
        provider: 'codex',
        sourceId: 'external-codex-b',
      })),
      /provider codex is paused pending explicit protocol or integrity repair/,
    );

    assert.equal(
      restarted.runtime.retryExternalSourceFailure('codex', 'external-codex-a'),
      true,
    );
    const repaired = await restarted.runtime.wake('scheduled');
    assert.notEqual(
      repaired.discovery.sources.find(source => source.sourceId === 'external-codex-b')?.status,
      'backoff',
    );

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread(
              'conversation-provider-gate',
              'branch-main',
              4,
              FP('provider-gate-4'),
              'rev-provider-gate-4',
            ),
          ]),
        },
      },
      read: {
        'conversation-provider-gate': readSpec(timeline(
          'codex',
          'conversation-provider-gate',
          'branch-main',
          4,
          FP('provider-gate-4'),
          [
            entry(1, 'User', 'Repair the provider protocol before reading another source.'),
            entry(2, 'Assistant', 'The provider protocol repair is verified.'),
            entry(3, 'User', 'Resume provider reads after the explicit repair.'),
            entry(4, 'Assistant', 'Provider reads resumed successfully.'),
          ],
          'rev-provider-gate-4',
        )),
      },
    } satisfies FakeXurlScenario);
    const progressed = await restarted.runtime.wake('scheduled');
    assert.notEqual(
      progressed.discovery.sources.find(source => source.sourceId === 'external-codex-b')?.status,
      'backoff',
    );
    assert.ok(
      readInvocationLog(env.logPath).filter(invocation => invocation.action === 'read').length
        > readsBeforeBlockedWake,
    );
  } finally {
    env.restore();
  }
});

test('quarantine recovery: skip writes a durable tombstone before allowing the cursor to cross', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const stateBeforeSkip = loadExternalCursorState(storePath);
    const sourceIdentity = stateBeforeSkip.sourceIdentities['external-codex']!;
    const quarantineId = 'external-codex::codex::agents://codex/conversation-main#1-2::2::conversation-main::branch-main';
    saveExternalCursorState(storePath, {
      ...stateBeforeSkip,
      quarantinedEvents: {
        ...stateBeforeSkip.quarantinedEvents,
        [quarantineId]: {
          quarantineId,
          resourceRef: 'conversation-main',
          sourceIdentity,
          identity: {
            eventId: 'agents://codex/conversation-main#1-2',
            position: 2,
            conversationId: 'conversation-main',
            branchId: 'branch-main',
            revision: 'rev-main-2',
            contentHash: 'seeded-skip-hash',
          },
          failureClass: 'integrity_conflict',
          message: 'seeded integrity conflict for skip recovery',
          detectedAt: new Date().toISOString(),
          cursorPosition: 0,
        },
      },
      updatedAt: new Date().toISOString(),
    });

    const quarantines = fixture.runtime.listExternalSourceQuarantines('codex', 'external-codex');
    assert.equal(quarantines[0]?.quarantineId, quarantineId);

    const skipped = fixture.runtime.skipExternalSourceQuarantine(
      'codex',
      'external-codex',
      quarantineId,
      'operator skip — upstream event is corrupt',
    );
    assert.equal(skipped, true);

    const state = loadExternalCursorState(storePath);
    assert.ok(!state.quarantinedEvents[quarantineId]);
    const tombstone = Object.values(state.tombstones).find(entry => entry.tombstoneId === quarantineId);
    assert.ok(tombstone, 'durable tombstone written');
    assert.equal(tombstone!.kind, 'event-skip');
    assert.equal(
      tombstone!.kind === 'event-skip' ? tombstone!.identity.eventId : undefined,
      'agents://codex/conversation-main#1-2',
    );
    assert.ok(tombstone!.reason.includes('operator skip'), 'tombstone carries redacted reason');
    assert.deepEqual(
      fixture.runtime.listExternalSourceRecoveryAudit('codex', 'external-codex')
        .map(entry => entry.action),
      ['event-skip'],
    );
    const restarted = env.createRuntime();
    assert.equal(
      restarted.runtime.listExternalSourceTombstones('codex', 'external-codex')[0]?.tombstoneId,
      quarantineId,
    );

    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage('codex', [thread('conversation-main', 'branch-main', 2, FP('mutated-2'), 'mutated-rev')]) } },
      read: {
        'conversation-main': readSpec(
          timeline('codex', 'conversation-main', 'branch-main', 2, FP('mutated-2'), [
            entry(1, 'User', 'Skipped task'),
            entry(2, 'Assistant', 'Skipped result.'),
          ], 'mutated-rev'),
        ),
      },
    } satisfies FakeXurlScenario);
    const skipWake = await restarted.runtime.wake('scheduled');
    const skipReport = skipWake.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(skipReport);
    assert.notEqual(skipReport!.status, 'backoff', 'skip clears the durable operator-action gate');
    assert.equal(skipReport!.unitsProcessed, 0, 'skipped identity never becomes learning evidence');
    assert.equal(loadExternalCursorState(storePath).cursors['conversation-main']?.cursor.position, 2);

    const episodeIds = Object.keys(restarted.episodeStore.load().episodes);
    const capsuleCount = restarted.runtime.getEvidenceCapsuleStore().count();
    const ordinary = await restarted.runtime.runExternalBackfill({
      operationId: 'issue-101-exact-skip-backfill',
      triggeredBy: 'operator:test',
      provider: 'codex',
      sourceId: 'external-codex',
      range: {
        startPosition: 2,
        endPosition: 2,
        resourceRefs: ['conversation-main'],
      },
      limits: {
        maxResources: 1,
        maxBytes: 1024 * 1024,
        maxElapsedMs: 60_000,
      },
    }, new XurlExternalBackfillSource({
      command: env.commandPath,
      provider: 'codex',
      sourceId: 'external-codex',
    }));
    assert.equal(ordinary.backfill.status, 'completed');
    assert.equal(ordinary.backfill.tombstonedEventsSkipped, 1);
    assert.deepEqual(Object.keys(restarted.episodeStore.load().episodes), episodeIds);
    assert.equal(restarted.runtime.getEvidenceCapsuleStore().count(), capsuleCount);
  } finally {
    env.restore();
  }
});

test('quarantine recovery: explicit retry reprocesses the same event before advancing its cursor', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const userText = 'Deliver the quarantined task.';
    const assistantText = 'Quarantined task delivered.';
    const eventIdentity = {
      eventId: 'agents://codex/conversation-main#1-2',
      position: 2,
      conversationId: 'conversation-main',
      branchId: 'branch-main',
      revision: 'rev-retry-2',
      contentHash: XURL_TEST_HELPERS.computeContentHash([
        { role: 'User', content: userText },
        { role: 'Assistant', content: assistantText },
      ]),
    };
    const stateBeforeQuarantine = loadExternalCursorState(storePath);
    const sourceIdentity = stateBeforeQuarantine.sourceIdentities['external-codex']!;
    const quarantineId = buildExternalEventDedupKey(sourceIdentity, eventIdentity);
    assert.equal(stateBeforeQuarantine.cursors['conversation-main']?.cursor.position, 0);

    saveExternalCursorState(storePath, {
      ...stateBeforeQuarantine,
      quarantinedEvents: {
        ...stateBeforeQuarantine.quarantinedEvents,
        [quarantineId]: {
          quarantineId,
          resourceRef: 'conversation-main',
          sourceIdentity,
          identity: eventIdentity,
          failureClass: 'quarantine',
          message: 'seeded stable event quarantine for explicit retry',
          detectedAt: new Date().toISOString(),
          cursorPosition: 0,
        },
      },
      updatedAt: new Date().toISOString(),
    });
    writeScenario(env.scenarioPath, stableScenario(
      'codex',
      'conversation-main',
      'branch-main',
      userText,
      assistantText,
      { fingerprint: FP('retry-2'), revision: eventIdentity.revision },
    ));

    const restarted = env.createRuntime();
    assert.equal(
      restarted.runtime.listExternalSourceQuarantines('codex', 'external-codex')[0]?.quarantineId,
      quarantineId,
      'the stable event quarantine survives a runtime restart',
    );

    const blockedWake = await restarted.runtime.wake('scheduled');
    const blockedReport = blockedWake.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(blockedReport);
    assert.equal(blockedReport!.unitsProcessed, 0, 'the quarantined event is not admitted');
    const blockedState = loadExternalCursorState(storePath);
    assert.equal(blockedState.cursors['conversation-main']?.cursor.position, 0, 'cursor cannot cross quarantine');
    assert.ok(blockedState.quarantinedEvents[quarantineId], 'quarantine remains durable after an ordinary wake');
    assert.equal(blockedState.processedEventIds[quarantineId], undefined);
    assert.equal(Object.keys(blockedState.tombstones).length, 0);

    assert.equal(
      restarted.runtime.retryExternalSourceQuarantine('codex', 'external-codex', quarantineId),
      true,
    );
    const retryReadyState = loadExternalCursorState(storePath);
    assert.equal(retryReadyState.quarantinedEvents[quarantineId], undefined);
    assert.equal(retryReadyState.cursors['conversation-main']?.cursor.position, 0, 'retry alone does not advance the cursor');
    assert.equal(Object.keys(retryReadyState.tombstones).length, 0, 'retry does not convert the event into a tombstone');
    assert.deepEqual(
      restarted.runtime.listExternalSourceRecoveryAudit('codex', 'external-codex')
        .map(entry => entry.action),
      ['quarantine-retry'],
    );

    saveExternalCursorState(storePath, {
      ...retryReadyState,
      quarantinedEvents: {
        [quarantineId]: {
          quarantineId,
          resourceRef: 'conversation-main',
          sourceIdentity,
          identity: eventIdentity,
          failureClass: 'quarantine',
          message: 'same stable event entered quarantine again before admission',
          detectedAt: new Date().toISOString(),
          cursorPosition: 0,
        },
      },
      updatedAt: new Date().toISOString(),
    });
    assert.equal(
      restarted.runtime.retryExternalSourceQuarantine('codex', 'external-codex', quarantineId),
      true,
    );
    assert.deepEqual(
      restarted.runtime.listExternalSourceRecoveryAudit('codex', 'external-codex')
        .map(entry => entry.action),
      ['quarantine-retry', 'quarantine-retry'],
      'each deliberate retry remains independently auditable',
    );

    const retryWake = await restarted.runtime.wake('scheduled');
    const retryReport = retryWake.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(retryReport);
    assert.equal(retryReport!.unitsProcessed, 1, 'the same quarantined event is reprocessed through admission');

    const admittedState = loadExternalCursorState(storePath);
    assert.equal(admittedState.processedEventIds[quarantineId], eventIdentity.contentHash);
    assert.equal(admittedState.cursors['conversation-main']?.cursor.position, 2, 'cursor advances after successful admission');
    assert.equal(admittedState.cursors['conversation-main']?.cursor.processedCount, 1);
    assert.equal(Object.keys(admittedState.tombstones).length, 0, 'successful retry leaves no tombstone');
    assert.equal(admittedState.quarantinedEvents[quarantineId], undefined);
  } finally {
    env.restore();
  }
});

test('restart heals a stale scheduling gate after quarantine retry commits only to cursor recovery', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  const dataRoot = path.join(env.root, 'data');
  let dataRootMode: number | undefined;
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const before = loadExternalCursorState(storePath);
    const sourceIdentity = before.sourceIdentities['external-codex']!;
    const eventIdentity = {
      eventId: 'agents://codex/conversation-main#1-2',
      position: 2,
      conversationId: 'conversation-main',
      branchId: 'branch-main',
      revision: 'rev-retry-crash-window',
      contentHash: 'retry-crash-window-hash',
    };
    const quarantineId = buildExternalEventDedupKey(sourceIdentity, eventIdentity);
    const detectedAt = '2026-07-16T01:00:00.000Z';
    saveExternalCursorState(storePath, {
      ...before,
      quarantinedEvents: {
        [quarantineId]: {
          quarantineId,
          resourceRef: 'conversation-main',
          sourceIdentity,
          identity: eventIdentity,
          failureClass: 'quarantine',
          message: 'seeded retry crash window',
          detectedAt,
          cursorPosition: 0,
        },
      },
      updatedAt: detectedAt,
    });

    const staleFailure = {
      consecutiveFailures: 1,
      lastFailedAt: detectedAt,
      lastError: 'seeded retry crash window',
      suspendedUntil: null,
      failureClass: 'quarantine' as const,
      nextRetryAt: null,
      requiresOperatorAction: true,
      resourceRef: 'conversation-main',
      eventId: eventIdentity.eventId,
      lastAttemptedAt: detectedAt,
      lastSuccessfulReadAt: null,
    };
    fs.writeFileSync(
      path.join(dataRoot, 'external-source-scheduling-state.json'),
      JSON.stringify({
        schemaVersion: 3,
        lanes: [{ provider: 'codex', sourceId: 'external-codex', state: staleFailure }],
        resourceLanes: [{
          provider: 'codex',
          sourceId: 'external-codex',
          resourceRef: 'conversation-main',
          state: staleFailure,
        }],
      }),
      'utf8',
    );

    dataRootMode = fs.statSync(dataRoot).mode & 0o777;
    fs.chmodSync(dataRoot, 0o500);
    assert.equal(
      fixture.runtime.retryExternalSourceQuarantine('codex', 'external-codex', quarantineId),
      true,
    );
    fs.chmodSync(dataRoot, dataRootMode);
    dataRootMode = undefined;
    assert.equal(loadExternalCursorState(storePath).quarantinedEvents[quarantineId], undefined);

    const restarted = env.createRuntime();
    assert.equal(
      restarted.runtime.getExternalResourceFailureState('codex', 'external-codex').size,
      0,
      'cursor recovery clears the stale resource scheduling gate on restart',
    );
    assert.equal(
      restarted.runtime.getExternalSourceFailure('codex', 'external-codex')?.requiresOperatorAction,
      false,
      'cursor recovery clears the stale source scheduling gate on restart',
    );
  } finally {
    if (dataRootMode !== undefined) fs.chmodSync(dataRoot, dataRootMode);
    env.restore();
  }
});

test('resource closure preserves cursor state and ordinary rediscovery cannot silently reopen it', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main', 'branch-main', 2));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const stateBefore = loadExternalCursorState(storePath);
    assert.ok(stateBefore.resources['conversation-main']);
    assert.notEqual(stateBefore.resources['conversation-main']?.lifecycleStatus, 'closed');

    const durableEvidencePaths = [
      path.join(env.root, 'data', 'evidence-capsules.json'),
      path.join(env.root, 'data', 'learning-episodes.json'),
      path.join(env.root, 'data', 'external-source-provenance.json'),
      path.join(env.root, 'data', 'registry.json'),
      path.join(env.root, 'data', 'transition-audit.jsonl'),
    ] as const;
    fixture.runtime.getEvidenceCapsuleStore().save({ schemaVersion: 1, capsules: {} });
    fixture.episodeStore.save({ schemaVersion: 3, episodes: {} });
    fs.writeFileSync(
      durableEvidencePaths[2],
      JSON.stringify({ schemaVersion: 1, episodeToEvent: {}, eventToEpisodes: {} }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      durableEvidencePaths[3],
      JSON.stringify(fixture.runtime.getSkillEvolution().getRegistry(), null, 2),
      'utf8',
    );
    fs.writeFileSync(
      durableEvidencePaths[4],
      `${JSON.stringify({ transitionId: 'unrelated-audit', status: 'preserved' })}\n`,
      'utf8',
    );
    const durableEvidenceBeforeClose = durableEvidencePaths.map(filePath => fs.readFileSync(filePath));

    assert.equal(fixture.runtime.deleteExternalSourceResource('codex', 'external-codex', 'conversation-main'), true);
    const stateAfter = loadExternalCursorState(storePath);
    assert.equal(stateAfter.resources['conversation-main']?.lifecycleStatus, 'closed');
    assert.ok(stateAfter.resources['conversation-main']?.closedAt);
    assert.ok(stateAfter.cursors['conversation-main']);
    durableEvidencePaths.forEach((filePath, index) => {
      assert.deepEqual(
        fs.readFileSync(filePath),
        durableEvidenceBeforeClose[index],
        `${path.basename(filePath)} remains byte-identical across resource close`,
      );
    });

    await fixture.runtime.wake('scheduled');
    const rediscoveredState = loadExternalCursorState(storePath);
    assert.equal(rediscoveredState.resources['conversation-main']?.lifecycleStatus, 'closed');
  } finally {
    env.restore();
  }
});

test('reversible disablement preserves durable state and re-enable resumes', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeScenario(env.scenarioPath, stableScenario('codex', 'conversation-main', 'branch-main', 'Step 1', 'Done 1.'));
    await fixture.runtime.wake('scheduled');
    const stateBefore = loadExternalCursorState(storePath);
    assert.ok(stateBefore.cursors['conversation-main']);

    assert.equal(fixture.runtime.disableExternalSource('codex', 'external-codex'), true);
    const disabledResult = await fixture.runtime.wake('scheduled');
    const disabledReport = disabledResult.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(disabledReport);
    assert.equal(disabledReport!.enabled, false);
    assert.ok(loadExternalCursorState(storePath).cursors['conversation-main']);

    assert.equal(fixture.runtime.enableExternalSource('codex', 'external-codex'), true);
    const enabledResult = await fixture.runtime.wake('scheduled');
    const enabledReport = enabledResult.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(enabledReport);
    assert.equal(enabledReport!.enabled, true);
  } finally {
    env.restore();
  }
});

test('graceful drain stops new external reads while internal review work still runs', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: catalogPage('codex', [
            thread('conversation-a', 'branch-a', 0, FP('a-0'), 'rev-a-0'),
            thread('conversation-b', 'branch-b', 0, FP('b-0'), 'rev-b-0'),
          ]),
        },
      },
      read: {},
    } satisfies FakeXurlScenario);

    const fixture = env.createRuntime();
    fixture.episodeStore.save({
      schemaVersion: 3,
      episodes: {
        'internal-drain-review': {
          schemaVersion: 3,
          episodeId: 'internal-drain-review',
          runtimeSessionId: 'internal-drain-review',
          sourceFilePath: 'internal-drain-review.jsonl',
          deliveryTurn: 1,
          completionEvidence: [{
            ref: 'internal-drain-review.jsonl#turn-1:delivery',
            sourceFilePath: 'internal-drain-review.jsonl',
            turn: 1,
            kind: 'artifact-delivery',
            detail: 'delivered the internal report',
          }],
          contradictionSignals: [],
          semanticObservations: [{
            kind: 'user-intent',
            value: 'Deliver the internal report.',
            sourceRefs: ['internal-drain-review.jsonl#turn-1:user-intent'],
          }],
          settlementDeadline: new Date(0).toISOString(),
          status: 'eligible',
        },
      },
    });

    fixture.runtime.requestExternalSourceDrain();
    const result = await fixture.runtime.wake('startup');
    const report = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report);
    assert.equal(report!.status, 'drained');
    assert.equal(report!.drainState, 'draining');
    assert.equal(report!.unitsProcessed, 0);
    assert.ok(result.review.reviewedEpisodes >= 1);

    const cursorEntries = Object.values(loadExternalCursorState(storePath).cursors)
      .filter(c => c.sourceIdentity?.sourceId === 'external-codex');
    assert.equal(cursorEntries.length, 0);

    fixture.runtime.resumeExternalSourceReads();
    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.notEqual(report2!.status, 'drained');
  } finally {
    env.restore();
  }
});

test('runtime diagnostics surface provider, reader, cursor progress, and drain state', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main', 'branch-main', 2));
    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');
    const report = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report);
    assert.equal(report!.provider, 'codex');
    assert.ok(report!.reader);
    assert.ok(report!.selectedProvider);
    assert.ok(report!.cursorProgress);
    assert.ok(typeof report!.cursorProgress!.maxPosition === 'number');
    assert.ok(typeof report!.cursorProgress!.activeResources === 'number');
    assert.equal(report!.drainState, 'idle');
    assert.ok(report!.supportStatus);
  } finally {
    env.restore();
  }
});

test('internal independence: missing xurl does not degrade internal heartbeat readiness', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = path.join(env.root, 'tmp', 'nonexistent-xurl.cjs');
    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Please deliver the internal result.', 'Done.'),
      turn(2, 'internal-session', 'Thanks.', 'You are welcome.'),
    ]);

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');

    const internalReport = result.discovery.sources.find(s => s.sourceId === 'internal-xiaoba');
    assert.ok(internalReport);
    assert.ok(internalReport!.unitsProcessed >= 1);

    const externalReport = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(externalReport);
    assert.notEqual(externalReport!.status, 'active');
  } finally {
    env.restore();
  }
});

test('discovery cycle finalization: missing resources remain resumable until explicitly closed', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-gone', 'branch-gone', 0));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const stateAfterFirst = loadExternalCursorState(storePath);
    assert.ok(stateAfterFirst.resources['conversation-gone']);
    assert.notEqual(stateAfterFirst.resources['conversation-gone']?.lifecycleStatus, 'closed');

    writeScenario(env.scenarioPath, { discover: { pages: { start: catalogPage('codex', []) } }, read: {} } satisfies FakeXurlScenario);
    await fixture.runtime.wake('scheduled');

    const stateAfterSecond = loadExternalCursorState(storePath);
    assert.notEqual(stateAfterSecond.resources['conversation-gone']?.lifecycleStatus, 'closed');

    await fixture.runtime.wake('scheduled');
    const stateAfterThird = loadExternalCursorState(storePath);
    assert.notEqual(
      stateAfterThird.resources['conversation-gone']?.lifecycleStatus,
      'closed',
      'resource remains resumable after repeated discovery absence',
    );
    assert.ok((stateAfterThird.resources['conversation-gone']?.missingDiscoveryCycles ?? 0) >= 1);
    assert.ok(stateAfterThird.resources['conversation-gone']?.missingSince);
    assert.ok(stateAfterThird.cursors['conversation-gone'], 'cursor preserved for missing resource');
  } finally {
    env.restore();
  }
});

test('external failures never increment Operational Review Retry counters', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeScenario(env.scenarioPath, {
      discover: { pages: { start: catalogPage('codex', [thread('conversation-main', 'branch-main', 0, FP('main-0'), 'rev-main-0')]) } },
      read: {
        'conversation-main': {
          exitCode: 1,
          stderr: 'Error: transient network timeout',
        },
      },
    } satisfies FakeXurlScenario);
    const result = await fixture.runtime.wake('scheduled');

    const externalReport = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(externalReport);
    assert.equal(externalReport!.status, 'failed');

    const state = fixture.runtime.getExternalSourceFailureState().get('external-codex');
    assert.ok(state);
    assert.equal(state!.failureClass, 'transient', 'classified as transient');
    assert.ok(state!.consecutiveFailures >= 1, 'failure count incremented');
    assert.ok(state!.suspendedUntil, 'transient failure suspends with backoff');
    assert.equal(result.review.operationalRetries, 0, 'external failure did not create an operational retry');
  } finally {
    env.restore();
  }
});

test('completed operations leave no in-memory source failure state', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, baselineScenario('codex', 'conversation-main'));
    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    writeScenario(env.scenarioPath, stableScenario('codex', 'conversation-main', 'branch-main', 'Step 1', 'Done 1.'));
    await fixture.runtime.wake('scheduled');

    fixture.runtime.listExternalSourceQuarantines('codex', 'external-codex');
    fixture.runtime.requestExternalSourceDrain();
    fixture.runtime.resumeExternalSourceReads();

    const failureState = fixture.runtime.getExternalSourceFailureState();
    assert.ok(failureState instanceof Map, 'failure state is a plain map');
    assert.equal(failureState.size, 0, 'no failure state from successful run');
  } finally {
    env.restore();
  }
});

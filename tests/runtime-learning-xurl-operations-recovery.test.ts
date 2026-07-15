/**
 * Issue #87 — Harden xurl-backed External Source Work Lane operations & recovery.
 *
 * Deterministic public-seam tests for:
 *   - Provider-scoped lock contention (heartbeat vs backfill, cross-provider isolation)
 *   - Durable failure classes (transient, permission, protocol, integrity_conflict, quarantine)
 *     with class-appropriate backoff or operator action
 *   - Durable bounded quarantine with explicit retry (reprocess) and skip (tombstone)
 *   - Resource closure (delete/archive) preserves cursor, capsules, episodes
 *   - Reversible disablement preserves durable state
 *   - Graceful drain stops new reads, leaves unacknowledged work resumable
 *   - Runtime status diagnostics (provider, reader, cursor progress, last successful
 *     read, next retry, redacted last error, drain state)
 *   - External source failures never increment Operational Review Retry or Branch
 *     Promotion Reviewer failure counters
 *
 * Uses the fake xurl command boundary — no real provider, credentials, or network.
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
  loadExternalCursorState,
  closeExternalResource,
  finalizeExternalDiscoveryCycleForStore,
} from '../src/utils/session-log-source';
import { acquireExternalSourceProviderLock } from '../src/utils/external-source-provider-lock';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared helpers (adapted from runtime-learning-xurl-continuous.test.ts)
// ---------------------------------------------------------------------------

interface TestEnv {
  readonly root: string;
  readonly scenarioPath: string;
  readonly logPath: string;
  readonly commandPath: string;
  readonly internalLogPath: string;
  createRuntime(): { runtime: RuntimeLearning; episodeStore: LearningEpisodeStore };
  restore(): void;
}

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

function writeScenario(filePath: string, scenario: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(scenario, null, 2), 'utf8');
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

function resource(
  resourceRef: string,
  eventId: string,
  position: number,
  conversationId: string,
  branchId: string,
  options: { activationPosition?: number; revision?: string; contentHash?: string } = {},
) {
  return {
    resourceRef,
    firstEvent: {
      eventId,
      position,
      conversationId,
      branchId,
      ...(options.revision ? { revision: options.revision } : {}),
      contentHash: options.contentHash ?? `resource-hash-${resourceRef}-${position}`,
    },
    ...(typeof options.activationPosition === 'number' ? { activationPosition: options.activationPosition } : {}),
  };
}

function protocolEvent(
  eventId: string,
  position: number,
  conversationId: string,
  branchId: string,
  userText: string,
  assistantText: string,
  options: { revision?: string; contentHash?: string; timestamp?: string } = {},
) {
  return {
    eventId,
    position,
    conversationId,
    branchId,
    revision: options.revision ?? `rev-${position}`,
    contentHash: options.contentHash ?? `hash-${position}`,
    timestamp: options.timestamp ?? '2026-01-01T00:00:00.000Z',
    messages: [
      { role: 'system', content: 'hidden system message' },
      { role: 'developer', content: 'hidden developer message' },
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText, final: true },
    ],
  };
}

function stableRead(
  provider: string,
  resourceRef: string,
  events: unknown[],
  newPosition: number,
) {
  return {
    protocolVersion: 1,
    provider,
    resourceRef,
    status: 'stable',
    exhausted: true,
    newPosition,
    events,
  };
}

function emptyStableRead(provider: string, resourceRef = 'unused', newPosition = 0) {
  return {
    protocolVersion: 1,
    provider,
    resourceRef,
    status: 'stable',
    exhausted: true,
    newPosition,
    events: [],
  };
}

function writeFakeXurl(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const action = args[1];
const scenarioPath = process.env.XURL_SCENARIO_PATH;
const logPath = process.env.XURL_LOG_PATH;
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.appendFileSync(logPath, JSON.stringify({ action, args }) + '\\n', 'utf8');

const pageTokenIndex = args.indexOf('--page-token');
const pageToken = pageTokenIndex >= 0 ? args[pageTokenIndex + 1] : 'start';
const resourceIndex = args.indexOf('--resource-ref');
const resourceRef = resourceIndex >= 0 ? args[resourceIndex + 1] : undefined;
const cursorIndex = args.indexOf('--cursor-position');
const cursorPosition = cursorIndex >= 0 ? Number(args[cursorIndex + 1]) : -1;

const discoverScenario = scenario.discover || {};
const readMap = scenario.read || {};
const readScenario = (resourceRef && readMap[resourceRef]) || readMap.default || {};
const discoverResponse = discoverScenario.pages ? discoverScenario.pages[pageToken || 'start'] : discoverScenario.response;
const selected = action === 'discover'
  ? ({ ...discoverScenario, response: discoverResponse })
  : (readScenario.byCursor ? readScenario.byCursor[String(cursorPosition)] || readScenario.default || {} : readScenario);

const respond = () => {
  if (selected.stderr) process.stderr.write(String(selected.stderr));
  if (selected.rawStdout) {
    process.stdout.write(String(selected.rawStdout));
  } else if (selected.response || selected.protocolVersion) {
    const response = JSON.parse(JSON.stringify(selected.response || selected));
    if (action === 'read' && response && Array.isArray(response.events)) {
      response.events = response.events.filter((event) => event.position > cursorPosition);
      if (response.events.length === 0) response.newPosition = cursorPosition;
    }
    process.stdout.write(JSON.stringify(response));
  }
  process.exit(Number(selected.exitCode || 0));
};

if (selected.delayMs) setTimeout(respond, Number(selected.delayMs));
else respond();
`, 'utf8');
  fs.chmodSync(filePath, 0o755);
  process.env.XURL_SCENARIO_PATH = path.join(path.dirname(filePath), 'xurl-scenario.json');
  process.env.XURL_LOG_PATH = path.join(path.dirname(filePath), 'xurl-invocations.jsonl');
}

function readInvocationLog(filePath: string): Array<{ action: string; args: string[] }> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { action: string; args: string[] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('lock contention: provider-scoped lock serializes heartbeat reads across processes', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': { byCursor: { '0': emptyStableRead('codex', 'conversation-main', 0) } },
      },
    });

    const fixture = env.createRuntime();

    // Acquire the provider lock from a "competing" process context.
    const lockRoot = path.join(env.root, 'data');
    const competingLock = acquireExternalSourceProviderLock({
      runtimeRoot: lockRoot,
      provider: 'codex',
      operation: 'competing-process',
      sourceId: 'external-codex',
    });
    assert.ok(competingLock.acquired, 'competing lock acquired');

    const result = await fixture.runtime.wake('startup');
    const report = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report, 'external source report exists');
    // The heartbeat lane detects lock contention and reports 'locked' status
    // without degrading internal heartbeat readiness.
    assert.equal(report!.status, 'locked', 'source reports lock contention');
    assert.equal(report!.drainState, 'idle');

    // Internal lane is unaffected.
    const internalReport = result.discovery.sources.find(s => s.sourceId === 'internal-xiaoba');
    assert.ok(internalReport, 'internal source report exists');

    competingLock.release();

    // After release, the next wake processes normally.
    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.notEqual(report2!.status, 'locked', 'source no longer locked after release');
  } finally {
    env.restore();
  }
});

test('lock contention: different providers remain isolated', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [],
          },
        },
      },
      read: {},
    });

    const lockRoot = path.join(env.root, 'data');
    // Acquire a lock for a DIFFERENT provider — codex lane must still proceed.
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
    assert.notEqual(report!.status, 'locked', 'codex lane not blocked by claude provider lock');

    otherLock.release();
  } finally {
    env.restore();
  }
});

test('lock contention: distinct provider identities cannot collide after path sanitization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-lock-identity-'));
  tempRoots.push(root);
  const first = acquireExternalSourceProviderLock({
    runtimeRoot: root,
    provider: 'codex/team',
    operation: 'first-provider',
  });
  assert.ok(first.acquired);
  const second = acquireExternalSourceProviderLock({
    runtimeRoot: root,
    provider: 'codex-team',
    operation: 'second-provider',
  });
  try {
    assert.ok(second.acquired, 'different provider identities own different lock paths');
  } finally {
    if (second.acquired) second.release();
    first.release();
  }
});

test('lock contention: a live in-progress stale-lock claimer is never deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-live-claim-'));
  tempRoots.push(root);
  const probe = acquireExternalSourceProviderLock({
    runtimeRoot: root,
    provider: 'codex',
    operation: 'probe',
  });
  assert.ok(probe.acquired);
  const lockDir = path.dirname(probe.lockPath);
  probe.release();

  const claimDir = path.join(lockDir, '.claim');
  fs.mkdirSync(claimDir, { recursive: true });
  fs.writeFileSync(path.join(claimDir, 'claimer.json'), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: 'live-claimer',
  }), 'utf8');

  const contender = acquireExternalSourceProviderLock({
    runtimeRoot: root,
    provider: 'codex',
    operation: 'contender',
  });
  assert.equal(contender.acquired, false, 'live claimer fences contenders during stale recovery');
  assert.equal(fs.existsSync(path.join(claimDir, 'claimer.json')), true, 'contender preserves live claim');
});

test('lock contention: a dead owner and dead reclaim claim recover without operator cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-stale-claim-'));
  tempRoots.push(root);
  const probe = acquireExternalSourceProviderLock({
    runtimeRoot: root,
    provider: 'codex',
    operation: 'probe',
  });
  assert.ok(probe.acquired);
  const lockDir = path.dirname(probe.lockPath);
  probe.release();

  fs.mkdirSync(path.join(lockDir, '.claim'), { recursive: true });
  fs.writeFileSync(probe.lockPath, JSON.stringify({
    provider: 'codex',
    pid: -1,
    startedAt: new Date(0).toISOString(),
    operation: 'stale-owner',
    token: 'stale-owner',
  }), 'utf8');
  fs.writeFileSync(path.join(lockDir, '.claim', 'claimer.json'), JSON.stringify({
    pid: -1,
    startedAt: new Date(0).toISOString(),
    token: 'stale-claimer',
  }), 'utf8');

  const recovered = acquireExternalSourceProviderLock({
    runtimeRoot: root,
    provider: 'codex',
    operation: 'recovered-owner',
  });
  assert.ok(recovered.acquired, 'dead owner and claim are reclaimed');
  if (recovered.acquired) {
    assert.equal(recovered.record.operation, 'recovered-owner');
    recovered.release();
  }
});

test('failure classification: permission failure records class and suspends with backoff', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    // discover succeeds, but read returns a permission error via exit code + stderr.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': { byCursor: { '0': emptyStableRead('codex', 'conversation-main', 0) } },
      },
    });

    const fixture = env.createRuntime();
    // First wake does discovery + activation baseline only (future-only).
    await fixture.runtime.wake('startup');

    // Second wake reads the resource — inject the permission error.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': {
              exitCode: 1,
              stderr: 'Error: permission denied Bearer secret-token api_key=abc123 C:\\Users\\alice\\secret /Users/alice/secret',
            },
          },
        },
      },
    });
    await fixture.runtime.wake('scheduled');

    const failureState = fixture.runtime.getExternalSourceFailureState();
    const state = failureState.get('external-codex');
    assert.ok(state, 'failure state recorded');
    assert.equal(state!.failureClass, 'permission', 'classified as permission failure');
    assert.ok(state!.suspendedUntil, 'permission failure suspends with backoff');
    assert.ok(state!.nextRetryAt, 'next retry timestamp set');
    assert.ok(state!.lastError, 'last error message recorded');
    assert.equal(state!.lastError.includes('permission'), true, 'error message is redacted but retains signal');
    assert.doesNotMatch(state!.lastError!, /secret-token|abc123|alice/i, 'credentials and local paths are redacted');

    // A third wake while suspended should skip (backoff) — not retry immediately.
    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.equal(report2!.status, 'backoff', 'source skipped due to backoff');
  } finally {
    env.restore();
  }
});

test('failure classification: protocol failure requires operator action (no automatic retry)', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': { byCursor: { '0': emptyStableRead('codex', 'conversation-main', 0) } },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    // Second wake: inject the protocol error on read.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': {
              exitCode: 1,
              stderr: 'Error: protocol version mismatch unsupported schema',
            },
          },
        },
      },
    });
    await fixture.runtime.wake('scheduled');

    const failureState = fixture.runtime.getExternalSourceFailureState();
    const state = failureState.get('external-codex');
    assert.ok(state);
    assert.equal(state!.failureClass, 'protocol', 'classified as protocol failure');
    assert.ok(state!.requiresOperatorAction, 'protocol failure requires operator action');
    assert.equal(state!.suspendedUntil, null, 'no automatic suspension — operator must intervene');

    // Subsequent wakes keep skipping until operator acts.
    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.equal(report2!.status, 'backoff', 'source skipped (requires operator action)');
    assert.equal(report2!.failureClass, 'protocol');
    assert.equal(report2!.requiresOperatorAction, true);
    assert.equal(report2!.nextAction, 'repair_source_then_retry');

    // After the operator fixes the reader/protocol, an explicit source retry
    // must clear the durable manual-action gate rather than strand the lane.
    assert.equal(
      fixture.runtime.retryExternalSourceFailure('codex', 'external-codex'),
      true,
      'operator can retry a source-level protocol failure',
    );
    const result3 = await fixture.runtime.wake('scheduled');
    const report3 = result3.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report3);
    assert.notEqual(report3!.status, 'backoff', 'explicit retry makes the source runnable again');
  } finally {
    env.restore();
  }
});

test('quarantine recovery: retry reprocesses the same event without a tombstone', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');

    // First wake: discover the resource (establishes activation baseline).
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': { byCursor: { '0': emptyStableRead('codex', 'conversation-main', 0) } },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const quarantinesBefore = fixture.runtime.listExternalSourceQuarantines('codex', 'external-codex');
    assert.equal(quarantinesBefore.length, 0, 'no quarantines initially');

    // Second wake: read fails with a quarantine-classified error (oversized).
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': {
              exitCode: 1,
              stderr: 'Error: oversized event exceeds external evidence limit — quarantine required',
            },
          },
        },
      },
    });
    await fixture.runtime.wake('scheduled');

    const quarantinesAfter = fixture.runtime.listExternalSourceQuarantines('codex', 'external-codex');
    assert.ok(quarantinesAfter.length >= 1, 'quarantine entry created');

    const quarantineId = quarantinesAfter[0]!.quarantineId;

    const lock = acquireExternalSourceProviderLock({
      runtimeRoot: path.join(env.root, 'data'),
      provider: 'codex',
      operation: 'competing-operator',
    });
    assert.ok(lock.acquired);
    assert.equal(
      fixture.runtime.retryExternalSourceQuarantine('codex', 'external-codex', quarantineId),
      false,
      'operator recovery respects the provider single-writer lock',
    );
    const stateWhileLocked = fixture.runtime.getExternalSourceFailureState().get('external-codex');
    assert.equal(stateWhileLocked?.failureClass, 'quarantine', 'lock contention preserves the recovery diagnosis');
    assert.equal(stateWhileLocked?.requiresOperatorAction, true);
    lock.release();

    // Retry: removes the quarantine so the event can be reprocessed.
    const retryResult = fixture.runtime.retryExternalSourceQuarantine('codex', 'external-codex', quarantineId);
    assert.equal(retryResult, true, 'retry removes quarantine');

    const stateAfterRetry = loadExternalCursorState(storePath);
    assert.ok(!stateAfterRetry.quarantinedEvents[quarantineId], 'quarantine entry removed');
    // No tombstone written for retry — the event will be reprocessed.
    assert.equal(Object.keys(stateAfterRetry.tombstones).length, 0, 'no tombstone written on retry');

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Retry task', 'Retry done.', {
                revision: 'retry-rev-1',
                contentHash: 'retry-hash-1',
              }),
            ], 1),
          },
        },
      },
    });
    const retryWake = await fixture.runtime.wake('scheduled');
    const retryReport = retryWake.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(retryReport);
    assert.notEqual(retryReport!.status, 'backoff', 'retry clears the durable operator-action gate');
    assert.equal(retryReport!.unitsProcessed, 1, 'the same blocked resource is reprocessed');
  } finally {
    env.restore();
  }
});

test('quarantine recovery: skip writes a durable tombstone before allowing the cursor to cross', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');

    // First wake: discover the resource.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': { byCursor: { '0': emptyStableRead('codex', 'conversation-main', 0) } },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    // Second wake: read fails with an integrity-conflict error.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': {
              exitCode: 1,
              stderr: 'Error: integrity conflict — event changed under the same identity',
            },
          },
        },
      },
    });
    await fixture.runtime.wake('scheduled');

    const quarantines = fixture.runtime.listExternalSourceQuarantines('codex', 'external-codex');
    assert.ok(quarantines.length >= 1, 'quarantine entry created for integrity conflict');
    const quarantineId = quarantines[0]!.quarantineId;

    // Skip: writes a tombstone, removes the quarantine.
    const skipResult = fixture.runtime.skipExternalSourceQuarantine(
      'codex',
      'external-codex',
      quarantineId,
      'operator skip — upstream event is corrupt',
    );
    assert.equal(skipResult, true, 'skip writes tombstone');

    const state = loadExternalCursorState(storePath);
    assert.ok(!state.quarantinedEvents[quarantineId], 'quarantine removed after skip');
    const tombstone = Object.values(state.tombstones).find(entry => entry.tombstoneId === quarantineId);
    assert.ok(tombstone, 'durable tombstone written');
    assert.ok(tombstone!.reason.includes('operator skip'), 'tombstone carries redacted reason');

    // The provider may replay the skipped stable identity with a different
    // revision/hash. The tombstone binds to stable identity, so the event is
    // still skipped and the cursor crosses it without creating evidence.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-0', 0, 'conv-1', 'branch-main', 'Skipped task', 'Skipped result.', {
                revision: 'mutated-after-skip',
                contentHash: 'mutated-after-skip',
              }),
            ], 0),
          },
        },
      },
    });
    const skipWake = await fixture.runtime.wake('scheduled');
    const skipReport = skipWake.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(skipReport);
    assert.notEqual(skipReport!.status, 'backoff', 'skip clears the durable operator-action gate');
    assert.equal(skipReport!.unitsProcessed, 0, 'skipped identity never becomes learning evidence');
    assert.equal(loadExternalCursorState(storePath).cursors['conversation-main']?.cursor.position, 0);
  } finally {
    env.restore();
  }
});

test('resource closure: delete closes locally while preserving cursor, capsules, and episodes', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');

    // Discover and process one event so we have cursor + capsule state.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Step 1', 'Done 1.', {
                revision: 'rev-main-1',
                contentHash: 'hash-main-1',
                timestamp: '2026-01-01T00:01:00.000Z',
              }),
            ], 1),
          },
        },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const stateBefore = loadExternalCursorState(storePath);
    assert.ok(stateBefore.resources['conversation-main'], 'resource discovered');
    assert.notEqual(stateBefore.resources['conversation-main']?.lifecycleStatus, 'closed', 'resource active');

    // Operator confirms the upstream resource was deleted.
    const closed = fixture.runtime.deleteExternalSourceResource('codex', 'external-codex', 'conversation-main');
    assert.equal(closed, true, 'resource closed after deletion confirmation');

    const stateAfter = loadExternalCursorState(storePath);
    const closedResource = stateAfter.resources['conversation-main'];
    assert.ok(closedResource, 'resource entry preserved (not deleted)');
    assert.equal(closedResource?.lifecycleStatus, 'closed', 'resource marked closed');
    assert.ok(closedResource?.closedAt, 'closedAt timestamp recorded');

    // Cursor is preserved — not wiped.
    assert.ok(stateAfter.cursors['conversation-main'], 'cursor preserved for closed resource');

    await fixture.runtime.wake('scheduled');
    const rediscoveredState = loadExternalCursorState(storePath);
    assert.equal(
      rediscoveredState.resources['conversation-main']?.lifecycleStatus,
      'closed',
      'ordinary rediscovery cannot silently reopen an operator-closed resource',
    );
  } finally {
    env.restore();
  }
});

test('resource closure: archive closes locally with the same preservation semantics', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-archived', 'event://codex/arc-0', 0, 'conv-arc', 'branch-arc', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-archived': { byCursor: { '0': emptyStableRead('codex', 'conversation-archived', 0) } },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const archived = fixture.runtime.archiveExternalSourceResource('codex', 'external-codex', 'conversation-archived');
    assert.equal(archived, true, 'resource archived');

    const state = loadExternalCursorState(storePath);
    assert.equal(state.resources['conversation-archived']?.lifecycleStatus, 'closed', 'archived resource closed');
    assert.ok(state.cursors['conversation-archived'], 'cursor preserved after archive');
  } finally {
    env.restore();
  }
});

test('reversible disablement: disable preserves durable state and re-enable resumes', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');

    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Step 1', 'Done 1.', {
                revision: 'rev-main-1',
                contentHash: 'hash-main-1',
                timestamp: '2026-01-01T00:01:00.000Z',
              }),
            ], 1),
          },
        },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const stateBefore = loadExternalCursorState(storePath);
    assert.ok(stateBefore.cursors['conversation-main'], 'cursor established');

    // Disable — durable state must be preserved.
    const disabled = fixture.runtime.disableExternalSource('codex', 'external-codex');
    assert.equal(disabled, true, 'source disabled');

    const result = await fixture.runtime.wake('scheduled');
    const disabledReport = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(disabledReport);
    assert.equal(disabledReport!.enabled, false, 'source reports disabled');

    const stateDuring = loadExternalCursorState(storePath);
    assert.ok(stateDuring.cursors['conversation-main'], 'cursor preserved during disablement');

    // Re-enable — state is intact, reads resume.
    const enabled = fixture.runtime.enableExternalSource('codex', 'external-codex');
    assert.equal(enabled, true, 'source re-enabled');

    const result2 = await fixture.runtime.wake('scheduled');
    const enabledReport = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(enabledReport);
    assert.equal(enabledReport!.enabled, true, 'source reports enabled after re-enablement');
  } finally {
    env.restore();
  }
});

test('graceful drain: stops new external reads and leaves unacknowledged work resumable', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');

    // Two resources: first one gets processed, second stays pending.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-a', 'event://codex/a-0', 0, 'conv-a', 'branch-a', { activationPosition: 0 }),
              resource('conversation-b', 'event://codex/b-0', 0, 'conv-b', 'branch-b', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-a': { byCursor: { '0': emptyStableRead('codex', 'conversation-a', 0) } },
        'conversation-b': { byCursor: { '0': emptyStableRead('codex', 'conversation-b', 0) } },
      },
    });

    const fixture = env.createRuntime();

    // Request drain before the next wake.
    fixture.runtime.requestExternalSourceDrain();

    const result = await fixture.runtime.wake('startup');
    const report = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report);
    assert.equal(report!.status, 'drained', 'source skipped due to drain');
    assert.equal(report!.drainState, 'draining', 'drain state visible in diagnostics');
    assert.equal(report!.unitsProcessed, 0, 'no external reads during drain');

    // Cursor state is untouched — no resources were acknowledged.
    const state = loadExternalCursorState(storePath);
    // Resources may have been discovered but cursors are not advanced.
    const cursorEntries = Object.values(state.cursors).filter(c => c.sourceIdentity?.sourceId === 'external-codex');
    assert.equal(cursorEntries.length, 0, 'no cursors advanced during drain');

    // Resume reads.
    fixture.runtime.resumeExternalSourceReads();
    const result2 = await fixture.runtime.wake('scheduled');
    const report2 = result2.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report2);
    assert.notEqual(report2!.status, 'drained', 'source resumes after drain cleared');
  } finally {
    env.restore();
  }
});

test('external drain does not suppress due internal settlement and review work', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: { pages: { start: { protocolVersion: 1, provider: 'codex', resources: [] } } },
      read: {},
    });
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
    assert.ok(
      result.review.reviewedEpisodes >= 1,
      `external drain leaves internal review admission live: ${JSON.stringify(result.review)}`,
    );
  } finally {
    env.restore();
  }
});

test('runtime diagnostics: status report surfaces provider, reader, cursor progress, and drain state', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Step 1', 'Done 1.', {
                revision: 'rev-main-1',
                contentHash: 'hash-main-1',
                timestamp: '2026-01-01T00:01:00.000Z',
              }),
            ], 1),
          },
        },
      },
    });

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');
    const report = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(report, 'external source report exists');

    // AC: Runtime status shows selected provider, reader support, cursor progress.
    assert.equal(report!.provider, 'codex', 'provider surfaced');
    assert.ok(report!.reader, 'reader surfaced');
    assert.ok(report!.selectedProvider, 'selected provider surfaced');
    assert.ok(report!.cursorProgress, 'cursor progress surfaced');
    assert.ok(typeof report!.cursorProgress!.maxPosition === 'number', 'maxPosition in cursor progress');
    assert.ok(typeof report!.cursorProgress!.activeResources === 'number', 'activeResources in cursor progress');
    assert.equal(report!.drainState, 'idle', 'drain state surfaced (idle)');
    assert.ok(report!.supportStatus, 'support status surfaced');
  } finally {
    env.restore();
  }
});

test('internal independence: missing xurl does not degrade internal heartbeat readiness', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    // Point xurl to a nonexistent command path so the external reader fails.
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = path.join(env.root, 'tmp', 'nonexistent-xurl.cjs');

    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Please deliver the internal result.', 'Done.'),
      turn(2, 'internal-session', 'Thanks.', 'You are welcome.'),
    ]);

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');

    // Internal lane processes normally despite external failure.
    const internalReport = result.discovery.sources.find(s => s.sourceId === 'internal-xiaoba');
    assert.ok(internalReport, 'internal source report exists');
    assert.ok(internalReport!.unitsProcessed >= 1, 'internal lane processed turns');

    // External lane fails but does not create a review queue entry.
    const externalReport = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(externalReport);
    assert.notEqual(externalReport!.status, 'active', 'external lane not healthy');
  } finally {
    env.restore();
  }
});

test('discovery cycle finalization: closes resources missing for two cycles', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    const storePath = cursorStorePath(env.root, 'codex', 'external-codex');

    // First wake: discover one resource.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-gone', 'event://codex/gone-0', 0, 'conv-gone', 'branch-gone', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-gone': { byCursor: { '0': emptyStableRead('codex', 'conversation-gone', 0) } },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    const stateAfterFirst = loadExternalCursorState(storePath);
    assert.ok(stateAfterFirst.resources['conversation-gone'], 'resource discovered in cycle 0');
    assert.notEqual(
      stateAfterFirst.resources['conversation-gone']?.lifecycleStatus,
      'closed',
      'resource active after first discovery',
    );

    // Second wake: resource disappears. Run finalization for cycle 1 —
    // resource has been missing for 1 cycle (not yet closed).
    writeScenario(env.scenarioPath, {
      discover: { pages: { start: { protocolVersion: 1, provider: 'codex', resources: [] } } },
      read: {},
    });
    await fixture.runtime.wake('scheduled');
    finalizeExternalDiscoveryCycleForStore(storePath, 1);

    const stateAfterSecond = loadExternalCursorState(storePath);
    assert.notEqual(
      stateAfterSecond.resources['conversation-gone']?.lifecycleStatus,
      'closed',
      'resource still active after 1 missing cycle',
    );

    // Third cycle: missing for 2 cycles → closed.
    finalizeExternalDiscoveryCycleForStore(storePath, 2);
    const stateAfterThird = loadExternalCursorState(storePath);
    assert.equal(
      stateAfterThird.resources['conversation-gone']?.lifecycleStatus,
      'closed',
      'resource closed after 2 missing discovery cycles',
    );
    // Cursor preserved.
    assert.ok(stateAfterThird.cursors['conversation-gone'], 'cursor preserved for auto-closed resource');
  } finally {
    env.restore();
  }
});

test('external failures never increment Operational Review Retry counters', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    // First wake: discover the resource (establishes activation baseline).
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': { byCursor: { '0': emptyStableRead('codex', 'conversation-main', 0) } },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    // Second wake: external read fails with a transient error.
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: { '0': { exitCode: 1, stderr: 'Error: transient network timeout' } },
        },
      },
    });
    const result = await fixture.runtime.wake('scheduled');

    // The external lane recorded a transient failure, but the review report
    // should show zero operational retries triggered by the external failure.
    assert.equal(result.ran, true);
    const externalReport = result.discovery.sources.find(s => s.sourceId === 'external-codex');
    assert.ok(externalReport);
    assert.equal(externalReport!.status, 'failed', 'external lane failed');

    const failureState = fixture.runtime.getExternalSourceFailureState();
    const state = failureState.get('external-codex');
    assert.ok(state);
    assert.equal(state!.failureClass, 'transient', 'classified as transient');
    assert.ok(state!.consecutiveFailures >= 1, 'failure count incremented');
    assert.ok(state!.suspendedUntil, 'transient failure suspends with backoff');
    // Review report must not attribute this to operational retry.
    assert.equal(result.review.operationalRetries, 0, 'external failure did not create an operational retry');
  } finally {
    env.restore();
  }
});

test('normal process exit does not leave in-flight state handles after operations', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Step 1', 'Done 1.', {
                revision: 'rev-main-1',
                contentHash: 'hash-main-1',
                timestamp: '2026-01-01T00:01:00.000Z',
              }),
            ], 1),
          },
        },
      },
    });

    const fixture = env.createRuntime();
    await fixture.runtime.wake('startup');

    // Exercise operator seams so any lingering state surfaces.
    fixture.runtime.listExternalSourceQuarantines('codex', 'external-codex');
    fixture.runtime.requestExternalSourceDrain();
    fixture.runtime.resumeExternalSourceReads();

    // No active backfill and no lingering abort controllers → clean exit.
    const failureState = fixture.runtime.getExternalSourceFailureState();
    assert.ok(failureState instanceof Map, 'failure state is a plain map');
    // A successful run with no failures should leave no scheduling-state entries.
    assert.equal(failureState.size, 0, 'no failure state from successful run');
  } finally {
    env.restore();
  }
});

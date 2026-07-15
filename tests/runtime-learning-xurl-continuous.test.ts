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
import { loadExternalCursorState } from '../src/utils/session-log-source';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';

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

test('future-only enablement is metadata-only and internal lane remains independent', async () => {
  const env = setupEnv({
    provider: 'codex',
    sourceId: 'external-codex',
  });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
              resource('conversation-main', 'event://codex/main-0', 0, 'conv-1', 'branch-main', {
                activationPosition: 1,
                revision: 'rev-main-0',
                contentHash: 'hash-main-0',
              }),
            ],
          },
        },
      },
      read: {},
    });
    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Please deliver the internal result.', 'Done.'),
      turn(2, 'internal-session', 'Thanks.', 'You are welcome.'),
    ]);

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');

    const externalReport = result.discovery.sources.find(source => source.sourceId === 'external-codex');
    const internalReport = result.discovery.sources.find(source => source.sourceId === 'internal-xiaoba');
    assert.ok(externalReport);
    assert.ok(internalReport);
    assert.equal(externalReport!.enabled, true);
    assert.equal(externalReport!.unitsProcessed, 0);
    assert.ok(internalReport!.unitsProcessed >= 1);

    const state = loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'));
    assert.equal(state.activation?.initialDiscoveryCompleted, true);
    assert.equal(state.cursors['conversation-main']?.cursor.position, 1);
    assert.equal(Object.keys(state.processedEventIds).length, 0);

    const invocations = readInvocationLog(env.logPath);
    assert.deepEqual(invocations.map(item => item.action), ['discover']);
  } finally {
    env.restore();
  }
});

test('discovery pagination state survives restart and completes independently from event progress', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        pages: {
          start: {
            protocolVersion: 1,
            provider: 'codex',
            nextPageToken: 'page-2',
            resources: [
              resource('conversation-a', 'event://codex/a-0', 0, 'conv-a', 'branch-a', { activationPosition: 0 }),
            ],
          },
          'page-2': {
            protocolVersion: 1,
            provider: 'codex',
            resources: [
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

    const first = env.createRuntime();
    await first.runtime.wake('startup');
    const afterFirst = loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'));
    assert.equal(afterFirst.discovery?.nextPageToken, 'page-2');
    assert.ok(afterFirst.resources['conversation-a']);
    assert.ok(!afterFirst.resources['conversation-b']);

    const second = env.createRuntime();
    await second.runtime.wake('scheduled');
    const afterSecond = loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'));
    assert.equal(afterSecond.discovery?.nextPageToken, null);
    assert.ok(afterSecond.resources['conversation-a']);
    assert.ok(afterSecond.resources['conversation-b']);
  } finally {
    env.restore();
  }
});

test('incremental continuation preserves branch isolation and bounded same-branch continuity', async () => {
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
              resource('conversation-side', 'event://codex/side-0', 0, 'conv-1', 'branch-side', { activationPosition: 0 }),
            ],
          },
        },
      },
      read: {
        'conversation-main': {
          byCursor: {
            '0': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Main branch step 1', 'Done main step 1.', {
                revision: 'rev-main-1',
                contentHash: 'hash-main-1',
                timestamp: '2026-01-01T00:01:00.000Z',
              }),
              protocolEvent('event://codex/main-2', 2, 'conv-1', 'branch-main', 'Main branch step 2', 'Done main step 2.', {
                revision: 'rev-main-2',
                contentHash: 'hash-main-2',
                timestamp: '2026-01-01T00:02:00.000Z',
              }),
            ], 3),
          },
        },
        'conversation-side': {
          byCursor: {
            '0': stableRead('codex', 'conversation-side', [
              protocolEvent('event://codex/side-1', 1, 'conv-1', 'branch-side', 'Side branch step 1', 'Done side step 1.', {
                revision: 'rev-side-1',
                contentHash: 'hash-side-1',
                timestamp: '2026-01-01T00:03:00.000Z',
              }),
            ], 2),
            '2': emptyStableRead('codex', 'conversation-side', 2),
          },
        },
      },
    });

    const first = env.createRuntime();
    await first.runtime.wake('startup');

    const second = env.createRuntime();
    const secondWake = await second.runtime.wake('scheduled');
    const secondExternal = secondWake.discovery.sources.find(source => source.sourceId === 'external-codex');
    assert.ok(secondExternal);
    assert.equal(secondExternal!.unitsProcessed, 3);

    const state = loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'));
    assert.equal(state.resources['conversation-main']?.continuityTail.length, 2);
    assert.equal(state.resources['conversation-side']?.continuityTail.length, 1);
    assert.equal(state.resources['conversation-main']?.resource.firstEventIdentity?.branchId, 'branch-main');
    assert.equal(state.resources['conversation-side']?.resource.firstEventIdentity?.branchId, 'branch-side');
  } finally {
    env.restore();
  }
});

test('pending ranges stay unacknowledged and mutated replayed events fail closed on restart', async () => {
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
            '0': {
              protocolVersion: 1,
              provider: 'codex',
              resourceRef: 'conversation-main',
              status: 'pending',
              exhausted: false,
              newPosition: 1,
              events: [],
            },
          },
        },
      },
    });

    const first = env.createRuntime();
    await first.runtime.wake('startup');
    const pendingRuntime = env.createRuntime();
    await pendingRuntime.runtime.wake('scheduled');
    const pendingState = loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'));
    assert.equal(pendingState.cursors['conversation-main']?.cursor.position, 0);
    assert.equal(Object.keys(pendingState.processedEventIds).length, 0);

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
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Step 1', 'Done step 1.', {
                revision: 'rev-1',
                contentHash: 'hash-1',
              }),
            ], 2),
            '2': stableRead('codex', 'conversation-main', [
              protocolEvent('event://codex/main-1', 1, 'conv-1', 'branch-main', 'Step 1', 'Done step 1 changed.', {
                revision: 'rev-2',
                contentHash: 'hash-2',
              }),
            ], 2, true),
          },
        },
      },
    });

    const admitted = env.createRuntime();
    await admitted.runtime.wake('scheduled');
    const admittedState = loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'));
    assert.equal(admittedState.cursors['conversation-main']?.cursor.position, 2);
    assert.equal(Object.keys(admittedState.processedEventIds).length, 1);

    const replay = env.createRuntime();
    const replayResult = await replay.runtime.wake('scheduled');
    const external = replayResult.discovery.sources.find(source => source.sourceId === 'external-codex');
    assert.ok(external);
    assert.equal(external!.status, 'failed');
    const replayState = loadExternalCursorState(cursorStorePath(env.root, 'codex', 'external-codex'));
    assert.equal(replayState.cursors['conversation-main']?.cursor.position, 2);
    assert.equal(replayState.processedEventFingerprints['external-codex::codex::event://codex/main-1::1::conv-1::branch-main'], 'rev-1::hash-1');
  } finally {
    env.restore();
  }
});

test('internal heartbeat remains healthy when the selected xurl provider fails', async () => {
  const env = setupEnv({ provider: 'codex', sourceId: 'external-codex' });
  try {
    writeScenario(env.scenarioPath, {
      discover: {
        rawStdout: '# invalid protocol\n',
      },
      read: {},
    });
    writeInternalLog(env.internalLogPath, [
      turn(1, 'internal-session', 'Please deliver the internal result.', 'Done.'),
      turn(2, 'internal-session', 'Thanks.', 'You are welcome.'),
    ]);

    const fixture = env.createRuntime();
    const result = await fixture.runtime.wake('startup');
    const external = result.discovery.sources.find(source => source.sourceId === 'external-codex');
    const internal = result.discovery.sources.find(source => source.sourceId === 'internal-xiaoba');
    assert.ok(external);
    assert.ok(internal);
    assert.equal(external!.status, 'failed');
    assert.ok(internal!.unitsProcessed >= 1);
  } finally {
    env.restore();
  }
});

function setupEnv(options: { provider: string; sourceId: string }): TestEnv {
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

function writeScenario(filePath: string, scenario: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(scenario, null, 2), 'utf8');
}

function readInvocationLog(filePath: string): Array<{ action: string; args: string[] }> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { action: string; args: string[] });
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
  ignoreCursor = false,
) {
  return {
    protocolVersion: 1,
    provider,
    resourceRef,
    status: 'stable',
    exhausted: true,
    newPosition,
    events,
    ignoreCursor,
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
    const ignoreCursor = selected.ignoreCursor === true;
    if (action === 'read' && !ignoreCursor && response && Array.isArray(response.events)) {
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

/**
 * Issue #85 — xurl protocol v1 explicit backfill through the public
 * RuntimeLearning seam.
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
import { XurlExternalBackfillSource } from '../src/utils/xurl-session-log-source';

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

test('xurl protocol v1 backfill succeeds through RuntimeLearning and persists canonical external identity', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, successScenario({ ignoreCursor: true }));
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
      provider: 'codex',
      sourceId: 'codex-xurl-source',
      resourceRefs: ['conversation-success'],
      endPosition: 0,
    });
    const result = await fixture.runtime.runExternalBackfill(request, createSource(env, request));

    assert.equal(result.backfill.status, 'completed');
    assert.equal(result.review.status, 'succeeded');
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 1);

    const episodeId = Object.keys(fixture.episodeStore.load().episodes)[0]!;
    const capsule = fixture.runtime.getEvidenceCapsuleStore().findByEpisodeId(episodeId)!;
    assert.equal(capsule.identity.eventId, 'event://codex/success-0');
    assert.equal(capsule.identity.conversationId, 'conversation-success-id');
    assert.equal(capsule.identity.branchId, 'branch-main');
    assert.equal(capsule.identity.revision, 'rev-success-0');
    assert.equal(capsule.identity.contentHash, 'hash-success-0');
    assert.ok(!JSON.stringify(capsule).includes('system-secret'));
    assert.ok(!JSON.stringify(capsule).includes('developer-secret'));

    const invocations = readInvocationLog(env.logPath);
    assert.deepEqual(invocations.map(item => item.action), ['discover', 'read']);
    assert.deepEqual(invocations[0]!.args, [
      'session-log-v1',
      'discover',
      '--protocol-version',
      '1',
      '--provider',
      'codex',
      '--source-id',
      'codex-xurl-source',
      '--mode',
      'explicit-backfill',
    ]);
    assert.deepEqual(invocations[1]!.args, [
      'session-log-v1',
      'read',
      '--protocol-version',
      '1',
      '--provider',
      'codex',
      '--source-id',
      'codex-xurl-source',
      '--resource-ref',
      'conversation-success',
      '--cursor-position',
      '-1',
    ]);
  } finally {
    env.restore();
  }
});

test('xurl invalid protocol fails closed without operational retry entries', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: { rawStdout: '# markdown fallback is forbidden\n' },
    });
    const fixture = env.createRuntime();
    const request = makeRequest({
      operationId: 'xurl-invalid-protocol',
      provider: 'codex',
      sourceId: 'codex-xurl-source',
      resourceRefs: ['conversation-success'],
      endPosition: 0,
    });

    const result = await fixture.runtime.runExternalBackfill(request, createSource(env, request));

    assert.equal(result.backfill.status, 'source_failed');
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 0);
    assert.equal(loadReviewQueueState(env.reviewQueuePath).operational.length, 0);
    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.equal(state.failures.length, 1);
    assert.match(state.failures[0]!.message, /not valid protocol-v1 JSON/i);
    const sourceFailure = fixture.runtime.getExternalSourceFailureState().get('codex-xurl-source');
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
      discover: { delayMs: 250, response: successScenario().discover.response },
    });
    const fixture = env.createRuntime();
    const request = makeRequest({ operationId: 'xurl-timeout' });

    const result = await fixture.runtime.runExternalBackfill(request, createSource(env, request, { timeoutMs: 50 }));

    assert.equal(result.backfill.status, 'source_failed');
    assert.equal(loadReviewQueueState(env.reviewQueuePath).operational.length, 0);
    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.match(state.failures[0]!.message, /timed out/i);
    const sourceFailure = fixture.runtime.getExternalSourceFailureState().get('codex-xurl-source');
    assert.equal(sourceFailure?.failureClass, 'transient');
    assert.ok(sourceFailure?.nextRetryAt);
  } finally {
    env.restore();
  }
});

test('xurl oversized output fails closed', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: { rawStdout: 'x'.repeat(8_192) },
    });
    const fixture = env.createRuntime();
    const request = makeRequest({ operationId: 'xurl-oversized-output' });

    const result = await fixture.runtime.runExternalBackfill(
      request,
      createSource(env, request, { maxOutputBytes: 512 }),
    );

    assert.equal(result.backfill.status, 'source_failed');
    assert.equal(loadReviewQueueState(env.reviewQueuePath).operational.length, 0);
    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.match(state.failures[0]!.message, /output exceeded/i);
  } finally {
    env.restore();
  }
});

test('xurl non-zero exit fails closed', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, {
      discover: { exitCode: 23, stderr: 'permission denied' },
    });
    const fixture = env.createRuntime();
    const request = makeRequest({ operationId: 'xurl-non-zero-exit' });

    const result = await fixture.runtime.runExternalBackfill(request, createSource(env, request));

    assert.equal(result.backfill.status, 'source_failed');
    assert.equal(loadReviewQueueState(env.reviewQueuePath).operational.length, 0);
    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.match(state.failures[0]!.message, /status 23/i);
  } finally {
    env.restore();
  }
});

test('xurl page failure replays safely after restart and acknowledges only after the full page succeeds', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, pageScenario({ ignoreCursor: true }));
    const request = makeRequest({
      operationId: 'xurl-page-replay',
      provider: 'codex',
      sourceId: 'codex-xurl-source',
      resourceRefs: ['conversation-page'],
      endPosition: 1,
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

    const store = failing.runtime.getEvidenceCapsuleStore();
    const originalUpsert = store.upsert.bind(store);
    let upsertCalls = 0;
    store.upsert = (capsule) => {
      upsertCalls += 1;
      if (upsertCalls === 2) {
        throw new Error('simulated second-capsule failure');
      }
      originalUpsert(capsule);
    };

    const first = await failing.runtime.runExternalBackfill(request, createSource(env, request));
    assert.equal(first.backfill.status, 'source_failed');
    const firstState = loadExternalSessionLogBackfillState(first.paths.stateFilePath)!;
    assert.equal(firstState.resourceCursors['conversation-page'], undefined, 'page cursor not acknowledged on failure');
    assert.equal(firstState.processedEventIds['codex::codex-xurl-source::event://codex/page-0::0::hash-page-0::conversation-page-id::branch-main::rev-page-0'], 'hash-page-0');
    assert.equal(Object.keys(failing.episodeStore.load().episodes).length, 2, 'replay must not create duplicate episodes after a page failure');

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
    assert.equal(Object.keys(recovery.episodeStore.load().episodes).length, 2);
    const secondState = loadExternalSessionLogBackfillState(second.paths.stateFilePath)!;
    assert.equal(secondState.resourceCursors['conversation-page']?.position, 2);
  } finally {
    env.restore();
  }
});

test('xurl rerun is idempotent even when the provider replays the same stable page', async () => {
  const env = setupEnv();
  try {
    writeScenario(env.scenarioPath, successScenario({ ignoreCursor: true }));
    const fixture = env.createRuntime();
    const request = makeRequest({ operationId: 'xurl-idempotent-rerun' });
    const source = createSource(env, request, { maxOutputBytes: 4_096 });

    const first = await fixture.runtime.runExternalBackfill(request, source);
    const second = await fixture.runtime.runExternalBackfill(request, source);

    assert.equal(first.backfill.status, 'completed');
    assert.equal(second.backfill.status, 'completed');
    assert.equal(second.backfill.duplicateEventsSkipped, 1);
    assert.equal(Object.keys(fixture.episodeStore.load().episodes).length, 1);
    assert.equal(fixture.runtime.getEvidenceCapsuleStore().count(), 1);
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
    provider: overrides.provider ?? 'codex',
    sourceId: overrides.sourceId ?? 'codex-xurl-source',
    range: {
      startPosition: overrides.startPosition ?? 0,
      endPosition: overrides.endPosition ?? 0,
      resourceRefs: overrides.resourceRefs ?? ['conversation-success'],
    },
    limits: {
      maxResources: 10,
      maxBytes: 1024 * 1024,
      maxElapsedMs: 60_000,
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

function successScenario(options: { ignoreCursor?: boolean } = {}) {
  return {
    discover: {
      response: {
        protocolVersion: 1,
        provider: 'codex',
        resources: [
          {
            resourceRef: 'conversation-success',
            firstEvent: {
              eventId: 'event://codex/success-0',
              position: 0,
              conversationId: 'conversation-success-id',
              branchId: 'branch-main',
              revision: 'rev-success-0',
              contentHash: 'hash-success-0',
            },
          },
        ],
      },
    },
    read: {
      default: {
        ignoreCursor: options.ignoreCursor === true,
        response: {
          protocolVersion: 1,
          provider: 'codex',
          resourceRef: 'conversation-success',
          status: 'stable',
          exhausted: true,
          newPosition: 1,
          events: [
            buildProtocolEvent({
              eventId: 'event://codex/success-0',
              position: 0,
              conversationId: 'conversation-success-id',
              branchId: 'branch-main',
              revision: 'rev-success-0',
              contentHash: 'hash-success-0',
              timestamp: '2026-01-01T00:00:00.000Z',
              userText: 'Please generate and send the report.',
              assistantText: 'Done.',
            }),
          ],
        },
      },
    },
  };
}

function pageScenario(options: { ignoreCursor?: boolean } = {}) {
  return {
    discover: {
      response: {
        protocolVersion: 1,
        provider: 'codex',
        resources: [
          {
            resourceRef: 'conversation-page',
            firstEvent: {
              eventId: 'event://codex/page-0',
              position: 0,
              conversationId: 'conversation-page-id',
              branchId: 'branch-main',
              revision: 'rev-page-0',
              contentHash: 'hash-page-0',
            },
          },
        ],
      },
    },
    read: {
      default: {
        ignoreCursor: options.ignoreCursor === true,
        response: {
          protocolVersion: 1,
          provider: 'codex',
          resourceRef: 'conversation-page',
          status: 'stable',
          exhausted: true,
          newPosition: 2,
          events: [
            buildProtocolEvent({
              eventId: 'event://codex/page-0',
              position: 0,
              conversationId: 'conversation-page-id',
              branchId: 'branch-main',
              revision: 'rev-page-0',
              contentHash: 'hash-page-0',
              timestamp: '2026-01-01T00:00:00.000Z',
              userText: 'Generate the first report.',
              assistantText: 'First report delivered.',
            }),
            buildProtocolEvent({
              eventId: 'event://codex/page-1',
              position: 1,
              conversationId: 'conversation-page-id',
              branchId: 'branch-main',
              revision: 'rev-page-1',
              contentHash: 'hash-page-1',
              timestamp: '2026-01-01T00:05:00.000Z',
              userText: 'Generate the second report.',
              assistantText: 'Second report delivered.',
            }),
          ],
        },
      },
    },
  };
}

function buildProtocolEvent(options: {
  eventId: string;
  position: number;
  conversationId: string;
  branchId: string;
  revision: string;
  contentHash: string;
  timestamp: string;
  userText: string;
  assistantText: string;
}) {
  return {
    eventId: options.eventId,
    position: options.position,
    conversationId: options.conversationId,
    branchId: options.branchId,
    revision: options.revision,
    contentHash: options.contentHash,
    timestamp: options.timestamp,
    messages: [
      { role: 'system', content: 'system-secret should be ignored' },
      { role: 'developer', content: 'developer-secret should be ignored' },
      { role: 'user', content: options.userText },
      {
        role: 'tool',
        toolCallId: `send-${options.position}`,
        name: 'send_file',
        arguments: { path: '/Users/me/project/private/report.md' },
        result: 'report sent token: my-secret',
        completed: true,
      },
      { role: 'assistant', content: options.assistantText, final: true },
    ],
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
const logEntry = { action, args };
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\\n', 'utf8');

const resourceIndex = args.indexOf('--resource-ref');
const resourceRef = resourceIndex >= 0 ? args[resourceIndex + 1] : undefined;
const cursorIndex = args.indexOf('--cursor-position');
const cursorPosition = cursorIndex >= 0 ? Number(args[cursorIndex + 1]) : -1;

const discoverScenario = scenario.discover || {};
const readMap = scenario.read || {};
const readScenario = (resourceRef && readMap[resourceRef]) || readMap.default || {};
const selected = action === 'discover' ? discoverScenario : readScenario;

const respond = () => {
  if (selected.stderr) process.stderr.write(String(selected.stderr));
  if (selected.rawStdout) {
    process.stdout.write(String(selected.rawStdout));
  } else if (selected.response) {
    const response = JSON.parse(JSON.stringify(selected.response));
    if (action === 'read' && !selected.ignoreCursor && response && Array.isArray(response.events)) {
      response.events = response.events.filter((event) => event.position > cursorPosition);
      response.newPosition = response.events.length > 0 ? response.newPosition : cursorPosition;
    }
    process.stdout.write(JSON.stringify(response));
  }
  process.exit(Number(selected.exitCode || 0));
};

if (selected.delayMs) {
  setTimeout(respond, Number(selected.delayMs));
} else {
  respond();
}
`, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

/**
 * Issue #75 — Source-neutral Heartbeat input seam with internal adapter.
 *
 * Tests the Session Log Source boundary through the public RuntimeLearning.wake()
 * path:
 *   - Internal source remains enabled by default and existing distillation
 *     behavior is preserved (no observable regression).
 *   - External sources are disabled by default and a default wake performs
 *     no external provider reads.
 *   - A deterministic fixture adapter feeds canonical source events through
 *     RuntimeLearning.wake() with observable source progress and status.
 *   - Source identity is distinct from External Agent executor identity.
 *
 * No private-helper assertions — all observations go through the public
 * wake() result and public accessors.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { SkillEvolutionRuntime, SkillEvolutionOptions } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import { DistillationUnit } from '../src/utils/distillation-unit';
import { extractDistillationUnit } from '../src/utils/distillation-unit';
import {
  InternalSessionLogSourceAdapter,
  FixtureSessionLogSourceAdapter,
  ExternalSessionLogSourceAdapter,
  ExternalSourceReader,
  ExternalSourceReaderResult,
  ExternalSourceRawEvent,
  FixtureExternalSourceReader,
  SessionLogSourceAdapter,
  SessionLogSourceIdentity,
  SourceCursor,
  SessionLogSourceResource,
  SessionLogSourceReadContext,
  SessionLogSourceReadResult,
  loadExternalCursorState,
  saveExternalCursorState,
  emptyExternalCursorState,
} from '../src/utils/session-log-source';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function writeLog(filePath: string, entries: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function futureTurn(
  turn: number,
  sessionId: string,
  userText: string,
  assistantText: string,
  toolCalls: { id: string; name: string; arguments: any; result: string }[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 20 },
  };
}

function deliveryPair(): [SessionTurnLogEntry, SessionTurnLogEntry] {
  return [
    futureTurn(1, 'cli', 'Deliver a small report.', 'Delivered the report.',
      [{ id: 'send-1', name: 'send_file', arguments: { path: 'report.md' }, result: 'report sent' }],
    ),
    futureTurn(2, 'cli', 'Thanks, that works perfectly!', 'Glad it helped.'),
  ];
}

/** Build a real DistillationUnit from turn entries written to a temp file. */
function buildDistillationUnitFromFile(
  turns: SessionTurnLogEntry[],
  filePath: string,
): DistillationUnit {
  writeLog(filePath, turns);
  const result = extractDistillationUnit(filePath, {
    filePath,
    byteOffset: 0,
    processedTurnCount: 0,
    updatedAt: '',
    status: 'pending',
  });
  if (!result.distillationUnit) {
    throw new Error('Failed to extract distillation unit from fixture file');
  }
  return result.distillationUnit;
}

interface TestEnv {
  root: string;
  logFile: string;
  stateFile: string;
  episodeStorePath: string;
  reviewQueuePath: string;
  registryPath: string;
  auditPath: string;
  journalPath: string;
  reassessmentManifestPath: string;
  curatorStatePath: string;
  ledgerPath: string;
  outputDir: string;
  skillEvolution: SkillEvolutionRuntime;
  episodeStore: LearningEpisodeStore;
  evidenceIngestor: EvidenceIngestor;
  curator: SkillUsageCurator;
  planner: DueWorkPlanner;
  savedEnv: Record<string, string | undefined>;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(settlementWindowMs = 0): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-source-boundary-'));
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
  const skillsRoot = path.join(root, 'skills');
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
    XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE: process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE,
    XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID,
    XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND: process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND,
  };

  process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
  process.env.DISTILLATION_HEARTBEAT_INTERVAL_HOURS = '6';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
  process.env.DISTILLATION_HEARTBEAT_STATE_FILE = stateFile;
  process.env.DISTILLATION_HEARTBEAT_RECORD_FILE = heartbeatRecordFile;
  delete process.env.XIAOBA_ROLE;
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = reassessmentManifestPath;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID;
  delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND;

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

  return {
    root,
    logFile,
    stateFile,
    episodeStorePath,
    reviewQueuePath,
    registryPath,
    auditPath,
    journalPath,
    reassessmentManifestPath,
    curatorStatePath,
    ledgerPath,
    outputDir,
    skillEvolution,
    episodeStore,
    evidenceIngestor,
    curator,
    planner,
    savedEnv,
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

function createRuntimeLearning(env: TestEnv, sources?: readonly SessionLogSourceAdapter[]): RuntimeLearning {
  return new RuntimeLearning({
    workingDirectory: env.root,
    evidenceIngestor: env.evidenceIngestor,
    learningEpisodeStore: env.episodeStore,
    skillEvolution: env.skillEvolution,
    curator: env.curator,
    planner: env.planner,
    sessionLogSources: sources,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #75 — Source-neutral Heartbeat input seam', () => {

  describe('AC1: Internal source enabled by default with no regression', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('default wake uses internal source adapter and ingests session logs', async () => {
      const [delivery, acceptance] = deliveryPair();
      writeLog(env.logFile, [delivery, acceptance]);

      // No sessionLogSources injected — defaults to InternalSessionLogSourceAdapter
      const runtimeLearning = createRuntimeLearning(env);

      const result = await runtimeLearning.wake('startup');

      assert.equal(result.ran, true);
      assert.equal(result.discovery.scanned, true);
      assert.equal(result.discovery.filesScanned, 1);
      assert.ok(result.ingestion.admittedEpisodes >= 1, 'at least one episode admitted');

      // Source report shows the internal source
      assert.ok(result.discovery.sources.length >= 1, 'at least one source report');
      const internalReport = result.discovery.sources[0];
      assert.equal(internalReport.sourceId, 'internal-xiaoba');
      assert.equal(internalReport.category, 'internal');
      assert.equal(internalReport.enabled, true);
      assert.equal(internalReport.resourcesDiscovered, 1);
      assert.equal(internalReport.unitsProcessed, 1);
      assert.equal(internalReport.advancedResources, 1);
    });

    test('cursor advancement is durable across wakes (no regression)', async () => {
      const [delivery, acceptance] = deliveryPair();
      writeLog(env.logFile, [delivery, acceptance]);

      const runtimeLearning = createRuntimeLearning(env);

      // First wake
      const result1 = await runtimeLearning.wake('startup');
      assert.equal(result1.discovery.unitsProcessed, 1);

      // Second wake — no new content
      const result2 = await runtimeLearning.wake('scheduled');
      assert.equal(result2.discovery.unitsProcessed, 0);
      assert.equal(result2.discovery.advancedFiles, 0);
    });

    test('bounded discovery releases stable EOF files so later pages are reachable', () => {
      const logsDir = path.dirname(env.logFile);
      const files = ['page-a.jsonl', 'page-b.jsonl', 'page-c.jsonl']
        .map(name => path.join(logsDir, name));
      fs.mkdirSync(logsDir, { recursive: true });
      for (const file of files) fs.writeFileSync(file, '', 'utf8');

      const adapter = new InternalSessionLogSourceAdapter(getDistillationHeartbeatConfig(env.root));
      const firstPage = adapter.discoverResources({ maxResources: 2, maxElapsedMs: 1_000 });
      assert.equal(firstPage.length, 2);
      for (const resource of firstPage) {
        const read = adapter.read(resource, { orderedResources: firstPage });
        assert.equal(read.status, 'exhausted');
        assert.equal(read.releaseResource, true);
        adapter.acknowledge(resource, read);
      }

      const secondPage = adapter.discoverResources({ maxResources: 2, maxElapsedMs: 1_000 });
      assert.ok(secondPage.some(resource => !firstPage.some(first => first.resourceRef === resource.resourceRef)));
      adapter.close();
    });

    test('an incomplete trailing line rotates without advancing its durable cursor', () => {
      fs.mkdirSync(path.dirname(env.logFile), { recursive: true });
      fs.writeFileSync(env.logFile, '{"entry_type":"turn"', 'utf8');
      const adapter = new InternalSessionLogSourceAdapter(getDistillationHeartbeatConfig(env.root));
      const [resource] = adapter.discoverResources({ maxResources: 1, maxElapsedMs: 1_000 });
      assert.ok(resource);

      const read = adapter.read(resource, { orderedResources: [resource] });
      assert.equal(read.status, 'idle');
      assert.equal(read.releaseResource, true);
      assert.equal(read.newCursor.position, 0);
      adapter.acknowledge(resource, read);
      assert.equal(read.newCursor.position, 0);
      adapter.close();
    });

    test('non-discovery wake skips log scanning', async () => {
      const [delivery, acceptance] = deliveryPair();
      writeLog(env.logFile, [delivery, acceptance]);

      const runtimeLearning = createRuntimeLearning(env);

      const result = await runtimeLearning.wake('settlement-deadline');

      assert.equal(result.discovery.scanned, false);
      assert.equal(result.discovery.filesScanned, 0);
      assert.equal(result.discovery.sources.length, 0);
    });

    test('internal adapter identity is distinct from External Agent executor identity', () => {
      const config = getDistillationHeartbeatConfig(env.root);
      const adapter = new InternalSessionLogSourceAdapter(config);
      const identity = adapter.identity;

      // Source identity describes the origin of the log, not an Agent
      assert.equal(identity.category, 'internal');
      assert.equal(identity.provider, 'xiaoba');
      assert.equal(identity.reader, 'filesystem-jsonl');
      assert.equal(identity.sourceId, 'internal-xiaoba');

      // The identity has provider and reader, but no executor/agent field —
      // source identity is structurally separate from External Agent executor
      // identity (which is managed by the skill-evolution runtime).
      assert.ok(!('executor' in identity), 'source identity has no executor field');
      assert.ok(!('agent' in identity), 'source identity has no agent field');
    });
  });

  describe('AC2: External sources disabled by default', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('external adapter reports disabled by default', () => {
      const external = new ExternalSessionLogSourceAdapter({
        sourceId: 'external-pi',
        provider: 'pi',
      });

      assert.equal(external.isEnabled(), false);
      assert.equal(external.identity.category, 'external');
      assert.equal(external.identity.provider, 'pi');
    });

    test('config externalSessionLogSourcesEnabled defaults to false', () => {
      delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED;
      const config = getDistillationHeartbeatConfig(env.root);
      assert.equal(config.externalSessionLogSourcesEnabled, false);
    });

    test('config externalSessionLogSourcesEnabled can be opt-in', () => {
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
      const config = getDistillationHeartbeatConfig(env.root);
      assert.equal(config.externalSessionLogSourcesEnabled, true);
    });

    test('opt-in without a selected provider keeps the default wake internal-only', () => {
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
      delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER;
      const runtimeLearning = createRuntimeLearning(env);
      const external = runtimeLearning.getSessionLogSources()
        .filter(source => source.identity.category === 'external');
      assert.deepEqual(external.map(source => source.identity.provider), []);
    });

    test('selected provider config is exposed through heartbeat config', async () => {
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER = 'codex';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID = 'external-codex';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = '/tmp/fake-xurl';
      const config = getDistillationHeartbeatConfig(env.root);
      assert.equal(config.externalSessionLogSelectedProvider, 'codex');
      assert.equal(config.externalSessionLogSelectedSourceId, 'external-codex');
      assert.equal(config.externalSessionLogXurlCommand, '/tmp/fake-xurl');
    });

    test('default wake with external adapter performs no external reads', async () => {
      const [delivery, acceptance] = deliveryPair();
      writeLog(env.logFile, [delivery, acceptance]);

      const external = new ExternalSessionLogSourceAdapter({
        sourceId: 'external-codex',
        provider: 'codex',
        // enabled defaults to false
      });

      const runtimeLearning = createRuntimeLearning(env, [
        new InternalSessionLogSourceAdapter(getDistillationHeartbeatConfig(env.root)),
        external,
      ]);

      const result = await runtimeLearning.wake('startup');

      // Internal source still works
      assert.equal(result.discovery.scanned, true);
      assert.ok(result.ingestion.admittedEpisodes >= 1);

      // External source is disabled in the report
      const externalReport = result.discovery.sources.find(s => s.sourceId === 'external-codex');
      assert.ok(externalReport, 'external source report exists');
      assert.equal(externalReport!.enabled, false);
      assert.equal(externalReport!.resourcesDiscovered, 0);
      assert.equal(externalReport!.unitsProcessed, 0);
    });
  });

  describe('AC3: Fixture adapter feeds canonical source events through wake()', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('fixture adapter produces observable progress through wake()', async () => {
      // Build a real DistillationUnit from session log entries
      const fixtureFile = path.join(env.root, 'fixture', 'chat', 'fixture-1.jsonl');
      const [delivery, acceptance] = deliveryPair();
      const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

      const fixture = new FixtureSessionLogSourceAdapter([unit]);

      const runtimeLearning = createRuntimeLearning(env, [fixture]);

      const result = await runtimeLearning.wake('startup');

      // Observable progress through the public wake() result
      assert.equal(result.ran, true);
      assert.equal(result.discovery.scanned, true);
      assert.ok(result.ingestion.admittedEpisodes >= 1, 'fixture admitted at least one episode');

      // Source report shows fixture source
      assert.equal(result.discovery.sources.length, 1);
      const fixtureReport = result.discovery.sources[0];
      assert.equal(fixtureReport.sourceId, 'fixture-test');
      assert.equal(fixtureReport.enabled, true);
      assert.equal(fixtureReport.resourcesDiscovered, 1);
      assert.equal(fixtureReport.unitsProcessed, 1);
      assert.equal(fixtureReport.advancedResources, 1);
    });

    test('fixture adapter second wake shows exhausted status (no new events)', async () => {
      const fixtureFile = path.join(env.root, 'fixture', 'chat', 'fixture-2.jsonl');
      const [delivery, acceptance] = deliveryPair();
      const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

      const fixture = new FixtureSessionLogSourceAdapter([unit]);
      const runtimeLearning = createRuntimeLearning(env, [fixture]);

      // First wake
      const result1 = await runtimeLearning.wake('startup');
      assert.equal(result1.discovery.unitsProcessed, 1);

      // Second wake — fixture is exhausted
      const result2 = await runtimeLearning.wake('scheduled');
      assert.equal(result2.discovery.unitsProcessed, 0);
      assert.equal(result2.discovery.sources[0].unitsProcessed, 0);
    });

    test('fixture adapter supports multiple units in one wake', async () => {
      const fixtureFile1 = path.join(env.root, 'fixture', 'chat', 'multi-1.jsonl');
      const fixtureFile2 = path.join(env.root, 'fixture', 'chat', 'multi-2.jsonl');
      const [delivery1, acceptance1] = deliveryPair();
      const [delivery2, acceptance2] = deliveryPair();
      const unit1 = buildDistillationUnitFromFile([delivery1, acceptance1], fixtureFile1);
      const unit2 = buildDistillationUnitFromFile([delivery2, acceptance2], fixtureFile2);

      const fixture = new FixtureSessionLogSourceAdapter([unit1, unit2]);
      const runtimeLearning = createRuntimeLearning(env, [fixture]);

      const result = await runtimeLearning.wake('startup');

      assert.equal(result.discovery.sources[0].resourcesDiscovered, 2);
      assert.equal(result.discovery.sources[0].unitsProcessed, 2);
      assert.equal(result.discovery.sources[0].advancedResources, 2);
      assert.ok(result.ingestion.admittedEpisodes >= 2, 'at least two episodes admitted');
    });

    test('external batch wake admits every unit before acknowledging once', async () => {
      const fixtureFile1 = path.join(env.root, 'fixture', 'chat', 'external-batch-1.jsonl');
      const fixtureFile2 = path.join(env.root, 'fixture', 'chat', 'external-batch-2.jsonl');
      const [delivery1, acceptance1] = deliveryPair();
      const [delivery2, acceptance2] = deliveryPair();
      const sensitivePrompt = '<system>external system prompt</system> token: batch-secret /Users/private/project';
      for (const delivery of [delivery1, delivery2]) {
        delivery.user.text = `Deliver the report. ${sensitivePrompt}`;
        delivery.assistant.tool_calls[0]!.arguments = { path: '/Users/private/project/report.md', token: 'batch-secret' };
        delivery.assistant.tool_calls[0]!.result = `report sent token: batch-secret from /Users/private/project`;
      }
      const units = [
        buildDistillationUnitFromFile([delivery1, acceptance1], fixtureFile1),
        buildDistillationUnitFromFile([delivery2, acceptance2], fixtureFile2),
      ];
      const resource: SessionLogSourceResource = {
        resourceRef: 'external://batch/resource',
        firstEventIdentity: { eventId: 'batch-event-1', position: 0 },
      };
      let acknowledged = 0;
      let consumed = false;
      const batchSource: SessionLogSourceAdapter = {
        identity: {
          sourceId: 'external-batch-wake',
          label: 'External Batch Wake Fixture',
          category: 'external',
          provider: 'fixture',
          reader: 'batch',
        },
        isEnabled: () => true,
        discoverResources: () => [resource],
        read: () => {
          if (consumed) {
            return {
              distillationUnit: null,
              advanced: false,
              status: 'exhausted',
              newCursor: { resourceRef: resource.resourceRef, position: 2, processedCount: 2 },
            };
          }
          consumed = true;
          return {
            distillationUnit: units[0]!,
            distillationUnits: units,
            eventIdentities: [
              { eventId: 'batch-event-1', position: 0, contentHash: 'batch-hash-1' },
              { eventId: 'batch-event-2', position: 1, contentHash: 'batch-hash-2' },
            ],
            advanced: true,
            status: 'advanced',
            newCursor: { resourceRef: resource.resourceRef, position: 2, processedCount: 2 },
          };
        },
        acknowledge: () => { acknowledged += 1; },
        markFailed: () => { consumed = false; },
      };

      const runtimeLearning = createRuntimeLearning(env, [batchSource]);
      const result = await runtimeLearning.wake('startup');

      assert.equal(result.discovery.unitsProcessed, 2);
      assert.equal(result.discovery.advancedFiles, 1);
      assert.equal(acknowledged, 1, 'the batch advances only after both units are admitted');
      const episodes = Object.values(env.episodeStore.load().episodes);
      assert.ok(episodes.length >= 2, 'both external units admit episodes');
      const capsules = Object.values(runtimeLearning.getEvidenceCapsuleStore().load().capsules);
      assert.ok(capsules.length >= 2, 'both external units persist capsules');
      const durableText = JSON.stringify({ episodes, capsules });
      assert.ok(!durableText.includes('batch-secret'));
      assert.ok(!durableText.includes('/Users/private/project'));
      assert.ok(!durableText.includes('external system prompt'));
    });

    test('external batch quarantine identifies the event that actually failed', async () => {
      const fixtureFile1 = path.join(env.root, 'fixture', 'chat', 'external-batch-good.jsonl');
      const fixtureFile2 = path.join(env.root, 'fixture', 'chat', 'external-batch-oversized.jsonl');
      const [delivery1, acceptance1] = deliveryPair();
      const [delivery2, acceptance2] = deliveryPair();
      delivery2.assistant.tool_calls[0]!.arguments = { payload: 'x'.repeat(4 * 1024) };
      const units = [
        buildDistillationUnitFromFile([delivery1, acceptance1], fixtureFile1),
        buildDistillationUnitFromFile([delivery2, acceptance2], fixtureFile2),
      ];
      const resource: SessionLogSourceResource = {
        resourceRef: 'external://batch-failure/resource',
        firstEventIdentity: { eventId: 'batch-good', position: 0 },
      };
      const source: SessionLogSourceAdapter = {
        identity: {
          sourceId: 'external-batch-failure',
          label: 'External Batch Failure Fixture',
          category: 'external',
          provider: 'fixture',
          reader: 'batch',
        },
        isEnabled: () => true,
        discoverResources: () => [resource],
        read: () => ({
          distillationUnit: units[0]!,
          distillationUnits: units,
          eventIdentities: [
            { eventId: 'batch-good', position: 0, contentHash: 'batch-good-hash' },
            { eventId: 'batch-oversized', position: 1, contentHash: 'batch-oversized-hash' },
          ],
          advanced: true,
          status: 'advanced',
          newCursor: { resourceRef: resource.resourceRef, position: 2, processedCount: 2 },
        }),
        acknowledge: () => assert.fail('failed batch must remain unacknowledged'),
        markFailed: () => {},
      };

      const runtimeLearning = createRuntimeLearning(env, [source]);
      const result = await runtimeLearning.wake('startup');
      const quarantines = runtimeLearning.listExternalSourceQuarantines('fixture', 'external-batch-failure');

      assert.equal(result.discovery.sources[0]!.status, 'failed');
      assert.equal(quarantines.length, 1);
      assert.equal(quarantines[0]!.identity.eventId, 'batch-oversized');
      assert.equal(quarantines[0]!.identity.position, 1);
    });

    test('replay repairs provenance before cursor advancement after a persistence interruption', async () => {
      const fixtureFile = path.join(env.root, 'fixture', 'chat', 'external-replay.jsonl');
      const [delivery, acceptance] = deliveryPair();
      const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);
      const identity = {
        sourceId: 'external-replay',
        category: 'external' as const,
        provider: 'fixture',
        reader: 'fixture',
      };
      const provenancePath = path.join(
        path.dirname(getDistillationHeartbeatConfig(env.root).learningEpisodeStorePath),
        'external-source-provenance.json',
      );

      const interruptedSource = new FixtureSessionLogSourceAdapter([unit], { identity });
      const interruptedRuntime = createRuntimeLearning(env, [interruptedSource]);
      fs.mkdirSync(provenancePath, { recursive: true });

      const interrupted = await interruptedRuntime.wake('startup');
      assert.equal(interrupted.discovery.unitsProcessed, 0);
      assert.equal(fs.statSync(provenancePath).isDirectory(), true);
      const persistedEpisodeIds = Object.keys(env.episodeStore.load().episodes);
      assert.ok(persistedEpisodeIds.length >= 1, 'episode persistence may precede provenance');

      fs.rmSync(provenancePath, { recursive: true, force: true });
      // Simulate the source-specific retry backoff having elapsed.
      fs.rmSync(path.join(path.dirname(provenancePath), 'external-source-scheduling-state.json'), {
        force: true,
      });
      const replaySource = new FixtureSessionLogSourceAdapter([unit], { identity });
      const replayRuntime = createRuntimeLearning(env, [replaySource]);
      const replay = await replayRuntime.wake('startup');

      assert.equal(replay.discovery.unitsProcessed, 1);
      assert.equal(replay.discovery.advancedFiles, 1);
      const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as {
        episodeToEvent: Record<string, string>;
      };
      assert.deepEqual(Object.keys(provenance.episodeToEvent).sort(), persistedEpisodeIds.sort());
      assert.ok(replayRuntime.getEvidenceCapsuleStore().count() >= 1);
    });

    test('corrupt external provenance is quarantined until explicit verified recovery', () => {
      const provenancePath = path.join(
        path.dirname(getDistillationHeartbeatConfig(env.root).learningEpisodeStorePath),
        'external-source-provenance.json',
      );
      fs.mkdirSync(path.dirname(provenancePath), { recursive: true });
      fs.writeFileSync(provenancePath, '{not-json', 'utf8');

      const runtimeLearning = createRuntimeLearning(env, []);
      const markerPath = `${provenancePath}.state-corrupt`;
      assert.equal(fs.existsSync(markerPath), true);
      assert.equal(fs.existsSync(provenancePath), false);
      assert.ok(fs.readdirSync(path.dirname(provenancePath))
        .some(name => name.startsWith('external-source-provenance.json.corrupt-')));

      runtimeLearning.recoverExternalEpisodeProvenanceState({
        schemaVersion: 1,
        episodeToEvent: {},
        eventToEpisodes: {},
      });
      assert.equal(fs.existsSync(markerPath), false);
    });

    test('oversized external evidence fails closed before episode persistence', async () => {
      const fixtureFile = path.join(env.root, 'fixture', 'chat', 'external-oversized.jsonl');
      const [delivery, acceptance] = deliveryPair();
      delivery.assistant.tool_calls[0]!.arguments = { payload: 'x'.repeat(4 * 1024) };
      const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);
      const resource: SessionLogSourceResource = {
        resourceRef: 'external://oversized/resource',
        firstEventIdentity: { eventId: 'oversized-event', position: 0 },
      };
      let acknowledged = 0;
      const source: SessionLogSourceAdapter = {
        identity: {
          sourceId: 'external-oversized',
          label: 'External Oversized Fixture',
          category: 'external',
          provider: 'fixture',
          reader: 'oversized',
        },
        isEnabled: () => true,
        discoverResources: () => [resource],
        read: () => ({
          distillationUnit: unit,
          advanced: true,
          status: 'advanced',
          newCursor: { resourceRef: resource.resourceRef, position: 1, processedCount: 2 },
        }),
        acknowledge: () => { acknowledged += 1; },
        markFailed: () => {},
      };

      const runtimeLearning = createRuntimeLearning(env, [source]);
      const result = await runtimeLearning.wake('startup');

      assert.equal(result.discovery.sources[0]!.status, 'failed');
      assert.equal(acknowledged, 0);
      assert.equal(Object.keys(env.episodeStore.load().episodes).length, 0);
      assert.equal(runtimeLearning.getEvidenceCapsuleStore().count(), 0);
    });

    test('fixture adapter source identity is distinct from external agent executor', () => {
      const fixture = new FixtureSessionLogSourceAdapter([]);
      const identity = fixture.identity;

      assert.equal(identity.category, 'internal');
      assert.equal(identity.provider, 'fixture');
      assert.equal(identity.reader, 'fixture');
      // No executor/agent field — distinct from External Agent executor identity
      assert.ok(!('executor' in identity));
      assert.ok(!('agent' in identity));
    });
  });

  describe('AC4: Source identity distinct from External Agent executor identity', () => {
    test('source identity has provider and reader, not executor', () => {
      const internal = new InternalSessionLogSourceAdapter(
        getDistillationHeartbeatConfig(process.cwd()),
      );
      const external = new ExternalSessionLogSourceAdapter({
        sourceId: 'external-claude-code',
        provider: 'claude-code',
        reader: 'xurl',
      });
      const fixture = new FixtureSessionLogSourceAdapter([]);

      for (const adapter of [internal, external, fixture]) {
        const identity = adapter.identity;
        assert.ok('sourceId' in identity, 'has sourceId');
        assert.ok('category' in identity, 'has category');
        assert.ok('provider' in identity, 'has provider');
        assert.ok('reader' in identity, 'has reader');
        assert.ok(!('executor' in identity), 'no executor field');
        assert.ok(!('agent' in identity), 'no agent field');
      }

      // External source identity: provider names the external tool, reader
      // names the access mechanism — both are source-level, not executor-level
      assert.equal(external.identity.provider, 'claude-code');
      assert.equal(external.identity.reader, 'xurl');
    });

    test('internal and external source identities are distinguishable', () => {
      const internal = new InternalSessionLogSourceAdapter(
        getDistillationHeartbeatConfig(process.cwd()),
      );
      const external = new ExternalSessionLogSourceAdapter({
        sourceId: 'external-pi',
        provider: 'pi',
      });

      assert.notEqual(internal.identity.sourceId, external.identity.sourceId);
      assert.notEqual(internal.identity.category, external.identity.category);
      assert.notEqual(internal.identity.provider, external.identity.provider);
    });
  });

  describe('AC5: Source Event Identity is representable', () => {
    test('internal adapter resources have source event identity', () => {
      const config = getDistillationHeartbeatConfig(process.cwd());
      const adapter = new InternalSessionLogSourceAdapter(config);

      // discoverResources is safe to call even if the dir doesn't exist
      const resources = adapter.discoverResources();
      for (const resource of resources) {
        assert.ok(resource.firstEventIdentity, 'resource has first event identity');
        assert.ok(typeof resource.firstEventIdentity!.eventId === 'string');
        assert.ok(typeof resource.firstEventIdentity!.position === 'number');
      }
    });

    test('fixture adapter resources have source event identity', () => {
      const fixtureFile = path.join(os.tmpdir(), 'xiaoba-identity-test', 'chat', 'f.jsonl');
      const [delivery, acceptance] = deliveryPair();
      const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);
      const fixture = new FixtureSessionLogSourceAdapter([unit]);

      const resources = fixture.discoverResources();
      assert.equal(resources.length, 1);
      assert.ok(resources[0].firstEventIdentity, 'fixture resource has event identity');
      assert.ok(typeof resources[0].firstEventIdentity!.eventId === 'string');
      assert.ok(typeof resources[0].firstEventIdentity!.position === 'number');

      // Cleanup
      fs.rmSync(path.join(os.tmpdir(), 'xiaoba-identity-test'), { recursive: true, force: true });
    });
  });

  describe('AC6: Scheduler and runtime compatibility', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('existing heartbeat scheduler behavior is compatible with source-neutral discovery', async () => {
      const [delivery, acceptance] = deliveryPair();
      writeLog(env.logFile, [delivery, acceptance]);

      const runtimeLearning = createRuntimeLearning(env);

      // Multiple discovery wakes (startup + scheduled) should be compatible
      const result1 = await runtimeLearning.wake('startup');
      assert.equal(result1.discovery.unitsProcessed, 1);

      const result2 = await runtimeLearning.wake('scheduled');
      assert.equal(result2.discovery.unitsProcessed, 0);

      // Heartbeat record is maintained
      const record = runtimeLearning.loadHeartbeatRecord();
      assert.ok(record.runCount >= 2, 'heartbeat record has multiple runs');
    });

    test('getSessionLogSources() returns configured adapters', () => {
      const runtimeLearning = createRuntimeLearning(env);
      const sources = runtimeLearning.getSessionLogSources();
      assert.ok(sources.length >= 1, 'at least one source adapter');
      assert.equal(sources[0].identity.sourceId, 'internal-xiaoba');
    });
  });

  describe('Issue #76 — External continuous Source Work Lane', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    // -----------------------------------------------------------------------
    // External cursor state persistence
    // -----------------------------------------------------------------------

    describe('External cursor state persistence', () => {
      test('emptyExternalCursorState returns valid state', () => {
        const state = emptyExternalCursorState();
        assert.equal(state.schemaVersion, 3);
        assert.deepEqual(state.cursors, {});
        assert.deepEqual(state.processedEventIds, {});
        assert.deepEqual(state.processedEventFingerprints, {});
        assert.equal(state.activation, null);
        assert.equal(state.discovery, null);
        assert.ok(typeof state.updatedAt === 'string');
      });

      test('load/save round-trip preserves cursor state', () => {
        const storePath = path.join(env.root, 'data', 'external-cursor-state.json');

        const original = emptyExternalCursorState();
        original.cursors['external-pi'] = {
          cursor: { resourceRef: 'pi://conversation/1', position: 5, processedCount: 3 },
          sourceIdentity: {
            sourceId: 'external-pi',
            label: 'External Source (pi)',
            category: 'external',
            provider: 'pi',
            reader: 'xurl',
          },
          updatedAt: new Date().toISOString(),
          lastStatus: 'stable',
        };
        original.processedEventIds['pi://conv/1/event-1'] = 'hash-a';
        original.processedEventFingerprints['pi::event-1'] = 'rev-a::hash-a';
        original.processedEventIds['pi://conv/1/event-2'] = 'hash-b';
        original.activation = {
          initializedAt: new Date().toISOString(),
          mode: 'future-only-resource-baseline',
          watermarkPosition: 5,
          initialDiscoveryCompleted: true,
        };
        original.discovery = {
          nextPageToken: 'page-2',
          nextResourceIndex: 1,
          updatedAt: new Date().toISOString(),
        };

        saveExternalCursorState(storePath, original);
        const loaded = loadExternalCursorState(storePath);

        assert.equal(loaded.schemaVersion, 3);
        assert.ok(loaded.cursors['external-pi']);
        assert.equal(loaded.cursors['external-pi'].cursor.position, 5);
        assert.equal(loaded.processedEventIds['pi://conv/1/event-1'], 'hash-a');
        assert.equal(loaded.processedEventFingerprints['pi::event-1'], 'rev-a::hash-a');
        assert.equal(loaded.activation?.watermarkPosition, 5);
        assert.equal(loaded.discovery?.nextPageToken, 'page-2');
      });

      test('load from missing path returns empty state', () => {
        const storePath = path.join(env.root, 'nonexistent', 'state.json');
        const state = loadExternalCursorState(storePath);
        assert.deepEqual(state.cursors, {});
        assert.deepEqual(state.processedEventIds, {});
      });

      test('load from corrupt file fails closed', () => {
        const storePath = path.join(env.root, 'data', 'corrupt-state.json');
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, 'not valid json', 'utf-8');

        assert.throws(() => loadExternalCursorState(storePath), /corrupt/);
      });
    });

    // -----------------------------------------------------------------------
    // FixtureExternalSourceReader
    // -----------------------------------------------------------------------

    describe('FixtureExternalSourceReader', () => {
      test('fresh enablement emits no resources under future-only policy', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader(
          [unit, null, unit],
          { sourceId: 'test-fixture', provider: 'test' },
        );

        const resources = reader.discoverResources(null);
        assert.equal(resources.length, 0);
      });

      test('cursor-based discovery filters processed resources', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader(
          [unit, unit, unit],
          { sourceId: 'test-fixture', provider: 'test' },
        );

        // Cursor at position 1: resource at position 0 was acknowledged,
        // resource at position 1 is the next unprocessed resource.
        const cursor: SourceCursor = {
          resourceRef: 'test',
          position: 1,
          processedCount: 1,
        };
        const resources = reader.discoverResources(cursor);
        assert.equal(resources.length, 2, 'resources at positions 1 and 2');
        assert.equal(resources[0].firstEventIdentity!.position, 1);
        assert.equal(resources[1].firstEventIdentity!.position, 2);
      });

      test('pending (null) unit returns pending status on read', () => {
        const reader = new FixtureExternalSourceReader(
          [null],
          { sourceId: 'test-fixture', provider: 'test' },
        );

        const resources = reader.discoverResources(null);
        assert.equal(resources.length, 0, 'pending unit filtered out');
      });

      test('stable unit read returns event identity', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader(
          [unit],
          { sourceId: 'test-fixture', provider: 'test' },
        );

        const resources = reader.discoverResources({ resourceRef: 'test', position: -1, processedCount: 0 });
        assert.equal(resources.length, 1);

        const cursor: SourceCursor = {
          resourceRef: resources[0].resourceRef,
          position: -1,
          processedCount: 0,
        };
        const result = reader.read(resources[0], cursor);
        assert.equal(result.status, 'stable');
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].eventId, resources[0].firstEventIdentity!.eventId);
        assert.equal(result.exhausted, true);
        assert.equal(result.newPosition, 1);
      });
    });

    // -----------------------------------------------------------------------
    // ExternalSessionLogSourceAdapter with FixtureExternalSourceReader
    // -----------------------------------------------------------------------

    describe('ExternalSessionLogSourceAdapter with reader', () => {
      test('multi-event stable batches expose every unit and acknowledge every identity', () => {
        const fixtureFile1 = path.join(env.root, 'fixture', 'chat', 'batch-1.jsonl');
        const fixtureFile2 = path.join(env.root, 'fixture', 'chat', 'batch-2.jsonl');
        const [delivery1, acceptance1] = deliveryPair();
        const [delivery2, acceptance2] = deliveryPair();
        const unit1 = buildDistillationUnitFromFile([delivery1, acceptance1], fixtureFile1);
        const unit2 = buildDistillationUnitFromFile([delivery2, acceptance2], fixtureFile2);
        const resource: SessionLogSourceResource = {
          resourceRef: 'fixture://batch/resource-0',
          firstEventIdentity: { eventId: 'event-1', position: 0 },
        };
        const reader: ExternalSourceReader = {
          provider: 'fixture',
          reader: 'batch-reader',
          discoverResources: () => [resource],
          read: () => ({
            events: [
              { eventId: 'event-1', position: 0, contentHash: 'hash-1', distillationUnit: unit1 },
              { eventId: 'event-2', position: 1, contentHash: 'hash-2', distillationUnit: unit2 },
            ],
            status: 'stable',
            exhausted: true,
            newPosition: 2,
          }),
        };
        const storePath = path.join(env.root, 'data', 'batch-cursor.json');
        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-batch',
          provider: 'fixture',
          reader,
          enabled: true,
        }, storePath);
        const initial = emptyExternalCursorState();
        initial.cursors['external-batch'] = {
          cursor: { resourceRef: resource.resourceRef, position: -1, processedCount: 0 },
          sourceIdentity: adapter.identity,
          updatedAt: new Date().toISOString(),
        };
        saveExternalCursorState(storePath, initial);

        const result = adapter.read(resource, { orderedResources: [resource] });

        assert.equal(result.status, 'advanced');
        assert.equal(result.distillationUnits?.length, 2);
        assert.deepEqual(result.eventIdentities?.map(identity => identity.eventId), ['event-1', 'event-2']);
        adapter.acknowledge(resource, result);
        const persisted = loadExternalCursorState(storePath);
        assert.equal(persisted.cursors['external-batch']?.cursor.position, 2);
        assert.equal(Object.keys(persisted.processedEventIds).length, 2);
      });

      test('mixed stable batches fail closed without cursor advancement', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'batch-missing-unit.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);
        const resource: SessionLogSourceResource = {
          resourceRef: 'fixture://batch/missing-unit',
          firstEventIdentity: { eventId: 'event-stable', position: 0 },
        };
        const reader: ExternalSourceReader = {
          provider: 'fixture',
          reader: 'batch-reader',
          discoverResources: () => [resource],
          read: () => ({
            events: [
              { eventId: 'event-stable', position: 0, distillationUnit: unit },
              { eventId: 'event-unconvertible', position: 1 },
            ],
            status: 'stable',
            exhausted: true,
            newPosition: 2,
          }),
        };
        const storePath = path.join(env.root, 'data', 'batch-missing-unit-cursor.json');
        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-batch-missing-unit',
          provider: 'fixture',
          reader,
          enabled: true,
        }, storePath);
        const initial = emptyExternalCursorState();
        initial.cursors['external-batch-missing-unit'] = {
          cursor: { resourceRef: resource.resourceRef, position: -1, processedCount: 0 },
          sourceIdentity: adapter.identity,
          updatedAt: new Date().toISOString(),
        };
        saveExternalCursorState(storePath, initial);

        const result = adapter.read(resource, { orderedResources: [resource] });

        assert.equal(result.status, 'failed');
        assert.equal(result.advanced, false);
        assert.equal(result.distillationUnit, null);
        assert.equal(loadExternalCursorState(storePath).cursors['external-batch-missing-unit']?.cursor.position, -1);
      });

      test('default cursor durability prefers the configured runtime data root', () => {
        const saved = {
          XIAOBA_USER_DATA_DIR: process.env.XIAOBA_USER_DATA_DIR,
          CATSCO_USER_DATA_DIR: process.env.CATSCO_USER_DATA_DIR,
          XIAOBA_ELECTRON_USER_DATA_DIR: process.env.XIAOBA_ELECTRON_USER_DATA_DIR,
          XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
        };
        try {
          delete process.env.XIAOBA_USER_DATA_DIR;
          delete process.env.CATSCO_USER_DATA_DIR;
          delete process.env.XIAOBA_ELECTRON_USER_DATA_DIR;
          process.env.XIAOBA_RUNTIME_ROOT = env.root;
          const adapter = new ExternalSessionLogSourceAdapter({
            sourceId: 'cursor-root-source',
            provider: 'cursor-root-provider',
          });
          const cursorPath = (adapter as unknown as { cursorStorePath: string }).cursorStorePath;
          assert.equal(
            cursorPath,
            path.join(env.root, 'data', 'cursor-root-provider', 'cursor-root-source.json'),
          );
          const explicitPath = path.join(env.root, 'explicit-cursor.json');
          const explicit = new ExternalSessionLogSourceAdapter({
            sourceId: 'cursor-root-source',
            provider: 'cursor-root-provider',
            cursorStorePath: explicitPath,
          });
          assert.equal((explicit as unknown as { cursorStorePath: string }).cursorStorePath, explicitPath);
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      });

      test('stable result without distillation unit is treated as hard failure', () => {
        class UnitlessReader implements ExternalSourceReader {
          readonly provider = 'fixture';
          readonly reader = 'missing-unit';
          discoverResources(): readonly SessionLogSourceResource[] {
            return [
              {
                resourceRef: 'fixture://missing-unit',
                firstEventIdentity: { eventId: 'fixture://missing-unit', position: 0 },
              },
            ];
          }
          read(): ExternalSourceReaderResult {
            return {
              events: [{
                eventId: 'fixture://missing-unit',
                position: 0,
              }],
              status: 'stable',
              exhausted: true,
              newPosition: 1,
            };
          }
        }

        const reader = new UnitlessReader();
        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-missing',
          provider: 'fixture',
          reader,
          enabled: true,
        }, path.join(env.root, 'data', 'ext-cursor-missing-unit.json'));

        assert.equal(adapter.discoverResources().length, 0, 'first enablement is metadata-only');
        const resources = adapter.discoverResources();
        assert.equal(resources.length, 1);
        const result = adapter.read(resources[0], {
          orderedResources: resources,
        });
        assert.equal(result.status, 'failed');
        assert.equal(result.advanced, false);
        assert.equal(result.distillationUnit, null);
      });

      test('enabled adapter with reader discovers resources', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader([unit], { sourceId: 'ext-test' });
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader,
          enabled: true,
        }, storePath);

        assert.equal(adapter.isEnabled(), true);
        assert.equal(adapter.identity.category, 'external');
        assert.equal(adapter.identity.provider, 'test');

        const initialState = emptyExternalCursorState();
        initialState.cursors['external-test'] = {
          cursor: {
            resourceRef: 'chat',
            position: -1,
            processedCount: 0,
          },
          sourceIdentity: {
            sourceId: 'external-test',
            category: 'external',
            provider: 'test',
            reader: 'fixture',
          },
          updatedAt: new Date().toISOString(),
        };
        saveExternalCursorState(storePath, initialState);

        const resources = adapter.discoverResources();
        assert.equal(resources.length, 1);
        assert.ok(resources[0].firstEventIdentity);
      });

      test('disabled adapter returns empty resources', () => {
        const reader = new FixtureExternalSourceReader([], { sourceId: 'ext-test' });
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader,
          enabled: false,
        }, storePath);

        assert.equal(adapter.isEnabled(), false);
        assert.equal(adapter.discoverResources().length, 0);
      });

      test('adapter without reader returns empty resources (no-op seam)', () => {
        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-pi',
          provider: 'pi',
          enabled: true,
        });

        assert.equal(adapter.isEnabled(), true);
        assert.equal(adapter.discoverResources().length, 0);
      });

      test('read returns advanced status and tracks cursor', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader([unit], { sourceId: 'ext-test' });
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader,
          enabled: true,
        }, storePath);

        const initialState = emptyExternalCursorState();
        initialState.cursors['external-test'] = {
          cursor: {
            resourceRef: 'chat',
            position: -1,
            processedCount: 0,
          },
          sourceIdentity: {
            sourceId: 'external-test',
            category: 'external',
            provider: 'test',
            reader: 'fixture',
          },
          updatedAt: new Date().toISOString(),
        };
        saveExternalCursorState(storePath, initialState);

        const resources = adapter.discoverResources();
        assert.equal(resources.length, 1);

        const readCtx: SessionLogSourceReadContext = { orderedResources: resources };
        const result = adapter.read(resources[0], readCtx);

        // Returns advanced status with a materialized distillation unit from fixture reader.
        assert.equal(result.status, 'advanced');
        assert.equal(result.advanced, true);
        assert.ok(result.distillationUnit);
        assert.ok(result.newCursor.position > 0);

        // Acknowledge to persist cursor
        adapter.acknowledge(resources[0], result);

        // Verify cursor was persisted
        const stored = loadExternalCursorState(storePath);
        assert.ok(stored.cursors['external-test']);
        assert.equal(stored.cursors['external-test'].cursor.position, result.newCursor.position);
      });

      test('cursor survives adapter reconstruction (simulated restart)', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader([unit, unit], { sourceId: 'ext-test' });
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        // First adapter: discover and process first resource
        const adapter1 = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader,
          enabled: true,
        }, storePath);

        const initialState = emptyExternalCursorState();
        initialState.cursors['external-test'] = {
          cursor: {
            resourceRef: 'chat',
            position: -1,
            processedCount: 0,
          },
          sourceIdentity: {
            sourceId: 'external-test',
            category: 'external',
            provider: 'test',
            reader: 'fixture',
          },
          updatedAt: new Date().toISOString(),
        };
        saveExternalCursorState(storePath, initialState);

        const resources1 = adapter1.discoverResources();
        assert.equal(resources1.length, 2);

        const readCtx: SessionLogSourceReadContext = { orderedResources: resources1 };
        const result1 = adapter1.read(resources1[0], readCtx);
        adapter1.acknowledge(resources1[0], result1);

        // Second adapter: simulate restart with same store path
        const reader2 = new FixtureExternalSourceReader([unit, unit], { sourceId: 'ext-test' });
        const adapter2 = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader: reader2,
          enabled: true,
        }, storePath);

        const resources2 = adapter2.discoverResources();
        assert.ok(resources2.length >= 1, 'restart still exposes known resources for bounded continuation');
        assert.ok(resources2.some(resource => resource.firstEventIdentity!.position === 1));
        const persisted = loadExternalCursorState(storePath);
        assert.equal(persisted.cursors[resources1[0].resourceRef]?.cursor.position, result1.newCursor.position);
      });

      test('exact dedup: same eventId + same contentHash skipped', () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader([unit], { sourceId: 'ext-test' });
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader,
          enabled: true,
        }, storePath);

        const initialState = emptyExternalCursorState();
        initialState.cursors['external-test'] = {
          cursor: {
            resourceRef: 'chat',
            position: -1,
            processedCount: 0,
          },
          sourceIdentity: {
            sourceId: 'external-test',
            category: 'external',
            provider: 'test',
            reader: 'fixture',
          },
          updatedAt: new Date().toISOString(),
        };
        saveExternalCursorState(storePath, initialState);

        const seededResources = adapter.discoverResources();
        const readCtx: SessionLogSourceReadContext = { orderedResources: seededResources };

        // First read + acknowledge
        const result1 = adapter.read(seededResources[0], readCtx);
        adapter.acknowledge(seededResources[0], result1);

        // Read the same resource again — should show advanced status
        // because the reader returns it again but the adapter filters via cursor
        const result2 = adapter.read(seededResources[0], readCtx);
        assert.equal(result2.status, 'exhausted', 'resource exhausted after ack');
      });

      test('stability gate: pending range does not advance cursor', () => {
        const reader = new FixtureExternalSourceReader(
          [null],
          { sourceId: 'ext-test', provider: 'test' },
        );
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        const adapter = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader,
          enabled: true,
        }, storePath);

        // Fresh enablement: pending units are not discovered
        const resources = adapter.discoverResources();
        assert.equal(resources.length, 0, 'pending units not discovered');
      });

      test('source identity independent per provider', () => {
        const storePath1 = path.join(env.root, 'data', 'ext-cursor-1.json');
        const storePath2 = path.join(env.root, 'data', 'ext-cursor-2.json');

        const adapter1 = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-pi',
          provider: 'pi',
          enabled: true,
        }, storePath1);

        const adapter2 = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-codex',
          provider: 'codex',
          enabled: true,
        }, storePath2);

        assert.notEqual(adapter1.identity.sourceId, adapter2.identity.sourceId);
        assert.notEqual(adapter1.identity.provider, adapter2.identity.provider);
        assert.equal(adapter1.identity.category, 'external');
        assert.equal(adapter2.identity.category, 'external');

        // Each provider has its own cursor store path
        assert.notEqual(storePath1, storePath2);
      });
    });

    // -----------------------------------------------------------------------
    // Fixture adapter with external-like identity through wake()
    // -----------------------------------------------------------------------

    describe('External identity through wake() path', () => {
      test('fixture adapter with external identity feeds wake()', async () => {
        const fixtureFile = path.join(env.root, 'fixture', 'chat', 'f.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        // Use FixtureSessionLogSourceAdapter with external category
        const fixture = new FixtureSessionLogSourceAdapter([unit], {
          identity: {
            sourceId: 'external-fixture',
            category: 'external',
            provider: 'fixture',
            reader: 'fixture',
          },
        });

        const runtimeLearning = createRuntimeLearning(env, [fixture]);
        const result = await runtimeLearning.wake('startup');

        assert.equal(result.ran, true);
        assert.equal(result.discovery.scanned, true);
        assert.equal(result.discovery.sources.length, 1);

        const report = result.discovery.sources[0];
        assert.equal(report.sourceId, 'external-fixture');
        assert.equal(report.category, 'external');
        assert.equal(report.enabled, true);
        assert.equal(report.resourcesDiscovered, 1);
        assert.equal(report.unitsProcessed, 1);
        assert.ok(result.ingestion.admittedEpisodes >= 1, 'episodes admitted from external-fixture');
      });

      test('external and internal sources coexist with independent reports', async () => {
        const [delivery, acceptance] = deliveryPair();
        writeLog(env.logFile, [delivery, acceptance]);

        const fixtureFile = path.join(env.root, 'fixture', 'ext', 'e.jsonl');
        const [extDelivery, extAcceptance] = deliveryPair();
        const extUnit = buildDistillationUnitFromFile(
          [extDelivery, extAcceptance],
          fixtureFile,
        );

        const fixture = new FixtureSessionLogSourceAdapter([extUnit], {
          identity: {
            sourceId: 'external-fixture',
            category: 'external',
            provider: 'fixture',
            reader: 'fixture',
          },
        });

        const internal = new InternalSessionLogSourceAdapter(
          getDistillationHeartbeatConfig(env.root),
        );

        const runtimeLearning = createRuntimeLearning(env, [internal, fixture]);
        const result = await runtimeLearning.wake('startup');

        assert.equal(result.discovery.sources.length, 2);

        const internalReport = result.discovery.sources.find(s => s.category === 'internal');
        const externalReport = result.discovery.sources.find(s => s.category === 'external');

        assert.ok(internalReport, 'internal report exists');
        assert.ok(externalReport, 'external report exists');
        assert.equal(internalReport!.sourceId, 'internal-xiaoba');
        assert.equal(externalReport!.sourceId, 'external-fixture');
        assert.equal(internalReport!.enabled, true);
        assert.equal(externalReport!.enabled, true);
        assert.ok(internalReport!.unitsProcessed >= 1);
        assert.equal(externalReport!.unitsProcessed, 1);
        assert.ok(result.ingestion.admittedEpisodes >= 2, 'episodes admitted from both sources');
      });

      test('external source with external adapter reports in wake()', async () => {
        const fixtureFile = path.join(env.root, 'fixture', 'ext', 'e.jsonl');
        const [delivery, acceptance] = deliveryPair();
        const unit = buildDistillationUnitFromFile([delivery, acceptance], fixtureFile);

        const reader = new FixtureExternalSourceReader([unit], { sourceId: 'ext-test' });
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        const external = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-test',
          provider: 'test',
          reader,
          enabled: true,
        }, storePath);

        const runtimeLearning = createRuntimeLearning(env, [
          new InternalSessionLogSourceAdapter(getDistillationHeartbeatConfig(env.root)),
          external,
        ]);

        const result = await runtimeLearning.wake('startup');

        // Both sources should be in the report
        assert.equal(result.discovery.sources.length, 2);

        const externalReport = result.discovery.sources.find(s => s.sourceId === 'external-test');
        assert.ok(externalReport, 'external source report exists');
        assert.equal(externalReport!.enabled, true);
        assert.equal(externalReport!.category, 'external');
        assert.equal(externalReport!.resourcesDiscovered, 0);
        assert.equal(externalReport!.unitsProcessed, 0);
      });

      test('disabled external source with adapter reports as disabled', async () => {
        const reader = new FixtureExternalSourceReader([], { sourceId: 'ext-test' });
        const storePath = path.join(env.root, 'data', 'ext-cursor.json');

        const external = new ExternalSessionLogSourceAdapter({
          sourceId: 'external-disabled',
          provider: 'test',
          reader,
          enabled: false,
        }, storePath);

        const runtimeLearning = createRuntimeLearning(env, [external]);
        const result = await runtimeLearning.wake('startup');

        const report = result.discovery.sources.find(s => s.sourceId === 'external-disabled');
        assert.ok(report, 'disabled external source report exists');
        assert.equal(report!.enabled, false);
        assert.equal(report!.resourcesDiscovered, 0);
        assert.equal(report!.unitsProcessed, 0);
      });
    });
  });
});

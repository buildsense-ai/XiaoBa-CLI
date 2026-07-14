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
  SessionLogSourceAdapter,
  SessionLogSourceIdentity,
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
});
/**
 * Focused tests for RuntimeLearning wake-level discovery quotas (issue #51).
 *
 * Proves that runDiscovery() bounds resources examined, candidates admitted,
 * and wall-clock time across all sources, deferring remaining resources to
 * the next wake WITHOUT falsely acknowledging their cursors, so a large
 * multi-source scan cannot starve the overdue settlement/review stages.
 *
 * Uses a fake SessionLogSourceAdapter and a stub EvidenceIngestor so the caps
 * can be exercised deterministically through the public wake('startup') path.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import type {
  SessionLogSourceAdapter,
  SessionLogSourceIdentity,
  SessionLogSourceReadContext,
  SessionLogSourceReadResult,
  SessionLogSourceResource,
} from '../src/utils/session-log-source';
import type { DistillationUnit } from '../src/utils/distillation-unit';
import type { EvidenceIngestor, EvidenceIngestionResult } from '../src/utils/evidence-ingestor';

// ---------------------------------------------------------------------------
// Fake adapter: N resources, each yields either an idle advance or a unit.
// ---------------------------------------------------------------------------

interface FakeAdapterOptions {
  sourceId: string;
  resourceCount: number;
  /** When true, read() returns a distillation unit (triggers ingestion); else idle advance. */
  yieldUnits: boolean;
}

class FakeSessionLogSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity = {
    sourceId: 'fake',
    label: 'Fake Source',
    category: 'internal',
    provider: 'fake',
    reader: 'fake',
  };
  readonly resources: SessionLogSourceResource[] = [];
  readonly acknowledged: string[] = [];
  private readonly opts: FakeAdapterOptions;

  constructor(opts: FakeAdapterOptions) {
    this.opts = opts;
    this.identity = { ...this.identity, sourceId: opts.sourceId };
    for (let i = 0; i < opts.resourceCount; i++) {
      this.resources.push({ resourceRef: `${opts.sourceId}#res-${i}` });
    }
  }

  isEnabled(): boolean {
    return true;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    return this.resources;
  }

  read(resource: SessionLogSourceResource, _ctx: SessionLogSourceReadContext): SessionLogSourceReadResult {
    if (!this.opts.yieldUnits) {
      return {
        distillationUnit: null,
        advanced: true,
        status: 'idle',
        newCursor: { resourceRef: resource.resourceRef, position: 1, processedCount: 0 },
      };
    }
    const unit: DistillationUnit = {
      filePath: resource.resourceRef,
      newTurns: [],
      continuityTurns: [],
      byteRange: { start: 0, end: 1 },
      generatedAt: new Date().toISOString(),
    };
    return {
      distillationUnit: unit,
      advanced: true,
      status: 'advanced',
      newCursor: { resourceRef: resource.resourceRef, position: 1, processedCount: 1 },
    };
  }

  acknowledge(resource: SessionLogSourceResource, _result: SessionLogSourceReadResult): void {
    this.acknowledged.push(resource.resourceRef);
  }

  markFailed(_resource: SessionLogSourceResource, _error: unknown): void {}
}

// ---------------------------------------------------------------------------
// Stub EvidenceIngestor: admits a fixed number of episodes per unit.
// ---------------------------------------------------------------------------

class StubEvidenceIngestor {
  admittedPerUnit: number;
  constructor(admittedPerUnit: number) {
    this.admittedPerUnit = admittedPerUnit;
  }
  ingest(_unit: DistillationUnit): EvidenceIngestionResult {
    const ids = Array.from({ length: this.admittedPerUnit }, (_, i) => `ep-${i}`);
    return {
      admittedEpisodeIds: ids,
      contradictionSignalIds: [],
      state: { schemaVersion: 2, episodes: {} },
    } as EvidenceIngestionResult;
  }
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function setupEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-rl-quotas-'));
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'registry.json');
  const auditPath = path.join(root, 'data', 'audit.jsonl');
  const journalPath = path.join(root, 'data', 'journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'ledger.jsonl');
  const skillsRoot = path.join(root, 'skills');
  const outputDir = path.join(skillsRoot, 'generated-distilled');

  fs.mkdirSync(path.dirname(episodeStorePath), { recursive: true });

  const savedEnv = { ...process.env };
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  process.env.XIAOBA_SKILL_EVOLUTION_REASSESSMENT_MANIFEST_FILE = reassessmentManifestPath;
  delete process.env.XIAOBA_ROLE;

  const episodeStore = new LearningEpisodeStore(episodeStorePath);
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
    authorFixture: ({ bundle }) => ({
      body: 'guidance',
      envelope: {
        decision: 'create_current_skill' as const,
        routingName: 'test-cap',
        description: 'test',
        referencedSkills: [],
        evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(r => r.ref),
      },
    }),
    verifierFixture: () => ({
      decision: 'accept' as const,
      transition: 'create_current_skill' as const,
      issues: [],
      rationale: 'ok',
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
    root,
    episodeStore,
    skillEvolution,
    curator,
    planner,
    restore: () => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeLearning wake-level discovery quotas', () => {
  test('resource cap defers remaining resources without falsely acknowledging cursors', async () => {
    const env = setupEnv();
    try {
      const adapter = new FakeSessionLogSourceAdapter({ sourceId: 'src-a', resourceCount: 5, yieldUnits: false });
      const ingestor = new StubEvidenceIngestor(0) as unknown as EvidenceIngestor;

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: ingestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [adapter],
        discoveryQuotas: { maxResourcesPerWake: 2, maxAdmittedEpisodesPerWake: 1000, maxDiscoveryMs: 60_000 },
      });

      const result = await runtimeLearning.wake('startup');

      assert.equal(result.ran, true);
      assert.equal(result.discovery.scanned, true);
      // Only 2 of 5 resources were examined/acknowledged; 3 deferred.
      assert.equal(result.discovery.advancedFiles, 2, 'only capped resources advanced');
      assert.equal(adapter.acknowledged.length, 2, 'only examined resources are acknowledged');
      assert.deepEqual(adapter.acknowledged, ['src-a#res-0', 'src-a#res-1']);
    } finally {
      env.restore();
      env.teardown();
    }
  });

  test('candidate cap stops admission once the episode quota is reached', async () => {
    const env = setupEnv();
    try {
      const adapter = new FakeSessionLogSourceAdapter({ sourceId: 'src-b', resourceCount: 6, yieldUnits: true });
      // Each unit admits 1 episode; cap at 2 episodes → only 2 resources ingested.
      const ingestor = new StubEvidenceIngestor(1) as unknown as EvidenceIngestor;

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: ingestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [adapter],
        discoveryQuotas: { maxResourcesPerWake: 1000, maxAdmittedEpisodesPerWake: 2, maxDiscoveryMs: 60_000 },
      });

      const result = await runtimeLearning.wake('startup');

      assert.equal(result.discovery.unitsProcessed, 2, 'only 2 units processed before candidate cap');
      assert.equal(result.ingestion.admittedEpisodes, 2, 'candidate admission capped at 2');
      assert.equal(adapter.acknowledged.length, 2, 'remaining resources not acknowledged');
    } finally {
      env.restore();
      env.teardown();
    }
  });

  test('time cap defers remaining resources once the discovery budget elapses', async () => {
    const env = setupEnv();
    try {
      const adapter = new FakeSessionLogSourceAdapter({ sourceId: 'src-c', resourceCount: 5, yieldUnits: false });
      const ingestor = new StubEvidenceIngestor(0) as unknown as EvidenceIngestor;

      // Injectable clock that advances 50ms per call so the time cap (100ms)
      // trips after a couple of resources.
      let t = 1_000_000;
      const clock = () => { t += 50; return new Date(t); };

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: ingestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [adapter],
        discoveryQuotas: { maxResourcesPerWake: 1000, maxAdmittedEpisodesPerWake: 1000, maxDiscoveryMs: 100 },
        clock,
      });

      const result = await runtimeLearning.wake('startup');

      assert.ok(result.discovery.advancedFiles < 5, 'time cap defers some resources');
      assert.ok(adapter.acknowledged.length < 5, 'not all resources acknowledged under time cap');
      assert.ok(adapter.acknowledged.length >= 1, 'at least one resource processed before the cap');
    } finally {
      env.restore();
      env.teardown();
    }
  });
});
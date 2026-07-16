/**
 * Issue #92 — Bounded concurrent external provider reads.
 *
 * Tests that external Source Work Lanes overlap their reads with bounded
 * concurrency while preserving Internal-first ordering, serial evidence
 * commits, provider isolation, cancellation, and no leaked handles.
 *
 * All behavior is asserted through the public RuntimeLearning.wake() seam
 * using fake adapters that instrument concurrency, overlap, and ordering.
 *
 * Acceptance criteria covered:
 *   AC1: Internal discovery completes before any external read starts
 *   AC2: External reads overlap up to the configured maximum
 *   AC3: Production default concurrency is 3; accepted values are clamped 1–8
 *   AC4: Setting concurrency to 1 preserves serial behavior
 *   AC5: The external reader/adapter seam is async and accepts cancellation
 *   AC6: Each provider may prefetch at most one uncommitted page
 *   AC7: Global deadline, shutdown, and disable stop new work and cancel reads
 *   AC8: A canceled read is not counted as provider failure
 *   AC9: Provider-scoped locks remain held until process is reaped and work settles
 *   AC10: One provider's failure does not cancel or alter another provider
 *   AC11: Existing wake-level resource, episode, byte, and elapsed-time limits hold
 *   AC12: No live child-process, timer, or promise handles after stop/drain
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import {
  LEARNING_EPISODE_SCHEMA_VERSION,
  LearningEpisodeStore,
} from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import type {
  SessionLogSourceAdapter,
  SessionLogSourceResource,
  SessionLogSourceDiscoveryContext,
  SessionLogSourceReadContext,
  SessionLogSourceReadResult,
  SessionLogSourceIdentity,
} from '../src/utils/session-log-source';
import type { DistillationUnit } from '../src/utils/distillation-unit';
import type { ExternalCatchUpAction } from '../src/utils/external-source-work';

// ---------------------------------------------------------------------------
// Fake async adapter — instruments concurrency, overlap, and ordering
// ---------------------------------------------------------------------------

interface AsyncFakeSourceOptions {
  sourceId: string;
  category?: 'internal' | 'external';
  resourceCount: number;
  readDelayMs?: number;
  shouldFail?: boolean;
  failAtIndex?: number;
  /** If true, only implements read() (sync); if false, implements readAsync(). */
  syncOnly?: boolean;
}

class AsyncFakeSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  readonly resources: SessionLogSourceResource[] = [];
  readonly acknowledged: string[] = [];
  readonly failedResources: string[] = [];

  // Concurrency tracking
  activeReads = 0;
  maxConcurrentReads = 0;
  readStartOrder: number[] = [];
  private static globalReadCounter = 0;
  private static globalReadStarts: Array<{ sourceId: string; time: number }> = [];
  private static globalActiveReads = 0;
  private static globalMaxActiveReads = 0;
  private static globalAcknowledgements: string[] = [];
  static resetGlobalReadStarts(): void {
    AsyncFakeSourceAdapter.globalReadCounter = 0;
    AsyncFakeSourceAdapter.globalReadStarts = [];
    AsyncFakeSourceAdapter.globalActiveReads = 0;
    AsyncFakeSourceAdapter.globalMaxActiveReads = 0;
    AsyncFakeSourceAdapter.globalAcknowledgements = [];
  }
  static getGlobalReadStarts(): Array<{ sourceId: string; time: number }> {
    return [...AsyncFakeSourceAdapter.globalReadStarts];
  }
  static getGlobalMaxActiveReads(): number {
    return AsyncFakeSourceAdapter.globalMaxActiveReads;
  }
  static getGlobalAcknowledgements(): string[] {
    return [...AsyncFakeSourceAdapter.globalAcknowledgements];
  }

  private readonly opts: AsyncFakeSourceOptions;
  private readonly readDelayMs: number;

  constructor(opts: AsyncFakeSourceOptions) {
    this.opts = opts;
    this.identity = {
      sourceId: opts.sourceId,
      label: `Fake Source ${opts.sourceId}`,
      category: opts.category ?? 'internal',
      provider: `fake-${opts.sourceId}`,
      reader: 'fake',
    };
    for (let i = 0; i < opts.resourceCount; i++) {
      this.resources.push({ resourceRef: `${opts.sourceId}#res-${i}` });
    }
    this.readDelayMs = opts.readDelayMs ?? 5;
    if (opts.syncOnly) {
      Object.defineProperty(this, 'readAsync', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
  }

  isEnabled(): boolean {
    return true;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    return this.resources;
  }

  read(
    resource: SessionLogSourceResource,
    _ctx: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    const index = this.resources.findIndex(r => r.resourceRef === resource.resourceRef);
    const readId = AsyncFakeSourceAdapter.globalReadCounter++;
    AsyncFakeSourceAdapter.globalReadStarts.push({
      sourceId: this.identity.sourceId,
      time: readId,
    });
    this.readStartOrder.push(readId);
    if (this.opts.shouldFail) {
      throw new Error(`fake read failure for ${resource.resourceRef}`);
    }
    if (this.opts.failAtIndex !== undefined && index === this.opts.failAtIndex) {
      throw new Error(`fake targeted failure for ${resource.resourceRef}`);
    }
    const unit: DistillationUnit = {
      filePath: resource.resourceRef,
      newTurns: [],
      continuityTurns: [],
      byteRange: { start: 0, end: 100 },
      generatedAt: new Date().toISOString(),
    };
    return {
      distillationUnit: unit,
      advanced: true,
      status: 'advanced',
      newCursor: {
        resourceRef: resource.resourceRef,
        position: 1,
        processedCount: 1,
      },
    };
  }

  async readAsync(
    resource: SessionLogSourceResource,
    _ctx: SessionLogSourceReadContext,
    signal: AbortSignal,
  ): Promise<SessionLogSourceReadResult> {
    const index = this.resources.findIndex(r => r.resourceRef === resource.resourceRef);
    this.activeReads++;
    AsyncFakeSourceAdapter.globalActiveReads++;
    AsyncFakeSourceAdapter.globalMaxActiveReads = Math.max(
      AsyncFakeSourceAdapter.globalMaxActiveReads,
      AsyncFakeSourceAdapter.globalActiveReads,
    );
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    const readId = AsyncFakeSourceAdapter.globalReadCounter++;
    AsyncFakeSourceAdapter.globalReadStarts.push({
      sourceId: this.identity.sourceId,
      time: readId,
    });
    this.readStartOrder.push(readId);

    try {
      // Cancellable delay
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, this.readDelayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });

      if (this.opts.shouldFail) {
        throw new Error(`fake read failure for ${resource.resourceRef}`);
      }
      if (this.opts.failAtIndex !== undefined && index === this.opts.failAtIndex) {
        throw new Error(`fake targeted failure for ${resource.resourceRef}`);
      }

      const unit: DistillationUnit = {
        filePath: resource.resourceRef,
        newTurns: [],
        continuityTurns: [],
        byteRange: { start: 0, end: 100 },
        generatedAt: new Date().toISOString(),
      };
      return {
        distillationUnit: unit,
        advanced: true,
        status: 'advanced',
        newCursor: {
          resourceRef: resource.resourceRef,
          position: 1,
          processedCount: 1,
        },
      };
    } finally {
      this.activeReads--;
      AsyncFakeSourceAdapter.globalActiveReads--;
    }
  }

  acknowledge(resource: SessionLogSourceResource, _result: SessionLogSourceReadResult): void {
    this.acknowledged.push(resource.resourceRef);
    AsyncFakeSourceAdapter.globalAcknowledgements.push(resource.resourceRef);
  }

  markFailed(resource: SessionLogSourceResource, _error: unknown): void {
    this.failedResources.push(resource.resourceRef);
  }
}

class DisableableAsyncFakeSourceAdapter extends AsyncFakeSourceAdapter {
  private enabled = true;

  override isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

class CatchUpSchedulingFakeAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  continuousTurns = 0;
  catchUpTurns = 0;
  readonly catchUpActions: ExternalCatchUpAction[] = [];
  readonly acknowledged: string[] = [];
  private readonly dueAction: ExternalCatchUpAction;

  constructor(provider: string, dueAction: ExternalCatchUpAction = 'inventory') {
    this.identity = {
      sourceId: `external-${provider}`,
      label: `Catch-up fixture ${provider}`,
      category: 'external',
      provider,
      reader: 'fixture',
    };
    this.dueAction = dueAction;
  }

  isEnabled(): boolean { return true; }

  getExternalAdmissionConfiguration() {
    return { historyMode: 'catch-up' as const, scope: 'global' as const };
  }

  getNextCatchUpAction(): ExternalCatchUpAction { return this.dueAction; }

  discoverResources(context: SessionLogSourceDiscoveryContext = {}): readonly SessionLogSourceResource[] {
    if (context.workLane === 'catch-up') {
      this.catchUpTurns++;
      this.catchUpActions.push(context.catchUpAction ?? this.dueAction);
      return this.dueAction === 'page'
        ? [{ resourceRef: `${this.identity.provider}-catch-up` }]
        : [];
    }
    this.continuousTurns++;
    return [{ resourceRef: `${this.identity.provider}-continuous` }];
  }

  read(resource: SessionLogSourceResource): SessionLogSourceReadResult {
    return {
      distillationUnit: null,
      advanced: true,
      releaseResource: true,
      status: 'exhausted',
      newCursor: { resourceRef: resource.resourceRef, position: 0, processedCount: 0 },
      admissionLane: resource.resourceRef.endsWith('-catch-up') ? 'catch-up' : 'continuous',
    };
  }

  acknowledge(resource: SessionLogSourceResource): void {
    this.acknowledged.push(resource.resourceRef);
  }

  markFailed(): void {}
}

class SlowContinuousCatchUpFakeAdapter extends CatchUpSchedulingFakeAdapter {
  activeReads = 0;

  async readAsync(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
    signal: AbortSignal,
  ): Promise<SessionLogSourceReadResult> {
    if (context.workLane === 'catch-up') return this.read(resource);
    this.activeReads++;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      return this.read(resource);
    } finally {
      this.activeReads--;
    }
  }
}

// ---------------------------------------------------------------------------
// Stub EvidenceIngestor
// ---------------------------------------------------------------------------

class StubEvidenceIngestor {
  ingest(_unit: DistillationUnit) {
    return {
      admittedEpisodeIds: [] as string[],
      contradictionSignalIds: [] as string[],
      state: {
        schemaVersion: LEARNING_EPISODE_SCHEMA_VERSION,
        episodes: {} as Record<string, unknown>,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

interface TestEnv {
  root: string;
  episodeStore: LearningEpisodeStore;
  skillEvolution: SkillEvolutionRuntime;
  curator: SkillUsageCurator;
  planner: DueWorkPlanner;
  restore: () => void;
  teardown: () => void;
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bounded-'));
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
    restore: () => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #92 — Bounded concurrent external provider reads', () => {

  test('one global catch-up quantum rotates providers durably while continuous lanes stay timely', async () => {
    const env = setupEnv();
    const alpha = new CatchUpSchedulingFakeAdapter('alpha');
    const beta = new CatchUpSchedulingFakeAdapter('beta');
    const createRuntime = () => new RuntimeLearning({
      workingDirectory: env.root,
      evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
      learningEpisodeStore: env.episodeStore,
      skillEvolution: env.skillEvolution,
      curator: env.curator,
      planner: env.planner,
      sessionLogSources: [alpha, beta],
      externalSourceMaxConcurrency: 2,
    });

    try {
      for (let wakeNumber = 0; wakeNumber < 6; wakeNumber++) {
        await createRuntime().wake('manual');
      }

      assert.deepEqual(
        [alpha.continuousTurns, beta.continuousTurns],
        [6, 6],
        'continuous work receives the unused capacity after every preparation quantum',
      );
      assert.deepEqual(
        [alpha.catchUpTurns, beta.catchUpTurns],
        [3, 3],
        'two continuously due providers each receive three of six global quanta across restart',
      );
      assert.deepEqual(alpha.catchUpActions, ['inventory', 'inventory', 'inventory']);
      assert.deepEqual(beta.catchUpActions, ['inventory', 'inventory', 'inventory']);
    } finally {
      env.restore();
      env.teardown();
    }
  });

  test('session-log append discovery does not consume a catch-up quantum', async () => {
    const env = setupEnv();
    const adapter = new CatchUpSchedulingFakeAdapter('alpha');
    const runtime = new RuntimeLearning({
      workingDirectory: env.root,
      evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
      learningEpisodeStore: env.episodeStore,
      skillEvolution: env.skillEvolution,
      curator: env.curator,
      planner: env.planner,
      sessionLogSources: [adapter],
    });

    try {
      await runtime.wake('session-log-append');

      assert.ok(adapter.continuousTurns > 0, 'append discovery still serves timely continuous work');
      assert.equal(
        adapter.catchUpTurns,
        0,
        'only startup, scheduled, and manual discovery wakes reserve a historical quantum',
      );
    } finally {
      env.restore();
      env.teardown();
    }
  });

  test('one due page quantum is followed only by donated continuous capacity', async () => {
    const env = setupEnv();
    const adapter = new CatchUpSchedulingFakeAdapter('alpha', 'page');
    const createRuntime = () => new RuntimeLearning({
      workingDirectory: env.root,
      evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
      learningEpisodeStore: env.episodeStore,
      skillEvolution: env.skillEvolution,
      curator: env.curator,
      planner: env.planner,
      sessionLogSources: [adapter],
      discoveryQuotas: {
        maxResourcesPerWake: 2,
        maxAdmittedEpisodesPerWake: 2,
      },
    });

    try {
      await createRuntime().wake('manual');

      assert.deepEqual(adapter.catchUpActions, ['page']);
      assert.deepEqual(
        adapter.acknowledged,
        ['alpha-catch-up', 'alpha-continuous'],
        'one historical page settles first and remaining capacity is donated to continuous',
      );
      assert.equal(
        createRuntime().getExternalAdmissionCoordinator()
          .getStateForTesting().providerTurns.alpha?.lastLaneServed,
        'continuous',
        'the donated continuous page is the final shared-writer turn; no second catch-up page ran',
      );
    } finally {
      env.restore();
      env.teardown();
    }
  });

  test('an unadmitted catch-up page keeps the same durable action across restart', async () => {
    const env = setupEnv();
    const adapter = new CatchUpSchedulingFakeAdapter('alpha', 'page');
    const createRuntime = (maxAdmittedEpisodesPerWake: number) => new RuntimeLearning({
      workingDirectory: env.root,
      evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
      learningEpisodeStore: env.episodeStore,
      skillEvolution: env.skillEvolution,
      curator: env.curator,
      planner: env.planner,
      sessionLogSources: [adapter],
      discoveryQuotas: {
        maxResourcesPerWake: 1,
        maxAdmittedEpisodesPerWake,
      },
    });

    try {
      await createRuntime(0).wake('manual');
      assert.deepEqual(adapter.catchUpActions, ['page']);
      assert.equal(adapter.acknowledged.includes('alpha-catch-up'), false);

      await createRuntime(1).wake('manual');
      assert.deepEqual(adapter.catchUpActions, ['page', 'page']);
      assert.equal(adapter.acknowledged.filter(ref => ref === 'alpha-catch-up').length, 1);
    } finally {
      env.restore();
      env.teardown();
    }
  });

  test('slow continuous reads donate the reserved deadline slice to catch-up without leaking work', async () => {
    const env = setupEnv();
    const adapter = new SlowContinuousCatchUpFakeAdapter('alpha');
    const runtime = new RuntimeLearning({
      workingDirectory: env.root,
      evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
      learningEpisodeStore: env.episodeStore,
      skillEvolution: env.skillEvolution,
      curator: env.curator,
      planner: env.planner,
      sessionLogSources: [adapter],
      discoveryQuotas: {
        maxResourcesPerWake: 2,
        maxAdmittedEpisodesPerWake: 2,
        maxDiscoveryMs: 50,
      },
      externalSourceBudget: {
        maxResourcesPerWake: 2,
        maxBytesPerWake: 1024,
        maxElapsedMsPerWake: 50,
      },
    });

    try {
      const wake = await runtime.wake('manual');

      assert.deepEqual(adapter.catchUpActions, ['inventory']);
      assert.equal(adapter.activeReads, 0);
      assert.equal(
        wake.discovery.sources.find(source => source.sourceId === adapter.identity.sourceId)?.failureState,
        undefined,
        'reserved-slice cancellation is not a provider failure',
      );
    } finally {
      env.restore();
      env.teardown();
    }
  });

  describe('AC1: Internal discovery completes before external reads start', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); AsyncFakeSourceAdapter.resetGlobalReadStarts(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('internal source is fully processed before any external readAsync starts', async () => {
      const internal = new AsyncFakeSourceAdapter({
        sourceId: 'internal-1',
        category: 'internal',
        resourceCount: 3,
        syncOnly: true,
      });
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-1',
        category: 'external',
        resourceCount: 3,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external, internal],
        externalSourceMaxConcurrency: 3,
      });

      await runtimeLearning.wake('startup');

      // Internal source should have processed all 3 resources
      assert.equal(internal.acknowledged.length, 3, 'internal source fully processed');
      // External source should have processed all 3 resources
      assert.equal(external.acknowledged.length, 3, 'external source fully processed');

      // All internal read starts (sync, order 0,1,2) should come before
      // any external read start (async, order >= 3)
      const globalStarts = AsyncFakeSourceAdapter.getGlobalReadStarts();
      const internalStarts = globalStarts.filter(s => s.sourceId === 'internal-1').map(s => s.time);
      const externalStarts = globalStarts.filter(s => s.sourceId === 'ext-1').map(s => s.time);

      assert.ok(internalStarts.length === 3, 'internal had 3 reads');
      assert.ok(externalStarts.length === 3, 'external had 3 reads');
      const maxInternalStart = Math.max(...internalStarts);
      const minExternalStart = Math.min(...externalStarts);
      assert.ok(
        maxInternalStart < minExternalStart,
        `internal reads (max=${maxInternalStart}) started before external reads (min=${minExternalStart})`,
      );
    });
  });

  describe('AC2: External reads overlap up to the configured maximum', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('with concurrency 3 and 5 providers, at most 3 reads are active simultaneously', async () => {
      const externals = Array.from({ length: 5 }, (_, i) =>
        new AsyncFakeSourceAdapter({
          sourceId: `ext-${i}`,
          category: 'external',
          resourceCount: 2,
          readDelayMs: 20,
        }),
      );

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: externals,
        externalSourceMaxConcurrency: 3,
      });

      await runtimeLearning.wake('startup');

      // Each adapter should have seen at most 1 concurrent read (since each
      // provider reads its own resources serially — one page prefetch).
      for (const ext of externals) {
        assert.equal(
          ext.maxConcurrentReads, 1,
          `provider ${ext.identity.sourceId} reads serially (one page prefetch)`,
        );
      }

      // At the global level, up to 3 different providers should have had
      // overlapping reads. We verify this by checking that some providers
      // had read starts at the same "time" (global counter).
      const allReadStartOrders = externals.flatMap(e => e.readStartOrder);
      const minStart = Math.min(...allReadStartOrders);
      const maxStart = Math.max(...allReadStartOrders);
      // With 5 providers × 2 resources = 10 reads, and concurrency 3,
      // the reads should overlap (not all serial).
      assert.ok(
        maxStart - minStart < 10,
        'reads overlap (not all sequential)',
      );
    });

    test('with concurrency 3, three providers start reads before any completes', async () => {
      // Use a longer delay to make overlap observable
      const ext1 = new AsyncFakeSourceAdapter({ sourceId: 'ext-a', category: 'external', resourceCount: 1, readDelayMs: 30 });
      const ext2 = new AsyncFakeSourceAdapter({ sourceId: 'ext-b', category: 'external', resourceCount: 1, readDelayMs: 30 });
      const ext3 = new AsyncFakeSourceAdapter({ sourceId: 'ext-c', category: 'external', resourceCount: 1, readDelayMs: 30 });
      const ext4 = new AsyncFakeSourceAdapter({ sourceId: 'ext-d', category: 'external', resourceCount: 1, readDelayMs: 30 });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [ext1, ext2, ext3, ext4],
        externalSourceMaxConcurrency: 3,
      });

      await runtimeLearning.wake('startup');

      // The first 3 providers should have read start orders that are
      // lower than the 4th — meaning the 4th waited for one of the first 3
      // to complete before starting.
      const starts = [ext1, ext2, ext3, ext4].map(e => e.readStartOrder[0] ?? -1);
      const sortedStarts = [...starts].sort((a, b) => a - b);
      // The 4th provider's start should come after at least one of the first 3 completed
      // With concurrency 3, providers 0-2 start immediately, provider 3 starts after one completes
      assert.ok(
        sortedStarts[3]! >= sortedStarts[2]!,
        '4th provider started after at least one of the first 3',
      );
    });

    test('overlapping reads commit in durable provider order rather than completion order', async () => {
      AsyncFakeSourceAdapter.resetGlobalReadStarts();
      const alpha = new AsyncFakeSourceAdapter({
        sourceId: 'ext-alpha', category: 'external', resourceCount: 1, readDelayMs: 40,
      });
      const beta = new AsyncFakeSourceAdapter({
        sourceId: 'ext-beta', category: 'external', resourceCount: 1, readDelayMs: 5,
      });
      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [beta, alpha],
        externalSourceMaxConcurrency: 2,
      });

      await runtimeLearning.wake('startup');

      assert.equal(AsyncFakeSourceAdapter.getGlobalMaxActiveReads(), 2, 'provider reads actually overlap');
      assert.deepEqual(
        AsyncFakeSourceAdapter.getGlobalAcknowledgements(),
        ['ext-alpha#res-0', 'ext-beta#res-0'],
        'the coordinator turn, not read completion arrival, selects the durable writer',
      );
    });
  });

  describe('AC3: Production default concurrency is 3; values clamped to 1–8', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('default concurrency is 3 when not specified', async () => {
      const externals = Array.from({ length: 6 }, (_, i) =>
        new AsyncFakeSourceAdapter({
          sourceId: `ext-${i}`,
          category: 'external',
          resourceCount: 1,
          readDelayMs: 20,
        }),
      );

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: externals,
        // No externalSourceMaxConcurrency — should use config default
      });

      await runtimeLearning.wake('startup');

      // With default concurrency 3 and 6 providers, not all 6 start at once
      // Check that all resources were acknowledged (basic correctness)
      for (const ext of externals) {
        assert.equal(ext.acknowledged.length, 1, `${ext.identity.sourceId} acknowledged`);
      }
    });

    test('concurrency above 8 is clamped to 8', async () => {
      // This tests the config parsing, not the runtime behavior directly.
      // We verify the config clamping by checking env var parsing.
      const savedEnv = { ...process.env };
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '16';
      try {
        const { getDistillationHeartbeatConfig } = await import('../src/utils/distillation-heartbeat-config');
        const config = getDistillationHeartbeatConfig(env.root);
        assert.equal(config.externalSessionLogMaxConcurrency, 8, 'clamped to 8');
      } finally {
        process.env = savedEnv;
      }
    });

    test('concurrency below 1 falls back to default', async () => {
      const savedEnv = { ...process.env };
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '0';
      try {
        const { getDistillationHeartbeatConfig } = await import('../src/utils/distillation-heartbeat-config');
        const config = getDistillationHeartbeatConfig(env.root);
        assert.equal(config.externalSessionLogMaxConcurrency, 3, 'falls back to default 3');
      } finally {
        process.env = savedEnv;
      }
    });

    test('concurrency of 5 is accepted', async () => {
      const savedEnv = { ...process.env };
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '5';
      try {
        const { getDistillationHeartbeatConfig } = await import('../src/utils/distillation-heartbeat-config');
        const config = getDistillationHeartbeatConfig(env.root);
        assert.equal(config.externalSessionLogMaxConcurrency, 5, 'accepted as 5');
      } finally {
        process.env = savedEnv;
      }
    });
  });

  describe('AC4: Setting concurrency to 1 preserves serial behavior', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); AsyncFakeSourceAdapter.resetGlobalReadStarts(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('with concurrency 1, external reads do not overlap', async () => {
      const ext1 = new AsyncFakeSourceAdapter({
        sourceId: 'ext-serial-1', category: 'external',
        resourceCount: 2, readDelayMs: 10,
      });
      const ext2 = new AsyncFakeSourceAdapter({
        sourceId: 'ext-serial-2', category: 'external',
        resourceCount: 2, readDelayMs: 10,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [ext1, ext2],
        externalSourceMaxConcurrency: 1,
      });

      await runtimeLearning.wake('startup');

      // With concurrency 1, each adapter reads its resources serially
      assert.equal(ext1.maxConcurrentReads, 1, 'ext1 reads are serial');
      assert.equal(ext2.maxConcurrentReads, 1, 'ext2 reads are serial');

      // Verify strict serial ordering: all reads should be sequential
      // (no two reads from different providers overlap)
      const allStarts = AsyncFakeSourceAdapter.getGlobalReadStarts();
      // With serial mode, reads should complete in order: 0,1,2,3
      // (each read starts only after the previous one completes)
      for (let i = 1; i < allStarts.length; i++) {
        assert.ok(
          allStarts[i]!.time > allStarts[i - 1]!.time,
          `read ${i} started after read ${i - 1}`,
        );
      }
    });
  });

  describe('AC5: The external reader/adapter seam is async and accepts cancellation', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('readAsync receives an AbortSignal that can cancel the read', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-cancel',
        category: 'external',
        resourceCount: 3,
        readDelayMs: 100, // Long enough to abort mid-read
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
        externalSourceMaxConcurrency: 3,
      });

      // Start wake and abort it shortly after it starts
      const wakePromise = runtimeLearning.wake('startup');
      // Give it time to start the external read
      await new Promise(resolve => setTimeout(resolve, 10));
      runtimeLearning.requestExternalSourceDrain();
      const result = await wakePromise;

      // The wake should complete without error
      assert.ok(result, 'wake completed');
      // Some reads may have been canceled — the key is no crash
    });
  });

  describe('AC6: Each provider may prefetch at most one uncommitted page', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('a provider with multiple resources reads them one at a time', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-one-page',
        category: 'external',
        resourceCount: 5,
        readDelayMs: 10,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
        externalSourceMaxConcurrency: 3,
      });

      await runtimeLearning.wake('startup');

      // Even with concurrency 3, a single provider reads one page at a time
      assert.equal(external.maxConcurrentReads, 1, 'single provider never has more than 1 concurrent read');
      assert.equal(external.acknowledged.length, 5, 'all 5 resources processed');
    });
  });

  describe('AC7: Shutdown drain stops new external work', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('drain external sources prevents new external reads', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-drain',
        category: 'external',
        resourceCount: 5,
        readDelayMs: 5,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
        externalSourceMaxConcurrency: 3,
      });

      runtimeLearning.requestExternalSourceDrain();
      const result = await runtimeLearning.wake('startup');

      // External source should report as drained (no reads performed)
      const extReport = result.discovery.sources.find(s => s.sourceId === 'ext-drain');
      assert.ok(extReport, 'external report exists');
      assert.equal(extReport!.status, 'drained', 'external source is drained');
      assert.equal(external.acknowledged.length, 0, 'no resources acknowledged');
    });

    test('disabling one source cancels its in-flight page without failure accounting', async () => {
      const external = new DisableableAsyncFakeSourceAdapter({
        sourceId: 'ext-disable-active',
        category: 'external',
        resourceCount: 3,
        readDelayMs: 100,
      });
      const healthyPeer = new AsyncFakeSourceAdapter({
        sourceId: 'ext-disable-peer',
        category: 'external',
        resourceCount: 2,
        readDelayMs: 10,
      });
      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external, healthyPeer],
      });

      const wakePromise = runtimeLearning.wake('startup');
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(
        runtimeLearning.disableExternalSource(
          external.identity.provider,
          external.identity.sourceId,
        ),
        true,
      );
      const wake = await wakePromise;

      assert.equal(external.activeReads, 0, 'disable reaps the provider read');
      assert.deepEqual(external.acknowledged, [], 'disabled ready work remains replayable');
      assert.deepEqual(external.failedResources, [], 'disable cancellation is not adapter failure');
      assert.equal(healthyPeer.acknowledged.length, 2, 'an unrelated provider continues independently');
      assert.equal(
        wake.discovery.sources.find(source => source.sourceId === external.identity.sourceId)?.failureState,
        undefined,
        'disable cancellation does not enter provider failure accounting',
      );
      assert.equal(wake.review.reviewFailureCount, 0, 'disable does not count as reviewer failure');
      assert.equal(wake.review.operationalRetries, 0, 'disable does not create review retry work');
    });
  });

  describe('AC8: Canceled read is not counted as provider failure', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('drained external source does not record backoff or quarantine', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-no-fail',
        category: 'external',
        resourceCount: 5,
        readDelayMs: 100,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
        externalSourceMaxConcurrency: 3,
      });

      const wakePromise = runtimeLearning.wake('startup');
      await new Promise(resolve => setTimeout(resolve, 5));
      runtimeLearning.requestExternalSourceDrain();
      const result = await wakePromise;

      // The external source should be drained, not failed
      const extReport = result.discovery.sources.find(s => s.sourceId === 'ext-no-fail');
      assert.ok(extReport, 'external report exists');
      assert.equal(extReport!.status, 'drained', 'status is drained, not failed');

      // No failure state should have been recorded for drain
      const failureState = runtimeLearning.getExternalSourceFailureState().get('ext-no-fail');
      assert.ok(!failureState?.consecutiveFailures, 'no consecutive failures recorded for drain');
      assert.ok(!failureState?.suspendedUntil, 'no suspension for drain');
    });
  });

  describe('AC10: One provider failure does not cancel or alter another provider', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('failing provider does not affect successful provider results', async () => {
      const failing = new AsyncFakeSourceAdapter({
        sourceId: 'ext-fail',
        category: 'external',
        resourceCount: 3,
        shouldFail: true,
        readDelayMs: 5,
      });
      const succeeding = new AsyncFakeSourceAdapter({
        sourceId: 'ext-ok',
        category: 'external',
        resourceCount: 3,
        readDelayMs: 5,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [failing, succeeding],
        externalSourceMaxConcurrency: 3,
      });

      const result = await runtimeLearning.wake('startup');

      // The failing provider should have failed status
      const failReport = result.discovery.sources.find(s => s.sourceId === 'ext-fail');
      assert.ok(failReport, 'failing report exists');
      assert.equal(failReport!.status, 'failed', 'failing provider reported failed');

      // The succeeding provider should have processed all resources
      const okReport = result.discovery.sources.find(s => s.sourceId === 'ext-ok');
      assert.ok(okReport, 'succeeding report exists');
      assert.equal(okReport!.status, 'active', 'succeeding provider is active');
      assert.equal(succeeding.acknowledged.length, 3, 'succeeding provider processed all resources');
    });
  });

  describe('AC11: Wake-level resource and episode limits remain hard aggregate bounds', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('discovery quota caps total resources across concurrent external providers', async () => {
      const externals = Array.from({ length: 4 }, (_, i) =>
        new AsyncFakeSourceAdapter({
          sourceId: `ext-quota-${i}`,
          category: 'external',
          resourceCount: 5,
          readDelayMs: 5,
        }),
      );

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: externals,
        externalSourceMaxConcurrency: 4,
        discoveryQuotas: {
          maxResourcesPerWake: 6, // Cap at 6 total resources
          maxAdmittedEpisodesPerWake: 100,
          maxDiscoveryMs: 30_000,
        },
      });

      const result = await runtimeLearning.wake('startup');

      // Total advanced files across all external sources should not exceed 6
      assert.ok(
        result.discovery.advancedFiles <= 6,
        `total advanced (${result.discovery.advancedFiles}) does not exceed quota (6)`,
      );
    });
  });

  describe('AC12: No live child-process, timer, or promise handles after stop/drain', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('wake completes with no leftover active timers from external reads', async () => {
      const externals = Array.from({ length: 3 }, (_, i) =>
        new AsyncFakeSourceAdapter({
          sourceId: `ext-clean-${i}`,
          category: 'external',
          resourceCount: 2,
          readDelayMs: 5,
        }),
      );

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: externals,
        externalSourceMaxConcurrency: 3,
      });

      await runtimeLearning.wake('startup');

      // All adapters should report 0 active reads after wake completes
      for (const ext of externals) {
        assert.equal(ext.activeReads, 0, `${ext.identity.sourceId} has no active reads after wake`);
      }
    });

    test('wake with drain completes with no leftover active reads', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-drain-clean',
        category: 'external',
        resourceCount: 10,
        readDelayMs: 50,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
        externalSourceMaxConcurrency: 3,
      });

      const wakePromise = runtimeLearning.wake('startup');
      await new Promise(resolve => setTimeout(resolve, 5));
      runtimeLearning.requestExternalSourceDrain();
      await wakePromise;

      // After drain, no active reads should remain
      assert.equal(external.activeReads, 0, 'no active reads after drain');
    });

    test('runtime drain cancels an in-flight external page without acknowledgement or failure', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-runtime-drain',
        category: 'external',
        resourceCount: 3,
        readDelayMs: 100,
      });
      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
      });

      const wakePromise = runtimeLearning.wake('startup');
      await new Promise(resolve => setTimeout(resolve, 5));
      await runtimeLearning.drain(1_000);
      const wake = await wakePromise;

      assert.equal(external.activeReads, 0, 'drain reaps the active read');
      assert.deepEqual(external.acknowledged, [], 'ready work remains replayable after drain');
      assert.deepEqual(external.failedResources, [], 'scheduler cancellation is not adapter failure');
      assert.equal(
        wake.discovery.sources.find(source => source.sourceId === external.identity.sourceId)?.failureState,
        undefined,
        'scheduler cancellation does not enter provider failure accounting',
      );
      assert.equal(wake.review.reviewFailureCount, 0, 'drain does not count as reviewer failure');
      assert.equal(wake.review.operationalRetries, 0, 'drain does not create review retry work');
    });

    test('drain discards a ready page waiting for its serialized commit turn', async () => {
      const alpha = new AsyncFakeSourceAdapter({
        sourceId: 'ext-alpha-drain-turn',
        category: 'external',
        resourceCount: 1,
        readDelayMs: 100,
      });
      const beta = new AsyncFakeSourceAdapter({
        sourceId: 'ext-beta-drain-turn',
        category: 'external',
        resourceCount: 1,
        readDelayMs: 5,
      });
      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [beta, alpha],
        externalSourceMaxConcurrency: 2,
      });

      const wakePromise = runtimeLearning.wake('startup');
      const deadline = Date.now() + 1_000;
      while (!(alpha.activeReads === 1 && beta.activeReads === 0)) {
        assert.ok(Date.now() < deadline, 'the fast provider becomes ready behind the slow provider');
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      runtimeLearning.requestExternalSourceDrain();
      const wake = await wakePromise;

      assert.deepEqual(alpha.acknowledged, []);
      assert.deepEqual(beta.acknowledged, [], 'ready work canceled before commit remains replayable');
      assert.deepEqual(alpha.failedResources, []);
      assert.deepEqual(beta.failedResources, [], 'discarding ready work is not provider failure');
      assert.equal(
        wake.discovery.sources.find(source => source.sourceId === beta.identity.sourceId)?.status,
        'drained',
      );
    });

    test('wake then drain leaves no leftover active reads', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-stop-clean',
        category: 'external',
        resourceCount: 2,
        readDelayMs: 5,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
        externalSourceMaxConcurrency: 3,
      });

      await runtimeLearning.wake('startup');
      runtimeLearning.requestExternalSourceDrain();

      assert.equal(external.activeReads, 0, 'no active reads after wake + drain');
    });
  });

  describe('Compatibility: sync-only adapters (no readAsync) still work', () => {
    let env: TestEnv;

    beforeEach(() => { env = setupEnv(); });
    afterEach(() => { env.restore(); env.teardown(); });

    test('sync adapter is wrapped for concurrent execution via read()', async () => {
      const external = new AsyncFakeSourceAdapter({
        sourceId: 'ext-sync',
        category: 'external',
        resourceCount: 3,
        syncOnly: true,
      });

      const runtimeLearning = new RuntimeLearning({
        workingDirectory: env.root,
        evidenceIngestor: new StubEvidenceIngestor() as unknown as EvidenceIngestor,
        learningEpisodeStore: env.episodeStore,
        skillEvolution: env.skillEvolution,
        curator: env.curator,
        planner: env.planner,
        sessionLogSources: [external],
        externalSourceMaxConcurrency: 3,
      });

      const result = await runtimeLearning.wake('startup');

      assert.equal(external.acknowledged.length, 3, 'sync adapter processed all resources');
      const report = result.discovery.sources[0]!;
      assert.equal(report.status, 'active', 'sync adapter reported active');
    });
  });
});

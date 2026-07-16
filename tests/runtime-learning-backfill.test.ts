/**
 * Issue #79 — RuntimeLearning explicit external backfill integration.
 *
 * Focused coverage for the operator-facing seam that wires the standalone
 * backfill service into the shared evidence capsule + review/promotion path.
 */

import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DistillationUnit, extractDistillationUnit } from '../src/utils/distillation-unit';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import {
  RuntimeLearning,
  EvidenceBundle,
} from '../src/utils/runtime-learning';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';
import {
  findOperationalByBundleId,
  loadReviewQueueState,
  saveReviewQueueState,
} from '../src/utils/skill-evolution-review-queue';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
  ExternalSessionLogBackfillReadResult,
  ExternalSessionLogBackfillRequest,
  ExternalSessionLogBackfillSource,
  loadExternalSessionLogBackfillState,
} from '../src/utils/session-log-backfill';
import {
  SessionLogSourceAdapter,
  SessionLogSourceIdentity,
  SessionLogSourceReadContext,
  SessionLogSourceReadResult,
  SessionLogSourceResource,
  SourceCursor,
} from '../src/utils/session-log-source';

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
  readonly registryPath: string;
  readonly auditPath: string;
  readonly journalPath: string;
  readonly outputDir: string;
  createRuntime(options?: {
    settlementWindowMs?: number;
    operationalRetryMs?: number;
    authorFixture?: Parameters<typeof SkillEvolutionRuntime>[0]['authorFixture'];
    verifierFixture?: Parameters<typeof SkillEvolutionRuntime>[0]['verifierFixture'];
    sessionLogSources?: readonly SessionLogSourceAdapter[];
    clock?: () => Date;
  }): RuntimeFixture;
  restore(): void;
}

interface FixtureBackfillItem {
  readonly resourceRef: string;
  readonly position: number;
  readonly unit: DistillationUnit | null;
  readonly contentHash?: string;
  readonly failMessage?: string;
  readonly ignoreCursor?: boolean;
}

class FixtureBackfillSource implements ExternalSessionLogBackfillSource {
  readonly identity: SessionLogSourceIdentity;
  private readonly resources: readonly SessionLogSourceResource[];
  private readonly itemsByRef: Map<string, FixtureBackfillItem>;

  constructor(
    items: readonly FixtureBackfillItem[],
    options: {
      sourceId?: string;
      provider?: string;
      label?: string;
    } = {},
  ) {
    const provider = options.provider ?? 'codex';
    const sourceId = options.sourceId ?? 'codex-backfill';
    this.identity = {
      sourceId,
      label: options.label ?? 'Fixture External Backfill Source',
      category: 'external',
      provider,
      reader: 'fixture-backfill',
    };
    this.resources = items.map(item => ({
      resourceRef: item.resourceRef,
      firstEventIdentity: {
        eventId: `${provider}://${item.resourceRef}/${item.position}`,
        position: item.position,
        contentHash: item.contentHash,
      },
    }));
    this.itemsByRef = new Map(items.map(item => [item.resourceRef, item]));
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    return this.resources;
  }

  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSessionLogBackfillReadResult {
    const item = this.itemsByRef.get(resource.resourceRef);
    if (!item) {
      return {
        events: [],
        status: 'stable',
        exhausted: true,
        newCursor: cursor,
      };
    }
    if (item.failMessage) throw new Error(item.failMessage);
    const position = resource.firstEventIdentity?.position ?? item.position;
    if (!item.ignoreCursor && cursor.position >= position + 1) {
      return {
        events: [],
        status: 'stable',
        exhausted: true,
        newCursor: cursor,
      };
    }
    if (!item.unit) {
      return {
        events: [],
        status: 'pending',
        exhausted: false,
        newCursor: cursor,
      };
    }
    const byteLength = Buffer.byteLength(JSON.stringify(item.unit), 'utf8');
    return {
      events: [{
        identity: resource.firstEventIdentity!,
        distillationUnit: item.unit,
        byteLength,
      }],
      status: 'stable',
      exhausted: true,
      newCursor: {
        resourceRef: resource.resourceRef,
        position: position + 1,
        processedCount: cursor.processedCount + 1,
      },
    };
  }
}

class ExternalContinuousFixtureAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  readonly acknowledged: string[] = [];
  private readonly resource: SessionLogSourceResource;
  private consumed = false;

  constructor(
    private readonly unit: DistillationUnit,
    private readonly options: {
      sourceId?: string;
      provider?: string;
      onAcknowledge?: (resourceRef: string) => void;
    } = {},
  ) {
    this.identity = {
      sourceId: options.sourceId ?? 'external-codex',
      label: 'External Continuous Fixture Source',
      category: 'external',
      provider: options.provider ?? 'codex',
      reader: 'fixture',
    };
    this.resource = {
      resourceRef: `${this.identity.sourceId}://resource-0`,
      firstEventIdentity: {
        eventId: `${this.identity.provider}://continuous/event-0`,
        position: 0,
        contentHash: 'continuous-hash-0',
      },
    };
  }

  isEnabled(): boolean { return true; }
  discoverResources(): readonly SessionLogSourceResource[] { return [this.resource]; }

  read(resource: SessionLogSourceResource, _context: SessionLogSourceReadContext): SessionLogSourceReadResult {
    if (this.consumed) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'exhausted',
        newCursor: { resourceRef: resource.resourceRef, position: 1, processedCount: this.unit.newTurns.length },
      };
    }
    this.consumed = true;
    return {
      distillationUnit: this.unit,
      advanced: true,
      status: 'advanced',
      newCursor: { resourceRef: resource.resourceRef, position: 1, processedCount: this.unit.newTurns.length },
    };
  }

  acknowledge(resource: SessionLogSourceResource, _result: SessionLogSourceReadResult): void {
    this.acknowledged.push(resource.resourceRef);
    this.options.onAcknowledge?.(resource.resourceRef);
  }
  markFailed(_resource: SessionLogSourceResource, _error: unknown): void { this.consumed = false; }
}

test('explicit backfill persists redacted capsules and promotes through the shared review path', async () => {
  let seenBundle: EvidenceBundle | undefined;
  const env = setupEnv();
  try {
    const fixture = env.createRuntime({
      authorFixture: ({ bundle }) => {
        seenBundle = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
        return {
          body: 'Promote the bounded external report delivery skill.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'explicit-backfill-report-delivery',
            description: 'Deliver a report from explicit external backfill evidence.',
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
            rationale: 'explicit backfill uses the same capsule-backed promotion path',
          },
        };
      },
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'explicit backfill promotion accepted',
        registryReadSet: [],
      }),
    });
    const source = new FixtureBackfillSource([
      {
        resourceRef: 'conversation-0',
        position: 0,
        unit: buildExternalUnit(env.root, 'external://codex/conversation/explicit.jsonl'),
        contentHash: 'explicit-hash-0',
      },
    ], {
      provider: 'codex',
      sourceId: 'codex-explicit-backfill',
    });
    const request = makeRequest({
      provider: 'codex',
      sourceId: 'codex-explicit-backfill',
      resourceRefs: ['conversation-0'],
      endPosition: 0,
    });
    const paths = fixture.runtime.getExternalBackfillOperationPaths(request);

    assert.equal(fs.existsSync(paths.stateFilePath), false);
    assert.equal(fs.existsSync(paths.auditFilePath), false);

    const result = await fixture.runtime.runExternalBackfill(request, source);

    assert.equal(result.backfill.status, 'completed');
    assert.equal(result.review.status, 'succeeded');
    assert.equal(result.review.reviewedEpisodes, 1);
    assert.ok(fs.existsSync(result.paths.stateFilePath));
    assert.ok(fs.existsSync(result.paths.auditFilePath));

    const episodeId = Object.keys(fixture.episodeStore.load().episodes)[0];
    assert.ok(episodeId, 'one admitted episode should exist');

    const capsule = fixture.runtime.getEvidenceCapsuleStore().findByEpisodeId(episodeId);
    assert.ok(capsule, 'external explicit backfill should persist a capsule');
    assert.equal(capsule!.provenance.provider, 'codex');
    assert.equal(capsule!.identity.eventId, 'codex://conversation-0/0');
    assert.ok(!JSON.stringify(capsule).includes('my-secret'));
    assert.ok(!JSON.stringify(capsule).includes('/Users/me/project/private'));

    const bundleText = JSON.stringify(seenBundle);
    assert.ok(bundleText.includes('sourceEvidence'));
    assert.ok(!bundleText.includes('my-secret'));
    assert.ok(!bundleText.includes('/Users/me/project/private'));

    const state = loadExternalSessionLogBackfillState(result.paths.stateFilePath)!;
    assert.equal(state.status, 'completed');
    assert.equal(state.metrics.ingestedEvents, 1);
    assert.equal(state.metrics.admittedEpisodes, 1);

    const audit = fixture.skillEvolution.getAudit();
    assert.equal(audit.length, 1);
    assert.deepEqual(capsule!.promotionAuditRefs, [audit[0]!.transitionId]);
    assert.equal(Object.keys(fixture.skillEvolution.getRegistry().capabilities).length, 1);
  } finally {
    env.restore();
  }
});

test('explicit backfill replay can create a missing capsule before cursor acknowledgement after initial capsule write failure', async () => {
  const env = setupEnv();
  try {
    const request = makeRequest({
      operationId: 'retryable-capsule-write',
      provider: 'codex',
      sourceId: 'codex-replay-backfill',
      resourceRefs: ['conversation-1'],
      endPosition: 0,
    });

    const source = new FixtureBackfillSource([
      {
        resourceRef: 'conversation-1',
        position: 0,
        unit: buildExternalUnit(env.root, 'external://codex/conversation/retry-capsule.jsonl'),
        contentHash: 'retry-capsule-hash-0',
        ignoreCursor: true,
      },
    ], {
      provider: 'codex',
      sourceId: 'codex-replay-backfill',
    });

    const runtime = env.createRuntime({
      authorFixture: ({ bundle }) => ({
        body: 'Promote retryable external backfill episode.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'replay-capsule-write-report-delivery',
          description: 'Recover replay for a missing external capsule.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          rationale: 'explicit backfill replay should fail closed before replaying',
        },
      }),
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'replay accepted after capsule recovery',
        registryReadSet: [],
      }),
    });

    const store = runtime.runtime.getEvidenceCapsuleStore();
    const originalUpsert = (store as unknown as { upsert: (value: Parameters<typeof store.upsert>[0]) => void }).upsert;
    let upsertAttempts = 0;
    (store as unknown as { upsert: (value: Parameters<typeof store.upsert>[0]) => void }).upsert = (capsule) => {
      upsertAttempts += 1;
      if (upsertAttempts === 1) {
        throw new Error('simulated capsule store write failure');
      }
      originalUpsert.call(store, capsule);
    };

    const first = await runtime.runtime.runExternalBackfill(request, source);
    assert.equal(first.backfill.status, 'source_failed', 'first run fails only because capsule write failed');
    assert.equal(first.review.status, 'failed', 'first run fails review due missing external capsule');

    const episodeId = Object.keys(runtime.episodeStore.load().episodes)[0];
    assert.ok(episodeId, 'episode should exist despite capsule failure');
    assert.equal(store.findByEpisodeId(episodeId), undefined, 'capsule absent on first failure');

    // Restore durable capsule writes and replay the same explicit backfill operation.
    (store as unknown as { upsert: (value: Parameters<typeof store.upsert>[0]) => void }).upsert = originalUpsert;

    const second = await runtime.runtime.runExternalBackfill(request, source);
    assert.equal(second.backfill.status, 'completed', 'second run completes with replayed capsule');
    assert.equal(second.review.status, 'succeeded', 'second run succeeds after capsule recovery');
    const restoredCapsule = runtime.runtime.getEvidenceCapsuleStore().findByEpisodeId(episodeId);
    assert.ok(restoredCapsule, 'capsule is recreated on replay');
  } finally {
    env.restore();
  }
});

test('external backfill remains fail-closed when source file path is non-URI', async () => {
  const env = setupEnv();
  try {
    const request = makeRequest({
      operationId: 'non-uri-path-backfill',
      provider: 'codex',
      sourceId: 'codex-non-uri',
      resourceRefs: ['conversation-non-uri'],
      endPosition: 0,
    });

    const nonUriSourceFile = 'sessions/conversation/non-uri.jsonl';
    const source = new FixtureBackfillSource([
      {
        resourceRef: 'conversation-non-uri',
        position: 0,
        unit: buildExternalUnit(env.root, nonUriSourceFile),
        contentHash: 'non-uri-hash-0',
        ignoreCursor: true,
      },
    ], {
      provider: 'codex',
      sourceId: 'codex-non-uri',
    });

    const runtime = env.createRuntime({
      authorFixture: ({ bundle }) => ({
        body: 'Promote non-uri backfill report.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'non-uri-backfill-report-delivery',
          description: 'Fail-closed for non-URI external evidence.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          rationale: 'non-uri path still must use provenance for fail-closed',
        },
      }),
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'non-uri path accepted when capsule exists',
        registryReadSet: [],
      }),
    });

    const store = runtime.runtime.getEvidenceCapsuleStore();
    const originalUpsert = store.upsert.bind(store);
    let upsertAttempts = 0;
    store.upsert = (capsule) => {
      upsertAttempts += 1;
      if (upsertAttempts === 1) {
        throw new Error('simulated capsule store write failure');
      }
      originalUpsert(capsule);
    };

    const first = await runtime.runtime.runExternalBackfill(request, source);
    assert.equal(first.review.status, 'failed', 'non-URI external evidence still requires capsule for review');

    store.upsert = originalUpsert;
    const second = await runtime.runtime.runExternalBackfill(request, source);
    assert.equal(second.review.status, 'succeeded', 'non-URI evidence succeeds once capsule is recoverable');
  } finally {
    env.restore();
  }
});

test('ordinary wake reasons never invoke explicit backfill automatically', async () => {
  const env = setupEnv();
  try {
    const fixture = env.createRuntime({
      sessionLogSources: [
        new ExternalContinuousFixtureAdapter(
          buildExternalUnit(env.root, 'external://codex/conversation/continuous.jsonl'),
          { sourceId: 'codex-continuous-source', provider: 'codex' },
        ),
      ],
      authorFixture: () => ({
        body: 'Promote the continuous external report delivery skill.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'continuous-external-report-delivery',
          description: 'Deliver a report from ordinary continuous external ingestion.',
          evidenceRefs: [],
          rationale: 'continuous wake path remains separate from explicit backfill',
        },
      }),
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'continuous path accepted',
        registryReadSet: [],
      }),
    });
    const request = makeRequest({
      operationId: 'no-auto-backfill',
      provider: 'codex',
      sourceId: 'codex-continuous-source',
      resourceRefs: ['conversation-0'],
      endPosition: 0,
    });
    const paths = fixture.runtime.getExternalBackfillOperationPaths(request);

    await fixture.runtime.wake('startup');
    await fixture.runtime.wake('scheduled');
    await fixture.runtime.wake('manual');

    assert.ok(Object.keys(fixture.episodeStore.load().episodes).length >= 1, 'continuous wake still ingests external evidence');
    assert.equal(fs.existsSync(paths.stateFilePath), false);
    assert.equal(fs.existsSync(paths.auditFilePath), false);
  } finally {
    env.restore();
  }
});

test('explicit backfill drains after one bounded slice and resumes durably', async () => {
  const env = setupEnv();
  try {
    const fixture = env.createRuntime();
    const unit = buildExternalUnit(env.root, 'external://codex/conversation/drain.jsonl');
    const items = Array.from({ length: 25 }, (_, position) => ({
      resourceRef: `conversation-drain-${position}`,
      position,
      unit,
      contentHash: `drain-hash-${position}`,
    }));
    const source = new FixtureBackfillSource(items, {
      provider: 'codex',
      sourceId: 'codex-drain-source',
    });
    const request = makeRequest({
      operationId: 'bounded-drain-backfill',
      provider: 'codex',
      sourceId: 'codex-drain-source',
      endPosition: 24,
      maxResources: 100,
    });

    const operation = fixture.runtime.runExternalBackfill(request, source);
    await fixture.runtime.drain(1_000);
    const first = await operation;

    assert.equal(first.drained, true);
    assert.equal(first.backfill.status, 'quota_reached');
    assert.equal(first.backfill.state.metrics.resourcesProcessed, 1);
    assert.equal(first.backfill.state.metrics.ingestedEvents, 1);
    assert.equal(first.review.status, 'skipped');

    const resumed = await fixture.runtime.runExternalBackfill(request, source);
    assert.equal(resumed.drained, false);
    assert.equal(resumed.backfill.status, 'completed');
    assert.equal(resumed.backfill.state.metrics.ingestedEvents, 25);
  } finally {
    env.restore();
  }
});

test('explicit backfill and ordinary wakes share one state writer', async () => {
  const env = setupEnv();
  try {
    let releaseAuthor!: () => void;
    const authorBlocked = new Promise<void>(resolve => { releaseAuthor = resolve; });
    let authorStarted!: () => void;
    const authorStartedPromise = new Promise<void>(resolve => { authorStarted = resolve; });
    const fixture = env.createRuntime({
      authorFixture: async ({ bundle }) => {
        authorStarted();
        await authorBlocked;
        return {
          body: 'Serialize explicit backfill with ordinary wakes.',
          envelope: {
            decision: 'create_current_skill' as const,
            routingName: 'serialized-backfill-review',
            description: 'Backfill review holds the sole state writer until it finishes.',
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
            rationale: 'ordinary wakes must wait behind the active explicit backfill writer',
          },
        };
      },
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'serialized writer path accepted',
        registryReadSet: [],
      }),
    });
    const request = makeRequest({
      operationId: 'serialized-backfill-writer',
      provider: 'codex',
      sourceId: 'codex-serialized-writer',
      resourceRefs: ['conversation-serialized'],
      endPosition: 0,
    });
    const source = new FixtureBackfillSource([
      {
        resourceRef: 'conversation-serialized',
        position: 0,
        unit: buildExternalUnit(env.root, 'external://codex/conversation/serialized.jsonl'),
        contentHash: 'serialized-hash-0',
      },
    ], {
      provider: 'codex',
      sourceId: 'codex-serialized-writer',
    });

    const backfill = fixture.runtime.runExternalBackfill(request, source);
    await authorStartedPromise;

    let wakeResolved = false;
    const wake = fixture.runtime.wake('manual').then(result => {
      wakeResolved = true;
      return result;
    });

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(wakeResolved, false, 'ordinary wake must wait until explicit backfill releases the writer');

    releaseAuthor();
    const [backfillResult, wakeResult] = await Promise.all([backfill, wake]);
    assert.equal(backfillResult.backfill.status, 'completed');
    assert.equal(backfillResult.review.status, 'succeeded');
    assert.equal(wakeResult.ran, true);
  } finally {
    env.restore();
  }
});

test('multi-page backfill yields to same-provider continuous work after one page turn', async () => {
  const env = setupEnv();
  try {
    const sequence: string[] = [];
    const nonCandidateUnit = (filePath: string): DistillationUnit => ({
      filePath,
      newTurns: [],
      continuityTurns: [],
      byteRange: { start: 0, end: 1 },
      generatedAt: new Date().toISOString(),
    });
    const continuous = new ExternalContinuousFixtureAdapter(
      nonCandidateUnit('external://codex/conversation/continuous-turn.jsonl'),
      {
        provider: 'codex',
        sourceId: 'codex-continuous-turn',
        onAcknowledge: () => sequence.push('continuous'),
      },
    );
    const fixture = env.createRuntime({
      settlementWindowMs: 24 * 60 * 60 * 1000,
      sessionLogSources: [continuous],
    });
    const request = makeRequest({
      operationId: 'page-turn-backfill',
      provider: 'codex',
      sourceId: 'codex-page-turn-backfill',
      resourceRefs: ['backfill-0', 'backfill-1', 'backfill-2'],
      endPosition: 2,
      maxResources: 100,
    });
    const baseSource = new FixtureBackfillSource(
      [0, 1, 2].map(position => ({
        resourceRef: `backfill-${position}`,
        position,
        unit: nonCandidateUnit(`external://codex/conversation/backfill-${position}.jsonl`),
        contentHash: `page-turn-hash-${position}`,
      })),
      { provider: 'codex', sourceId: 'codex-page-turn-backfill' },
    );
    let wake: Promise<Awaited<ReturnType<RuntimeLearning['wake']>>> | undefined;
    const source: ExternalSessionLogBackfillSource = {
      identity: baseSource.identity,
      discoverResources: () => baseSource.discoverResources(),
      read: (resource, cursor) => {
        sequence.push(resource.resourceRef);
        if (!wake) {
          queueMicrotask(() => {
            wake = fixture.runtime.wake('manual');
          });
        }
        return baseSource.read(resource, cursor);
      },
    };

    const backfill = await fixture.runtime.runExternalBackfill(request, source);
    await wake;

    assert.equal(backfill.backfill.status, 'completed');
    assert.equal(backfill.backfill.state.metrics.ingestedEvents, 3);
    assert.deepEqual(continuous.acknowledged, ['codex-continuous-turn://resource-0']);
    assert.ok(
      sequence.indexOf('backfill-0') < sequence.indexOf('continuous')
      && sequence.indexOf('continuous') < sequence.indexOf('backfill-1'),
      `expected one-page yield, observed ${sequence.join(' -> ')}`,
    );
  } finally {
    env.restore();
  }
});

test('explicit backfill retries through the shared queue and remains idempotent on rerun', async () => {
  const env = setupEnv();
  try {
    const request = makeRequest({
      operationId: 'retryable-backfill',
      provider: 'codex',
      sourceId: 'codex-retry-source',
      resourceRefs: ['conversation-retry'],
      endPosition: 0,
    });
    const source = new FixtureBackfillSource([
      {
        resourceRef: 'conversation-retry',
        position: 0,
        unit: buildExternalUnit(env.root, 'external://codex/conversation/retry.jsonl'),
        contentHash: 'retry-hash-0',
        ignoreCursor: true,
      },
    ], {
      provider: 'codex',
      sourceId: 'codex-retry-source',
    });

    const failing = env.createRuntime({
      operationalRetryMs: 60_000,
      authorFixture: async () => {
        throw new Error('simulated author branch failure');
      },
    });

    const first = await failing.runtime.runExternalBackfill(request, source);
    assert.equal(first.backfill.status, 'completed');
    assert.equal(Object.keys(failing.skillEvolution.getRegistry().capabilities).length, 0);

    const episodeId = Object.keys(failing.episodeStore.load().episodes)[0];
    assert.ok(episodeId, 'one admitted episode should exist');
    const bundleId = `v3:learning-episode:${episodeId}`;
    const queued = findOperationalByBundleId(loadReviewQueueState(env.reviewQueuePath), bundleId);
    assert.ok(queued, 'failed explicit backfill review should queue an operational retry');
    assert.ok(queued!.bundle.sourceEvidence?.length, 'queued retry should keep the redacted capsule snapshot');

    const queue = loadReviewQueueState(env.reviewQueuePath);
    queue.operational[0]!.nextRetryAt = new Date(0).toISOString();
    saveReviewQueueState(env.reviewQueuePath, queue);

    const recovery = env.createRuntime({
      operationalRetryMs: 0,
      authorFixture: ({ bundle }) => ({
        body: 'Recover the queued explicit backfill review.',
        envelope: {
          decision: 'create_current_skill' as const,
          routingName: 'retryable-backfill-report-delivery',
          description: 'Recover explicit backfill promotion from queued redacted evidence.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          rationale: 'retry the explicit backfill promotion from the shared queue',
        },
      }),
      verifierFixture: () => ({
        decision: 'accept' as const,
        transition: 'create_current_skill' as const,
        issues: [],
        rationale: 'queued explicit backfill retry accepted',
        registryReadSet: [],
      }),
    });

    const second = await recovery.runtime.runExternalBackfill(request, source);
    assert.equal(second.backfill.duplicateEventsSkipped, 1);
    assert.equal(second.review.operationalQueueReviews, 1);
    assert.equal(second.review.status, 'succeeded');
    assert.equal(Object.keys(recovery.skillEvolution.getRegistry().capabilities).length, 1);
  } finally {
    env.restore();
  }
});

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-backfill-'));
  tempRoots.push(root);

  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');
  const outputDir = defaultDistilledOutputDir(path.join(root, 'skills'));

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

  return {
    root,
    reviewQueuePath,
    registryPath,
    auditPath,
    journalPath,
    outputDir,
    createRuntime(options = {}) {
      const skillEvolution = new SkillEvolutionRuntime({
        workingDirectory: root,
        outputDir,
        registryPath,
        auditPath,
        journalPath,
        reviewQueuePath,
        settlementWindowMs: options.settlementWindowMs ?? 0,
        operationalRetryMs: options.operationalRetryMs ?? 0,
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
        settlementWindowMs: options.settlementWindowMs ?? 0,
      });

      return {
        runtime: new RuntimeLearning({
          workingDirectory: root,
          evidenceIngestor,
          learningEpisodeStore: episodeStore,
          skillEvolution,
          curator,
          planner,
          sessionLogSources: options.sessionLogSources ?? [],
          ...(options.clock ? { clock: options.clock } : {}),
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

function makeRequest(overrides: Partial<{
  operationId: string;
  provider: string;
  sourceId: string;
  resourceRefs: string[];
  startPosition: number;
  endPosition: number;
  maxResources: number;
  maxBytes: number;
  maxElapsedMs: number;
}> = {}): ExternalSessionLogBackfillRequest {
  return {
    operationId: overrides.operationId ?? 'backfill-op-79',
    triggeredBy: 'operator:test',
    provider: overrides.provider ?? 'codex',
    sourceId: overrides.sourceId ?? 'codex-backfill',
    range: {
      startPosition: overrides.startPosition ?? 0,
      endPosition: overrides.endPosition ?? 99,
      resourceRefs: overrides.resourceRefs,
    },
    limits: {
      maxResources: overrides.maxResources ?? 10,
      maxBytes: overrides.maxBytes ?? Number.MAX_SAFE_INTEGER,
      maxElapsedMs: overrides.maxElapsedMs ?? 60_000,
    },
  };
}

function buildExternalUnit(root: string, sourceFilePath: string): DistillationUnit {
  const localFile = path.join(root, 'fixtures', `${Buffer.from(sourceFilePath).toString('hex').slice(0, 24)}.jsonl`);
  writeLog(localFile, [
    makeTurn(
      1,
      'external-session',
      'Please generate and send the report.',
      'Done.',
      [{
        id: 'send-1',
        name: 'send_file',
        arguments: { path: '/Users/me/project/private/report.md' },
        result: 'report sent token: my-secret',
      }],
    ),
    makeTurn(2, 'external-session', 'Thanks, that works perfectly!', 'Glad it helped.'),
  ]);
  const extracted = extractDistillationUnit(localFile, {
    filePath: localFile,
    byteOffset: 0,
    processedTurnCount: 0,
    updatedAt: '',
    status: 'pending',
  });
  if (!extracted.distillationUnit) throw new Error('failed to build external distillation unit');
  return {
    ...extracted.distillationUnit,
    filePath: sourceFilePath,
  };
}

function writeLog(filePath: string, entries: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function makeTurn(
  turn: number,
  sessionId: string,
  userText: string,
  assistantText: string,
  toolCalls: { id: string; name: string; arguments: any; result: string }[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, turn)).toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 20 },
  };
}

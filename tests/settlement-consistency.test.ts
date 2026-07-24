/**
 * Regression: external Pi/DeepSeek settlement-evidence consistency.
 *
 * A real isolated Pi -> DeepSeek Flash E2E produced an eligible episode and
 * reached Skill Author/Verifier. The Verifier deferred because the settlement
 * evidence ref claimed `settled` while the evidence content said
 * `status: settling` — a material settlement contradiction frozen into the
 * durable Evidence Capsule at admission time, before the episode matured.
 *
 * Root cause: the capsule was built at the external-admission boundary while
 * the freshly-extracted episode was still `settling`, but the settlement
 * evidence unconditionally labeled the ref `:settled-` and the content
 * `settled at <deadline> (status: <status>)`. The capsule is the durable,
 * pinned external-evidence boundary, so that self-contradictory assertion was
 * reconstructed into the Verifier's bundle and (correctly, fail-closed) deferred.
 *
 * These tests exercise the public/production path:
 *   admission capsule build -> durable store -> maturation refresh ->
 *   buildEpisodeEvidenceBundle reconstruction (the exact function runReview
 *   calls for external-origin episodes).
 *
 * They prove a review bundle never labels a settling episode as settled and
 * never exposes mutually contradictory settlement assertions, for both the
 * pre-maturation (settling) capsule and the post-maturation (eligible) bundle.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildEpisodeEvidenceBundle,
  buildEpisodeSettlementEvidence,
} from '../src/utils/episode-evidence-bundle';
import {
  EvidenceCapsuleStore,
  buildEvidenceCapsule,
  redactExternalEvidenceContent,
} from '../src/utils/evidence-capsule';
import {
  LearningEpisodeStore,
  settleLearningEpisodes,
  type LearningEpisode,
  type LearningEpisodeStatus,
} from '../src/utils/learning-episode';
import {
  SkillEvolutionRuntime,
  type EvidenceBundle,
  type ReferencedSkillSnapshot,
  type SkillEvolutionOptions,
} from '../src/utils/skill-evolution';
import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { DueWorkPlanner, reviewContinuationPathForEpisodeStore } from '../src/utils/due-work-planner';
import { defaultDistilledOutputDir } from '../src/utils/path-resolver';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { readShardStructurally } from '../src/utils/evidence-review-engine';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import type { SourceEventIdentity, SessionLogSourceIdentity } from '../src/utils/session-log-source';

/**
 * Assert that a settlement-evidence content string does not simultaneously
 * claim the episode has settled and expose a non-settled status — the exact
 * material contradiction the Verifier defers on.
 */
function assertNoSettlementContradiction(content: string): void {
  const claimsSettled = /\bsettled at\b/i.test(content);
  const claimsNotSettled = /\bnot settled\b/i.test(content);
  const statusMatch = content.match(/status:\s*([a-z-]+)/i);
  const status = statusMatch ? statusMatch[1]!.toLowerCase() : undefined;
  const settledStatus = status === 'eligible' || status === 'contradicted';

  // The content must pick one stance: either it honestly says "not settled"
  // with a non-settled status, or it says "settled at" with a settled status.
  // It must never say "settled at" alongside a non-settled status, and never
  // say "not settled" alongside a settled status.
  if (claimsSettled) {
    assert.ok(
      settledStatus,
      `settlement content claims "settled at" but status is non-settled: ${content}`,
    );
    assert.ok(
      !claimsNotSettled,
      `settlement content contradicts itself ("settled at" vs "not settled"): ${content}`,
    );
  } else {
    assert.ok(
      claimsNotSettled,
      `settlement content must honestly state the non-settled state: ${content}`,
    );
    assert.ok(
      !settledStatus,
      `settlement content says "not settled" but status is settled: ${content}`,
    );
  }
}

function makeExternalEpisode(
  overrides: Partial<LearningEpisode> = {},
): LearningEpisode {
  return {
    schemaVersion: 3 as any,
    episodeId: 'episode-ext-settlement-001',
    runtimeSessionId: 'runtime-ext-1',
    sourceFilePath: 'external://event/pi/pi-thread-1/evt-001',
    deliveryTurn: 4,
    completionEvidence: [
      {
        ref: 'external://event/pi/pi-thread-1/evt-001#turn-4:delivery',
        sourceFilePath: 'external://event/pi/pi-thread-1/evt-001',
        turn: 4,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered',
      },
    ],
    contradictionSignals: [],
    sourceEvidence: [{
      ref: 'external://event/pi/pi-thread-1/evt-001#turn-4:delivery',
      role: 'problem-action',
      content: 'User:\nDeliver the requested artifact.\n\nAssistant:\nThe artifact was delivered.',
      sourceFilePath: 'external://event/pi/pi-thread-1/evt-001',
      turn: 4,
    }],
    semanticObservations: [
      {
        kind: 'user-intent',
        value: 'deliver the requested artifact',
        sourceRefs: ['external://event/pi/pi-thread-1/evt-001#turn-4:delivery'],
      },
    ],
    settlementDeadline: '2026-01-01T00:00:00.000Z',
    status: 'settling',
    ...overrides,
  } as LearningEpisode;
}

function makeCandidate(episode: LearningEpisode): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: `episode-capability-${episode.episodeId}`,
    title: 'Capability: deliver the requested artifact',
    applicability: 'Applies when a similar task needs a verified artifact delivery.',
    actionPattern: 'Complete the user task: send_file: delivered',
    boundaries: ['Only apply when a new task matches the same user-facing capability.'],
    risks: ['This candidate is derived from one completed delivery attempt.'],
    solvedLoop: {
      problem: 'Deliver the requested artifact.',
      action: 'send_file: delivered',
      verification: `The episode settled at ${episode.settlementDeadline} without contradiction.`,
      noCorrection: 'No contradiction signal was present when the settlement deadline elapsed.',
    },
    provenance: [
      {
        filePath: episode.sourceFilePath,
        turn: episode.deliveryTurn,
        role: 'problem-action' as const,
        unitByteRange: { start: 0, end: 10 },
        provider: 'pi',
        threadId: 'pi-thread-1',
        contentHash: 'hash-ext-001',
      },
    ],
    generatedAt: episode.settlementDeadline,
    sourceUnit: {
      filePath: episode.sourceFilePath,
      byteRange: { start: 0, end: 10 },
      generatedAt: episode.settlementDeadline,
    },
  } as unknown as DistilledKnowledgeCandidate;
}

function makeSkillEvolutionStub(): SkillEvolutionRuntime {
  return {
    getRegistry: () => ({ schemaVersion: 2 as any, catalogRevision: 0, routeRedirects: {}, capabilities: {} }),
    getReferencedSkillSnapshots: () => [] as ReferencedSkillSnapshot[],
  } as unknown as SkillEvolutionRuntime;
}

const EXTERNAL_SOURCE_IDENTITY: SessionLogSourceIdentity = {
  sourceId: 'pi-source-1',
  label: 'External Source (pi)',
  category: 'external',
  provider: 'pi',
  reader: 'xurl',
};

const EXTERNAL_EVENT_IDENTITY: SourceEventIdentity = {
  eventId: 'agents://pi/pi-thread-1#3-6',
  position: 6,
  contentHash: 'hash-ext-001',
  conversationId: 'pi-thread-1',
  branchId: 'branch-1',
  revision: '1',
};

/**
 * Replicate the production admission capsule build: create the capsule from
 * the freshly-admitted (still-settling) episode using the same honest
 * settlement-evidence builder the production admission path uses.
 */
function admitExternalCapsule(
  capsuleStore: EvidenceCapsuleStore,
  episode: LearningEpisode,
): void {
  const bundleId = `v3:learning-episode:${episode.episodeId}`;
  if (capsuleStore.findByBundleId(bundleId)) return;
  const completionEvidence = episode.completionEvidence
    .filter(e => e.kind !== 'contradiction')
    .map(e => ({
      ref: e.ref,
      content: e.detail ?? `${e.kind} at turn ${e.turn}`,
      role: 'problem-action' as const,
      sourceFilePath: e.sourceFilePath,
      turn: e.turn,
    }));
  const settlement = buildEpisodeSettlementEvidence(episode);
  const capsule = buildEvidenceCapsule({
    sourceIdentity: EXTERNAL_SOURCE_IDENTITY,
    eventIdentity: EXTERNAL_EVENT_IDENTITY,
    episodeId: episode.episodeId,
    bundleId,
    completionEvidence,
    settlementEvidence: [
      {
        ref: settlement.ref,
        content: settlement.content,
        role: 'verification' as const,
        sourceFilePath: settlement.sourceFilePath,
        turn: settlement.turn,
      },
    ],
    semanticObservations: episode.semanticObservations,
    now: new Date('2025-12-31T00:00:00.000Z'),
  });
  capsuleStore.upsert(capsule);
}

/**
 * Replicate the production maturation refresh: after the episode matures,
 * re-derive settlement evidence from the authoritative status and update the
 * durable capsule in place (stable lifecycle-neutral ref, recomputed
 * fingerprint).
 */
function matureExternalCapsule(
  capsuleStore: EvidenceCapsuleStore,
  episode: LearningEpisode,
): void {
  const bundleId = `v3:learning-episode:${episode.episodeId}`;
  const settlement = buildEpisodeSettlementEvidence(episode);
  capsuleStore.refreshSettlementEvidence(bundleId, [settlement]);
}

describe('settlement-evidence consistency (external Pi/DeepSeek regression)', () => {
  test('capsule replay ignores settlement-only drift but rejects immutable evidence drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-upsert-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const settlingEpisode = makeExternalEpisode({ status: 'settling' });
      admitExternalCapsule(capsuleStore, settlingEpisode);
      const bundleId = `v3:learning-episode:${settlingEpisode.episodeId}`;
      const admissionCapsule = capsuleStore.findByBundleId(bundleId)!;

      matureExternalCapsule(capsuleStore, {
        ...settlingEpisode,
        status: 'eligible',
      });

      assert.doesNotThrow(() => capsuleStore.upsert(admissionCapsule));
      assert.equal(capsuleStore.count(), 1);
      assert.throws(
        () => capsuleStore.upsert({
          ...admissionCapsule,
          completionEvidence: admissionCapsule.completionEvidence.map((entry, index) => (
            index === 0 ? { ...entry, content: `${entry.content} changed` } : entry
          )),
        }),
        /immutable integrity conflict/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('admission capsule for a settling episode never labels it settled and exposes no contradiction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-admission-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const settlingEpisode = makeExternalEpisode({ status: 'settling' });

      admitExternalCapsule(capsuleStore, settlingEpisode);

      const bundleId = `v3:learning-episode:${settlingEpisode.episodeId}`;
      const capsule = capsuleStore.findByBundleId(bundleId)!;
      assert.ok(capsule, 'admission capsule must be persisted');
      const [settlement] = capsule.settlementEvidence;
      // The ref must be lifecycle-neutral; it must never claim :settled-.
      assert.match(settlement.ref, /:settlement-/);
      assert.doesNotMatch(settlement.ref, /:settled-/);
      // The content must honestly record the non-settled state.
      assert.match(settlement.content, /not settled/i);
      assert.match(settlement.content, /status: settling/i);
      assertNoSettlementContradiction(settlement.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reconstructed review bundle after maturation is internally consistent (eligible)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-maturation-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      const episodeStore = new LearningEpisodeStore(episodeStorePath);
      const clockNow = new Date('2026-01-02T00:00:00.000Z'); // past the deadline

      // 1. Admit the external episode while it is still settling (production
      //    admission boundary runs before maturation).
      const settlingEpisode = makeExternalEpisode({ status: 'settling' });
      episodeStore.upsert([settlingEpisode]);
      admitExternalCapsule(capsuleStore, settlingEpisode);

      // 2. Mature: settle the episode (zero settlement window -> eligible once
      //    the deadline has elapsed), then refresh the durable capsule to the
      //    authoritative status (the production runMaturation hook).
      const [matured] = settleLearningEpisodes([settlingEpisode], { now: clockNow });
      assert.equal(matured.status, 'eligible');
      episodeStore.upsert([matured]);
      matureExternalCapsule(capsuleStore, matured);

      // 3. Reconstruct the review bundle the way runReview does for external
      //    episodes: buildEpisodeEvidenceBundle with the capsule store + the
      //    external-origin predicate.
      const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        matured,
        makeCandidate(matured),
        makeSkillEvolutionStub(),
        capsuleStore,
        () => true,
      );

      // The reconstructed bundle must carry the authoritative, internally
      // consistent settlement evidence.
      assert.equal(bundle.settlementEvidence.length, 1);
      const [settlementRef] = bundle.settlementEvidence;
      assert.match(settlementRef.ref, /:settlement-/);
      assert.doesNotMatch(settlementRef.ref, /:settled-/);

      // sourceEvidence is populated by capsule reconstruction; the settlement
      // source content must agree with the matured status.
      assert.ok(bundle.sourceEvidence, 'capsule reconstruction must supply sourceEvidence');
      const settlementSource = bundle.sourceEvidence!.find(
        s => s.ref === settlementRef.ref,
      );
      assert.ok(settlementSource, 'settlement source evidence must be present');
      assert.match(settlementSource!.content, /settled at/i);
      assert.match(settlementSource!.content, /status: eligible/i);
      assertNoSettlementContradiction(settlementSource!.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a capsule admitted while settling and not yet matured stays honestly non-settled in any reconstructed bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-premature-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      // Admit while settling; do NOT mature (deadline still in the future).
      const settlingEpisode = makeExternalEpisode({
        status: 'settling',
        settlementDeadline: '2026-01-01T00:00:00.000Z',
      });
      admitExternalCapsule(capsuleStore, settlingEpisode);

      // Even if review somehow reconstructs from the not-yet-matured capsule,
      // the bundle must never label a settling episode as settled.
      const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        settlingEpisode,
        makeCandidate(settlingEpisode),
        makeSkillEvolutionStub(),
        capsuleStore,
        () => true,
      );

      assert.equal(bundle.settlementEvidence.length, 1);
      const [settlementRef] = bundle.settlementEvidence;
      assert.match(settlementRef.ref, /:settlement-/);
      assert.doesNotMatch(settlementRef.ref, /:settled-/);
      const settlementSource = bundle.sourceEvidence!.find(
        s => s.ref === settlementRef.ref,
      )!;
      assert.match(settlementSource.content, /not settled/i);
      assert.match(settlementSource.content, /status: settling/i);
      assertNoSettlementContradiction(settlementSource.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('local (non-capsule) review bundle uses the lifecycle-neutral settlement ref for an eligible episode', () => {
    const eligibleEpisode = makeExternalEpisode({ status: 'eligible' });
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
      eligibleEpisode,
      makeCandidate(eligibleEpisode),
      makeSkillEvolutionStub(),
    );
    const [settlement] = bundle.settlementEvidence;
    assert.match(settlement.ref, /:settlement-/);
    assert.doesNotMatch(settlement.ref, /:settled-/);
    assert.equal(settlement.sourceFilePath, eligibleEpisode.sourceFilePath);
    assert.equal(settlement.turn, eligibleEpisode.deliveryTurn);
  });

  test('buildEpisodeSettlementEvidence is honest for every LearningEpisode status', () => {
    const cases: Array<{ status: LearningEpisodeStatus; expectSettled: boolean }> = [
      { status: 'settling', expectSettled: false },
      { status: 'historical-pending', expectSettled: false },
      { status: 'historical-abandoned', expectSettled: false },
      { status: 'eligible', expectSettled: true },
      { status: 'contradicted', expectSettled: true },
    ];
    for (const { status, expectSettled } of cases) {
      const episode = makeExternalEpisode({ status });
      const evidence = buildEpisodeSettlementEvidence(episode);
      // The ref is always lifecycle-neutral and stable.
      assert.match(evidence.ref, /:settlement-/);
      assert.doesNotMatch(evidence.ref, /:settled-/);
      if (expectSettled) {
        assert.match(evidence.content, /settled at/i, `status ${status} should be settled`);
      } else {
        assert.match(evidence.content, /not settled/i, `status ${status} should not be settled`);
      }
      assertNoSettlementContradiction(evidence.content);
    }
  });

  test('maturation refresh is idempotent and keeps the stable ref (restart/resume)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-idempotent-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const settlingEpisode = makeExternalEpisode({ status: 'settling' });
      admitExternalCapsule(capsuleStore, settlingEpisode);

      const bundleId = `v3:learning-episode:${settlingEpisode.episodeId}`;
      const beforeAdmission = capsuleStore.findByBundleId(bundleId)!;
      const admissionRef = beforeAdmission.settlementEvidence[0]!.ref;

      // Mature once.
      const [matured] = settleLearningEpisodes([settlingEpisode], {
        now: new Date('2026-01-02T00:00:00.000Z'),
      });
      matureExternalCapsule(capsuleStore, matured);
      const afterFirst = capsuleStore.findByBundleId(bundleId)!;
      assert.equal(afterFirst.settlementEvidence[0]!.ref, admissionRef, 'ref must stay stable');
      assert.match(afterFirst.settlementEvidence[0]!.content, /status: eligible/i);

      // Mature again (restart/resume re-derives from the same authoritative
      // status); the ref must stay stable and the content idempotent.
      matureExternalCapsule(capsuleStore, matured);
      const afterSecond = capsuleStore.findByBundleId(bundleId)!;
      assert.equal(afterSecond.settlementEvidence[0]!.ref, admissionRef);
      assert.equal(
        afterSecond.settlementEvidence[0]!.content,
        afterFirst.settlementEvidence[0]!.content,
        'refresh must be idempotent',
      );
      assertNoSettlementContradiction(afterSecond.settlementEvidence[0]!.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Build a capsule that carries the PRE-FIX contradictory settlement evidence —
 * the exact durable state a capsule persisted before the settlement-
 * consistency fix could contain: a `:settled-` ref and `settled at <deadline>
 * (status: settling)` content while the episode is durably `eligible`.
 */
function buildPrefFixContradictoryCapsule(
  capsuleStore: EvidenceCapsuleStore,
  episode: LearningEpisode,
): void {
  const bundleId = `v3:learning-episode:${episode.episodeId}`;
  // The old (pre-fix) ref claimed `:settled-` unconditionally.
  const oldRef = `${episode.sourceFilePath}#episode-${episode.episodeId}:settled-${episode.settlementDeadline}`;
  // The old (pre-fix) content unconditionally labeled the episode settled.
  const oldContent = `Episode ${episode.episodeId} settled at ${episode.settlementDeadline} (status: settling)`;
  const completionEvidence = episode.completionEvidence
    .filter(e => e.kind !== 'contradiction')
    .map(e => ({
      ref: e.ref,
      content: e.detail ?? `${e.kind} at turn ${e.turn}`,
      role: 'problem-action' as const,
      sourceFilePath: e.sourceFilePath,
      turn: e.turn,
    }));
  const capsule = buildEvidenceCapsule({
    sourceIdentity: EXTERNAL_SOURCE_IDENTITY,
    eventIdentity: EXTERNAL_EVENT_IDENTITY,
    episodeId: episode.episodeId,
    bundleId,
    completionEvidence,
    settlementEvidence: [
      {
        ref: oldRef,
        content: oldContent,
        role: 'verification' as const,
        sourceFilePath: episode.sourceFilePath,
        turn: episode.deliveryTurn,
      },
    ],
    semanticObservations: episode.semanticObservations,
    now: new Date('2025-12-31T00:00:00.000Z'),
  });
  capsuleStore.upsert(capsule);
}

/**
 * Construct a real, restartable RuntimeLearning over a temp root with the
 * capsule store, episode store, and Skill Evolution review engine wired the
 * same way production startup does. External session-log discovery is disabled
 * so the wake cannot reach any live provider.
 */
function createReconcileRuntimeLearning(root: string): RuntimeLearning {
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const curatorStatePath = path.join(root, 'data', 'curator-state.json');
  const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');

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
    readerFixture: ({ shard, lane }) => ({
      findingSet: readShardStructurally(
        shard.shardId,
        shard.contentHash,
        shard.content,
        lane,
      ),
    }),
    authorFixture: ({ bundle }) => ({
      body: 'Deliver a report when requested and wait for user verification.',
      envelope: {
        decision: 'create_current_skill' as const,
        routingName: 'test-report-delivery',
        description: 'Deliver a report and wait for user verification.',
        referencedSkills: [],
        evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
      },
    }),
    verifierFixture: () => ({
      decision: 'accept' as const,
      transition: 'create_current_skill' as const,
      issues: [],
      rationale: 'The bounded report workflow is supported by the fixed artifact evidence.',
    }),
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
    settlementWindowMs: 0,
  });
  return new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor,
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator,
    planner,
  });
}

describe('settlement-evidence restart reconciliation (pre-fix durable state)', () => {
  test('a public wake reconciles a pre-fix contradictory capsule for an already-eligible external episode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-reconcile-'));
    try {
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      const episodeStore = new LearningEpisodeStore(episodeStorePath);
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'data', 'evidence-capsules.json'));

      // 1. Pre-seed the EXACT pre-fix durable state: an episode that is durably
      //    `eligible` (maturation already happened in a prior process) ...
      const eligibleEpisode = makeExternalEpisode({ status: 'eligible' });
      episodeStore.upsert([eligibleEpisode]);
      // 2. ... and a capsule persisted BEFORE the fix, carrying the contradictory
      //    `settled at <deadline> (status: settling)` content with a `:settled-`
      //    ref. On restart, runMaturation sees pre-status `eligible`, so the
      //    transition-based refresh never fires for this capsule.
      buildPrefFixContradictoryCapsule(capsuleStore, eligibleEpisode);

      const bundleId = `v3:learning-episode:${eligibleEpisode.episodeId}`;
      const beforeCapsule = capsuleStore.findByBundleId(bundleId)!;
      assert.ok(beforeCapsule, 'pre-fix contradictory capsule must be seeded');
      assert.match(beforeCapsule.settlementEvidence[0]!.content, /settled at/i);
      assert.match(beforeCapsule.settlementEvidence[0]!.content, /status: settling/i);
      assert.match(beforeCapsule.settlementEvidence[0]!.ref, /:settled-/);

      // 3. Construct the REAL production RuntimeLearning path and invoke a
      //    public wake (startup). This is the exact restart/recovery wiring;
      //    no manual refreshSettlementEvidence call.
      const runtimeLearning = createReconcileRuntimeLearning(root);
      // Copy the seeded capsule into the RuntimeLearning-owned capsule store
      // path (the constructor creates its own store over the same file).
      const rlCapsuleStore = runtimeLearning.getEvidenceCapsuleStore();
      assert.ok(rlCapsuleStore.findByBundleId(bundleId),
        'RuntimeLearning capsule store must load the seeded capsule');

      await runtimeLearning.wake('startup');

      // 4. The capsule must now be reconciled from the authoritative `eligible`
      //    status: lifecycle-neutral ref, `settled at ... (status: eligible)`,
      //    no contradiction.
      const afterCapsule = rlCapsuleStore.findByBundleId(bundleId)!;
      assert.ok(afterCapsule, 'reconciled capsule must still exist');
      const afterSettlement = afterCapsule.settlementEvidence[0]!;
      assert.doesNotMatch(afterSettlement.ref, /:settled-/);
      assert.match(afterSettlement.ref, /:settlement-/);
      assert.match(afterSettlement.content, /settled at/i);
      assert.match(afterSettlement.content, /status: eligible/i);
      assertNoSettlementContradiction(afterSettlement.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a public wake supersedes an active review job whose frozen basis carries the old contradictory settlement evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-job-reconcile-'));
    try {
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      const episodeStore = new LearningEpisodeStore(episodeStorePath);
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'data', 'evidence-capsules.json'));
      const reviewQueuePath = path.join(root, 'data', 'review-queue.json');

      // 1. Pre-seed the pre-fix durable state: eligible episode + contradictory
      //    capsule.
      const eligibleEpisode = makeExternalEpisode({ status: 'eligible' });
      episodeStore.upsert([eligibleEpisode]);
      buildPrefFixContradictoryCapsule(capsuleStore, eligibleEpisode);

      const bundleId = `v3:learning-episode:${eligibleEpisode.episodeId}`;

      // 2. Construct the RuntimeLearning and, before the wake, create an
      //    ACTIVE Evidence Review Job whose frozen bundle was copied from the
      //    old contradictory capsule — the exact state an already-running
      //    review would be in at restart.
      const runtimeLearning = createReconcileRuntimeLearning(root);
      const skillEvolution = runtimeLearning.getSkillEvolution();
      const rlCapsuleStore = runtimeLearning.getEvidenceCapsuleStore();
      const staleBundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        eligibleEpisode,
        makeCandidate(eligibleEpisode),
        skillEvolution,
        rlCapsuleStore,
        () => true,
      );
      // The frozen bundle's settlement source evidence must carry the old
      // contradiction.
      const staleSettlementSource = staleBundle.sourceEvidence!.find(
        s => s.ref === staleBundle.settlementEvidence[0]!.ref,
      )!;
      assert.match(staleSettlementSource.content, /settled at/i);
      assert.match(staleSettlementSource.content, /status: settling/i);

      const staleJob = skillEvolution.enqueueReview(staleBundle);
      assert.equal(staleJob.disposition, 'active');

      // 3. Invoke the public wake (the real restart/recovery wiring).
      await runtimeLearning.wake('startup');

      // 4. The old job must be superseded; a clean successor must exist with
      //    a fresh basis built from the reconciled capsule.
      const engine = skillEvolution.getEvidenceReviewEngine();
      const jobs = Object.values(engine.loadStore().jobs);
      const superseded = jobs.find(j => j.jobId === staleJob.jobId);
      assert.ok(superseded, 'old job must still be present');
      assert.equal(superseded!.disposition, 'superseded');
      assert.ok(superseded!.successorJobId, 'superseded job must link a successor');
      const successor = jobs.find(j => j.jobId === superseded!.successorJobId);
      assert.ok(successor, 'successor job must exist');
      assert.equal(successor!.disposition, 'active');
      assert.equal(successor!.parentJobId, staleJob.jobId);

      // 5. The successor's frozen bundle settlement evidence must be consistent
      //    with the authoritative `eligible` status — no contradiction.
      const successorSettlementSource = successor!.bundle.sourceEvidence!.find(
        s => s.ref === successor!.bundle.settlementEvidence[0]!.ref,
      );
      assert.ok(successorSettlementSource, 'successor bundle must carry settlement source evidence');
      assert.match(successorSettlementSource!.content, /settled at/i);
      assert.match(successorSettlementSource!.content, /status: eligible/i);
      assertNoSettlementContradiction(successorSettlementSource!.content);

      // 6. The reconciled capsule must also be consistent.
      const afterCapsule = rlCapsuleStore.findByBundleId(bundleId)!;
      const afterSettlement = afterCapsule.settlementEvidence[0]!;
      assert.doesNotMatch(afterSettlement.ref, /:settled-/);
      assert.match(afterSettlement.content, /status: eligible/i);
      assertNoSettlementContradiction(afterSettlement.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a public wake supersedes a stale active job even when the capsule was already refreshed in a prior crashed wake (post-refresh/pre-supersede crash window)', async () => {
    // Crash window: process A refreshes the contradictory capsule successfully,
    // then crashes BEFORE superseding the stale active job whose frozen bundle
    // still carries the pre-fix `:settled-` ref and `settled ... status:
    // settling` content. On process B restart the capsule already matches the
    // authoritative `eligible` status, so the capsule-refresh step is an
    // idempotent no-op and must NOT short-circuit the job supersession scan.
    // The active job must still be compared against the current authoritative
    // reconstruction and superseded by a clean successor.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-crashwindow-'));
    try {
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      const episodeStore = new LearningEpisodeStore(episodeStorePath);
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'data', 'evidence-capsules.json'));

      // 1. Pre-seed the durably-eligible external episode (maturation already
      //    happened in a prior process).
      const eligibleEpisode = makeExternalEpisode({ status: 'eligible' });
      episodeStore.upsert([eligibleEpisode]);
      const bundleId = `v3:learning-episode:${eligibleEpisode.episodeId}`;

      // 2. Persist the PRE-FIX contradictory capsule so the frozen bundle can
      //    be built from it (the stale active job's basis).
      buildPrefFixContradictoryCapsule(capsuleStore, eligibleEpisode);

      // 3. Process A: construct the real RuntimeLearning and create the ACTIVE
      //    review job whose frozen bundle was copied from the old contradictory
      //    capsule — the exact state an already-running review would be in.
      const processA = createReconcileRuntimeLearning(root);
      const skillEvolutionA = processA.getSkillEvolution();
      const capsuleStoreA = processA.getEvidenceCapsuleStore();
      const staleBundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        eligibleEpisode,
        makeCandidate(eligibleEpisode),
        skillEvolutionA,
        capsuleStoreA,
        () => true,
      );
      // The frozen bundle's settlement source evidence must carry the old
      // contradiction (the pre-fix durable state).
      const staleSettlementSource = staleBundle.sourceEvidence!.find(
        s => s.ref === staleBundle.settlementEvidence[0]!.ref,
      )!;
      assert.match(staleSettlementSource.content, /settled at/i);
      assert.match(staleSettlementSource.content, /status: settling/i);
      assert.match(staleBundle.settlementEvidence[0]!.ref, /:settled-/);
      const staleJob = skillEvolutionA.enqueueReview(staleBundle);
      assert.equal(staleJob.disposition, 'active');

      // 4. Process A refreshes the capsule successfully (the capsule-refresh
      //    step of reconcileSettlementConsistency), then crashes BEFORE the
      //    job-supersession step. Simulate exactly that: re-derive the
      //    authoritative settlement evidence and durably refresh the capsule,
      //    then do NOT call wake again on process A.
      const authoritativeSettlement = buildEpisodeSettlementEvidence(eligibleEpisode);
      capsuleStoreA.refreshSettlementEvidence(bundleId, [authoritativeSettlement]);

      // The crash-window durable state: capsule is already clean (matches the
      // authoritative `eligible` status) ...
      const cleanCapsule = capsuleStoreA.findByBundleId(bundleId)!;
      assert.doesNotMatch(cleanCapsule.settlementEvidence[0]!.ref, /:settled-/);
      assert.match(cleanCapsule.settlementEvidence[0]!.content, /status: eligible/i);
      assertNoSettlementContradiction(cleanCapsule.settlementEvidence[0]!.content);
      // ... but the active job's frozen basis still carries the old
      // contradiction.
      const engineA = skillEvolutionA.getEvidenceReviewEngine();
      const frozenJob = Object.values(engineA.loadStore().jobs).find(j => j.jobId === staleJob.jobId)!;
      assert.equal(frozenJob.disposition, 'active');
      const frozenSettlementSource = frozenJob.bundle.sourceEvidence!.find(
        s => s.ref === frozenJob.bundle.settlementEvidence[0]!.ref,
      )!;
      assert.match(frozenSettlementSource.content, /status: settling/i);
      assert.match(frozenJob.bundle.settlementEvidence[0]!.ref, /:settled-/);

      // 5. Process B restart: construct a FRESH RuntimeLearning over the same
      //    durable root (loads the already-clean capsule and the stale active
      //    job) and invoke the public wake. The capsule-refresh step is an
      //    idempotent no-op, so this is the exact crash-window recovery path.
      const processB = createReconcileRuntimeLearning(root);
      const skillEvolutionB = processB.getSkillEvolution();
      const capsuleStoreB = processB.getEvidenceCapsuleStore();
      // The restarted store must observe the already-clean capsule (proof that
      // the capsule-refresh step will be an idempotent no-op this wake).
      const preWakeCapsule = capsuleStoreB.findByBundleId(bundleId)!;
      assert.doesNotMatch(preWakeCapsule.settlementEvidence[0]!.ref, /:settled-/);
      assert.match(preWakeCapsule.settlementEvidence[0]!.content, /status: eligible/i);

      await processB.wake('startup');

      // 6. The stale active job must be superseded regardless of the capsule
      //    already being clean, and a clean successor must be the only runnable
      //    basis.
      const engineB = skillEvolutionB.getEvidenceReviewEngine();
      const jobs = Object.values(engineB.loadStore().jobs);
      const superseded = jobs.find(j => j.jobId === staleJob.jobId);
      assert.ok(superseded, 'stale job must still be present after restart');
      assert.equal(superseded!.disposition, 'superseded');
      assert.ok(superseded!.successorJobId, 'superseded job must link a successor');
      const successor = jobs.find(j => j.jobId === superseded!.successorJobId);
      assert.ok(successor, 'clean successor job must exist');
      assert.equal(successor!.disposition, 'active');
      assert.equal(successor!.parentJobId, staleJob.jobId);

      // 7. The successor's frozen bundle settlement evidence must be consistent
      //    with the authoritative `eligible` status — lifecycle-neutral ref,
      //    no contradiction.
      const successorSettlementRef = successor!.bundle.settlementEvidence[0]!;
      assert.doesNotMatch(successorSettlementRef.ref, /:settled-/);
      assert.match(successorSettlementRef.ref, /:settlement-/);
      const successorSettlementSource = successor!.bundle.sourceEvidence!.find(
        s => s.ref === successorSettlementRef.ref,
      );
      assert.ok(successorSettlementSource, 'successor bundle must carry settlement source evidence');
      assert.match(successorSettlementSource!.content, /settled at/i);
      assert.match(successorSettlementSource!.content, /status: eligible/i);
      assertNoSettlementContradiction(successorSettlementSource!.content);

      // 8. No other active runnable job may exist for this bundle (the clean
      //    successor is the only runnable basis).
      const activeForBundle = jobs.filter(
        j => j.disposition === 'active'
          && j.bundle.bundleId === bundleId,
      );
      assert.equal(activeForBundle.length, 1, 'exactly one active job for the bundle (the clean successor)');
      assert.equal(activeForBundle[0]!.jobId, successor!.jobId);

      // 9. The capsule must remain clean and idempotent across the restart.
      const afterCapsule = capsuleStoreB.findByBundleId(bundleId)!;
      const afterSettlement = afterCapsule.settlementEvidence[0]!;
      assert.doesNotMatch(afterSettlement.ref, /:settled-/);
      assert.match(afterSettlement.content, /status: eligible/i);
      assertNoSettlementContradiction(afterSettlement.content);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a public wake recovers a durably deferred review job whose frozen basis carries the old contradictory settlement evidence', async () => {
    // Same root cause as the active-job recovery, but the job already reached
    // the durable `disposition: deferred` terminal state because the Verifier
    // semantically deferred on the fabricated `settled at ... (status:
    // settling)` contradiction frozen into its Review Basis. A deferred job is
    // treated as a bundle owner by getReviewedOrQueuedBundleIds() (so the
    // episode is never re-admitted for review) and is never executed by fair
    // scheduling (only active jobs advance). Without recovery it remains
    // permanently stuck even after the capsule is repaired.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-deferred-'));
    try {
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      const episodeStore = new LearningEpisodeStore(episodeStorePath);
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'data', 'evidence-capsules.json'));

      // 1. Pre-seed the durably-eligible external episode (maturation already
      //    happened in a prior process).
      const eligibleEpisode = makeExternalEpisode({ status: 'eligible' });
      episodeStore.upsert([eligibleEpisode]);
      const bundleId = `v3:learning-episode:${eligibleEpisode.episodeId}`;
      // 2. Persist the PRE-FIX contradictory capsule so the frozen bundle can
      //    be built from it (the stale deferred job's basis).
      buildPrefFixContradictoryCapsule(capsuleStore, eligibleEpisode);

      // 3. Construct the RuntimeLearning and, before the wake, create an
      //    Evidence Review Job whose frozen bundle was copied from the old
      //    contradictory capsule, then durably transition it to the deferred
      //    terminal state — the exact state a review that reached the Verifier
      //    and was semantically deferred on the contradiction would be in at
      //    restart.
      const runtimeLearning = createReconcileRuntimeLearning(root);
      const skillEvolution = runtimeLearning.getSkillEvolution();
      const rlCapsuleStore = runtimeLearning.getEvidenceCapsuleStore();
      const staleBundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        eligibleEpisode,
        makeCandidate(eligibleEpisode),
        skillEvolution,
        rlCapsuleStore,
        () => true,
      );
      // The frozen bundle's settlement source evidence must carry the old
      // contradiction.
      const staleSettlementSource = staleBundle.sourceEvidence!.find(
        s => s.ref === staleBundle.settlementEvidence[0]!.ref,
      )!;
      assert.match(staleSettlementSource.content, /settled at/i);
      assert.match(staleSettlementSource.content, /status: settling/i);
      assert.match(staleBundle.settlementEvidence[0]!.ref, /:settled-/);

      const seededJob = skillEvolution.enqueueReview(staleBundle);
      assert.equal(seededJob.disposition, 'active');

      // Durably transition the seeded job to `deferred` (the Verifier's
      // semantic deferral on the contradictory frozen basis), persisted to the
      // job store so the fresh RuntimeLearning on restart observes the
      // terminal deferred state.
      const engine = skillEvolution.getEvidenceReviewEngine();
      const deferredState = engine.loadStore();
      const deferredJob = deferredState.jobs[seededJob.jobId]!;
      deferredJob.disposition = 'deferred';
      deferredJob.terminalReason = 'Verifier deferred: settlement evidence contradicts itself (settled at ... status: settling)';
      engine.saveStore(deferredState);
      const reloadedDeferred = engine.loadStore().jobs[seededJob.jobId]!;
      assert.equal(reloadedDeferred.disposition, 'deferred');

      // 4. Invoke the public wake (the real restart/recovery wiring).
      await runtimeLearning.wake('startup');

      // 5. The old deferred job must be audibly superseded; exactly one clean
      //    active successor must own the bundle.
      const jobsAfter = Object.values(engine.loadStore().jobs);
      const superseded = jobsAfter.find(j => j.jobId === seededJob.jobId)!;
      assert.ok(superseded, 'old deferred job must still be present');
      assert.equal(superseded!.disposition, 'superseded');
      assert.ok(superseded!.successorJobId, 'superseded deferred job must link a successor');
      const successor = jobsAfter.find(j => j.jobId === superseded!.successorJobId);
      assert.ok(successor, 'clean successor job must exist');
      assert.equal(successor!.disposition, 'active');
      assert.equal(successor!.parentJobId, seededJob.jobId);

      // The successor's frozen bundle settlement evidence must be consistent
      // with the authoritative `eligible` status — lifecycle-neutral ref,
      // no contradiction.
      const successorSettlementRef = successor!.bundle.settlementEvidence[0]!;
      assert.doesNotMatch(successorSettlementRef.ref, /:settled-/);
      assert.match(successorSettlementRef.ref, /:settlement-/);
      const successorSettlementSource = successor!.bundle.sourceEvidence!.find(
        s => s.ref === successorSettlementRef.ref,
      );
      assert.ok(successorSettlementSource, 'successor bundle must carry settlement source evidence');
      assert.match(successorSettlementSource!.content, /settled at/i);
      assert.match(successorSettlementSource!.content, /status: eligible/i);
      assertNoSettlementContradiction(successorSettlementSource!.content);

      // Exactly one active job for the bundle (the clean successor).
      const activeForBundle = jobsAfter.filter(
        j => j.disposition === 'active' && j.bundle.bundleId === bundleId,
      );
      assert.equal(activeForBundle.length, 1, 'exactly one active job for the bundle (the clean successor)');
      assert.equal(activeForBundle[0]!.jobId, successor!.jobId);

      // 6. The clean capsule must stay unchanged (no double mutation).
      const afterCapsule = rlCapsuleStore.findByBundleId(bundleId)!;
      const afterSettlement = afterCapsule.settlementEvidence[0]!;
      assert.doesNotMatch(afterSettlement.ref, /:settled-/);
      assert.match(afterSettlement.content, /status: eligible/i);
      assertNoSettlementContradiction(afterSettlement.content);

      // 7. Restart idempotency: a second fresh wake must not create a duplicate
      //    successor. The deferred job is now superseded (not deferred), and the
      //    active successor's basis already matches the authoritative capsule.
      const runtimeLearning2 = createReconcileRuntimeLearning(root);
      await runtimeLearning2.wake('startup');
      const engine2 = runtimeLearning2.getSkillEvolution().getEvidenceReviewEngine();
      const jobsAfter2 = Object.values(engine2.loadStore().jobs);
      const activeForBundle2 = jobsAfter2.filter(
        j => j.disposition === 'active' && j.bundle.bundleId === bundleId,
      );
      assert.equal(activeForBundle2.length, 1, 'second wake must not create a duplicate active successor');
      assert.equal(activeForBundle2[0]!.jobId, successor!.jobId);
      // The originally-deferred job stays superseded (not re-deferred).
      const resuperseded = jobsAfter2.find(j => j.jobId === seededJob.jobId)!;
      assert.equal(resuperseded.disposition, 'superseded');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a legitimate deferred job whose settlement evidence equals the authoritative capsule is not reopened', async () => {
    // Control: a deferred job whose frozen basis already carries the current,
    // authoritative settlement evidence (lifecycle-neutral ref + `status:
    // eligible` content matching the capsule) is a legitimate semantic
    // deferral. Recovery must NOT reopen it: the structural-equality check
    // skips it, so no successor is created and the deferred job stays deferred.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-settlement-legit-deferred-'));
    try {
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      const episodeStore = new LearningEpisodeStore(episodeStorePath);
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'data', 'evidence-capsules.json'));

      // 1. Pre-seed the durably-eligible external episode with a CLEAN capsule
      //    (already reconciled to the authoritative `eligible` status). Admit the
      //    capsule from the already-eligible episode so it carries the honest,
      //    authoritative settlement evidence.
      const eligibleEpisode = makeExternalEpisode({ status: 'eligible' });
      episodeStore.upsert([eligibleEpisode]);
      const bundleId = `v3:learning-episode:${eligibleEpisode.episodeId}`;
      admitExternalCapsule(capsuleStore, eligibleEpisode);
      const cleanCapsule = capsuleStore.findByBundleId(bundleId)!;
      assert.ok(cleanCapsule, 'clean admission capsule must be seeded');
      assert.doesNotMatch(cleanCapsule.settlementEvidence[0]!.ref, /:settled-/);
      assert.match(cleanCapsule.settlementEvidence[0]!.content, /status: eligible/i);

      // 2. Construct the RuntimeLearning and create an Evidence Review Job
      //    whose frozen bundle is built from the clean capsule (current
      //    authoritative settlement evidence), then durably transition it to
      //    `deferred` — a legitimate semantic deferral (the Verifier deferred
      //    for a non-settlement reason, e.g. awaiting more evidence).
      const runtimeLearning = createReconcileRuntimeLearning(root);
      const skillEvolution = runtimeLearning.getSkillEvolution();
      const rlCapsuleStore = runtimeLearning.getEvidenceCapsuleStore();
      const cleanBundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        eligibleEpisode,
        makeCandidate(eligibleEpisode),
        skillEvolution,
        rlCapsuleStore,
        () => true,
      );
      // The frozen bundle's settlement evidence must be current (matches the
      // authoritative capsule).
      const cleanSettlementRef = cleanBundle.settlementEvidence[0]!;
      assert.doesNotMatch(cleanSettlementRef.ref, /:settled-/);
      assert.match(cleanSettlementRef.ref, /:settlement-/);
      const cleanSettlementSource = cleanBundle.sourceEvidence!.find(
        s => s.ref === cleanSettlementRef.ref,
      )!;
      assert.match(cleanSettlementSource.content, /status: eligible/i);

      const seededJob = skillEvolution.enqueueReview(cleanBundle);
      const engine = skillEvolution.getEvidenceReviewEngine();
      const deferredState = engine.loadStore();
      const deferredJob = deferredState.jobs[seededJob.jobId]!;
      deferredJob.disposition = 'deferred';
      deferredJob.terminalReason = 'Verifier deferred: awaiting additional usage evidence';
      engine.saveStore(deferredState);
      const reloadedDeferred = engine.loadStore().jobs[seededJob.jobId]!;
      assert.equal(reloadedDeferred.disposition, 'deferred');

      // 3. Invoke the public wake.
      await runtimeLearning.wake('startup');

      // 4. The legitimate deferred job must NOT be reopened: it stays deferred
      //    with no successor, because its frozen basis already equals the
      //    authoritative capsule.
      const jobsAfter = Object.values(engine.loadStore().jobs);
      const stillDeferred = jobsAfter.find(j => j.jobId === seededJob.jobId)!;
      assert.equal(stillDeferred.disposition, 'deferred', 'legitimate deferred job must not be reopened');
      assert.ok(!stillDeferred.successorJobId, 'legitimate deferred job must not link a successor');
      const successors = jobsAfter.filter(
        j => j.disposition === 'active' && j.bundle.bundleId === bundleId,
      );
      assert.equal(successors.length, 0, 'no clean successor must be created for a legitimate deferral');

      // The clean capsule must stay unchanged.
      const afterCapsule = rlCapsuleStore.findByBundleId(bundleId)!;
      assert.equal(
        afterCapsule.settlementEvidence[0]!.content,
        cleanCapsule.settlementEvidence[0]!.content,
        'legitimate deferred capsule must be untouched',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

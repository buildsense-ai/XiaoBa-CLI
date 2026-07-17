/**
 * Issue #106 — multi-shard dual-lane coverage through public RuntimeLearning.wake().
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisode, LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import {
  SkillEvolutionRuntime,
  type SkillDraft,
  type SkillVerifierResult,
} from '../src/utils/skill-evolution';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import { readShardStructurally } from '../src/utils/evidence-review-engine';
import {
  loadEvidenceReviewJobStore,
  evidenceReviewJobStorePathForReviewQueue,
  buildEvidenceReviewDiagnostics,
} from '../src/utils/evidence-review-job-store';
import { shardEvidenceBundle } from '../src/utils/evidence-review';
import { acceptReviewObligations } from './evidence-review-test-fixtures';

interface TestEnv {
  root: string;
  reviewQueuePath: string;
  auditPath: string;
  jobStorePath: string;
  runtimeLearning: RuntimeLearning;
  skillEvolution: SkillEvolutionRuntime;
  branchCalls: { author: number; verifier: number };
  teardown: () => void;
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-review-106-'));
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const jobStorePath = evidenceReviewJobStorePathForReviewQueue(reviewQueuePath);
  const branchCalls = { author: 0, verifier: 0 };

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
    // Explicit test fixture — production default is model-backed.
    readerFixture: ({ shard, lane }) => ({
      findingSet: readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane),
    }),
    authorFixture: ({ bundle }): SkillDraft => {
      branchCalls.author += 1;
      const episode = bundle.episode as { authorEvidenceDossier?: { complete?: boolean; coveredShardIds?: string[] } };
      assert.ok(episode?.authorEvidenceDossier, 'Author receives dossier');
      assert.equal(episode.authorEvidenceDossier.complete, true);
      assert.ok((episode.authorEvidenceDossier.coveredShardIds?.length ?? 0) >= 2);
      return {
        body: [
          '# Multi Shard Delivery',
          '',
          'Deliver a validated multi-section report from complete dual-lane evidence.',
        ].join('\n'),
        envelope: {
          decision: 'create_current_skill',
          routingName: 'multi-shard-delivery',
          description: 'Deliver a multi-shard validated report.',
          referencedSkills: [],
          evidenceRefs: ['multi-shard.jsonl#1'],
          rationale: 'Complete dual-lane coverage supports the draft.',
        },
      };
    },
    verifierFixture: ({ bundle, draft }): SkillVerifierResult => {
      branchCalls.verifier += 1;
      const episode = bundle.episode as {
        verifierEvidenceDossier?: { complete?: boolean };
        reviewObligations?: unknown[];
      };
      assert.ok(episode?.verifierEvidenceDossier?.complete);
      assert.ok(Array.isArray(episode?.reviewObligations));
      assert.equal(draft.envelope.routingName, 'multi-shard-delivery');
      return {
        decision: 'accept',
        transition: 'create_current_skill',
        issues: [],
        rationale: 'All shards covered; obligations dispositioned.',
        registryReadSet: [],
        obligationDispositions: acceptReviewObligations(bundle),
      };
    },
  });

  const episodeStore = new LearningEpisodeStore(episodeStorePath);
  const runtimeLearning = new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor: new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 }),
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator: null,
    planner: new DueWorkPlanner({
      learningEpisodeStorePath: episodeStorePath,
      reviewQueuePath,
      curatorStatePath: path.join(root, 'data', 'curator-state.json'),
      curatorIntervalMs: 24 * 60 * 60 * 1000,
      semanticReassessmentManifestPath: reassessmentManifestPath,
    }),
    sessionLogSources: [],
  });

  return {
    root,
    reviewQueuePath,
    auditPath,
    jobStorePath,
    runtimeLearning,
    skillEvolution,
    branchCalls,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function multiShardEpisode(): LearningEpisode {
  // Keep semantic observations within Evidence Bundle validation bounds; force
  // multi-shard via preferSingleShardWhenFits: false + low soft limit instead.
  return {
    schemaVersion: 3,
    episodeId: 'episode-multi-shard',
    runtimeSessionId: 'runtime-multi-shard',
    sourceFilePath: 'multi-shard.jsonl',
    deliveryTurn: 1,
    completionEvidence: [
      {
        ref: 'multi-shard.jsonl#1',
        sourceFilePath: 'multi-shard.jsonl',
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered section A',
      },
      {
        ref: 'multi-shard.jsonl#2',
        sourceFilePath: 'multi-shard.jsonl',
        turn: 2,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered section B',
      },
    ],
    contradictionSignals: [],
    semanticObservations: [
      {
        kind: 'user-intent',
        value: 'Deliver a multi-section validated report.',
        sourceRefs: ['multi-shard.jsonl#intent'],
      },
      {
        kind: 'verification',
        value: 'Prefer concise sections and confirm delivery.',
        sourceRefs: ['multi-shard.jsonl#verify'],
      },
    ],
    settlementDeadline: new Date(0).toISOString(),
    status: 'eligible',
  };
}

describe('Evidence Review Job — multi-shard (#106)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.teardown();
  });

  test('deterministic multi-shard partition covers every domain unit', () => {
    const episode = multiShardEpisode();
    const bundle = {
      bundleId: 'v3:learning-episode:episode-multi-shard',
      episode,
      completionEvidence: episode.completionEvidence,
      settlementEvidence: [],
      boundedContinuity: [{ note: 'prior context ' + 'C'.repeat(200) }],
      referencedSkills: [],
      relatedCurrentSkills: [],
      semanticObservations: episode.semanticObservations,
    };
    const forced = shardEvidenceBundle(bundle as any, {
      preferSingleShardWhenFits: false,
      softLimitBytes: 1_000,
      hardLimitBytes: 2_000,
    });
    assert.ok(forced.shards.length >= 2, `expected multi-shard, got ${forced.shards.length}`);
    assert.equal(forced.manifest.shardIds.length, forced.shards.length);
    for (const shard of forced.shards) {
      assert.equal(shard.contentHash.length, 64);
      assert.ok(forced.manifest.shardIds.includes(shard.shardId));
    }
  });

  test('public wake dual-lane covers every shard and commits without truncation', async () => {
    const episode = multiShardEpisode();
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [episode.episodeId]: episode },
    });

    // Force multi-shard by lowering soft limit on the engine's next job creation.
    // Monkey-patch ensureJob via engine.createJob options through createJob wrapper.
    const engine = env.skillEvolution.getEvidenceReviewEngine();
    const originalEnsure = engine.ensureJob.bind(engine);
    engine.ensureJob = (input: any) => originalEnsure({
      ...input,
      sharding: {
        preferSingleShardWhenFits: false,
        softLimitBytes: 800,
        hardLimitBytes: 1_600,
      },
    });

    const result = await env.runtimeLearning.wake('manual');
    assert.equal(result.review.status, 'succeeded');
    assert.equal(result.review.reviewedEpisodes, 1);
    assert.equal(env.branchCalls.author, 1);
    assert.equal(env.branchCalls.verifier, 1);

    const store = loadEvidenceReviewJobStore(env.jobStorePath);
    const job = Object.values(store.jobs)[0]!;
    assert.ok(job.manifest.shardIds.length >= 2, `job shards=${job.manifest.shardIds.length}`);
    assert.equal(job.disposition, 'completed');
    assert.equal(job.authorDossier?.complete, true);
    assert.equal(job.verifierDossier?.complete, true);
    assert.equal(job.authorDossier?.coveredShardIds.length, job.manifest.shardIds.length);
    assert.equal(job.verifierDossier?.coveredShardIds.length, job.manifest.shardIds.length);

    const authorReaders = Object.values(job.quanta).filter(q => q.kind === 'author_reader');
    const verifierReaders = Object.values(job.quanta).filter(q => q.kind === 'verifier_reader');
    assert.equal(authorReaders.length, job.manifest.shardIds.length);
    assert.equal(verifierReaders.length, job.manifest.shardIds.length);
    assert.ok(authorReaders.every(q => q.state === 'succeeded'));
    assert.ok(verifierReaders.every(q => q.state === 'succeeded'));

    const diagnostics = buildEvidenceReviewDiagnostics(job);
    assert.equal(diagnostics.authorCoveredShards, diagnostics.shardCount);
    assert.equal(diagnostics.verifierCoveredShards, diagnostics.shardCount);

    const auditLines = fs.readFileSync(env.auditPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(auditLines.length, 1);
  });
});

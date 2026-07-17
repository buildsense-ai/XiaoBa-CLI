/**
 * Issue #105 — one-shard Evidence Review Job tracer through public RuntimeLearning.wake().
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
  type EvidenceBundle,
  type SkillDraft,
  type SkillVerifierResult,
} from '../src/utils/skill-evolution';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import {
  loadEvidenceReviewJobStore,
  evidenceReviewJobStorePathForReviewQueue,
  buildEvidenceReviewDiagnostics,
} from '../src/utils/evidence-review-job-store';
import { shardEvidenceBundle } from '../src/utils/evidence-sharding';
import { createEvidenceReviewJob } from '../src/utils/evidence-review-graph';
import { readShardStructurally } from '../src/utils/evidence-review-engine';

interface TestEnv {
  root: string;
  episodeStorePath: string;
  reviewQueuePath: string;
  registryPath: string;
  auditPath: string;
  jobStorePath: string;
  runtimeLearning: RuntimeLearning;
  skillEvolution: SkillEvolutionRuntime;
  branchCalls: { author: number; verifier: number };
  teardown: () => void;
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-review-105-'));
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
      const episode = bundle.episode as { authorEvidenceDossier?: unknown };
      assert.ok(episode?.authorEvidenceDossier, 'Skill Author receives Author Evidence Dossier context');
      return {
        body: [
          '# One Shard Delivery',
          '',
          'Deliver a small validated artifact when the user asks for a short report.',
          '',
          '## Steps',
          '1. Confirm the request is a bounded delivery.',
          '2. Send the file through the approved channel.',
        ].join('\n'),
        envelope: {
          decision: 'create_current_skill',
          routingName: 'one-shard-delivery',
          description: 'Deliver a bounded one-shard report artifact.',
          referencedSkills: [],
          evidenceRefs: ['one-shard.jsonl#1'],
          rationale: 'Evidence supports a bounded delivery skill.',
        },
      };
    },
    verifierFixture: ({ bundle, draft }): SkillVerifierResult => {
      branchCalls.verifier += 1;
      const episode = bundle.episode as {
        authorEvidenceDossier?: unknown;
        verifierEvidenceDossier?: unknown;
        dossierDifferenceIndex?: unknown;
        reviewObligations?: unknown;
      };
      assert.ok(episode?.authorEvidenceDossier, 'Verifier receives Author Dossier');
      assert.ok(episode?.verifierEvidenceDossier, 'Verifier receives Verifier Dossier');
      assert.ok(episode?.dossierDifferenceIndex, 'Verifier receives Difference Index');
      assert.ok(Array.isArray(episode?.reviewObligations), 'Verifier receives Review Obligations');
      assert.equal(draft.envelope.routingName, 'one-shard-delivery');
      return {
        decision: 'accept',
        transition: 'create_current_skill',
        issues: [],
        rationale: 'Dual-lane coverage and obligations support the draft.',
        registryReadSet: [],
      };
    },
  });

  const episodeStore = new LearningEpisodeStore(episodeStorePath);
  const planner = new DueWorkPlanner({
    learningEpisodeStorePath: episodeStorePath,
    reviewQueuePath,
    curatorStatePath: path.join(root, 'data', 'curator-state.json'),
    curatorIntervalMs: 24 * 60 * 60 * 1000,
    semanticReassessmentManifestPath: reassessmentManifestPath,
  });
  const evidenceIngestor = new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 });
  const runtimeLearning = new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor,
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator: null,
    planner,
    sessionLogSources: [],
  });

  return {
    root,
    episodeStorePath,
    reviewQueuePath,
    registryPath,
    auditPath,
    jobStorePath,
    runtimeLearning,
    skillEvolution,
    branchCalls,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function oneShardEpisode(episodeId = 'episode-one-shard'): LearningEpisode {
  return {
    schemaVersion: 3,
    episodeId,
    runtimeSessionId: 'runtime-one-shard',
    sourceFilePath: 'one-shard.jsonl',
    deliveryTurn: 1,
    completionEvidence: [{
      ref: 'one-shard.jsonl#1',
      sourceFilePath: 'one-shard.jsonl',
      turn: 1,
      kind: 'artifact-delivery',
      detail: 'send_file: delivered',
    }],
    contradictionSignals: [],
    semanticObservations: [{
      kind: 'user-intent',
      value: 'Deliver a short validated report.',
      sourceRefs: ['one-shard.jsonl#intent'],
    }],
    settlementDeadline: new Date(0).toISOString(),
    status: 'eligible',
  };
}

describe('Evidence Review Job — one-shard tracer (#105)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.teardown();
  });

  test('deterministic sharding yields one content-addressed shard for a small bundle', () => {
    const bundle: EvidenceBundle = {
      bundleId: 'v3:learning-episode:episode-one-shard',
      episode: oneShardEpisode(),
      completionEvidence: [{
        ref: 'one-shard.jsonl#1',
        sourceFilePath: 'one-shard.jsonl',
        turn: 1,
        kind: 'artifact-delivery',
        detail: 'send_file: delivered',
      }],
      settlementEvidence: [],
      boundedContinuity: [],
      referencedSkills: [],
      relatedCurrentSkills: [],
      semanticObservations: [{
        kind: 'user-intent',
        value: 'Deliver a short validated report.',
        sourceRefs: ['one-shard.jsonl#intent'],
      }],
    };
    const { manifest, shards } = shardEvidenceBundle(bundle);
    assert.equal(shards.length, 1);
    assert.equal(manifest.shardIds.length, 1);
    assert.equal(shards[0]!.contentHash.length, 64);
    assert.equal(manifest.manifestHash.length, 64);

    const job = createEvidenceReviewJob({
      bundle,
      candidate: {
        schemaVersion: 1,
        kind: 'capability',
        capabilityId: 'one-shard',
        title: 'One shard',
        applicability: 'test',
        actionPattern: 'deliver',
        boundaries: [],
        risks: [],
        provenance: [],
        solvedLoop: {
          problem: 'p',
          action: 'a',
          verification: 'v',
          noCorrection: 'n',
        },
        generatedAt: new Date(0).toISOString(),
        sourceUnit: {
          filePath: 'one-shard.jsonl',
          byteRange: { start: 0, end: 1 },
          generatedAt: new Date(0).toISOString(),
        },
      } as any,
      workClass: 'live_learning',
    });
    assert.equal(Object.keys(job.shards).length, 1);
    assert.ok(Object.values(job.quanta).some(q => q.kind === 'author_reader'));
    assert.ok(Object.values(job.quanta).some(q => q.kind === 'verifier_reader'));
    assert.ok(Object.values(job.quanta).some(q => q.kind === 'commit'));
    assert.equal(job.basis.basisHash.length, 64);
  });

  test('public wake creates a durable one-shard job and commits a Capability Transition', async () => {
    const episode = oneShardEpisode();
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [episode.episodeId]: episode },
    });

    const result = await env.runtimeLearning.wake('manual');

    assert.equal(result.review.status, 'succeeded');
    assert.equal(result.review.reviewedEpisodes, 1);
    assert.equal(env.branchCalls.author, 1);
    assert.equal(env.branchCalls.verifier, 1);

    const store = loadEvidenceReviewJobStore(env.jobStorePath);
    const jobs = Object.values(store.jobs);
    assert.equal(jobs.length, 1);
    const job = jobs[0]!;
    assert.equal(job.manifest.shardIds.length, 1);
    assert.equal(job.disposition, 'completed');
    assert.ok(job.authorDossier, 'Author Dossier persisted');
    assert.ok(job.verifierDossier, 'Verifier Dossier persisted');
    assert.ok(job.differenceIndex, 'Difference Index persisted');
    assert.ok(job.obligations, 'Review Obligations persisted');
    assert.ok(job.obligationDispositions, 'Obligation dispositions persisted');
    assert.ok(job.draft, 'Skill Draft persisted');
    assert.ok(job.transitionId, 'transition id linked on job');

    const quanta = Object.values(job.quanta);
    assert.ok(quanta.every(q => q.state === 'succeeded'), 'all quanta succeeded');
    assert.ok(quanta.some(q => q.kind === 'author_reader' && q.state === 'succeeded'));
    assert.ok(quanta.some(q => q.kind === 'verifier_reader' && q.state === 'succeeded'));
    assert.ok(quanta.some(q => q.kind === 'skill_author' && q.state === 'succeeded'));
    assert.ok(quanta.some(q => q.kind === 'skill_verifier' && q.state === 'succeeded'));
    assert.ok(quanta.some(q => q.kind === 'commit' && q.state === 'succeeded'));

    // Readers have no transition authority — only structured finding sets.
    const authorReader = quanta.find(q => q.kind === 'author_reader')!;
    const findingSet = authorReader.result as { coverage?: string; findings?: unknown[] };
    assert.equal(findingSet.coverage, 'covered');
    assert.ok(Array.isArray(findingSet.findings));

    const diagnostics = buildEvidenceReviewDiagnostics(job);
    assert.equal(diagnostics.shardCount, 1);
    assert.equal(diagnostics.authorCoveredShards, 1);
    assert.equal(diagnostics.verifierCoveredShards, 1);
    assert.equal(diagnostics.succeededQuanta, quanta.length);

    // Existing Transition Journal / Audit / Registry optimistic commit path.
    assert.equal(fs.existsSync(path.join(env.root, 'data', 'transition-journal.json')), false);
    assert.ok(fs.existsSync(env.auditPath));
    const auditLines = fs.readFileSync(env.auditPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(auditLines.length, 1);
    const audit = JSON.parse(auditLines[0]!);
    assert.equal(audit.transition, 'create_current_skill');
    assert.ok(Array.isArray(audit.branchTranscriptPaths));
    assert.ok(audit.branchTranscriptPaths.length >= 2);

    const registry = JSON.parse(fs.readFileSync(env.registryPath, 'utf8'));
    assert.ok(Object.keys(registry.capabilities).length >= 1);
  });
});

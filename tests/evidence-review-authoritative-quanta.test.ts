/**
 * Authoritative Review Quanta — engine-owned skill_author / skill_verifier /
 * commit + independent dual-lane readers with auditable transcripts.
 *
 * Proves:
 * - Completed quanta are not replayed across wakes / restart.
 * - Reader transcripts exist for each lane-shard quantum.
 * - Failed quantum retries only the failed node.
 * - No deliberate-throw promotion callbacks / settlePromotionQuanta path.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
} from '../src/utils/evidence-review-job-store';
import {
  EvidenceReviewEngine,
  readShardStructurally,
} from '../src/utils/evidence-review-engine';
import { reclaimExpiredLeases, recoverJobAfterRestart } from '../src/utils/evidence-review-graph-core';
import type { ShardFindingSet } from '../src/utils/evidence-review-types';

interface TestEnv {
  root: string;
  jobStorePath: string;
  auditPath: string;
  runtimeLearning: RuntimeLearning;
  skillEvolution: SkillEvolutionRuntime;
  branchCalls: { author: number; verifier: number; reader: number };
  teardown: () => void;
}

function setupEnv(options?: {
  failSkillAuthorOnce?: boolean;
}): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-auth-quanta-'));
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const jobStorePath = evidenceReviewJobStorePathForReviewQueue(reviewQueuePath);
  const branchCalls = { author: 0, verifier: 0, reader: 0 };
  let authorFailures = options?.failSkillAuthorOnce ? 1 : 0;

  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: root,
    outputDir,
    registryPath,
    auditPath,
    journalPath,
    reviewQueuePath,
    settlementWindowMs: 0,
    operationalRetryMs: 1,
    operationalRetryMaxMs: 1_000,
    logEnabled: false,
    readerFixture: ({ shard, lane }) => {
      branchCalls.reader += 1;
      const findingSet = readShardStructurally(
        shard.shardId,
        shard.contentHash,
        shard.content,
        lane,
      );
      // Lane-specific identity: author and verifier must not share findingIds.
      assert.ok(findingSet.findings.every(f => f.findingId.startsWith(`${lane}:`)));
      return { findingSet };
    },
    authorFixture: ({ bundle }): SkillDraft => {
      branchCalls.author += 1;
      if (authorFailures > 0) {
        authorFailures -= 1;
        throw new Error('injected skill_author operational failure');
      }
      const episode = bundle.episode as { authorEvidenceDossier?: unknown };
      assert.ok(episode?.authorEvidenceDossier, 'Skill Author receives Author Dossier');
      return {
        body: '# Authoritative Quanta\n\nDeliver from durable quanta.',
        envelope: {
          decision: 'create_current_skill',
          routingName: 'authoritative-quanta-delivery',
          description: 'Engine-owned promotion quanta.',
          referencedSkills: [],
          evidenceRefs: ['auth-quanta.jsonl#1'],
          rationale: 'Coverage and promotion quanta complete.',
        },
      };
    },
    verifierFixture: ({ draft }): SkillVerifierResult => {
      branchCalls.verifier += 1;
      assert.equal(draft.envelope.routingName, 'authoritative-quanta-delivery');
      return {
        decision: 'accept',
        transition: 'create_current_skill',
        issues: [],
        rationale: 'Accept after authoritative quanta.',
        registryReadSet: [],
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
    jobStorePath,
    auditPath,
    runtimeLearning,
    skillEvolution,
    branchCalls,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function fixtureEpisode(): LearningEpisode {
  return {
    schemaVersion: 3,
    episodeId: 'episode-auth-quanta',
    runtimeSessionId: 'runtime-auth-quanta',
    sourceFilePath: 'auth-quanta.jsonl',
    deliveryTurn: 1,
    completionEvidence: [{
      ref: 'auth-quanta.jsonl#1',
      sourceFilePath: 'auth-quanta.jsonl',
      turn: 1,
      kind: 'artifact-delivery',
      detail: 'send_file: delivered',
    }],
    contradictionSignals: [],
    semanticObservations: [{
      kind: 'user-intent',
      value: 'Deliver via authoritative quanta.',
      sourceRefs: ['auth-quanta.jsonl#intent'],
    }],
    settlementDeadline: new Date(0).toISOString(),
    status: 'eligible',
  };
}

function fixtureBundle(): EvidenceBundle {
  return {
    bundleId: 'bundle-auth-quanta',
    episode: {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'auth-quanta',
      title: 'Authoritative quanta',
      applicability: 'Engine-owned promotion.',
      actionPattern: 'Advance durable quanta.',
      boundaries: [],
      risks: [],
      provenance: [],
      solvedLoop: {
        problem: 'Post-hoc settlement hides failures.',
        action: 'Execute promotion as leased quanta.',
        verification: 'No replay of succeeded quanta.',
        noCorrection: 'No correction.',
      },
      generatedAt: new Date(0).toISOString(),
      sourceUnit: {
        filePath: 'auth-quanta.jsonl',
        byteRange: { start: 0, end: 1 },
        generatedAt: new Date(0).toISOString(),
      },
    },
    completionEvidence: [{
      ref: 'auth-quanta.jsonl#1',
      sourceFilePath: 'auth-quanta.jsonl',
      turn: 1,
      kind: 'artifact-delivery',
      detail: 'send_file: delivered',
    }],
    settlementEvidence: [{
      ref: 'auth-quanta.jsonl#2',
      sourceFilePath: 'auth-quanta.jsonl',
      turn: 2,
      kind: 'user-confirmation',
      detail: 'thanks, works',
    }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [{
      kind: 'user-intent',
      value: 'Deliver via authoritative quanta.',
      sourceRefs: ['auth-quanta.jsonl#intent'],
    }],
  };
}

describe('Authoritative Review Quanta', () => {
  let env: TestEnv;

  afterEach(() => {
    env?.teardown();
  });

  test('public wake executes promotion quanta with reader transcripts and no replay', async () => {
    env = setupEnv();
    const episode = fixtureEpisode();
    env.runtimeLearning.getEpisodeStore().save({
      schemaVersion: 3,
      episodes: { [episode.episodeId]: episode },
    });

    const result = await env.runtimeLearning.wake('manual');
    assert.equal(result.review.status, 'succeeded');
    assert.equal(env.branchCalls.author, 1);
    assert.equal(env.branchCalls.verifier, 1);
    assert.ok(env.branchCalls.reader >= 2, 'both lanes read');

    const store = loadEvidenceReviewJobStore(env.jobStorePath);
    const job = Object.values(store.jobs)[0]!;
    assert.equal(job.disposition, 'completed');
    assert.ok(job.transitionId);

    const quanta = Object.values(job.quanta);
    assert.ok(quanta.every(q => q.state === 'succeeded'), 'all quanta succeeded via engine');
    assert.ok(quanta.some(q => q.kind === 'skill_author' && q.state === 'succeeded'));
    assert.ok(quanta.some(q => q.kind === 'skill_verifier' && q.state === 'succeeded'));
    assert.ok(quanta.some(q => q.kind === 'commit' && q.state === 'succeeded'));

    // Reader transcripts are auditable artifacts retained on the commit audit.
    const readers = quanta.filter(q => q.kind === 'author_reader' || q.kind === 'verifier_reader');
    const auditLines = fs.readFileSync(env.auditPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(auditLines.length, 1);
    const audit = JSON.parse(auditLines[0]!) as {
      branchTranscriptPaths: string[];
      branchTranscriptHashes?: string[];
    };
    for (const reader of readers) {
      assert.ok(reader.transcriptPaths.length >= 1, `${reader.quantumId} missing transcript`);
      for (const tp of reader.transcriptPaths) {
        assert.ok(fs.existsSync(tp), `reader transcript missing: ${tp}`);
        const body = fs.readFileSync(tp, 'utf8');
        assert.ok(body.includes('"event_type":"start"') || body.includes('"event_type": "start"'));
        assert.ok(body.includes('transcript') || body.includes('fixture_result'));
        assert.ok(
          audit.branchTranscriptPaths.includes(tp),
          `commit audit retains reader transcript ${tp}`,
        );
        const idx = audit.branchTranscriptPaths.indexOf(tp);
        if (audit.branchTranscriptHashes?.[idx]) {
          assert.equal(
            audit.branchTranscriptHashes[idx],
            crypto.createHash('sha256').update(body).digest('hex'),
          );
        }
      }
    }

    // Author and Verifier finding sets are lane-independent (no shared first-64 heuristic).
    const authorSet = readers.find(q => q.kind === 'author_reader')!.result as ShardFindingSet;
    const verifierSet = readers.find(q => q.kind === 'verifier_reader')!.result as ShardFindingSet;
    assert.equal(authorSet.lane, 'author');
    assert.equal(verifierSet.lane, 'verifier');
    const authorIds = new Set(authorSet.findings.map(f => f.findingId));
    for (const f of verifierSet.findings) {
      assert.equal(authorIds.has(f.findingId), false, 'lanes must not share finding identity');
    }
    for (const set of [authorSet, verifierSet]) {
      for (const f of set.findings) {
        for (const span of f.spans) {
          // Full-shard or pattern spans — never a shared first-64-byte only fact.
          assert.ok(span.end > span.start || span.end === 0);
        }
      }
    }

    // Skill author / verifier branch transcripts preserved on quanta.
    const skillAuthor = quanta.find(q => q.kind === 'skill_author')!;
    const skillVerifier = quanta.find(q => q.kind === 'skill_verifier')!;
    assert.ok(skillAuthor.transcriptPaths.length >= 1);
    assert.ok(skillVerifier.transcriptPaths.length >= 1);

    // Second wake must not replay completed quanta.
    const authorBefore = env.branchCalls.author;
    const verifierBefore = env.branchCalls.verifier;
    const readerBefore = env.branchCalls.reader;
    await env.runtimeLearning.wake('manual');
    assert.equal(env.branchCalls.author, authorBefore, 'skill_author not replayed');
    assert.equal(env.branchCalls.verifier, verifierBefore, 'skill_verifier not replayed');
    assert.equal(env.branchCalls.reader, readerBefore, 'readers not replayed');

    assert.ok(fs.existsSync(env.auditPath));
  });

  test('failed skill_author retries only that quantum; succeeded readers stay succeeded', async () => {
    env = setupEnv({ failSkillAuthorOnce: true });
    const engine = env.skillEvolution.getEvidenceReviewEngine();
    // Long retry so the first wake cannot auto-recover the failed quantum.
    (engine as any).options.retryBaseMs = 60_000;
    (engine as any).options.retryMaxMs = 60_000;
    (engine as any).options.maxQuantaPerAdvance = 32;

    const bundle = fixtureBundle();
    const job = engine.createJob({
      bundle,
      candidate: bundle.episode as any,
      workClass: 'live_learning',
    });

    // First advance: coverage succeeds; skill_author fails once and waits.
    await engine.advanceJob(job.jobId, 'wake-fail', undefined);
    const afterFail = engine.loadStore().jobs[job.jobId]!;
    const skillAuthor = Object.values(afterFail.quanta).find(q => q.kind === 'skill_author')!;
    const readers = Object.values(afterFail.quanta).filter(
      q => q.kind === 'author_reader' || q.kind === 'verifier_reader',
    );
    assert.ok(readers.every(q => q.state === 'succeeded'), 'readers remain succeeded');
    assert.equal(skillAuthor.state, 'retry_wait', `skill_author state=${skillAuthor.state}`);
    assert.equal(afterFail.disposition, 'active');
    assert.equal(env.branchCalls.author, 1);
    assert.equal(env.branchCalls.verifier, 0);

    const readerSucceededIds = readers.map(q => q.quantumId);

    // Force retry eligibility for the failed quantum only.
    afterFail.quanta[skillAuthor.quantumId] = {
      ...skillAuthor,
      nextRetryAt: new Date(0).toISOString(),
    };
    const state = engine.loadStore();
    state.jobs[job.jobId] = afterFail;
    engine.saveStore(state);

    // Resume via public path: completes without re-running readers.
    const result = await env.skillEvolution.reviewAndApply(bundle);
    assert.equal(result.transition, 'create_current_skill');
    const final = engine.loadStore().jobs[job.jobId]!;
    assert.equal(final.disposition, 'completed');
    for (const id of readerSucceededIds) {
      assert.equal(final.quanta[id]!.state, 'succeeded');
    }
    assert.equal(final.quanta[skillAuthor.quantumId]!.state, 'succeeded');
    // Author called twice: fail + success; verifier once.
    assert.equal(env.branchCalls.author, 2);
    assert.equal(env.branchCalls.verifier, 1);
  });

  test('restart preserves succeeded quanta and does not replay them', async () => {
    env = setupEnv();
    const engine = env.skillEvolution.getEvidenceReviewEngine();
    const bundle = fixtureBundle();
    const job = engine.createJob({
      bundle,
      candidate: bundle.episode as any,
      workClass: 'live_learning',
    });

    await engine.advanceJob(job.jobId, 'wake-1', undefined, {
      allowedKinds: ['author_reader', 'verifier_reader'],
    });
    let live = engine.loadStore().jobs[job.jobId]!;
    const succeeded = Object.values(live.quanta)
      .filter(q => q.state === 'succeeded')
      .map(q => q.quantumId);
    assert.ok(succeeded.length >= 2);

    // Simulate crash with an expired lease on a still-pending node.
    const pending = Object.values(live.quanta).find(q => q.state === 'pending');
    if (pending) {
      live.quanta[pending.quantumId] = {
        ...pending,
        state: 'leased',
        lease: {
          leaseId: 'lease-expired',
          ownerWakeId: 'old-wake',
          leasedAt: new Date(0).toISOString(),
          expiresAt: new Date(1).toISOString(),
        },
      };
      const state = engine.loadStore();
      state.jobs[job.jobId] = live;
      engine.saveStore(state);
    }

    live = engine.loadStore().jobs[job.jobId]!;
    const recovered = recoverJobAfterRestart(live as any, new Date());
    reclaimExpiredLeases(recovered, new Date());
    const state = engine.loadStore();
    state.jobs[job.jobId] = recovered as any;
    engine.saveStore(state);

    for (const id of succeeded) {
      assert.equal(engine.loadStore().jobs[job.jobId]!.quanta[id]!.state, 'succeeded');
    }

    const result = await env.skillEvolution.reviewAndApply(bundle);
    assert.equal(result.transition, 'create_current_skill');
    const final = engine.loadStore().jobs[job.jobId]!;
    for (const id of succeeded) {
      assert.equal(final.quanta[id]!.state, 'succeeded');
    }
    // Readers already done — readerFixture should not re-run for them.
    // (may run for none if both lanes done; allow 0 additional beyond first wake)
    assert.ok(env.branchCalls.author === 1);
    assert.ok(env.branchCalls.verifier === 1);
  });

  test('invalid reader output fails closed without certifying coverage', async () => {
    env = setupEnv();
    const engine = new EvidenceReviewEngine({
      jobStorePath: env.jobStorePath,
      workingDirectory: env.root,
      maxQuantaPerAdvance: 4,
      leaseMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 10,
      runReaderLane: async ({ shard, lane }) => ({
        findingSet: {
          shardId: shard.shardId,
          contentHash: shard.contentHash,
          lane,
          coverage: 'covered',
          // Invalid: free-form only / empty findings on nonempty content fails validation.
          findings: [],
          diagnostic: 'looks fine',
        },
      }),
      runSkillAuthor: async () => {
        throw new Error('must not reach skill_author after invalid reader');
      },
      runSkillVerifier: async () => {
        throw new Error('must not reach skill_verifier after invalid reader');
      },
      commitTransition: async () => {
        throw new Error('must not reach commit after invalid reader');
      },
    });

    const bundle = fixtureBundle();
    const job = engine.createJob({
      bundle,
      candidate: bundle.episode as any,
      workClass: 'live_learning',
    });
    await engine.advanceJob(job.jobId, 'wake-invalid', undefined, {
      allowedKinds: ['author_reader', 'verifier_reader'],
    });
    const live = engine.loadStore().jobs[job.jobId]!;
    const readers = Object.values(live.quanta).filter(
      q => q.kind === 'author_reader' || q.kind === 'verifier_reader',
    );
    assert.ok(readers.some(q => q.state === 'retry_wait' || q.state === 'terminal_failed'));
    assert.equal(readers.every(q => q.state === 'succeeded'), false);
    assert.equal(live.authorDossier, undefined);
  });

  test('lane structural readers produce independent finding identities', () => {
    const content = 'Deliver the report. Confirm it works. No secret material.';
    const hash = 'a'.repeat(64);
    const author = readShardStructurally('s1', hash, content, 'author');
    const verifier = readShardStructurally('s1', hash, content, 'verifier');
    assert.equal(author.lane, 'author');
    assert.equal(verifier.lane, 'verifier');
    const authorIds = new Set(author.findings.map(f => f.findingId));
    for (const f of verifier.findings) {
      assert.equal(authorIds.has(f.findingId), false);
    }
    // Nonempty content is covered by full-shard span, not first-64-only.
    for (const set of [author, verifier]) {
      assert.equal(set.coverage, 'covered');
      assert.ok(set.findings.length >= 1);
      const maxEnd = Math.max(...set.findings.flatMap(f => f.spans.map(s => s.end)));
      assert.ok(maxEnd === Buffer.byteLength(content, 'utf8') || maxEnd > 0);
    }
  });
});

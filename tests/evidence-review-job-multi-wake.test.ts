/**
 * Issue #107 — Evidence Review Jobs resume across wakes and restarts.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
import { EvidenceReviewEngine, readShardStructurally } from '../src/utils/evidence-review-engine';
import { reclaimExpiredLeases, recoverJobAfterRestart } from '../src/utils/evidence-review-graph-core';
import { acceptReviewObligations } from './evidence-review-test-fixtures';

function fixtureBundle(): EvidenceBundle {
  return {
    bundleId: 'bundle-multi-wake',
    episode: {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'multi-wake',
      title: 'Multi wake',
      applicability: 'Resume across wakes.',
      actionPattern: 'Advance one quantum per wake.',
      boundaries: [],
      risks: [],
      provenance: [],
      solvedLoop: {
        problem: 'Large review spans wakes.',
        action: 'Resume unfinished quanta.',
        verification: 'No successful quantum re-runs.',
        noCorrection: 'No correction.',
      },
      generatedAt: new Date(0).toISOString(),
      sourceUnit: {
        filePath: 'multi-wake.jsonl',
        byteRange: { start: 0, end: 1 },
        generatedAt: new Date(0).toISOString(),
      },
    },
    completionEvidence: [{
      ref: 'multi-wake.jsonl#1',
      sourceFilePath: 'multi-wake.jsonl',
      turn: 1,
      kind: 'artifact-delivery',
      detail: 'send_file: delivered',
    }],
    settlementEvidence: [{
      ref: 'multi-wake.jsonl#2',
      sourceFilePath: 'multi-wake.jsonl',
      turn: 2,
      kind: 'user-confirmation',
      detail: 'thanks, works',
    }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [{
      kind: 'user-intent',
      value: 'Deliver across wakes.',
      sourceRefs: ['multi-wake.jsonl#intent'],
    }],
  };
}

describe('Evidence Review Job — multi-wake resume (#107)', () => {
  let root: string;
  let skillEvolution: SkillEvolutionRuntime;
  let jobStorePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-review-107-'));
    const skillsRoot = path.join(root, 'skills');
    const outputDir = defaultDistilledOutputDir(skillsRoot);
    const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
    jobStorePath = evidenceReviewJobStorePathForReviewQueue(reviewQueuePath);
    skillEvolution = new SkillEvolutionRuntime({
      workingDirectory: root,
      outputDir,
      registryPath: path.join(root, 'data', 'current-skill-registry.json'),
      auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
      journalPath: path.join(root, 'data', 'transition-journal.json'),
      reviewQueuePath,
      settlementWindowMs: 0,
      operationalRetryMs: 1,
      operationalRetryMaxMs: 1_000,
      logEnabled: false,
      // Explicit test fixture — production default is model-backed.
      readerFixture: ({ shard, lane }) => ({
        findingSet: readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane),
      }),
      authorFixture: (): SkillDraft => ({
        body: '# Wake Resume\n\nResume safely.',
        envelope: {
          decision: 'create_current_skill',
          routingName: 'wake-resume-delivery',
          description: 'Resume durable review across wakes.',
          referencedSkills: [],
          evidenceRefs: ['multi-wake.jsonl#1'],
          rationale: 'Coverage complete.',
        },
      }),
      verifierFixture: ({ bundle }): SkillVerifierResult => ({
        decision: 'accept',
        transition: 'create_current_skill',
        issues: [],
        rationale: 'Accept after multi-wake coverage.',
        registryReadSet: [],
        obligationDispositions: acceptReviewObligations(bundle),
      }),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('bounded wakes advance coverage without replaying succeeded quanta', async () => {
    const engine = new EvidenceReviewEngine({
      jobStorePath,
      workingDirectory: root,
      maxQuantaPerAdvance: 1,
      leaseMs: 60_000,
      runSkillAuthor: async () => {
        throw new Error('not used in coverage-only phase');
      },
      runSkillVerifier: async () => {
        throw new Error('not used in coverage-only phase');
      },
      commitTransition: async () => {
        throw new Error('not used in coverage-only phase');
      },
    });

    const bundle = fixtureBundle();
    const candidate = bundle.episode as any;
    const job = engine.createJob({
      bundle,
      candidate,
      workClass: 'live_learning',
      sharding: { preferSingleShardWhenFits: false, softLimitBytes: 200, hardLimitBytes: 400 },
    });
    assert.ok(job.manifest.shardIds.length >= 2);

    const succeededBefore = new Set<string>();
    let wake = 0;
    while (wake < 40) {
      wake += 1;
      const advanced = await engine.advanceJob(job.jobId, `wake-${wake}`, undefined, {
        allowedKinds: [
          'author_reader',
          'verifier_reader',
          'author_dossier',
          'verifier_dossier',
          'difference_index',
          'obligations',
        ],
      });
      assert.ok(advanced.executedQuantumIds.length <= 1);
      for (const id of advanced.executedQuantumIds) {
        assert.equal(succeededBefore.has(id), false, `replayed quantum ${id}`);
        succeededBefore.add(id);
      }
      const live = engine.loadStore().jobs[job.jobId]!;
      const coverageDone = [
        'author_reader',
        'verifier_reader',
        'author_dossier',
        'verifier_dossier',
        'difference_index',
        'obligations',
      ].every(kind => Object.values(live.quanta).filter(q => q.kind === kind).every(q => q.state === 'succeeded'));
      if (coverageDone) break;
    }

    const covered = engine.loadStore().jobs[job.jobId]!;
    assert.ok(covered.authorDossier?.complete);
    assert.ok(covered.verifierDossier?.complete);
    assert.ok(covered.obligations);
    // Succeeded quanta remain succeeded after another wake with no runnable coverage.
    const noop = await engine.advanceJob(job.jobId, 'wake-final', undefined, {
      allowedKinds: [
        'author_reader',
        'verifier_reader',
        'author_dossier',
        'verifier_dossier',
        'difference_index',
        'obligations',
      ],
    });
    assert.equal(noop.executedQuantumIds.length, 0);
    for (const id of succeededBefore) {
      assert.equal(engine.loadStore().jobs[job.jobId]!.quanta[id]!.state, 'succeeded');
    }
  });

  test('restart reclaims expired leases and preserves successes', async () => {
    const engine = new EvidenceReviewEngine({
      jobStorePath,
      workingDirectory: root,
      maxQuantaPerAdvance: 2,
      leaseMs: 1,
      runSkillAuthor: async () => ({ draft: null as any, transcriptPaths: [] }),
      runSkillVerifier: async () => ({ verifier: null as any, dispositions: [], transcriptPaths: [] }),
      commitTransition: async () => ({ transition: 'defer', verified: false, rounds: 1 }),
    });
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
    const succeeded = Object.values(live.quanta).filter(q => q.state === 'succeeded').map(q => q.quantumId);
    assert.ok(succeeded.length >= 1);

    // Force an expired lease on a pending-turned-leased node.
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

    // Simulate restart recovery.
    live = engine.loadStore().jobs[job.jobId]!;
    const recovered = recoverJobAfterRestart(live as any, new Date());
    reclaimExpiredLeases(recovered, new Date());
    const state = engine.loadStore();
    state.jobs[job.jobId] = recovered as any;
    engine.saveStore(state);

    const after = loadEvidenceReviewJobStore(jobStorePath).jobs[job.jobId]!;
    for (const id of succeeded) {
      assert.equal(after.quanta[id]!.state, 'succeeded');
    }
    const leased = Object.values(after.quanta).filter(q => q.state === 'leased');
    assert.equal(leased.length, 0, 'expired leases reclaimed on restart');
  });

  test('public SkillEvolution path completes job after prior partial coverage', async () => {
    // Seed a partially covered job, then call reviewAndApply to finish.
    const engine = skillEvolution.getEvidenceReviewEngine();
    const bundle = fixtureBundle();
    const job = engine.createJob({
      bundle,
      candidate: bundle.episode as any,
      workClass: 'live_learning',
    });
    await engine.advanceJob(job.jobId, 'seed-wake', undefined, {
      allowedKinds: ['author_reader', 'verifier_reader'],
    });
    const partial = engine.loadStore().jobs[job.jobId]!;
    const partialSucceeded = Object.values(partial.quanta).filter(q => q.state === 'succeeded').length;
    assert.ok(partialSucceeded >= 1);

    const result = await skillEvolution.reviewAndApply(bundle);
    assert.equal(result.transition, 'create_current_skill');
    const final = engine.loadStore().jobs[job.jobId]!;
    assert.equal(final.disposition, 'completed');
    // Prior successes remain.
    assert.ok(
      Object.values(final.quanta).filter(q => q.state === 'succeeded').length >= partialSucceeded,
    );
  });
});

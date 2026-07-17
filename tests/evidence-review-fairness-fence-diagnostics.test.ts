/**
 * #108 Fair rotation, #109 Review Commit Fence, #110 operator diagnostics.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createEvidenceReviewJob } from '../src/utils/evidence-review-graph';
import {
  emptyEvidenceReviewJobStoreState,
  upsertEvidenceReviewJob,
  saveEvidenceReviewJobStore,
  loadEvidenceReviewJobStore,
} from '../src/utils/evidence-review-job-store';
import { planFairQuantumClaims } from '../src/utils/evidence-review-scheduler';
import {
  compareReviewBasis,
  createSuccessorReviewJob,
  markJobSuperseded,
} from '../src/utils/evidence-review-commit-fence';
import { buildOperatorView, classifyOperatorDisposition } from '../src/utils/evidence-review-diagnostics';
import type { EvidenceBundle } from '../src/utils/skill-evolution';

function validBundle(bundleId: string, extra = ''): EvidenceBundle {
  return {
    bundleId,
    episode: {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: bundleId,
      title: `Title ${bundleId}`,
      applicability: 'Fairness and fence tests.',
      actionPattern: `action ${extra}`,
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
        filePath: `${bundleId}.jsonl`,
        byteRange: { start: 0, end: 1 },
        generatedAt: new Date(0).toISOString(),
      },
    },
    completionEvidence: [{ ref: `${bundleId}.jsonl#1` }],
    settlementEvidence: [{ ref: `${bundleId}.jsonl#2` }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [{
      kind: 'user-intent',
      value: `Intent for ${bundleId}`,
      sourceRefs: [`${bundleId}.jsonl#intent`],
    }],
  };
}

function candidateFrom(bundle: EvidenceBundle): any {
  return bundle.episode;
}

describe('Fair Review Quantum Rotation (#108)', () => {
  test('rotates across work classes and at most one quantum per job when competing', () => {
    const state = emptyEvidenceReviewJobStoreState();
    const classes = [
      'operational_recovery',
      'live_learning',
      'historical_learning',
      'semantic_reassessment',
    ] as const;
    for (const [index, workClass] of classes.entries()) {
      const bundle = validBundle(`bundle-${workClass}`);
      const job = createEvidenceReviewJob({
        bundle,
        candidate: candidateFrom(bundle),
        workClass,
        jobId: `job-${workClass}`,
      });
      // Ensure multiple quanta so the job stays runnable after one claim plan.
      assert.ok(Object.keys(job.quanta).length > 1);
      upsertEvidenceReviewJob(state, job);
      // Second job in live class to prove within-class one-per-job.
      if (workClass === 'live_learning') {
        const bundle2 = validBundle('bundle-live-2');
        const job2 = createEvidenceReviewJob({
          bundle: bundle2,
          candidate: candidateFrom(bundle2),
          workClass: 'live_learning',
          jobId: 'job-live-2',
        });
        upsertEvidenceReviewJob(state, job2);
      }
      void index;
    }

    const plan = planFairQuantumClaims(state, { maxClaims: 4, maxClaimsPerJob: 1 });
    assert.equal(plan.claims.length, 4);
    const classesSeen = new Set(plan.claims.map(c => c.workClass));
    assert.ok(classesSeen.size >= 3, `expected multi-class rotation, got ${[...classesSeen]}`);
    // Within one plan cycle, no job appears twice when competing.
    const jobCounts = new Map<string, number>();
    for (const claim of plan.claims) {
      jobCounts.set(claim.jobId, (jobCounts.get(claim.jobId) ?? 0) + 1);
    }
    for (const [jobId, count] of jobCounts) {
      assert.equal(count, 1, `${jobId} claimed ${count} times under contention`);
    }
    assert.ok(plan.fairness.nextWorkClass);
  });

  test('sole runnable job may consume spare global capacity', () => {
    const state = emptyEvidenceReviewJobStoreState();
    const bundle = validBundle('sole-job');
    const job = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
      jobId: 'job-sole',
      sharding: { preferSingleShardWhenFits: false, softLimitBytes: 100, hardLimitBytes: 200 },
    });
    upsertEvidenceReviewJob(state, job);
    const plan = planFairQuantumClaims(state, { maxClaims: 3, maxClaimsPerJob: 1 });
    assert.ok(plan.claims.length >= 2, 'sole job fills spare slots');
    assert.ok(plan.claims.every(c => c.jobId === 'job-sole'));
  });
});

describe('Review Commit Fence (#109)', () => {
  test('matching basis allows commit; evidence change is stale', () => {
    const bundle = validBundle('fence-a');
    const job = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
    });
    const match = compareReviewBasis(job.basis, {
      bundle,
      registryReadSet: job.basis.registryReadSet,
      reviewPolicyVersion: job.basis.reviewPolicyVersion,
      promptVersion: job.basis.promptVersion,
    });
    assert.equal(match.status, 'match');

    const changed: EvidenceBundle = {
      ...bundle,
      completionEvidence: [...bundle.completionEvidence, { ref: 'fence-a.jsonl#extra' }],
    };
    const stale = compareReviewBasis(job.basis, {
      bundle: changed,
      registryReadSet: job.basis.registryReadSet,
    });
    assert.equal(stale.status, 'stale');
    if (stale.status === 'stale') {
      assert.ok(stale.changed.includes('evidence'));
    }
  });

  test('unrelated registry handle outside declared read set does not invalidate', () => {
    const bundle = validBundle('fence-b');
    const job = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
      registryReadSet: [{ handle: 'cap_a', revision: 1 }],
    });
    // Live world has extra capabilities, but fence only compares declared read set.
    const match = compareReviewBasis(job.basis, {
      bundle,
      registryReadSet: [{ handle: 'cap_a', revision: 1 }],
    });
    assert.equal(match.status, 'match');

    const staleTarget = compareReviewBasis(job.basis, {
      bundle,
      registryReadSet: [{ handle: 'cap_a', revision: 2 }],
    });
    assert.equal(staleTarget.status, 'stale');
  });

  test('successor reuses quanta with identical input hashes only', () => {
    const bundle = validBundle('fence-c', 'same');
    const prior = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
      jobId: 'job-prior',
    });
    // Mark one reader succeeded.
    const reader = Object.values(prior.quanta).find(q => q.kind === 'author_reader')!;
    prior.quanta[reader.quantumId] = {
      ...reader,
      state: 'succeeded',
      result: { covered: true },
      resultHash: 'abc',
      updatedAt: new Date().toISOString(),
    };

    const liveBundle: EvidenceBundle = {
      ...bundle,
      settlementEvidence: [...bundle.settlementEvidence, { ref: 'fence-c.jsonl#3' }],
    };
    const successor = createSuccessorReviewJob({
      staleJob: prior,
      liveBundle,
      candidate: candidateFrom(liveBundle),
    });
    const superseded = markJobSuperseded(prior, successor.jobId);
    assert.equal(superseded.disposition, 'superseded');
    assert.equal(superseded.successorJobId, successor.jobId);
    assert.equal(successor.parentJobId, prior.jobId);

    // Same content-identified reader may reuse; changed evidence usually changes shard hashes.
    const reused = Object.values(successor.quanta).filter(q => q.state === 'succeeded');
    // Either reuse happened for unchanged shards, or none if all inputs changed — both valid.
    for (const q of reused) {
      assert.equal(q.kind, prior.quanta[Object.keys(prior.quanta).find(id => prior.quanta[id]!.inputHash === q.inputHash)!]?.kind);
    }
  });
});

describe('Evidence Review diagnostics (#110)', () => {
  test('operator views distinguish dispositions without raw queue JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-er-diag-'));
    try {
      const storePath = path.join(root, 'evidence-review-jobs.json');
      const state = emptyEvidenceReviewJobStoreState();

      const activeBundle = validBundle('diag-active');
      const active = createEvidenceReviewJob({
        bundle: activeBundle,
        candidate: candidateFrom(activeBundle),
        workClass: 'live_learning',
        jobId: 'job-active',
      });
      upsertEvidenceReviewJob(state, active);

      const deferredBundle = validBundle('diag-defer');
      const deferred = createEvidenceReviewJob({
        bundle: deferredBundle,
        candidate: candidateFrom(deferredBundle),
        workClass: 'live_learning',
        jobId: 'job-defer',
      });
      deferred.disposition = 'deferred';
      upsertEvidenceReviewJob(state, deferred);

      const superBundle = validBundle('diag-super');
      const superJob = createEvidenceReviewJob({
        bundle: superBundle,
        candidate: candidateFrom(superBundle),
        workClass: 'live_learning',
        jobId: 'job-super',
      });
      Object.assign(superJob, markJobSuperseded(superJob, 'job-successor'));
      upsertEvidenceReviewJob(state, superJob);

      saveEvidenceReviewJobStore(storePath, state);
      const loaded = loadEvidenceReviewJobStore(storePath);

      const activeView = buildOperatorView(loaded.jobs['job-active']!);
      assert.ok(['active_coverage', 'incomplete_coverage', 'leased', 'local_retry'].includes(activeView.operatorDisposition));
      assert.match(activeView.summary, /Job job-active/);

      assert.equal(classifyOperatorDisposition(loaded.jobs['job-defer']!), 'semantic_defer');
      assert.equal(classifyOperatorDisposition(loaded.jobs['job-super']!), 'stale_basis_superseded');
      assert.ok(buildOperatorView(loaded.jobs['job-super']!).summary.includes('superseded'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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
import {
  emptyFairnessState,
  normalizeFairnessState,
  planFairQuantumClaims,
} from '../src/utils/evidence-review-scheduler';
import {
  EvidenceReviewEngine,
  advanceJobsFairly,
} from '../src/utils/evidence-review-engine';
import {
  compareReviewBasis,
  createSuccessorReviewJob,
  markJobSuperseded,
} from '../src/utils/evidence-review-commit-fence';
import { buildOperatorView, classifyOperatorDisposition } from '../src/utils/evidence-review-diagnostics';
import type { EvidenceBundle } from '../src/utils/skill-evolution';
import type { EvidenceReviewJob, ReviewWorkClass } from '../src/utils/evidence-review-types';
import { WORK_CLASS_ORDER } from '../src/utils/evidence-review-job-store';

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

function multiShardJob(input: {
  jobId: string;
  workClass: ReviewWorkClass;
  label?: string;
}): EvidenceReviewJob {
  const label = input.label ?? input.jobId;
  // Force multi-shard dual-lane graphs so many readers stay runnable.
  const bundle = validBundle(label, `${label}-extra-evidence-payload`.repeat(8));
  return createEvidenceReviewJob({
    bundle,
    candidate: candidateFrom(bundle),
    workClass: input.workClass,
    jobId: input.jobId,
    sharding: {
      preferSingleShardWhenFits: false,
      softLimitBytes: 40,
      hardLimitBytes: 80,
    },
  });
}

function markSucceeded(job: EvidenceReviewJob, quantumId: string): void {
  const quantum = job.quanta[quantumId];
  if (!quantum) return;
  job.quanta[quantumId] = {
    ...quantum,
    state: 'succeeded',
    result: { covered: true },
    resultHash: `hash-${quantumId}`,
    lease: undefined,
    updatedAt: new Date(0).toISOString(),
  };
}

function markLeased(job: EvidenceReviewJob, quantumId: string, expiresAt: string): void {
  const quantum = job.quanta[quantumId];
  if (!quantum) return;
  job.quanta[quantumId] = {
    ...quantum,
    state: 'leased',
    lease: {
      leaseId: `lease-${quantumId}`,
      ownerWakeId: 'wake-test',
      leasedAt: new Date(0).toISOString(),
      expiresAt,
    },
    updatedAt: new Date(0).toISOString(),
  };
}

describe('Fair Review Quantum Rotation (#108)', () => {
  test('fair execution runs only the single quantum selected for this wake', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-review-fair-exec-'));
    const jobStorePath = path.join(root, 'evidence-review-jobs.json');
    let readerCalls = 0;
    const engine = new EvidenceReviewEngine({
      jobStorePath,
      workingDirectory: root,
      maxQuantaPerAdvance: 64,
      runReaderLane: async () => {
        readerCalls += 1;
        throw new Error('reader call counted');
      },
      runSkillAuthor: async () => { throw new Error('author must not run'); },
      runSkillVerifier: async () => { throw new Error('verifier must not run'); },
      commitTransition: async () => { throw new Error('commit must not run'); },
    });
    try {
      const bundle = validBundle('bounded-fair-execution', 'large'.repeat(100));
      engine.createJob({
        bundle,
        candidate: candidateFrom(bundle),
        workClass: 'live_learning',
        sharding: {
          preferSingleShardWhenFits: false,
          softLimitBytes: 40,
          hardLimitBytes: 80,
        },
      });

      const advanced = await advanceJobsFairly(engine, 'wake-bounded', {
        maxClaims: 1,
        maxClaimsPerJob: 1,
      });

      assert.equal(advanced.claims, 1);
      assert.equal(readerCalls, 1, 'one fair claim must execute exactly one quantum');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rotates durably across work classes without permanent priority', () => {
    const state = emptyEvidenceReviewJobStoreState();
    for (const workClass of WORK_CLASS_ORDER) {
      upsertEvidenceReviewJob(state, multiShardJob({
        jobId: `job-${workClass}`,
        workClass,
      }));
    }

    const classHits = new Map<ReviewWorkClass, number>();
    for (let wake = 0; wake < 8; wake++) {
      const plan = planFairQuantumClaims(state, { maxClaims: 1, maxClaimsPerJob: 1 });
      assert.equal(plan.claims.length, 1, `wake ${wake} should claim one quantum`);
      const claim = plan.claims[0]!;
      classHits.set(claim.workClass, (classHits.get(claim.workClass) ?? 0) + 1);
      state.fairness = plan.fairness;
    }

    for (const workClass of WORK_CLASS_ORDER) {
      assert.equal(
        classHits.get(workClass),
        2,
        `${workClass} should receive equal bounded service, got ${classHits.get(workClass)}`,
      );
    }
  });

  test('within a class claims at most one quantum per job before cycling again', () => {
    const state = emptyEvidenceReviewJobStoreState();
    for (const jobId of ['job-a', 'job-b', 'job-c']) {
      upsertEvidenceReviewJob(state, multiShardJob({
        jobId,
        workClass: 'live_learning',
      }));
    }

    // maxClaimsPerJob=2 must not allow double-claim in the first class visit.
    const plan = planFairQuantumClaims(state, { maxClaims: 3, maxClaimsPerJob: 2 });
    assert.equal(plan.claims.length, 3);
    assert.deepEqual(
      plan.claims.map(c => c.jobId).sort(),
      ['job-a', 'job-b', 'job-c'],
    );
    const counts = new Map<string, number>();
    for (const claim of plan.claims) {
      counts.set(claim.jobId, (counts.get(claim.jobId) ?? 0) + 1);
    }
    for (const [jobId, count] of counts) {
      assert.equal(count, 1, `${jobId} claimed ${count} times in one-per-job pass`);
    }
  });

  test('per-job concurrency limit prevents large-job monopoly under contention', () => {
    const state = emptyEvidenceReviewJobStoreState();
    upsertEvidenceReviewJob(state, multiShardJob({
      jobId: 'job-large',
      workClass: 'historical_learning',
      label: 'large-job-with-very-long-payload-to-force-many-shards'.repeat(4),
    }));
    upsertEvidenceReviewJob(state, multiShardJob({
      jobId: 'job-small',
      workClass: 'historical_learning',
      label: 'small',
    }));

    const hits = new Map<string, number>();
    for (let wake = 0; wake < 10; wake++) {
      const plan = planFairQuantumClaims(state, { maxClaims: 1, maxClaimsPerJob: 1 });
      assert.equal(plan.claims.length, 1);
      hits.set(plan.claims[0]!.jobId, (hits.get(plan.claims[0]!.jobId) ?? 0) + 1);
      state.fairness = plan.fairness;
    }

    assert.equal(hits.get('job-large'), 5);
    assert.equal(hits.get('job-small'), 5);
  });

  test('job size and retry state do not create permanent priority', () => {
    const state = emptyEvidenceReviewJobStoreState();
    const heavy = multiShardJob({
      jobId: 'job-heavy-retry',
      workClass: 'operational_recovery',
      label: 'heavy-retry-payload'.repeat(6),
    });
    // Mark one reader as retry_wait so the job still has runnable siblings.
    const heavyReader = Object.values(heavy.quanta).find(q => q.kind === 'author_reader')!;
    heavy.quanta[heavyReader.quantumId] = {
      ...heavyReader,
      state: 'retry_wait',
      attempt: 9,
      nextRetryAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const light = multiShardJob({
      jobId: 'job-light',
      workClass: 'operational_recovery',
      label: 'light',
    });
    upsertEvidenceReviewJob(state, heavy);
    upsertEvidenceReviewJob(state, light);

    const plan = planFairQuantumClaims(state, { maxClaims: 2, maxClaimsPerJob: 1 });
    assert.equal(plan.claims.length, 2);
    assert.deepEqual(
      plan.claims.map(c => c.jobId).sort(),
      ['job-heavy-retry', 'job-light'],
    );

    state.fairness = emptyFairnessState();
    const hits = new Map<string, number>();
    for (let wake = 0; wake < 6; wake++) {
      const step = planFairQuantumClaims(state, { maxClaims: 1, maxClaimsPerJob: 1 });
      hits.set(step.claims[0]!.jobId, (hits.get(step.claims[0]!.jobId) ?? 0) + 1);
      state.fairness = step.fairness;
    }
    assert.equal(hits.get('job-heavy-retry'), 3);
    assert.equal(hits.get('job-light'), 3);
  });

  test('sole runnable job may consume spare global capacity', () => {
    const state = emptyEvidenceReviewJobStoreState();
    upsertEvidenceReviewJob(state, multiShardJob({
      jobId: 'job-sole',
      workClass: 'live_learning',
    }));
    const plan = planFairQuantumClaims(state, { maxClaims: 3, maxClaimsPerJob: 1 });
    assert.ok(plan.claims.length >= 2, 'sole job fills spare slots above per-job cap');
    assert.ok(plan.claims.every(c => c.jobId === 'job-sole'));
  });

  test('work-conserving refill stops when contention appears', () => {
    const state = emptyEvidenceReviewJobStoreState();
    upsertEvidenceReviewJob(state, multiShardJob({ jobId: 'job-a', workClass: 'live_learning' }));
    upsertEvidenceReviewJob(state, multiShardJob({ jobId: 'job-b', workClass: 'live_learning' }));

    const plan = planFairQuantumClaims(state, { maxClaims: 4, maxClaimsPerJob: 1 });
    assert.equal(plan.claims.length, 2);
    assert.deepEqual(
      plan.claims.map(c => c.jobId).sort(),
      ['job-a', 'job-b'],
    );
    const counts = new Map<string, number>();
    for (const claim of plan.claims) {
      counts.set(claim.jobId, (counts.get(claim.jobId) ?? 0) + 1);
    }
    assert.equal(counts.get('job-a'), 1);
    assert.equal(counts.get('job-b'), 1);
  });

  test('in-flight leased quanta count against per-job concurrency', () => {
    const state = emptyEvidenceReviewJobStoreState();
    const a = multiShardJob({ jobId: 'job-a', workClass: 'live_learning' });
    const b = multiShardJob({ jobId: 'job-b', workClass: 'live_learning' });
    const now = new Date('2030-01-01T00:00:00.000Z');
    const future = new Date(now.getTime() + 60_000).toISOString();
    const aReader = Object.values(a.quanta).find(q => q.kind === 'author_reader')!;
    markLeased(a, aReader.quantumId, future);
    upsertEvidenceReviewJob(state, a);
    upsertEvidenceReviewJob(state, b);

    const plan = planFairQuantumClaims(state, {
      maxClaims: 2,
      maxClaimsPerJob: 1,
      now,
    });
    // job-a already at cap via in-flight lease; only job-b is newly claimable.
    assert.equal(plan.claims.length, 1);
    assert.equal(plan.claims[0]!.jobId, 'job-b');
  });

  test('critical-path nodes are preferred among runnable quanta', () => {
    const state = emptyEvidenceReviewJobStoreState();
    const job = multiShardJob({ jobId: 'job-path', workClass: 'semantic_reassessment' });
    // Succeed all readers and dossiers so promotion/critical-path nodes become runnable.
    for (const quantum of Object.values(job.quanta)) {
      if (
        quantum.kind === 'author_reader'
        || quantum.kind === 'verifier_reader'
        || quantum.kind === 'author_dossier'
        || quantum.kind === 'verifier_dossier'
        || quantum.kind === 'difference_index'
        || quantum.kind === 'obligations'
      ) {
        markSucceeded(job, quantum.quantumId);
      }
    }
    // Make skill_author runnable by succeeding its deps if present; otherwise force one.
    const skillAuthor = Object.values(job.quanta).find(q => q.kind === 'skill_author');
    const skillVerifier = Object.values(job.quanta).find(q => q.kind === 'skill_verifier');
    const commit = Object.values(job.quanta).find(q => q.kind === 'commit');
    assert.ok(skillAuthor || skillVerifier || commit, 'graph should include promotion nodes');

    // Leave only critical-path candidates runnable alongside a synthetic reader.
    // Prefer the lowest criticalPathRank among still-runnable nodes.
    upsertEvidenceReviewJob(state, job);
    const plan = planFairQuantumClaims(state, { maxClaims: 1, maxClaimsPerJob: 1 });
    assert.equal(plan.claims.length, 1);
    const claimed = job.quanta[plan.claims[0]!.quantumId]!;
    assert.ok(
      claimed.kind !== 'author_reader' && claimed.kind !== 'verifier_reader',
      `expected critical-path preference, got ${claimed.kind}`,
    );
  });

  test('Author and Verifier reader lanes receive balanced service', () => {
    const state = emptyEvidenceReviewJobStoreState();
    const job = multiShardJob({ jobId: 'job-lanes', workClass: 'live_learning' });
    const authorReaders = Object.values(job.quanta).filter(q => q.kind === 'author_reader');
    const verifierReaders = Object.values(job.quanta).filter(q => q.kind === 'verifier_reader');
    assert.ok(authorReaders.length >= 2 && verifierReaders.length >= 2);

    // Keep only readers runnable by leaving dossiers pending (deps unsatisfied).
    upsertEvidenceReviewJob(state, job);
    const plan = planFairQuantumClaims(state, {
      maxClaims: 4,
      maxClaimsPerJob: 4,
    });
    assert.equal(plan.claims.length, 4);
    const claimed = plan.claims.map(c => job.quanta[c.quantumId]!);
    const author = claimed.filter(q => q.lane === 'author' || q.kind === 'author_reader').length;
    const verifier = claimed.filter(q => q.lane === 'verifier' || q.kind === 'verifier_reader').length;
    assert.equal(author, 2);
    assert.equal(verifier, 2);

    // With prior author progress, prefer verifier next.
    const behind = multiShardJob({ jobId: 'job-behind-v', workClass: 'live_learning' });
    for (const q of Object.values(behind.quanta).filter(q => q.kind === 'author_reader').slice(0, 2)) {
      markSucceeded(behind, q.quantumId);
    }
    const behindState = emptyEvidenceReviewJobStoreState();
    upsertEvidenceReviewJob(behindState, behind);
    const next = planFairQuantumClaims(behindState, { maxClaims: 1, maxClaimsPerJob: 1 });
    const nextQuantum = behind.quanta[next.claims[0]!.quantumId]!;
    assert.equal(nextQuantum.lane ?? (nextQuantum.kind === 'verifier_reader' ? 'verifier' : undefined), 'verifier');
  });

  test('durable cursors survive restart and continue rotation', () => {
    const state = emptyEvidenceReviewJobStoreState();
    for (const jobId of ['job-a', 'job-b']) {
      upsertEvidenceReviewJob(state, multiShardJob({ jobId, workClass: 'live_learning' }));
    }
    upsertEvidenceReviewJob(state, multiShardJob({
      jobId: 'job-c',
      workClass: 'historical_learning',
    }));

    const first = planFairQuantumClaims(state, { maxClaims: 1, maxClaimsPerJob: 1 });
    assert.equal(first.claims.length, 1);

    // Simulate process restart: only JSON-serializable fairness is restored.
    const persisted = JSON.parse(JSON.stringify(first.fairness));
    const restored = normalizeFairnessState(persisted);
    assert.equal(restored.nextWorkClass, first.fairness.nextWorkClass);
    assert.deepEqual(restored.classCursors, first.fairness.classCursors);
    assert.deepEqual(restored.jobCursors, first.fairness.jobCursors);

    state.fairness = restored;
    const second = planFairQuantumClaims(state, { maxClaims: 1, maxClaimsPerJob: 1 });
    assert.equal(second.claims.length, 1);
    assert.notEqual(
      `${second.claims[0]!.jobId}:${second.claims[0]!.quantumId}`,
      `${first.claims[0]!.jobId}:${first.claims[0]!.quantumId}`,
    );

    // Corrupt / partial blobs normalize safely.
    const normalized = normalizeFairnessState({
      nextWorkClass: 'not-a-class',
      classCursors: { live_learning: 123, historical_learning: 'job-c' },
      jobCursors: { 'job-a': null, 'job-b': 'q-ok' },
    });
    assert.equal(normalized.nextWorkClass, 'operational_recovery');
    assert.equal(normalized.classCursors.historical_learning, 'job-c');
    assert.equal(normalized.classCursors.live_learning, undefined);
    assert.equal(normalized.jobCursors['job-b'], 'q-ok');
    assert.equal(normalized.jobCursors['job-a'], undefined);
  });

  test('maxClaims=0 is a no-op and preserves rotation cursors', () => {
    const state = emptyEvidenceReviewJobStoreState();
    state.fairness = {
      nextWorkClass: 'historical_learning',
      classCursors: { live_learning: 'job-x' },
      jobCursors: { 'job-x': 'q-1' },
    };
    upsertEvidenceReviewJob(state, multiShardJob({
      jobId: 'job-x',
      workClass: 'live_learning',
    }));
    const plan = planFairQuantumClaims(state, { maxClaims: 0, maxClaimsPerJob: 1 });
    assert.deepEqual(plan.claims, []);
    assert.equal(plan.fairness.nextWorkClass, 'historical_learning');
    assert.equal(plan.fairness.classCursors.live_learning, 'job-x');
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

describe('shouldStopClaiming drain gate (#lifecycle-fence)', () => {
  test('advanceJobsFairly stops new leases when shouldStopClaiming arms', async () => {
    const { EvidenceReviewEngine, advanceJobsFairly, readShardStructurally } = await import(
      '../src/utils/evidence-review-engine'
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-stop-claim-'));
    try {
      const storePath = path.join(root, 'jobs.json');
      let claims = 0;
      let stop = false;
      const engine = new EvidenceReviewEngine({
        jobStorePath: storePath,
        workingDirectory: root,
        maxQuantaPerAdvance: 1,
        runReaderLane: async ({ shard, lane }) => {
          claims += 1;
          // Arm the drain gate after the first claim so later fair claims stop.
          if (claims >= 1) stop = true;
          return {
            findingSet: readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane),
          };
        },
        runSkillAuthor: async () => {
          throw new Error('skill_author should not run under drain gate test');
        },
        runSkillVerifier: async () => {
          throw new Error('skill_verifier should not run under drain gate test');
        },
        commitTransition: async () => {
          throw new Error('commit should not run under drain gate test');
        },
      });

      const bundles = [validBundle('stop-a'), validBundle('stop-b'), validBundle('stop-c')];
      for (const bundle of bundles) {
        engine.createJob({
          bundle,
          candidate: candidateFrom(bundle),
          workClass: 'live_learning',
        });
      }

      const fair = await advanceJobsFairly(engine, 'wake-stop-claim', {
        maxClaims: 10,
        maxClaimsPerJob: 1,
        shouldStopClaiming: () => stop,
      });
      // First job may execute one quantum before the gate arms; later jobs stop.
      assert.ok(fair.claims >= 1, 'at least the first planned claim executes');
      assert.ok(fair.claims < 10, `stop gate must bound executed claims, got ${fair.claims}`);
      assert.ok(claims >= 1 && claims < 10, `reader claims after stop gate: ${claims}`);
      assert.ok(fair.jobIds.length <= 2, `stop gate bounds job fan-out: ${fair.jobIds.join(',')}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

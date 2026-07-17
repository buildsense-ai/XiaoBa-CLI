/**
 * Focused foundation tests for durable Evidence Review Dependency Graph (#107).
 *
 * Covers: dependency readiness, parallel runnable nodes, lease claim/expiry/reclaim,
 * idempotent duplicate completion, independent retries, restart reconstruction,
 * input-hash identity changes, and corrupted-state fail-closed behavior.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildDualLaneCoverageQuanta,
  buildReviewBasis,
  claimQuantum,
  completeQuantum,
  createEvidenceReviewJob,
  createReviewQuantum,
  deriveJobDisposition,
  deriveJobProgress,
  failQuantum,
  isQuantumRunnable,
  listRunnableQuanta,
  makeQuantumId,
  quantumInputHash,
  reclaimExpiredLeases,
  recoverJobAfterRestart,
  reuseSucceededQuanta,
  sha256Hex,
} from '../src/utils/evidence-review-graph-core';
import {
  emptyEvidenceReviewJobStoreState,
  getEvidenceReviewJob,
  loadAndRecoverEvidenceReviewJobStore,
  loadEvidenceReviewJobStore,
  saveEvidenceReviewJobStore,
  upsertEvidenceReviewJob,
} from '../src/utils/evidence-review-graph-store';
import type { EvidenceReviewJob } from '../src/utils/evidence-review-types';

function makeJob(overrides?: {
  jobId?: string;
  shards?: { shardId: string; contentHash: string }[];
  now?: Date;
}): EvidenceReviewJob {
  const now = overrides?.now ?? new Date('2026-07-17T00:00:00.000Z');
  const jobId = overrides?.jobId ?? 'job:test-foundation';
  const shards = overrides?.shards ?? [
    { shardId: 'shard-a', contentHash: sha256Hex('content-a') },
    { shardId: 'shard-b', contentHash: sha256Hex('content-b') },
  ];
  const basis = buildReviewBasis({
    manifestHash: sha256Hex(shards.map(s => s.contentHash).join('|')),
    evidenceBundleHash: sha256Hex('bundle'),
    registryReadSet: ['cap.demo@1'],
    referencedSkillHashes: [sha256Hex('skill')],
  });
  const quanta = buildDualLaneCoverageQuanta({
    jobId,
    shards,
    basisHash: basis.basisHash,
    now,
  });
  return createEvidenceReviewJob({
    jobId,
    workClass: 'live_learning',
    basis,
    quanta,
    domain: { shards },
    now,
  });
}

function tempStorePath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xiaoba-erg-${label}-`));
  return path.join(dir, 'evidence-review-jobs.json');
}

describe('Evidence Review Dependency Graph foundation (#107)', () => {
  test('content-identified Quantum identity changes when input hashes change', () => {
    const jobId = 'job:id';
    const a = createReviewQuantum(jobId, {
      kind: 'author_reader',
      inputs: { shardId: 's1', contentHash: 'hash-v1' },
      shardId: 's1',
      lane: 'author',
    });
    const b = createReviewQuantum(jobId, {
      kind: 'author_reader',
      inputs: { shardId: 's1', contentHash: 'hash-v2' },
      shardId: 's1',
      lane: 'author',
    });
    assert.notEqual(a.inputHash, b.inputHash);
    assert.notEqual(a.quantumId, b.quantumId);
    assert.equal(a.quantumId, makeQuantumId(jobId, 'author_reader', a.inputHash));
    assert.equal(
      a.inputHash,
      quantumInputHash({
        kind: 'author_reader',
        promptVersion: 'evidence-review-job-v1',
        policyVersion: 'evidence-review-policy-v1',
        shardId: 's1',
        contentHash: 'hash-v1',
      }),
    );
  });

  test('dependency readiness gates downstream nodes; independent readers run in parallel', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const job = makeJob({ now });
    const runnable = listRunnableQuanta(job, now);
    const kinds = runnable.map(q => q.kind).sort();
    // Both author and verifier readers for both shards are ready in parallel.
    assert.equal(runnable.length, 4);
    assert.deepEqual(kinds, [
      'author_reader',
      'author_reader',
      'verifier_reader',
      'verifier_reader',
    ]);

    // Dossiers are not runnable until their lane readers succeed.
    const authorDossier = Object.values(job.quanta).find(q => q.kind === 'author_dossier')!;
    assert.equal(isQuantumRunnable(job, authorDossier, now), false);

    // Complete one author reader — dossier still blocked by remaining readers.
    const authorReaders = Object.values(job.quanta).filter(q => q.kind === 'author_reader');
    for (const reader of authorReaders) {
      const claim = claimQuantum(job, reader.quantumId, { ownerWakeId: 'wake-1', now });
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error('expected claim');
      const done = completeQuantum(job, reader.quantumId, {
        result: { coverage: 'covered' },
        leaseId: claim.lease.leaseId,
        now,
      });
      assert.equal(done.ok, true);
    }

    assert.equal(isQuantumRunnable(job, authorDossier, now), true);
    // Commit remains blocked.
    const commit = Object.values(job.quanta).find(q => q.kind === 'commit')!;
    assert.equal(isQuantumRunnable(job, commit, now), false);
  });

  test('lease claim, expiry, and reclaim make unfinished work eligible again', () => {
    const t0 = new Date('2026-07-17T00:00:00.000Z');
    const job = makeJob({ now: t0 });
    const reader = Object.values(job.quanta).find(q => q.kind === 'author_reader')!;

    const claim = claimQuantum(job, reader.quantumId, {
      ownerWakeId: 'wake-a',
      leaseMs: 5_000,
      now: t0,
    });
    assert.equal(claim.ok, true);
    if (!claim.ok) throw new Error('expected claim');
    assert.equal(job.quanta[reader.quantumId]!.state, 'leased');
    assert.equal(job.quanta[reader.quantumId]!.lease?.ownerWakeId, 'wake-a');

    // Still leased before expiry → not runnable / not re-claimable.
    const mid = new Date(t0.getTime() + 1_000);
    assert.equal(isQuantumRunnable(job, job.quanta[reader.quantumId]!, mid), false);
    const reclaimAttempt = claimQuantum(job, reader.quantumId, {
      ownerWakeId: 'wake-b',
      now: mid,
    });
    assert.equal(reclaimAttempt.ok, false);

    // After expiry → runnable and reclaimable.
    const expired = new Date(t0.getTime() + 6_000);
    assert.equal(isQuantumRunnable(job, job.quanta[reader.quantumId]!, expired), true);
    const reclaimed = reclaimExpiredLeases(job, expired);
    assert.equal(reclaimed.length, 1);
    assert.equal(job.quanta[reader.quantumId]!.state, 'pending');
    assert.equal(job.quanta[reader.quantumId]!.lease, undefined);

    const reclaim = claimQuantum(job, reader.quantumId, {
      ownerWakeId: 'wake-b',
      leaseMs: 5_000,
      now: expired,
    });
    assert.equal(reclaim.ok, true);
    if (!reclaim.ok) throw new Error('expected reclaim claim');
    assert.equal(reclaim.lease.ownerWakeId, 'wake-b');
  });

  test('successful completion is idempotent for the same Quantum identity', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const job = makeJob({ now });
    const reader = Object.values(job.quanta).find(q => q.kind === 'author_reader')!;
    const claim = claimQuantum(job, reader.quantumId, { ownerWakeId: 'wake-1', now });
    assert.equal(claim.ok, true);
    if (!claim.ok) throw new Error('expected claim');

    const first = completeQuantum(job, reader.quantumId, {
      result: { coverage: 'covered', findings: 1 },
      leaseId: claim.lease.leaseId,
      transcriptPath: 'logs/reader-1.jsonl',
      now,
    });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('expected complete');
    assert.equal(first.alreadySucceeded, false);
    assert.equal(job.quanta[reader.quantumId]!.state, 'succeeded');
    const resultHash = job.quanta[reader.quantumId]!.resultHash;

    // Duplicate completion is a no-op success and does not re-execute.
    const second = completeQuantum(job, reader.quantumId, {
      result: { coverage: 'covered', findings: 999 },
      now: new Date(now.getTime() + 1_000),
    });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error('expected idempotent complete');
    assert.equal(second.alreadySucceeded, true);
    assert.equal(job.quanta[reader.quantumId]!.resultHash, resultHash);
    assert.deepEqual(job.quanta[reader.quantumId]!.result, { coverage: 'covered', findings: 1 });

    // Already succeeded cannot be re-leased.
    const reClaim = claimQuantum(job, reader.quantumId, {
      ownerWakeId: 'wake-2',
      now: new Date(now.getTime() + 2_000),
    });
    assert.equal(reClaim.ok, false);
    if (reClaim.ok) throw new Error('should not reclaim');
    assert.equal(reClaim.reason, 'already_succeeded');
  });

  test('independent retries keep separate backoff state per Quantum', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const job = makeJob({ now });
    const readers = Object.values(job.quanta)
      .filter(q => q.kind === 'author_reader')
      .sort((a, b) => a.quantumId.localeCompare(b.quantumId, 'en'));
    assert.ok(readers.length >= 2);
    const [q1, q2] = readers;

    for (const quantum of [q1, q2]) {
      const claim = claimQuantum(job, quantum.quantumId, { ownerWakeId: 'wake-1', now });
      assert.equal(claim.ok, true);
    }

    const fail1 = failQuantum(job, q1.quantumId, {
      message: 'provider timeout',
      retryBaseMs: 1_000,
      retryMaxMs: 30_000,
      maxAttempts: 5,
      now,
    });
    assert.equal(fail1.ok, true);
    if (!fail1.ok) throw new Error('expected fail1');
    assert.equal(fail1.quantum.state, 'retry_wait');
    assert.equal(fail1.quantum.attempts, 1);
    assert.equal(fail1.quantum.currentDelayMs, 1_000);
    assert.equal(fail1.quantum.nextRetryAt, '2026-07-17T00:00:01.000Z');

    const later = new Date(now.getTime() + 500);
    const fail2 = failQuantum(job, q2.quantumId, {
      message: 'invalid schema',
      retryBaseMs: 2_000,
      retryMaxMs: 30_000,
      maxAttempts: 5,
      now: later,
    });
    assert.equal(fail2.ok, true);
    if (!fail2.ok) throw new Error('expected fail2');
    assert.equal(fail2.quantum.state, 'retry_wait');
    assert.equal(fail2.quantum.attempts, 1);
    assert.equal(fail2.quantum.currentDelayMs, 2_000);
    assert.equal(fail2.quantum.nextRetryAt, '2026-07-17T00:00:02.500Z');

    // Independent: q1 remains on its own deadline and message.
    assert.equal(job.quanta[q1.quantumId]!.nextRetryAt, '2026-07-17T00:00:01.000Z');
    assert.equal(job.quanta[q1.quantumId]!.failureMessage, 'provider timeout');
    assert.equal(job.quanta[q2.quantumId]!.failureMessage, 'invalid schema');

    // Before deadline: not runnable; after: runnable only for that node.
    assert.equal(
      isQuantumRunnable(job, job.quanta[q1.quantumId]!, new Date('2026-07-17T00:00:00.500Z')),
      false,
    );
    assert.equal(
      isQuantumRunnable(job, job.quanta[q1.quantumId]!, new Date('2026-07-17T00:00:01.000Z')),
      true,
    );
    assert.equal(
      isQuantumRunnable(job, job.quanta[q2.quantumId]!, new Date('2026-07-17T00:00:01.000Z')),
      false,
    );
  });

  test('restart reconstruction reclaims expired leases and preserves successes', () => {
    const t0 = new Date('2026-07-17T00:00:00.000Z');
    const job = makeJob({ now: t0 });
    const readers = Object.values(job.quanta).filter(q => q.kind === 'author_reader');
    const [doneReader, leasedReader] = readers;

    const claimDone = claimQuantum(job, doneReader.quantumId, {
      ownerWakeId: 'wake-1',
      leaseMs: 5_000,
      now: t0,
    });
    assert.equal(claimDone.ok, true);
    if (!claimDone.ok) throw new Error('claimDone');
    completeQuantum(job, doneReader.quantumId, {
      result: { ok: true },
      leaseId: claimDone.lease.leaseId,
      now: t0,
    });

    const claimLeased = claimQuantum(job, leasedReader.quantumId, {
      ownerWakeId: 'wake-1',
      leaseMs: 5_000,
      now: t0,
    });
    assert.equal(claimLeased.ok, true);

    // Persist and "restart" after lease expiry.
    const storePath = tempStorePath('restart');
    const state = emptyEvidenceReviewJobStoreState();
    upsertEvidenceReviewJob(state, job);
    saveEvidenceReviewJobStore(storePath, state);

    const recoveredAt = new Date(t0.getTime() + 10_000);
    const recovered = loadAndRecoverEvidenceReviewJobStore(storePath, recoveredAt);
    assert.equal(recovered.stateCorrupt, undefined);
    const live = getEvidenceReviewJob(recovered, job.jobId)!;
    assert.equal(live.quanta[doneReader.quantumId]!.state, 'succeeded');
    assert.equal(live.quanta[leasedReader.quantumId]!.state, 'pending');
    assert.equal(live.quanta[leasedReader.quantumId]!.lease, undefined);
    assert.equal(live.disposition, 'active');
    assert.ok(listRunnableQuanta(live, recoveredAt).some(q => q.quantumId === leasedReader.quantumId));

    // Progress is derived from nodes, not a linear phase flag.
    const progress = deriveJobProgress(live, recoveredAt);
    assert.equal(progress.succeededQuanta, 1);
    assert.ok(progress.runnableQuanta >= 3); // remaining readers
    assert.equal(progress.disposition, 'active');
  });

  test('job disposition is derived from Quantum graph (commit success → completed)', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    // Tiny single-node graph for disposition derivation.
    const basis = buildReviewBasis({
      manifestHash: 'm',
      evidenceBundleHash: 'e',
    });
    const commit = createReviewQuantum('job:tiny', {
      kind: 'commit',
      inputs: { basisHash: basis.basisHash },
    }, now);
    const job = createEvidenceReviewJob({
      jobId: 'job:tiny',
      workClass: 'operational_recovery',
      basis,
      quanta: [commit],
      now,
    });
    assert.equal(deriveJobDisposition(job), 'active');
    const claim = claimQuantum(job, commit.quantumId, { ownerWakeId: 'w', now });
    assert.equal(claim.ok, true);
    if (!claim.ok) throw new Error('claim');
    completeQuantum(job, commit.quantumId, {
      result: { transitionId: 't1' },
      leaseId: claim.lease.leaseId,
      now,
    });
    assert.equal(job.disposition, 'completed');
    assert.equal(deriveJobDisposition(job), 'completed');
  });

  test('reuseSucceededQuanta copies only matching kind+inputHash successes', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const prior = makeJob({ jobId: 'job:prior', now });
    const reader = Object.values(prior.quanta).find(q => q.kind === 'author_reader')!;
    const claim = claimQuantum(prior, reader.quantumId, { ownerWakeId: 'w', now });
    assert.equal(claim.ok, true);
    if (!claim.ok) throw new Error('claim');
    completeQuantum(prior, reader.quantumId, {
      result: { reused: true },
      leaseId: claim.lease.leaseId,
      now,
    });

    // Successor with same shard inputs → same content identity for that reader.
    const successor = makeJob({ jobId: 'job:successor', now });
    const reused = reuseSucceededQuanta(successor, prior);
    const match = Object.values(reused.quanta).find(
      q => q.kind === reader.kind && q.inputHash === reader.inputHash,
    );
    assert.ok(match);
    assert.equal(match!.state, 'succeeded');
    assert.deepEqual(match!.result, { reused: true });

    // Changing content hash produces a new identity that is not reused.
    const changed = makeJob({
      jobId: 'job:changed',
      now,
      shards: [
        { shardId: 'shard-a', contentHash: sha256Hex('content-a-CHANGED') },
        { shardId: 'shard-b', contentHash: sha256Hex('content-b') },
      ],
    });
    const notReused = reuseSucceededQuanta(changed, prior);
    const changedReaders = Object.values(notReused.quanta).filter(q => q.kind === 'author_reader');
    // At most one author reader may still match (shard-b); shard-a must remain pending.
    const pendingChanged = changedReaders.filter(q => q.state === 'pending');
    assert.ok(pendingChanged.length >= 1);
    assert.ok(
      pendingChanged.some(q => q.shardId === 'shard-a'),
      'changed shard-a must not reuse prior success',
    );
  });

  test('corrupted durable state is quarantined and fail-closed', () => {
    const storePath = tempStorePath('corrupt');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{not-json', 'utf8');

    const loaded = loadEvidenceReviewJobStore(storePath);
    assert.equal(loaded.stateCorrupt, true);
    assert.deepEqual(loaded.jobs, {});
    assert.equal(fs.existsSync(storePath), false);

    const quarantined = fs.readdirSync(path.dirname(storePath))
      .filter(name => name.includes('corrupt'));
    assert.equal(quarantined.length, 1);

    // Invalid schema also fail-closed.
    const badSchemaPath = tempStorePath('bad-schema');
    fs.mkdirSync(path.dirname(badSchemaPath), { recursive: true });
    fs.writeFileSync(
      badSchemaPath,
      JSON.stringify({ schemaVersion: 999, jobs: { x: { jobId: 'x' } } }, null, 2),
      'utf8',
    );
    const bad = loadEvidenceReviewJobStore(badSchemaPath);
    assert.equal(bad.stateCorrupt, true);
    assert.deepEqual(bad.jobs, {});
  });

  test('atomic save round-trips job graph without losing Quantum state', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const job = makeJob({ now });
    const reader = Object.values(job.quanta).find(q => q.kind === 'verifier_reader')!;
    const claim = claimQuantum(job, reader.quantumId, {
      ownerWakeId: 'wake-persist',
      leaseMs: 30_000,
      now,
    });
    assert.equal(claim.ok, true);

    const storePath = tempStorePath('roundtrip');
    const state = emptyEvidenceReviewJobStoreState();
    upsertEvidenceReviewJob(state, job);
    saveEvidenceReviewJobStore(storePath, state);

    const reloaded = loadEvidenceReviewJobStore(storePath);
    assert.equal(reloaded.stateCorrupt, undefined);
    const live = getEvidenceReviewJob(reloaded, job.jobId)!;
    assert.equal(live.quanta[reader.quantumId]!.state, 'leased');
    assert.equal(live.quanta[reader.quantumId]!.lease?.ownerWakeId, 'wake-persist');
    assert.equal(live.basis.basisHash, job.basis.basisHash);
  });

  test('recoverJobAfterRestart is pure over an in-memory job', () => {
    const t0 = new Date('2026-07-17T00:00:00.000Z');
    const job = makeJob({ now: t0 });
    const reader = Object.values(job.quanta).find(q => q.kind === 'verifier_reader')!;
    claimQuantum(job, reader.quantumId, {
      ownerWakeId: 'wake-x',
      leaseMs: 1_000,
      now: t0,
    });
    const recovered = recoverJobAfterRestart(job, new Date(t0.getTime() + 5_000));
    assert.equal(recovered.quanta[reader.quantumId]!.state, 'pending');
    assert.equal(deriveJobDisposition(recovered), 'active');
  });
});

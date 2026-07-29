import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  claimQuantum,
  completeQuantum,
  createReviewQuantum,
  failQuantum,
  type GraphJobView,
} from '../src/utils/evidence-review-graph-core';

function fixtureJob(): { job: GraphJobView; quantumId: string } {
  const now = new Date('2026-07-29T00:00:00.000Z');
  const quantum = createReviewQuantum('job:lease-fencing', {
    kind: 'author_reader',
    inputs: { shardId: 'shard:1' },
    shardId: 'shard:1',
    lane: 'author',
  }, now);
  return {
    quantumId: quantum.quantumId,
    job: {
      disposition: 'active',
      quanta: { [quantum.quantumId]: quantum },
      updatedAt: now.toISOString(),
    },
  };
}

describe('Evidence Review Quantum lease fencing', () => {
  test('rejects completion and failure when a Quantum is not leased', () => {
    const { job, quantumId } = fixtureJob();

    assert.deepEqual(
      completeQuantum(job, quantumId, { result: { ok: true }, leaseId: 'lease:stale' }),
      { ok: false, reason: 'not_leased' },
    );
    assert.deepEqual(
      failQuantum(job, quantumId, { message: 'late failure', leaseId: 'lease:stale' }),
      { ok: false, reason: 'lease_mismatch' },
    );
    assert.equal(job.quanta[quantumId]?.state, 'pending');
  });

  test('rejects stale attempt completion and failure after a newer lease is claimed', () => {
    const { job, quantumId } = fixtureJob();
    const first = claimQuantum(job, quantumId, {
      ownerWakeId: 'wake:first',
      now: new Date('2026-07-29T00:00:00.000Z'),
      leaseMs: 10,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = claimQuantum(job, quantumId, {
      ownerWakeId: 'wake:second',
      now: new Date('2026-07-29T00:00:00.011Z'),
      leaseMs: 10,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    assert.deepEqual(
      completeQuantum(job, quantumId, { result: { stale: true }, leaseId: first.lease.leaseId }),
      { ok: false, reason: 'lease_mismatch' },
    );
    assert.deepEqual(
      failQuantum(job, quantumId, { message: 'stale failure', leaseId: first.lease.leaseId }),
      { ok: false, reason: 'lease_mismatch' },
    );
    assert.equal(job.quanta[quantumId]?.lease?.leaseId, second.lease.leaseId);
    assert.equal(job.quanta[quantumId]?.state, 'leased');
  });
});

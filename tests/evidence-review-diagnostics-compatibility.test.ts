/**
 * #110 foundation tests — operator diagnostic projections and legacy
 * compatibility migration for Evidence Review Jobs.
 *
 * Focused diagnostics/compatibility tests for integrated #110 surface.
 * Pure modules only. No RuntimeLearning, dashboard routes, or scheduler wiring.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDispositionSeparation,
  assertProjectionFacets,
  classifyOperatorDisposition,
  listOperatorProjections,
  projectEvidenceReviewJob,
  toProjectionInput,
  type EvidenceReviewOperatorProjection,
  type EvidenceReviewProjectionInput,
  type ProjectionQuantum,
} from '../src/utils/evidence-review-diagnostics';
import {
  assertMigrationPreserved,
  migrateLegacyReviewRecords,
  migrateOperationalQueueEntries,
  migrateOperationalReviewRetry,
  migratePromptBudgetBlocked,
  parseLegacyOperationalRetry,
  parseLegacyPromptBudgetBlocked,
  type LegacyOperationalReviewRetryRecord,
  type LegacyPromptBudgetBlockedRecord,
} from '../src/utils/evidence-review-compatibility';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-07-17T04:00:00.000Z');

function quantum(partial: ProjectionQuantum): ProjectionQuantum {
  return {
    attempts: 0,
    currentDelayMs: 0,
    dependencyQuantumIds: [],
    transcriptPaths: [],
    updatedAt: FIXED_NOW.toISOString(),
    ...partial,
  };
}

function dualLaneJob(overrides: Partial<EvidenceReviewProjectionInput> = {}): EvidenceReviewProjectionInput {
  const quanta: ProjectionQuantum[] = [
    quantum({
      quantumId: 'q-author-1',
      kind: 'author_reader',
      state: 'pending',
      shardId: 'shard-1',
      lane: 'author',
    }),
    quantum({
      quantumId: 'q-verifier-1',
      kind: 'verifier_reader',
      state: 'pending',
      shardId: 'shard-1',
      lane: 'verifier',
    }),
    quantum({
      quantumId: 'q-author-dossier',
      kind: 'author_dossier',
      state: 'pending',
      dependencyQuantumIds: ['q-author-1'],
    }),
  ];
  return {
    jobId: 'job-fixture',
    disposition: 'active',
    workClass: 'live_learning',
    basisHash: 'basis-abc',
    manifestHash: 'manifest-abc',
    shardCount: 1,
    quanta,
    obligations: [],
    obligationDispositions: [],
    ...overrides,
  };
}

function evidenceBundle(bundleId: string): Record<string, unknown> {
  return {
    bundleId,
    episode: { capabilityId: bundleId, title: `Title ${bundleId}` },
    completionEvidence: [{ ref: `${bundleId}.jsonl#1` }],
    settlementEvidence: [{ ref: `${bundleId}.jsonl#2` }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [{ kind: 'user-intent', value: `intent-${bundleId}`, sourceRefs: [] }],
  };
}

function candidate(capabilityId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId,
    title: `Title ${capabilityId}`,
    applicability: 'tests',
    actionPattern: 'act',
    boundaries: [],
    risks: [],
    solvedLoop: {
      problem: 'p',
      action: 'a',
      verification: 'v',
      noCorrection: 'n',
    },
    provenance: [
      {
        filePath: `${capabilityId}.jsonl`,
        turn: 1,
        role: 'problem-action',
        unitByteRange: { start: 0, end: 10 },
      },
    ],
    generatedAt: FIXED_NOW.toISOString(),
    sourceUnit: {
      filePath: `${capabilityId}.jsonl`,
      byteRange: { start: 0, end: 10 },
      generatedAt: FIXED_NOW.toISOString(),
    },
  };
}

function operationalRetryFixture(
  overrides: Partial<LegacyOperationalReviewRetryRecord> = {},
): LegacyOperationalReviewRetryRecord {
  const bundle = evidenceBundle('bundle-op');
  const cand = candidate('cap-op');
  return {
    entryId: 'op_entry_1',
    candidateCapabilityId: 'cap-op',
    bundleId: 'bundle-op',
    bundle,
    candidate: cand,
    failureKind: 'branch_timeout',
    failureMessage: 'Author branch timed out at Review Deadline',
    failureTranscripts: [
      '/tmp/xiaoba/transcripts/author-1.jsonl',
      '/tmp/xiaoba/transcripts/verifier-1.jsonl',
    ],
    attempts: 3,
    currentDelayMs: 480_000,
    nextRetryAt: '2026-07-17T05:00:00.000Z',
    createdAt: '2026-07-17T01:00:00.000Z',
    updatedAt: '2026-07-17T03:00:00.000Z',
    provenance: cand.provenance as readonly unknown[],
    evidenceFingerprint: 'fp-evidence-op',
    reviewerVersion: 'promotion-reviewer-v3',
    ...overrides,
  };
}

function promptBudgetBlockedFixture(
  overrides: Partial<LegacyPromptBudgetBlockedRecord> = {},
): LegacyPromptBudgetBlockedRecord {
  const bundle = evidenceBundle('bundle-pbb');
  const cand = candidate('cap-pbb');
  return {
    entryId: 'pbb_entry_1',
    candidateCapabilityId: 'cap-pbb',
    bundleId: 'bundle-pbb',
    bundle,
    candidate: cand,
    estimatedPromptTokens: 19_200,
    maxPromptTokens: 8_000,
    blockedReason: 'estimated evidence bundle exceeded maxPromptTokens',
    blockedAt: '2026-06-01T12:00:00.000Z',
    failureTranscripts: ['/tmp/xiaoba/transcripts/admission-block-1.jsonl'],
    attempts: 1,
    provenance: cand.provenance as readonly unknown[],
    evidenceFingerprint: 'fp-evidence-pbb',
    reviewerVersion: 'promotion-reviewer-v2',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Projection states
// ---------------------------------------------------------------------------

describe('Evidence Review diagnostic projections (#110)', () => {
  test('projects active coverage with incomplete dual-lane readers', () => {
    const job = dualLaneJob();
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);

    assert.equal(projection.operatorDisposition, 'incomplete_coverage');
    assert.equal(projection.activeCoverage.shardCount, 1);
    assert.equal(projection.activeCoverage.authorCoveredShards, 0);
    assert.equal(projection.activeCoverage.verifierCoveredShards, 0);
    assert.equal(projection.activeCoverage.complete, false);
    assert.equal(projection.nextDueWork.runnableQuanta, 2);
    assert.ok(projection.summary.includes('coverage incomplete'));
  });

  test('projects leases without reading raw queue JSON', () => {
    const job = dualLaneJob({
      quanta: [
        quantum({
          quantumId: 'q-leased',
          kind: 'author_reader',
          state: 'leased',
          shardId: 'shard-1',
          lane: 'author',
          lease: {
            leaseId: 'lease-1',
            ownerWakeId: 'wake-9',
            leasedAt: '2026-07-17T03:59:00.000Z',
            expiresAt: '2026-07-17T04:05:00.000Z',
          },
        }),
        quantum({
          quantumId: 'q-verifier-1',
          kind: 'verifier_reader',
          state: 'pending',
          shardId: 'shard-1',
          lane: 'verifier',
        }),
      ],
    });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'leased');
    assert.equal(projection.leases.count, 1);
    assert.equal(projection.leases.items[0]?.leaseId, 'lease-1');
    assert.equal(projection.leases.items[0]?.ownerWakeId, 'wake-9');
    assert.match(projection.summary, /leased quantum/);
  });

  test('projects retry wait with attempts and next due', () => {
    const job = dualLaneJob({
      quanta: [
        quantum({
          quantumId: 'q-retry',
          kind: 'skill_author',
          state: 'retry_wait',
          attempts: 2,
          currentDelayMs: 120_000,
          nextRetryAt: '2026-07-17T04:10:00.000Z',
          failureMessage: 'provider 429',
          transcriptPaths: ['/t/a.jsonl'],
        }),
      ],
      nextDueAt: '2026-07-17T04:10:00.000Z',
    });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'local_retry');
    assert.equal(projection.retryWait.count, 1);
    assert.equal(projection.retryWait.totalAttempts, 2);
    assert.equal(projection.retryWait.earliestNextRetryAt, '2026-07-17T04:10:00.000Z');
    assert.equal(projection.nextDueWork.nextDueAt, '2026-07-17T04:10:00.000Z');
  });

  test('projects semantic defer with unresolved obligations', () => {
    const job = dualLaneJob({
      disposition: 'deferred',
      obligations: [
        { obligationId: 'ob-1' },
        { obligationId: 'ob-2' },
      ],
      obligationDispositions: [
        { obligationId: 'ob-1' },
      ],
    });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'semantic_defer');
    assert.equal(projection.semanticDefer.deferred, true);
    assert.equal(projection.obligations.total, 2);
    assert.equal(projection.obligations.resolved, 1);
    assert.equal(projection.obligations.unresolved, 1);
    assert.deepEqual(projection.obligations.unresolvedIds, ['ob-2']);
    assert.match(projection.summary, /unresolved obligation/);
  });

  test('projects supersession with successor link', () => {
    const job = dualLaneJob({
      disposition: 'superseded',
      successorJobId: 'job-successor',
      supersededByJobId: 'job-successor',
      parentJobId: 'job-grandparent',
    });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'stale_basis_superseded');
    assert.equal(projection.supersession.superseded, true);
    assert.equal(projection.successorLink, 'job-successor');
    assert.equal(projection.supersession.parentJobId, 'job-grandparent');
    assert.match(projection.summary, /superseded by job-successor/);
  });

  test('projects completion with transition link', () => {
    const job = dualLaneJob({
      disposition: 'completed',
      transitionId: 'transition-42',
      quanta: [
        quantum({ quantumId: 'q-done', kind: 'commit', state: 'succeeded' }),
      ],
    });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'completed');
    assert.equal(projection.completion.completed, true);
    assert.equal(projection.transitionLink, 'transition-42');
    assert.match(projection.summary, /completed as transition-42/);
  });

  test('projects terminal integrity failure', () => {
    const job = dualLaneJob({
      disposition: 'terminal_failed',
      terminalReason: 'manifest hash mismatch',
      quanta: [
        quantum({
          quantumId: 'q-fail',
          kind: 'commit',
          state: 'terminal_failed',
          failureMessage: 'manifest hash mismatch',
        }),
      ],
    });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'terminal_integrity_failure');
    assert.equal(projection.terminalIntegrityFailure.failed, true);
    assert.equal(projection.terminalIntegrityFailure.reason, 'manifest hash mismatch');
    assert.equal(projection.terminalIntegrityFailure.failedQuanta, 1);
    assert.match(projection.summary, /terminal: manifest hash mismatch/);
  });

  test('projects next due work from runnable quanta and deadlines', () => {
    const job = dualLaneJob({
      quanta: [
        quantum({
          quantumId: 'q-ready',
          kind: 'author_reader',
          state: 'pending',
          shardId: 'shard-1',
          lane: 'author',
        }),
        quantum({
          quantumId: 'q-blocked',
          kind: 'author_dossier',
          state: 'pending',
          dependencyQuantumIds: ['q-ready'],
        }),
        quantum({
          quantumId: 'q-retry-due',
          kind: 'verifier_reader',
          state: 'retry_wait',
          nextRetryAt: '2026-07-17T03:59:00.000Z',
          attempts: 1,
          shardId: 'shard-1',
          lane: 'verifier',
        }),
      ],
    });
    // classify prefers local_retry (quantum retry_wait) over runnable; nextDue still lists due work
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'local_retry');
    assert.ok(projection.nextDueWork.dueQuantumIds.includes('q-ready'));
    assert.ok(projection.nextDueWork.dueQuantumIds.includes('q-retry-due'));
    assert.ok(!projection.nextDueWork.dueQuantumIds.includes('q-blocked'));
    assert.equal(projection.nextDueWork.nextDueAt, '2026-07-17T03:59:00.000Z');
  });

  test('listOperatorProjections sorts by jobId', () => {
    const views = listOperatorProjections([
      dualLaneJob({ jobId: 'job-b', disposition: 'completed', transitionId: 't1' }),
      dualLaneJob({ jobId: 'job-a', disposition: 'deferred' }),
    ], FIXED_NOW);
    assert.deepEqual(views.map(v => v.jobId), ['job-a', 'job-b']);
  });

  test('toProjectionInput strips engine payloads to projection surface', () => {
    const input = toProjectionInput({
      jobId: 'job-engine',
      disposition: 'active',
      workClass: 'historical_learning',
      basis: { basisHash: 'b1', manifestHash: 'm1' },
      manifest: { manifestHash: 'm1', shardIds: ['s1', 's2'] },
      quanta: {
        'q1': quantum({ quantumId: 'q1', kind: 'author_reader', state: 'succeeded', shardId: 's1', lane: 'author' }),
      },
      obligations: [{ obligationId: 'ob' }],
      obligationDispositions: [],
      nextDueAt: '2026-07-17T06:00:00.000Z',
    });
    assert.equal(input.basisHash, 'b1');
    assert.equal(input.shardCount, 2);
    const projection = projectEvidenceReviewJob(input, FIXED_NOW);
    assert.equal(projection.activeCoverage.authorCoveredShards, 1);
    assert.equal(projection.activeCoverage.shardCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Corrupted data
// ---------------------------------------------------------------------------

describe('Evidence Review diagnostic corruption handling (#110)', () => {
  test('projects corrupt_state disposition and keeps other facets defined', () => {
    const job = dualLaneJob({ stateCorrupt: true, quanta: [], shardCount: 0 });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'corrupt_state');
    assert.equal(projection.stateCorrupt, true);
    assert.equal(projection.activeCoverage.shardCount, 0);
    assert.equal(projection.leases.count, 0);
    assert.match(projection.summary, /corrupt durable state/);
    for (const result of assertProjectionFacets(projection)) {
      assert.equal(result.passed, true, result.detail);
    }
  });

  test('tolerates missing quanta, obligations, and hashes', () => {
    const projection = projectEvidenceReviewJob({
      jobId: 'job-sparse',
      disposition: 'active',
    }, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'active_coverage');
    assert.equal(projection.counts.total, 0);
    assert.equal(projection.obligations.total, 0);
    assert.equal(projection.basisHash, undefined);
  });

  test('ignores malformed nextRetryAt when computing runnable work', () => {
    const job = dualLaneJob({
      quanta: [
        quantum({
          quantumId: 'q-bad-retry',
          kind: 'author_reader',
          state: 'retry_wait',
          nextRetryAt: 'not-a-date',
          shardId: 'shard-1',
          lane: 'author',
        }),
      ],
    });
    const projection = projectEvidenceReviewJob(job, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'local_retry');
    assert.equal(projection.nextDueWork.runnableQuanta, 0);
    assert.equal(projection.retryWait.earliestNextRetryAt, undefined);
  });
});

// ---------------------------------------------------------------------------
// Compatibility migration
// ---------------------------------------------------------------------------

describe('Evidence Review compatibility migration (#110)', () => {
  test('migrates Operational Review Retry without dropping evidence/attempts/backoff/transcripts', () => {
    const source = operationalRetryFixture();
    const seed = migrateOperationalReviewRetry(source, { now: FIXED_NOW });

    assert.equal(seed.sourceKind, 'operational_retry');
    assert.equal(seed.proposedJobId, 'job:migrated:op:op_entry_1');
    assert.equal(seed.workClass, 'operational_recovery');
    assert.equal(seed.attempts, 3);
    assert.equal(seed.currentDelayMs, 480_000);
    assert.equal(seed.nextRetryAt, '2026-07-17T05:00:00.000Z');
    assert.equal(seed.failureKind, 'branch_timeout');
    assert.deepEqual(seed.transcriptPaths, source.failureTranscripts);
    assert.equal(seed.bundle, source.bundle);
    assert.equal(seed.candidate, source.candidate);
    assert.equal(seed.provenance, source.provenance);
    assert.equal(seed.evidenceFingerprint, 'fp-evidence-op');

    const check = assertMigrationPreserved({ kind: 'operational_retry', record: source }, seed);
    assert.equal(check.preserved, true, check.violations.join('; '));

    const projection = projectEvidenceReviewJob(seed.projectionInput, FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'local_retry');
    assert.equal(projection.retryWait.totalAttempts, 3);
    assert.equal(projection.retryWait.earliestNextRetryAt, source.nextRetryAt);
  });

  test('migrates prompt-budget-blocked records into pending coverage (not dropped)', () => {
    const source = promptBudgetBlockedFixture();
    const seed = migratePromptBudgetBlocked(source, { now: FIXED_NOW });

    assert.equal(seed.sourceKind, 'prompt_budget_blocked');
    assert.equal(seed.workClass, 'live_learning');
    assert.equal(seed.durableDisposition, 'active');
    assert.equal(seed.estimatedPromptTokens, 19_200);
    assert.equal(seed.maxPromptTokens, 8_000);
    assert.equal(seed.bundle, source.bundle);
    assert.equal(seed.candidate, source.candidate);
    assert.deepEqual(seed.transcriptPaths, source.failureTranscripts);
    assert.ok(seed.messages[0]?.includes('prompt-budget') || seed.messages[0]?.includes('maxPromptTokens'));

    const check = assertMigrationPreserved({ kind: 'prompt_budget_blocked', record: source }, seed);
    assert.equal(check.preserved, true, check.violations.join('; '));

    const projection = projectEvidenceReviewJob(seed.projectionInput, FIXED_NOW);
    // Single pending author_reader → incomplete_coverage (not rejected).
    assert.ok(
      projection.operatorDisposition === 'incomplete_coverage'
      || projection.operatorDisposition === 'active_coverage',
    );
    assert.equal(projection.counts.pending, 1);
    assert.equal(projection.counts.retryWait, 0);
  });

  test('batch migration skips corrupt records and preserves valid ones', () => {
    const op = operationalRetryFixture({ entryId: 'op_ok' });
    const pbb = promptBudgetBlockedFixture({ entryId: 'pbb_ok' });
    const corrupt = { entryId: 'broken', failureKind: 'branch_failure' }; // no bundle/candidate
    const empty = null;
    const unknown = { entryId: 'x', foo: 'bar' };

    const result = migrateLegacyReviewRecords(
      [op, pbb, corrupt, empty, unknown],
      { now: FIXED_NOW },
    );

    assert.equal(result.seeds.length, 2);
    assert.equal(result.preservedFieldCounts.evidenceBundles, 2);
    assert.equal(result.preservedFieldCounts.candidates, 2);
    assert.ok(result.preservedFieldCounts.transcripts >= 3);
    assert.ok(result.preservedFieldCounts.attempts >= 4);
    assert.ok(result.skipped.length >= 3);
    assert.ok(result.skipped.some(s => s.reason.includes('missing required')));
    assert.ok(result.skipped.some(s => s.reason.includes('unrecognized') || s.reason.includes('not an object')));
  });

  test('migrateOperationalQueueEntries tags operational shape', () => {
    const op = operationalRetryFixture();
    const result = migrateOperationalQueueEntries([op], { now: FIXED_NOW });
    assert.equal(result.seeds.length, 1);
    assert.equal(result.seeds[0]?.sourceKind, 'operational_retry');
    assert.equal(result.seeds[0]?.attempts, op.attempts);
  });

  test('parse helpers reject incomplete legacy records', () => {
    assert.equal(parseLegacyOperationalRetry({ entryId: 'x' }), undefined);
    assert.equal(parseLegacyPromptBudgetBlocked({ entryId: 'y', blockedAt: 't' }), undefined);
    assert.ok(parseLegacyOperationalRetry(operationalRetryFixture()));
    assert.ok(parseLegacyPromptBudgetBlocked(promptBudgetBlockedFixture()));
  });

  test('assertMigrationPreserved detects dropped transcripts', () => {
    const source = operationalRetryFixture();
    const seed = migrateOperationalReviewRetry(source, { now: FIXED_NOW });
    const tampered = { ...seed, transcriptPaths: seed.transcriptPaths.slice(0, 1) };
    const check = assertMigrationPreserved({ kind: 'operational_retry', record: source }, tampered);
    assert.equal(check.preserved, false);
    assert.ok(check.violations.some(v => v.includes('transcript')));
  });
});

// ---------------------------------------------------------------------------
// Release canaries
// ---------------------------------------------------------------------------

describe('Evidence Review diagnostics release canaries (#110)', () => {
  test('every required operator facet is present on all disposition fixtures', () => {
    const fixtures: EvidenceReviewProjectionInput[] = [
      dualLaneJob({ jobId: 'c-active' }),
      dualLaneJob({
        jobId: 'c-lease',
        quanta: [
          quantum({
            quantumId: 'ql',
            kind: 'author_reader',
            state: 'leased',
            lease: { leaseId: 'L', ownerWakeId: 'W', expiresAt: '2026-07-17T04:30:00.000Z' },
          }),
        ],
      }),
      dualLaneJob({
        jobId: 'c-retry',
        quanta: [
          quantum({
            quantumId: 'qr',
            kind: 'skill_author',
            state: 'retry_wait',
            attempts: 1,
            nextRetryAt: '2026-07-17T04:20:00.000Z',
          }),
        ],
      }),
      dualLaneJob({ jobId: 'c-defer', disposition: 'deferred', obligations: [{ obligationId: 'o1' }] }),
      dualLaneJob({ jobId: 'c-super', disposition: 'superseded', successorJobId: 'job-next' }),
      dualLaneJob({ jobId: 'c-done', disposition: 'completed', transitionId: 'tr-1' }),
      dualLaneJob({ jobId: 'c-term', disposition: 'terminal_failed', terminalReason: 'integrity' }),
    ];

    const projections: EvidenceReviewOperatorProjection[] = listOperatorProjections(fixtures, FIXED_NOW);
    for (const projection of projections) {
      for (const result of assertProjectionFacets(projection)) {
        assert.equal(result.passed, true, `${projection.jobId}: ${result.detail}`);
      }
    }

    const separation = assertDispositionSeparation(projections);
    for (const result of separation) {
      assert.equal(result.passed, true, result.detail);
    }

    const dispositions = new Set(projections.map(p => p.operatorDisposition));
    assert.ok(dispositions.has('local_retry'));
    assert.ok(dispositions.has('semantic_defer'));
    assert.ok(dispositions.has('stale_basis_superseded'));
    assert.ok(dispositions.has('completed'));
    assert.ok(dispositions.has('terminal_integrity_failure'));
    assert.ok(dispositions.has('leased'));
  });

  test('classifyOperatorDisposition priority: durable outcomes beat quanta', () => {
    const leasedButCompleted = dualLaneJob({
      disposition: 'completed',
      transitionId: 't',
      quanta: [
        quantum({ quantumId: 'q', kind: 'author_reader', state: 'leased' }),
      ],
    });
    assert.equal(classifyOperatorDisposition(leasedButCompleted, FIXED_NOW), 'completed');

    const retryButDeferred = dualLaneJob({
      disposition: 'deferred',
      quanta: [
        quantum({
          quantumId: 'q',
          kind: 'skill_author',
          state: 'retry_wait',
          nextRetryAt: '2026-07-17T05:00:00.000Z',
        }),
      ],
    });
    assert.equal(classifyOperatorDisposition(retryButDeferred, FIXED_NOW), 'semantic_defer');
  });

  test('migration + projection canary: operational retry is not semantic defer', () => {
    const opSeed = migrateOperationalReviewRetry(operationalRetryFixture(), { now: FIXED_NOW });
    const pbbSeed = migratePromptBudgetBlocked(promptBudgetBlockedFixture(), { now: FIXED_NOW });
    const deferred = dualLaneJob({ jobId: 'job-defer', disposition: 'deferred' });

    const projections = listOperatorProjections(
      [opSeed.projectionInput, pbbSeed.projectionInput, deferred],
      FIXED_NOW,
    );
    const opView = projections.find(p => p.jobId === opSeed.proposedJobId)!;
    const deferView = projections.find(p => p.jobId === 'job-defer')!;
    assert.equal(opView.operatorDisposition, 'local_retry');
    assert.equal(deferView.operatorDisposition, 'semantic_defer');
    assert.notEqual(opView.operatorDisposition, deferView.operatorDisposition);

    for (const result of assertDispositionSeparation(projections)) {
      assert.equal(result.passed, true, result.detail);
    }
  });
});


// ---------------------------------------------------------------------------
// Integrated buildOperatorView compatibility (preserve call sites)
// ---------------------------------------------------------------------------

describe('Evidence Review integrated operator view compatibility (#110)', () => {
  test('buildOperatorView preserves integrated flat diagnostics fields', () => {
    // Duck-typed engine-like job: projection path must not require full domain payloads.
    const engineLike = {
      jobId: 'job-engine-view',
      workClass: 'live_learning' as const,
      disposition: 'deferred' as const,
      basis: { basisHash: 'basis-x', manifestHash: 'manifest-x' },
      manifest: { manifestHash: 'manifest-x', shardIds: ['s1'] },
      quanta: {
        'q1': quantum({
          quantumId: 'q1',
          kind: 'author_reader',
          state: 'pending',
          shardId: 's1',
          lane: 'author',
        }),
      },
      obligations: [{ obligationId: 'ob-1' }],
      obligationDispositions: [],
      nextDueAt: '2026-07-17T06:00:00.000Z',
    };

    const projection = projectEvidenceReviewJob(toProjectionInput(engineLike), FIXED_NOW);
    assert.equal(projection.operatorDisposition, 'semantic_defer');
    assert.equal(projection.obligations.unresolved, 1);
    assert.ok(projection.summary.includes('deferred'));

    // Facet separation: durable disposition is not collapsed into operator facet naming.
    assert.equal(projection.durableDisposition, 'deferred');
    assert.notEqual(projection.operatorDisposition, projection.durableDisposition);
  });

  test('disposition/facet separation: local_retry vs semantic_defer vs supersession', () => {
    const fixtures: EvidenceReviewProjectionInput[] = [
      dualLaneJob({
        jobId: 'sep-retry',
        quanta: [
          quantum({
            quantumId: 'qr',
            kind: 'skill_author',
            state: 'retry_wait',
            attempts: 2,
            nextRetryAt: '2026-07-17T04:20:00.000Z',
          }),
        ],
      }),
      dualLaneJob({
        jobId: 'sep-defer',
        disposition: 'deferred',
        obligations: [{ obligationId: 'o1' }, { obligationId: 'o2' }],
        obligationDispositions: [{ obligationId: 'o1' }],
      }),
      dualLaneJob({
        jobId: 'sep-super',
        disposition: 'superseded',
        successorJobId: 'job-next',
        supersededByJobId: 'job-next',
      }),
    ];
    const projections = listOperatorProjections(fixtures, FIXED_NOW);
    assert.equal(projections.find(p => p.jobId === 'sep-retry')?.operatorDisposition, 'local_retry');
    assert.equal(projections.find(p => p.jobId === 'sep-defer')?.operatorDisposition, 'semantic_defer');
    assert.equal(projections.find(p => p.jobId === 'sep-super')?.operatorDisposition, 'stale_basis_superseded');

    for (const result of assertDispositionSeparation(projections)) {
      assert.equal(result.passed, true, result.detail);
    }

    // Facets remain independently readable even when disposition is set.
    const defer = projections.find(p => p.jobId === 'sep-defer')!;
    assert.equal(defer.semanticDefer.deferred, true);
    assert.equal(defer.obligations.unresolved, 1);
    assert.equal(defer.retryWait.count, 0);

    const retry = projections.find(p => p.jobId === 'sep-retry')!;
    assert.equal(retry.retryWait.count, 1);
    assert.equal(retry.semanticDefer.deferred, false);

    const superP = projections.find(p => p.jobId === 'sep-super')!;
    assert.equal(superP.supersession.superseded, true);
    assert.equal(superP.successorLink, 'job-next');
  });
});

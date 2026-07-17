/**
 * Hardened Review Commit Fence tests (#109 / ADR 0045).
 *
 * Covers:
 * - fail-closed Review Basis validation + basisHash recomputation
 * - declared relevant dependencies vs unrelated Registry churn
 * - match / stale_before_fence / unrelated_change / post_commit_reassessment
 * - explicit before/after race outcomes (no last-writer-wins)
 * - complete Quantum identity equality (kind + inputs + prompt + policy)
 * - Successor Review Job planning with content-identified reuse
 * - Skill Evolution integration API compatibility
 *
 * Scope: fence-owned module + engine graph helpers already in this branch.
 * Does not exercise Transition Journal / Runtime Learning wake / scheduler.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDualLaneCoverageQuanta,
  claimQuantum,
  completeQuantum,
  createEvidenceReviewJob,
  createReviewQuantum,
  sha256Hex,
} from '../src/utils/evidence-review-graph';
import {
  buildLiveReviewBasis,
  compareReviewBasis,
  computeQuantumIdentity,
  createSuccessorReviewJob,
  decideReviewCommitFence,
  markJobSuperseded,
  MISSING_DECLARED_REGISTRY_REVISION,
  planSuccessorReviewJob,
  quantumIdentityEquals,
  resolveFenceRace,
  resolveLiveDeclaredRegistryReadSet,
  reuseValidSucceededQuanta,
  validateReviewBasis,
  type LiveReviewWorld,
} from '../src/utils/evidence-review-commit-fence';
import type { EvidenceReviewJob, ReviewBasis } from '../src/utils/evidence-review-types';
import {
  EVIDENCE_REVIEW_POLICY_VERSION,
  EVIDENCE_REVIEW_PROMPT_VERSION,
} from '../src/utils/evidence-review-types';
import type { EvidenceBundle } from '../src/utils/skill-evolution';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixedWorld(overrides?: Partial<LiveReviewWorld>): LiveReviewWorld {
  return {
    manifestHash: 'manifest:v1',
    evidenceBundleHash: 'evidence:v1',
    registryReadSet: ['cap_target@3', 'cap_dep@1'],
    referencedSkillHashes: ['skill:alpha:h1', 'skill:beta:h2'],
    reviewPolicyVersion: EVIDENCE_REVIEW_POLICY_VERSION,
    promptVersion: EVIDENCE_REVIEW_PROMPT_VERSION,
    targetCapabilityHandle: 'cap_target',
    targetCapabilityRevision: 3,
    ...overrides,
  };
}

function makeBasis(overrides?: Partial<LiveReviewWorld>): ReviewBasis {
  return buildLiveReviewBasis(fixedWorld(overrides));
}

function makePureJob(input?: {
  jobId?: string;
  now?: Date;
  world?: LiveReviewWorld;
  shards?: readonly { shardId: string; contentHash: string }[];
}): EvidenceReviewJob {
  const now = input?.now ?? new Date('2026-07-17T00:00:00.000Z');
  const world = input?.world ?? fixedWorld();
  const basis = buildLiveReviewBasis(world);
  const jobId = input?.jobId ?? `job:${basis.basisHash.slice(0, 12)}`;
  const shards = input?.shards ?? [
    { shardId: 'shard-a', contentHash: sha256Hex('content-a') },
    { shardId: 'shard-b', contentHash: sha256Hex('content-b') },
  ];
  const quantaList = buildDualLaneCoverageQuanta({
    jobId,
    shards,
    basisHash: basis.basisHash,
    now,
  });
  const quanta: EvidenceReviewJob['quanta'] = {};
  for (const q of quantaList) quanta[q.quantumId] = q;

  // Minimal engine job shell for pure fence planning paths.
  return {
    schemaVersion: 1,
    jobId,
    workClass: 'live_learning',
    disposition: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    candidate: {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: jobId,
      title: 'pure-fence',
      applicability: 'test',
      actionPattern: 'act',
      boundaries: [],
      risks: [],
      provenance: [],
      solvedLoop: {
        problem: 'p',
        action: 'a',
        verification: 'v',
        noCorrection: 'n',
      },
      generatedAt: now.toISOString(),
      sourceUnit: {
        filePath: `${jobId}.jsonl`,
        byteRange: { start: 0, end: 1 },
        generatedAt: now.toISOString(),
      },
    } as any,
    bundle: {
      bundleId: jobId,
      episode: {} as any,
      completionEvidence: [],
      settlementEvidence: [],
      boundedContinuity: [],
      referencedSkills: [],
      relatedCurrentSkills: [],
      semanticObservations: [],
    },
    manifest: {
      manifestId: `manifest:${jobId}`,
      manifestHash: basis.manifestHash,
      bundleId: jobId,
      shards: shards.map(s => ({
        shardId: s.shardId,
        contentHash: s.contentHash,
        domainKind: 'completion' as const,
      })),
      createdAt: now.toISOString(),
    } as any,
    shards: Object.fromEntries(
      shards.map(s => [
        s.shardId,
        {
          shardId: s.shardId,
          contentHash: s.contentHash,
          domainKind: 'completion',
          spans: [],
        },
      ]),
    ) as any,
    basis,
    quanta,
    domain: { shards },
  };
}

function succeedReader(
  job: EvidenceReviewJob,
  kind: 'author_reader' | 'verifier_reader',
  shardId: string,
  now: Date,
  result: unknown = { covered: true },
): void {
  const reader = Object.values(job.quanta).find(
    q => q.kind === kind && q.shardId === shardId,
  );
  assert.ok(reader, `missing ${kind} for ${shardId}`);
  const claim = claimQuantum(job as any, reader.quantumId, {
    ownerWakeId: 'wake-test',
    now,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error('claim failed');
  completeQuantum(job as any, reader.quantumId, {
    result,
    leaseId: claim.lease.leaseId,
    now,
  });
}

function validBundle(bundleId: string, extra = ''): EvidenceBundle {
  return {
    bundleId,
    episode: {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: bundleId,
      title: `Title ${bundleId}`,
      applicability: 'Fence tests.',
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

// ---------------------------------------------------------------------------
// Review Basis validation / comparison
// ---------------------------------------------------------------------------

describe('Review Basis version vector (#109)', () => {
  test('buildLiveReviewBasis is deterministic and ignores registry order', () => {
    const a = makeBasis({
      registryReadSet: ['cap_b@1', 'cap_a@2'],
    });
    const b = makeBasis({
      registryReadSet: ['cap_a@2', 'cap_b@1'],
    });
    assert.equal(a.basisHash, b.basisHash);
    assert.deepEqual(a.registryReadSetFingerprints, ['cap_a@2', 'cap_b@1']);
  });

  test('validateReviewBasis accepts a well-formed vector and rejects corruption', () => {
    const basis = makeBasis();
    const ok = validateReviewBasis(basis);
    assert.equal(ok.ok, true);

    const missingHash = validateReviewBasis({ ...basis, basisHash: '' });
    assert.equal(missingHash.ok, false);

    const tampered = validateReviewBasis({
      ...basis,
      evidenceBundleHash: 'evidence:TAMPERED',
      // basisHash left as the old hash → mismatch
    });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) {
      assert.match(tampered.reason, /basisHash does not match/i);
    }

    const notObject = validateReviewBasis(null);
    assert.equal(notObject.ok, false);

    const badRegistry = validateReviewBasis({
      ...basis,
      registryReadSet: 'not-an-array',
      registryReadSetFingerprints: 'also-bad',
    });
    assert.equal(badRegistry.ok, false);
  });

  test('compareReviewBasis matches when every declared dependency is equal', () => {
    const basis = makeBasis();
    const live = fixedWorld();
    const comparison = compareReviewBasis(basis, live);
    assert.equal(comparison.status, 'match');
    if (comparison.status === 'match') {
      assert.equal(comparison.basisHash, basis.basisHash);
      assert.equal(comparison.liveBasisHash, basis.basisHash);
    }
  });

  test('relevant evidence / policy / target / registry changes are stale', () => {
    const basis = makeBasis();

    const evidence = compareReviewBasis(basis, fixedWorld({
      evidenceBundleHash: 'evidence:v2',
      manifestHash: 'manifest:v2',
    }));
    assert.equal(evidence.status, 'stale');
    if (evidence.status === 'stale') {
      assert.ok(evidence.changed.includes('evidence'));
      assert.ok(evidence.changed.includes('manifest'));
    }

    const registry = compareReviewBasis(basis, fixedWorld({
      registryReadSet: ['cap_target@4', 'cap_dep@1'],
    }));
    assert.equal(registry.status, 'stale');
    if (registry.status === 'stale') {
      assert.ok(
        registry.changed.includes('registry')
        || registry.changed.includes('registry_read_set'),
      );
    }

    const skills = compareReviewBasis(basis, fixedWorld({
      referencedSkillHashes: ['skill:alpha:h1-CHANGED', 'skill:beta:h2'],
    }));
    assert.equal(skills.status, 'stale');
    if (skills.status === 'stale') {
      assert.ok(skills.changed.includes('referenced_skills'));
    }

    const policy = compareReviewBasis(basis, fixedWorld({
      reviewPolicyVersion: 'evidence-review-policy-v2',
    }));
    assert.equal(policy.status, 'stale');
    if (policy.status === 'stale') {
      assert.ok(policy.changed.includes('policy'));
    }

    const prompt = compareReviewBasis(basis, fixedWorld({
      promptVersion: 'evidence-review-job-v2',
    }));
    assert.equal(prompt.status, 'stale');
    if (prompt.status === 'stale') {
      assert.ok(prompt.changed.includes('prompt'));
    }

    const target = compareReviewBasis(basis, fixedWorld({
      targetCapabilityRevision: 4,
    }));
    assert.equal(target.status, 'stale');
    if (target.status === 'stale') {
      assert.ok(target.changed.includes('target'));
    }
  });

  test('unrelated Registry handle outside declared read set does not invalidate', () => {
    const basis = makeBasis({
      registryReadSet: ['cap_target@3'],
    });
    const comparison = compareReviewBasis(basis, fixedWorld({
      registryReadSet: ['cap_target@3'],
      unrelatedRegistryFingerprints: ['cap_unrelated@99', 'cap_other@1'],
    }));
    assert.equal(comparison.status, 'match');
  });

  test('corrupted basis fails closed (never match)', () => {
    const pure = compareReviewBasis(
      { basisHash: 'deadbeef', manifestHash: 12 },
      fixedWorld(),
    );
    assert.equal(pure.status, 'corrupted_basis');

    // Skill Evolution path surfaces corruption as stale so commit is blocked
    // without requiring Skill Evolution call-site edits.
    const se = compareReviewBasis(
      { basisHash: 'deadbeef', manifestHash: 12 },
      { bundle: validBundle('corrupt-se') },
    );
    assert.equal(se.status, 'stale');

    const decision = decideReviewCommitFence({
      basis: '{not-json',
      live: fixedWorld(),
    });
    assert.equal(decision.kind, 'corrupted_basis');
    assert.equal(decision.mayCommit, false);
    assert.equal(decision.shouldCreateSuccessor, false);
  });
});

// ---------------------------------------------------------------------------
// Fence decision outcomes
// ---------------------------------------------------------------------------

describe('Review Commit Fence decision (#109)', () => {
  test('match allows commit and does not create successor', () => {
    const basis = makeBasis();
    const decision = decideReviewCommitFence({
      basis,
      live: fixedWorld(),
    });
    assert.equal(decision.kind, 'match');
    assert.equal(decision.mayCommit, true);
    assert.equal(decision.shouldCreateSuccessor, false);
    assert.equal(decision.shouldScheduleReassessment, false);
  });

  test('stale_before_fence blocks commit and requests successor', () => {
    const basis = makeBasis();
    const decision = decideReviewCommitFence({
      basis,
      live: fixedWorld({ evidenceBundleHash: 'evidence:v2', manifestHash: 'manifest:v2' }),
    });
    assert.equal(decision.kind, 'stale_before_fence');
    assert.equal(decision.mayCommit, false);
    assert.equal(decision.shouldCreateSuccessor, true);
    assert.equal(decision.shouldScheduleReassessment, false);
    assert.match(decision.reason, /stale/i);
  });

  test('unrelated_change keeps commit eligibility without successor', () => {
    const basis = makeBasis({ registryReadSet: ['cap_target@3'] });
    const decision = decideReviewCommitFence({
      basis,
      live: fixedWorld({
        registryReadSet: ['cap_target@3'],
        unrelatedRegistryFingerprints: ['cap_noise@7'],
      }),
    });
    assert.equal(decision.kind, 'unrelated_change');
    assert.equal(decision.mayCommit, true);
    assert.equal(decision.shouldCreateSuccessor, false);
    assert.equal(decision.shouldScheduleReassessment, false);
  });

  test('post_commit_reassessment leaves committed transition intact', () => {
    const basis = makeBasis();
    const decision = decideReviewCommitFence({
      basis,
      live: fixedWorld({ evidenceBundleHash: 'evidence:after-commit' }),
      commitAlreadyApplied: true,
    });
    assert.equal(decision.kind, 'post_commit_reassessment');
    assert.equal(decision.mayCommit, false);
    assert.equal(decision.shouldCreateSuccessor, false);
    assert.equal(decision.shouldScheduleReassessment, true);
  });
});

// ---------------------------------------------------------------------------
// Race model: relevant change before vs after fence
// ---------------------------------------------------------------------------

describe('Fence race ordering model (#109)', () => {
  test('relevant change before fence prevents stale commit (no last-writer-wins)', () => {
    const basis = makeBasis();
    const live = fixedWorld({
      evidenceBundleHash: 'evidence:race',
      manifestHash: 'manifest:race',
      targetCapabilityRevision: 4,
    });

    const before = resolveFenceRace({
      basis,
      live,
      changeOrdering: 'before',
    });
    assert.equal(before.kind, 'stale_before_fence');
    assert.equal(before.mayCommit, false);
    assert.equal(before.shouldCreateSuccessor, true);

    const after = resolveFenceRace({
      basis,
      live,
      changeOrdering: 'after',
    });
    assert.equal(after.kind, 'post_commit_reassessment');
    assert.equal(after.mayCommit, false);
    assert.equal(after.shouldCreateSuccessor, false);
    assert.equal(after.shouldScheduleReassessment, true);

    assert.notEqual(before.kind, after.kind);
  });

  test('unrelated Registry churn races as non-invalidating under both orderings', () => {
    const basis = makeBasis({ registryReadSet: ['cap_target@3'] });
    const live = fixedWorld({
      registryReadSet: ['cap_target@3'],
      unrelatedRegistryFingerprints: ['cap_noise@1'],
    });

    const before = resolveFenceRace({ basis, live, changeOrdering: 'before' });
    const after = resolveFenceRace({ basis, live, changeOrdering: 'after' });

    assert.equal(before.kind, 'unrelated_change');
    assert.equal(before.mayCommit, true);
    assert.equal(after.kind, 'unrelated_change');
    assert.equal(after.mayCommit, false);
    assert.equal(after.shouldCreateSuccessor, false);
    assert.equal(after.shouldScheduleReassessment, false);
  });
});

// ---------------------------------------------------------------------------
// Content-identified Quantum reuse + Successor planning
// ---------------------------------------------------------------------------

describe('Content-identified Quantum reuse (#109)', () => {
  test('quantum identity requires kind, inputs, prompt version, and policy version', () => {
    const base = computeQuantumIdentity({
      kind: 'author_reader',
      inputs: { lane: 'author', shardId: 'shard-a', contentHash: 'h1' },
    });
    const same = computeQuantumIdentity({
      kind: 'author_reader',
      inputs: { lane: 'author', shardId: 'shard-a', contentHash: 'h1' },
    });
    assert.equal(base.inputHash, same.inputHash);

    const differentInputs = computeQuantumIdentity({
      kind: 'author_reader',
      inputs: { lane: 'author', shardId: 'shard-a', contentHash: 'h2' },
    });
    assert.notEqual(base.inputHash, differentInputs.inputHash);

    const differentPrompt = computeQuantumIdentity({
      kind: 'author_reader',
      inputs: { lane: 'author', shardId: 'shard-a', contentHash: 'h1' },
      promptVersion: 'evidence-review-job-v2',
    });
    assert.notEqual(base.inputHash, differentPrompt.inputHash);

    const differentPolicy = computeQuantumIdentity({
      kind: 'author_reader',
      inputs: { lane: 'author', shardId: 'shard-a', contentHash: 'h1' },
      policyVersion: 'evidence-review-policy-v2',
    });
    assert.notEqual(base.inputHash, differentPolicy.inputHash);

    const differentKind = computeQuantumIdentity({
      kind: 'verifier_reader',
      inputs: { lane: 'author', shardId: 'shard-a', contentHash: 'h1' },
    });
    assert.notEqual(base.inputHash, differentKind.inputHash);
  });

  test('quantumIdentityEquals requires complete equality including lane/shard', () => {
    const a = {
      kind: 'author_reader' as const,
      inputHash: 'abc',
      shardId: 'shard-a',
      lane: 'author' as const,
    };
    assert.equal(quantumIdentityEquals(a, { ...a }), true);
    assert.equal(quantumIdentityEquals(a, { ...a, kind: 'verifier_reader' }), false);
    assert.equal(quantumIdentityEquals(a, { ...a, inputHash: 'xyz' }), false);
    assert.equal(quantumIdentityEquals(a, { ...a, shardId: 'shard-b' }), false);
    assert.equal(quantumIdentityEquals(a, { ...a, lane: 'verifier' }), false);
  });

  test('reuseValidSucceededQuanta copies only complete identity matches', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const prior = makePureJob({ jobId: 'job:prior', now });
    succeedReader(prior, 'author_reader', 'shard-a', now, { finding: 'A' });
    succeedReader(prior, 'author_reader', 'shard-b', now, { finding: 'B' });

    const sameSuccessor = makePureJob({ jobId: 'job:same', now });
    const same = reuseValidSucceededQuanta(sameSuccessor, prior);
    assert.equal(same.reusedQuantumIds.length, 2);
    for (const id of same.reusedQuantumIds) {
      assert.equal(same.job.quanta[id]!.state, 'succeeded');
    }

    const changed = makePureJob({
      jobId: 'job:changed',
      now,
      shards: [
        { shardId: 'shard-a', contentHash: sha256Hex('content-a-CHANGED') },
        { shardId: 'shard-b', contentHash: sha256Hex('content-b') },
      ],
    });
    const partial = reuseValidSucceededQuanta(changed, prior);
    const reusedShards = partial.reusedQuantumIds.map(
      id => partial.job.quanta[id]!.shardId,
    );
    assert.ok(reusedShards.includes('shard-b'));
    assert.ok(!reusedShards.includes('shard-a'));
    assert.ok(partial.skippedQuantumIds.length >= 1);

    const pendingA = Object.values(partial.job.quanta).find(
      q => q.kind === 'author_reader' && q.shardId === 'shard-a',
    );
    assert.ok(pendingA);
    assert.equal(pendingA!.state, 'pending');
  });

  test('prompt/policy version drift blocks reuse even when shard content matches', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const prior = makePureJob({ jobId: 'job:prior-policy', now });
    succeedReader(prior, 'author_reader', 'shard-a', now);

    const liveBasis = buildLiveReviewBasis(fixedWorld({
      reviewPolicyVersion: 'evidence-review-policy-v2',
    }));
    const shards = [
      { shardId: 'shard-a', contentHash: sha256Hex('content-a') },
      { shardId: 'shard-b', contentHash: sha256Hex('content-b') },
    ];
    const quantaList = shards.flatMap(shard => [
      createReviewQuantum('job:policy-drift', {
        kind: 'author_reader',
        inputs: { lane: 'author', shardId: shard.shardId, contentHash: shard.contentHash },
        shardId: shard.shardId,
        lane: 'author',
        policyVersion: 'evidence-review-policy-v2',
      }, now),
      createReviewQuantum('job:policy-drift', {
        kind: 'verifier_reader',
        inputs: { lane: 'verifier', shardId: shard.shardId, contentHash: shard.contentHash },
        shardId: shard.shardId,
        lane: 'verifier',
        policyVersion: 'evidence-review-policy-v2',
      }, now),
    ]);
    const quanta: EvidenceReviewJob['quanta'] = {};
    for (const q of quantaList) quanta[q.quantumId] = q;

    const successor: EvidenceReviewJob = {
      ...prior,
      jobId: 'job:policy-drift',
      basis: liveBasis,
      quanta,
      disposition: 'active',
      parentJobId: prior.jobId,
    };

    const result = reuseValidSucceededQuanta(successor, prior);
    assert.equal(result.reusedQuantumIds.length, 0);
    const authorA = Object.values(result.job.quanta).find(
      q => q.kind === 'author_reader' && q.shardId === 'shard-a',
    );
    assert.equal(authorA!.state, 'pending');
  });
});

describe('Successor Review Job planning (#109)', () => {
  test('stale basis creates successor with audit link and reuses valid quanta', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const prior = makePureJob({ jobId: 'job:stale', now });
    succeedReader(prior, 'author_reader', 'shard-a', now, { finding: 'keep' });
    succeedReader(prior, 'author_reader', 'shard-b', now, { finding: 'keep-b' });

    const live = fixedWorld({
      evidenceBundleHash: 'evidence:v2',
      manifestHash: 'manifest:v2',
    });
    const plan = planSuccessorReviewJob({
      staleJob: prior,
      live,
      domainShards: [
        { shardId: 'shard-a', contentHash: sha256Hex('content-a-NEW') },
        { shardId: 'shard-b', contentHash: sha256Hex('content-b') },
      ],
      successorJobId: 'job:successor-1',
      now,
    });

    assert.equal(plan.successor.jobId, 'job:successor-1');
    assert.equal(plan.successor.parentJobId, prior.jobId);
    assert.equal(plan.superseded.disposition, 'superseded');
    assert.equal(plan.superseded.successorJobId, plan.successor.jobId);
    assert.equal(plan.auditLink.parentJobId, prior.jobId);
    assert.equal(plan.auditLink.successorJobId, plan.successor.jobId);
    assert.equal(plan.auditLink.supersededDisposition, 'superseded');

    assert.notEqual(plan.successor.basis.basisHash, prior.basis.basisHash);
    assert.equal(plan.successor.basis.evidenceBundleHash, 'evidence:v2');

    const reusedShards = plan.reusedQuantumIds.map(
      id => plan.successor.quanta[id]!.shardId,
    );
    assert.ok(reusedShards.includes('shard-b'));
    assert.ok(!reusedShards.includes('shard-a'));

    const kept = Object.values(plan.successor.quanta).find(
      q => q.kind === 'author_reader' && q.shardId === 'shard-b' && q.state === 'succeeded',
    );
    assert.ok(kept);
    assert.deepEqual(kept!.result, { finding: 'keep-b' });
  });

  test('target-only basis change reuses all content-identical quanta', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const prior = makePureJob({ jobId: 'job:target-prior', now });
    succeedReader(prior, 'author_reader', 'shard-a', now);
    succeedReader(prior, 'verifier_reader', 'shard-a', now);
    succeedReader(prior, 'author_reader', 'shard-b', now);
    succeedReader(prior, 'verifier_reader', 'shard-b', now);

    const live = fixedWorld({ targetCapabilityRevision: 9 });
    const plan = planSuccessorReviewJob({
      staleJob: prior,
      live,
      // No domainShards → identity-preserving rematerialization path.
      successorJobId: 'job:target-successor',
      now,
    });

    assert.equal(plan.successor.basis.targetCapabilityRevision, 9);
    assert.notEqual(plan.successor.basis.basisHash, prior.basis.basisHash);
    assert.equal(plan.reusedQuantumIds.length, 4);
    assert.equal(
      Object.values(plan.successor.quanta).filter(q => q.state === 'succeeded').length,
      4,
    );
  });

  test('fence decision + successor planning compose without committing stale job', () => {
    const now = new Date('2026-07-17T00:00:00.000Z');
    const prior = makePureJob({ jobId: 'job:compose', now });
    succeedReader(prior, 'author_reader', 'shard-a', now);

    const live = fixedWorld({
      evidenceBundleHash: 'evidence:compose',
      manifestHash: 'manifest:compose',
    });
    const decision = decideReviewCommitFence({ basis: prior.basis, live });
    assert.equal(decision.kind, 'stale_before_fence');
    assert.equal(decision.mayCommit, false);

    if (!decision.shouldCreateSuccessor) {
      throw new Error('expected successor');
    }

    const plan = planSuccessorReviewJob({
      staleJob: prior,
      live,
      domainShards: [
        { shardId: 'shard-a', contentHash: sha256Hex('content-a') },
        { shardId: 'shard-b', contentHash: sha256Hex('content-b') },
      ],
      now,
    });

    assert.equal(plan.superseded.disposition, 'superseded');
    assert.notEqual(plan.superseded.disposition, 'terminal_failed');
    assert.notEqual(plan.superseded.disposition, 'deferred');
    assert.equal(plan.successor.disposition, 'active');
    assert.equal(plan.successor.parentJobId, prior.jobId);
  });
});

// ---------------------------------------------------------------------------
// Skill Evolution integration API compatibility
// ---------------------------------------------------------------------------

describe('Skill Evolution fence API compatibility (#109)', () => {
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

  test('createSuccessorReviewJob reuses quanta with identical input hashes only', () => {
    const bundle = validBundle('fence-c', 'same');
    const prior = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
      jobId: 'job-prior',
    });
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

    const reused = Object.values(successor.quanta).filter(q => q.state === 'succeeded');
    for (const q of reused) {
      const priorMatch = Object.values(prior.quanta).find(
        p => p.inputHash === q.inputHash && p.kind === q.kind,
      );
      assert.ok(priorMatch);
    }
  });

  test('engine basis validates via fail-closed hash recomputation', () => {
    const bundle = validBundle('fence-validate');
    const job = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
    });
    const ok = validateReviewBasis(job.basis);
    assert.equal(ok.ok, true);

    const tampered = validateReviewBasis({
      ...job.basis,
      evidenceBundleHash: 'tampered',
    });
    assert.equal(tampered.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Missing/deleted declared handles + successor freezes live vector
// ---------------------------------------------------------------------------

describe('Declared Registry handle deletion is stale (#109)', () => {
  test('resolveLiveDeclaredRegistryReadSet never falls back to frozen revision', () => {
    const declared = [
      { handle: 'cap_target', revision: 3 },
      { handle: 'cap_dep', revision: 1 },
    ];
    const live = resolveLiveDeclaredRegistryReadSet(declared, {
      cap_target: { handle: 'cap_target', revision: 3 },
      // cap_dep deleted/missing
    });
    assert.deepEqual(live, [
      { handle: 'cap_target', revision: 3 },
      { handle: 'cap_dep', revision: MISSING_DECLARED_REGISTRY_REVISION },
    ]);
    assert.notEqual(live[1]!.revision, declared[1]!.revision);
  });

  test('missing/deleted declared handle compares stale (never match via frozen fallback)', () => {
    const basis = makeBasis({
      registryReadSet: ['cap_target@3', 'cap_dep@1'],
    });
    // Live world fingerprints the missing handle with the sentinel revision.
    const live = fixedWorld({
      registryReadSet: [`cap_target@3`, `cap_dep@${MISSING_DECLARED_REGISTRY_REVISION}`],
    });
    const comparison = compareReviewBasis(basis, live);
    assert.equal(comparison.status, 'stale');
    if (comparison.status === 'stale') {
      assert.ok(
        comparison.changed.includes('registry')
        || comparison.changed.includes('registry_read_set'),
      );
    }

    const decision = decideReviewCommitFence({ basis, live });
    assert.equal(decision.kind, 'stale_before_fence');
    assert.equal(decision.mayCommit, false);
    assert.equal(decision.shouldCreateSuccessor, true);
  });

  test('unrelated Registry deletion outside declared read set is ignored', () => {
    const basis = makeBasis({ registryReadSet: ['cap_target@3'] });
    const live = fixedWorld({
      registryReadSet: ['cap_target@3'],
      unrelatedRegistryFingerprints: ['cap_noise@0'],
    });
    const decision = decideReviewCommitFence({ basis, live });
    assert.equal(decision.kind, 'unrelated_change');
    assert.equal(decision.mayCommit, true);
  });
});

describe('Successor freezes live declared dependency vector (#109)', () => {
  test('createSuccessorReviewJob freezes the live registry read set, not the stale one', () => {
    const bundle = validBundle('fence-live-successor');
    const prior = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
      registryReadSet: [{ handle: 'cap_a', revision: 1 }],
      jobId: 'job-stale-vector',
    });
    assert.deepEqual(prior.basis.registryReadSet, [{ handle: 'cap_a', revision: 1 }]);

    const liveRegistryReadSet = [{ handle: 'cap_a', revision: 4 }];
    const successor = createSuccessorReviewJob({
      staleJob: prior,
      liveBundle: bundle,
      candidate: candidateFrom(bundle),
      registryReadSet: liveRegistryReadSet,
    });

    assert.deepEqual(successor.basis.registryReadSet, [{ handle: 'cap_a', revision: 4 }]);
    assert.notDeepEqual(successor.basis.registryReadSet, prior.basis.registryReadSet);
    assert.ok(
      successor.basis.registryReadSetFingerprints.includes('cap_a@4'),
      'live fingerprint must be frozen on the successor basis',
    );
  });

  test('job creation freezes referenced skills, target, policy, prompt, and declared registry', () => {
    const bundle: EvidenceBundle = {
      ...validBundle('fence-declared-all'),
      referencedSkills: [
        { name: 'alpha', contentFingerprint: 'a1' },
        { name: 'beta', contentFingerprint: 'b1' },
      ],
      relatedCurrentSkills: [
        {
          handle: 'cap_target',
          revision: 7,
          routingName: 'target-route',
          description: 'target',
          guidanceHash: 'g1',
        },
      ],
    };
    const job = createEvidenceReviewJob({
      bundle,
      candidate: candidateFrom(bundle),
      workClass: 'live_learning',
      registryReadSet: [
        { handle: 'cap_target', revision: 7 },
        { handle: 'cap_dep', revision: 2 },
      ],
    });

    assert.equal(job.basis.targetCapabilityHandle, 'cap_target');
    assert.equal(job.basis.targetCapabilityRevision, 7);
    assert.equal(job.basis.reviewPolicyVersion, EVIDENCE_REVIEW_POLICY_VERSION);
    assert.equal(job.basis.promptVersion, EVIDENCE_REVIEW_PROMPT_VERSION);
    assert.equal(job.basis.referencedSkillHashes.length, 2);
    assert.deepEqual(
      job.basis.registryReadSet.map(e => `${e.handle}@${e.revision}`).sort(),
      ['cap_dep@2', 'cap_target@7'],
    );

    // Live comparison with all declared fields equal is a match.
    const match = compareReviewBasis(job.basis, {
      bundle,
      registryReadSet: job.basis.registryReadSet,
      reviewPolicyVersion: job.basis.reviewPolicyVersion,
      promptVersion: job.basis.promptVersion,
    });
    assert.equal(match.status, 'match');

    // Referenced-skill content change is stale.
    const skillChanged: EvidenceBundle = {
      ...bundle,
      referencedSkills: [
        { name: 'alpha', contentFingerprint: 'a1-CHANGED' },
        { name: 'beta', contentFingerprint: 'b1' },
      ],
    };
    const skillStale = compareReviewBasis(job.basis, {
      bundle: skillChanged,
      registryReadSet: job.basis.registryReadSet,
    });
    assert.equal(skillStale.status, 'stale');
    if (skillStale.status === 'stale') {
      assert.ok(skillStale.changed.includes('referenced_skills'));
    }
  });
});

describe('Before-commit race: stale blocks journal write (#109)', () => {
  test('stale_before_fence decision forbids commit (mayCommit=false)', () => {
    const basis = makeBasis();
    const live = fixedWorld({
      registryReadSet: ['cap_target@99', 'cap_dep@1'],
    });
    const before = resolveFenceRace({ basis, live, changeOrdering: 'before' });
    assert.equal(before.kind, 'stale_before_fence');
    assert.equal(before.mayCommit, false);
    assert.equal(before.shouldCreateSuccessor, true);

    // Explicit contract used by Skill Evolution precommit hook: only match/
    // unrelated_change may proceed to applyCapabilityTransition.
    assert.equal(
      before.mayCommit && before.kind !== 'stale_before_fence',
      false,
    );
  });

  test('post_commit_reassessment schedules ordinary reassessment without superseding', () => {
    const basis = makeBasis();
    const live = fixedWorld({
      evidenceBundleHash: 'evidence:after',
      manifestHash: 'manifest:after',
    });
    const after = resolveFenceRace({ basis, live, changeOrdering: 'after' });
    assert.equal(after.kind, 'post_commit_reassessment');
    assert.equal(after.shouldScheduleReassessment, true);
    assert.equal(after.shouldCreateSuccessor, false);
    assert.equal(after.mayCommit, false);
  });
});

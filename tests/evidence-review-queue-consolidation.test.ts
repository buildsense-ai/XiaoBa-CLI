import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import {
  type EvidenceBundle,
  type SkillEvolutionOptions,
  SkillEvolutionRuntime,
  SKILL_EVOLUTION_REVIEWER_VERSION,
} from '../src/utils/skill-evolution';
import { createEvidenceReviewJob } from '../src/utils/evidence-review-graph';
import {
  evidenceReviewJobStorePathForReviewQueue,
  importLegacyReviewQueue,
  loadEvidenceReviewJobStore,
  saveEvidenceReviewJobStore,
} from '../src/utils/evidence-review-job-store';

const NOW = '2026-07-20T00:00:00.000Z';

function candidate(id: string): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: id,
    title: `Candidate ${id}`,
    applicability: 'Use for the bounded test workflow.',
    actionPattern: 'Apply the bounded workflow.',
    boundaries: ['Use only cited evidence.'],
    risks: [],
    solvedLoop: {
      problem: 'A bounded task was requested.',
      action: 'Applied the workflow.',
      verification: 'The result was verified.',
      noCorrection: 'No correction followed.',
    },
    provenance: [
      { filePath: 'session.jsonl', turn: 1, role: 'problem-action', unitByteRange: { start: 0, end: 1 } },
      { filePath: 'session.jsonl', turn: 2, role: 'verification', unitByteRange: { start: 1, end: 2 } },
    ],
    generatedAt: NOW,
    sourceUnit: { filePath: 'session.jsonl', byteRange: { start: 0, end: 2 }, generatedAt: NOW },
  };
}

function bundle(id: string): EvidenceBundle {
  return {
    bundleId: id,
    episode: candidate(id),
    completionEvidence: [{ ref: 'session.jsonl#1' }],
    settlementEvidence: [{ ref: 'session.jsonl#2' }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
  };
}

function setup(reviewerVersion = SKILL_EVOLUTION_REVIEWER_VERSION) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-owner-'));
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const options: SkillEvolutionOptions = {
    workingDirectory: root,
    outputDir: path.join(root, 'skills', 'generated-distilled'),
    registryPath: path.join(root, 'data', 'current-skill-registry.json'),
    auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
    journalPath: path.join(root, 'data', 'transition-journal.json'),
    reviewQueuePath,
    reviewerVersion,
    manualSkillNames: [],
    logEnabled: false,
  };
  return {
    root,
    options,
    reviewQueuePath,
    jobStorePath: evidenceReviewJobStorePathForReviewQueue(reviewQueuePath),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function seedDeferred(
  options: SkillEvolutionOptions,
  input: {
    bundle: EvidenceBundle;
    reviewerVersion?: string;
    registryReadSet?: Array<{ handle: string; revision: number }>;
    reviewPolicyVersion?: string;
    omitDeferState?: boolean;
  },
) {
  const job = createEvidenceReviewJob({
    bundle: input.bundle,
    candidate: input.bundle.episode as DistilledKnowledgeCandidate,
    workClass: 'semantic_reassessment',
    registryReadSet: input.registryReadSet,
    reviewPolicyVersion: input.reviewPolicyVersion,
    now: new Date(NOW),
  });
  job.disposition = 'deferred';
  if (!input.omitDeferState) {
    job.deferState = {
      reviewerVersion: input.reviewerVersion ?? SKILL_EVOLUTION_REVIEWER_VERSION,
      reason: 'Waiting for a material trigger.',
      deferredAt: NOW,
    };
  }
  const storePath = evidenceReviewJobStorePathForReviewQueue(options.reviewQueuePath!);
  const state = loadEvidenceReviewJobStore(storePath);
  state.jobs[job.jobId] = job;
  saveEvidenceReviewJobStore(storePath, state);
  return job;
}

function assertUniqueSuccessor(runtime: SkillEvolutionRuntime, staleJobId: string) {
  const state = runtime.getEvidenceReviewEngine().loadStore();
  const stale = state.jobs[staleJobId]!;
  assert.equal(stale.disposition, 'superseded');
  assert.ok(stale.successorJobId);
  const successor = state.jobs[stale.successorJobId!]!;
  assert.equal(successor.parentJobId, staleJobId);
  assert.equal(successor.disposition, 'active');
  assert.equal(
    Object.values(state.jobs).filter(job => job.parentJobId === staleJobId).length,
    1,
  );
  return successor;
}

describe('Evidence Review Job single-owner consolidation', () => {
  test('legacy queue migration is durable, idempotent, and preserves terminal collisions', () => {
    const env = setup();
    try {
      const operationalBundle = bundle('legacy-operational');
      const deferredBundle = bundle('legacy-deferred');
      const historical = createEvidenceReviewJob({
        bundle: operationalBundle,
        candidate: operationalBundle.episode as DistilledKnowledgeCandidate,
        workClass: 'live_learning',
      });
      historical.disposition = 'completed';
      const initial = loadEvidenceReviewJobStore(env.jobStorePath);
      initial.jobs[historical.jobId] = historical;
      saveEvidenceReviewJobStore(env.jobStorePath, initial);

      fs.mkdirSync(path.dirname(env.reviewQueuePath), { recursive: true });
      fs.writeFileSync(env.reviewQueuePath, JSON.stringify({
        schemaVersion: 1,
        operational: [{
          entryId: 'op-1', candidateCapabilityId: 'legacy-operational',
          bundleId: operationalBundle.bundleId, bundle: operationalBundle,
          candidate: operationalBundle.episode,
          failureKind: 'branch_timeout', failureMessage: 'provider timed out',
          failureTranscripts: ['author.jsonl'], attempts: 3, currentDelayMs: 400,
          nextRetryAt: '2026-07-20T00:01:00.000Z', createdAt: NOW, updatedAt: NOW,
        }],
        deferred: [{
          entryId: 'defer-1', candidateCapabilityId: 'legacy-deferred',
          bundleId: deferredBundle.bundleId, bundle: deferredBundle,
          candidate: deferredBundle.episode, relevantReadSet: [{ handle: 'cap-a', revision: 2 }],
          evidenceFingerprint: 'legacy-fingerprint', reviewerVersion: 'reviewer-v1',
          reason: 'needs evidence', createdAt: NOW, updatedAt: NOW,
        }],
      }));

      const migrated = importLegacyReviewQueue(env.reviewQueuePath, env.jobStorePath);
      assert.equal(migrated.status, 'migrated');
      assert.equal(migrated.imported, 2);
      const state = loadEvidenceReviewJobStore(env.jobStorePath);
      assert.equal(Object.keys(state.jobs).length, 3, 'terminal history must not discard live legacy work');
      const operational = Object.values(state.jobs).find(job =>
        job.bundle.bundleId === operationalBundle.bundleId && job.disposition === 'active');
      const retry = Object.values(operational!.quanta).find(quantum => quantum.state === 'retry_wait');
      assert.deepEqual(
        [retry?.attempts, retry?.currentDelayMs, retry?.failureKind, retry?.nextRetryAt],
        [3, 400, 'branch_timeout', '2026-07-20T00:01:00.000Z'],
      );
      const deferred = Object.values(state.jobs).find(job => job.bundle.bundleId === deferredBundle.bundleId)!;
      assert.equal(deferred.disposition, 'deferred');
      assert.equal(deferred.deferState?.reviewerVersion, 'reviewer-v1');

      // Simulate crash after the atomic store write but before source archive.
      fs.renameSync(migrated.archivePath, env.reviewQueuePath);
      const replay = importLegacyReviewQueue(env.reviewQueuePath, env.jobStorePath);
      assert.equal(replay.status, 'migrated');
      assert.equal(replay.imported, 0);
      assert.equal(Object.keys(loadEvidenceReviewJobStore(env.jobStorePath).jobs).length, 3);
    } finally {
      env.cleanup();
    }
  });

  test('migration hydrates released dual-written Jobs instead of discarding queue-only state', () => {
    const env = setup();
    try {
      const operationalBundle = bundle('dual-written-operational');
      const operational = createEvidenceReviewJob({
        bundle: operationalBundle,
        candidate: operationalBundle.episode as DistilledKnowledgeCandidate,
        workClass: 'live_learning',
        now: new Date(NOW),
      });
      const retryQuantum = Object.values(operational.quanta)
        .find(quantum => quantum.dependencyQuantumIds.length === 0)!;
      retryQuantum.state = 'retry_wait';
      retryQuantum.attempts = 1;
      retryQuantum.currentDelayMs = 100;
      retryQuantum.nextRetryAt = '2026-07-20T00:00:30.000Z';
      operational.nextDueAt = retryQuantum.nextRetryAt;

      const deferredBundle = bundle('dual-written-deferred');
      const deferred = createEvidenceReviewJob({
        bundle: deferredBundle,
        candidate: deferredBundle.episode as DistilledKnowledgeCandidate,
        workClass: 'live_learning',
        now: new Date(NOW),
      });
      deferred.disposition = 'deferred';

      const state = loadEvidenceReviewJobStore(env.jobStorePath);
      state.jobs[operational.jobId] = operational;
      state.jobs[deferred.jobId] = deferred;
      saveEvidenceReviewJobStore(env.jobStorePath, state);

      fs.mkdirSync(path.dirname(env.reviewQueuePath), { recursive: true });
      fs.writeFileSync(env.reviewQueuePath, JSON.stringify({
        schemaVersion: 1,
        operational: [{
          entryId: 'dual-op', candidateCapabilityId: 'dual-written-operational',
          bundleId: operationalBundle.bundleId, bundle: operationalBundle,
          candidate: operationalBundle.episode,
          failureKind: 'branch_timeout', failureMessage: 'released timeout',
          failureTranscripts: ['released-author.jsonl'], attempts: 3, currentDelayMs: 400,
          nextRetryAt: '2026-07-20T00:01:00.000Z', createdAt: NOW, updatedAt: NOW,
        }],
        deferred: [{
          entryId: 'dual-defer', candidateCapabilityId: 'dual-written-deferred',
          bundleId: deferredBundle.bundleId, bundle: deferredBundle,
          candidate: deferredBundle.episode, relevantReadSet: [{ handle: 'cap-a', revision: 7 }],
          evidenceFingerprint: 'released-evidence-fingerprint', reviewerVersion: 'reviewer-v1',
          reason: 'released deferred state',
          createdAt: NOW, updatedAt: NOW,
        }],
      }));

      const migrated = importLegacyReviewQueue(env.reviewQueuePath, env.jobStorePath);
      assert.equal(migrated.status, 'migrated');
      assert.equal(migrated.imported, 2);
      const hydrated = loadEvidenceReviewJobStore(env.jobStorePath);
      assert.equal(Object.keys(hydrated.jobs).length, 2, 'migration must not duplicate existing owners');
      const hydratedOperational = hydrated.jobs[operational.jobId]!;
      const hydratedRetry = Object.values(hydratedOperational.quanta)
        .find(quantum => quantum.state === 'retry_wait')!;
      assert.deepEqual(
        [hydratedOperational.workClass, hydratedRetry.attempts, hydratedRetry.currentDelayMs,
          hydratedRetry.nextRetryAt, hydratedRetry.failureKind, hydratedRetry.transcriptPaths],
        ['operational_recovery', 3, 400, '2026-07-20T00:01:00.000Z',
          'branch_timeout', ['released-author.jsonl']],
      );
      const hydratedDeferred = hydrated.jobs[deferred.jobId]!;
      assert.deepEqual(hydratedDeferred.deferState, {
        reviewerVersion: 'reviewer-v1',
        reason: 'released deferred state',
        deferredAt: NOW,
        registryReadSet: [{ handle: 'cap-a', revision: 7 }],
        evidenceFingerprint: 'released-evidence-fingerprint',
      });
    } finally {
      env.cleanup();
    }
  });

  test('corrupt legacy input and corrupt authoritative state both fail closed', () => {
    const corruptLegacy = setup();
    try {
      fs.mkdirSync(path.dirname(corruptLegacy.reviewQueuePath), { recursive: true });
      fs.writeFileSync(corruptLegacy.reviewQueuePath, '{broken');
      assert.throws(() => new SkillEvolutionRuntime(corruptLegacy.options), /corrupt|quarantined/i);
      assert.equal(fs.existsSync(corruptLegacy.reviewQueuePath), false);
      assert.equal(fs.existsSync(`${corruptLegacy.reviewQueuePath}.state-corrupt`), true);
      assert.ok(fs.readdirSync(path.dirname(corruptLegacy.reviewQueuePath)).some(name => name.includes('.corrupt.')));
      assert.throws(
        () => new SkillEvolutionRuntime(corruptLegacy.options),
        /corrupt|quarantined/i,
        'the sidecar must keep a second startup fail-closed after quarantine moved the source',
      );
    } finally {
      corruptLegacy.cleanup();
    }

    const corruptStore = setup();
    try {
      fs.mkdirSync(path.dirname(corruptStore.reviewQueuePath), { recursive: true });
      fs.writeFileSync(corruptStore.reviewQueuePath, JSON.stringify({ schemaVersion: 1, operational: [], deferred: [] }));
      fs.writeFileSync(corruptStore.jobStorePath, '{broken');
      assert.throws(
        () => importLegacyReviewQueue(corruptStore.reviewQueuePath, corruptStore.jobStorePath),
        /job store was corrupt/i,
      );
      assert.equal(fs.existsSync(corruptStore.reviewQueuePath), true, 'legacy source remains recoverable');
      assert.equal(fs.existsSync(`${corruptStore.jobStorePath}.state-corrupt`), true);
      const latched = loadEvidenceReviewJobStore(corruptStore.jobStorePath);
      assert.equal(latched.stateCorrupt, true);
      assert.throws(
        () => saveEvidenceReviewJobStore(corruptStore.jobStorePath, latched),
        /corruption is latched/i,
      );
      assert.throws(
        () => new SkillEvolutionRuntime(corruptStore.options),
        /job store is corrupt/i,
        'a second startup must not replace quarantined authoritative state with an empty store',
      );
    } finally {
      corruptStore.cleanup();
    }
  });

  test('ordinary restart is dormant and missing defer metadata never auto-reactivates', () => {
    const env = setup();
    try {
      seedDeferred(env.options, { bundle: bundle('dormant') });
      seedDeferred(env.options, { bundle: bundle('missing-state'), omitDeferState: true });
      assert.deepEqual(new SkillEvolutionRuntime(env.options).reactivateDeferredReviews(), []);
      assert.deepEqual(new SkillEvolutionRuntime(env.options).reactivateDeferredReviews(), []);
      assert.equal(
        Object.values(loadEvidenceReviewJobStore(env.jobStorePath).jobs)
          .filter(job => job.disposition === 'deferred').length,
        2,
      );
    } finally {
      env.cleanup();
    }
  });

  test('reviewer/policy, Registry, and fresh-evidence triggers create one clean successor', () => {
    for (const mode of ['reviewer', 'policy'] as const) {
      const env = setup(mode === 'reviewer' ? 'reviewer-v2' : SKILL_EVOLUTION_REVIEWER_VERSION);
      try {
        const stale = seedDeferred(env.options, {
          bundle: bundle(mode),
          reviewerVersion: mode === 'reviewer' ? 'reviewer-v1' : SKILL_EVOLUTION_REVIEWER_VERSION,
          reviewPolicyVersion: mode === 'policy' ? 'evidence-review-policy-v1' : undefined,
        });
        const runtime = new SkillEvolutionRuntime(env.options);
        assert.equal(runtime.reactivateDeferredReviews().length, 1, `${mode} trigger`);
        assertUniqueSuccessor(runtime, stale.jobId);
      } finally {
        env.cleanup();
      }
    }

    const registryEnv = setup();
    try {
      const stale = seedDeferred(registryEnv.options, {
        bundle: bundle('registry'), registryReadSet: [{ handle: 'cap-a', revision: 1 }],
      });
      fs.writeFileSync(registryEnv.options.registryPath, JSON.stringify({
        schemaVersion: 2, catalogRevision: 2, routeRedirects: {}, capabilities: {
          'cap-a': {
            handle: 'cap-a', revision: 2, routingName: 'cap-a-route', description: 'Capability A',
            skillFilePath: path.join(registryEnv.root, 'skills', 'cap-a', 'SKILL.md'),
            guidanceHash: 'hash-a', evidenceRefs: [], referencedSkills: [], createdAt: NOW, updatedAt: NOW,
          },
        },
      }));
      const runtime = new SkillEvolutionRuntime(registryEnv.options);
      assert.equal(runtime.reactivateDeferredReviews().length, 1);
      const successor = assertUniqueSuccessor(runtime, stale.jobId);
      assert.deepEqual(successor.basis.registryReadSet, [{ handle: 'cap-a', revision: 2 }]);
      assert.deepEqual(runtime.reactivateDeferredReviews(), [], 'updated basis cannot re-defer-loop');
    } finally {
      registryEnv.cleanup();
    }

    const evidenceEnv = setup();
    try {
      const original = bundle('evidence');
      const stale = seedDeferred(evidenceEnv.options, { bundle: original });
      const runtime = new SkillEvolutionRuntime(evidenceEnv.options);
      assert.deepEqual(runtime.reactivateDeferredReviews([original]), []);
      const changed: EvidenceBundle = {
        ...original,
        completionEvidence: [...original.completionEvidence, { ref: 'session.jsonl#3' }],
      };
      assert.equal(runtime.reactivateDeferredReviews([changed]).length, 1);
      const successor = assertUniqueSuccessor(runtime, stale.jobId);
      assert.notEqual(successor.basis.evidenceBundleHash, stale.basis.evidenceBundleHash);
    } finally {
      evidenceEnv.cleanup();
    }
  });

  test('a deterministic successor ID collision preserves the stale audit record', () => {
    const env = setup();
    try {
      const staleBundle = bundle('corrupted-basis-collision');
      const stale = createEvidenceReviewJob({
        bundle: staleBundle,
        candidate: staleBundle.episode as DistilledKnowledgeCandidate,
        workClass: 'live_learning',
        now: new Date(NOW),
      });
      const completedRoot = Object.values(stale.quanta)
        .find(quantum => quantum.dependencyQuantumIds.length === 0)!;
      completedRoot.state = 'succeeded';
      stale.basis = { ...stale.basis, basisHash: 'corrupted-basis-hash' };
      const seeded = loadEvidenceReviewJobStore(env.jobStorePath);
      seeded.jobs[stale.jobId] = stale;
      saveEvidenceReviewJobStore(env.jobStorePath, seeded);

      const runtime = new SkillEvolutionRuntime(env.options);
      const fenced = runtime.fenceStaleActiveJobsBeforeFairAdvance(new Date(NOW));
      assert.deepEqual(fenced.supersededJobIds, [stale.jobId]);
      assert.equal(fenced.successorJobIds.length, 1);
      assert.notEqual(fenced.successorJobIds[0], stale.jobId);

      const state = runtime.getEvidenceReviewEngine().loadStore();
      assert.equal(state.jobs[stale.jobId]?.disposition, 'superseded');
      assert.equal(state.jobs[stale.jobId]?.quanta[completedRoot.quantumId]?.state, 'succeeded');
      const successor = state.jobs[fenced.successorJobIds[0]!]!;
      assert.equal(successor.parentJobId, stale.jobId);
      assert.equal(successor.disposition, 'active');
      assert.equal(
        Object.values(successor.quanta).some(quantum => quantum.state === 'succeeded'),
        false,
        'a collision successor must not trust quanta from the corrupted basis',
      );
    } finally {
      env.cleanup();
    }
  });
});

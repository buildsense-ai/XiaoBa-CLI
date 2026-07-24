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
    authority: { kind: 'learning-episode', episodeId: id },
    episode: candidate(id),
    completionEvidence: [{ ref: 'session.jsonl#1' }],
    settlementEvidence: [{ ref: 'session.jsonl#2' }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    sourceEvidence: [
      {
        ref: 'session.jsonl#1',
        role: 'problem-action',
        content: 'The bounded task was requested and completed.',
      },
      {
        ref: 'session.jsonl#2',
        role: 'verification',
        content: 'The completed result was verified.',
      },
    ],
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
  test('corrupt authoritative state stays latched and cannot be overwritten', () => {
    const corruptStore = setup();
    try {
      fs.mkdirSync(path.dirname(corruptStore.jobStorePath), { recursive: true });
      fs.writeFileSync(corruptStore.jobStorePath, '{broken');
      const latched = loadEvidenceReviewJobStore(corruptStore.jobStorePath);
      assert.equal(latched.stateCorrupt, true);
      assert.equal(fs.existsSync(`${corruptStore.jobStorePath}.state-corrupt`), true);
      assert.throws(
        () => saveEvidenceReviewJobStore(corruptStore.jobStorePath, latched),
        /corruption is latched/i,
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

  test('an active legacy Learning Episode job stays dormant until frozen source evidence is migrated', () => {
    const env = setup();
    try {
      const legacyBundle: EvidenceBundle = {
        ...bundle('v3:learning-episode:episode-legacy-active-no-source'),
        authority: undefined,
        episode: candidate('episode-capability-legacy-active-no-source'),
        sourceEvidence: undefined,
      };
      const legacy = createEvidenceReviewJob({
        bundle: legacyBundle,
        candidate: legacyBundle.episode as DistilledKnowledgeCandidate,
        workClass: 'live_learning',
        reviewPolicyVersion: 'evidence-review-policy-v6',
        now: new Date(NOW),
      });
      const seeded = loadEvidenceReviewJobStore(env.jobStorePath);
      seeded.jobs[legacy.jobId] = legacy;
      saveEvidenceReviewJobStore(env.jobStorePath, seeded);

      const runtime = new SkillEvolutionRuntime(env.options);
      const fenced = runtime.fenceStaleActiveJobsBeforeFairAdvance(new Date(NOW));
      assert.deepEqual(fenced, { supersededJobIds: [], successorJobIds: [] });

      const dormant = runtime.getEvidenceReviewEngine().loadStore().jobs[legacy.jobId]!;
      assert.equal(dormant.disposition, 'deferred');
      assert.match(dormant.deferState?.reason ?? '', /no complete frozen source evidence/);
      assert.equal(dormant.nextDueAt, undefined);
      assert.equal(
        Object.values(dormant.quanta).some(quantum => quantum.attempts > 0),
        false,
        'no reader, author, or verifier quantum should be claimed',
      );

      assert.deepEqual(
        runtime.reactivateDeferredReviews(),
        [],
        'review policy changes alone cannot make missing evidence replayable',
      );

      const migratedBundle: EvidenceBundle = {
        ...legacyBundle,
        sourceEvidence: [
          {
            ref: 'session.jsonl#1',
            role: 'problem-action',
            content: 'A bounded task was requested and handled.',
          },
          {
            ref: 'session.jsonl#2',
            role: 'verification',
            content: 'The result was verified.',
          },
        ],
      };
      const [successor] = runtime.reactivateDeferredReviews([migratedBundle]);
      assert.ok(successor);
      assert.equal(successor.bundle.sourceEvidence?.length, 2);
      assert.equal(successor.disposition, 'active');
    } finally {
      env.cleanup();
    }
  });
});

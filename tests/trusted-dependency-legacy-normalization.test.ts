import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import {
  type EvidenceBundle,
  SkillEvolutionRuntime,
  type SkillEvolutionOptions,
} from '../src/utils/skill-evolution';
import {
  loadEvidenceReviewJobStore,
  saveEvidenceReviewJobStore,
  upsertEvidenceReviewJob,
  findOperationalJobByBundleId,
  findDeferredJobByBundleId,
} from '../src/utils/evidence-review-job-store';
import { createEvidenceReviewJob } from '../src/utils/evidence-review-graph';
import {
  advanceJobsFairly,
  readShardStructurally,
  resolveEvidenceReviewJobStorePath,
} from '../src/utils/evidence-review-engine';

function fixtureCandidate(id: string): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: id,
    title: `Candidate ${id}`,
    applicability: 'When the user needs this bounded workflow.',
    actionPattern: 'Follow the bounded workflow only.',
    boundaries: ['Bounded by the cited evidence only.'],
    risks: ['Do not import unrelated dependencies.'],
    solvedLoop: { problem: 'bounded task', action: 'solved it', verification: 'accepted', noCorrection: 'none' },
    provenance: [
      { filePath: 'session.jsonl', turn: 12, role: 'problem-action', unitByteRange: { start: 0, end: 10 } },
      { filePath: 'session.jsonl', turn: 13, role: 'verification', unitByteRange: { start: 11, end: 20 } },
    ],
    generatedAt: '2026-07-19T00:00:00.000Z',
    sourceUnit: { filePath: 'session.jsonl', byteRange: { start: 0, end: 20 }, generatedAt: '2026-07-19T00:00:00.000Z' },
  };
}

function ordinaryBundle(
  bundleId = 'v3:learning-episode:episode-legacy-1',
  capabilityId = `episode-capability-${bundleId.replace(/^.*:episode-/, '')}`,
): EvidenceBundle {
  return {
    bundleId,
    episode: fixtureCandidate(capabilityId),
    completionEvidence: [{ ref: 'session.jsonl#12' }],
    settlementEvidence: [{ ref: 'session.jsonl#13' }],
    sourceEvidence: [
      {
        ref: 'session.jsonl#12',
        sourceFilePath: 'session.jsonl',
        turn: 12,
        byteRange: { start: 0, end: 10 },
        role: 'problem-action',
        content: 'Use the bounded workflow.',
      },
      {
        ref: 'session.jsonl#13',
        sourceFilePath: 'session.jsonl',
        turn: 13,
        byteRange: { start: 11, end: 20 },
        role: 'verification',
        content: 'The bounded workflow was accepted.',
      },
    ],
    semanticObservations: [
      { kind: 'user-intent', value: 'use the bounded workflow', sourceRefs: ['session.jsonl#12:user-intent'] },
    ],
    boundedContinuity: [],
    // Legacy leakage: persisted global-catalog referencedSkills array.
    referencedSkills: [
      { name: 'generated-helper-a', capabilityHandle: 'cap-a', guidanceHash: 'hash-a' },
      { name: 'generated-helper-b', capabilityHandle: 'cap-b', guidanceHash: 'hash-b' },
    ],
    relatedCurrentSkills: [],
  };
}

function trustedOrdinaryBundle(bundleId = 'v3:learning-episode:episode-trusted-1'): EvidenceBundle {
  return {
    ...ordinaryBundle(bundleId),
    referencedSkills: [
      { name: 'generated-helper-a', capabilityHandle: 'cap-a', guidanceHash: 'hash-a' },
    ],
    referencedSkillProvenance: {
      kind: 'runtime-owned-generated-skill-load-v1',
      runtimeSessionId: 'runtime-session-1',
      agentTurnEpisodeId: 'agent-turn-episode-1',
      referencedSkills: [
        { capabilityHandle: 'cap-a', routingName: 'generated-helper-a', guidanceHash: 'hash-a' },
      ],
    },
  };
}

function forgedTrustedOrdinaryBundle(bundleId = 'v3:learning-episode:episode-forged-1'): EvidenceBundle {
  return {
    ...ordinaryBundle(bundleId),
    referencedSkills: [
      { name: 'generated-helper-a', capabilityHandle: 'cap-a', guidanceHash: 'hash-forged' },
    ],
    referencedSkillProvenance: {
      kind: 'runtime-owned-generated-skill-load-v1',
      runtimeSessionId: 'runtime-session-1',
      agentTurnEpisodeId: 'agent-turn-episode-1',
      referencedSkills: [
        { capabilityHandle: 'cap-a', routingName: 'generated-helper-a', guidanceHash: 'hash-a' },
      ],
    },
  };
}

function flashcardBundle(
  bundleId = 'flashcard-legacy-1',
  episodeId = bundleId.slice('flashcard-'.length),
): EvidenceBundle {
  return {
    ...ordinaryBundle(bundleId),
    episode: {
      episodeId,
      workflow: 'flashcard correction and verified retry',
    },
    referencedSkills: [{ name: 'word-card-maker', version: '1.0.0', contentFingerprint: 'word-card-v1' }],
  };
}

function genericV3Bundle(bundleId = 'v3:session.jsonl:0:20:candidate-generic-1'): EvidenceBundle {
  return ordinaryBundle(bundleId);
}

function legacyV3Bundle(bundleId = 'legacy-v3:legacy-generic-1'): EvidenceBundle {
  return ordinaryBundle(bundleId);
}

function usageCurationBundle(
  bundleId = 'usage-curation:cap-a:fact-1',
  capabilityHandle = 'cap-a',
): EvidenceBundle {
  return {
    ...ordinaryBundle(bundleId),
    episode: {
      kind: 'usage-reassessment',
      capabilityHandle,
    },
    referencedSkills: [{ name: 'generated-helper-a', capabilityHandle: 'cap-a', guidanceHash: 'hash-a' }],
  };
}

function semanticReassessmentBundle(
  bundleId = 'semantic-reassessment:cap-a:guidance-a:semantic-a',
  capabilityHandle = 'cap-a',
): EvidenceBundle {
  return {
    ...ordinaryBundle(bundleId),
    episode: {
      ...fixtureCandidate('semantic-cap-a'),
      capabilityHandle,
    },
    referencedSkills: [{ name: 'generated-helper-a', capabilityHandle: 'cap-a', guidanceHash: 'hash-a' }],
  };
}

function setup(): { root: string; options: SkillEvolutionOptions; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-trusted-dependency-legacy-'));
  const skillsRoot = path.join(root, 'skills');
  const previousRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;
  const previousSkillsRoot = process.env.XIAOBA_SKILLS_DIR;
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  const options: SkillEvolutionOptions = {
    workingDirectory: root,
    outputDir: path.join(skillsRoot, 'generated-distilled'),
    registryPath: path.join(root, 'data', 'current-skill-registry.json'),
    auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
    journalPath: path.join(root, 'data', 'transition-journal.json'),
    reviewQueuePath: path.join(root, 'data', 'review-queue.json'),
    manualSkillNames: ['manual-skill'],
    logEnabled: false,
    readerFixture: ({ shard, lane }) => ({
      findingSet: readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane),
    }),
    authorFixture: ({ bundle }) => ({
      body: `Use the workflow for ${bundle.bundleId}.`,
      envelope: {
        decision: 'create_current_skill',
        routingName: `route-${bundle.bundleId.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        description: `Workflow for ${bundle.bundleId}.`,
        evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
      },
    }),
    verifierFixture: () => ({
      decision: 'accept',
      transition: 'create_current_skill',
      issues: [],
      rationale: 'Looks bounded.',
    }),
  };
  return {
    root,
    options,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      if (previousRuntimeRoot === undefined) delete process.env.XIAOBA_RUNTIME_ROOT;
      else process.env.XIAOBA_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousSkillsRoot === undefined) delete process.env.XIAOBA_SKILLS_DIR;
      else process.env.XIAOBA_SKILLS_DIR = previousSkillsRoot;
    },
  };
}

/** Seed an operational recovery job in the job store (replaces legacy addOrUpdateOperationalFailure). */
function seedOperationalFailure(
  options: SkillEvolutionOptions,
  bundle: EvidenceBundle,
  message: string,
  now = new Date(0),
): void {
  const jobStorePath = resolveEvidenceReviewJobStorePath(options);
  const job = createEvidenceReviewJob({
    bundle,
    candidate: bundle.episode as DistilledKnowledgeCandidate,
    workClass: 'operational_recovery',
  });
  const retryQuantum = Object.values(job.quanta)
    .filter(quantum => quantum.dependencyQuantumIds.length === 0)
    .sort((left, right) => left.quantumId.localeCompare(right.quantumId, 'en'))[0]!;
  retryQuantum.state = 'retry_wait';
  retryQuantum.attempts = 1;
  retryQuantum.currentDelayMs = 1;
  retryQuantum.nextRetryAt = now.toISOString();
  retryQuantum.failureKind = 'branch_timeout';
  retryQuantum.failureMessage = message;
  const state = loadEvidenceReviewJobStore(jobStorePath);
  const operationalJob = {
    ...job,
    disposition: 'active' as const,
    workClass: 'operational_recovery' as const,
    nextDueAt: now.toISOString(),
  };
  upsertEvidenceReviewJob(state, operationalJob);
  saveEvidenceReviewJobStore(jobStorePath, state);
}

/** Seed a deferred job in the job store (replaces legacy upsertDeferredEntry). */
function seedDeferredEntry(
  options: SkillEvolutionOptions,
  bundle: EvidenceBundle,
  reviewerVersion: string,
  reason: string,
  now = new Date(0),
): void {
  const jobStorePath = resolveEvidenceReviewJobStorePath(options);
  const job = createEvidenceReviewJob({
    bundle,
    candidate: bundle.episode as DistilledKnowledgeCandidate,
    workClass: 'semantic_reassessment',
  });
  const state = loadEvidenceReviewJobStore(jobStorePath);
  const deferredJob = {
    ...job,
    disposition: 'deferred' as const,
    workClass: 'semantic_reassessment' as const,
    deferState: {
      reviewerVersion,
      reason,
      deferredAt: now.toISOString(),
    },
  };
  upsertEvidenceReviewJob(state, deferredJob);
  saveEvidenceReviewJobStore(jobStorePath, state);
}

async function advanceFairUntilBlocked(runtime: SkillEvolutionRuntime) {
  const touched = new Set<string>();
  runtime.reactivateDeferredReviews();
  runtime.fenceStaleActiveJobsBeforeFairAdvance();
  for (let turn = 0; turn < 256; turn++) {
    const advanced = await advanceJobsFairly(
      runtime.getEvidenceReviewEngine(),
      `normalization:${turn}`,
      { maxClaims: 1, maxClaimsPerJob: 1 },
    );
    for (const jobId of advanced.jobIds) touched.add(jobId);
    if (advanced.claims === 0) break;
  }
  return runtime.collectFairReviewOutcomes([...touched]);
}

describe('legacy referencedSkills normalization', () => {
  test('ordinary persisted operational retry strips legacy global-catalog referencedSkills before Author/Verifier', async () => {
    const env = setup();
    try {
      const seenReferencedSkills: string[][] = [];
      env.options.authorFixture = ({ bundle }) => {
        seenReferencedSkills.push(bundle.referencedSkills.map(skill => skill.name));
        return {
          body: 'Use the bounded workflow only.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'normalized-ordinary-retry',
            description: 'Normalized ordinary retry.',
            evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
          },
        };
      };

      const bundle = ordinaryBundle();
      seedOperationalFailure(env.options, bundle, 'seeded legacy ordinary retry');

      const result = await advanceFairUntilBlocked(new SkillEvolutionRuntime(env.options));

      assert.equal(result.reviewed, 1);
      assert.deepEqual(seenReferencedSkills, [[]]);
    } finally {
      env.cleanup();
    }
  });

  test('generic persisted v3 retry without provable authority remains durably deferred', async () => {
    const env = setup();
    try {
      env.options.authorFixture = () => {
        throw new Error('unclassified generic work must not reach Author');
      };

      const bundle = genericV3Bundle();
      seedOperationalFailure(env.options, bundle, 'seeded generic v3 retry');

      const runtime = new SkillEvolutionRuntime(env.options);
      const result = await advanceFairUntilBlocked(runtime);
      const jobs = Object.values(
        loadEvidenceReviewJobStore(resolveEvidenceReviewJobStorePath(env.options)).jobs,
      );

      assert.equal(result.reviewed, 0);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.disposition, 'deferred');
      assert.match(jobs[0]!.deferState?.reason ?? '', /no provable authority/);
      assert.deepEqual(
        runtime.reactivateDeferredReviews(),
        [],
        'an unclassifiable deferred Job must remain dormant across later wakes',
      );
    } finally {
      env.cleanup();
    }
  });

  test('legacy family prefixes stay dormant when payload identity does not match the Bundle ID', async () => {
    const mismatches: Array<{ name: string; bundle: EvidenceBundle }> = [
      {
        name: 'learning episode',
        bundle: ordinaryBundle(
          'v3:learning-episode:episode-legacy-1',
          'episode-capability-different-episode',
        ),
      },
      {
        name: 'flashcard',
        bundle: flashcardBundle('flashcard-legacy-1', 'different-episode'),
      },
      {
        name: 'usage reassessment',
        bundle: usageCurationBundle('usage-curation:cap-a:fact-1', 'cap-b'),
      },
      {
        name: 'semantic reassessment',
        bundle: semanticReassessmentBundle(
          'semantic-reassessment:cap-a:guidance-a:semantic-a',
          'cap-b',
        ),
      },
    ];

    for (const mismatch of mismatches) {
      const env = setup();
      try {
        env.options.authorFixture = () => {
          throw new Error(`${mismatch.name} identity mismatch must not reach Author`);
        };
        seedOperationalFailure(
          env.options,
          mismatch.bundle,
          `seeded mismatched ${mismatch.name} retry`,
        );

        const runtime = new SkillEvolutionRuntime(env.options);
        const result = await advanceFairUntilBlocked(runtime);
        const jobs = Object.values(
          loadEvidenceReviewJobStore(resolveEvidenceReviewJobStorePath(env.options)).jobs,
        );

        assert.equal(result.reviewed, 0, mismatch.name);
        assert.equal(jobs.length, 1, mismatch.name);
        assert.equal(jobs[0]!.disposition, 'deferred', mismatch.name);
        assert.match(jobs[0]!.deferState?.reason ?? '', /no provable authority/, mismatch.name);
        assert.deepEqual(runtime.reactivateDeferredReviews(), [], mismatch.name);
      } finally {
        env.cleanup();
      }
    }
  });

  test('structurally verified legacy flashcard retry preserves its pinned referenced skill', async () => {
    const env = setup();
    try {
      const seenReferencedSkills: string[][] = [];
      env.options.authorFixture = ({ bundle }) => {
        seenReferencedSkills.push(bundle.referencedSkills.map(skill => skill.name));
        return {
          body: 'Use the bounded flashcard workflow.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'normalized-flashcard-retry',
            description: 'Normalized flashcard retry.',
            referencedSkills: ['word-card-maker'],
            evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
          },
        };
      };

      const bundle = flashcardBundle();
      seedOperationalFailure(env.options, bundle, 'seeded flashcard retry');

      const result = await advanceFairUntilBlocked(new SkillEvolutionRuntime(env.options));

      assert.equal(result.reviewed, 1);
      assert.deepEqual(seenReferencedSkills, [['word-card-maker']]);
    } finally {
      env.cleanup();
    }
  });

  test('usage-curation retry preserves its audited referenced skills while staying deferred without an append target', async () => {
    const env = setup();
    try {
      const seenReferencedSkills: string[][] = [];
      env.options.authorFixture = ({ bundle }) => {
        seenReferencedSkills.push(bundle.referencedSkills.map(skill => skill.name));
        return {
          body: 'Use the audited usage-curation workflow.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'normalized-usage-curation-retry',
            description: 'Normalized usage-curation retry.',
            referencedSkills: ['generated-helper-a'],
            evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
          },
        };
      };
      env.options.verifierFixture = () => ({
        decision: 'defer',
        issues: [{
          code: 'awaiting-append-target',
          message: 'The usage correction has no active exact target in this fixture.',
          severity: 'warning',
        }],
        rationale: 'Keep the authenticated dependency vector while waiting for an exact append target.',
      });

      const bundle = usageCurationBundle();
      seedOperationalFailure(env.options, bundle, 'seeded usage-curation retry');

      const result = await advanceFairUntilBlocked(new SkillEvolutionRuntime(env.options));
      const persisted = Object.values(
        loadEvidenceReviewJobStore(resolveEvidenceReviewJobStorePath(env.options)).jobs,
      ).filter(job => job.bundle.bundleId === bundle.bundleId);

      assert.equal(result.reviewed, 1);
      assert.ok(persisted.some(job => job.disposition === 'deferred'));
      assert.ok(seenReferencedSkills.length >= 1);
      assert.ok(seenReferencedSkills.every(names => (
        names.length === 1 && names[0] === 'generated-helper-a'
      )));
    } finally {
      env.cleanup();
    }
  });

  test('semantic reassessment retry preserves authenticated referenced skills', async () => {
    const env = setup();
    try {
      const seenReferencedSkills: string[][] = [];
      env.options.authorFixture = ({ bundle }) => {
        seenReferencedSkills.push(bundle.referencedSkills.map(skill => skill.name));
        return {
          body: 'Use the audited semantic reassessment workflow.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'normalized-semantic-reassessment-retry',
            description: 'Normalized semantic reassessment retry.',
            referencedSkills: ['generated-helper-a'],
            evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
          },
        };
      };

      const bundle = semanticReassessmentBundle();
      seedOperationalFailure(env.options, bundle, 'seeded semantic reassessment retry');

      const result = await advanceFairUntilBlocked(new SkillEvolutionRuntime(env.options));

      assert.equal(result.reviewed, 1);
      assert.deepEqual(seenReferencedSkills, [['generated-helper-a']]);
    } finally {
      env.cleanup();
    }
  });

  test('trusted current ordinary operational retry retains the exact proven dependency', async () => {
    const env = setup();
    try {
      const seenReferencedSkills: string[][] = [];
      env.options.authorFixture = ({ bundle }) => {
        seenReferencedSkills.push(bundle.referencedSkills.map(skill => skill.name));
        return {
          body: 'Use the trusted bounded workflow only.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'normalized-trusted-ordinary-operational-retry',
            description: 'Normalized trusted ordinary operational retry.',
            referencedSkills: ['generated-helper-a'],
            evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
          },
        };
      };

      const bundle = trustedOrdinaryBundle();
      seedOperationalFailure(env.options, bundle, 'seeded trusted ordinary retry');

      const result = await advanceFairUntilBlocked(new SkillEvolutionRuntime(env.options));

      assert.equal(result.reviewed, 1);
      assert.deepEqual(seenReferencedSkills, [['generated-helper-a']]);
    } finally {
      env.cleanup();
    }
  });

  test('trusted current ordinary deferred retry retains the exact proven dependency', async () => {
    const env = setup();
    try {
      const seenReferencedSkills: string[][] = [];
      const seenAuthorities: EvidenceBundle['authority'][] = [];
      env.options.authorFixture = ({ bundle }) => {
        seenReferencedSkills.push(bundle.referencedSkills.map(skill => skill.name));
        seenAuthorities.push(bundle.authority);
        return {
          body: 'Use the trusted bounded workflow only.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'normalized-trusted-ordinary-deferred-retry',
            description: 'Normalized trusted ordinary deferred retry.',
            referencedSkills: ['generated-helper-a'],
            evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
          },
        };
      };
      env.options.verifierFixture = () => ({
        decision: 'accept',
        transition: 'create_current_skill',
        issues: [],
        rationale: 'Looks bounded now.',
      });

      const bundle = trustedOrdinaryBundle('v3:learning-episode:episode-trusted-deferred-1');
      seedDeferredEntry(env.options, bundle, 'legacy-reviewer-version', 'Waiting for retry.');

      await advanceFairUntilBlocked(new SkillEvolutionRuntime(env.options));
      assert.deepEqual(seenReferencedSkills, [['generated-helper-a']]);
      assert.deepEqual(seenAuthorities, [{
        kind: 'learning-episode',
        episodeId: 'episode-trusted-deferred-1',
      }]);
    } finally {
      env.cleanup();
    }
  });

  test('forged or mismatched trusted ordinary provenance fails closed before Author/Verifier', async () => {
    const env = setup();
    try {
      const seenReferencedSkills: string[][] = [];
      env.options.authorFixture = ({ bundle }) => {
        seenReferencedSkills.push(bundle.referencedSkills.map(skill => skill.name));
        return {
          body: 'Use the bounded workflow only.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'normalized-forged-ordinary-retry',
            description: 'Normalized forged ordinary retry.',
            evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
          },
        };
      };

      const bundle = forgedTrustedOrdinaryBundle();
      seedOperationalFailure(env.options, bundle, 'seeded forged ordinary retry');

      const result = await advanceFairUntilBlocked(new SkillEvolutionRuntime(env.options));

      assert.equal(result.reviewed, 1);
      assert.deepEqual(seenReferencedSkills, [[]]);
    } finally {
      env.cleanup();
    }
  });

  test('unclassified legacy-v3 retry remains durably deferred', async () => {
    const env = setup();
    try {
      env.options.authorFixture = () => {
        throw new Error('unclassified legacy work must not reach Author');
      };

      const bundle = legacyV3Bundle();
      seedOperationalFailure(env.options, bundle, 'seeded legacy v3 retry');

      const runtime = new SkillEvolutionRuntime(env.options);
      const result = await advanceFairUntilBlocked(runtime);
      const jobs = Object.values(
        loadEvidenceReviewJobStore(resolveEvidenceReviewJobStorePath(env.options)).jobs,
      );

      assert.equal(result.reviewed, 0);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.disposition, 'deferred');
      assert.match(jobs[0]!.deferState?.reason ?? '', /no provable authority/);
      assert.deepEqual(runtime.reactivateDeferredReviews(), []);
    } finally {
      env.cleanup();
    }
  });

  test('an unclassified policy-v2 active job is fenced into a dormant defer', async () => {
    const env = setup();
    try {
      env.options.authorFixture = () => {
        throw new Error('stale v2 active job should be fenced before Author runs');
      };

      const runtime = new SkillEvolutionRuntime(env.options);
      const bundle = genericV3Bundle('v3:session.jsonl:0:20:candidate-active-v2');
      const staleJob = createEvidenceReviewJob({
        bundle,
        candidate: bundle.episode as DistilledKnowledgeCandidate,
        workClass: 'live_learning',
        reviewPolicyVersion: 'evidence-review-policy-v2',
        now: new Date('2026-07-19T00:00:00.000Z'),
      });
      const jobStorePath = resolveEvidenceReviewJobStorePath(env.options);
      const state = loadEvidenceReviewJobStore(jobStorePath);
      state.jobs[staleJob.jobId] = staleJob;
      saveEvidenceReviewJobStore(jobStorePath, state);

      const fenced = runtime.fenceStaleActiveJobsBeforeFairAdvance(
        new Date('2026-07-19T00:00:01.000Z'),
      );
      const reloaded = loadEvidenceReviewJobStore(jobStorePath);
      const persistedStale = reloaded.jobs[staleJob.jobId]!;
      const successor = Object.values(reloaded.jobs).find(job => job.parentJobId === staleJob.jobId);

      assert.deepEqual(fenced.supersededJobIds, []);
      assert.equal(persistedStale.disposition, 'deferred');
      assert.equal(persistedStale.successorJobId, undefined);
      assert.equal(successor, undefined);
      assert.match(persistedStale.deferState?.reason ?? '', /no provable authority/);
    } finally {
      env.cleanup();
    }
  });
});

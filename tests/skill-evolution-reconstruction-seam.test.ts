/**
 * Reconstruction seam: a crash/re-entry AFTER the durable commit quantum
 * persisted (commit.state === 'succeeded', job.disposition === 'completed'
 * or 'deferred') but BEFORE advanceJob returned a fresh SkillEvolutionResult
 * must reconstruct the authoritative outcome from the persisted commit
 * quantum result — not infer it from the draft intent or disposition.
 *
 * Drives the real public SkillEvolutionRuntime.reviewAndApply path:
 *   1. First call advances a fresh Evidence Review Job through commit.
 *   2. Simulate crash/re-entry by resuming the SAME terminal persisted job
 *      (override findActiveJobForBundle so ensureJob returns it). advanceJob
 *      on a terminal job returns no fresh result, so reviewAndApply enters
 *      its reconstruction branch.
 *   3. Assert the reconstructed result equals the authoritative commit
 *      quantum outcome with verified=false for reject/defer cases and
 *      correct rounds.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  SkillEvolutionRuntime,
  type EvidenceBundle,
  type SkillDraft,
  type SkillVerifierResult,
  type SkillVerifierIssue,
  type SkillEvolutionOptions,
  type SkillEvolutionResult,
  saveCurrentSkillRegistry,
} from '../src/utils/skill-evolution';
import { loadEvidenceReviewJobStore, findDeferredJobByBundleId } from '../src/utils/evidence-review-job-store';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import { readShardStructurally } from '../src/utils/evidence-review-engine';
import type { EvidenceReviewJob } from '../src/utils/evidence-review-types';
import { acceptReviewObligations } from './evidence-review-test-fixtures';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixtureBundle(bundleId: string): EvidenceBundle {
  return {
    bundleId,
    authority: { kind: 'learning-episode', episodeId: bundleId },
    episode: { problem: 'Create a card', completion: 'card delivered' },
    completionEvidence: [{ ref: 'session.jsonl#12' }],
    settlementEvidence: [{ ref: 'session.jsonl#13' }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [
      {
        kind: 'user-intent',
        value: 'Create a validated card artifact.',
        sourceRefs: ['session.jsonl#12:user-intent'],
      },
      {
        kind: 'workflow-tool',
        value: 'opencli google images mirror',
        sourceRefs: ['session.jsonl#12:workflow:execute_shell'],
      },
    ],
  };
}

function fixtureCandidate(bundleId: string): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: `candidate-${bundleId}`,
    title: 'Card artifact',
    applicability: 'When the user needs a card artifact.',
    actionPattern: 'Use the card maker and validate the result.',
    boundaries: ['Stay within the cited workflow.'],
    risks: ['Evidence is bounded.'],
    solvedLoop: { problem: 'card', action: 'made one', verification: 'delivered', noCorrection: 'none' },
    provenance: [
      { filePath: 'session.jsonl', turn: 12, role: 'problem-action', unitByteRange: { start: 0, end: 10 } },
      { filePath: 'session.jsonl', turn: 13, role: 'verification', unitByteRange: { start: 11, end: 20 } },
    ],
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceUnit: { filePath: 'session.jsonl', byteRange: { start: 0, end: 20 }, generatedAt: '2026-07-10T00:00:00.000Z' },
  };
}

function makeDraft(body: string, routingName = 'card-artifact-delivery'): SkillDraft {
  return {
    body,
    envelope: {
      decision: 'create_current_skill',
      routingName,
      description: 'Create and validate a card artifact.',
      evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
    },
  };
}

interface SetupEnv {
  root: string;
  options: SkillEvolutionOptions;
  cleanup: () => void;
}

function setup(): SetupEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-recon-seam-'));
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
    manualSkillNames: ['manual-skill'],
    logEnabled: true,
    readerFixture: ({ shard, lane }) => ({
      findingSet: readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane),
    }),
    authorFixture: ({ round }) => ({
      body: round === 1
        ? 'Use the bounded card maker, validate the generated artifact, and deliver it.'
        : 'Revised draft addressing verifier issues with narrower boundaries.',
      envelope: {
        decision: 'create_current_skill',
        routingName: 'card-artifact-delivery',
        description: 'Create and validate a card artifact when the user needs a repeatable card workflow.',
        evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
      },
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

type VerifierPlan = Array<{
  decision: SkillVerifierResult['decision'];
  issues?: SkillVerifierIssue[];
  transition?: SkillEvolutionResult['transition'];
}>;

function makeVerifierFixture(plan: VerifierPlan): NonNullable<SkillEvolutionOptions['verifierFixture']> {
  let i = 0;
  return ({ bundle }) => {
    const step = plan[Math.min(i, plan.length - 1)]!;
    i++;
    const dispositionDecision = step.decision === 'accept'
      ? 'accepted'
      : step.decision === 'defer'
        ? 'deferred'
        : 'rejected';
    return {
      decision: step.decision,
      ...(step.transition ? { transition: step.transition } : {}),
      issues: step.issues ?? [],
      rationale: step.decision === 'accept'
        ? 'Draft is acceptable.'
        : step.decision === 'revise'
          ? 'Draft needs revision.'
          : step.decision === 'defer'
            ? 'Defer for more evidence.'
            : 'Reject the candidate.',
      obligationDispositions: acceptReviewObligations(bundle).map(disposition => ({
        ...disposition,
        decision: dispositionDecision,
        rationale: `Test verifier explicitly ${dispositionDecision} this cited obligation.`,
      })),
    };
  };
}

interface DriveResult {
  firstResult: SkillEvolutionResult;
  reconstructed: SkillEvolutionResult;
  persistedJob: EvidenceReviewJob;
  commitQuantumResult: SkillEvolutionResult | undefined;
}

/**
 * Drive reviewAndApply once to a terminal persisted job, then simulate a
 * crash/re-entry by resuming the SAME terminal job (so advanceJob returns no
 * fresh result and reviewAndApply enters its reconstruction branch).
 */
async function driveToTerminalAndReconstruct(
  options: SkillEvolutionOptions,
  bundleId: string,
  verifierPlan: VerifierPlan,
  beforeReconstruct?: () => void,
): Promise<DriveResult> {
  const bundle = fixtureBundle(bundleId);
  const runtime = new SkillEvolutionRuntime(options);
  runtime.options.verifierFixture = makeVerifierFixture(verifierPlan);

  // First call: advances a fresh job through commit and returns the
  // authoritative SkillEvolutionResult (the same value the commit quantum
  // persists durably in its quantum.result).
  const firstResult = await runtime.reviewAndApply(bundle);

  const engine = runtime.getEvidenceReviewEngine();
  const liveAfterFirst = engine.loadStore();
  const persistedJob = Object.values(liveAfterFirst.jobs).find(
    job => job.bundle.bundleId === bundleId
      && (job.disposition === 'completed' || job.disposition === 'deferred'),
  );
  assert.ok(persistedJob, 'First reviewAndApply should have left a terminal persisted job');

  const commitQuantum = Object.values(persistedJob.quanta).find(
    q => q.kind === 'commit' && q.state === 'succeeded',
  );
  const commitQuantumResult = commitQuantum?.result as SkillEvolutionResult | undefined;

  // Simulate crash/re-entry: ensureJob must resume the SAME terminal job so
  // advanceJob returns { result: undefined } and the reconstruction branch
  // in reviewAndApplyViaEvidenceReviewJob fires.
  engine.findActiveJobForBundle = (id: string) => {
    if (id !== bundleId) return undefined;
    const state = engine.loadStore();
    return Object.values(state.jobs)
      .filter(
        job => job.bundle.bundleId === id
          && (job.disposition === 'completed' || job.disposition === 'deferred'),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt, 'en'))[0];
  };

  beforeReconstruct?.();
  const reconstructed = await runtime.reviewAndApply(bundle);
  return { firstResult, reconstructed, persistedJob, commitQuantumResult };
}

function writeRegistryWithCollidingRoute(
  options: SkillEvolutionOptions,
  routingName: string,
): void {
  fs.mkdirSync(path.dirname(options.registryPath), { recursive: true });
  saveCurrentSkillRegistry(options.registryPath, {
    schemaVersion: 2 as const,
    catalogRevision: 1,
    routeRedirects: {},
    capabilities: {
      cap_existing: {
        handle: 'cap_existing',
        revision: 1,
        routingName,
        description: 'Pre-existing colliding capability.',
        skillFilePath: path.join(options.outputDir, 'cap_existing', 'SKILL.md'),
        guidanceHash: 'guidance-existing-fixture',
        evidenceRefs: [],
        referencedSkills: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillEvolution reconstruction seam (crash/re-entry after durable commit)', () => {

  test('RED: exhausted danger revise reconstructs reject_candidate with verified=false, rounds=2 from commit quantum', async () => {
    const env = setup();
    try {
      const bundleId = `recon-danger-${crypto.randomUUID().slice(0, 8)}`;
      const { firstResult, reconstructed, persistedJob, commitQuantumResult } =
        await driveToTerminalAndReconstruct(env.options, bundleId, [
          { decision: 'revise', issues: [{ code: 'too-broad', message: 'Draft is too broad.', severity: 'warning' }] },
          { decision: 'revise', issues: [{ code: 'dangerous', message: 'Dangerous content.', severity: 'danger' }] },
        ]);

      // Authoritative commit outcome.
      assert.equal(firstResult.transition, 'reject_candidate');
      assert.equal(firstResult.verified, false);
      assert.equal(firstResult.rounds, 2);
      assert.ok(commitQuantumResult, 'Commit quantum must have persisted a SkillEvolutionResult');
      assert.equal(commitQuantumResult!.transition, 'reject_candidate');
      assert.equal(commitQuantumResult!.verified, false);
      assert.equal(commitQuantumResult!.rounds, 2);

      // Persisted verifier is normalized to reject (not revise).
      assert.equal(persistedJob.verifierResult?.decision, 'reject');
      assert.equal(persistedJob.disposition, 'completed');

      // Reconstruction must match the authoritative commit outcome, not the
      // draft intent (create_current_skill) and not verified=true.
      assert.equal(reconstructed.transition, 'reject_candidate',
        'reconstruction must use reject_candidate from the commit quantum, not draft.envelope.decision');
      assert.equal(reconstructed.verified, false,
        'reconstruction must NOT infer verified=true from disposition completed');
      assert.equal(reconstructed.rounds, 2);
    } finally {
      env.cleanup();
    }
  });

  test('RED: round-1 reject reconstructs reject_candidate with verified=false, rounds=1 from commit quantum', async () => {
    const env = setup();
    try {
      const bundleId = `recon-r1reject-${crypto.randomUUID().slice(0, 8)}`;
      const { firstResult, reconstructed, persistedJob, commitQuantumResult } =
        await driveToTerminalAndReconstruct(env.options, bundleId, [
          { decision: 'reject', issues: [{ code: 'contradicted', message: 'Contradicted.', severity: 'danger' }] },
        ]);

      assert.equal(firstResult.transition, 'reject_candidate');
      assert.equal(firstResult.verified, false);
      assert.equal(firstResult.rounds, 1);
      assert.ok(commitQuantumResult);
      assert.equal(commitQuantumResult!.transition, 'reject_candidate');
      assert.equal(commitQuantumResult!.verified, false);

      assert.equal(persistedJob.verifierResult?.decision, 'reject');
      assert.equal(persistedJob.disposition, 'completed');

      assert.equal(reconstructed.transition, 'reject_candidate',
        'reconstruction must use reject_candidate from the commit quantum, not draft.envelope.decision');
      assert.equal(reconstructed.verified, false);
      assert.equal(reconstructed.rounds, 1);
    } finally {
      env.cleanup();
    }
  });

  test('RED: accepted verifier but routing-name collision reconstructs reject_candidate with verified=false from commit quantum', async () => {
    const env = setup();
    try {
      // Pre-populate the registry with a capability that collides with the
      // fixture draft routingName. validateDraft does not check the registry,
      // so the draft passes the runtime gate; applyReviewedTransition's
      // reserveCreateRoutingName returns false and the commit quantum persists
      // reject_candidate + verified=false (routing-name-collision).
      writeRegistryWithCollidingRoute(env.options, 'card-artifact-delivery');

      const bundleId = `recon-collision-${crypto.randomUUID().slice(0, 8)}`;
      const { firstResult, reconstructed, persistedJob, commitQuantumResult } =
        await driveToTerminalAndReconstruct(env.options, bundleId, [
          { decision: 'accept', transition: 'create_current_skill' },
        ]);

      assert.equal(firstResult.transition, 'reject_candidate');
      assert.equal(firstResult.verified, false);
      assert.equal(firstResult.rounds, 1);
      assert.ok(commitQuantumResult);
      assert.equal(commitQuantumResult!.transition, 'reject_candidate');
      assert.equal(commitQuantumResult!.verified, false);

      // Verifier accepted, but the commit outcome was reject_candidate.
      assert.equal(persistedJob.verifierResult?.decision, 'accept');
      assert.equal(persistedJob.disposition, 'completed');

      assert.equal(reconstructed.transition, 'reject_candidate',
        'reconstruction must use the commit quantum outcome, not the draft intent / accepted verifier');
      assert.equal(reconstructed.verified, false,
        'reconstruction must NOT infer verified=true from disposition completed for a routing-collision reject');
      assert.equal(reconstructed.rounds, 1);
    } finally {
      env.cleanup();
    }
  });

  test('exhausted non-danger revise reconstructs defer with verified=false, rounds=2 (regression guard)', async () => {
    const env = setup();
    try {
      const bundleId = `recon-defer-${crypto.randomUUID().slice(0, 8)}`;
      const { firstResult, reconstructed, persistedJob, commitQuantumResult } =
        await driveToTerminalAndReconstruct(env.options, bundleId, [
          { decision: 'revise', issues: [{ code: 'too-broad', message: 'Draft is too broad.', severity: 'warning' }] },
          { decision: 'revise', issues: [{ code: 'too-broad', message: 'Still too broad.', severity: 'warning' }] },
        ]);

      assert.equal(firstResult.transition, 'defer');
      assert.equal(firstResult.verified, false);
      assert.equal(firstResult.rounds, 2);
      assert.ok(commitQuantumResult);
      assert.equal(commitQuantumResult!.transition, 'defer');
      assert.equal(commitQuantumResult!.verified, false);

      assert.equal(persistedJob.verifierResult?.decision, 'defer');
      assert.equal(persistedJob.disposition, 'deferred');

      assert.equal(reconstructed.transition, 'defer');
      assert.equal(reconstructed.verified, false);
      assert.equal(reconstructed.rounds, 2);
    } finally {
      env.cleanup();
    }
  });

  test('defer reconstruction restores a missing durable review-queue entry after commit', async () => {
    const env = setup();
    try {
      env.options.reviewQueuePath = path.join(env.root, 'data', 'review-queue.json');
      const bundleId = `recon-defer-queue-${crypto.randomUUID().slice(0, 8)}`;
      const { reconstructed } = await driveToTerminalAndReconstruct(
        env.options,
        bundleId,
        [
          { decision: 'revise', issues: [{ code: 'too-broad', message: 'Draft is too broad.', severity: 'warning' }] },
          { decision: 'revise', issues: [{ code: 'too-broad', message: 'Still too broad.', severity: 'warning' }] },
        ],
        () => fs.rmSync(env.options.reviewQueuePath!, { force: true }),
      );

      assert.equal(reconstructed.transition, 'defer');
      assert.equal(reconstructed.queued, 'deferred');
      const jobStoreState = loadEvidenceReviewJobStore(
        path.join(env.root, 'data', 'evidence-review-jobs.json'),
      );
      const deferredJob = findDeferredJobByBundleId(jobStoreState, bundleId);
      assert.ok(deferredJob, 'deferred job should exist in the job store');
      assert.equal(deferredJob?.bundle.bundleId, bundleId);
    } finally {
      env.cleanup();
    }
  });

  test('accept happy path reconstructs create_current_skill with verified=true, rounds=1 (backward compat)', async () => {
    const env = setup();
    try {
      const bundleId = `recon-accept-${crypto.randomUUID().slice(0, 8)}`;
      const { firstResult, reconstructed, persistedJob, commitQuantumResult } =
        await driveToTerminalAndReconstruct(env.options, bundleId, [
          { decision: 'accept', transition: 'create_current_skill' },
        ]);

      assert.equal(firstResult.transition, 'create_current_skill');
      assert.equal(firstResult.verified, true);
      assert.equal(firstResult.rounds, 1);
      assert.ok(commitQuantumResult);
      assert.equal(commitQuantumResult!.transition, 'create_current_skill');
      assert.equal(commitQuantumResult!.verified, true);

      assert.equal(persistedJob.verifierResult?.decision, 'accept');
      assert.equal(persistedJob.disposition, 'completed');

      assert.equal(reconstructed.transition, 'create_current_skill');
      assert.equal(reconstructed.verified, true);
      assert.equal(reconstructed.rounds, 1);
    } finally {
      env.cleanup();
    }
  });
});

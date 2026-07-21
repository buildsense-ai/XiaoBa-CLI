/**
 * Bounded two-round Author/Verifier revision loop in the durable Evidence
 * Review Job graph.
 *
 * Regression tests for the revision loop:
 * - Round-1 revise → round-2 Author receives previousDraft/issues → round-2
 *   accept commits once with rounds=2.
 * - Round-1 accept uses one Author/Verifier round only (rounds=1).
 * - Round-1 defer and round-1 reject skip round-2 Author/Verifier entirely.
 * - Exhausted non-danger revise → defer (normalized verifier persisted).
 * - Danger revise → reject (normalized verifier persisted).
 * - Atomicity/restart seam: a crash between verifier completion and graph
 *   expansion must not let the old commit execute on restart.
 * - Crash/restart or reconciliation idempotence at the
 *   verifier-result-to-next-graph-node seam.
 * - Local retry so a round-2 failure does not replay successful readers/round 1.
 * - Stale commit-fence: a live Registry mutation between round 2 and commit
 *   supersedes the old job and creates a successor.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { EvidenceReviewEngine } from '../src/utils/evidence-review-engine';
import type {
  EvidenceReviewJob,
} from '../src/utils/evidence-review-types';
import type {
  EvidenceBundle,
  SkillDraft,
  SkillVerifierResult,
  SkillVerifierIssue,
  SkillEvolutionResult,
} from '../src/utils/skill-evolution';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import { readShardStructurally } from '../src/utils/evidence-review-engine';
import {
  saveEvidenceReviewJobStore,
} from '../src/utils/evidence-review-job-store';
import { recoverJobAfterRestart } from '../src/utils/evidence-review-graph-core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixtureBundle(bundleId = 'revision-loop-test'): EvidenceBundle {
  return {
    bundleId,
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
    ],
  };
}

function fixtureCandidate(): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: 'candidate-revision-test',
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

interface CallTracker {
  authorCalls: Array<{ round: number; previousDraft?: SkillDraft; verifierIssues?: readonly SkillVerifierIssue[] }>;
  verifierCalls: Array<{ round: number }>;
  commitCalls: Array<{ round: number; verifierDecision: string }>;
}

function makeEngineCallbacks(
  tracker: CallTracker,
  verifierPlan: ('revise' | 'accept' | 'defer' | 'reject')[],
  commitResult?: Partial<SkillEvolutionResult>,
) {
  let verifierCallIndex = 0;

  return {
    runReaderLane: ({ shard, lane }: { shard: { shardId: string; contentHash: string; content: string }; lane: 'author' | 'verifier' }) => {
      return Promise.resolve({
        findingSet: readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane),
      });
    },
    runSkillAuthor: (input: {
      bundle: EvidenceBundle;
      job: EvidenceReviewJob;
      previousDraft?: SkillDraft;
      verifierIssues?: readonly SkillVerifierIssue[];
      round: number;
    }) => {
      tracker.authorCalls.push({
        round: input.round,
        previousDraft: input.previousDraft,
        verifierIssues: input.verifierIssues,
      });
      const body = input.round === 1
        ? 'Initial draft that is too broad.'
        : 'Revised draft addressing verifier issues.';
      return Promise.resolve({
        draft: makeDraft(body),
        transcriptPaths: [],
      });
    },
    runSkillVerifier: (input: {
      bundle: EvidenceBundle;
      draft: SkillDraft;
      job: EvidenceReviewJob;
      round: number;
    }) => {
      const decision = verifierPlan[verifierCallIndex] ?? 'accept';
      verifierCallIndex++;
      tracker.verifierCalls.push({ round: input.round });
      const issues: SkillVerifierIssue[] = decision === 'revise'
        ? [{ code: 'too-broad', message: 'Draft is too broad for the evidence.', severity: 'warning' }]
        : [];
      const verifier: SkillVerifierResult = {
        decision,
        issues,
        rationale: decision === 'accept'
          ? 'Draft is acceptable.'
          : decision === 'revise'
            ? 'Draft needs revision.'
            : 'Decision: ' + decision,
      };
      // Build simple dispositions for the obligations
      const dispositions = (input.job.obligations ?? []).map(obl => ({
        obligationId: obl.obligationId,
        decision: 'accepted' as const,
        rationale: 'Test verifier disposition.',
        citedSpans: obl.requiredShardIds.map(sid => ({ shardId: sid, span: { start: 0, end: 1 } })),
      }));
      return Promise.resolve({ verifier, dispositions, transcriptPaths: [] });
    },
    commitTransition: (input: {
      bundle: EvidenceBundle;
      draft: SkillDraft;
      verifier: SkillVerifierResult;
      job: EvidenceReviewJob;
      round: number;
    }) => {
      tracker.commitCalls.push({
        round: input.round,
        verifierDecision: input.verifier.decision,
      });
      const transition = input.verifier.decision === 'accept'
        ? 'create_current_skill'
        : input.verifier.decision === 'defer'
          ? 'defer'
          : 'reject_candidate';
      const result: SkillEvolutionResult = {
        transition: transition as SkillEvolutionResult['transition'],
        verified: input.verifier.decision === 'accept',
        rounds: input.round,
        draft: input.draft,
        verifier: input.verifier,
        ...commitResult,
      };
      return Promise.resolve(result);
    },
  };
}

function setupEngineDir(): { root: string; jobStorePath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-revision-loop-'));
  const jobStorePath = path.join(root, 'data', 'evidence-review-jobs.json');
  fs.mkdirSync(path.dirname(jobStorePath), { recursive: true });
  return {
    root,
    jobStorePath,
    cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function createAndAdvance(
  engine: EvidenceReviewEngine,
  tracker: CallTracker,
  verifierPlan: ('revise' | 'accept' | 'defer' | 'reject')[],
  commitResult?: Partial<SkillEvolutionResult>,
): Promise<{
  job: EvidenceReviewJob;
  result?: SkillEvolutionResult;
  tracker: CallTracker;
}> {
  const callbacks = makeEngineCallbacks(tracker, verifierPlan, commitResult);
  // Monkey-patch the engine options with our callbacks
  (engine as any).options.runReaderLane = callbacks.runReaderLane;
  (engine as any).options.runSkillAuthor = callbacks.runSkillAuthor;
  (engine as any).options.runSkillVerifier = callbacks.runSkillVerifier;
  (engine as any).options.commitTransition = callbacks.commitTransition;

  const bundle = fixtureBundle(`revision-${crypto.randomUUID().slice(0, 8)}`);
  const job = engine.createJob({
    bundle,
    candidate: fixtureCandidate(),
    workClass: 'live_learning',
  });

  return engine.advanceJob(job.jobId, 'wake:test').then(advanced => ({
    job: advanced.job,
    result: advanced.result,
    tracker,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Evidence Review revision loop (durable graph)', () => {

  test('RED: round-1 revise triggers round-2 Author/Verifier before commit', async () => {
    const dir = setupEngineDir();
    try {
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };

      const { result, tracker: t } = await createAndAdvance(engine, tracker, ['revise', 'accept']);

      // The current code does NOT have a revision loop, so:
      // - Author should be called once (round 1 only)
      // - Verifier should be called once (round 1 only)
      // - Commit should receive 'revise' directly
      // After the fix, these should be:
      // - Author called twice (round 1 + round 2)
      // - Verifier called twice (round 1 + round 2)
      // - Commit receives 'accept' with rounds=2
      assert.equal(t.authorCalls.length, 2, 'Author should be called twice (round 1 + round 2)');
      assert.equal(t.verifierCalls.length, 2, 'Verifier should be called twice (round 1 + round 2)');
      assert.equal(t.commitCalls.length, 1, 'Commit should be called once');
      assert.equal(t.commitCalls[0]!.round, 2, 'Commit round should be 2');
      assert.equal(t.commitCalls[0]!.verifierDecision, 'accept', 'Commit should receive accept from round 2');
      assert.equal(result?.rounds, 2, 'Result rounds should be 2');
    } finally {
      dir.cleanup();
    }
  });

  test('round-1 accept uses one Author/Verifier round only (rounds=1)', async () => {
    const dir = setupEngineDir();
    try {
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };

      const { result, tracker: t } = await createAndAdvance(engine, tracker, ['accept']);

      assert.equal(t.authorCalls.length, 1, 'Author should be called once');
      assert.equal(t.verifierCalls.length, 1, 'Verifier should be called once');
      assert.equal(t.commitCalls.length, 1, 'Commit should be called once');
      assert.equal(t.commitCalls[0]!.round, 1, 'Commit round should be 1');
      assert.equal(result?.rounds, 1, 'Result rounds should be 1');
    } finally {
      dir.cleanup();
    }
  });

  test('round-2 Author receives previousDraft and verifierIssues from round 1', async () => {
    const dir = setupEngineDir();
    try {
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };

      const { tracker: t } = await createAndAdvance(engine, tracker, ['revise', 'accept']);

      assert.equal(t.authorCalls.length, 2);
      // Round 1: no previousDraft or verifierIssues
      assert.equal(t.authorCalls[0]!.round, 1);
      assert.equal(t.authorCalls[0]!.previousDraft, undefined);
      assert.equal(t.authorCalls[0]!.verifierIssues, undefined);
      // Round 2: has previousDraft and verifierIssues
      assert.equal(t.authorCalls[1]!.round, 2);
      assert.ok(t.authorCalls[1]!.previousDraft, 'Round-2 Author should receive previousDraft');
      assert.ok(t.authorCalls[1]!.verifierIssues, 'Round-2 Author should receive verifierIssues');
      assert.equal(t.authorCalls[1]!.verifierIssues!.length, 1);
      assert.equal(t.authorCalls[1]!.verifierIssues![0]!.code, 'too-broad');
    } finally {
      dir.cleanup();
    }
  });

  test('exhausted non-danger revise → defer', async () => {
    const dir = setupEngineDir();
    try {
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };

      const { result, tracker: t } = await createAndAdvance(engine, tracker, ['revise', 'revise']);

      assert.equal(t.authorCalls.length, 2, 'Two author rounds');
      assert.equal(t.verifierCalls.length, 2, 'Two verifier rounds');
      assert.equal(t.commitCalls.length, 1, 'One commit call');
      // Exhausted revise with non-danger issues → defer
      assert.equal(t.commitCalls[0]!.verifierDecision, 'defer',
        'Exhausted non-danger revise should become defer at commit');
      assert.equal(result?.transition, 'defer');
      assert.equal(result?.rounds, 2);
    } finally {
      dir.cleanup();
    }
  });

  test('danger revise → reject', async () => {
    const dir = setupEngineDir();
    try {
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };

      // Custom verifier plan: round 1 returns revise with non-danger, round 2 returns revise with danger
      const callbacks = makeEngineCallbacks(tracker, ['revise', 'revise']);
      let verifierCallIndex = 0;
      const originalRunSkillVerifier = callbacks.runSkillVerifier;
      (engine as any).options.runReaderLane = callbacks.runReaderLane;
      (engine as any).options.runSkillAuthor = callbacks.runSkillAuthor;
      (engine as any).options.runSkillVerifier = (input: any) => {
        const round = input.round;
        const decision = 'revise';
        verifierCallIndex++;
        tracker.verifierCalls.push({ round });
        const issues: SkillVerifierIssue[] = round === 2
          ? [{ code: 'dangerous', message: 'Dangerous content detected.', severity: 'danger' }]
          : [{ code: 'too-broad', message: 'Draft is too broad.', severity: 'warning' }];
        const verifier: SkillVerifierResult = {
          decision,
          issues,
          rationale: 'Needs revision.',
        };
        const dispositions = (input.job.obligations ?? []).map((obl: any) => ({
          obligationId: obl.obligationId,
          decision: 'accepted' as const,
          rationale: 'Test verifier disposition.',
          citedSpans: obl.requiredShardIds.map((sid: string) => ({ shardId: sid, span: { start: 0, end: 1 } })),
        }));
        return Promise.resolve({ verifier, dispositions, transcriptPaths: [] });
      };
      (engine as any).options.commitTransition = callbacks.commitTransition;

      const bundle = fixtureBundle(`danger-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      const advanced = await engine.advanceJob(job.jobId, 'wake:test');

      assert.equal(tracker.commitCalls.length, 1);
      assert.equal(tracker.commitCalls[0]!.verifierDecision, 'reject',
        'Exhausted danger revise should become reject at commit');
      assert.equal(advanced.result?.transition, 'reject_candidate');
      assert.equal(advanced.result?.rounds, 2);
    } finally {
      dir.cleanup();
    }
  });

  test('crash/restart idempotence: round-2 nodes survive restart', async () => {
    const dir = setupEngineDir();
    try {
      // Phase 1: Advance until round-1 verifier completes with revise
      let tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const callbacks = makeEngineCallbacks(tracker, ['revise', 'accept']);

      // Create engine with callbacks that stop after skill_verifier round 1
      const engine1 = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      (engine1 as any).options.runReaderLane = callbacks.runReaderLane;
      (engine1 as any).options.runSkillAuthor = callbacks.runSkillAuthor;
      // Stop after round-1 verifier by making round-2 author throw a terminal error
      let authorCallCount = 0;
      const originalAuthor = callbacks.runSkillAuthor;
      (engine1 as any).options.runSkillAuthor = (input: any) => {
        authorCallCount++;
        if (input.round === 2) {
          // Simulate crash — throw a terminal error to stop the advance loop
          throw new Error('SIMULATED_CRASH: terminal integrity failure');
        }
        return originalAuthor(input);
      };
      (engine1 as any).options.runSkillVerifier = callbacks.runSkillVerifier;
      (engine1 as any).options.commitTransition = callbacks.commitTransition;

      const bundle = fixtureBundle(`crash-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine1.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      // Advance — will crash when round-2 author runs
      await engine1.advanceJob(job.jobId, 'wake:1');

      // Verify round-1 quanta succeeded and round-2 author is terminal_failed
      const state1 = engine1.loadStore();
      const job1 = state1.jobs[job.jobId]!;
      const succeededQuanta = Object.values(job1.quanta).filter(q => q.state === 'succeeded');
      const readers = succeededQuanta.filter(q => q.kind === 'author_reader' || q.kind === 'verifier_reader');
      const round1Author = succeededQuanta.find(q => q.kind === 'skill_author');
      const round1Verifier = succeededQuanta.find(q => q.kind === 'skill_verifier');
      assert.ok(readers.length > 0, 'Readers should have succeeded');
      assert.ok(round1Author, 'Round-1 author should have succeeded');
      assert.ok(round1Verifier, 'Round-1 verifier should have succeeded');

      // The round-2 author should exist (in terminal_failed state after crash)
      const skillAuthors = Object.values(job1.quanta).filter(q => q.kind === 'skill_author');
      assert.equal(skillAuthors.length, 2, 'Should have 2 skill_author quanta (round 1 + round 2)');

      // The old commit should be gone, replaced by a new one
      const commits = Object.values(job1.quanta).filter(q => q.kind === 'commit');
      assert.equal(commits.length, 1, 'Should have exactly 1 commit quantum');
      // Phase 2: Restart — create a new engine and continue
      // Reset the terminal_failed round-2 author to pending so it can run
      tracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const callbacks2 = makeEngineCallbacks(tracker, ['revise', 'accept']);
      const engine2 = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      (engine2 as any).options.runReaderLane = callbacks2.runReaderLane;
      (engine2 as any).options.runSkillAuthor = callbacks2.runSkillAuthor;
      (engine2 as any).options.runSkillVerifier = callbacks2.runSkillVerifier;
      (engine2 as any).options.commitTransition = callbacks2.commitTransition;

      // Recover job after restart and reset terminal_failed to pending
      const state2 = engine2.loadStore();
      const job2 = state2.jobs[job.jobId]!;
      recoverJobAfterRestart(job2 as any, new Date());

      // Reset the terminal_failed round-2 author to pending (simulating operator recovery)
      for (const q of Object.values(job2.quanta)) {
        if (q.kind === 'skill_author' && q.state === 'terminal_failed') {
          job2.quanta[q.quantumId] = {
            ...q,
            state: 'pending',
            attempts: 0,
            currentDelayMs: 0,
            nextRetryAt: undefined,
            lease: undefined,
            failureMessage: undefined,
            updatedAt: new Date().toISOString(),
          };
        }
      }
      saveEvidenceReviewJobStore(dir.jobStorePath, state2);

      const advanced = await engine2.advanceJob(job.jobId, 'wake:2');

      // Round-1 quanta should NOT replay
      assert.equal(tracker.authorCalls.length, 1, 'Only round-2 author should run after restart');
      assert.equal(tracker.authorCalls[0]!.round, 2, 'It should be round 2');
      assert.equal(tracker.verifierCalls.length, 1, 'Only round-2 verifier should run');
      assert.equal(tracker.verifierCalls[0]!.round, 2);
      assert.equal(tracker.commitCalls.length, 1);
      assert.equal(tracker.commitCalls[0]!.round, 2);
      assert.equal(advanced.result?.rounds, 2);
    } finally {
      dir.cleanup();
    }
  });

  test('local retry: round-2 failure does not replay successful readers/round 1', async () => {
    const dir = setupEngineDir();
    try {
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const callbacks = makeEngineCallbacks(tracker, ['revise', 'accept']);

      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
        retryBaseMs: 5000, // Long delay so first advance stops after failure
        retryMaxMs: 10000,
      });
      (engine as any).options.runReaderLane = callbacks.runReaderLane;

      let authorCallCount = 0;
      (engine as any).options.runSkillAuthor = (input: any) => {
        authorCallCount++;
        tracker.authorCalls.push({
          round: input.round,
          previousDraft: input.previousDraft,
          verifierIssues: input.verifierIssues,
        });
        if (input.round === 2 && authorCallCount === 2) {
          // Fail the first attempt of round-2 author
          throw new Error('TRANSIENT_FAILURE');
        }
        const body = input.round === 1
          ? 'Initial draft that is too broad.'
          : 'Revised draft addressing verifier issues.';
        return Promise.resolve({ draft: makeDraft(body), transcriptPaths: [] });
      };
      (engine as any).options.runSkillVerifier = callbacks.runSkillVerifier;
      (engine as any).options.commitTransition = callbacks.commitTransition;

      const bundle = fixtureBundle(`retry-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      // First advance: round-1 completes, round-2 author fails
      const firstAdvance = await engine.advanceJob(job.jobId, 'wake:1');
      // The round-2 author should be in retry_wait
      const state1 = engine.loadStore();
      const job1 = state1.jobs[job.jobId]!;
      const round2Author = Object.values(job1.quanta)
        .filter(q => q.kind === 'skill_author' && q.state === 'retry_wait');
      assert.ok(round2Author.length > 0, 'Round-2 author should be in retry_wait after failure');

      // Readers and round-1 should still be succeeded (not replayed)
      const readers = Object.values(job1.quanta)
        .filter(q => (q.kind === 'author_reader' || q.kind === 'verifier_reader') && q.state === 'succeeded');
      assert.ok(readers.length > 0, 'Readers should remain succeeded');
      const round1Author = Object.values(job1.quanta)
        .filter(q => q.kind === 'skill_author' && q.state === 'succeeded');
      assert.ok(round1Author.length === 1, 'Round-1 author should remain succeeded');

      // Second advance: manually reset retry_wait to pending (simulating retry deadline elapse)
      const state2 = engine.loadStore();
      const job2 = state2.jobs[job.jobId]!;
      for (const q of Object.values(job2.quanta)) {
        if (q.kind === 'skill_author' && q.state === 'retry_wait') {
          job2.quanta[q.quantumId] = {
            ...q,
            state: 'pending',
            nextRetryAt: undefined,
            lease: undefined,
            updatedAt: new Date().toISOString(),
          };
        }
      }
      saveEvidenceReviewJobStore(dir.jobStorePath, state2);
      const secondAdvance = await engine.advanceJob(job.jobId, 'wake:2');

      // Verify only round-2 author/verifier ran in the retry
      // Total author calls: 1 (round 1) + 1 (round 2 failed) + 1 (round 2 retry) = 3
      assert.equal(tracker.authorCalls.length, 3, 'Author called 3 times total (1 round-1 + 2 round-2 attempts)');
      assert.equal(tracker.authorCalls[2]!.round, 2, 'Retry should be round 2');
      assert.equal(tracker.verifierCalls.length, 2, 'Verifier called twice (round 1 + round 2)');
      assert.equal(tracker.commitCalls.length, 1);
      assert.equal(secondAdvance.result?.rounds, 2);
    } finally {
      dir.cleanup();
    }
  });

  test('RED: atomicity seam — persisted round-1 revise with old commit pending must expand and not commit round 1 on restart', async () => {
    const dir = setupEngineDir();
    try {
      // Phase 1: Create a job and capture the original quantum IDs (round-1 graph).
      let tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const callbacks = makeEngineCallbacks(tracker, ['revise', 'accept']);

      const engine1 = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      (engine1 as any).options.runReaderLane = callbacks.runReaderLane;
      (engine1 as any).options.runSkillAuthor = callbacks.runSkillAuthor;
      (engine1 as any).options.runSkillVerifier = callbacks.runSkillVerifier;
      (engine1 as any).options.commitTransition = callbacks.commitTransition;

      const bundle = fixtureBundle(`seam-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine1.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      // Capture the original round-1 quantum IDs before any advance.
      const originalQuantumIds = new Set(Object.keys(job.quanta));

      // Advance fully — round-1 revise → round-2 → accept → commit.
      await engine1.advanceJob(job.jobId, 'wake:1');

      // Now manually reconstruct the SEAM state: the exact persisted state a
      // crash between the verifier-completion save and the expansion save
      // would leave on disk.
      //
      // Seam state: round-1 verifier succeeded with 'revise', original commit
      // still pending (depending on round-1 verifier), no round-2 nodes,
      // revisionRound = undefined.
      const seamState = engine1.loadStore();
      const seamJob = seamState.jobs[job.jobId]!;

      // Remove ALL round-2 quanta (anything not in the original graph).
      for (const qId of Object.keys(seamJob.quanta)) {
        if (!originalQuantumIds.has(qId)) {
          delete seamJob.quanta[qId];
        }
      }

      // Restore the original commit quantum to pending (it was removed during
      // expansion). Re-add it depending on the round-1 verifier.
      const { createReviewQuantum } = await import('../src/utils/evidence-review-graph-core');
      const round1Verifier = Object.values(seamJob.quanta).find(
        q => q.kind === 'skill_verifier' && q.state === 'succeeded',
      )!;
      const oldCommit = createReviewQuantum(seamJob.jobId, {
        kind: 'commit',
        inputs: {
          basisHash: seamJob.basis.basisHash,
          skillVerifier: round1Verifier.quantumId,
        },
        dependencyQuantumIds: [round1Verifier.quantumId],
      });
      seamJob.quanta[oldCommit.quantumId] = oldCommit;

      // Clear expansion markers to simulate pre-expansion persisted state.
      seamJob.revisionRound = undefined;
      seamJob.previousDraft = undefined;
      seamJob.round1VerifierIssues = undefined;
      seamJob.disposition = 'active';
      seamJob.updatedAt = new Date().toISOString();
      saveEvidenceReviewJobStore(dir.jobStorePath, seamState);

      // Phase 2: Restart with a fresh engine. The reconciliation must expand
      // the graph before any runnable selection so the old commit never runs.
      tracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const callbacks2 = makeEngineCallbacks(tracker, ['accept']);
      const engine2 = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      (engine2 as any).options.runReaderLane = callbacks2.runReaderLane;
      (engine2 as any).options.runSkillAuthor = callbacks2.runSkillAuthor;
      (engine2 as any).options.runSkillVerifier = callbacks2.runSkillVerifier;
      (engine2 as any).options.commitTransition = callbacks2.commitTransition;

      const advanced = await engine2.advanceJob(job.jobId, 'wake:2');

      // The old commit must NOT have executed — commit should only run after
      // round-2 expansion with round=2.
      assert.equal(tracker.commitCalls.length, 1, 'Commit should be called once');
      assert.equal(tracker.commitCalls[0]!.round, 2,
        'Commit must be round 2 after reconciliation expansion, not round 1');
      assert.equal(tracker.commitCalls[0]!.verifierDecision, 'accept');

      // Round-1 quanta should NOT replay.
      assert.equal(tracker.authorCalls.length, 1, 'Only round-2 author should run');
      assert.equal(tracker.authorCalls[0]!.round, 2);
      assert.equal(tracker.verifierCalls.length, 1, 'Only round-2 verifier should run');
      assert.equal(tracker.verifierCalls[0]!.round, 2);

      // The job should have completed with rounds=2.
      assert.equal(advanced.result?.rounds, 2);
      assert.equal(advanced.job.disposition, 'completed');
    } finally {
      dir.cleanup();
    }
  });

  test('RED: normalized verifier persistence — exhausted non-danger revise persists defer, not revise, on reload', async () => {
    const dir = setupEngineDir();
    try {
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const callbacks = makeEngineCallbacks(tracker, ['revise', 'revise']);
      (engine as any).options.runReaderLane = callbacks.runReaderLane;
      (engine as any).options.runSkillAuthor = callbacks.runSkillAuthor;
      (engine as any).options.runSkillVerifier = callbacks.runSkillVerifier;
      (engine as any).options.commitTransition = callbacks.commitTransition;

      const bundle = fixtureBundle(`norm-defer-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      const advanced = await engine.advanceJob(job.jobId, 'wake:test');

      // The commit callback received 'defer' (normalized from revise).
      assert.equal(tracker.commitCalls[0]!.verifierDecision, 'defer');
      assert.equal(advanced.result?.transition, 'defer');

      // Reload the job from the store and verify the persisted verifierResult
      // is the NORMALIZED 'defer', not the original 'revise'.
      const reloaded = engine.loadStore().jobs[job.jobId]!;
      assert.ok(reloaded.verifierResult, 'Job should have persisted verifierResult');
      assert.equal(reloaded.verifierResult!.decision, 'defer',
        'Persisted verifierResult must be normalized to defer, not revise');
      assert.equal(reloaded.verifierResult!.transition, undefined);

      // Reconstruct through the public SkillEvolution result seam: a deferred
      // job should reconstruct to defer + verified=false.
      const reconstructedTransition = reloaded.disposition === 'deferred'
        ? 'defer'
        : (reloaded.verifierResult!.transition ?? reloaded.draft?.envelope.decision);
      assert.equal(reconstructedTransition, 'defer');
      assert.equal(reloaded.disposition, 'deferred');
    } finally {
      dir.cleanup();
    }
  });

  test('RED: normalized verifier persistence — exhausted danger revise persists reject, not revise, on reload', async () => {
    const dir = setupEngineDir();
    try {
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };

      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      (engine as any).options.runReaderLane = makeEngineCallbacks(tracker, []).runReaderLane;
      (engine as any).options.runSkillAuthor = makeEngineCallbacks(tracker, []).runSkillAuthor;

      // Round 1: revise with warning, round 2: revise with danger.
      let verifierCallIndex = 0;
      (engine as any).options.runSkillVerifier = (input: any) => {
        verifierCallIndex++;
        tracker.verifierCalls.push({ round: input.round });
        const issues = input.round === 2
          ? [{ code: 'dangerous', message: 'Dangerous content.', severity: 'danger' as const }]
          : [{ code: 'too-broad', message: 'Too broad.', severity: 'warning' as const }];
        const verifier: SkillVerifierResult = {
          decision: 'revise',
          issues,
          rationale: 'Needs revision.',
        };
        const dispositions = (input.job.obligations ?? []).map((obl: any) => ({
          obligationId: obl.obligationId,
          decision: 'accepted' as const,
          rationale: 'Test.',
          citedSpans: obl.requiredShardIds.map((sid: string) => ({ shardId: sid, span: { start: 0, end: 1 } })),
        }));
        return Promise.resolve({ verifier, dispositions, transcriptPaths: [] });
      };
      const commitCallbacks = makeEngineCallbacks(tracker, []);
      (engine as any).options.commitTransition = commitCallbacks.commitTransition;

      const bundle = fixtureBundle(`norm-reject-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      const advanced = await engine.advanceJob(job.jobId, 'wake:test');

      assert.equal(tracker.commitCalls[0]!.verifierDecision, 'reject');
      assert.equal(advanced.result?.transition, 'reject_candidate');

      // Reload and verify persisted verifierResult is normalized to 'reject'.
      const reloaded = engine.loadStore().jobs[job.jobId]!;
      assert.ok(reloaded.verifierResult, 'Job should have persisted verifierResult');
      assert.equal(reloaded.verifierResult!.decision, 'reject',
        'Persisted verifierResult must be normalized to reject, not revise');

      // Reconstruct through the public result seam.
      const reconstructedTransition = reloaded.verifierResult!.transition ?? 'reject_candidate';
      assert.equal(reconstructedTransition, 'reject_candidate');
      assert.equal(advanced.result?.verified, false);
    } finally {
      dir.cleanup();
    }
  });

  test('RED: first-round defer skips round-2 Author/Verifier entirely', async () => {
    const dir = setupEngineDir();
    try {
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const callbacks = makeEngineCallbacks(tracker, ['defer']);
      (engine as any).options.runReaderLane = callbacks.runReaderLane;
      (engine as any).options.runSkillAuthor = callbacks.runSkillAuthor;
      (engine as any).options.runSkillVerifier = callbacks.runSkillVerifier;
      (engine as any).options.commitTransition = callbacks.commitTransition;

      const bundle = fixtureBundle(`defer-r1-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      const advanced = await engine.advanceJob(job.jobId, 'wake:test');

      // No round-2 expansion — one Author, one Verifier, one commit.
      assert.equal(tracker.authorCalls.length, 1, 'Author should be called once (no round 2)');
      assert.equal(tracker.verifierCalls.length, 1, 'Verifier should be called once (no round 2)');
      assert.equal(tracker.commitCalls.length, 1, 'Commit should be called once');
      assert.equal(tracker.commitCalls[0]!.round, 1, 'Commit round should be 1');
      assert.equal(tracker.commitCalls[0]!.verifierDecision, 'defer');
      assert.equal(advanced.result?.transition, 'defer');
      assert.equal(advanced.result?.rounds, 1);
    } finally {
      dir.cleanup();
    }
  });

  test('RED: first-round reject skips round-2 Author/Verifier entirely', async () => {
    const dir = setupEngineDir();
    try {
      const tracker: CallTracker = { authorCalls: [], verifierCalls: [], commitCalls: [] };
      const engine = new EvidenceReviewEngine({
        jobStorePath: dir.jobStorePath,
        workingDirectory: dir.root,
      });
      const callbacks = makeEngineCallbacks(tracker, ['reject']);
      (engine as any).options.runReaderLane = callbacks.runReaderLane;
      (engine as any).options.runSkillAuthor = callbacks.runSkillAuthor;
      (engine as any).options.runSkillVerifier = callbacks.runSkillVerifier;
      (engine as any).options.commitTransition = callbacks.commitTransition;

      const bundle = fixtureBundle(`reject-r1-${crypto.randomUUID().slice(0, 8)}`);
      const job = engine.createJob({
        bundle,
        candidate: fixtureCandidate(),
        workClass: 'live_learning',
      });

      const advanced = await engine.advanceJob(job.jobId, 'wake:test');

      assert.equal(tracker.authorCalls.length, 1, 'Author should be called once (no round 2)');
      assert.equal(tracker.verifierCalls.length, 1, 'Verifier should be called once (no round 2)');
      assert.equal(tracker.commitCalls.length, 1, 'Commit should be called once');
      assert.equal(tracker.commitCalls[0]!.round, 1, 'Commit round should be 1');
      assert.equal(tracker.commitCalls[0]!.verifierDecision, 'reject');
      assert.equal(advanced.result?.transition, 'reject_candidate');
      assert.equal(advanced.result?.rounds, 1);
    } finally {
      dir.cleanup();
    }
  });
});
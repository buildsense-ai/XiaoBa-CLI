import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  type EvidenceReviewJob,
  type EvidenceReviewJobStoreState,
} from '../src/utils/evidence-review-types';
import { createEvidenceReviewJob } from '../src/utils/evidence-review-graph';
import {
  projectSkillCandidateLifecycle,
} from '../src/utils/skill-candidate-lifecycle';
import {
  SKILL_EVOLUTION_SCHEMA_VERSION,
  type CapabilityTransitionKind,
  type EvidenceBundle,
  type TransitionAuditEntry,
} from '../src/utils/skill-evolution';

const NOW = '2026-08-14T00:00:00.000Z';

function candidate(id: string): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: id,
    title: `Candidate ${id}`,
    applicability: 'Use only for the bounded test workflow.',
    actionPattern: 'Apply the bounded workflow.',
    boundaries: ['Use only cited evidence.'],
    risks: ['Do not extend the workflow beyond the evidence.'],
    solvedLoop: {
      problem: 'A bounded task was requested.',
      action: 'Applied the bounded workflow.',
      verification: 'The result was verified.',
      noCorrection: 'No correction followed.',
    },
    provenance: [
      { filePath: 'session.jsonl', turn: 1, role: 'problem-action', unitByteRange: { start: 0, end: 1 } },
      { filePath: 'session.jsonl', turn: 2, role: 'verification', unitByteRange: { start: 1, end: 2 } },
    ],
    generatedAt: NOW,
    sourceUnit: {
      filePath: 'session.jsonl',
      byteRange: { start: 0, end: 2 },
      generatedAt: NOW,
    },
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

function job(id: string): EvidenceReviewJob {
  const evidenceBundle = bundle(id);
  return createEvidenceReviewJob({
    bundle: evidenceBundle,
    candidate: evidenceBundle.episode as DistilledKnowledgeCandidate,
    workClass: 'live_learning',
    now: new Date(NOW),
  });
}

function completeJob(
  job: EvidenceReviewJob,
  transition: CapabilityTransitionKind,
  transitionId = `transition:${job.bundle.bundleId}`,
): TransitionAuditEntry | undefined {
  const commit = Object.values(job.quanta).find(quantum => quantum.kind === 'commit')!;
  const commitKey = `${job.jobId}:${commit.quantumId}`;
  commit.state = 'succeeded';
  commit.commitIntent = { key: commitKey, preparedAt: NOW };
  commit.result = { transition, transitionId };
  job.disposition = 'completed';
  job.transitionId = transitionId;
  if (transition === 'defer' || transition === 'reject_candidate') return undefined;
  return {
    schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
    transitionId,
    transition,
    bundleId: job.bundle.bundleId,
    reviewCommitKey: commitKey,
    occurredAt: NOW,
    reviewerVersion: 'test-reviewer',
    promptVersion: 'test-prompt',
    evidenceRefs: [],
    involvedCapabilityHandles: [],
    registryReadSet: [],
    priorGuidanceHash: null,
    resultingGuidanceHash: null,
    branchTranscriptPaths: [],
    rationale: 'The durable audit confirms the transition.',
  };
}

function store(jobs: readonly EvidenceReviewJob[]): EvidenceReviewJobStoreState {
  return {
    schemaVersion: EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
    jobs: Object.fromEntries(jobs.map(item => [item.jobId, item])),
    fairness: {
      nextWorkClass: 'operational_recovery',
      classCursors: {},
      jobCursors: {},
    },
  };
}

describe('Skill candidate lifecycle projection', () => {
  test('derives every lifecycle stage from the durable job graph and audit', () => {
    const admitted = job('admitted');

    const reviewing = job('reviewing');
    const reviewingRoot = Object.values(reviewing.quanta)
      .find(quantum => quantum.dependencyQuantumIds.length === 0)!;
    reviewingRoot.state = 'leased';
    reviewingRoot.attempts = 1;
    reviewingRoot.lease = {
      leaseId: 'lease-reviewing',
      ownerWakeId: 'wake-reviewing',
      leasedAt: NOW,
      expiresAt: '2026-08-14T00:01:00.000Z',
    };

    const retryWaiting = job('retry-waiting');
    const retryRoot = Object.values(retryWaiting.quanta)
      .find(quantum => quantum.dependencyQuantumIds.length === 0)!;
    retryRoot.state = 'retry_wait';
    retryRoot.attempts = 1;
    retryRoot.nextRetryAt = '2026-08-14T00:05:00.000Z';

    const deferred = job('deferred');
    deferred.disposition = 'deferred';

    const applied = job('applied');
    const appliedAudit = completeJob(applied, 'create_current_skill');

    const rejected = job('rejected');
    completeJob(rejected, 'reject_candidate');

    const superseded = job('superseded');
    superseded.disposition = 'superseded';
    superseded.successorJobId = 'successor-job';

    const failed = job('failed');
    failed.disposition = 'terminal_failed';

    const snapshot = projectSkillCandidateLifecycle(
      store([admitted, reviewing, retryWaiting, deferred, applied, rejected, superseded, failed]),
      appliedAudit ? [appliedAudit] : [],
    );

    assert.equal(snapshot.status, 'healthy');
    assert.deepEqual(
      Object.fromEntries(snapshot.candidates.map(candidate => [candidate.bundleId, candidate.stage])),
      {
        admitted: 'admitted',
        reviewing: 'reviewing',
        'retry-waiting': 'retry_wait',
        deferred: 'deferred',
        applied: 'applied',
        rejected: 'rejected',
        superseded: 'superseded',
        failed: 'failed',
      },
    );
    assert.deepEqual(snapshot.summary, {
      status: 'healthy',
      total: 8,
      admitted: 1,
      reviewing: 1,
      retryWaiting: 1,
      deferred: 1,
      applied: 1,
      rejected: 1,
      superseded: 1,
      failed: 1,
    });
  });

  test('does not infer an applied Skill when a completed mutation lacks its audit receipt', () => {
    const missingAudit = job('missing-audit');
    completeJob(missingAudit, 'create_current_skill');

    const snapshot = projectSkillCandidateLifecycle(store([missingAudit]), []);

    assert.equal(snapshot.status, 'healthy');
    assert.equal(snapshot.candidates[0]?.stage, 'failed');
    assert.equal(snapshot.summary.applied, 0);
    assert.equal(snapshot.summary.failed, 1);
  });

  test('keeps an active Job reviewing when a local terminal quantum leaves independent work', () => {
    const partiallyFailed = job('local-terminal-failure');
    const failedRoot = Object.values(partiallyFailed.quanta)
      .find(quantum => quantum.dependencyQuantumIds.length === 0)!;
    failedRoot.state = 'terminal_failed';
    failedRoot.attempts = 5;

    const snapshot = projectSkillCandidateLifecycle(store([partiallyFailed]), []);

    assert.equal(snapshot.status, 'healthy');
    assert.equal(snapshot.candidates[0]?.stage, 'reviewing');
    assert.equal(snapshot.summary.reviewing, 1);
    assert.equal(snapshot.summary.failed, 0);
  });

  test('does not project candidates from a corruption-latched store', () => {
    const corrupted = store([job('ignored-after-corruption')]);
    corrupted.stateCorrupt = true;

    const snapshot = projectSkillCandidateLifecycle(corrupted, []);

    assert.equal(snapshot.status, 'corrupt');
    assert.deepEqual(snapshot.candidates, []);
    assert.equal(snapshot.summary.reason, 'evidence-review-job-store-corrupt');
  });
});

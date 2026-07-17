/**
 * Production-path tests for #104/#110 Evidence Review compatibility migration.
 *
 * Uses real filesystem review-queue + job-store state and the public
 * RuntimeLearning.wake / SkillEvolution ensure seam — not pure helpers alone.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RuntimeLearning } from '../src/utils/runtime-learning';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { DueWorkPlanner } from '../src/utils/due-work-planner';
import {
  SkillEvolutionRuntime,
  type EvidenceBundle,
} from '../src/utils/skill-evolution';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import {
  loadEvidenceReviewJobStore,
  evidenceReviewJobStorePathForReviewQueue,
} from '../src/utils/evidence-review-job-store';
import {
  EVIDENCE_REVIEW_MIGRATION_MARKER,
  materializeLegacyReviewRecordsAsJobs,
} from '../src/utils/evidence-review-compatibility';
import { planFairQuantumClaims } from '../src/utils/evidence-review-scheduler';
import {
  emptyReviewQueueState,
  saveReviewQueueState,
  type SkillEvolutionOperationalReviewFailureEntry,
} from '../src/utils/skill-evolution-review-queue';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';

interface TestEnv {
  root: string;
  reviewQueuePath: string;
  jobStorePath: string;
  promptBudgetBlockedPath: string;
  runtimeLearning: RuntimeLearning;
  skillEvolution: SkillEvolutionRuntime;
  teardown: () => void;
}

const FIXED_NOW = new Date('2026-07-17T06:00:00.000Z');

function candidate(capabilityId: string): DistilledKnowledgeCandidate {
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
    provenance: [{
      filePath: `${capabilityId}.jsonl`,
      turn: 1,
      role: 'problem-action',
      unitByteRange: { start: 0, end: 10 },
    }],
    generatedAt: FIXED_NOW.toISOString(),
    sourceUnit: {
      filePath: `${capabilityId}.jsonl`,
      byteRange: { start: 0, end: 10 },
      generatedAt: FIXED_NOW.toISOString(),
    },
  };
}

function bundle(bundleId: string, capabilityId: string): EvidenceBundle {
  const cand = candidate(capabilityId);
  return {
    bundleId,
    episode: cand,
    completionEvidence: [{
      ref: `${capabilityId}.jsonl#1`,
      sourceFilePath: `${capabilityId}.jsonl`,
      turn: 1,
      kind: 'artifact-delivery',
      detail: 'delivered',
    }],
    settlementEvidence: [],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [{
      kind: 'user-intent',
      value: `intent-${capabilityId}`,
      sourceRefs: [`${capabilityId}.jsonl#intent`],
    }],
  };
}

function operationalEntry(
  overrides: Partial<SkillEvolutionOperationalReviewFailureEntry> = {},
): SkillEvolutionOperationalReviewFailureEntry {
  const cand = candidate('cap-op-prod');
  const b = bundle('bundle-op-prod', 'cap-op-prod');
  return {
    entryId: 'op_entry_prod_1',
    candidateCapabilityId: cand.capabilityId,
    bundleId: b.bundleId,
    bundle: b,
    candidate: cand,
    failureKind: 'branch_timeout',
    failureMessage: 'Author branch timed out at Review Deadline',
    failureTranscripts: [
      '/tmp/xiaoba/transcripts/author-prod-1.jsonl',
      '/tmp/xiaoba/transcripts/verifier-prod-1.jsonl',
    ],
    attempts: 3,
    currentDelayMs: 480_000,
    nextRetryAt: '2026-07-17T07:00:00.000Z',
    createdAt: '2026-07-17T01:00:00.000Z',
    updatedAt: '2026-07-17T03:00:00.000Z',
    ...overrides,
  };
}

function promptBudgetBlockedRecord() {
  const cand = candidate('cap-pbb-prod');
  const b = bundle('bundle-pbb-prod', 'cap-pbb-prod');
  return {
    entryId: 'pbb_entry_prod_1',
    candidateCapabilityId: cand.capabilityId,
    bundleId: b.bundleId,
    bundle: b,
    candidate: cand,
    estimatedPromptTokens: 19_200,
    maxPromptTokens: 8_000,
    blockedReason: 'estimated evidence bundle exceeded maxPromptTokens',
    blockedAt: '2026-06-01T12:00:00.000Z',
    failureTranscripts: ['/tmp/xiaoba/transcripts/admission-block-prod-1.jsonl'],
    attempts: 1,
    provenance: cand.provenance,
    evidenceFingerprint: 'fp-evidence-pbb-prod',
    reviewerVersion: 'promotion-reviewer-v2',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
  };
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-evidence-review-prod-mig-'));
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const reviewQueuePath = path.join(root, 'data', 'skill-evolution-review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const reassessmentManifestPath = path.join(root, 'data', 'reassessment-manifest.json');
  const jobStorePath = evidenceReviewJobStorePathForReviewQueue(reviewQueuePath);
  const promptBudgetBlockedPath = path.join(root, 'data', 'prompt-budget-blocked.json');

  fs.mkdirSync(path.dirname(reviewQueuePath), { recursive: true });

  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: root,
    outputDir,
    registryPath,
    auditPath,
    journalPath,
    reviewQueuePath,
    settlementWindowMs: 0,
    operationalRetryMs: 1,
    operationalRetryMaxMs: 60_000,
    logEnabled: false,
    authorFixture: () => {
      throw new Error('author should not run during migration-only wake');
    },
    verifierFixture: () => {
      throw new Error('verifier should not run during migration-only wake');
    },
  });

  const episodeStore = new LearningEpisodeStore(episodeStorePath);
  const planner = new DueWorkPlanner({
    learningEpisodeStorePath: episodeStorePath,
    reviewQueuePath,
    curatorStatePath: path.join(root, 'data', 'curator-state.json'),
    curatorIntervalMs: 24 * 60 * 60 * 1000,
    semanticReassessmentManifestPath: reassessmentManifestPath,
  });
  const evidenceIngestor = new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 });
  const runtimeLearning = new RuntimeLearning({
    workingDirectory: root,
    evidenceIngestor,
    learningEpisodeStore: episodeStore,
    skillEvolution,
    curator: null,
    planner,
    sessionLogSources: [],
    clock: () => FIXED_NOW,
  });

  return {
    root,
    reviewQueuePath,
    jobStorePath,
    promptBudgetBlockedPath,
    runtimeLearning,
    skillEvolution,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeLegacyQueue(env: TestEnv, operational: SkillEvolutionOperationalReviewFailureEntry[]): void {
  const state = emptyReviewQueueState();
  state.operational = operational;
  saveReviewQueueState(env.reviewQueuePath, state);
}

function writePromptBudgetBlocked(env: TestEnv, records: unknown[]): void {
  fs.writeFileSync(env.promptBudgetBlockedPath, JSON.stringify(records, null, 2), 'utf8');
}

describe('Evidence Review production migration (#104/#110)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    env.teardown();
  });

  test('filesystem materializer creates durable jobs preserving evidence/attempts/backoff/transcripts', () => {
    const op = operationalEntry();
    writeLegacyQueue(env, [op]);
    writePromptBudgetBlocked(env, [promptBudgetBlockedRecord()]);

    const first = materializeLegacyReviewRecordsAsJobs({
      reviewQueuePath: env.reviewQueuePath,
      jobStorePath: env.jobStorePath,
      promptBudgetBlockedPath: env.promptBudgetBlockedPath,
      now: FIXED_NOW,
    });

    assert.equal(first.scanned, 2);
    assert.equal(first.materialized, 2);
    assert.equal(first.alreadyPresent, 0);
    assert.equal(first.quarantined, 0);
    assert.equal(first.jobIds.length, 2);

    const store = loadEvidenceReviewJobStore(env.jobStorePath);
    const opJob = store.jobs['job:migrated:op:op_entry_prod_1'];
    const pbbJob = store.jobs['job:migrated:pbb:pbb_entry_prod_1'];
    assert.ok(opJob, 'operational retry job materializes');
    assert.ok(pbbJob, 'prompt-budget-blocked job materializes');

    assert.equal(opJob.disposition, 'active');
    assert.equal(opJob.workClass, 'operational_recovery');
    assert.equal(opJob.bundle.bundleId, op.bundleId);
    assert.equal(opJob.candidate.capabilityId, op.candidateCapabilityId);
    assert.equal(opJob.nextDueAt, op.nextRetryAt);
    assert.equal(opJob.domain?.migrationMarker, EVIDENCE_REVIEW_MIGRATION_MARKER);
    assert.equal(opJob.domain?.sourceEntryId, op.entryId);
    assert.equal(opJob.domain?.attempts, 3);
    assert.equal(opJob.domain?.currentDelayMs, 480_000);
    assert.deepEqual(opJob.domain?.transcriptPaths, op.failureTranscripts);

    const authorReader = Object.values(opJob.quanta).find(q => q.kind === 'author_reader');
    assert.ok(authorReader);
    assert.equal(authorReader.attempts, 3);
    assert.equal(authorReader.currentDelayMs, 480_000);
    for (const transcript of op.failureTranscripts) {
      assert.ok(authorReader.transcriptPaths.includes(transcript));
    }

    assert.equal(pbbJob.disposition, 'active');
    assert.equal(pbbJob.workClass, 'live_learning');
    assert.equal(pbbJob.bundle.bundleId, 'bundle-pbb-prod');
    assert.equal(pbbJob.domain?.estimatedPromptTokens, 19_200);
    assert.equal(pbbJob.domain?.maxPromptTokens, 8_000);

    // Idempotent re-run: no duplicate jobs, no extra materialization.
    // Operational ownership already transferred out of the legacy queue, so the
    // re-scan only sees the still-present prompt-budget-blocked source.
    const second = materializeLegacyReviewRecordsAsJobs({
      reviewQueuePath: env.reviewQueuePath,
      jobStorePath: env.jobStorePath,
      promptBudgetBlockedPath: env.promptBudgetBlockedPath,
      now: FIXED_NOW,
    });
    assert.equal(second.materialized, 0);
    assert.equal(second.alreadyPresent, 1);
    const after = loadEvidenceReviewJobStore(env.jobStorePath);
    assert.equal(Object.keys(after.jobs).length, 2);

    // Successful migration transfers ownership to the Evidence Review Job.
    const queueRaw = JSON.parse(fs.readFileSync(env.reviewQueuePath, 'utf8')) as {
      operational: unknown[];
    };
    assert.equal(queueRaw.operational.length, 0);
  });

  test('migrated operational retry is not runnable before its preserved deadline', () => {
    const op = operationalEntry();
    writeLegacyQueue(env, [op]);

    materializeLegacyReviewRecordsAsJobs({
      reviewQueuePath: env.reviewQueuePath,
      jobStorePath: env.jobStorePath,
      now: FIXED_NOW,
    });

    const store = loadEvidenceReviewJobStore(env.jobStorePath);
    const beforeDue = planFairQuantumClaims(store, {
      maxClaims: 1,
      maxClaimsPerJob: 1,
      now: FIXED_NOW,
    });
    assert.equal(beforeDue.claims.length, 0);

    const afterDue = planFairQuantumClaims(store, {
      maxClaims: 1,
      maxClaimsPerJob: 1,
      now: new Date('2026-07-17T07:00:00.000Z'),
    });
    assert.equal(afterDue.claims.length, 1);
    assert.equal(afterDue.claims[0]!.jobId, 'job:migrated:op:op_entry_prod_1');
  });

  test('migrated operational retry cannot also execute through the legacy queue', async () => {
    const op = operationalEntry({ nextRetryAt: '2026-07-17T05:00:00.000Z' });
    writeLegacyQueue(env, [op]);

    const migrated = env.skillEvolution.ensureLegacyReviewRecordsMigrated(FIXED_NOW);
    assert.equal(migrated.materialized, 1);
    assert.equal(loadEvidenceReviewJobStore(env.jobStorePath).jobs[migrated.jobIds[0]!] !== undefined, true);

    const legacyResult = await env.skillEvolution.reviewDueQueueEntries({ now: FIXED_NOW });
    assert.equal(legacyResult.reviewed, 0);
    assert.equal(legacyResult.operationalRetried, 0);
  });

  test('public SkillEvolution + RuntimeLearning.wake path materializes legacy records once', async () => {
    const op = operationalEntry({
      // Due at FIXED_NOW so operational-retry planner path is eligible, but
      // author fixture throws — wake must still complete migration first.
      nextRetryAt: '2026-07-17T05:00:00.000Z',
    });
    writeLegacyQueue(env, [op]);
    writePromptBudgetBlocked(env, [promptBudgetBlockedRecord()]);

    // Direct SkillEvolution seam (startup / pre-review).
    const direct = env.skillEvolution.ensureLegacyReviewRecordsMigrated(FIXED_NOW);
    assert.equal(direct.materialized, 2);
    assert.ok(fs.existsSync(env.jobStorePath));

    // Second call is idempotent in-process and across restart-style re-scan.
    // Operational entry was transferred out; only the PBB source remains to re-match.
    const again = env.skillEvolution.ensureLegacyReviewRecordsMigrated(FIXED_NOW);
    assert.equal(again.materialized, 0);
    assert.equal(again.alreadyPresent, 1);

    // Public wake re-enters the same seam without duplicating jobs.
    await env.runtimeLearning.wake('manual');
    const store = loadEvidenceReviewJobStore(env.jobStorePath);
    assert.equal(Object.keys(store.jobs).length, 2);
    assert.ok(store.jobs['job:migrated:op:op_entry_prod_1']);
    assert.ok(store.jobs['job:migrated:pbb:pbb_entry_prod_1']);
  });

  test('corrupt legacy records fail closed without inventing jobs or duplicating ownership', () => {
    writeLegacyQueue(env, [
      // Missing required evidence/candidate — must skip, not invent.
      {
        entryId: 'op_corrupt',
        candidateCapabilityId: 'cap-x',
        bundleId: 'bundle-x',
        failureKind: 'branch_failure',
        failureMessage: 'broken',
        failureTranscripts: [],
        attempts: 1,
        currentDelayMs: 1000,
        nextRetryAt: FIXED_NOW.toISOString(),
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
      } as unknown as SkillEvolutionOperationalReviewFailureEntry,
      operationalEntry(),
    ]);
    fs.writeFileSync(env.promptBudgetBlockedPath, '{not-json', 'utf8');

    const result = materializeLegacyReviewRecordsAsJobs({
      reviewQueuePath: env.reviewQueuePath,
      jobStorePath: env.jobStorePath,
      promptBudgetBlockedPath: env.promptBudgetBlockedPath,
      now: FIXED_NOW,
    });

    // One valid operational entry materializes; corrupt op skipped; pbb file quarantined.
    assert.equal(result.materialized, 1);
    assert.ok(result.skipped >= 1);
    assert.equal(result.quarantined, 1);
    assert.ok(!fs.existsSync(env.promptBudgetBlockedPath), 'corrupt pbb file quarantined');

    const store = loadEvidenceReviewJobStore(env.jobStorePath);
    assert.equal(Object.keys(store.jobs).length, 1);
    assert.ok(store.jobs['job:migrated:op:op_entry_prod_1']);
    assert.equal(store.jobs['job:migrated:op:op_corrupt'], undefined);
  });
});

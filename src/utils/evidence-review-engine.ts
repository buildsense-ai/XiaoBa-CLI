/**
 * Evidence Review Job engine — leases and executes Review Quanta.
 *
 * Coverage quanta use pure #106 domain helpers + #107 lease/graph APIs.
 * Skill Author / Verifier / commit are settled by SkillEvolutionRuntime after
 * dual-lane coverage succeeds (preserves Branch Transcript / Journal / Audit).
 */

import * as crypto from 'crypto';
import type {
  EvidenceBundle,
  SkillDraft,
  SkillVerifierResult,
  SkillEvolutionResult,
  SkillEvolutionOptions,
} from './skill-evolution';
import type { DistilledKnowledgeCandidate } from './capability-distiller';
import {
  type EvidenceDossier,
  type EvidenceReviewJob,
  type DossierDifferenceIndex,
  type ObligationDisposition,
  type ReviewObligation,
  type ReviewQuantumRecord,
  type ReviewWorkClass,
  type ShardFindingSet,
  type TypedFinding,
} from './evidence-review-types';
import { createEvidenceReviewJob } from './evidence-review-graph';
import {
  deriveJobDisposition,
  listRunnableQuanta,
  loadEvidenceReviewJobStore,
  saveEvidenceReviewJobStore,
  upsertEvidenceReviewJob,
  evidenceReviewJobStorePathForReviewQueue,
} from './evidence-review-job-store';
import {
  claimQuantum as claimQuantumCore,
  completeQuantum as completeQuantumCore,
  failQuantum as failQuantumCore,
  reclaimExpiredLeases,
} from './evidence-review-graph-core';
import {
  buildDossierDifferenceIndex,
  buildEvidenceDossier,
  buildReviewObligations,
  verifyShardContent,
  validateShardFindingSet,
  allObligationsResolvedForCommit,
} from './evidence-review';
import { planFairQuantumClaims } from './evidence-review-scheduler';

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export interface EvidenceReviewEngineOptions {
  jobStorePath: string;
  workingDirectory: string;
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  maxQuantaPerAdvance?: number;
  runSkillAuthor: (input: {
    bundle: EvidenceBundle;
    authorDossier: EvidenceDossier;
    job: EvidenceReviewJob;
    signal?: AbortSignal;
  }) => Promise<{ draft: SkillDraft; transcriptPaths: string[] }>;
  runSkillVerifier: (input: {
    bundle: EvidenceBundle;
    draft: SkillDraft;
    authorDossier: EvidenceDossier;
    verifierDossier: EvidenceDossier;
    differenceIndex: DossierDifferenceIndex;
    obligations: readonly ReviewObligation[];
    job: EvidenceReviewJob;
    signal?: AbortSignal;
  }) => Promise<{
    verifier: SkillVerifierResult;
    dispositions: readonly ObligationDisposition[];
    transcriptPaths: string[];
  }>;
  commitTransition: (input: {
    bundle: EvidenceBundle;
    draft: SkillDraft;
    verifier: SkillVerifierResult;
    job: EvidenceReviewJob;
    branchTranscriptPaths: string[];
  }) => Promise<SkillEvolutionResult>;
}

export interface AdvanceJobResult {
  job: EvidenceReviewJob;
  executedQuantumIds: string[];
  remainingRunnable: number;
  result?: SkillEvolutionResult;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Pure graph helpers mutate job.quanta in place. We pass the engine job
 * directly (structurally compatible for quanta/disposition/updatedAt).
 */
function asMutableGraphJob(job: EvidenceReviewJob): any {
  return job;
}

/** Deterministic structural reader — no model authority over shard boundaries. */
export function readShardStructurally(
  shardId: string,
  contentHash: string,
  content: string,
  lane: 'author' | 'verifier',
): ShardFindingSet {
  const findings: TypedFinding[] = [];
  const lower = content.toLowerCase();
  const push = (
    classification: TypedFinding['classification'],
    summary: string,
    needle: string,
  ): void => {
    const idx = lower.indexOf(needle.toLowerCase());
    if (idx < 0) return;
    const start = Buffer.byteLength(content.slice(0, idx), 'utf8');
    const end = start + Buffer.byteLength(content.slice(idx, idx + needle.length), 'utf8');
    findings.push({
      findingId: `${lane}:${classification}:${sha256(`${shardId}:${needle}`).slice(0, 12)}`,
      classification,
      summary,
      spans: [{ start, end }],
    });
  };

  if (/ignore (all )?(previous|prior) instructions|system prompt|you are now/i.test(content)) {
    push('source_instruction', 'Source material contains instruction-like text.', 'ignore');
  }
  if (/password|secret|credential|sudo|rm -rf|privilege/i.test(content)) {
    push('privilege_implication', 'Source material mentions privilege-sensitive content.', 'privilege');
  }
  if (/risk|danger|unsafe|leak/i.test(content)) {
    push('risk', 'Source material mentions risk language.', 'risk');
  }
  if (/but |however |contradict|instead /i.test(content)) {
    push('limitation', 'Source material contains limiting or contrastive language.', 'but');
  }
  if (findings.length === 0 && content.trim().length > 0) {
    const end = Math.min(Buffer.byteLength(content, 'utf8'), 64);
    findings.push({
      findingId: `${lane}:fact:${contentHash.slice(0, 12)}`,
      classification: 'fact',
      summary: 'Shard content observed for dual-lane coverage.',
      spans: [{ start: 0, end }],
    });
  }

  return {
    shardId,
    contentHash,
    lane,
    coverage: content.trim().length === 0 ? 'empty' : 'covered',
    findings,
  };
}

// Re-export package builders for tests / integrators that used prior names.
export function buildDossierFromFindingSets(
  lane: 'author' | 'verifier',
  manifestHash: string,
  sets: readonly ShardFindingSet[],
  complete = true,
): EvidenceDossier {
  return {
    lane,
    manifestHash,
    coveredShardIds: sets
      .filter(s => s.coverage === 'covered' || s.coverage === 'empty')
      .map(s => s.shardId)
      .sort((a, b) => a.localeCompare(b, 'en')),
    findings: sets.flatMap(s => s.findings),
    findingSets: sets,
    complete,
  };
}

export function buildDifferenceIndex(
  author: EvidenceDossier,
  verifier: EvidenceDossier,
): DossierDifferenceIndex {
  return buildDossierDifferenceIndex(author, verifier);
}

export { buildReviewObligations };

export class EvidenceReviewEngine {
  private readonly options: EvidenceReviewEngineOptions;

  constructor(options: EvidenceReviewEngineOptions) {
    this.options = options;
  }

  get jobStorePath(): string {
    return this.options.jobStorePath;
  }

  loadStore() {
    return loadEvidenceReviewJobStore(this.options.jobStorePath);
  }

  saveStore(state: ReturnType<typeof loadEvidenceReviewJobStore>): void {
    saveEvidenceReviewJobStore(this.options.jobStorePath, state);
  }

  findActiveJobForBundle(bundleId: string): EvidenceReviewJob | undefined {
    const state = this.loadStore();
    return Object.values(state.jobs)
      .filter(job => job.bundle.bundleId === bundleId && job.disposition === 'active')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt, 'en'))[0];
  }

  createJob(input: {
    bundle: EvidenceBundle;
    candidate: DistilledKnowledgeCandidate;
    workClass: ReviewWorkClass;
    sharding?: Parameters<typeof createEvidenceReviewJob>[0]['sharding'];
  }): EvidenceReviewJob {
    const job = createEvidenceReviewJob({
      bundle: input.bundle,
      candidate: input.candidate,
      workClass: input.workClass,
      now: this.options.now?.() ?? new Date(),
      sharding: input.sharding,
    });
    const state = this.loadStore();
    upsertEvidenceReviewJob(state, job);
    this.saveStore(state);
    return job;
  }

  ensureJob(input: {
    bundle: EvidenceBundle;
    candidate: DistilledKnowledgeCandidate;
    workClass: ReviewWorkClass;
    sharding?: Parameters<typeof createEvidenceReviewJob>[0]['sharding'];
  }): EvidenceReviewJob {
    const existing = this.findActiveJobForBundle(input.bundle.bundleId);
    if (existing) return existing;
    return this.createJob(input);
  }

  async advanceJob(
    jobId: string,
    wakeId: string,
    signal?: AbortSignal,
    options?: {
      allowedKinds?: ReadonlySet<ReviewQuantumRecord['kind']> | readonly ReviewQuantumRecord['kind'][];
    },
  ): Promise<AdvanceJobResult> {
    const nowFn = this.options.now ?? (() => new Date());
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const retryBaseMs = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const retryMaxMs = this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const maxQuanta = Math.max(1, this.options.maxQuantaPerAdvance ?? 64);
    const allowedKinds = options?.allowedKinds
      ? new Set(options.allowedKinds)
      : undefined;
    const executedQuantumIds: string[] = [];
    let result: SkillEvolutionResult | undefined;

    for (let i = 0; i < maxQuanta; i++) {
      if (signal?.aborted) break;
      const now = nowFn();
      const state = this.loadStore();
      let job = state.jobs[jobId];
      if (!job || job.disposition !== 'active') {
        return {
          job: job ?? state.jobs[jobId]!,
          executedQuantumIds,
          remainingRunnable: 0,
          result,
        };
      }

      // Reclaim expired leases via pure graph helper (mutates quanta in place).
      reclaimExpiredLeases(asMutableGraphJob(job), now);
      upsertEvidenceReviewJob(state, job);
      this.saveStore(state);

      const runnable = listRunnableQuanta(job, now).filter(q => (
        !allowedKinds || allowedKinds.has(q.kind)
      ));
      if (runnable.length === 0) {
        job.disposition = deriveJobDisposition(job);
        job.updatedAt = now.toISOString();
        upsertEvidenceReviewJob(state, job);
        this.saveStore(state);
        return { job, executedQuantumIds, remainingRunnable: 0, result };
      }

      const selected = selectNextQuantum(job, runnable);
      if (!selected) break;

      const claim = claimQuantumCore(asMutableGraphJob(job), selected.quantumId, {
        ownerWakeId: wakeId,
        now,
        leaseMs,
      });
      if (!claim.ok) break;
      upsertEvidenceReviewJob(state, job);
      this.saveStore(state);

      try {
        const execution = await this.executeQuantum(job, job.quanta[selected.quantumId]!, signal);
        const after = this.loadStore();
        const live = after.jobs[jobId]!;
        const completed = completeQuantumCore(asMutableGraphJob(live), selected.quantumId, {
          result: execution.result,
          now: nowFn(),
          // graph-core accepts a single transcriptPath; fold multiples into result metadata
          ...(execution.transcriptPaths[0] ? { transcriptPath: execution.transcriptPaths[0] } : {}),
        });
        if (!completed.ok) {
          throw new Error(`completeQuantum failed: ${completed.reason}`);
        }
        // Preserve additional transcript paths on the quantum when present.
        if (execution.transcriptPaths.length > 1) {
          const q = live.quanta[selected.quantumId]!;
          live.quanta[selected.quantumId] = {
            ...q,
            transcriptPaths: [...new Set([...q.transcriptPaths, ...execution.transcriptPaths])],
          };
        }
        if (execution.jobPatch) Object.assign(live, execution.jobPatch);
        if (execution.skillResult) result = execution.skillResult;
        live.disposition = deriveJobDisposition(live);
        live.updatedAt = nowFn().toISOString();
        if (live.disposition === 'completed' && result?.transitionId) {
          live.transitionId = result.transitionId;
        }
        upsertEvidenceReviewJob(after, live);
        this.saveStore(after);
        executedQuantumIds.push(selected.quantumId);
        if (selected.kind === 'commit' && result) {
          return {
            job: live,
            executedQuantumIds,
            remainingRunnable: listRunnableQuanta(live, nowFn()).length,
            result,
          };
        }
        job = live;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const terminal = /terminal|integrity|manifest/i.test(message);
        const after = this.loadStore();
        const live = after.jobs[jobId]!;
        const failed = failQuantumCore(asMutableGraphJob(live), selected.quantumId, {
          message,
          now: nowFn(),
          retryBaseMs,
          retryMaxMs,
          terminal,
        });
        if (!failed.ok) {
          // Fall back to manual retry_wait if pure helper rejects.
          live.quanta[selected.quantumId] = {
            ...live.quanta[selected.quantumId]!,
            state: terminal ? 'terminal_failed' : 'retry_wait',
            failureMessage: message,
            lease: undefined,
            updatedAt: nowFn().toISOString(),
          };
        }
        live.disposition = deriveJobDisposition(live);
        if (live.disposition === 'terminal_failed') {
          live.terminalReason = message;
        }
        live.updatedAt = nowFn().toISOString();
        const retrying = Object.values(live.quanta)
          .filter(q => q.state === 'retry_wait' && q.nextRetryAt)
          .map(q => q.nextRetryAt!)
          .sort();
        live.nextDueAt = retrying[0];
        upsertEvidenceReviewJob(after, live);
        this.saveStore(after);
        executedQuantumIds.push(selected.quantumId);
        job = live;
      }
    }

    const finalState = this.loadStore();
    const finalJob = finalState.jobs[jobId]!;
    return {
      job: finalJob,
      executedQuantumIds,
      remainingRunnable: listRunnableQuanta(finalJob, nowFn()).length,
      result,
    };
  }

  private async executeQuantum(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    signal?: AbortSignal,
  ): Promise<{
    result: unknown;
    transcriptPaths: string[];
    jobPatch?: Partial<EvidenceReviewJob>;
    skillResult?: SkillEvolutionResult;
  }> {
    switch (quantum.kind) {
      case 'author_reader':
      case 'verifier_reader':
        return this.executeReader(job, quantum);
      case 'author_dossier':
        return this.executeDossier(job, 'author');
      case 'verifier_dossier':
        return this.executeDossier(job, 'verifier');
      case 'difference_index':
        return this.executeDifference(job);
      case 'obligations':
        return this.executeObligations(job);
      case 'skill_author':
      case 'skill_verifier':
      case 'commit':
        throw new Error(`${quantum.kind} quantum is settled by the Skill Evolution promotion path`);
      default:
        throw new Error(`unknown quantum kind: ${(quantum as ReviewQuantumRecord).kind}`);
    }
  }

  private executeReader(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
  ): { result: ShardFindingSet; transcriptPaths: string[] } {
    const shardId = quantum.shardId;
    if (!shardId) throw new Error('reader quantum missing shardId');
    const shard = job.shards[shardId];
    if (!shard) throw new Error(`missing shard ${shardId}`);
    if (!verifyShardContent(shard)) {
      throw new Error(`integrity: shard content hash mismatch for ${shardId}`);
    }
    const lane = quantum.lane ?? (quantum.kind === 'author_reader' ? 'author' : 'verifier');
    const findingSet = readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane);
    const validation = validateShardFindingSet(findingSet, shard, job.manifest, { expectedLane: lane });
    if (!validation.ok) {
      const first = validation.errors[0]!;
      throw new Error(`invalid_completion_schema: ${first.code}: ${first.message}`);
    }
    if (findingSet.coverage !== 'covered' && findingSet.coverage !== 'empty') {
      throw new Error(`reader coverage incomplete: ${findingSet.coverage}`);
    }
    return { result: findingSet, transcriptPaths: [] };
  }

  private executeDossier(
    job: EvidenceReviewJob,
    lane: 'author' | 'verifier',
  ): { result: EvidenceDossier; transcriptPaths: string[]; jobPatch: Partial<EvidenceReviewJob> } {
    const kind = lane === 'author' ? 'author_reader' : 'verifier_reader';
    const sets = Object.values(job.quanta)
      .filter(q => q.kind === kind && q.state === 'succeeded')
      .map(q => q.result as ShardFindingSet)
      .filter(Boolean);
    const shards = job.manifest.shardIds.map(id => job.shards[id]!).filter(Boolean);
    const dossier = buildEvidenceDossier({
      lane,
      manifest: job.manifest,
      shards,
      findingSets: sets,
      requireCompleteCoverage: true,
    });
    const jobPatch: Partial<EvidenceReviewJob> = lane === 'author'
      ? { authorDossier: dossier }
      : { verifierDossier: dossier };
    return { result: dossier, transcriptPaths: [], jobPatch };
  }

  private executeDifference(
    job: EvidenceReviewJob,
  ): { result: DossierDifferenceIndex; transcriptPaths: string[]; jobPatch: Partial<EvidenceReviewJob> } {
    if (!job.authorDossier || !job.verifierDossier) {
      throw new Error('difference index requires both dossiers');
    }
    const index = buildDossierDifferenceIndex(job.authorDossier, job.verifierDossier);
    return { result: index, transcriptPaths: [], jobPatch: { differenceIndex: index } };
  }

  private executeObligations(
    job: EvidenceReviewJob,
  ): { result: ReviewObligation[]; transcriptPaths: string[]; jobPatch: Partial<EvidenceReviewJob> } {
    if (!job.authorDossier || !job.verifierDossier || !job.differenceIndex) {
      throw new Error('obligations require dossiers and difference index');
    }
    const obligations = buildReviewObligations(
      job.authorDossier,
      job.verifierDossier,
      job.differenceIndex,
    );
    return { result: obligations, transcriptPaths: [], jobPatch: { obligations } };
  }
}

export function selectNextQuantum(
  job: EvidenceReviewJob,
  runnable: readonly ReviewQuantumRecord[],
): ReviewQuantumRecord | undefined {
  if (runnable.length === 0) return undefined;
  const nonReaders = runnable.filter(q => q.kind !== 'author_reader' && q.kind !== 'verifier_reader');
  if (nonReaders.length > 0) return nonReaders[0];

  const authorDone = Object.values(job.quanta)
    .filter(q => q.kind === 'author_reader' && q.state === 'succeeded').length;
  const verifierDone = Object.values(job.quanta)
    .filter(q => q.kind === 'verifier_reader' && q.state === 'succeeded').length;
  const preferLane: 'author' | 'verifier' = authorDone <= verifierDone ? 'author' : 'verifier';
  const preferred = runnable.find(q => q.lane === preferLane);
  return preferred ?? runnable[0];
}

export function resolveEvidenceReviewJobStorePath(
  options: Pick<SkillEvolutionOptions, 'reviewQueuePath' | 'workingDirectory'>,
): string {
  if (options.reviewQueuePath) {
    return evidenceReviewJobStorePathForReviewQueue(options.reviewQueuePath);
  }
  return `${options.workingDirectory.replace(/\/$/, '')}/data/evidence-review-jobs.json`;
}

export { allObligationsResolvedForCommit };

/**
 * Fair multi-job advance for one wake (#108).
 * Claims a bounded set of quanta across jobs using Fair Review Quantum Rotation.
 */
export async function advanceJobsFairly(
  engine: EvidenceReviewEngine,
  wakeId: string,
  options: {
    maxClaims: number;
    maxClaimsPerJob?: number;
    signal?: AbortSignal;
    now?: Date;
  },
): Promise<{ claims: number; jobIds: string[] }> {
  const state = engine.loadStore();
  const plan = planFairQuantumClaims(state, {
    maxClaims: options.maxClaims,
    maxClaimsPerJob: options.maxClaimsPerJob ?? 1,
    now: options.now,
  });
  state.fairness = plan.fairness;
  engine.saveStore(state);

  const touched = new Set<string>();
  // Group claims by job and advance each job with maxQuanta equal to its claim count.
  const perJob = new Map<string, number>();
  for (const claim of plan.claims) {
    perJob.set(claim.jobId, (perJob.get(claim.jobId) ?? 0) + 1);
    touched.add(claim.jobId);
  }
  for (const [jobId, count] of perJob) {
    if (options.signal?.aborted) break;
    // Temporarily bound by looping maxClaims times with allowed coverage+promotion kinds.
    for (let i = 0; i < count; i++) {
      if (options.signal?.aborted) break;
      const advanced = await engine.advanceJob(jobId, `${wakeId}:${jobId}:${i}`, options.signal);
      if (advanced.executedQuantumIds.length === 0) break;
    }
  }
  return { claims: plan.claims.length, jobIds: [...touched] };
}

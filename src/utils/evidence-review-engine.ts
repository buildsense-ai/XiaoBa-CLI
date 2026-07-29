/**
 * Evidence Review Job engine — leases and executes Review Quanta.
 *
 * Authoritative Review Quanta (ADR 0045 / #105–#107):
 * - Dual-lane readers produce schema-validated Shard Finding Sets with exact
 *   spans and auditable Reader transcript artifacts.
 * - skill_author / skill_verifier / commit execute as leased durable quanta
 *   via injected callbacks (no post-hoc graph projection).
 * - Failed quanta retry locally; succeeded quanta are never replayed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  EvidenceBundle,
  SkillDraft,
  SkillVerifierResult,
  SkillVerifierIssue,
  SkillEvolutionResult,
  SkillEvolutionOptions,
} from './skill-evolution';
import type { DistilledKnowledgeCandidate } from './capability-distiller';
import {
  type EvidenceDossier,
  type EvidenceReviewJob,
  type EvidenceReviewJobStoreState,
  type DossierDifferenceIndex,
  type ObligationDisposition,
  type ReviewObligation,
  type ReviewQuantumRecord,
  type ReviewOperationalFailureKind,
  type ReviewOperationalFailureReason,
  type ReviewWorkClass,
  type ShardFindingSet,
  type TypedFinding,
  type EvidenceShard,
} from './evidence-review-types';
import type { EvidenceReviewLane } from './evidence-review';
import { createEvidenceReviewJob } from './evidence-review-graph';
import {
  loadEvidenceReviewJobStore,
  mutateEvidenceReviewJobStore,
  upsertEvidenceReviewJob,
  evidenceReviewJobStorePathForReviewQueue,
} from './evidence-review-job-store';
import {
  claimQuantum as claimQuantumCore,
  completeQuantum as completeQuantumCore,
  failQuantum as failQuantumCore,
  releaseQuantum as releaseQuantumCore,
  renewQuantumLease as renewQuantumLeaseCore,
  reclaimExpiredLeases,
  createReviewQuantum,
  deriveJobDisposition,
  listRunnableQuanta,
  stableStringify,
} from './evidence-review-graph-core';
import {
  buildDossierDifferenceIndex,
  buildEvidenceDossier,
  buildReviewObligations,
  verifyShardContent,
  validateShardFindingSet,
  validateObligationDispositions,
  allObligationsResolvedForCommit,
} from './evidence-review';
import { planFairQuantumClaims } from './evidence-review-scheduler';

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export interface ReaderLaneInput {
  shard: EvidenceShard;
  lane: EvidenceReviewLane;
  job: EvidenceReviewJob;
  signal?: AbortSignal;
}

export interface ReaderLaneResult {
  findingSet: ShardFindingSet;
  /** Optional pre-written transcript path; engine persists one when omitted. */
  transcriptPath?: string;
}

type CommitLeaseGuard = <T>(work: () => T) => T;

export interface EvidenceReviewEngineOptions {
  jobStorePath: string;
  workingDirectory: string;
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  maxQuantaPerAdvance?: number;
  /** Skill Evolution reviewer version persisted when a commit semantically defers. */
  reviewerVersion?: string;
  /**
   * Production / SkillEvolution seam: independent Author or Verifier reader
   * execution over one immutable shard. SkillEvolution wires a model-backed
   * reader here; tests inject deterministic fixtures via SkillEvolution.readerFixture
   * or a direct runReaderLane callback. When omitted, the engine uses a
   * lane-scoped structural fallback for low-level engine tests only — never as
   * silent production semantic certification.
   */
  runReaderLane?: (input: ReaderLaneInput) => Promise<ReaderLaneResult>;
  runSkillAuthor: (input: {
    bundle: EvidenceBundle;
    authorDossier: EvidenceDossier;
    job: EvidenceReviewJob;
    /** Round 1 for initial draft, 2 for revision after round-1 revise. */
    round: number;
    /** Previous draft from round 1, present only when round = 2. */
    previousDraft?: SkillDraft;
    /** Verifier issues from round 1, present only when round = 2. */
    verifierIssues?: readonly SkillVerifierIssue[];
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
    /** Round 1 for initial verification, 2 for revision verification. */
    round: number;
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
    /** Final review round (1 or 2). */
    round: number;
    /** Stable durable identity for crash-safe commit replay. */
    reviewCommitKey: string;
    /** Execute synchronous transition side effects while the durable lease is fenced. */
    commitUnderLease: CommitLeaseGuard;
  }) => Promise<SkillEvolutionResult>;
  /** Resolve a previously committed audit receipt without invoking commit again. */
  recoverCommittedTransition?: (input: {
    bundle: EvidenceBundle;
    draft: SkillDraft;
    verifier: SkillVerifierResult;
    job: EvidenceReviewJob;
    branchTranscriptPaths: string[];
    round: number;
    reviewCommitKey: string;
  }) => SkillEvolutionResult | undefined;
}

export interface AdvanceJobResult {
  job: EvidenceReviewJob;
  executedQuantumIds: string[];
  remainingRunnable: number;
  result?: SkillEvolutionResult;
  /** Last quantum execution error (message + optional operational kind). */
  lastError?: {
    message: string;
    kind?: string;
    reason?: ReviewOperationalFailureReason;
    transcriptPaths?: string[];
    quantumId?: string;
    quantumKind?: string;
  };
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Pure graph helpers mutate job.quanta in place. The engine job
 * structurally satisfies GraphJobView, so we pass it directly.
 */

/**
 * Lane-scoped structural reader for explicit test fixtures and engine unit tests.
 * Not the production SkillEvolution default (that path is model-backed).
 * Author and Verifier use independent finding identity and different pattern
 * emphasis; neither certifies coverage via a shared first-64-byte span.
 */
export function readShardStructurally(
  shardId: string,
  contentHash: string,
  content: string,
  lane: 'author' | 'verifier',
): ShardFindingSet {
  const findings: TypedFinding[] = [];
  const lower = content.toLowerCase();
  const contentBytes = Buffer.byteLength(content, 'utf8');

  const push = (
    classification: TypedFinding['classification'],
    summary: string,
    needle: string,
    salt: string,
  ): void => {
    const idx = lower.indexOf(needle.toLowerCase());
    if (idx < 0) return;
    const start = Buffer.byteLength(content.slice(0, idx), 'utf8');
    const end = start + Buffer.byteLength(content.slice(idx, idx + needle.length), 'utf8');
    findings.push({
      findingId: `${lane}:${classification}:${sha256(`${lane}:${salt}:${shardId}:${needle}`).slice(0, 12)}`,
      classification,
      summary,
      spans: [{ start, end }],
    });
  };

  // Author lane emphasizes instruction / privilege / risk extraction.
  // Verifier lane emphasizes corroboration / limitation / contradiction.
  if (lane === 'author') {
    if (/ignore (all )?(previous|prior) instructions|system prompt|you are now/i.test(content)) {
      push('source_instruction', 'Author lane: source material contains instruction-like text.', 'ignore', 'a1');
    }
    if (/password|secret|credential|sudo|rm -rf|privilege/i.test(content)) {
      push('privilege_implication', 'Author lane: privilege-sensitive content observed.', 'privilege', 'a2');
    }
    if (/risk|danger|unsafe|leak/i.test(content)) {
      push('risk', 'Author lane: risk language observed.', 'risk', 'a3');
    }
    if (/but |however |contradict|instead /i.test(content)) {
      push('limitation', 'Author lane: limiting or contrastive language observed.', 'but', 'a4');
    }
  } else {
    if (/ignore (all )?(previous|prior) instructions|system prompt|you are now/i.test(content)) {
      push('source_instruction', 'Verifier lane: independent confirmation of instruction-like text.', 'system', 'v1');
    }
    if (/password|secret|credential|sudo|rm -rf|privilege/i.test(content)) {
      push('privilege_implication', 'Verifier lane: independent privilege-sensitive observation.', 'secret', 'v2');
    }
    if (/risk|danger|unsafe|leak/i.test(content)) {
      push('risk', 'Verifier lane: independent risk observation.', 'danger', 'v3');
    }
    if (/but |however |contradict|instead /i.test(content)) {
      push('contradiction', 'Verifier lane: contrastive language may indicate contradiction.', 'however', 'v4');
    }
    if (/confirm|verify|thanks|works|delivered/i.test(content)) {
      push('fact', 'Verifier lane: corroborating settlement/delivery language.', 'confirm', 'v5');
    }
  }

  // Nonempty content without pattern hits still needs structured coverage —
  // cite the full immutable shard, never a shared first-N-byte heuristic.
  if (findings.length === 0 && content.trim().length > 0) {
    findings.push({
      findingId: `${lane}:fact:${sha256(`${lane}:full:${contentHash}`).slice(0, 12)}`,
      classification: 'fact',
      summary: `${lane === 'author' ? 'Author' : 'Verifier'} lane observed full shard content for dual-lane coverage.`,
      spans: [{ start: 0, end: contentBytes }],
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

  /** Production mutations must use this whole-store transaction. */
  mutateStore<T>(mutation: (state: EvidenceReviewJobStoreState) => T): T {
    return mutateEvidenceReviewJobStore(this.options.jobStorePath, mutation);
  }

  /** Test/bootstrap replacement only; production read-modify-write must use mutateStore. */
  saveStore(state: ReturnType<typeof loadEvidenceReviewJobStore>): void {
    this.mutateStore(live => {
      live.jobs = state.jobs;
      live.fairness = state.fairness;
    });
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
    registryReadSet?: Parameters<typeof createEvidenceReviewJob>[0]['registryReadSet'];
    sharding?: Parameters<typeof createEvidenceReviewJob>[0]['sharding'];
  }): EvidenceReviewJob {
    return this.mutateStore(state => {
      const now = this.options.now?.() ?? new Date();
      const provisional = createEvidenceReviewJob({
        bundle: input.bundle,
        candidate: input.candidate,
        workClass: input.workClass,
        registryReadSet: input.registryReadSet,
        now,
        sharding: input.sharding,
      });
      // Deterministic job ids collide across sequential reviews of the same bundle.
      // Never overwrite a terminal job: mint a unique id so reader transcript paths
      // and quanta remain owned by a single commit audit.
      let job = provisional;
      const prior = state.jobs[provisional.jobId];
      if (prior?.disposition === 'active') return prior;
      if (prior) {
        const uniqueSuffix = crypto.randomBytes(4).toString('hex');
        job = createEvidenceReviewJob({
          bundle: input.bundle,
          candidate: input.candidate,
          workClass: input.workClass,
          registryReadSet: input.registryReadSet,
          now,
          sharding: input.sharding,
          jobId: `${provisional.jobId}:${uniqueSuffix}`,
        });
      }
      upsertEvidenceReviewJob(state, job);
      return job;
    });
  }

  ensureJob(input: {
    bundle: EvidenceBundle;
    candidate: DistilledKnowledgeCandidate;
    workClass: ReviewWorkClass;
    registryReadSet?: Parameters<typeof createEvidenceReviewJob>[0]['registryReadSet'];
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
      /** Execute only the quantum selected by an external scheduler. */
      quantumId?: string;
      /** Per-call execution bound; defaults to the engine-wide setting. */
      maxQuanta?: number;
      /** Independent hard deadline for every leased Quantum in this call. */
      quantumTimeoutMs?: number;
      /** Shutdown/drain gate checked before every new lease claim. */
      shouldStopClaiming?: () => boolean;
    },
  ): Promise<AdvanceJobResult> {
    const nowFn = this.options.now ?? (() => new Date());
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const retryBaseMs = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const retryMaxMs = this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const maxQuanta = Math.max(
      1,
      options?.maxQuanta ?? this.options.maxQuantaPerAdvance ?? 64,
    );
    const allowedKinds = options?.allowedKinds
      ? new Set(options.allowedKinds)
      : undefined;
    const executedQuantumIds: string[] = [];
    let result: SkillEvolutionResult | undefined;
    let lastError: AdvanceJobResult['lastError'];

    for (let i = 0; i < maxQuanta; i++) {
      if (options?.shouldStopClaiming?.()) break;
      // Shutdown/drain must not manufacture retry work. Other pre-existing
      // aborts (notably a review deadline) are a real operational failure and
      // are recorded on the selected Quantum below.
      if (signal?.aborted && signal.reason === 'runtime-shutdown') break;
      const now = nowFn();
      const claimedWork = mutateEvidenceReviewJobStore(this.jobStorePath, (state) => {
        const job = state.jobs[jobId];
        if (!job || job.disposition !== 'active') {
          return { job, selected: undefined, claim: undefined, remainingRunnable: 0 };
        }

        // Reclaim, reconcile, select and lease are one durable transaction.
        // Never hold this lock while a provider-backed Quantum executes.
        reclaimExpiredLeases(job, now);
        this.reconcileRevisionRound(state, job, now);
        const runnable = listRunnableQuanta(job, now).filter(q => (
          (!allowedKinds || allowedKinds.has(q.kind))
          && (!options?.quantumId || q.quantumId === options.quantumId)
        ));
        if (runnable.length === 0) {
          job.disposition = deriveJobDisposition(job);
          job.updatedAt = now.toISOString();
          upsertEvidenceReviewJob(state, job);
          return { job, selected: undefined, claim: undefined, remainingRunnable: 0 };
        }

        const selected = selectNextQuantum(job, runnable);
        if (!selected) return { job, selected: undefined, claim: undefined, remainingRunnable: 0 };
        const claim = claimQuantumCore(job, selected.quantumId, {
          ownerWakeId: wakeId,
          now,
          leaseMs,
        });
        if (!claim.ok) return { job, selected: undefined, claim: undefined, remainingRunnable: runnable.length };
        if (selected.kind === 'commit') {
          const claimed = job.quanta[selected.quantumId]!;
          job.quanta[selected.quantumId] = {
            ...claimed,
            commitIntent: claimed.commitIntent ?? {
              key: `${job.jobId}:${selected.quantumId}`,
              preparedAt: now.toISOString(),
            },
          };
        }
        upsertEvidenceReviewJob(state, job);
        return { job, selected, claim, remainingRunnable: runnable.length - 1 };
      });
      let { job, selected, claim } = claimedWork;
      if (!job) {
        throw new Error(`Evidence Review Job not found: ${jobId}`);
      }
      if (!selected || !claim || !claim.ok) {
        return {
          job,
          executedQuantumIds,
          remainingRunnable: claimedWork.remainingRunnable,
          result,
          lastError,
        };
      }

      // Provider-backed quanta are cancellable and independently bounded.
      // Commit owns external side effects and must run to its durable receipt;
      // racing it against a timeout could retry a commit that already applied.
      const quantumBoundary = selected.kind === 'commit'
        ? createNonInterruptibleCommitBoundary()
        : createQuantumAbortBoundary(signal, options?.quantumTimeoutMs ?? leaseMs);
      let leaseLost = false;
      const renewLease = (): void => {
        try {
          const renewed = this.mutateStore(state => {
            const live = state.jobs[jobId];
            if (!live) return { ok: false as const, reason: 'missing' as const };
            return renewQuantumLeaseCore(live, selected.quantumId, {
              leaseId: claim.lease.leaseId,
              ownerWakeId: claim.lease.ownerWakeId,
              leaseMs,
              now: nowFn(),
            });
          });
          if (!renewed.ok) leaseLost = true;
        } catch {
          // Busy store locks are transient. Completion still performs the
          // authoritative lease CAS inside the same whole-store lock.
        }
      };
      const renewalTimer = setInterval(renewLease, Math.max(10, Math.floor(leaseMs / 3)));
      renewalTimer.unref?.();
      try {
        if (quantumBoundary.signal.aborted) {
          throw reviewAbortError(quantumBoundary.signal.reason, 'Review quantum aborted before execution.');
        }
        const commitUnderLease: CommitLeaseGuard = <T>(work: () => T): T =>
          this.mutateStore(state => {
            const live = state.jobs[jobId];
            if (!live) throw new Error('quantum_lease_lost: job is missing');
            const renewed = renewQuantumLeaseCore(live, selected.quantumId, {
              leaseId: claim.lease.leaseId,
              ownerWakeId: claim.lease.ownerWakeId,
              leaseMs,
              now: nowFn(),
            });
            if (!renewed.ok) {
              throw new Error(`quantum_lease_lost: ${renewed.reason}`);
            }
            // The whole-store lock remains held through this synchronous work.
            // A newer wake cannot reclaim the lease before journal side effects.
            const value = work();
            const completedAt = nowFn();
            const current = live.quanta[selected.quantumId];
            if (
              !current
              || current.state !== 'leased'
              || current.lease?.leaseId !== claim.lease.leaseId
              || current.lease.ownerWakeId !== claim.lease.ownerWakeId
            ) {
              throw new Error('quantum_lease_lost: identity changed during commit');
            }
            // Synchronous journal recovery may block the event loop longer than
            // leaseMs. Extend before releasing the store lock so no contender
            // can reclaim the just-committed Quantum in the completion gap.
            current.lease = {
              ...current.lease,
              expiresAt: new Date(completedAt.getTime() + leaseMs).toISOString(),
            };
            current.updatedAt = completedAt.toISOString();
            const receipt = value && typeof value === 'object'
              ? value as { transitionId?: unknown; audit?: { transitionId?: unknown } }
              : undefined;
            const transitionId = typeof receipt?.transitionId === 'string'
              ? receipt.transitionId
              : typeof receipt?.audit?.transitionId === 'string'
                ? receipt.audit.transitionId
                : undefined;
            current.commitReceipt = {
              key: current.commitIntent?.key ?? `${live.jobId}:${selected.quantumId}`,
              ...(transitionId ? { transitionId } : {}),
              recordedAt: completedAt.toISOString(),
            };
            live.updatedAt = completedAt.toISOString();
            return value;
          });
        const execution = await awaitQuantumExecution(
          this.executeQuantum(
            job,
            job.quanta[selected.quantumId]!,
            quantumBoundary.signal,
            selected.kind === 'commit' ? commitUnderLease : undefined,
          ),
          quantumBoundary.signal,
        );
        if (quantumBoundary.signal.aborted) {
          throw reviewAbortError(quantumBoundary.signal.reason, 'Review quantum exceeded its execution boundary.');
        }
        renewLease();
        if (leaseLost) throw new Error('quantum_lease_lost: execution result is stale');
        const live = mutateEvidenceReviewJobStore(this.jobStorePath, (after) => {
          const live = after.jobs[jobId]!;
          const completed = completeQuantumCore(live, selected.quantumId, {
            result: execution.result,
            leaseId: claim.lease.leaseId,
            ownerWakeId: claim.lease.ownerWakeId,
            now: nowFn(),
            // graph-core accepts a single transcriptPath; fold multiples into result metadata
            ...(execution.transcriptPaths[0] ? { transcriptPath: execution.transcriptPaths[0] } : {}),
          });
          if (!completed.ok) {
            throw new Error(`completeQuantum failed: ${completed.reason}`);
          }
          // A late attempt that observes authoritative success is a pure no-op.
          // Never apply its stale transcript metadata, jobPatch, or skill result.
          if (completed.alreadySucceeded) return live;
          // Preserve additional transcript paths on the quantum when present.
        if (execution.transcriptPaths.length > 1) {
          const q = live.quanta[selected.quantumId]!;
          live.quanta[selected.quantumId] = {
            ...q,
            transcriptPaths: [...new Set([...q.transcriptPaths, ...execution.transcriptPaths])],
          };
        }
        if (selected.kind === 'commit') {
          const q = live.quanta[selected.quantumId]!;
          const key = q.commitIntent?.key ?? `${live.jobId}:${selected.quantumId}`;
          live.quanta[selected.quantumId] = {
            ...q,
            commitReceipt: {
              key,
              ...(execution.skillResult?.transitionId ? { transitionId: execution.skillResult.transitionId } : {}),
              recordedAt: nowFn().toISOString(),
            },
          };
        }
        if (execution.jobPatch) Object.assign(live, execution.jobPatch);
        if (execution.skillResult) result = execution.skillResult;
        live.disposition = deriveJobDisposition(live);
        live.updatedAt = nowFn().toISOString();
        if (live.disposition === 'completed' && result?.transitionId) {
          live.transitionId = result.transitionId;
        }
        // Semantic defer from commit quantum: surface deferred disposition.
        if (
          selected.kind === 'commit'
          && result
          && (result.transition === 'defer' || result.queued === 'deferred')
          && live.disposition === 'completed'
        ) {
          live.disposition = 'deferred';
        }
        // Bounded revision loop: after round-1 skill_verifier completes with
        // 'revise', expand the graph with round-2 Author/Verifier/commit quanta.
        // Successful readers/dossiers/obligations/round-1 are never replayed.
        //
        // ATOMICITY: the verifier completion and the deterministic revision
        // graph expansion must be one durable mutation. Deferring the save
        // until after expansion prevents a crash between two writes from
        // leaving a persisted round-1 revise next to a still-runnable old
        // commit, which would let the old commit execute on restart.
        if (selected.kind === 'skill_verifier' && !result) {
          this.maybeExpandRevisionRound(after, live, selected.quantumId, nowFn());
        }
        upsertEvidenceReviewJob(after, live);
          return live;
        });
        executedQuantumIds.push(selected.quantumId);

        if (selected.kind === 'commit' && result) {
          return {
            job: live,
            executedQuantumIds,
            remainingRunnable: listRunnableQuanta(live, nowFn()).length,
            result,
            lastError,
          };
        }
        job = live;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const operationalKind = extractOperationalKind(error)
          ?? (message.startsWith('invalid_completion_schema:') ? 'invalid_completion_schema' : undefined);
        const operationalReason = extractOperationalReason(error)
          ?? (message.startsWith('invalid_completion_schema:') ? 'schema-validation-error' : undefined);
        const operationalTranscripts = extractOperationalTranscripts(error);
        lastError = {
          message,
          ...(operationalKind ? { kind: operationalKind } : {}),
          ...(operationalReason ? { reason: operationalReason } : {}),
          ...(operationalTranscripts.length > 0 ? { transcriptPaths: operationalTranscripts } : {}),
          quantumId: selected.quantumId,
          quantumKind: selected.kind,
        };
        const terminal = /terminal|integrity|manifest/i.test(message);
        const mutation = this.mutateStore(after => {
          const live = after.jobs[jobId]!;
          if (operationalReason === 'runtime-shutdown' || operationalReason === 'external-abort') {
            const released = releaseQuantumCore(live, selected.quantumId, {
              leaseId: claim.lease.leaseId,
              ownerWakeId: claim.lease.ownerWakeId,
              message,
              reason: operationalReason,
              now: nowFn(),
            });
            if (released.ok) {
              const releasedQuantum = live.quanta[selected.quantumId]!;
              releasedQuantum.transcriptPaths = [...new Set([
                ...releasedQuantum.transcriptPaths,
                ...operationalTranscripts,
              ])];
              upsertEvidenceReviewJob(after, live);
            }
            return { live, changed: released.ok };
          }
          const failed = failQuantumCore(live, selected.quantumId, {
            message,
            leaseId: claim.lease.leaseId,
            ownerWakeId: claim.lease.ownerWakeId,
            now: nowFn(),
            retryBaseMs,
            retryMaxMs,
            ...(operationalKind ? { maxAttempts: Number.MAX_SAFE_INTEGER } : {}),
            terminal,
          });
          if (!failed.ok) return { live, changed: false };
          const failedQuantum = live.quanta[selected.quantumId]!;
          if (operationalKind === 'branch_timeout'
            || operationalKind === 'branch_failure'
            || operationalKind === 'invalid_completion_schema') {
            failedQuantum.failureKind = operationalKind;
            failedQuantum.failureReason = operationalReason;
            failedQuantum.transcriptPaths = [...new Set([
              ...failedQuantum.transcriptPaths,
              ...operationalTranscripts,
            ])];
            live.workClass = 'operational_recovery';
          }
          live.disposition = deriveJobDisposition(live);
          if (live.disposition === 'terminal_failed') live.terminalReason = message;
          live.updatedAt = nowFn().toISOString();
          const retrying = Object.values(live.quanta)
            .filter(q => q.state === 'retry_wait' && q.nextRetryAt)
            .map(q => q.nextRetryAt!)
            .sort();
          live.nextDueAt = retrying[0];
          upsertEvidenceReviewJob(after, live);
          return { live, changed: true };
        });
        job = mutation.live;
        if (mutation.changed) executedQuantumIds.push(selected.quantumId);
        if (!mutation.changed) {
          return {
            job: mutation.live,
            executedQuantumIds,
            remainingRunnable: listRunnableQuanta(mutation.live, nowFn()).length,
            result,
            lastError,
          };
        }
        // Cancellation and failure both yield at this wake boundary. Lifecycle
        // cancellation keeps the attempt budget; provider failure persists retry.
        break;
      } finally {
        clearInterval(renewalTimer);
        quantumBoundary.cleanup();
      }
    }

    const finalState = this.loadStore();
    const finalJob = finalState.jobs[jobId]!;
    return {
      job: finalJob,
      executedQuantumIds,
      remainingRunnable: listRunnableQuanta(finalJob, nowFn()).length,
      result,
      lastError,
    };
  }

  private async executeQuantum(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    signal?: AbortSignal,
    commitUnderLease?: CommitLeaseGuard,
  ): Promise<{
    result: unknown;
    transcriptPaths: string[];
    jobPatch?: Partial<EvidenceReviewJob>;
    skillResult?: SkillEvolutionResult;
  }> {
    switch (quantum.kind) {
      case 'author_reader':
      case 'verifier_reader':
        return this.executeReader(job, quantum, signal);
      case 'author_dossier':
        return this.executeDossier(job, 'author');
      case 'verifier_dossier':
        return this.executeDossier(job, 'verifier');
      case 'difference_index':
        return this.executeDifference(job);
      case 'obligations':
        return this.executeObligations(job);
      case 'skill_author':
        return this.executeSkillAuthor(job, signal);
      case 'skill_verifier':
        return this.executeSkillVerifier(job, signal);
      case 'commit':
        if (!commitUnderLease) throw new Error('commit lease guard is required');
        return this.executeCommit(job, quantum, commitUnderLease);
      default:
        throw new Error(`unknown quantum kind: ${(quantum as ReviewQuantumRecord).kind}`);
    }
  }

  private async executeReader(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    signal?: AbortSignal,
  ): Promise<{ result: ShardFindingSet; transcriptPaths: string[] }> {
    const shardId = quantum.shardId;
    if (!shardId) throw new Error('reader quantum missing shardId');
    const shard = job.shards[shardId];
    if (!shard) throw new Error(`missing shard ${shardId}`);
    if (!verifyShardContent(shard)) {
      throw new Error(`integrity: shard content hash mismatch for ${shardId}`);
    }
    const lane = quantum.lane ?? (quantum.kind === 'author_reader' ? 'author' : 'verifier');

    let findingSet: ShardFindingSet;
    let providedTranscript: string | undefined;
    if (this.options.runReaderLane) {
      const laneResult = await this.options.runReaderLane({ shard, lane, job, signal });
      if (!laneResult || !laneResult.findingSet) {
        throw new Error(`invalid_completion_schema: reader lane returned no finding set for ${lane}:${shardId}`);
      }
      findingSet = laneResult.findingSet;
      providedTranscript = laneResult.transcriptPath;
    } else {
      findingSet = readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane);
    }

    const validation = validateShardFindingSet(findingSet, shard, job.manifest, { expectedLane: lane });
    if (!validation.ok) {
      const first = validation.errors[0]!;
      throw new Error(`invalid_completion_schema: ${first.code}: ${first.message}`);
    }
    if (findingSet.coverage !== 'covered' && findingSet.coverage !== 'empty') {
      throw new Error(`reader coverage incomplete: ${findingSet.coverage}`);
    }

    const transcriptPath = providedTranscript && fs.existsSync(providedTranscript)
      ? providedTranscript
      : this.persistReaderTranscript(job, quantum, lane, shard, findingSet);

    return { result: findingSet, transcriptPaths: [transcriptPath] };
  }

  private persistReaderTranscript(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    lane: EvidenceReviewLane,
    shard: EvidenceShard,
    findingSet: ShardFindingSet,
  ): string {
    const root = path.join(this.options.workingDirectory, 'data', 'reader-transcripts');
    const jobDir = path.join(root, sanitizeFilePart(job.jobId));
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(
      jobDir,
      `${sanitizeFilePart(quantum.quantumId)}-${lane}.jsonl`,
    );
    // Deterministic job/quantum ids are reused across completed-job recreations.
    // Always rewrite the reader artifact for this quantum so prior-run appends
    // cannot invalidate Transition Audit transcript hashes.
    fs.writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
    const write = (eventType: string, payload: Record<string, unknown>): void => {
      const entry = {
        entry_type: 'reader',
        branch_type: `evidence-${lane}-reader`,
        branch_id: quantum.quantumId,
        event_type: eventType,
        timestamp: new Date().toISOString(),
        jobId: job.jobId,
        shardId: shard.shardId,
        contentHash: shard.contentHash,
        lane,
        ...payload,
      };
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    };
    write('start', {
      quantumKind: quantum.kind,
      byteLength: shard.byteLength,
    });
    write('fixture_result', {
      coverage: findingSet.coverage,
      findingCount: findingSet.findings.length,
      findingIds: findingSet.findings.map(f => f.findingId),
    });
    write('transcript', {
      messages: [
        {
          role: 'system',
          content: `Independent ${lane} reader over immutable shard ${shard.shardId}`,
        },
        {
          role: 'assistant',
          content: JSON.stringify({
            shardId: findingSet.shardId,
            contentHash: findingSet.contentHash,
            lane: findingSet.lane,
            coverage: findingSet.coverage,
            findings: findingSet.findings,
          }),
        },
      ],
    });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // best-effort permissions
    }
    return filePath;
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

  private async executeSkillAuthor(
    job: EvidenceReviewJob,
    signal?: AbortSignal,
  ): Promise<{
    result: SkillDraft;
    transcriptPaths: string[];
    jobPatch: Partial<EvidenceReviewJob>;
  }> {
    if (!job.authorDossier) {
      throw new Error('skill_author requires author dossier');
    }
    const round = job.revisionRound ?? 1;
    const outcome = await this.options.runSkillAuthor({
      bundle: job.bundle,
      authorDossier: job.authorDossier,
      job,
      round,
      ...(round === 2 && job.previousDraft ? { previousDraft: job.previousDraft } : {}),
      ...(round === 2 && job.round1VerifierIssues ? { verifierIssues: job.round1VerifierIssues } : {}),
      signal,
    });
    if (!outcome?.draft) {
      throw new Error('invalid_completion_schema: skill_author returned no draft');
    }
    return {
      result: outcome.draft,
      transcriptPaths: outcome.transcriptPaths ?? [],
      jobPatch: { draft: outcome.draft },
    };
  }

  private async executeSkillVerifier(
    job: EvidenceReviewJob,
    signal?: AbortSignal,
  ): Promise<{
    result: { verifier: SkillVerifierResult; dispositions: readonly ObligationDisposition[] };
    transcriptPaths: string[];
    jobPatch: Partial<EvidenceReviewJob>;
  }> {
    if (!job.authorDossier || !job.verifierDossier || !job.differenceIndex || !job.obligations) {
      throw new Error('skill_verifier requires dossiers, difference index, and obligations');
    }
    const draft = job.draft ?? this.readSucceededQuantumResult<SkillDraft>(job, 'skill_author');
    if (!draft) {
      throw new Error('skill_verifier requires skill_author draft');
    }
    const round = job.revisionRound ?? 1;
    const outcome = await this.options.runSkillVerifier({
      bundle: job.bundle,
      draft,
      authorDossier: job.authorDossier,
      verifierDossier: job.verifierDossier,
      differenceIndex: job.differenceIndex,
      obligations: job.obligations,
      job,
      round,
      signal,
    });
    if (!outcome?.verifier) {
      throw new Error('invalid_completion_schema: skill_verifier returned no verifier result');
    }
    const dispositions = outcome.dispositions ?? [];
    const validation = validateObligationDispositions(
      job.obligations,
      dispositions,
      Object.values(job.shards),
    );
    if (!validation.ok) {
      throw new Error(
        `invalid_completion_schema: skill_verifier obligation dispositions invalid: ${validation.errors.join('; ')}`,
      );
    }
    return {
      result: { verifier: outcome.verifier, dispositions },
      transcriptPaths: outcome.transcriptPaths ?? [],
      jobPatch: {
        draft,
        verifierResult: outcome.verifier,
        obligationDispositions: dispositions,
      },
    };
  }

  private async executeCommit(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    commitUnderLease: CommitLeaseGuard,
  ): Promise<{
    result: SkillEvolutionResult;
    transcriptPaths: string[];
    jobPatch: Partial<EvidenceReviewJob>;
    skillResult: SkillEvolutionResult;
  }> {
    const draft = job.draft ?? this.readSucceededQuantumResult<SkillDraft>(job, 'skill_author');
    const verifierPayload = job.verifierResult
      ? { verifier: job.verifierResult, dispositions: job.obligationDispositions ?? [] }
      : this.readSucceededQuantumResult<{
        verifier: SkillVerifierResult;
        dispositions: readonly ObligationDisposition[];
      }>(job, 'skill_verifier');
    if (!draft || !verifierPayload?.verifier) {
      throw new Error('commit requires skill_author draft and skill_verifier result');
    }
    const obligations = job.obligations ?? [];
    const dispositions = verifierPayload.dispositions ?? [];
    const shards = Object.values(job.shards);
    const validation = validateObligationDispositions(obligations, dispositions, shards);
    if (!validation.ok) {
      throw new Error(
        `invalid_completion_schema: commit blocked by invalid obligation dispositions: ${validation.errors.join('; ')}`,
      );
    }

    // Accept remains fail-closed on unresolved obligations. Non-accept outcomes
    // (semantic defer/reject) still go through commitTransition so audit/queue
    // side effects stay intact; only missing/invalid dispositions schema-fail.
    let verifierForCommit = verifierPayload.verifier;
    if (
      verifierForCommit.decision === 'accept'
      && !allObligationsResolvedForCommit(obligations, dispositions, shards)
    ) {
      verifierForCommit = {
        ...verifierForCommit,
        decision: 'defer',
        rationale: verifierForCommit.rationale?.trim()
          || 'Unresolved review obligations remain; deferring Capability Transition commit.',
      };
    }

    // Exhausted revision loop: if the final-round verifier still returns
    // 'revise' after both rounds, preserve legacy semantics - danger issue
    // -> reject; otherwise -> defer. This prevents weakening the Verifier or
    // forcing revise to accept.
    const round = job.revisionRound ?? 1;
    if (verifierForCommit.decision === 'revise') {
      const dangerous = verifierForCommit.issues.some(issue => issue.severity === 'danger');
      verifierForCommit = {
        ...verifierForCommit,
        decision: dangerous ? 'reject' : 'defer',
        rationale: verifierForCommit.rationale?.trim()
          || `Revision loop exhausted after round ${round}; ${dangerous ? 'danger issue -> reject' : 'non-danger revise -> defer'}.`,
      };
    }

    const branchTranscriptPaths = successfulTranscriptPaths(job);
    const reviewCommitKey = quantum.commitIntent?.key ?? `${job.jobId}:${quantum.quantumId}`;
    // The Transition Audit is the authoritative external receipt. If a process
    // crashed after journal/audit commit but before completing this Quantum,
    // reconcile by stable key instead of invoking the side effect again.
    const recovered = this.options.recoverCommittedTransition?.({
      bundle: job.bundle,
      draft,
      verifier: verifierForCommit,
      job,
      branchTranscriptPaths,
      round,
      reviewCommitKey,
    });
    const committed = recovered ?? await this.options.commitTransition({
      bundle: job.bundle,
      draft,
      verifier: verifierForCommit,
      job,
      branchTranscriptPaths,
      round,
      reviewCommitKey,
      commitUnderLease,
    });
    const isDeferred = committed.transition === 'defer' || committed.queued === 'deferred';
    const skillResult: SkillEvolutionResult = isDeferred
      ? { ...committed, queued: 'deferred', queueEntryId: job.jobId }
      : committed;

    // commitTransition may have superseded the job (stale Review Basis).
    const reloaded = this.loadStore().jobs[job.jobId];
    if (reloaded?.disposition === 'superseded' || reloaded?.supersededByJobId) {
      return {
        result: skillResult,
        transcriptPaths: branchTranscriptPaths,
        jobPatch: {
          disposition: 'superseded',
          supersededByJobId: reloaded.supersededByJobId,
          terminalReason: reloaded.terminalReason,
        },
        skillResult,
      };
    }

    // Operational queue means the commit quantum itself did not finish — retry later.
    if (skillResult.queued === 'operational' && !skillResult.transitionId && !skillResult.audit) {
      throw new Error('commit deferred to operational retry queue');
    }

    const jobPatch: Partial<EvidenceReviewJob> = {
      draft,
      // Persist the NORMALIZED final verifier so reload/reconstruction returns
      // reject_candidate + verified=false for danger, and defer + verified=false
      // for ordinary revise exhaustion — not the original 'revise' decision.
      verifierResult: verifierForCommit,
      obligationDispositions: verifierPayload.dispositions ?? job.obligationDispositions,
      transitionId: committed.transitionId ?? committed.audit?.transitionId,
    };
    if (isDeferred) {
      jobPatch.disposition = 'deferred';
      jobPatch.workClass = 'semantic_reassessment';
      jobPatch.deferState = {
        reviewerVersion: this.options.reviewerVersion ?? job.basis.reviewPolicyVersion,
        reason: committed.verifier?.rationale
          ?? job.verifierResult?.rationale
          ?? 'Verifier deferred for later review.',
        deferredAt: new Date().toISOString(),
      };
    }

    return {
      result: skillResult,
      transcriptPaths: branchTranscriptPaths,
      jobPatch,
      skillResult,
    };
  }

  private readSucceededQuantumResult<T>(
    job: EvidenceReviewJob,
    kind: ReviewQuantumRecord['kind'],
  ): T | undefined {
    const quantum = Object.values(job.quanta).find(q => q.kind === kind && q.state === 'succeeded');
    return quantum?.result as T | undefined;
  }

  /**
   * Fail-closed reconciliation for the atomicity seam between round-1
   * verifier completion and revision graph expansion.
   *
   * If a crash interrupted the single durable write that completes the
   * round-1 verifier and expands the graph, the persisted state may contain:
   * - a succeeded round-1 skill_verifier with decision 'revise'
   * - revisionRound !== 2 (expansion never persisted)
   * - a still-runnable old commit quantum depending on that verifier
   * - no round-2 skill_author / skill_verifier nodes
   *
   * This method detects that seam and expands the graph before any runnable
   * selection so the old commit can never execute and commit round 1.
   *
   * Idempotent: if the graph is already expanded (revisionRound === 2 or no
   * succeeded round-1 verifier with 'revise'), this is a no-op.
   */
  private reconcileRevisionRound(
    state: EvidenceReviewJobStoreState,
    job: EvidenceReviewJob,
    now: Date,
  ): void {
    if (job.revisionRound === 2) return;
    if (job.disposition !== 'active') return;

    // Find a succeeded round-1 skill_verifier with 'revise'.
    const round1Verifier = Object.values(job.quanta).find(
      q => q.kind === 'skill_verifier' && q.state === 'succeeded',
    );
    if (!round1Verifier) return;

    const verifierPayload = round1Verifier.result as
      | { verifier: SkillVerifierResult; dispositions: readonly ObligationDisposition[] }
      | undefined;
    if (!verifierPayload?.verifier || verifierPayload.verifier.decision !== 'revise') {
      return;
    }

    // If round-2 nodes already exist, the expansion was persisted — no-op.
    // The maybeExpandRevisionRound guard on revisionRound === 2 handles this,
    // but we also check for multiple skill_author quanta as a structural guard.
    const skillAuthorCount = Object.values(job.quanta)
      .filter(q => q.kind === 'skill_author').length;
    if (skillAuthorCount > 1) return;

    // Seam detected: expand the graph so the old commit is removed.
    this.maybeExpandRevisionRound(state, job, round1Verifier.quantumId, now);
  }

  /**
   * Expand the graph with round-2 Author/Verifier/commit quanta after round-1
   * skill_verifier returns 'revise'. This is a deterministic, content-identified
   * graph expansion within the same job:
   *
   * - Round-2 skill_author identity includes round=2, previousDraftHash, and
   *   verifierIssuesHash so it is distinct from round-1.
   * - Round-2 skill_verifier depends on round-2 skill_author + the same
   *   dossiers/diff/obligations as round-1.
   * - The old commit quantum (which depended on round-1 verifier) is removed.
   * - A new commit quantum depends on round-2 skill_verifier.
   * - job.previousDraft and job.round1VerifierIssues are set so round-2
   *   executeSkillAuthor can pass them to the runSkillAuthor callback.
   *
   * Idempotent: if job.revisionRound === 2 or the verifier decision is not
   * 'revise', no expansion occurs. Successful round-1 quanta are never replayed.
   *
   * Returns true if the graph was expanded (or was already expanded).
   */
  private maybeExpandRevisionRound(
    state: EvidenceReviewJobStoreState,
    job: EvidenceReviewJob,
    round1VerifierQuantumId: string,
    now: Date,
  ): boolean {
    // Already expanded — idempotence for crash/restart at this seam.
    if (job.revisionRound === 2) return false;

    const round1Verifier = job.quanta[round1VerifierQuantumId];
    if (!round1Verifier || round1Verifier.state !== 'succeeded') return false;

    const verifierPayload = round1Verifier.result as
      | { verifier: SkillVerifierResult; dispositions: readonly ObligationDisposition[] }
      | undefined;
    if (!verifierPayload?.verifier || verifierPayload.verifier.decision !== 'revise') {
      return false;
    }

    // Retrieve round-1 draft from the succeeded skill_author quantum.
    const round1Author = Object.values(job.quanta).find(
      q => q.kind === 'skill_author' && q.state === 'succeeded',
    );
    if (!round1Author) return false;
    const previousDraft = round1Author.result as SkillDraft | undefined;
    if (!previousDraft) return false;

    const verifierIssues = verifierPayload.verifier.issues;

    // Find the existing dependency quanta to wire round-2 nodes.
    const authorDossier = Object.values(job.quanta).find(
      q => q.kind === 'author_dossier' && q.state === 'succeeded',
    );
    const verifierDossier = Object.values(job.quanta).find(
      q => q.kind === 'verifier_dossier' && q.state === 'succeeded',
    );
    const differenceIndex = Object.values(job.quanta).find(
      q => q.kind === 'difference_index' && q.state === 'succeeded',
    );
    const obligations = Object.values(job.quanta).find(
      q => q.kind === 'obligations' && q.state === 'succeeded',
    );
    if (!authorDossier || !verifierDossier || !differenceIndex || !obligations) {
      return false;
    }

    // Find and remove the old commit quantum (it depended on round-1 verifier).
    const oldCommit = Object.values(job.quanta).find(q => q.kind === 'commit');
    if (oldCommit) {
      delete job.quanta[oldCommit.quantumId];
    }

    // Create round-2 skill_author quantum.
    // Identity includes round=2, previousDraftHash, and verifierIssuesHash
    // so it is distinct from the round-1 skill_author.
    const previousDraftHash = sha256(stableStringify(previousDraft));
    const verifierIssuesHash = sha256(stableStringify(verifierIssues));
    const skillAuthorR2 = createReviewQuantum(job.jobId, {
      kind: 'skill_author',
      inputs: {
        authorDossier: authorDossier.quantumId,
        round: 2,
        previousDraftHash,
        verifierIssuesHash,
      },
      dependencyQuantumIds: [authorDossier.quantumId, obligations.quantumId],
    }, now);
    job.quanta[skillAuthorR2.quantumId] = skillAuthorR2;

    // Create round-2 skill_verifier quantum.
    const skillVerifierR2 = createReviewQuantum(job.jobId, {
      kind: 'skill_verifier',
      inputs: {
        author: skillAuthorR2.quantumId,
        dossiers: [authorDossier.quantumId, verifierDossier.quantumId],
        difference: differenceIndex.quantumId,
        obligations: obligations.quantumId,
        round: 2,
      },
      dependencyQuantumIds: [
        skillAuthorR2.quantumId,
        verifierDossier.quantumId,
        differenceIndex.quantumId,
        obligations.quantumId,
      ],
    }, now);
    job.quanta[skillVerifierR2.quantumId] = skillVerifierR2;

    // Create new commit quantum depending on round-2 verifier.
    const newCommit = createReviewQuantum(job.jobId, {
      kind: 'commit',
      inputs: {
        basisHash: job.basis.basisHash,
        skillVerifier: skillVerifierR2.quantumId,
        round: 2,
      },
      dependencyQuantumIds: [skillVerifierR2.quantumId],
    }, now);
    job.quanta[newCommit.quantumId] = newCommit;

    // Preserve round-1 results for round-2 Author input.
    job.previousDraft = previousDraft;
    job.round1VerifierIssues = verifierIssues;
    job.revisionRound = 2;
    job.updatedAt = now.toISOString();

    upsertEvidenceReviewJob(state, job);
    return true;
  }
}

function successfulTranscriptPaths(job: EvidenceReviewJob): string[] {
  const paths: string[] = [];
  for (const quantum of Object.values(job.quanta)) {
    if (quantum.state !== 'succeeded') continue;
    // Retry history remains on the Quantum for diagnostics, but commit
    // reconstruction must validate the transcript from the successful attempt.
    const p = quantum.transcriptPaths.at(-1);
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'quantum';
}

const QUANTUM_ABORT_SETTLE_GRACE_MS = 1_000;

async function awaitQuantumExecution<T>(execution: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw reviewAbortError(signal.reason, 'Review quantum aborted before execution.');
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (abortGraceTimer) clearTimeout(abortGraceTimer);
      callback();
    };
    const boundaryError = (sourceError?: unknown) => {
      const error = reviewAbortError(
        signal.reason,
        'Review quantum exceeded its execution boundary.',
      );
      const transcriptPaths = extractOperationalTranscripts(sourceError);
      return transcriptPaths.length > 0
        ? Object.assign(error, { transcriptPaths })
        : error;
    };
    const onAbort = () => {
      // Give the active branch one bounded grace period to flush its failure
      // audit and reject with transcript metadata. Never wait indefinitely for
      // a provider that ignores cancellation.
      abortGraceTimer = setTimeout(
        () => finish(() => reject(boundaryError())),
        QUANTUM_ABORT_SETTLE_GRACE_MS,
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    execution.then(
      value => finish(() => {
        if (signal.aborted) reject(boundaryError());
        else resolve(value);
      }),
      error => finish(() => reject(signal.aborted ? boundaryError(error) : error)),
    );
  });
}

function createNonInterruptibleCommitBoundary(): { signal: AbortSignal; cleanup: () => void } {
  return {
    signal: new AbortController().signal,
    cleanup: () => undefined,
  };
}

function createQuantumAbortBoundary(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(normalizeExternalAbortReason(externalSignal?.reason));
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort('quantum-timeout'),
    Math.max(1, timeoutMs),
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

function normalizeExternalAbortReason(reason: unknown): 'runtime-shutdown' | 'attempt-deadline-exceeded' | 'external-abort' {
  if (reason === 'runtime-shutdown') return 'runtime-shutdown';
  if (reason === 'attempt-deadline-exceeded' || reason === 'review-timeout') {
    return 'attempt-deadline-exceeded';
  }
  return 'external-abort';
}

function reviewAbortError(reason: unknown, message: string): Error {
  const failureReason: ReviewOperationalFailureReason = reason === 'quantum-timeout'
    ? 'quantum-timeout'
    : normalizeExternalAbortReason(reason);
  const kind: ReviewOperationalFailureKind = failureReason === 'quantum-timeout'
    || failureReason === 'attempt-deadline-exceeded'
    ? 'branch_timeout'
    : 'branch_failure';
  return Object.assign(new Error(`${message} Cause: ${failureReason}.`), {
    name: 'AbortError',
    kind,
    reviewFailureReason: failureReason,
  });
}

function extractOperationalKind(error: unknown): ReviewOperationalFailureKind | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return kind === 'branch_timeout'
    || kind === 'branch_failure'
    || kind === 'invalid_completion_schema'
    ? kind
    : undefined;
}

function extractOperationalReason(error: unknown): ReviewOperationalFailureReason | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const reason = (error as { reviewFailureReason?: unknown }).reviewFailureReason;
  return reason === 'quantum-timeout'
    || reason === 'attempt-deadline-exceeded'
    || reason === 'runtime-shutdown'
    || reason === 'external-abort'
    || reason === 'reader-error'
    || reason === 'schema-validation-error'
    ? reason
    : undefined;
}

function extractOperationalTranscripts(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const paths = (error as { transcriptPaths?: unknown }).transcriptPaths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
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
    /** Independent hard deadline for each claimed Quantum. */
    quantumTimeoutMs?: number;
    shouldStopClaiming?: () => boolean;
  },
): Promise<{ claims: number; jobIds: string[] }> {
  const plan = engine.mutateStore(state => {
    const planned = planFairQuantumClaims(state, {
      maxClaims: options.maxClaims,
      maxClaimsPerJob: options.maxClaimsPerJob ?? 1,
      now: options.now,
    });
    state.fairness = planned.fairness;
    return planned;
  });

  const touched = new Set<string>();
  let executedClaims = 0;
  for (const claim of plan.claims) {
    if (options.signal?.aborted || options.shouldStopClaiming?.()) break;
    const advanced = await engine.advanceJob(
      claim.jobId,
      `${wakeId}:${claim.jobId}:${claim.quantumId}`,
      options.signal,
      {
        quantumId: claim.quantumId,
        maxQuanta: 1,
        quantumTimeoutMs: options.quantumTimeoutMs,
        shouldStopClaiming: options.shouldStopClaiming,
      },
    );
    if (advanced.executedQuantumIds.length === 0) continue;
    executedClaims += advanced.executedQuantumIds.length;
    touched.add(claim.jobId);
  }
  return { claims: executedClaims, jobIds: [...touched] };
}

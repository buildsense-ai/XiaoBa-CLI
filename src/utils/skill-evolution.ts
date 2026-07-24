import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { readRequiredDefaultPromptFile } from './prompt-template';
import {
  BranchSession,
  BranchSessionAbortError,
  BranchSessionOptions,
  BranchReviewAttemptMetadata,
  SharedReviewTurnBudget,
} from '../core/branch-session';
import { Message } from '../types';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { AIService } from './ai-service';
import { PathResolver } from './path-resolver';
import { SkillParser } from '../skills/skill-parser';
import {
  findDeferredJobByBundleId,
  findOperationalJobByBundleId,
  upsertEvidenceReviewJob,
} from './evidence-review-job-store';

/** Operational failure category for retry backoff (moved from deleted legacy queue module). */
export type OperationalReviewFailureKind = import('./evidence-review-types').ReviewOperationalFailureKind;
import { DistilledKnowledgeCandidate } from './capability-distiller';
import type { SemanticObservation } from './learning-episode';
import {
  EvidenceReviewEngine,
  resolveEvidenceReviewJobStorePath,
  type ReaderLaneInput,
  type ReaderLaneResult,
} from './evidence-review-engine';
import { runModelBackedReaderLane } from './evidence-review-reader-branch';
import type {
  EvidenceDossier,
  DossierDifferenceIndex,
  ObligationDisposition,
  ReviewObligation,
  ReviewWorkClass,
  EvidenceReviewJob,
} from './evidence-review-types';
import { hashEvidenceBundle } from './evidence-review';
import { createEvidenceReviewJob } from './evidence-review-graph';
import { detectDuplicateCapabilityCreation } from './capability-update-guidance';
import {
  createSuccessorReviewJob,
  decideReviewCommitFence,
  markJobSuperseded,
  resolveLiveDeclaredRegistryReadSet,
} from './evidence-review-commit-fence';
import {
  EVIDENCE_REVIEW_POLICY_VERSION,
  EVIDENCE_REVIEW_PROMPT_VERSION,
} from './evidence-review-types';
import {
  classifyEvidenceBundleAuthority,
  containsExactStableIdentifier,
  migratePersistedEvidenceBundleAuthority,
  requireExplicitEvidenceBundleAuthority,
  semanticPriorGuidanceEvidenceRef,
  type EvidenceBundleAuthority,
} from './evidence-bundle-authority';
import { validateFrozenSourceEvidence } from './frozen-source-evidence';

/**
 * V3's runtime-owned promotion seam.
 *
 * The branch outputs in this file are deliberately small control-plane
 * envelopes. The Markdown body is the only agent-facing guidance; identity,
 * traceability, and persistence are supplied by the runtime after the
 * independent verifier accepts the draft.
 */

export const SKILL_EVOLUTION_SCHEMA_VERSION = 2 as const;
export const SKILL_EVOLUTION_REVIEWER_VERSION = 'skill-evolution-v3';
export const MAX_AUTHOR_VERIFIER_ROUNDS = 2;
const DEFAULT_REVIEW_ATTEMPT_MAX_TURNS = 4;
const DEFAULT_REVIEW_ATTEMPT_DEADLINE_MS = 10 * 60 * 1000;

export type CapabilityTransitionKind =
  | 'create_current_skill'
  | 'append_evidence'
  | 'replace_current_skill'
  | 'migrate_skill_route'
  | 'merge_into_capability'
  | 'retire_capability'
  | 'restore_capability_revision'
  | 'defer'
  | 'reject_candidate';

export interface SkillEvidenceRef {
  ref: string;
  sourceFilePath?: string;
  turn?: number;
  byteRange?: { start: number; end: number };
}

export interface ReferencedSkillSnapshot {
  name: string;
  version?: string;
  contentFingerprint?: string;
  capabilityHandle?: string;
  guidanceHash?: string;
  /** Hash of executable guidance only, excluding route/frontmatter metadata. */
  guidanceContentHash?: string;
  /** Bounded read-only observation supplied to Author/Verifier branches. */
  content?: string;
}

export interface BoundedSourceEvidence extends SkillEvidenceRef {
  role: 'problem-action' | 'verification';
  content: string;
}

export interface RelatedCurrentSkill {
  handle: string;
  revision: number;
  routingName: string;
  description: string;
  guidanceHash: string;
}

export interface TrustedReferencedSkillIdentity {
  capabilityHandle: string;
  routingName: string;
  guidanceHash: string;
}

export interface RuntimeOwnedReferencedSkillProvenance {
  kind: 'runtime-owned-generated-skill-load-v1';
  runtimeSessionId: string;
  agentTurnEpisodeId: string;
  referencedSkills: readonly TrustedReferencedSkillIdentity[];
}

/** The one fixed input shared by Author and Verifier branches. */
export interface EvidenceBundle {
  bundleId: string;
  /**
   * Explicit mutation authority for newly-created bundles. Optional only so
   * persisted pre-authority bundles can be classified through one fail-closed
   * legacy compatibility path.
   */
  authority?: EvidenceBundleAuthority;
  episode: unknown;
  completionEvidence: readonly SkillEvidenceRef[];
  settlementEvidence: readonly SkillEvidenceRef[];
  boundedContinuity: readonly unknown[];
  referencedSkills: readonly ReferencedSkillSnapshot[];
  relatedCurrentSkills: readonly RelatedCurrentSkill[];
  /** Optional trusted marker for ordinary bundle retry normalization. */
  referencedSkillProvenance?: RuntimeOwnedReferencedSkillProvenance;
  /** Optional for legacy callers; production V3 bundles always supply it. */
  semanticObservations?: readonly SemanticObservation[];
  /** Optional for compatibility; production construction always supplies it. */
  sourceEvidence?: readonly BoundedSourceEvidence[];
}

export interface SkillAuthoringEnvelope {
  decision: CapabilityTransitionKind;
  routingName?: string;
  description?: string;
  referencedSkills?: string[];
  evidenceRefs?: string[];
  targetCapabilityHandle?: string;
  sourceCapabilityHandle?: string;
  rationale?: string;
}

export interface SkillDraft {
  body: string;
  envelope: SkillAuthoringEnvelope;
}

export interface SkillVerifierIssue {
  code: string;
  message: string;
  severity?: 'warning' | 'error' | 'danger';
}

export interface SkillVerifierResult {
  decision: 'accept' | 'revise' | 'defer' | 'reject';
  transition?: CapabilityTransitionKind;
  issues: SkillVerifierIssue[];
  rationale: string;
  /** Capability Handles and revisions observed by this review. */
  registryReadSet?: CapabilityReadSetEntry[];
  /** Explicit final dispositions over Evidence Review obligations. */
  obligationDispositions?: ObligationDisposition[];
}

const VERIFIER_DECISION_STRICTNESS: Record<SkillVerifierResult['decision'], number> = {
  accept: 0,
  revise: 1,
  defer: 2,
  reject: 3,
};

function stricterVerifierDecision(
  left: SkillVerifierResult['decision'],
  right: SkillVerifierResult['decision'],
): SkillVerifierResult['decision'] {
  return VERIFIER_DECISION_STRICTNESS[left] >= VERIFIER_DECISION_STRICTNESS[right]
    ? left
    : right;
}

function applyVerifierDecisionGate(
  verification: SkillVerifierResult,
  gate: SkillVerifierResult,
): SkillVerifierResult {
  return {
    decision: stricterVerifierDecision(verification.decision, gate.decision),
    issues: [...gate.issues, ...verification.issues],
    rationale: `${verification.rationale} ${gate.rationale}`.trim(),
    ...(verification.registryReadSet ? { registryReadSet: verification.registryReadSet } : {}),
    ...(verification.obligationDispositions
      ? { obligationDispositions: verification.obligationDispositions }
      : {}),
  };
}

export interface CapabilityReadSetEntry {
  handle: string;
  revision: number;
}

export interface SkillAuthorBranchInput {
  bundle: EvidenceBundle;
  previousDraft?: SkillDraft;
  verifierIssues?: readonly SkillVerifierIssue[];
  round: number;
}

export type SkillAuthorFixture = (
  input: SkillAuthorBranchInput,
) => SkillDraft | Promise<SkillDraft>;

export interface SkillVerifierBranchInput {
  bundle: EvidenceBundle;
  draft: SkillDraft;
  round: number;
}

export type SkillVerifierFixture = (
  input: SkillVerifierBranchInput,
) => SkillVerifierResult | Promise<SkillVerifierResult>;

export interface SkillAuthorBranchOptions extends Omit<BranchSessionOptions, 'type'> {
  bundle: EvidenceBundle;
  round: number;
  previousDraft?: SkillDraft;
  verifierIssues?: readonly SkillVerifierIssue[];
  fixture?: SkillAuthorFixture;
}

export interface SkillVerifierBranchOptions extends Omit<BranchSessionOptions, 'type'> {
  bundle: EvidenceBundle;
  draft: SkillDraft;
  round: number;
  fixture?: SkillVerifierFixture;
}

/** A constrained branch with only one completion tool and no write tools. */
export class SkillAuthorBranchSession extends BranchSession {
  private payload: SkillDraft | null = null;

  constructor(private readonly authorOptions: SkillAuthorBranchOptions) {
    super({ ...authorOptions, type: 'skill-author', stream: true, logEnabled: true, transcriptContract: 'required' });
  }

  async run(): Promise<SkillDraft> {
    return this.runWithTerminalAudit(async () => {
      if (!this.shouldContinue()) {
        this.throwAbortError();
      }
      if (this.authorOptions.fixture) {
        this.logStart({ message_count: 0, execution: 'fixture' });
        const draft = await this.authorOptions.fixture({
          bundle: this.authorOptions.bundle,
          previousDraft: this.authorOptions.previousDraft,
          verifierIssues: this.authorOptions.verifierIssues,
          round: this.authorOptions.round,
        });
        this.payload = draft;
        this.logger.write('fixture_result', { round: this.authorOptions.round, draft });
        this.logger.write('transcript', { messages: this.messages });
        return draft;
      }

      while (this.shouldContinue() && !this.payload) {
        const outcome = await this.runConversation();
        if (!this.payload) {
          this.messages.push({
            role: 'user',
            content: readRequiredDefaultPromptFile('subagents/skill-author-finish-nudge.md'),
          });
          if (!outcome.result) break;
        }
      }
      if (!this.payload) {
        this.throwAbortError();
      }
      return this.payload;
    });
  }

  protected async buildInitialMessages(): Promise<Message[]> {
    return [
      {
        role: 'system',
        content: readRequiredDefaultPromptFile('subagents/skill-author.md'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          evidence_bundle: this.authorOptions.bundle,
          round: this.authorOptions.round,
          previousDraft: this.authorOptions.previousDraft ?? null,
          verifierIssues: this.authorOptions.verifierIssues ?? [],
        }),
      },
    ];
  }

  protected buildTools(): Tool[] {
    return [new FinishSkillAuthoringTool(payload => {
      this.payload = payload;
    })];
  }

  get transcriptPath(): string | null {
    return this.getBranchTranscriptPath();
  }
}

/** A separate constrained branch that cannot mutate the Author's context. */
export class SkillVerifierBranchSession extends BranchSession {
  private payload: SkillVerifierResult | null = null;

  constructor(private readonly verifierOptions: SkillVerifierBranchOptions) {
    super({ ...verifierOptions, type: 'skill-verifier', stream: true, logEnabled: true, transcriptContract: 'required' });
  }

  async run(): Promise<SkillVerifierResult> {
    return this.runWithTerminalAudit(async () => {
      if (!this.shouldContinue()) {
        this.throwAbortError();
      }
      if (this.verifierOptions.fixture) {
        this.logStart({ message_count: 0, execution: 'fixture' });
        const result = await this.verifierOptions.fixture({
          bundle: this.verifierOptions.bundle,
          draft: this.verifierOptions.draft,
          round: this.verifierOptions.round,
        });
        this.payload = normalizeVerifierResult(result);
        this.logger.write('fixture_result', { round: this.verifierOptions.round, result: this.payload });
        this.logger.write('transcript', { messages: this.messages });
        return this.payload;
      }

      while (this.shouldContinue() && !this.payload) {
        const outcome = await this.runConversation();
        if (!this.payload) {
          this.messages.push({
            role: 'user',
            content: readRequiredDefaultPromptFile('subagents/skill-verifier-finish-nudge.md'),
          });
          if (!outcome.result) break;
        }
      }
      if (!this.payload) {
        this.throwAbortError();
      }
      return this.payload;
    });
  }

  protected async buildInitialMessages(): Promise<Message[]> {
    return [
      {
        role: 'system',
        content: readRequiredDefaultPromptFile('subagents/skill-verifier.md'),
      },
      { role: 'user', content: JSON.stringify({ evidence_bundle: this.verifierOptions.bundle, round: this.verifierOptions.round, draft: this.verifierOptions.draft }) },
    ];
  }

  protected buildTools(): Tool[] {
    return [new FinishSkillVerificationTool(payload => {
      this.payload = normalizeVerifierResult(payload);
    })];
  }

  get transcriptPath(): string | null {
    return this.getBranchTranscriptPath();
  }
}

export interface CurrentSkillRecord {
  handle: string;
  revision: number;
  routingName: string;
  description: string;
  skillFilePath: string;
  guidanceHash: string;
  /** Stable hash of the executable Markdown body, excluding route metadata. */
  guidanceContentHash?: string;
  evidenceRefs: SkillEvidenceRef[];
  referencedSkills: ReferencedSkillSnapshot[];
  /** Durable bounded observations used for future semantic reassessment. */
  semanticObservations?: SemanticObservation[];
  createdAt: string;
  updatedAt: string;
}

export interface CurrentSkillRegistryState {
  schemaVersion: typeof SKILL_EVOLUTION_SCHEMA_VERSION;
  catalogRevision: number;
  routeRedirects: Record<string, string>;
  capabilities: Record<string, CurrentSkillRecord>;
}

export interface TransitionAuditEntry {
  schemaVersion: typeof SKILL_EVOLUTION_SCHEMA_VERSION;
  transitionId: string;
  transition: CapabilityTransitionKind;
  /** Stable input identity, used by bootstrap recovery to avoid re-review. */
  bundleId?: string;
  occurredAt: string;
  reviewerVersion: string;
  promptVersion: string;
  evidenceRefs: string[];
  involvedCapabilityHandles: string[];
  registryReadSet: CapabilityReadSetEntry[];
  /** Null means this side of the transition has no current guidance. */
  priorGuidanceHash: string | null;
  /** For merge, this is the surviving target guidance hash. */
  resultingGuidanceHash: string | null;
  /** Public route before/after a semantic route migration. */
  priorRoutingName?: string | null;
  resultingRoutingName?: string | null;
  branchTranscriptPaths: string[];
  /** SHA-256 content hashes aligned with branchTranscriptPaths. */
  branchTranscriptHashes?: string[];
  rationale: string;
}

export interface SkillEvolutionPaths {
  outputDir: string;
  registryPath: string;
  auditPath: string;
  journalPath: string;
  branchLogRoot?: string;
  reviewQueuePath?: string;
}

/**
 * Durable commit fence callback (#109).
 * Invoked inside the commit boundary immediately before applyCapabilityTransition
 * / journal / audit write. Returning a SkillEvolutionResult aborts the commit
 * without writing the journal.
 */
type BeforeAcceptedCommitHook = (input: {
  bundle: EvidenceBundle;
  draft: SkillDraft;
  verifier: SkillVerifierResult;
  transition: CapabilityTransitionKind;
  round: number;
  branchTranscriptPaths: readonly string[];
}) => SkillEvolutionResult | undefined | Promise<SkillEvolutionResult | undefined>;

export interface SkillEvolutionOptions extends SkillEvolutionPaths {
  workingDirectory: string;
  aiService?: AIService;
  manualSkillNames?: readonly string[];
  reviewAttemptSignal?: AbortSignal;
  reviewAttemptDeadlineMs?: number;
  reviewQueuePath?: string;
  settlementWindowMs?: number;
  reviewerConcurrency?: number;
  operationalRetryMs?: number;
  operationalRetryMaxMs?: number;
  authorModel?: string;
  verifierModel?: string;
  /** Optional model override for dual-lane Evidence Readers (falls back to author/verifier model). */
  readerModel?: string;
  reviewerVersion?: string;
  promptVersion?: string;
  logEnabled?: boolean;
  authorFixture?: SkillAuthorFixture;
  verifierFixture?: SkillVerifierFixture;
  /**
   * Explicit deterministic dual-lane reader fixture for tests only.
   * Never used as silent production semantic certification — production uses
   * the model-backed reader branch via AIService.
   */
  readerFixture?: (input: ReaderLaneInput) => ReaderLaneResult | Promise<ReaderLaneResult>;
  authorFactory?: (options: SkillAuthorBranchOptions) => SkillAuthorBranchSession;
  verifierFactory?: (options: SkillVerifierBranchOptions) => SkillVerifierBranchSession;
}

export interface SkillEvolutionEffectiveConfig {
  settlementWindowMs: number;
  reviewerConcurrency: number;
  operationalRetryMs: number;
  operationalRetryMaxMs: number;
  reviewAttemptDeadlineMs: number;
  authorModel?: string;
  verifierModel?: string;
  readerModel?: string;
}

export interface SkillEvolutionResult {
  transition: CapabilityTransitionKind;
  transitionId?: string;
  verified: boolean;
  rounds: number;
  draft?: SkillDraft;
  verifier?: SkillVerifierResult;
  record?: CurrentSkillRecord;
  audit?: TransitionAuditEntry;
  queued?: 'deferred' | 'operational';
  queueEntryId?: string;
}

export interface SkillEvolutionQueueReviewResult {
  reviewed: number;
  deferredReviewed: number;
  operationalReviewed: number;
  operationalRetried: number;
  deferredRetried: number;
  transitionsByKind: Partial<Record<CapabilityTransitionKind, number>>;
  /** Durable outcome by bundle id so reassessment manifests can converge with queue recovery. */
  queueOutcomes?: Record<string, {
    status: 'succeeded' | 'deferred' | 'operational';
    nextRetryAt?: string;
    reason?: string;
    failureKind?: OperationalReviewFailureKind;
  }>;
}

export interface TransitionJournal {
  schemaVersion: typeof SKILL_EVOLUTION_SCHEMA_VERSION;
  transitionId: string;
  /**
   * Hash of the Registry state read before this transition was planned.
   * Absent on legacy journals; those retain their historical best-effort
   * recovery behavior.
   */
  priorRegistryHash?: string;
  targetRegistryHash: string;
  targetRegistry: CurrentSkillRegistryState;
  skillOperations: Array<{
    path: string;
    content?: string;
    expectedHash?: string;
    /**
     * Hash of the file before this operation. `null` means the operation
     * expected the path to be absent. Absent on legacy operations.
     */
    priorHash?: string | null;
    delete?: boolean;
    immutable?: boolean;
  }>;
  audit: TransitionAuditEntry;
  committedAt?: string;
}

function incrementTransitionCount(
  counts: Partial<Record<CapabilityTransitionKind, number>>,
  transition: CapabilityTransitionKind,
): void {
  counts[transition] = (counts[transition] ?? 0) + 1;
}

/**
 * Read the succeeded commit quantum's persisted SkillEvolutionResult from a
 * terminal Evidence Review Job. This is the authoritative outcome after a
 * durable commit: a crash/re-entry that lost advanceJob's in-memory result
 * must reconstruct from it rather than from the draft intent or disposition.
 *
 * Returns undefined for legacy terminal jobs lacking a persisted commit
 * quantum result (callers fall back to a decision-aware reconstruction).
 */
function readSucceededCommitQuantumResult(
  job: EvidenceReviewJob,
): SkillEvolutionResult | undefined {
  const commitQuantum = Object.values(job.quanta).find(
    q => q.kind === 'commit' && q.state === 'succeeded',
  );
  const result = commitQuantum?.result as SkillEvolutionResult | undefined;
  if (!result || typeof result.transition !== 'string') return undefined;
  return result;
}

export class SkillEvolutionRuntime {
  private readonly options: SkillEvolutionOptions;
  private readonly inFlightCreateRoutingNames = new Set<string>();
  private evidenceReviewEngine: EvidenceReviewEngine | undefined;

  constructor(options: SkillEvolutionOptions) {
    this.options = options;
    fs.mkdirSync(options.outputDir, { recursive: true });
    recoverTransitionJournal(options);
  }

  /** Durable Evidence Review Job engine (ADR 0045). Created lazily. */
  getEvidenceReviewEngine(): EvidenceReviewEngine {
    if (!this.evidenceReviewEngine) {
      this.evidenceReviewEngine = this.createEvidenceReviewEngine();
    }
    return this.evidenceReviewEngine;
  }

  async reviewAndApply(bundle: EvidenceBundle, signal?: AbortSignal): Promise<SkillEvolutionResult> {
    return this.reviewAndApplyViaEvidenceReviewJob(bundle, signal);
  }

  /**
   * Durably admit review work without waiting for any model call.
   *
   * Learning is background maintenance: ingestion must be able to finish even
   * when the review provider is slow or unavailable.  Fair review wakes own
   * subsequent Quantum execution and resume this job from durable state.
   */
  enqueueReview(bundle: EvidenceBundle): EvidenceReviewJob {
    const frozen = freezeClone(bundle);
    validateEvidenceBundle(frozen);
    const engine = this.getEvidenceReviewEngine();
    const deferred = findDeferredJobByBundleId(engine.loadStore(), frozen.bundleId);
    if (deferred) {
      if (!this.isDeferredReviewEligible(deferred, frozen)) return deferred;
      return this.createDeferredReviewSuccessor(deferred, frozen, 'Deferred review basis changed.');
    }
    return engine.ensureJob({
      bundle: frozen,
      candidate: this.extractCandidateFromBundle(frozen),
      workClass: inferReviewWorkClass(frozen),
      registryReadSet: declaredRelevantRegistryReadSetFromBundle(frozen),
    });
  }

  /**
   * Usage reassessment shares the same durable promotion seam as normal review.
   * Operational handoff still throws so the curator does not consume evidence
   * as though a semantic rejection had completed.
   */
  async reviewUsageAndApply(bundle: EvidenceBundle): Promise<SkillEvolutionResult> {
    const result = await this.reviewAndApplyViaEvidenceReviewJob(bundle, undefined, false);
    if (result.queued === 'operational') {
      throw new OperationalReviewError(
        'branch_failure',
        `Usage reassessment ${bundle.bundleId} remains queued for durable retry.`,
        [],
      );
    }
    return result;
  }

  getQueuedReviewKind(bundleId: string): 'deferred' | 'operational' | undefined {
    return this.getQueuedReviewState(bundleId)?.kind;
  }

  /** One-pass durable disposition snapshot for bounded batch admission. */
  getReviewedOrQueuedBundleIds(): Set<string> {
    const bundleIds = new Set(
      this.getAudit()
        .map(entry => entry.bundleId)
        .filter((bundleId): bundleId is string => typeof bundleId === 'string'),
    );
    // The durable Job remains the authoritative review fact after a terminal
    // semantic rejection as well. A completed job without a transition audit
    // must still prevent the same Episode from being re-admitted forever.
    try {
      const jobs = this.getEvidenceReviewEngine().loadStore().jobs;
      for (const job of Object.values(jobs)) {
        if (
          job.disposition === 'active'
          || job.disposition === 'deferred'
          || job.disposition === 'completed'
        ) {
          bundleIds.add(job.bundle.bundleId);
        }
      }
    } catch {
      // Job store optional during early construction.
    }
    return bundleIds;
  }

  /**
   * Return the durable retry state for a queued review. Reassessment uses the
   * same job store as ordinary capability review, so the manifest can mirror
   * the actual deadline instead of inventing a second backoff clock.
   */
  getQueuedReviewState(bundleId: string): {
    kind: 'deferred' | 'operational';
    nextRetryAt?: string;
    reason?: string;
    failureKind?: OperationalReviewFailureKind;
  } | undefined {
    try {
      const state = this.getEvidenceReviewEngine().loadStore();
      const deferred = findDeferredJobByBundleId(state, bundleId);
      if (deferred?.deferState) return { kind: 'deferred', reason: deferred.deferState.reason };
      const operational = findOperationalJobByBundleId(state, bundleId);
      if (operational) {
        const retry = Object.values(operational.quanta)
          .filter(quantum => quantum.state === 'retry_wait' || quantum.state === 'terminal_failed')
          .sort((left, right) => (left.nextRetryAt ?? '').localeCompare(right.nextRetryAt ?? '', 'en'))[0];
        return {
          kind: 'operational',
          nextRetryAt: retry?.nextRetryAt ?? operational.nextDueAt,
          reason: retry?.failureMessage ?? operational.terminalReason,
          failureKind: retry?.failureKind,
        };
      }
    } catch {
      // Job store optional during early construction.
    }
    return undefined;
  }

  private createEvidenceReviewEngine(): EvidenceReviewEngine {
    const jobStorePath = resolveEvidenceReviewJobStorePath(this.options);
    // Authoritative quanta: dual-lane readers + skill_author / skill_verifier /
    // commit execute as leased durable graph nodes via these callbacks.
    // No deliberate-throw stubs and no post-hoc settlePromotionQuanta.
    return new EvidenceReviewEngine({
      jobStorePath,
      workingDirectory: this.options.workingDirectory,
      retryBaseMs: this.getEffectiveConfig().operationalRetryMs,
      retryMaxMs: this.getEffectiveConfig().operationalRetryMaxMs,
      maxQuantaPerAdvance: 64,
      reviewerVersion: this.options.reviewerVersion ?? SKILL_EVOLUTION_REVIEWER_VERSION,
      runReaderLane: async (input) => this.runReaderLaneCallback(input),
      runSkillAuthor: async (input) => this.runSkillAuthorQuantum(input),
      runSkillVerifier: async (input) => this.runSkillVerifierQuantum(input),
      commitTransition: async (input) => this.commitTransitionQuantum(input),
    });
  }

  /**
   * Public promotion path: create or resume a durable Evidence Review Job and
   * advance all runnable quanta (readers through commit) under lease ownership.
   */
  private async reviewAndApplyViaEvidenceReviewJob(
    bundle: EvidenceBundle,
    signal?: AbortSignal,
    allowOperationalHandoff = true,
  ): Promise<SkillEvolutionResult> {
    const frozen = freezeClone(bundle);
    validateEvidenceBundle(frozen);
    const engine = this.getEvidenceReviewEngine();
    const candidate = this.extractCandidateFromBundle(frozen);
    const workClass = inferReviewWorkClass(frozen);
    // Freeze every declared relevant dependency available from the bundle
    // (relatedCurrentSkills) into the Review Basis. Unrelated Registry handles
    // never enter the declared read set.
    const declaredRegistryReadSet = declaredRelevantRegistryReadSetFromBundle(frozen);
    const job = engine.ensureJob({
      bundle: frozen,
      candidate,
      workClass,
      registryReadSet: declaredRegistryReadSet,
    });
    const wakeId = `wake:${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // Pre-promotion Review Commit Fence: stale basis → successor, no promotion.
    const preFence = this.decideLiveReviewFence(job, frozen);
    if (
      preFence.decision.kind === 'stale_before_fence'
      || preFence.decision.kind === 'corrupted_basis'
    ) {
      return this.supersedeStaleReviewJob(
        engine,
        job,
        preFence.liveBundle,
        candidate,
        preFence.decision.reason,
        preFence.liveRegistryReadSet,
      );
    }

    // Preserve Branch Transcript Contract deadlines/abort across quanta.
    const attemptController = new AbortController();
    const externalSignals = [...new Set(
      [this.options.reviewAttemptSignal, signal].filter(
        (s): s is AbortSignal => s !== undefined,
      ),
    )];
    let cancelledByRuntimeShutdown = false;
    const attemptDeadlineMs = this.getEffectiveConfig().reviewAttemptDeadlineMs;
    const attemptDeadlineTimer = setTimeout(
      () => attemptController.abort('review-timeout'),
      Math.max(1, attemptDeadlineMs),
    );
    attemptDeadlineTimer.unref?.();
    const removeExternalAbortListeners: Array<() => void> = [];
    for (const externalSignal of externalSignals) {
      if (externalSignal.aborted) {
        const reason = this.resolveAbortReason(externalSignal.reason);
        cancelledByRuntimeShutdown = reason === 'runtime-shutdown';
        attemptController.abort(reason);
        break;
      }
      const onAbort = () => {
        const reason = this.resolveAbortReason(externalSignal.reason);
        cancelledByRuntimeShutdown = reason === 'runtime-shutdown';
        attemptController.abort(reason);
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeExternalAbortListeners.push(() => externalSignal.removeEventListener('abort', onAbort));
    }

    try {
      const advanced = await engine.advanceJob(job.jobId, wakeId, attemptController.signal);
      const live = engine.loadStore().jobs[job.jobId] ?? advanced.job;

      if (advanced.result) {
        return advanced.result;
      }

      if (live.disposition === 'completed' || live.disposition === 'deferred') {
        // Authoritative source: the succeeded commit quantum's persisted
        // SkillEvolutionResult. A crash/re-entry after durable commit must
        // reconstruct from this, never from the draft intent or disposition.
        const persistedCommitResult = readSucceededCommitQuantumResult(live);
        if (persistedCommitResult) {
          const reconstructed: SkillEvolutionResult = {
            transition: persistedCommitResult.transition,
            transitionId: persistedCommitResult.transitionId ?? live.transitionId,
            verified: persistedCommitResult.verified,
            rounds: persistedCommitResult.rounds > 0 ? persistedCommitResult.rounds : (live.revisionRound ?? 1),
            draft: persistedCommitResult.draft ?? live.draft,
            verifier: persistedCommitResult.verifier ?? live.verifierResult,
            ...(persistedCommitResult.record ? { record: persistedCommitResult.record } : {}),
            ...(persistedCommitResult.audit ? { audit: persistedCommitResult.audit } : {}),
            ...(persistedCommitResult.queued ? { queued: persistedCommitResult.queued } : {}),
            ...(persistedCommitResult.queueEntryId ? { queueEntryId: persistedCommitResult.queueEntryId } : {}),
          };
          return reconstructed;
        }

        // Backward-compat fallback for legacy terminal jobs without a persisted
        // commit quantum result. Decision-aware, never infers verified solely
        // from disposition completed.
        if (live.draft && live.verifierResult) {
          const decision = live.verifierResult.decision;
          const reconstructedTransition: CapabilityTransitionKind =
            live.disposition === 'deferred' || decision === 'defer'
              ? 'defer'
              : decision === 'accept'
                ? (live.verifierResult.transition ?? live.draft.envelope.decision)
                : 'reject_candidate';
          const reconstructed: SkillEvolutionResult = {
            transition: reconstructedTransition,
            transitionId: live.transitionId,
            verified: decision === 'accept' && live.disposition === 'completed' && reconstructedTransition !== 'reject_candidate',
            rounds: live.revisionRound ?? 1,
            draft: live.draft,
            verifier: live.verifierResult,
            ...(live.disposition === 'deferred' ? { queued: 'deferred' as const } : {}),
          };
          return reconstructed;
        }
      }

      if (live.disposition === 'terminal_failed') {
        const terminalError = new OperationalReviewError(
          'branch_failure',
          live.terminalReason ?? 'Evidence Review Job terminal failure',
          this.collectPromotionTranscriptPaths(live, advanced.lastError),
        );
        throw terminalError;
      }

      // Incomplete graph — surface the concrete quantum failure when present.
      const failure = this.buildIncompleteJobError(live, advanced.lastError, cancelledByRuntimeShutdown);
      if (cancelledByRuntimeShutdown || !allowOperationalHandoff) {
        throw failure;
      }
      if (!this.options.reviewQueuePath) {
        throw failure;
      }
      return this.queuedOperationalResult(live);
    } finally {
      clearTimeout(attemptDeadlineTimer);
      for (const remove of removeExternalAbortListeners) remove();
    }
  }

  private queuedOperationalResult(
    job: EvidenceReviewJob,
  ): SkillEvolutionResult {
    return {
      transition: 'reject_candidate',
      verified: false,
      rounds: job.revisionRound ?? 1,
      queued: 'operational',
      queueEntryId: job.jobId,
    };
  }

  private buildIncompleteJobError(
    job: EvidenceReviewJob,
    lastError?: {
      message: string;
      kind?: string;
      transcriptPaths?: string[];
      quantumId?: string;
      quantumKind?: string;
    },
    cancelledByRuntimeShutdown = false,
  ): OperationalReviewError {
    const transcripts = this.collectPromotionTranscriptPaths(job, lastError);
    if (cancelledByRuntimeShutdown) {
      return new OperationalReviewError(
        'branch_failure',
        lastError?.message ?? 'Review branch was aborted before persistence.',
        transcripts,
      );
    }
    if (lastError?.kind) {
      return new OperationalReviewError(
        lastError.kind as OperationalReviewFailureKind,
        lastError.message,
        transcripts,
      );
    }
    if (lastError?.message) {
      const kind = /invalid completion schema|invalid_completion_schema/i.test(lastError.message)
        ? 'invalid_completion_schema'
        : /timeout|deadline|aborted|review-timeout/i.test(lastError.message)
          ? 'branch_timeout'
          : 'branch_failure';
      return new OperationalReviewError(kind, lastError.message, transcripts);
    }
    return new OperationalReviewError(
      'branch_timeout',
      'Evidence Review Job incomplete after this wake; durable quanta will resume.',
      transcripts,
    );
  }

  /** All branch transcripts, including independent reader lanes, follow the commit audit. */
  private collectPromotionTranscriptPaths(
    job: EvidenceReviewJob,
    lastError?: { transcriptPaths?: string[] },
  ): string[] {
    const paths: string[] = [];
    for (const quantum of Object.values(job.quanta)) {
      for (const p of quantum.transcriptPaths ?? []) {
        if (p && !paths.includes(p)) paths.push(p);
      }
    }
    for (const p of lastError?.transcriptPaths ?? []) {
      if (p && !paths.includes(p)) paths.push(p);
    }
    return paths;
  }

  private decideLiveReviewFence(
    job: EvidenceReviewJob,
    bundle: EvidenceBundle,
    commitAlreadyApplied = false,
  ): {
    decision: ReturnType<typeof decideReviewCommitFence>;
    liveRegistryReadSet: CapabilityReadSetEntry[];
    liveBundle: EvidenceBundle;
  } {
    const live = this.buildLiveDeclaredDependencySnapshot(job.basis, bundle);
    return {
      decision: decideReviewCommitFence({
        basis: job.basis,
        live: live.liveWorld,
        commitAlreadyApplied,
      }),
      liveRegistryReadSet: live.liveRegistryReadSet,
      liveBundle: live.liveWorld.bundle,
    };
  }

  private async runReaderLaneCallback(input: ReaderLaneInput): Promise<ReaderLaneResult> {
    // Explicit test fixture only — never silent production semantic certification.
    if (this.options.readerFixture) {
      return this.options.readerFixture(input);
    }
    // Production default: lane-isolated model-backed reader via AIService/branch
    // transcript infrastructure. No second scheduler — runs under the claimed quantum.
    const laneModel = this.options.readerModel
      ?? (input.lane === 'author' ? this.options.authorModel : this.options.verifierModel);
    try {
      return await runModelBackedReaderLane(input, {
        aiService: this.createBranchAIService(laneModel),
        workingDirectory: this.options.workingDirectory,
        branchLogRoot: this.options.branchLogRoot,
        model: laneModel,
        signal: input.signal ?? this.options.reviewAttemptSignal,
        promptVersion: this.options.promptVersion ?? EVIDENCE_REVIEW_PROMPT_VERSION,
        policyVersion: EVIDENCE_REVIEW_POLICY_VERSION,
      });
    } catch (error) {
      const paths = extractErrorTranscriptPaths(error);
      throw this.buildOperationalReviewError(error, paths);
    }
  }

  private async runSkillAuthorQuantum(input: {
    bundle: EvidenceBundle;
    authorDossier: EvidenceDossier;
    job: EvidenceReviewJob;
    round: number;
    previousDraft?: SkillDraft;
    verifierIssues?: readonly SkillVerifierIssue[];
    signal?: AbortSignal;
  }): Promise<{ draft: SkillDraft; transcriptPaths: string[] }> {
    const reviewBundle = attachAuthorDossierContext(input.bundle, input.authorDossier);
    const attemptDeadlineMs = this.getEffectiveConfig().reviewAttemptDeadlineMs;
    const reviewAttempt: BranchReviewAttemptMetadata = {
      deadlineMs: attemptDeadlineMs,
      deadlineAt: new Date(Date.now() + Math.max(1, attemptDeadlineMs)).toISOString(),
    };
    const author = this.createAuthorBranch(
      reviewBundle,
      input.round,
      input.previousDraft,
      input.verifierIssues ?? [],
      { remainingTurns: this.getReviewAttemptMaxTurns() },
      input.signal,
      reviewAttempt,
    );
    let draft: SkillDraft;
    try {
      draft = await author.run();
      this.throwIfReviewAborted(input.signal);
    } catch (error) {
      const paths = author.transcriptPath ? [author.transcriptPath] : [];
      throw this.buildOperationalReviewError(error, paths);
    }
    const transcriptPaths = author.transcriptPath ? [author.transcriptPath] : [];
    if (author.transcriptPath) {
      assertHealthyBranchTranscript(author.transcriptPath, 'skill-author', this.options.branchLogRoot);
    }
    // Retryable schema issues enqueue operationally on durable quanta.
    // Semantic/policy issues remain on the draft for commit-time gate.
    const draftIssues = validateDraft(draft, reviewBundle, this.getManualSkillNames());
    const hasDuplicateCapabilityIssue = draftIssues.some(
      issue => issue.code === 'duplicate-capability-creation',
    );
    if (
      draftIssues.length > 0
      && draftIssues.every(isRetryableAuthorDraftIssue)
      && this.options.reviewQueuePath
      && !hasDuplicateCapabilityIssue
    ) {
      throw new OperationalReviewError(
        'invalid_completion_schema',
        `Skill Author returned an invalid completion schema: ${draftIssues.map(i => i.message).join(' ')}`,
        transcriptPaths,
      );
    }
    return { draft, transcriptPaths };
  }

  private async runSkillVerifierQuantum(input: {
    bundle: EvidenceBundle;
    draft: SkillDraft;
    authorDossier: EvidenceDossier;
    verifierDossier: EvidenceDossier;
    differenceIndex: DossierDifferenceIndex;
    obligations: readonly ReviewObligation[];
    job: EvidenceReviewJob;
    round: number;
    signal?: AbortSignal;
  }): Promise<{
    verifier: SkillVerifierResult;
    dispositions: readonly ObligationDisposition[];
    transcriptPaths: string[];
  }> {
    const reviewBundle = attachVerifierReviewContext(input.bundle, {
      authorDossier: input.authorDossier,
      verifierDossier: input.verifierDossier,
      differenceIndex: input.differenceIndex,
      obligations: input.obligations,
    });

    // Retryable schema issues with a queue already threw from skill_author.
    // Other draft gates may tighten the final decision, but only the Verifier
    // may explicitly disposition obligations and cite their supporting spans.
    const draftIssues = validateDraft(input.draft, reviewBundle, this.getManualSkillNames());
    let draftGate: SkillVerifierResult | undefined;
    if (draftIssues.length > 0) {
      const isDuplicate = draftIssues.some(i => i.code === 'duplicate-capability-creation');
      if (
        draftIssues.every(isRetryableAuthorDraftIssue)
        && this.options.reviewQueuePath
        && !isDuplicate
      ) {
        throw new OperationalReviewError(
          'invalid_completion_schema',
          `Skill Author returned an invalid completion schema: ${draftIssues.map(i => i.message).join(' ')}`,
          [],
        );
      }
      // Progressive Trust duplicate avoidance: a duplicate create_current_skill
      // draft whose routingName matches an existing capability in the bundle's
      // relatedCurrentSkills gets a bounded revision chance (round 2) when
      // expandable, so the Author can correct to append_evidence or
      // replace_current_skill. Only defer when revision is exhausted.
      const canRevise = input.round < MAX_AUTHOR_VERIFIER_ROUNDS;
      const decision = isDuplicate && canRevise ? 'revise' :
        draftIssues.some(issue => issue.severity === 'danger') ? 'reject' : 'defer';
      draftGate = {
        decision,
        issues: draftIssues,
        rationale: `Runtime ${decision === 'revise' ? 'revision requested' : decision === 'reject' ? 'rejected' : 'deferred'} the author envelope before persistence: ${draftIssues.map(i => i.message).join(' ')}`,
      };
    }

    const attemptDeadlineMs = this.getEffectiveConfig().reviewAttemptDeadlineMs;
    const reviewAttempt: BranchReviewAttemptMetadata = {
      deadlineMs: attemptDeadlineMs,
      deadlineAt: new Date(Date.now() + Math.max(1, attemptDeadlineMs)).toISOString(),
    };
    const verifier = this.createVerifierBranch(
      reviewBundle,
      input.draft,
      input.round,
      { remainingTurns: this.getReviewAttemptMaxTurns() },
      input.signal,
      reviewAttempt,
    );
    let verification: SkillVerifierResult;
    try {
      verification = normalizeVerifierResult(await verifier.run());
      this.throwIfReviewAborted(input.signal);
    } catch (error) {
      const paths = verifier.transcriptPath ? [verifier.transcriptPath] : [];
      throw this.buildOperationalReviewError(error, paths);
    }
    const transcriptPaths = verifier.transcriptPath ? [verifier.transcriptPath] : [];
    if (verifier.transcriptPath) {
      assertHealthyBranchTranscript(verifier.transcriptPath, 'skill-verifier', this.options.branchLogRoot);
    }
    if (draftGate) {
      verification = applyVerifierDecisionGate(verification, draftGate);
    }
    const dispositions = verification.obligationDispositions ?? [];
    return { verifier: verification, dispositions, transcriptPaths };
  }

  private async commitTransitionQuantum(input: {
    bundle: EvidenceBundle;
    draft: SkillDraft;
    verifier: SkillVerifierResult;
    job: EvidenceReviewJob;
    branchTranscriptPaths: string[];
    round: number;
  }): Promise<SkillEvolutionResult> {
    const engine = this.getEvidenceReviewEngine();
    const candidate = this.extractCandidateFromBundle(input.bundle);

    // Early fence avoids spending commit work on an already-stale basis. The
    // authoritative check is repeated by beforeAcceptedCommit below.
    const earlyFence = this.decideLiveReviewFence(input.job, input.bundle);
    if (
      earlyFence.decision.kind === 'stale_before_fence'
      || earlyFence.decision.kind === 'corrupted_basis'
    ) {
      return this.supersedeStaleReviewJob(
        engine,
        input.job,
        earlyFence.liveBundle,
        candidate,
        earlyFence.decision.reason,
        earlyFence.liveRegistryReadSet,
      );
    }

    const beforeAcceptedCommit: BeforeAcceptedCommitHook = () => {
      const liveJob = engine.loadStore().jobs[input.job.jobId] ?? input.job;
      const fence = this.decideLiveReviewFence(liveJob, input.bundle);
      if (
        fence.decision.kind === 'stale_before_fence'
        || fence.decision.kind === 'corrupted_basis'
      ) {
        return this.supersedeStaleReviewJob(
          engine,
          liveJob,
          fence.liveBundle,
          candidate,
          fence.decision.reason,
          fence.liveRegistryReadSet,
        );
      }
      return undefined;
    };

    const reviewBundle = input.job.authorDossier && input.job.verifierDossier
      ? attachVerifierReviewContext(input.bundle, {
        authorDossier: input.job.authorDossier,
        verifierDossier: input.job.verifierDossier,
        differenceIndex: input.job.differenceIndex ?? {
          manifestHash: input.job.manifest.manifestHash,
          entries: [],
        },
        obligations: input.job.obligations ?? [],
      })
      : input.bundle;

    // Runtime draft validation is a pre-persistence gate (legacy parity):
    // invalid drafts never install guidance even if the Verifier accepted them.
    const draftIssues = validateDraft(input.draft, reviewBundle, this.getManualSkillNames());
    if (draftIssues.length > 0) {
      if (
        draftIssues.every(isRetryableAuthorDraftIssue)
        && this.options.reviewQueuePath
      ) {
        throw new OperationalReviewError(
          'invalid_completion_schema',
          `Skill Author returned an invalid completion schema: ${draftIssues.map(i => i.message).join(' ')}`,
          input.branchTranscriptPaths,
        );
      }
      const danger = draftIssues.some(issue => issue.severity === 'danger');
      const gate: SkillVerifierResult = {
        decision: danger ? 'reject' : 'defer',
        issues: draftIssues,
        rationale: `Runtime ${danger ? 'rejected' : 'deferred'} the author envelope before persistence: ${draftIssues.map(i => i.message).join(' ')}`,
      };
      return this.applyReviewedTransition(
        reviewBundle,
        input.draft,
        applyVerifierDecisionGate(input.verifier, gate),
        input.round,
        [...input.branchTranscriptPaths],
      );
    }

    // Registry conflicts during applyCapabilityTransition are stale Review Basis
    // events: supersede the durable job and freeze a successor on the live vector.
    // Never re-run Author/Verifier against the same job under a mutated basis.
    try {
      const result = await this.applyReviewedTransition(
        reviewBundle,
        input.draft,
        input.verifier,
        input.round,
        [...input.branchTranscriptPaths],
        beforeAcceptedCommit,
      );
      if (result.transitionId || result.audit) {
        this.schedulePostCommitReassessmentIfNeeded(
          engine,
          input.job.jobId,
          input.bundle,
          candidate,
          result,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof ReviewCommitConflictError) {
        const live = this.buildLiveDeclaredDependencySnapshot(input.job.basis, input.bundle);
        return this.supersedeStaleReviewJob(
          engine,
          engine.loadStore().jobs[input.job.jobId] ?? input.job,
          live.liveWorld.bundle,
          candidate,
          error.message,
          live.liveRegistryReadSet,
        );
      }
      throw error;
    }
  }

  /**
   * Build the live declared dependency vector for Review Commit Fence comparison.
   * Includes every declared relevant dependency available from the bundle/Registry:
   * declared Registry read set (missing/deleted → sentinel revision), referenced-skill
   * hashes (via live bundle), target capability state, and live policy/prompt versions.
   * Unrelated Registry handles remain ignored.
   */
  private buildLiveDeclaredDependencySnapshot(
    basis: import('./evidence-review-types').ReviewBasis,
    bundle: EvidenceBundle,
  ): {
    liveRegistryReadSet: CapabilityReadSetEntry[];
    liveWorld: import('./evidence-review-commit-fence').SkillEvolutionLiveWorld;
  } {
    const registry = this.getRegistry();
    const liveBundle = this.refreshDeclaredEvidenceBundle(bundle);
    const liveRegistryReadSet = resolveLiveDeclaredRegistryReadSet(
      basis.registryReadSet,
      handle => registry.capabilities[handle],
    );
    const targetHandle = basis.targetCapabilityHandle;
    const liveTarget = targetHandle ? registry.capabilities[targetHandle] : undefined;
    // Policy/prompt live versions are the Evidence Review versions (same source
    // buildReviewBasis uses). Skill Evolution reviewerVersion is a separate
    // Author/Verifier control-plane version and must not pollute the fence vector.
    return {
      liveRegistryReadSet,
      liveWorld: {
        bundle: liveBundle,
        registryReadSet: liveRegistryReadSet,
        reviewPolicyVersion: EVIDENCE_REVIEW_POLICY_VERSION,
        promptVersion: EVIDENCE_REVIEW_PROMPT_VERSION,
        ...(targetHandle
          ? {
              targetCapabilityHandle: targetHandle,
              // Missing/deleted target is undefined → differs from frozen revision.
              targetCapabilityRevision: liveTarget?.revision,
            }
          : {}),
      },
    };
  }

  /**
   * Re-resolve declared Referenced Skills / related capabilities from live sources.
   * Missing dependencies keep a sentinel fingerprint so the Review Commit Fence can
   * classify staleness without aborting the fence decision itself.
   */
  private refreshDeclaredEvidenceBundle(bundle: EvidenceBundle): EvidenceBundle {
    const available = this.getReferencedSkillSnapshots();
    const referencedSkills = bundle.referencedSkills.map(frozen => {
      const live = available.find(candidate => (
        frozen.capabilityHandle
          ? candidate.capabilityHandle === frozen.capabilityHandle
          : candidate.name === frozen.name
      ));
      if (!live) {
        // A snapshot without a live capability locator is part of the fixed
        // Evidence Bundle itself. Absence from the local discovery scan is not
        // evidence that the declared dependency was deleted.
        if (!frozen.capabilityHandle) return frozen;
        return {
          ...frozen,
          contentFingerprint: '<missing>',
          version: frozen.version ?? '<missing>',
        };
      }
      return live;
    });
    const registry = this.getRegistry();
    const relatedCurrentSkills = bundle.relatedCurrentSkills.map(frozen => {
      const live = registry.capabilities[frozen.handle];
      if (!live) return { ...frozen, revision: -1, guidanceHash: '<missing>' };
      return {
        handle: live.handle,
        revision: live.revision,
        routingName: live.routingName,
        description: live.description,
        guidanceHash: live.guidanceHash,
      };
    });
    return freezeClone({ ...bundle, referencedSkills, relatedCurrentSkills });
  }

  /**
   * After a completed atomic commit, if the live declared world has already
   * drifted relative to the *post-commit expected* basis (own write folded in),
   * schedule ordinary reassessment rather than silently ignoring the change.
   */
  private schedulePostCommitReassessmentIfNeeded(
    engine: EvidenceReviewEngine,
    jobId: string,
    liveBundle: EvidenceBundle,
    candidate: DistilledKnowledgeCandidate,
    commitResult: SkillEvolutionResult,
  ): void {
    const state = engine.loadStore();
    const completed = state.jobs[jobId];
    if (!completed) return;

    // Fold our own transition write into the expected post-commit basis so the
    // commit itself is not misclassified as external post-fence drift.
    const postCommitBasis = this.foldCommittedWriteIntoBasis(completed.basis, commitResult);
    const liveSnap = this.buildLiveDeclaredDependencySnapshot(postCommitBasis, liveBundle);
    const fence = decideReviewCommitFence({
      basis: postCommitBasis,
      live: liveSnap.liveWorld,
      commitAlreadyApplied: true,
    });
    if (!fence.shouldScheduleReassessment) return;

    // Prefer engine create path so reassessment freezes the live declared vector.
    // Normalize the successor bundle so a persisted legacy/global-catalog
    // referencedSkills array cannot leak into the reassessment Author/Verifier.
    const reassessment = createSuccessorReviewJob({
      staleJob: {
        ...completed,
        workClass: 'semantic_reassessment',
      },
      liveBundle: this.normalizePersistedBundleForReReview(liveBundle),
      candidate,
      registryReadSet: liveSnap.liveRegistryReadSet,
    });
    reassessment.workClass = 'semantic_reassessment';
    reassessment.parentJobId = completed.jobId;
    upsertEvidenceReviewJob(state, reassessment);
    // Annotate completed job with successor link for audit without superseding
    // the already-committed disposition.
    if (!completed.successorJobId) {
      completed.successorJobId = reassessment.jobId;
      completed.updatedAt = new Date().toISOString();
      state.jobs[completed.jobId] = completed;
    }
    engine.saveStore(state);
  }

  /** Apply the just-committed Registry write onto a Review Basis for post-fence checks. */
  private foldCommittedWriteIntoBasis(
    basis: import('./evidence-review-types').ReviewBasis,
    commitResult: SkillEvolutionResult,
  ): import('./evidence-review-types').ReviewBasis {
    const record = commitResult.record;
    if (!record) return basis;
    const registryReadSet = basis.registryReadSet.map(entry =>
      entry.handle === record.handle
        ? { handle: record.handle, revision: record.revision }
        : entry,
    );
    // Create may introduce a brand-new handle not present on the pre-commit basis;
    // post-commit expected basis only rewrites handles already declared.
    const fingerprints = registryReadSet
      .map(entry => `${entry.handle}@${entry.revision}`)
      .sort((a, b) => a.localeCompare(b, 'en'));
    return {
      ...basis,
      registryReadSet,
      registryReadSetFingerprints: fingerprints,
      ...(basis.targetCapabilityHandle === record.handle
        ? { targetCapabilityRevision: record.revision }
        : {}),
    };
  }

  /**
   * Progressive Trust normalization for a persisted Evidence Bundle that is
   * about to re-enter Author/Verifier review or be frozen into a successor
   * Review Basis.
   *
   * Fail closed for ordinary persisted bundle families whose referencedSkills
   * were historically sourced from a global catalog or whose trusted runtime
   * load facts cannot be re-established from the persisted bundle alone. This
   * includes ordinary Learning Episode bundles (`v3:learning-episode:`),
   * generic Distillation Unit bundles (`v3:<file>:<range>:<candidate>`), and
   * legacy bootstrap bundles (`legacy-v3:`).
   *
   * Preserve dependencies only for explicit, audited families whose builders
   * already authenticate or intentionally pin their dependency vector:
   * flashcard composition (`flashcard-`), usage curation (`usage-curation:`),
   * and semantic reassessment (`semantic-reassessment:`).
   */
  private normalizePersistedBundleForReReview(bundle: EvidenceBundle): EvidenceBundle {
    if (bundle.referencedSkills.length === 0) return bundle;
    if (this.preservePersistedReferencedSkills(bundle)) return bundle;
    const trustedReferencedSkills = selectTrustedPersistedReferencedSkills(bundle);
    if (trustedReferencedSkills.length === 0) {
      return freezeClone({ ...bundle, referencedSkills: [] });
    }
    if (trustedReferencedSkills.length === bundle.referencedSkills.length) return bundle;
    return freezeClone({ ...bundle, referencedSkills: trustedReferencedSkills });
  }

  private preservePersistedReferencedSkills(bundle: EvidenceBundle): boolean {
    const authority = migratePersistedEvidenceBundleAuthority(bundle)?.authority;
    return authority?.kind === 'flashcard'
      || authority?.kind === 'usage-reassessment'
      || authority?.kind === 'semantic-reassessment';
  }

  private supersedeStaleReviewJob(
    engine: EvidenceReviewEngine,
    staleJob: EvidenceReviewJob,
    liveBundle: EvidenceBundle,
    candidate: DistilledKnowledgeCandidate,
    reason: string,
    liveRegistryReadSet?: readonly CapabilityReadSetEntry[],
  ): SkillEvolutionResult {
    // Successors freeze the *current live* declared dependency vector, never the
    // stale job's frozen read set alone. A persisted legacy/global-catalog
    // `referencedSkills` array must never be carried into the successor: apply
    // the Progressive Trust normalization so ordinary legacy referencedSkills
    // are stripped (fail closed) while structurally authenticated bundle
    // families keep their pinned dependencies.
    const normalizedLiveBundle = this.normalizePersistedBundleForReReview(liveBundle);
    const resolvedLiveReadSet = liveRegistryReadSet
      ?? resolveLiveDeclaredRegistryReadSet(
        staleJob.basis.registryReadSet,
        handle => this.getRegistry().capabilities[handle],
      );
    let successor = createSuccessorReviewJob({
      staleJob,
      liveBundle: normalizedLiveBundle,
      candidate,
      registryReadSet: resolvedLiveReadSet,
    });
    const state = engine.loadStore();
    if (state.jobs[successor.jobId]) {
      // A corrupted frozen basis can still produce the original deterministic
      // ID when rebuilt from the live basis. Never overwrite that stale audit
      // record: allocate a clean successor and do not copy its trusted quanta.
      successor = createSuccessorReviewJob({
        staleJob,
        liveBundle: normalizedLiveBundle,
        candidate,
        registryReadSet: resolvedLiveReadSet,
        jobId: `${successor.jobId}:successor:${randomUUID()}`,
        reuseSucceededQuanta: false,
      });
    }
    const superseded = markJobSuperseded(staleJob, successor.jobId);
    superseded.terminalReason = reason;
    upsertEvidenceReviewJob(state, superseded);
    upsertEvidenceReviewJob(state, successor);
    engine.saveStore(state);
    // The active successor itself is the durable follow-up. No parallel retry
    // record is needed: its graph quanta and leases are the single owner.
    return {
      transition: 'defer',
      verified: false,
      rounds: 1,
      queued: 'operational',
      queueEntryId: successor.jobId,
    };
  }

  /**
   * Fail-closed pre-claim fence for durable fair scheduling.
   *
   * RuntimeLearning may wake directly into fair quantum rotation for already
   * active jobs. Before any quantum is claimed/executed, supersede jobs whose
   * frozen Review Basis is stale/corrupted so Author/Verifier only ever see a
   * normalized live successor bundle under the current v3 policy.
   */
  fenceStaleActiveJobsBeforeFairAdvance(now: Date = new Date()): {
    supersededJobIds: string[];
    successorJobIds: string[];
  } {
    const engine = this.getEvidenceReviewEngine();
    const supersededJobIds: string[] = [];
    const successorJobIds: string[] = [];

    const isDueRunnableActiveJob = (job: EvidenceReviewJob): boolean => {
      if (job.disposition !== 'active') return false;
      const notBefore = job.nextDueAt ? Date.parse(job.nextDueAt) : Number.NaN;
      if (Number.isFinite(notBefore) && notBefore > now.getTime()) return false;
      return Object.values(job.quanta).some(quantum => (
        quantum.state === 'pending'
        || quantum.state === 'leased'
        || quantum.state === 'retry_wait'
      ));
    };

    const activeJobIds = Object.values(engine.loadStore().jobs)
      .filter(isDueRunnableActiveJob)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt, 'en')
        || left.jobId.localeCompare(right.jobId, 'en'))
      .map(job => job.jobId);

    for (const jobId of activeJobIds) {
      const current = engine.loadStore().jobs[jobId];
      if (!current || !isDueRunnableActiveJob(current)) continue;
      const bundleAuthority = classifyEvidenceBundleAuthority(current.bundle);
      const migratedLegacyBundle = bundleAuthority.legacy
        ? migratePersistedEvidenceBundleAuthority(
          this.normalizePersistedBundleForReReview(current.bundle),
        )
        : undefined;
      const effectiveAuthority = migratedLegacyBundle?.authority ?? bundleAuthority.authority;

      // A pre-source-snapshot Learning Episode may already have an active
      // durable job from an older runtime. It cannot be rebuilt from the
      // current log without changing the review basis, so quarantine it as a
      // normal dormant defer before any reader/author quantum can run. The
      // Episode remains available for explicit migration or inspection.
      const missingLearningSource = effectiveAuthority?.kind === 'learning-episode'
        && !hasCompleteFrozenSourceEvidence(current.bundle);
      if (
        missingLearningSource
        || bundleAuthority.malformedAuthority
        || (bundleAuthority.legacy && !migratedLegacyBundle)
      ) {
        const state = engine.loadStore();
        const live = state.jobs[jobId];
        if (live && live.disposition === 'active') {
          const reason = missingLearningSource
            ? 'Learning Episode review basis has no complete frozen source evidence; explicit migration is required.'
            : bundleAuthority.malformedAuthority
              ? 'Evidence Bundle authority is malformed; explicit migration is required.'
              : 'Persisted Evidence Bundle has no provable authority; explicit migration is required.';
          live.disposition = 'deferred';
          live.deferState = {
            reviewerVersion: this.options.reviewerVersion ?? SKILL_EVOLUTION_REVIEWER_VERSION,
            reason,
            deferredAt: now.toISOString(),
          };
          live.terminalReason = reason;
          live.nextDueAt = undefined;
          live.updatedAt = now.toISOString();
          upsertEvidenceReviewJob(state, live);
          engine.saveStore(state);
        }
        continue;
      }
      if (migratedLegacyBundle) {
        const candidate = this.extractCandidateFromBundle(migratedLegacyBundle);
        this.supersedeStaleReviewJob(
          engine,
          current,
          migratedLegacyBundle,
          candidate,
          'Persisted pre-authority Evidence Bundle migrated to an explicit authority successor.',
          declaredRelevantRegistryReadSetFromBundle(migratedLegacyBundle),
        );
        supersededJobIds.push(current.jobId);
        const successorJobId = engine.loadStore().jobs[current.jobId]?.successorJobId;
        if (successorJobId) successorJobIds.push(successorJobId);
        continue;
      }
      const preFence = this.decideLiveReviewFence(
        current,
        this.normalizePersistedBundleForReReview(current.bundle),
      );
      if (
        preFence.decision.kind !== 'stale_before_fence'
        && preFence.decision.kind !== 'corrupted_basis'
      ) {
        continue;
      }
      const candidate = this.extractCandidateFromBundle(current.bundle);
      this.supersedeStaleReviewJob(
        engine,
        current,
        preFence.liveBundle,
        candidate,
        preFence.decision.reason,
        preFence.liveRegistryReadSet,
      );
      supersededJobIds.push(current.jobId);
      const successorJobId = engine.loadStore().jobs[current.jobId]?.successorJobId;
      if (successorJobId) successorJobIds.push(successorJobId);
    }

    return { supersededJobIds, successorJobIds };
  }

  /**
   * Supersede an active Evidence Review Job whose immutable frozen Review Basis
   * still carries stale settlement evidence, using the existing audited
   * successor mechanism.
   *
   * The frozen basis is never mutated in place: the stale job is marked
   * `superseded`, a normalized successor is created from the fresh bundle
   * (built from the now-reconciled capsule), and an operational follow-up is
   * enqueued so fair advancement reaches only the clean successor. This is the
   * same audited path `fenceStaleActiveJobsBeforeFairAdvance` uses for stale
   * declared-dependency bases.
   *
   * Returns the superseded + successor job ids, or `undefined` when no active
   * job exists for the bundle (already terminal or not yet enqueued).
   */
  supersedeActiveJobWithFreshBundle(
    bundleId: string,
    freshBundle: EvidenceBundle,
    reason: string,
  ): { supersededJobId: string; successorJobId: string } | undefined {
    const engine = this.getEvidenceReviewEngine();
    const staleJob = engine.findActiveJobForBundle(bundleId);
    if (!staleJob) return undefined;
    const candidate = this.extractCandidateFromBundle(freshBundle);
    this.supersedeStaleReviewJob(
      engine,
      staleJob,
      freshBundle,
      candidate,
      reason,
    );
    const successorJobId = engine.loadStore().jobs[staleJob.jobId]?.successorJobId;
    return successorJobId
      ? { supersededJobId: staleJob.jobId, successorJobId }
      : undefined;
  }

  /**
   * Supersede a durably `deferred` Evidence Review Job whose immutable frozen
   * Review Basis still carries stale settlement evidence, using the same audited
   * successor mechanism as `supersedeActiveJobWithFreshBundle`.
   *
   * A job that reached the durable `disposition: deferred` terminal state
   * because the Verifier semantically deferred on the fabricated
   * `settled ... (status: settling)` contradiction can remain permanently
   * stuck even after the capsule is repaired: `getReviewedOrQueuedBundleIds()`
   * treats deferred jobs as bundle owners (so the episode is never re-admitted
   * for review), and fair scheduling only executes active jobs. Recovery
   * therefore must extend to the stale `deferred` terminal state using the same
   * immutable supersede/successor path — the frozen basis is never mutated in
   * place; the stale job is marked `superseded` and a normalized successor is
   * created from the fresh bundle.
   *
   * Returns the superseded + successor job ids, or `undefined` when no deferred
   * job exists for the bundle (already recovered or not yet enqueued).
   */
  supersedeStaleDeferredJobWithFreshBundle(
    bundleId: string,
    freshBundle: EvidenceBundle,
    reason: string,
  ): { supersededJobId: string; successorJobId: string } | undefined {
    const engine = this.getEvidenceReviewEngine();
    const staleJob = Object.values(engine.loadStore().jobs)
      .filter(job => job.bundle.bundleId === bundleId && job.disposition === 'deferred')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt, 'en'))[0];
    if (!staleJob) return undefined;
    const candidate = this.extractCandidateFromBundle(freshBundle);
    this.supersedeStaleReviewJob(
      engine,
      staleJob,
      freshBundle,
      candidate,
      reason,
    );
    const successorJobId = engine.loadStore().jobs[staleJob.jobId]?.successorJobId;
    return successorJobId
      ? { supersededJobId: staleJob.jobId, successorJobId }
      : undefined;
  }

  private buildOperationalReviewError(error: unknown, branchTranscriptPaths: string[]): OperationalReviewError {
    const transcriptPaths = uniqueStrings([
      ...branchTranscriptPaths,
      ...extractErrorTranscriptPaths(error),
    ]);
    if (error instanceof OperationalReviewError) {
      return new OperationalReviewError(
        error.kind,
        error.message,
        uniqueStrings([...transcriptPaths, ...error.transcriptPaths]),
      );
    }
    if (error instanceof BranchSessionAbortError) {
      const kind: OperationalReviewFailureKind = error.reason === 'runtime-shutdown'
        ? 'branch_failure'
        : 'branch_timeout';
      return new OperationalReviewError(
        kind,
        error.message,
        transcriptPaths,
      );
    }

    const message = String((error as { message?: unknown })?.message ?? error ?? 'Unknown branch failure');
    const lower = message.toLowerCase();
    let kind: OperationalReviewFailureKind = 'branch_failure';
    if (/completion schema/i.test(message) || /invalid schema/i.test(lower) || /missing required/i.test(lower)) {
      kind = 'invalid_completion_schema';
    } else if (/timeout|timed.?out|deadline/i.test(lower)) {
      kind = 'branch_timeout';
    }

    return new OperationalReviewError(
      kind,
      message,
      transcriptPaths,
    );
  }

  private extractCandidateFromBundle(bundle: EvidenceBundle): DistilledKnowledgeCandidate {
    if (isLikelyDistilledKnowledgeCandidate(bundle.episode)) {
      return bundle.episode;
    }
    return this.buildFallbackCandidateFromBundle(bundle);
  }

  private buildFallbackCandidateFromBundle(bundle: EvidenceBundle): DistilledKnowledgeCandidate {
    const fallbackEpisode = typeof bundle.episode === 'object' && bundle.episode !== null ? bundle.episode as Record<string, unknown> : {};
    const completionRef = bundle.completionEvidence[0]?.ref ?? bundle.settlementEvidence[0]?.ref ?? 'episode-source';
    const [sourceFile, sourceTurn] = String(completionRef).split('#');
    const numericSourceTurn = Number.parseInt(sourceTurn, 10);
    const turn = Number.isFinite(numericSourceTurn) && numericSourceTurn >= 0 ? numericSourceTurn : 0;
    const capabilityId = `bundle-${bundle.bundleId}`.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
    const problemText = typeof fallbackEpisode.problem === 'string' ? fallbackEpisode.problem : bundle.bundleId;
    const completionText = typeof fallbackEpisode.completion === 'string' ? fallbackEpisode.completion : 'Review attempt completed via fallback candidate path.';

    return {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId,
      title: problemText.slice(0, 120),
      applicability: `Fallback promotion review context for ${bundle.bundleId}.`,
      actionPattern: completionText.slice(0, 120),
      boundaries: ['Fallback candidate generated from a non-candidate episode bundle.'],
      risks: ['Fallback candidate is a diagnostic placeholder.'],
      solvedLoop: {
        problem: problemText.slice(0, 160),
        action: completionText.slice(0, 160),
        verification: 'Operational review queue captured and retried.',
        noCorrection: 'No correction signal was available.',
      },
      provenance: [
        {
          filePath: sourceFile || 'episode-source',
          turn,
          role: 'problem-action',
          unitByteRange: { start: 0, end: 1 },
        },
        {
          filePath: sourceFile || 'episode-source',
          turn: turn + 1,
          role: 'verification',
          unitByteRange: { start: 1, end: 2 },
        },
      ],
      generatedAt: new Date().toISOString(),
      sourceUnit: {
        filePath: sourceFile || 'episode-source',
        byteRange: { start: 0, end: 2 },
        generatedAt: new Date().toISOString(),
      },
    };
  }

  private isDeferredReviewEligible(job: EvidenceReviewJob, candidateBundle?: EvidenceBundle): boolean {
    if (job.disposition !== 'deferred') return false;
    const normalizedBundle = migratePersistedEvidenceBundleAuthority(job.bundle);
    if (!normalizedBundle) return false;
    if (
      normalizedBundle.authority.kind === 'learning-episode'
      && !hasCompleteFrozenSourceEvidence(job.bundle)
    ) {
      return !!candidateBundle
        && hasCompleteFrozenSourceEvidence(candidateBundle)
        && hashEvidenceBundle(candidateBundle) !== job.basis.evidenceBundleHash;
    }
    if (job.deferState
      && job.deferState.reviewerVersion !== (this.options.reviewerVersion ?? SKILL_EVOLUTION_REVIEWER_VERSION)) {
      return true;
    }
    if (job.basis.reviewPolicyVersion !== EVIDENCE_REVIEW_POLICY_VERSION
      || job.basis.promptVersion !== EVIDENCE_REVIEW_PROMPT_VERSION) {
      return true;
    }
    const registry = this.getRegistry();
    if (job.basis.registryReadSet.some(entry => registry.capabilities[entry.handle]?.revision !== entry.revision)) {
      return true;
    }
    if (!candidateBundle) return false;
    return hashEvidenceBundle(candidateBundle) !== job.basis.evidenceBundleHash;
  }

  /**
   * Replace a terminal deferred graph with a fresh, uniquely identified graph.
   * No Author/Verifier/commit result is reused; stale + successor persist in one write.
   */
  private createDeferredReviewSuccessor(
    staleJob: EvidenceReviewJob,
    bundle: EvidenceBundle,
    reason: string,
  ): EvidenceReviewJob {
    const engine = this.getEvidenceReviewEngine();
    const state = engine.loadStore();
    const liveStale = state.jobs[staleJob.jobId];
    if (!liveStale || liveStale.disposition !== 'deferred') {
      const existing = liveStale?.successorJobId ? state.jobs[liveStale.successorJobId] : undefined;
      if (existing) return existing;
      throw new Error(`Deferred review job ${staleJob.jobId} is no longer eligible for reactivation.`);
    }
    const normalizedPersisted = this.normalizePersistedBundleForReReview(bundle);
    const normalized = migratePersistedEvidenceBundleAuthority(normalizedPersisted);
    if (!normalized) {
      throw new Error(
        `Deferred review job ${staleJob.jobId} has no migratable Evidence Bundle authority.`,
      );
    }
    const successor = createEvidenceReviewJob({
      bundle: normalized,
      candidate: this.extractCandidateFromBundle(normalized),
      workClass: 'semantic_reassessment',
      registryReadSet: resolveLiveDeclaredRegistryReadSet(
        liveStale.basis.registryReadSet,
        handle => this.getRegistry().capabilities[handle],
      ),
      parentJobId: liveStale.jobId,
      jobId: `${liveStale.jobId}:retry:${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    });
    successor.domain = { ...successor.domain, reactivatedDeferred: true };
    const superseded = markJobSuperseded(liveStale, successor.jobId);
    superseded.terminalReason = reason;
    upsertEvidenceReviewJob(state, superseded);
    upsertEvidenceReviewJob(state, successor);
    engine.saveStore(state);
    return successor;
  }

  getDeferredReviewBundleIds(): string[] {
    return Object.values(this.getEvidenceReviewEngine().loadStore().jobs)
      .filter(job => job.disposition === 'deferred')
      .map(job => job.bundle.bundleId)
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  /** Reactivate dormant defers only when reviewer/policy, Registry, or evidence changed. */
  reactivateDeferredReviews(candidateBundles: readonly EvidenceBundle[] = []): EvidenceReviewJob[] {
    const liveBundles = new Map(candidateBundles.map(bundle => [bundle.bundleId, bundle]));
    const jobs = Object.values(this.getEvidenceReviewEngine().loadStore().jobs)
      .filter(job => job.disposition === 'deferred'
        && this.isDeferredReviewEligible(job, liveBundles.get(job.bundle.bundleId)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt, 'en'));
    return jobs.map(job => this.createDeferredReviewSuccessor(
      job,
      liveBundles.get(job.bundle.bundleId) ?? job.bundle,
      'Deferred review became eligible under a durable retry trigger.',
    ));
  }

  /** Project the single fair executor's touched jobs into wake/report metrics. */
  collectFairReviewOutcomes(
    jobIds: readonly string[],
  ): SkillEvolutionQueueReviewResult {
    const empty: SkillEvolutionQueueReviewResult = {
      reviewed: 0,
      deferredReviewed: 0,
      operationalReviewed: 0,
      operationalRetried: 0,
      deferredRetried: 0,
      transitionsByKind: {} as Partial<Record<CapabilityTransitionKind, number>>,
      queueOutcomes: {} as NonNullable<SkillEvolutionQueueReviewResult['queueOutcomes']>,
    };
    if (jobIds.length === 0) return empty;
    try {
      const jobs = this.getEvidenceReviewEngine().loadStore().jobs;
      for (const jobId of jobIds) {
        const job = jobs[jobId];
        if (!job) continue;
        const wasOperational = job.workClass === 'operational_recovery';
        const wasDeferred = job.domain?.reactivatedDeferred === true;
        if (!wasOperational && !wasDeferred) continue;
        const bundleId = job.bundle.bundleId;
        if (job.disposition === 'completed') {
          empty.reviewed += 1;
          if (wasOperational) empty.operationalReviewed += 1;
          if (wasDeferred) empty.deferredReviewed += 1;
          empty.queueOutcomes![bundleId] = { status: 'succeeded' };
          if (job.verifierResult?.transition) {
            incrementTransitionCount(empty.transitionsByKind, job.verifierResult.transition);
          } else if (job.draft?.envelope.decision) {
            incrementTransitionCount(empty.transitionsByKind, job.draft.envelope.decision);
          }
        } else if (job.disposition === 'deferred') {
          empty.reviewed += 1;
          if (wasOperational) empty.operationalReviewed += 1;
          if (wasDeferred) {
            empty.deferredReviewed += 1;
            empty.deferredRetried += 1;
          }
          empty.queueOutcomes![bundleId] = {
            status: 'deferred',
            reason: job.verifierResult?.rationale ?? job.terminalReason,
          };
          incrementTransitionCount(empty.transitionsByKind, 'defer');
        } else if (wasOperational) {
          const retry = Object.values(job.quanta)
            .filter(quantum => quantum.state === 'retry_wait' || quantum.state === 'terminal_failed')
            .sort((left, right) => (left.nextRetryAt ?? '').localeCompare(right.nextRetryAt ?? '', 'en'))[0];
          if (!retry) continue;
          empty.reviewed += 1;
          empty.operationalReviewed += 1;
          empty.operationalRetried += 1;
          empty.queueOutcomes![bundleId] = {
            status: 'operational',
            nextRetryAt: retry.nextRetryAt ?? job.nextDueAt,
            reason: retry.failureMessage ?? job.terminalReason,
            failureKind: retry.failureKind ?? 'branch_failure',
          };
        }
      }
    } catch {
      // Job store optional.
    }
    return empty;
  }

  getRegistry(): CurrentSkillRegistryState {
    return loadCurrentSkillRegistry(this.options.registryPath);
  }

  /**
   * Refresh a generated capability's referenced-skill snapshots after a
   * referenced route changes without rewriting executable guidance. This is
   * still a journaled/audited Registry transition so a crash cannot leave a
   * half-updated catalog, and the stable bundle id makes replay idempotent.
   */
  refreshReferencedSkillMetadata(
    targetCapabilityHandle: string,
    referencedSkills: readonly ReferencedSkillSnapshot[],
  ): AppliedTransition {
    recoverTransitionJournal(this.options);
    const registry = loadCurrentSkillRegistry(this.options.registryPath);
    const current = registry.capabilities[targetCapabilityHandle];
    if (!current) throw new Error('Referenced-skill metadata target is not active.');
    const normalized = referencedSkills.map(({ content: _content, ...snapshot }) => ({ ...snapshot }));
    const metadataHash = stableHash(normalized);
    const bundleId = `refresh-references:${targetCapabilityHandle}:${metadataHash}`;
    const prior = loadTransitionAudit(this.options.auditPath)
      .slice().reverse()
      .find(entry => entry.bundleId === bundleId && entry.transition === 'append_evidence');
    if (prior) return { transitionId: prior.transitionId, record: current, audit: prior };
    if (stableHash(current.referencedSkills) === metadataHash) {
      throw new Error('Referenced-skill metadata is already current.');
    }
    const now = new Date().toISOString();
    const target = cloneRegistry(registry);
    const updated: CurrentSkillRecord = {
      ...current,
      // The executable guidance remains unchanged, but the Registry record
      // changed. Advance its optimistic-concurrency revision so a reviewer
      // holding the prior metadata read set cannot clobber this refresh.
      revision: current.revision + 1,
      referencedSkills: normalized,
      updatedAt: now,
    };
    target.capabilities[targetCapabilityHandle] = updated;
    target.catalogRevision += 1;
    const transitionId = `transition-${randomUUID()}`;
    const audit: TransitionAuditEntry = {
      schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
      transitionId,
      transition: 'append_evidence',
      bundleId,
      occurredAt: now,
      reviewerVersion: this.options.reviewerVersion ?? SKILL_EVOLUTION_REVIEWER_VERSION,
      promptVersion: this.options.promptVersion ?? 'skill-evolution-v3',
      evidenceRefs: [],
      involvedCapabilityHandles: [targetCapabilityHandle],
      registryReadSet: [{ handle: current.handle, revision: current.revision }],
      priorGuidanceHash: current.guidanceHash,
      resultingGuidanceHash: current.guidanceHash,
      priorRoutingName: current.routingName,
      resultingRoutingName: current.routingName,
      branchTranscriptPaths: [],
      rationale: 'Refresh referenced generated-skill metadata without executable guidance churn.',
    };
    const journal: TransitionJournal = {
      schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
      transitionId,
      priorRegistryHash: stableHash(registry),
      targetRegistryHash: stableHash(target),
      targetRegistry: target,
      skillOperations: [],
      audit,
    };
    writeJsonAtomic(this.options.journalPath, journal);
    recoverTransitionJournal(this.options);
    return { transitionId, record: updated, audit };
  }

  getAudit(): TransitionAuditEntry[] {
    return loadTransitionAudit(this.options.auditPath);
  }

  /** Current manual skills are resolved at promotion time, not startup time. */
  getManualSkillNames(): string[] {
    return uniqueStrings([
      ...(this.options.manualSkillNames ?? []),
      ...discoverManualSkillSnapshots(this.options.outputDir).map(skill => skill.name),
    ]);
  }

  /** Bounded snapshots used by the production Evidence Bundle constructor. */
  getReferencedSkillSnapshots(): ReferencedSkillSnapshot[] {
    const manual = discoverManualSkillSnapshots(this.options.outputDir);
    const generated = Object.values(this.getRegistry().capabilities).map(record => ({
      name: record.routingName,
      capabilityHandle: record.handle,
      guidanceHash: record.guidanceHash,
      guidanceContentHash: record.guidanceContentHash ?? guidanceBodyHashFromFile(record.skillFilePath),
      contentFingerprint: record.guidanceHash,
    }));
    return [...manual, ...generated];
  }

  getEffectiveConfig(): SkillEvolutionEffectiveConfig {
    return {
      settlementWindowMs: this.options.settlementWindowMs ?? 3 * 60 * 60 * 1000,
      reviewerConcurrency: this.options.reviewerConcurrency ?? 3,
      operationalRetryMs: this.options.operationalRetryMs ?? 5 * 60 * 1000,
      operationalRetryMaxMs: this.options.operationalRetryMaxMs ?? 6 * 60 * 60 * 1000,
      reviewAttemptDeadlineMs: this.options.reviewAttemptDeadlineMs ?? DEFAULT_REVIEW_ATTEMPT_DEADLINE_MS,
      ...(this.options.authorModel && { authorModel: this.options.authorModel }),
      ...(this.options.verifierModel && { verifierModel: this.options.verifierModel }),
      ...(this.options.readerModel && { readerModel: this.options.readerModel }),
    };
  }

  private getReviewAttemptMaxTurns(): number {
    return DEFAULT_REVIEW_ATTEMPT_MAX_TURNS;
  }

  private resolveAbortReason(reason: unknown): 'review-timeout' | 'runtime-shutdown' | 'turn_budget_exhausted' {
    if (reason === 'review-timeout') return 'review-timeout';
    if (reason === 'turn_budget_exhausted') return 'turn_budget_exhausted';
    return 'runtime-shutdown';
  }

  private throwIfReviewAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw new BranchSessionAbortError(
      this.resolveAbortReason(signal.reason),
      'Review branch was aborted before persistence.',
    );
  }

  private createAuthorBranch(
    bundle: EvidenceBundle,
    round: number,
    previousDraft: SkillDraft | undefined,
    verifierIssues: readonly SkillVerifierIssue[],
    sharedReviewTurnBudget: SharedReviewTurnBudget,
    attemptSignal?: AbortSignal,
    reviewAttempt?: BranchReviewAttemptMetadata,
  ): SkillAuthorBranchSession {
    const options: SkillAuthorBranchOptions = {
      id: `skill-author-${randomUUID()}`,
      aiService: this.createBranchAIService(this.options.authorModel),
      workingDirectory: this.options.workingDirectory,
      branchLogRoot: this.options.branchLogRoot,
      logEnabled: true,
      transcriptContract: 'required',
      signal: attemptSignal,
      sharedReviewTurnBudget,
      reviewAttempt,
      bundle,
      round,
      previousDraft,
      verifierIssues,
      fixture: this.options.authorFixture,
    };
    return this.options.authorFactory?.(options) ?? new SkillAuthorBranchSession(options);
  }

  private createVerifierBranch(
    bundle: EvidenceBundle,
    draft: SkillDraft,
    round: number,
    sharedReviewTurnBudget: SharedReviewTurnBudget,
    attemptSignal?: AbortSignal,
    reviewAttempt?: BranchReviewAttemptMetadata,
  ): SkillVerifierBranchSession {
    const options: SkillVerifierBranchOptions = {
      id: `skill-verifier-${randomUUID()}`,
      aiService: this.createBranchAIService(this.options.verifierModel),
      workingDirectory: this.options.workingDirectory,
      branchLogRoot: this.options.branchLogRoot,
      logEnabled: true,
      transcriptContract: 'required',
      signal: attemptSignal,
      sharedReviewTurnBudget,
      reviewAttempt,
      bundle,
      draft,
      round,
      fixture: this.options.verifierFixture,
    };
    return this.options.verifierFactory?.(options) ?? new SkillVerifierBranchSession(options);
  }

  private createBranchAIService(model?: string): AIService {
    const service = requireAIService(this.options.aiService);
    if (!model?.trim() || typeof service.getConfig !== 'function') return service;
    return new AIService({ ...service.getConfig(), model: model.trim() });
  }

  private async applyReviewedTransition(
    bundle: EvidenceBundle,
    draft: SkillDraft,
    verifier: SkillVerifierResult,
    round: number,
    branchTranscriptPaths: string[],
    beforeAcceptedCommit?: BeforeAcceptedCommitHook,
  ): Promise<SkillEvolutionResult> {
    if (
      verifier.decision === 'accept'
      && verifier.transition
      && verifier.transition !== draft.envelope.decision
    ) {
      verifier = {
        decision: 'reject',
        issues: [{
          code: 'transition-mismatch',
          message: 'Verifier transition does not match the Authoring Envelope.',
          severity: 'danger',
        }],
        rationale: 'Runtime rejected a verifier result that attempted to change the author-proposed transition.',
      };
    }
    let transition = verifier.decision === 'accept'
      ? (verifier.transition ?? draft.envelope.decision)
      : verifier.decision === 'defer' ? 'defer' : 'reject_candidate';

    const nonMutatingTransition = transition === 'defer' || transition === 'reject_candidate';
    const targetHandle = draft.envelope.targetCapabilityHandle;
    const authority = classifyEvidenceBundleAuthority(bundle);
    if (verifier.decision === 'accept' && authority.malformedAuthority) {
      transition = 'reject_candidate';
      verifier = {
        decision: 'reject',
        issues: [{
          code: 'malformed-bundle-authority',
          message: 'Evidence Bundle authority is malformed; mutation is not permitted.',
          severity: 'danger',
        }],
        rationale: 'Runtime rejected a transition whose explicit authority marker could not be validated.',
      };
    }
    const isLearningEpisode = authority.family === 'learning-episode';
    const isFlashcard = authority.family === 'flashcard';
    const isSemanticReassessment = authority.family === 'semantic-reassessment';
    const semanticEpisode = bundle.episode as { capabilityHandle?: unknown } | null;
    const semanticTargetHandle = typeof semanticEpisode?.capabilityHandle === 'string'
      ? semanticEpisode.capabilityHandle
      : undefined;
    const declaredSemanticTarget = authority.targetCapabilityHandle;
    const semanticBundleTargetsEpisode = typeof declaredSemanticTarget === 'string'
      && declaredSemanticTarget === semanticTargetHandle;
    const semanticRelatedSkillsTargetEpisode = bundle.relatedCurrentSkills.length === 1
      && bundle.relatedCurrentSkills[0]?.handle === semanticTargetHandle;
    const semanticPriorGuidanceFrozen = typeof semanticTargetHandle === 'string'
      && hasFrozenSemanticPriorGuidance(
        bundle,
        this.getRegistry().capabilities[semanticTargetHandle],
      );
    const semanticTransitionKindAllowed = transition === 'append_evidence'
      || (
        (transition === 'replace_current_skill' || transition === 'migrate_skill_route')
        && semanticPriorGuidanceFrozen
      );
    const semanticTransitionAllowed = nonMutatingTransition || (
      semanticTransitionKindAllowed
      && semanticBundleTargetsEpisode
      && semanticRelatedSkillsTargetEpisode
      && semanticTargetHandle === targetHandle
    );
    if (
      verifier.decision === 'accept'
      && isSemanticReassessment
      && !semanticTransitionAllowed
    ) {
      transition = 'reject_candidate';
      verifier = {
        decision: 'reject',
        issues: [{
          code: 'semantic-reassessment-scope',
          message: 'Semantic reassessment may append evidence to its exact target; replacing or migrating executable guidance additionally requires a frozen prior-guidance body that matches the active Registry revision.',
          severity: 'danger',
        }],
        rationale: 'Runtime rejected a semantic reassessment transition outside its exact target-bound authority.',
      };
    }
    const usageEpisode = bundle.episode as { kind?: unknown; capabilityHandle?: unknown } | null;
    const isUsageReassessment = authority.family === 'usage-reassessment';
    const usageTargetHandle = usageEpisode?.kind === 'usage-reassessment'
      && typeof usageEpisode.capabilityHandle === 'string'
      && authority.targetCapabilityHandle === usageEpisode.capabilityHandle
      ? authority.targetCapabilityHandle
      : undefined;
    // A usage bundle currently freezes only the fact that a named load was
    // contradicted, not the bounded correction text or the prior guidance
    // body. That is enough to retain negative evidence, but not enough to
    // conclude that the whole Capability is disposable. Automatic usage
    // reassessment therefore has one mutating outlet: append evidence. Full
    // retirement remains an explicit operator action until a richer frozen
    // correction contract exists.
    const usageCurationTransitionAllowed = nonMutatingTransition || (
      typeof usageTargetHandle === 'string'
      && usageTargetHandle === targetHandle
      && transition === 'append_evidence'
    );
    const learningAppendTargetsBoundedSkill = transition !== 'append_evidence'
      || (
        typeof targetHandle === 'string'
        && learningAppendTargetIsEvidenceBound(
          bundle,
          this.getRegistry().capabilities[targetHandle],
        )
      );
    const learningEpisodeTransitionAllowed = nonMutatingTransition
      || transition === 'create_current_skill'
      || (transition === 'append_evidence' && learningAppendTargetsBoundedSkill);
    const usageTransitionExceedsAuthority = isUsageReassessment
      && !usageCurationTransitionAllowed;
    const learningTransitionExceedsAuthority = isLearningEpisode
      && !learningEpisodeTransitionAllowed;
    if (
      verifier.decision === 'accept'
      && (usageTransitionExceedsAuthority || learningTransitionExceedsAuthority)
    ) {
      const rejectCorrection = usageTransitionExceedsAuthority;
      transition = rejectCorrection ? 'reject_candidate' : 'defer';
      verifier = {
        decision: rejectCorrection ? 'reject' : 'defer',
        issues: [{
          code: rejectCorrection ? 'usage-reassessment-scope' : 'learning-episode-scope',
          message: rejectCorrection
            ? 'Correction-bound reassessment may only append evidence until a bounded correction and prior-guidance snapshot exist; retirement remains an explicit operator action.'
            : 'One Learning Episode may create a Skill or append evidence only to its bounded related-skill set; behavior replacement and structural catalog changes require dedicated evidence paths.',
          severity: rejectCorrection ? 'danger' : 'error',
        }],
        rationale: rejectCorrection
          ? 'Runtime rejected a transition that exceeded the target-bound authority of the correction.'
          : 'Runtime deferred a structural catalog change that requires a dedicated evidence path.',
      };
    }
    if (
      verifier.decision === 'accept'
      && isFlashcard
      && !nonMutatingTransition
      && transition !== 'create_current_skill'
    ) {
      transition = 'defer';
      verifier = {
        decision: 'defer',
        issues: [{
          code: 'flashcard-authority-scope',
          message: 'The flashcard evidence path may create one bounded Current Skill; updates to existing capabilities require their dedicated evidence path.',
          severity: 'error',
        }],
        rationale: 'Runtime deferred a flashcard transition outside its create-only authority.',
      };
    }
    const operatorEpisode = bundle.episode as {
      kind?: unknown;
      action?: unknown;
      capabilityHandle?: unknown;
    } | null;
    const operatorRetirementAllowed = authority.family === 'operator-control'
      && authority.targetCapabilityHandle === targetHandle
      && operatorEpisode?.kind === 'operator-skill-control'
      && operatorEpisode.action === 'retire'
      && operatorEpisode.capabilityHandle === targetHandle;
    if (
      verifier.decision === 'accept'
      && transition === 'retire_capability'
      && !operatorRetirementAllowed
    ) {
      transition = 'reject_candidate';
      verifier = {
        decision: 'reject',
        issues: [{
          code: 'retirement-requires-operator-control',
          message: 'Generated Current Skill retirement requires the explicit operator-control path.',
          severity: 'danger',
        }],
        rationale: 'Runtime rejected non-operator retirement authority.',
      };
    }
    let applied: AppliedTransition;
    const isCreateTransition = transition === 'create_current_skill' && verifier.decision === 'accept';
    const routingName = draft.envelope.routingName;
    const reservedRoutingName = isCreateTransition ? this.reserveCreateRoutingName(routingName) : false;
    if (isCreateTransition && !reservedRoutingName) {
      return {
        transition: 'reject_candidate',
        verified: false,
        rounds: round,
        draft,
        verifier: {
          decision: 'reject',
          issues: [{
            code: 'routing-name-collision',
            message: `Runtime detected a create Routing Name collision for ${routingName}.`,
            severity: 'danger',
          }],
          rationale: 'Runtime rejected the candidate due local optimistic in-flight create prefilter.',
        },
      };
    }
    assertAuditPathWritableAndReadable(this.options.auditPath);
    try {
      // Review Commit Fence: run inside the commit boundary immediately before
      // applyCapabilityTransition / journal / audit write, after the verifier
      // transition is known accepted. Returning a result aborts without journal.
      if (
        verifier.decision === 'accept'
        && transition !== 'defer'
        && transition !== 'reject_candidate'
        && beforeAcceptedCommit
      ) {
        const fenceAbort = await beforeAcceptedCommit({
          bundle,
          draft,
          verifier,
          transition,
          round,
          branchTranscriptPaths,
        });
        if (fenceAbort) {
          return fenceAbort;
        }
      }
      applied = applyCapabilityTransition({
        ...this.options,
        reviewerVersion: this.options.reviewerVersion ?? SKILL_EVOLUTION_REVIEWER_VERSION,
        promptVersion: this.options.promptVersion ?? 'skill-author-verifier-v3',
        manualSkillNames: this.getManualSkillNames(),
        bundle,
        draft,
        transition,
        verifier,
        registryReadSet: declaredRegistryReadSet(verifier, bundle, draft),
        branchTranscriptPaths,
      });
    } catch (error) {
      if (error instanceof CapabilityRoutingCollisionError) {
        return {
          transition: 'reject_candidate',
          verified: false,
          rounds: round,
          draft,
          verifier: {
            decision: 'reject',
            issues: [
              ...verifier.issues,
              {
                code: 'routing-collision',
                message: `Runtime detected a Routing Name collision for ${error.routingName}.`,
                severity: 'danger',
              },
            ],
            rationale: 'Runtime rejected the candidate after bounded commit collision checks.',
          },
        };
      }
      if (error instanceof StaleCapabilityReadSetError) {
        throw new ReviewCommitConflictError(error, { bundle, draft, verifier, round, branchTranscriptPaths });
      }
      throw error;
    } finally {
      if (reservedRoutingName) {
        this.releaseCreateRoutingName(routingName);
      }
    }
    assertTransitionAuditReadable(
      this.options.auditPath,
      applied.audit,
      this.options.branchLogRoot,
      this.options.workingDirectory,
    );
    return {
      transition,
      transitionId: applied.transitionId,
      verified: verifier.decision === 'accept',
      rounds: round,
      draft,
      verifier,
      record: applied.record,
      audit: applied.audit,
    };
  }

  private reserveCreateRoutingName(name: string | undefined): boolean {
    if (!name?.trim()) return false;
    const routingName = name.trim().toLowerCase();
    if (this.inFlightCreateRoutingNames.has(routingName)) {
      return false;
    }

    const manualNameSet = new Set(this.getManualSkillNames().map(item => item.toLowerCase()));
    if (manualNameSet.has(routingName)) {
      return false;
    }

    const registry = this.getRegistry();
    if (Object.values(registry.capabilities).some(item => item.routingName.toLowerCase() === routingName)) {
      return false;
    }

    this.inFlightCreateRoutingNames.add(routingName);
    return true;
  }

  private releaseCreateRoutingName(name: string | undefined): void {
    if (!name?.trim()) return;
    this.inFlightCreateRoutingNames.delete(name.trim().toLowerCase());
  }
}

function readerTranscriptRoot(workingDirectory?: string): string | undefined {
  if (!workingDirectory?.trim()) return undefined;
  return path.resolve(workingDirectory, 'data', 'reader-transcripts');
}

function resolveTranscriptAllowedRoots(
  branchLogRoot?: string,
  workingDirectory?: string,
): string[] {
  const roots = [path.resolve(branchLogRoot ?? PathResolver.getLogsPath('branches'))];
  const readerRoot = readerTranscriptRoot(workingDirectory);
  if (readerRoot) roots.push(readerRoot);
  return roots;
}

function assertHealthyBranchTranscript(
  filePath: string | null,
  expectedBranchType: string | undefined,
  branchLogRoot?: string,
  workingDirectory?: string,
): string {
  const label = expectedBranchType ?? 'branch';
  if (!filePath) throw new Error(`${label} transcript is disabled.`);
  const resolvedPath = path.resolve(filePath);
  const allowedRoots = resolveTranscriptAllowedRoots(branchLogRoot, workingDirectory);
  if (!allowedRoots.some(root => isPathInside(resolvedPath, root))) {
    throw new Error(`${label} transcript is outside the runtime transcript roots.`);
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`${label} transcript is missing.`);
  }

  const entries = fs.readFileSync(resolvedPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`${label} transcript is empty.`);
  }
  const eventTypes = new Set(entries.map(entry => entry.event_type));
  const actualEntryType = String(entries[0]?.entry_type ?? '');
  const actualBranchType = expectedBranchType ?? String(entries[0]?.branch_type ?? '');
  // Author/Verifier promotion transcripts use entry_type=branch; independent
  // Evidence Reader lanes use entry_type=reader under data/reader-transcripts.
  if (actualEntryType !== 'branch' && actualEntryType !== 'reader') {
    throw new Error(`${label} transcript has unsupported entry_type ${actualEntryType || '<missing>'}.`);
  }
  if (expectedBranchType && actualBranchType !== expectedBranchType) {
    throw new Error(`${label} transcript branch_type mismatch.`);
  }
  if (!entries.every(entry => (
    entry.entry_type === actualEntryType
    && entry.branch_type === actualBranchType
  ))) {
    throw new Error(`${label} transcript contains an invalid ${actualEntryType} entry.`);
  }
  if (!eventTypes.has('start') || !eventTypes.has('transcript')) {
    throw new Error(`${label} transcript is missing minimum reconstruction events.`);
  }
  if (!eventTypes.has('run_result') && !eventTypes.has('fixture_result') && !eventTypes.has('completed')) {
    throw new Error(`${label} transcript is missing a completion event.`);
  }
  const transcript = entries.find(entry => entry.event_type === 'transcript');
  if (!Array.isArray(transcript?.messages)) {
    throw new Error(`${label} transcript has no reconstructable messages.`);
  }
  return hashTranscriptFile(resolvedPath);
}

function assertAuditPathWritableAndReadable(auditPath: string): void {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.accessSync(path.dirname(auditPath), fs.constants.R_OK | fs.constants.W_OK);
  if (!fs.existsSync(auditPath)) return;
  fs.accessSync(auditPath, fs.constants.R_OK | fs.constants.W_OK);
  loadTransitionAudit(auditPath);
}

function assertTransitionAuditReadable(
  auditPath: string,
  audit: TransitionAuditEntry,
  branchLogRoot?: string,
  workingDirectory?: string,
): void {
  const entries = loadTransitionAudit(auditPath);
  const persisted = entries.find(entry => entry.transitionId === audit.transitionId);
  if (!persisted) throw new Error(`Transition Audit entry ${audit.transitionId} is not readable.`);
  const hashes = persisted.branchTranscriptHashes;
  if (hashes && hashes.length !== persisted.branchTranscriptPaths.length) {
    throw new Error(`Transition Audit entry ${audit.transitionId} has incomplete transcript hashes.`);
  }
  persisted.branchTranscriptPaths.forEach((transcriptPath, index) => {
    const actualHash = assertHealthyBranchTranscript(
      transcriptPath,
      undefined,
      branchLogRoot,
      workingDirectory,
    );
    if (hashes && actualHash !== hashes[index]) {
      throw new Error(`Transition Audit entry ${audit.transitionId} has a transcript hash mismatch.`);
    }
  });
}

function assertBranchTranscriptEvidence(
  transcriptPaths: readonly string[],
  branchLogRoot?: string,
  workingDirectory?: string,
): string[] {
  return transcriptPaths.map(transcriptPath => (
    assertHealthyBranchTranscript(transcriptPath, undefined, branchLogRoot, workingDirectory)
  ));
}

function hashTranscriptFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sanitizeTransitionAudit(input: TransitionAuditEntry): TransitionAuditEntry {
  return {
    ...input,
    branchTranscriptPaths: Array.isArray(input.branchTranscriptPaths)
      ? input.branchTranscriptPaths.filter((item): item is string => typeof item === 'string')
      : [],
    ...(Array.isArray(input.branchTranscriptHashes)
      ? { branchTranscriptHashes: input.branchTranscriptHashes.filter((item): item is string => typeof item === 'string') }
      : {}),
  };
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (
    !!relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export interface ApplyTransitionInput extends SkillEvolutionPaths {
  bundle: EvidenceBundle;
  draft: SkillDraft;
  transition: CapabilityTransitionKind;
  verifier: SkillVerifierResult;
  branchTranscriptPaths: string[];
  reviewerVersion: string;
  promptVersion: string;
  manualSkillNames?: readonly string[];
  registryReadSet?: readonly CapabilityReadSetEntry[];
  /**
   * Working directory used to authorize independent reader transcript roots
   * (`data/reader-transcripts`) during commit audit validation.
   */
  workingDirectory?: string;
}

export interface RestoreCapabilityRevisionInput extends SkillEvolutionPaths {
  targetCapabilityHandle: string;
  guidanceHash: string;
  reviewerVersion?: string;
  promptVersion?: string;
  branchTranscriptPaths?: readonly string[];
  rationale?: string;
}

export interface AppliedTransition {
  transitionId: string;
  record?: CurrentSkillRecord;
  audit: TransitionAuditEntry;
}

export class StaleCapabilityReadSetError extends Error {
  constructor(public readonly staleReadSet: CapabilityReadSetEntry[]) {
    super('Capability Registry read set is stale.');
    this.name = 'StaleCapabilityReadSetError';
  }
}

export class CapabilityRoutingCollisionError extends Error {
  constructor(public readonly routingName: string) {
    super(`Skill Routing Name collision: ${routingName}`);
    this.name = 'CapabilityRoutingCollisionError';
  }
}

class ReviewCommitConflictError extends Error {
  constructor(
    public readonly conflict: StaleCapabilityReadSetError | CapabilityRoutingCollisionError,
    public readonly review: {
      bundle: EvidenceBundle;
      draft: SkillDraft;
      verifier: SkillVerifierResult;
      round: number;
      branchTranscriptPaths: string[];
    },
  ) {
    super(conflict.message);
    this.name = 'ReviewCommitConflictError';
  }
}

class OperationalReviewError extends Error {
  public readonly transcriptPaths: string[];

  constructor(
    public readonly kind: OperationalReviewFailureKind,
    message: string,
    transcriptPaths: readonly string[] = [],
  ) {
    super(message);
    this.name = 'OperationalReviewError';
    this.transcriptPaths = uniqueStrings(transcriptPaths);
  }

  get transcriptPath(): string | undefined {
    return this.transcriptPaths[this.transcriptPaths.length - 1];
  }
}

export function emptyCurrentSkillRegistryState(): CurrentSkillRegistryState {
  return {
    schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
    catalogRevision: 0,
    routeRedirects: {},
    capabilities: {},
  };
}

export class CurrentSkillRegistrySchemaError extends Error {
  constructor(public readonly schemaVersion: unknown) {
    super(`Unsupported generated-skill Registry schema version: ${String(schemaVersion)}`);
    this.name = 'CurrentSkillRegistrySchemaError';
  }
}

export class CurrentSkillRegistryValidationError extends Error {
  constructor(message: string) {
    super(`Invalid generated-skill Registry state: ${message}`);
    this.name = 'CurrentSkillRegistryValidationError';
  }
}

export class ActiveGeneratedSkillInvariantError extends Error {
  constructor(
    public readonly handle: string,
    public readonly skillFilePath: string,
    public readonly reason: string,
  ) {
    super(
      `Active generated skill invariant violated for ${handle}: ${reason} (path=${skillFilePath})`,
    );
    this.name = 'ActiveGeneratedSkillInvariantError';
  }
}

export function loadCurrentSkillRegistry(filePath: string): CurrentSkillRegistryState {
  if (!fs.existsSync(filePath)) return emptyCurrentSkillRegistryState();
  let parsed: (Omit<Partial<CurrentSkillRegistryState>, 'schemaVersion'> & { schemaVersion?: unknown });
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof parsed;
  } catch (cause) {
    // Keep the invalid source in place so callers can fail closed and retry
    // after repair; quarantining here would make a later load look like an
    // empty Registry and could re-admit orphaned generated files.
    throw new CurrentSkillRegistryValidationError(
      `could not parse Registry JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed.schemaVersion !== SKILL_EVOLUTION_SCHEMA_VERSION) {
    throw new CurrentSkillRegistrySchemaError(parsed.schemaVersion);
  }
  if (!isRecord(parsed.capabilities)) {
    throw new CurrentSkillRegistryValidationError('capabilities must be an object');
  }
  validateRegistryState(parsed);
  return sanitizeRegistry(parsed as CurrentSkillRegistryState);
}

/**
 * Enforce: every active registry entry points at a present, parseable SKILL.md
 * whose content hash matches guidanceHash. Recovery is allowed only from the
 * authoritative immutable history snapshot for that hash — never by inventing
 * guidance from registry metadata alone.
 */
export function reconcileActiveGeneratedSkillArtifacts(
  state: CurrentSkillRegistryState,
  outputDir: string,
): { state: CurrentSkillRegistryState; repaired: boolean } {
  let repaired = false;
  const capabilities: Record<string, CurrentSkillRecord> = { ...state.capabilities };
  for (const [handle, record] of Object.entries(capabilities)) {
    const skillPath = record.skillFilePath;
    if (!skillPath?.trim()) {
      throw new ActiveGeneratedSkillInvariantError(handle, String(skillPath), 'skillFilePath is empty');
    }
    if (!isPathSafelyWithinDirectory(skillPath, outputDir)) {
      throw new ActiveGeneratedSkillInvariantError(
        handle,
        skillPath,
        'skillFilePath escapes the generated Skill root',
      );
    }
    if (!fs.existsSync(skillPath)) {
      const archivePath = path.join(path.dirname(skillPath), 'history', record.guidanceHash, 'SKILL.md');
      if (!isPathSafelyWithinDirectory(archivePath, outputDir)) {
        throw new ActiveGeneratedSkillInvariantError(
          handle,
          archivePath,
          'history snapshot path escapes the generated Skill root',
        );
      }
      if (!fs.existsSync(archivePath)) {
        throw new ActiveGeneratedSkillInvariantError(
          handle,
          skillPath,
          `SKILL.md is missing and no authoritative history snapshot exists for guidanceHash=${record.guidanceHash}`,
        );
      }
      const archiveContent = fs.readFileSync(archivePath, 'utf8');
      if (sha256(archiveContent) !== record.guidanceHash) {
        throw new ActiveGeneratedSkillInvariantError(
          handle,
          archivePath,
          'history snapshot hash does not match registry guidanceHash',
        );
      }
      // Safe recovery: restore the exact authoritative content only.
      writeFileAtomic(skillPath, archiveContent);
      repaired = true;
    }
    let parsedName: string;
    try {
      parsedName = SkillParser.parse(skillPath).metadata.name;
    } catch (error) {
      throw new ActiveGeneratedSkillInvariantError(
        handle,
        skillPath,
        `SKILL.md is not parseable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsedName !== record.routingName) {
      throw new ActiveGeneratedSkillInvariantError(
        handle,
        skillPath,
        `SKILL.md route "${parsedName}" does not match registry routingName "${record.routingName}"`,
      );
    }
    const contentHash = hashFile(skillPath);
    if (!contentHash || contentHash !== record.guidanceHash) {
      throw new ActiveGeneratedSkillInvariantError(
        handle,
        skillPath,
        `SKILL.md hash ${contentHash ?? 'missing'} does not match registry guidanceHash ${record.guidanceHash}`,
      );
    }
  }
  return { state: { ...state, capabilities }, repaired };
}

export function saveCurrentSkillRegistry(filePath: string, state: CurrentSkillRegistryState): void {
  writeJsonAtomic(filePath, state);
}

export function computeCurrentSkillRegistryHash(state: CurrentSkillRegistryState): string {
  return stableHash(state);
}

export function loadTransitionAudit(filePath: string): TransitionAuditEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => sanitizeTransitionAudit(JSON.parse(line) as TransitionAuditEntry));
}

/**
 * Replays of one fixed Evidence Bundle must not manufacture a second copy of
 * the same transition. The audit's bundleId is the durable idempotency key;
 * the same bundle may still progress through a deferred review or a later
 * material transition, so only a matching transition/target is short-circuited.
 */
function findIdempotentTransition(
  input: ApplyTransitionInput,
  registry: CurrentSkillRegistryState,
  targetHandle: string | undefined,
  sourceHandle: string | undefined,
): AppliedTransition | undefined {
  // Non-mutating outcomes are not crash-recovery targets: the same bundle may
  // emit multiple distinct defer/reject audits (different drafts/rationale).
  // Treating them as idempotent would short-circuit later rejects and re-check
  // older transcript paths that later jobs may legitimately supersede.
  if (input.transition === 'reject_candidate' || input.transition === 'defer') {
    return undefined;
  }

  const prior = loadTransitionAudit(input.auditPath)
    .filter(entry => entry.bundleId === input.bundle.bundleId)
    .slice()
    .reverse();
  if (prior.length === 0) return undefined;

  const committed = prior.find(entry => (
    entry.transition === input.transition
    && (!targetHandle || entry.involvedCapabilityHandles.includes(targetHandle))
    && (!sourceHandle || entry.involvedCapabilityHandles.includes(sourceHandle))
    && (input.transition !== 'create_current_skill' && input.transition !== 'migrate_skill_route'
      || entry.resultingRoutingName === input.draft.envelope.routingName?.trim())
  ));
  // A bundle can legitimately move through defer/review or append/revise
  // transitions over its lifetime. Only the same transition against the same
  // target (and, for creation, the same public route) is an idempotent retry;
  // otherwise this is a fresh transition and normal validation continues.
  if (!committed) return undefined;

  const activeHandle = targetHandle
    ?? committed.involvedCapabilityHandles.find(handle => registry.capabilities[handle]);
  const record = activeHandle ? registry.capabilities[activeHandle] : undefined;
  const guidanceTransition = new Set<CapabilityTransitionKind>([
    'create_current_skill',
    'append_evidence',
    'replace_current_skill',
    'migrate_skill_route',
    'merge_into_capability',
  ]);
  if (guidanceTransition.has(input.transition)) {
    if (!record || record.guidanceHash !== committed.resultingGuidanceHash) {
      throw new Error(`Committed Capability Transition state no longer matches bundleId ${input.bundle.bundleId}.`);
    }
  } else if (input.transition === 'retire_capability' && record) {
    throw new Error(`Committed Capability Transition state no longer matches bundleId ${input.bundle.bundleId}.`);
  }

  return { transitionId: committed.transitionId, record, audit: committed };
}

export function recoverTransitionJournal(
  paths: Pick<SkillEvolutionPaths, 'outputDir' | 'registryPath' | 'auditPath' | 'journalPath'>,
): boolean {
  const journal = loadTransitionJournalForInspection(paths);
  if (!journal) return false;
  if (journal.committedAt) {
    fs.unlinkSync(paths.journalPath);
    return true;
  }
  const current = loadCurrentSkillRegistry(paths.registryPath);
  const currentRegistryHash = stableHash(current);
  if (
    journal.priorRegistryHash !== undefined
    && currentRegistryHash !== journal.priorRegistryHash
    && currentRegistryHash !== journal.targetRegistryHash
  ) {
    throw new Error(
      `Transition journal Registry precondition no longer matches: current=${currentRegistryHash}`,
    );
  }
  // Apply file operations even when the Registry already reached its target:
  // a crash can happen between any two of the three durable replacements.
  for (const operation of journal.skillOperations) {
    const currentHash = hashFile(operation.path);
    if (operation.delete) {
      if (currentHash === undefined) continue;
      if (operation.priorHash !== undefined && currentHash !== operation.priorHash) {
        throw new Error(`Transition journal file precondition no longer matches at ${operation.path}.`);
      }
      fs.unlinkSync(operation.path);
    } else if (operation.content !== undefined) {
      if (
        operation.priorHash !== undefined
        && currentHash !== operation.expectedHash
        && (
          operation.priorHash === null
            ? currentHash !== undefined
            : currentHash !== operation.priorHash
        )
      ) {
        throw new Error(`Transition journal file precondition no longer matches at ${operation.path}.`);
      }
      if (operation.immutable && currentHash !== undefined && currentHash !== operation.expectedHash) {
        throw new Error(`Immutable guidance snapshot collision at ${operation.path}.`);
      }
      if (currentHash !== operation.expectedHash) writeFileAtomic(operation.path, operation.content);
    }
  }
  if (stableHash(current) !== journal.targetRegistryHash) {
    saveCurrentSkillRegistry(paths.registryPath, journal.targetRegistry);
  }
  const audits = loadTransitionAudit(paths.auditPath);
  if (!audits.some(entry => entry.transitionId === journal.transitionId)) {
    fs.mkdirSync(path.dirname(paths.auditPath), { recursive: true });
    fs.appendFileSync(paths.auditPath, JSON.stringify(journal.audit) + '\n', 'utf8');
  }
  writeJsonAtomic(paths.journalPath, { ...journal, committedAt: new Date().toISOString() });
  fs.unlinkSync(paths.journalPath);
  return true;
}

/**
 * Read and validate a pending transition without applying or deleting it.
 * Operator confirmation flows use this to describe a crash-recovery state
 * without turning inspection into a write-capable action.
 */
export function loadTransitionJournalForInspection(
  paths: Pick<SkillEvolutionPaths, 'outputDir' | 'journalPath'>,
): TransitionJournal | undefined {
  if (!fs.existsSync(paths.journalPath)) return undefined;
  const journal = JSON.parse(fs.readFileSync(paths.journalPath, 'utf8')) as TransitionJournal;
  // Validate the durable record before honoring even its metadata. A
  // malformed or operator-tampered journal remains in place for inspection.
  validateTransitionJournalForRecovery(journal, paths.outputDir);
  return journal;
}

/** Validate every recovery-owned write target before replaying any operation. */
function validateTransitionJournalForRecovery(
  journal: TransitionJournal,
  outputDir: string,
): void {
  if (
    !isRecord(journal)
    || !Number.isInteger(journal.schemaVersion)
    || journal.schemaVersion < 1
    || journal.schemaVersion > SKILL_EVOLUTION_SCHEMA_VERSION
    || !isNonEmptyString(journal.transitionId)
    || !isNonEmptyString(journal.targetRegistryHash)
    || (journal.priorRegistryHash !== undefined && !isNonEmptyString(journal.priorRegistryHash))
    || !isRecord(journal.targetRegistry)
    || !Array.isArray(journal.skillOperations)
    || !isRecord(journal.audit)
    || journal.audit.transitionId !== journal.transitionId
  ) {
    throw new Error('Transition journal is malformed.');
  }
  validateRegistryState(journal.targetRegistry);
  if (stableHash(journal.targetRegistry) !== journal.targetRegistryHash) {
    throw new Error('Transition journal target Registry hash does not match its payload.');
  }
  for (const record of Object.values(journal.targetRegistry.capabilities)) {
    if (!isPathSafelyWithinDirectory(record.skillFilePath, outputDir)) {
      throw new Error(`Transition journal Registry path escapes the generated Skill root: ${record.skillFilePath}`);
    }
  }
  for (const operation of journal.skillOperations) {
    if (
      !isRecord(operation)
      || !isNonEmptyString(operation.path)
      || !isPathSafelyWithinDirectory(operation.path, outputDir)
      || (operation.delete !== true && typeof operation.content !== 'string')
      || (operation.delete === true && operation.content !== undefined)
      || (typeof operation.content === 'string' && !isNonEmptyString(operation.expectedHash))
      || (
        typeof operation.content === 'string'
        && sha256(operation.content) !== operation.expectedHash
      )
      || (
        operation.priorHash !== undefined
        && operation.priorHash !== null
        && !isNonEmptyString(operation.priorHash)
      )
    ) {
      throw new Error('Transition journal contains an unsafe or malformed Skill operation.');
    }
  }
}

export function applyCapabilityTransition(input: ApplyTransitionInput): AppliedTransition {
  recoverTransitionJournal(input);
  validateEvidenceBundle(input.bundle);
  const registry = loadCurrentSkillRegistry(input.registryPath);
  const envelope = input.draft?.envelope ?? {};
  const targetHandle = typeof envelope.targetCapabilityHandle === 'string' ? envelope.targetCapabilityHandle : undefined;
  const sourceHandle = typeof envelope.sourceCapabilityHandle === 'string' ? envelope.sourceCapabilityHandle : undefined;
  const idempotent = findIdempotentTransition(input, registry, targetHandle, sourceHandle);
  if (idempotent) {
    assertTransitionAuditReadable(
      input.auditPath,
      idempotent.audit,
      input.branchLogRoot,
      input.workingDirectory,
    );
    return idempotent;
  }
  const registryReadSet = normalizeRegistryReadSet(input.registryReadSet ?? []);
  // Authority for target-bound mutations is evaluated against Registry state.
  // Establish the optimistic-concurrency precondition first so a concurrent
  // revision is classified as stale review work, not as an authority failure
  // caused by comparing frozen evidence with a newer guidance revision.
  assertRegistryReadSetCurrent(registry, registryReadSet);
  assertTransitionTargetsWereRead(input, registryReadSet);
  const authorityViolation = transitionAuthorityViolation(
    input.bundle,
    input.transition,
    targetHandle,
    registry,
  );
  if (authorityViolation) {
    throw new Error(`Evidence Bundle mutation authority rejected: ${authorityViolation}`);
  }
  const now = new Date().toISOString();
  const transitionId = `transition-${randomUUID()}`;
  const evidenceRefs = selectedEvidenceRefs(input.draft, input.bundle);
  const routingName = typeof envelope.routingName === 'string' ? envelope.routingName.trim() : '';
  const existing = targetHandle ? registry.capabilities[targetHandle] : undefined;
  const manualNames = new Set([
    ...(input.manualSkillNames ?? []),
    ...discoverManualSkillSnapshots(input.outputDir).map(skill => skill.name),
  ]);

  validateTransitionInput(input, registry, existing, manualNames, routingName, evidenceRefs);
  const branchTranscriptHashes = assertBranchTranscriptEvidence(
    input.branchTranscriptPaths,
    input.branchLogRoot,
    input.workingDirectory,
  );
  const target = cloneRegistry(registry);
  const operations: TransitionJournal['skillOperations'] = [];
  let resultingRecord: CurrentSkillRecord | undefined;
  let priorGuidanceHash: string | null = null;
  let resultingGuidanceHash: string | null = null;
  const involved = [targetHandle, sourceHandle].filter((value): value is string => !!value);

  if (input.transition === 'create_current_skill') {
    const handle = opaqueCapabilityHandle();
    const skillPath = path.join(input.outputDir, handle, 'SKILL.md');
    const content = renderCurrentSkill(input.draft, handle, transitionId, evidenceRefs);
    resultingGuidanceHash = sha256(content);
    resultingRecord = {
      handle,
      revision: 1,
      routingName,
      description: input.draft.envelope.description!.trim(),
      skillFilePath: skillPath,
      guidanceHash: resultingGuidanceHash,
      guidanceContentHash: guidanceBodyHash(input.draft.body),
      evidenceRefs: evidenceRefs.map(ref => ({ ref })),
      referencedSkills: referencedSkillSnapshots(input.draft, input.bundle),
      semanticObservations: normalizeSemanticObservations(input.bundle.semanticObservations),
      createdAt: now,
      updatedAt: now,
    };
    target.capabilities[handle] = resultingRecord;
    involved.push(handle);
    operations.push({
      path: skillPath,
      content,
      expectedHash: sha256(content),
      priorHash: null,
    });
  } else if (input.transition === 'migrate_skill_route') {
    priorGuidanceHash = existing!.guidanceHash;
    const currentHash = hashFile(existing!.skillFilePath);
    if (currentHash !== existing!.guidanceHash) throw new Error('Active guidance hash does not match the Capability Registry.');
    const migrationDraft = input.draft.envelope.description?.trim()
      ? input.draft
      : { ...input.draft, envelope: { ...input.draft.envelope, description: existing!.description } };
    const content = renderCurrentSkill(migrationDraft, existing!.handle, transitionId, evidenceRefs);
    resultingGuidanceHash = sha256(content);
    resultingRecord = {
      ...existing!,
      revision: existing!.revision + 1,
      routingName,
      description: input.draft.envelope.description?.trim() || existing!.description,
      guidanceHash: resultingGuidanceHash,
      guidanceContentHash: guidanceBodyHash(migrationDraft.body),
      evidenceRefs: mergeEvidence(existing!.evidenceRefs, evidenceRefs),
      referencedSkills: referencedSkillSnapshots(migrationDraft, input.bundle),
      semanticObservations: normalizeSemanticObservations([
        ...(existing!.semanticObservations ?? []),
        ...(input.bundle.semanticObservations ?? []),
      ]),
      updatedAt: now,
    };
    target.capabilities[existing!.handle] = resultingRecord;
    target.routeRedirects[existing!.routingName] = existing!.handle;
    const previousContent = fs.readFileSync(existing!.skillFilePath, 'utf8');
    operations.push({
      path: path.join(path.dirname(existing!.skillFilePath), 'history', existing!.guidanceHash, 'SKILL.md'),
      content: previousContent,
      expectedHash: existing!.guidanceHash,
      priorHash: null,
      immutable: true,
    });
    operations.push({
      path: existing!.skillFilePath,
      content,
      expectedHash: sha256(content),
      priorHash: existing!.guidanceHash,
    });
  } else if (input.transition === 'replace_current_skill') {
    priorGuidanceHash = existing!.guidanceHash;
    const currentHash = hashFile(existing!.skillFilePath);
    if (currentHash !== existing!.guidanceHash) throw new Error('Active guidance hash does not match the Capability Registry.');
    const replacementDraft = input.draft.envelope.description?.trim()
      ? input.draft
      : { ...input.draft, envelope: { ...input.draft.envelope, description: existing!.description } };
    const content = renderCurrentSkill(replacementDraft, existing!.handle, transitionId, evidenceRefs);
    resultingGuidanceHash = sha256(content);
    resultingRecord = {
      ...existing!,
      revision: existing!.revision + 1,
      description: replacementDraft.envelope.description!.trim(),
      guidanceHash: resultingGuidanceHash,
      guidanceContentHash: guidanceBodyHash(input.draft.body),
      evidenceRefs: mergeEvidence(existing!.evidenceRefs, evidenceRefs),
      referencedSkills: referencedSkillSnapshots(input.draft, input.bundle),
      semanticObservations: existing!.semanticObservations ?? [],
      updatedAt: now,
    };
    target.capabilities[existing!.handle] = resultingRecord;
    const previousContent = fs.readFileSync(existing!.skillFilePath, 'utf8');
    const historyPath = path.join(path.dirname(existing!.skillFilePath), 'history', existing!.guidanceHash, 'SKILL.md');
    operations.push({
      path: historyPath,
      content: previousContent,
      expectedHash: existing!.guidanceHash,
      priorHash: null,
      immutable: true,
    });
    operations.push({
      path: existing!.skillFilePath,
      content,
      expectedHash: sha256(content),
      priorHash: existing!.guidanceHash,
    });
  } else if (input.transition === 'append_evidence') {
    priorGuidanceHash = existing!.guidanceHash;
    resultingGuidanceHash = existing!.guidanceHash;
    resultingRecord = {
      ...existing!,
      // Evidence metadata may include runtime-proven dependencies and bounded
      // semantic observations. It never changes active guidance, route, or
      // guidance hash, but still advances the Registry revision so an older
      // read set cannot overwrite the newly admitted evidence.
      revision: existing!.revision + 1,
      evidenceRefs: mergeEvidence(existing!.evidenceRefs, evidenceRefs),
      referencedSkills: input.draft.envelope.referencedSkills !== undefined
        ? referencedSkillSnapshots(input.draft, input.bundle)
        : existing!.referencedSkills,
      semanticObservations: normalizeSemanticObservations([
        ...(existing!.semanticObservations ?? []),
        ...(input.bundle.semanticObservations ?? []),
      ]),
      updatedAt: now,
    };
    target.capabilities[existing!.handle] = resultingRecord;
  } else if (input.transition === 'merge_into_capability') {
    const source = registry.capabilities[sourceHandle!];
    priorGuidanceHash = source.guidanceHash;
    resultingGuidanceHash = existing!.guidanceHash;
    resultingRecord = {
      ...existing!,
      revision: existing!.revision + 1,
      evidenceRefs: mergeEvidence(existing!.evidenceRefs, [...source.evidenceRefs.map(ref => ref.ref), ...evidenceRefs]),
      semanticObservations: existing!.semanticObservations ?? [],
      updatedAt: now,
    };
    target.capabilities[existing!.handle] = resultingRecord;
    delete target.capabilities[source.handle];
    operations.push({
      path: source.skillFilePath,
      priorHash: source.guidanceHash,
      delete: true,
    });
  } else if (input.transition === 'retire_capability') {
    priorGuidanceHash = existing!.guidanceHash;
    resultingGuidanceHash = null;
    // Retirement must remain reversible.  Keep the exact active body in the
    // immutable revision store before removing the Registry-owned artifact;
    // recovery reuses the same journal semantics as replacement/merge.
    const currentContent = fs.readFileSync(existing!.skillFilePath, 'utf8');
    const currentHash = sha256(currentContent);
    if (currentHash !== existing!.guidanceHash) {
      throw new Error('Active guidance hash does not match the Capability Registry.');
    }
    operations.push({
      path: path.join(path.dirname(existing!.skillFilePath), 'history', existing!.guidanceHash, 'SKILL.md'),
      content: currentContent,
      expectedHash: existing!.guidanceHash,
      priorHash: null,
      immutable: true,
    });
    operations.push({
      path: existing!.skillFilePath,
      priorHash: existing!.guidanceHash,
      delete: true,
    });
    delete target.capabilities[existing!.handle];
    // A retired capability cannot remain the target of a route redirect: the
    // Registry validator intentionally rejects redirects to missing handles.
    // Explicit retirement therefore removes all aliases for this capability;
    // the append-only transition audit retains their historical identity.
    for (const [route, handle] of Object.entries(target.routeRedirects)) {
      if (handle === existing!.handle) delete target.routeRedirects[route];
    }
  }

  if (input.transition === 'create_current_skill'
    || input.transition === 'append_evidence'
    || input.transition === 'replace_current_skill'
    || input.transition === 'migrate_skill_route'
    || input.transition === 'merge_into_capability'
    || input.transition === 'retire_capability') {
    target.catalogRevision += 1;
  }

  const audit: TransitionAuditEntry = {
    schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
    transitionId,
    transition: input.transition,
    bundleId: input.bundle.bundleId,
    occurredAt: now,
    reviewerVersion: input.reviewerVersion,
    promptVersion: input.promptVersion,
    evidenceRefs,
    involvedCapabilityHandles: uniqueStrings(involved),
    registryReadSet,
    priorGuidanceHash,
    resultingGuidanceHash,
    priorRoutingName: existing?.routingName ?? null,
    resultingRoutingName: resultingRecord?.routingName ?? null,
    branchTranscriptPaths: [...input.branchTranscriptPaths],
    branchTranscriptHashes,
    rationale: input.verifier.rationale,
  };
  const journal: TransitionJournal = {
    schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
    transitionId,
    priorRegistryHash: stableHash(registry),
    targetRegistryHash: stableHash(target),
    targetRegistry: target,
    skillOperations: operations,
    audit,
  };
  writeJsonAtomic(input.journalPath, journal);
  recoverTransitionJournal(input);
  assertTransitionAuditReadable(
    input.auditPath,
    audit,
    input.branchLogRoot,
    input.workingDirectory,
  );
  return { transitionId, record: resultingRecord, audit };
}

/** Explicit, audited restoration of one immutable guidance snapshot. */
export function restoreCapabilityRevision(input: RestoreCapabilityRevisionInput): AppliedTransition {
  recoverTransitionJournal(input);
  const registry = loadCurrentSkillRegistry(input.registryPath);
  const current = registry.capabilities[input.targetCapabilityHandle];
  if (!current) throw new Error('Capability revision restore target is not active.');
  const restoreBundleId = `restore:${current.handle}:${input.guidanceHash}`;
  const committedRestore = loadTransitionAudit(input.auditPath)
    .slice()
    .reverse()
    .find(entry => entry.bundleId === restoreBundleId && entry.transition === 'restore_capability_revision');
  if (committedRestore) {
    if (current.guidanceHash !== input.guidanceHash) {
      throw new Error('Committed capability revision restore no longer matches the active Registry state.');
    }
    return { transitionId: committedRestore.transitionId, record: current, audit: committedRestore };
  }
  if (current.guidanceHash === input.guidanceHash) throw new Error('Capability revision is already active.');
  const archivePath = path.join(path.dirname(current.skillFilePath), 'history', input.guidanceHash, 'SKILL.md');
  if (!fs.existsSync(archivePath)) throw new Error(`Immutable guidance snapshot not found: ${input.guidanceHash}`);
  const content = fs.readFileSync(archivePath, 'utf8');
  if (sha256(content) !== input.guidanceHash) throw new Error('Immutable guidance snapshot hash mismatch.');
  const restoredGuidanceContentHash = guidanceBodyHashFromFile(archivePath);
  if (!restoredGuidanceContentHash) {
    throw new Error('Immutable guidance snapshot has no valid executable guidance body.');
  }
  const activeHash = hashFile(current.skillFilePath);
  if (activeHash !== current.guidanceHash) throw new Error('Active guidance hash does not match the Capability Registry.');

  const now = new Date().toISOString();
  const transitionId = `transition-${randomUUID()}`;
  const target = cloneRegistry(registry);
  const restored: CurrentSkillRecord = {
    ...current,
    revision: current.revision + 1,
    guidanceHash: input.guidanceHash,
    guidanceContentHash: restoredGuidanceContentHash,
    updatedAt: now,
  };
  target.capabilities[current.handle] = restored;
  target.catalogRevision += 1;
  const operations: TransitionJournal['skillOperations'] = [
    {
      path: path.join(path.dirname(current.skillFilePath), 'history', current.guidanceHash, 'SKILL.md'),
      content: fs.readFileSync(current.skillFilePath, 'utf8'),
      expectedHash: current.guidanceHash,
      priorHash: null,
      immutable: true,
    },
    {
      path: current.skillFilePath,
      content,
      expectedHash: input.guidanceHash,
      priorHash: current.guidanceHash,
    },
  ];
  const audit: TransitionAuditEntry = {
    schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
    transitionId,
    transition: 'restore_capability_revision',
    bundleId: restoreBundleId,
    occurredAt: now,
    reviewerVersion: input.reviewerVersion ?? SKILL_EVOLUTION_REVIEWER_VERSION,
    promptVersion: input.promptVersion ?? 'skill-restore-v1',
    evidenceRefs: [],
    involvedCapabilityHandles: [current.handle],
    registryReadSet: [{ handle: current.handle, revision: current.revision }],
    priorGuidanceHash: current.guidanceHash,
    resultingGuidanceHash: input.guidanceHash,
    priorRoutingName: current.routingName,
    resultingRoutingName: current.routingName,
    branchTranscriptPaths: [...(input.branchTranscriptPaths ?? [])],
    rationale: input.rationale ?? `Explicitly restored immutable guidance revision ${input.guidanceHash}.`,
  };
  const journal: TransitionJournal = {
    schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
    transitionId,
    priorRegistryHash: stableHash(registry),
    targetRegistryHash: stableHash(target),
    targetRegistry: target,
    skillOperations: operations,
    audit,
  };
  writeJsonAtomic(input.journalPath, journal);
  recoverTransitionJournal(input);
  return { transitionId, record: restored, audit };
}

function validateEvidenceBundle(bundle: EvidenceBundle): void {
  if (!bundle || !bundle.bundleId || bundle.episode == null) throw new Error('Evidence Bundle must contain an episode and bundleId.');
  requireExplicitEvidenceBundleAuthority(bundle);
  if (!Array.isArray(bundle.completionEvidence) || bundle.completionEvidence.length === 0) throw new Error('Evidence Bundle is missing completion evidence.');
  if (!Array.isArray(bundle.settlementEvidence) || bundle.settlementEvidence.length === 0) throw new Error('Evidence Bundle is missing settlement evidence.');
  const completionRefs = bundle.completionEvidence.map(item => item.ref);
  const settlementRefs = bundle.settlementEvidence.map(item => item.ref);
  const refs = [...completionRefs, ...settlementRefs];
  if (refs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error('Evidence Bundle contains invalid evidence refs.');
  if (new Set(completionRefs).size !== completionRefs.length) throw new Error('Evidence Bundle contains duplicate completion refs.');
  if (new Set(settlementRefs).size !== settlementRefs.length) throw new Error('Evidence Bundle contains duplicate settlement refs.');
  if (!Array.isArray(bundle.referencedSkills) || !Array.isArray(bundle.relatedCurrentSkills)) throw new Error('Evidence Bundle is incomplete.');
  if (bundle.referencedSkillProvenance !== undefined && !isRuntimeOwnedReferencedSkillProvenance(bundle.referencedSkillProvenance)) {
    throw new Error('Evidence Bundle referenced-skill provenance is malformed.');
  }
  if (bundle.semanticObservations !== undefined) {
    if (!Array.isArray(bundle.semanticObservations) || bundle.semanticObservations.length > 12) {
      throw new Error('Evidence Bundle semantic observations exceed the bounded limit.');
    }
    if (Buffer.byteLength(JSON.stringify(bundle.semanticObservations), 'utf8') > 8192) {
      throw new Error('Evidence Bundle semantic observations exceed the bounded payload.');
    }
    if (bundle.semanticObservations.some(observation =>
      !observation
      || !isSemanticObservationKind(observation.kind)
      || typeof observation.value !== 'string'
      || observation.value.length > 512
      || !Array.isArray(observation.sourceRefs)
      || observation.sourceRefs.length === 0
      || observation.sourceRefs.some((ref: unknown) => typeof ref !== 'string' || !ref.trim() || ref.length > 512),
    )) {
      throw new Error('Evidence Bundle semantic observations are malformed.');
    }
  }
  if (bundle.sourceEvidence !== undefined) {
    const failure = validateFrozenSourceEvidence({
      completionEvidence: bundle.completionEvidence,
      settlementEvidence: bundle.settlementEvidence,
      sourceEvidence: bundle.sourceEvidence,
    });
    if (failure) throw new Error(`Evidence Bundle source evidence is invalid: ${failure.message}`);
  }
}

/**
 * Check the minimum provenance needed to replay an ordinary Learning Episode
 * review without consulting its mutable source log. This is intentionally
 * stricter than the legacy optional Bundle contract and is used only when
 * quarantining already-persisted jobs from before source snapshots existed.
 */
function hasCompleteFrozenSourceEvidence(bundle: EvidenceBundle): boolean {
  return !validateFrozenSourceEvidence({
    completionEvidence: bundle.completionEvidence,
    settlementEvidence: bundle.settlementEvidence,
    sourceEvidence: bundle.sourceEvidence,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRuntimeOwnedReferencedSkillProvenance(
  value: unknown,
): value is RuntimeOwnedReferencedSkillProvenance {
  if (!value || typeof value !== 'object') return false;
  const provenance = value as Partial<RuntimeOwnedReferencedSkillProvenance>;
  return provenance.kind === 'runtime-owned-generated-skill-load-v1'
    && isNonEmptyString(provenance.runtimeSessionId)
    && isNonEmptyString(provenance.agentTurnEpisodeId)
    && Array.isArray(provenance.referencedSkills)
    && provenance.referencedSkills.every(skill => (
      !!skill
      && typeof skill === 'object'
      && isNonEmptyString((skill as TrustedReferencedSkillIdentity).capabilityHandle)
      && isNonEmptyString((skill as TrustedReferencedSkillIdentity).routingName)
      && isNonEmptyString((skill as TrustedReferencedSkillIdentity).guidanceHash)
    ));
}

function trustedReferencedSkillIdentityKey(skill: TrustedReferencedSkillIdentity): string {
  return `${skill.capabilityHandle}\u0000${skill.routingName}\u0000${skill.guidanceHash}`;
}

function referencedSkillSnapshotIdentityKey(snapshot: ReferencedSkillSnapshot): string | undefined {
  if (!snapshot.capabilityHandle || !snapshot.name || !snapshot.guidanceHash) return undefined;
  return `${snapshot.capabilityHandle}\u0000${snapshot.name}\u0000${snapshot.guidanceHash}`;
}

function selectTrustedPersistedReferencedSkills(bundle: EvidenceBundle): ReferencedSkillSnapshot[] {
  const provenance = bundle.referencedSkillProvenance;
  if (!isRuntimeOwnedReferencedSkillProvenance(provenance)) return [];
  const provenIdentities = new Set(provenance.referencedSkills.map(trustedReferencedSkillIdentityKey));
  if (provenIdentities.size === 0) return [];
  return bundle.referencedSkills.filter(snapshot => {
    const identity = referencedSkillSnapshotIdentityKey(snapshot);
    return !!identity && provenIdentities.has(identity);
  });
}

function normalizeSemanticObservations(observations: readonly SemanticObservation[] | undefined): SemanticObservation[] {
  if (!observations) return [];
  const deduped = new Map<string, SemanticObservation>();
  for (const observation of observations) {
    if (!observation || !isSemanticObservationKind(observation.kind) || typeof observation.value !== 'string' || !Array.isArray(observation.sourceRefs)) continue;
    const sourceRefs = uniqueStrings(observation.sourceRefs).filter(ref => ref.length <= 512);
    if (sourceRefs.length === 0) continue;
    const bounded = {
      kind: observation.kind,
      value: observation.value.slice(0, 512),
      sourceRefs,
    } satisfies SemanticObservation;
    deduped.set(`${bounded.kind}:${bounded.value}:${sourceRefs.join(',')}`, bounded);
  }
  const bounded = [...deduped.values()].slice(0, 12);
  while (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > 8192 && bounded.length > 0) bounded.pop();
  return bounded;
}

function isSemanticObservationKind(value: unknown): value is SemanticObservation['kind'] {
  return typeof value === 'string' && new Set<SemanticObservation['kind']>([
    'user-intent',
    'workflow-tool',
    'artifact-operation',
    'verification',
    'correction-or-contradiction',
    'referenced-skill',
  ]).has(value as SemanticObservation['kind']);
}

function isLikelyDistilledKnowledgeCandidate(value: unknown): value is DistilledKnowledgeCandidate {
  return !!value
    && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'capability';
}

function validateDraft(draft: SkillDraft, bundle: EvidenceBundle, manualSkillNames: readonly string[]): SkillVerifierIssue[] {
  const issues: SkillVerifierIssue[] = [];
  if (!draft || typeof draft.body !== 'string' || !draft.body.trim()) issues.push(issue('empty-draft', 'Skill Draft body is empty.', 'danger'));
  if (/^\s*---(?:\r?\n|$)/.test(draft?.body ?? '')) issues.push(issue('frontmatter', 'Skill Draft must not contain YAML frontmatter.', 'danger'));
  const envelope = draft?.envelope;
  if (!envelope || !isTransition(envelope.decision)) issues.push(issue('envelope', 'Skill Authoring Envelope has an invalid transition.', 'danger'));
  if (envelope?.routingName && (typeof envelope.routingName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(envelope.routingName))) issues.push(issue('routing-name', 'Skill Routing Name must be semantic kebab-case.', 'danger'));
  const routingName = envelope?.routingName;
  if (
    envelope?.decision === 'create_current_skill'
    && bundle.semanticObservations !== undefined
    && bundle.semanticObservations.length === 0
  ) {
    issues.push(issue(
      'insufficient-semantic-evidence',
      'Current Skill creation requires at least one durable Semantic Observation; defer until bounded naming evidence is available.',
      'error',
    ));
  }
  const requiresSemanticRoutingName = envelope?.decision === 'create_current_skill'
    || envelope?.decision === 'migrate_skill_route';
  if (requiresSemanticRoutingName && typeof routingName === 'string' && isLifecycleOrGenericRoutingName(routingName)) {
    issues.push(issue('lifecycle-routing-name', 'Skill Routing Name is lifecycle-bound or generic; the Author must propose a precise semantic name.', 'error'));
  }
  if (envelope?.decision === 'replace_current_skill' && envelope.targetCapabilityHandle && typeof routingName === 'string') {
    const priorRoute = bundle.relatedCurrentSkills.find(skill => skill.handle === envelope.targetCapabilityHandle)?.routingName;
    if (priorRoute && routingName !== priorRoute) {
      issues.push(issue(
        'replace-route-mismatch',
        'replace_current_skill must preserve the existing Skill Routing Name; use migrate_skill_route for a public rename.',
        'error',
      ));
    }
  }
  if (envelope?.decision === 'migrate_skill_route' && envelope.targetCapabilityHandle) {
    const priorRoute = bundle.relatedCurrentSkills.find(skill => skill.handle === envelope.targetCapabilityHandle)?.routingName;
    if (priorRoute && draft.body.toLowerCase().includes(priorRoute.toLowerCase())) {
      issues.push(issue('stale-route-reference', 'Migrated guidance still embeds the retired route; rewrite the body or defer the migration.', 'error'));
    }
  }
  if (envelope?.referencedSkills !== undefined && !Array.isArray(envelope.referencedSkills)) issues.push(issue('referenced-skills-shape', 'Referenced Skills must be a list of names.', 'danger'));
  if (Array.isArray(envelope?.referencedSkills) && envelope!.referencedSkills.some(name => typeof name !== 'string' || !bundle.referencedSkills.some(skill => skill.name === name))) issues.push(issue('missing-referenced-skill', 'Draft references a skill outside the fixed Evidence Bundle.', 'danger'));
  if (envelope?.evidenceRefs !== undefined && !Array.isArray(envelope.evidenceRefs)) issues.push(issue('evidence-refs-shape', 'Evidence refs must be a list of strings.', 'danger'));
  const availableEvidence = new Set(fixedEvidenceRefs(bundle));
  if (Array.isArray(envelope?.evidenceRefs) && envelope!.evidenceRefs.some(ref => typeof ref !== 'string' || !availableEvidence.has(ref))) issues.push(issue('missing-evidence', 'Draft cites evidence outside the fixed Evidence Bundle.', 'danger'));
  const manualNames = new Set(manualSkillNames);
  if (envelope?.routingName && manualNames.has(envelope.routingName)) issues.push(issue('manual-collision', 'Generated skill cannot collide with a manually managed skill.', 'danger'));
  const promptVisibleGuidance = `${draft?.body ?? ''}\n${envelope?.description ?? ''}`;
  if (UNSAFE_GUIDANCE_PATTERNS.some(pattern => pattern.test(promptVisibleGuidance))) issues.push(issue('privilege-expansion', 'Draft contains unsafe authority expansion or source-instruction contamination.', 'danger'));
  if (envelope?.decision === 'create_current_skill' && envelope.targetCapabilityHandle) issues.push(issue('forged-handle', 'Runtime assigns the Capability Handle for a new capability.', 'danger'));
  if (envelope?.decision === 'create_current_skill' && (!envelope.routingName || typeof envelope.routingName !== 'string' || !envelope.description || typeof envelope.description !== 'string')) {
    issues.push(issue('creation-metadata', 'Current Skill creation requires a routing name and description.', 'danger'));
  }
  // Progressive Trust duplicate avoidance: a create_current_skill draft whose
  // routingName matches an existing capability in the bundle's recall context
  // (relatedCurrentSkills) must guide the Author to append_evidence /
  // replace_current_skill instead of creating a duplicate. Bounded validation
  // gate — never invents a name, never silently overrides a genuinely different
  // Author proposal. Retryable so the Author gets one bounded revision chance.
  const duplicate = detectDuplicateCapabilityCreation(draft, bundle);
  if (duplicate) issues.push(duplicate);
  return issues;
}

const RETRYABLE_AUTHOR_DRAFT_ISSUES = new Set([
  'empty-draft',
  'frontmatter',
  'envelope',
  'routing-name',
  'creation-metadata',
  'referenced-skills-shape',
  'missing-referenced-skill',
  'evidence-refs-shape',
  'missing-evidence',
  'replace-route-mismatch',
  'duplicate-capability-creation',
]);

function isRetryableAuthorDraftIssue(issue: SkillVerifierIssue): boolean {
  return RETRYABLE_AUTHOR_DRAFT_ISSUES.has(issue.code);
}

function validateTransitionInput(
  input: ApplyTransitionInput,
  registry: CurrentSkillRegistryState,
  existing: CurrentSkillRecord | undefined,
  manualNames: Set<string>,
  routingName: string,
  evidenceRefs: string[],
): void {
  if (!isTransition(input.transition)) throw new Error(`Unknown Capability Transition: ${input.transition}`);
  if (input.verifier.decision !== 'accept' && input.transition !== 'defer' && input.transition !== 'reject_candidate') throw new Error('Only an accepted verifier may apply a mutating Capability Transition.');
  if (input.transition === 'create_current_skill') {
    if (!routingName || !input.draft.envelope.description?.trim()) throw new Error('Current Skill creation requires a routing name and description.');
    if (!isValidRoutingName(routingName)) throw new Error('Skill Routing Name must be semantic kebab-case.');
    if (manualNames.has(routingName)
      || Object.values(registry.capabilities).some(record => record.routingName === routingName)
      || Object.prototype.hasOwnProperty.call(registry.routeRedirects, routingName)) {
      throw new CapabilityRoutingCollisionError(routingName);
    }
  }
  if (['append_evidence', 'replace_current_skill', 'migrate_skill_route', 'merge_into_capability', 'retire_capability'].includes(input.transition) && !existing) throw new Error('Capability Transition target is not an active capability.');
  if (['append_evidence', 'replace_current_skill'].includes(input.transition) && evidenceRefs.length === 0) throw new Error('Evidence append or replacement requires evidence refs.');
  if (input.transition === 'replace_current_skill' && input.draft.envelope.routingName !== existing!.routingName) throw new Error('replace_current_skill must preserve the existing Skill Routing Name.');
  if (input.transition === 'migrate_skill_route') {
    if (!routingName) throw new Error('Route migration requires a routing name.');
    if (!isValidRoutingName(routingName)) throw new Error('Skill Routing Name must be semantic kebab-case.');
    if (routingName === existing!.routingName) throw new Error('Route migration must change the public Routing Name.');
    if (!isPathSafelyWithinDirectory(existing!.skillFilePath, input.outputDir)) {
      throw new Error('Only generated Current Skills may use route migration.');
    }
    if (input.draft.body.toLowerCase().includes(existing!.routingName.toLowerCase())) {
      throw new Error('Route migration guidance still references the retired Routing Name.');
    }
    if (manualNames.has(routingName)
      || Object.values(registry.capabilities).some(record => record.handle !== existing!.handle && record.routingName === routingName)
      || Object.prototype.hasOwnProperty.call(registry.routeRedirects, routingName)) {
      throw new CapabilityRoutingCollisionError(routingName);
    }
  }
  if (input.transition === 'merge_into_capability') {
    if (!input.draft.envelope.sourceCapabilityHandle || input.draft.envelope.sourceCapabilityHandle === input.draft.envelope.targetCapabilityHandle) throw new Error('Merge requires distinct source and target Capability Handles.');
    if (!registry.capabilities[input.draft.envelope.sourceCapabilityHandle]) throw new Error('Merge source capability is not active.');
  }
  if (input.transition === 'retire_capability') {
    if (!input.draft.envelope.targetCapabilityHandle) throw new Error('Retirement requires a target Capability Handle.');
    if (!isPathSafelyWithinDirectory(existing!.skillFilePath, input.outputDir)) {
      throw new Error('Only generated Current Skills may be retired.');
    }
  }
}

function isValidRoutingName(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function isPathSafelyWithinDirectory(filePath: string, directoryPath: string): boolean {
  const directory = path.resolve(directoryPath);
  const target = path.resolve(filePath);
  const relative = path.relative(directory, target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || !fs.existsSync(directory)
  ) return false;

  try {
    const realDirectory = fs.realpathSync(directory);
    let existingAncestor = target;
    const missingSegments: string[] = [];
    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return false;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
    const prospectiveRealPath = path.resolve(
      fs.realpathSync(existingAncestor),
      ...missingSegments,
    );
    const realRelative = path.relative(realDirectory, prospectiveRealPath);
    return realRelative !== ''
      && realRelative !== '..'
      && !realRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(realRelative);
  } catch {
    return false;
  }
}

function renderCurrentSkill(draft: SkillDraft, handle: string, transitionId: string, evidenceRefs: string[]): string {
  const name = draft.envelope.routingName!.trim();
  const description = yamlString(draft.envelope.description!.trim());
  return [
    '---',
    `name: ${yamlString(name)}`,
    `description: ${description}`,
    'user-invocable: true',
    `x-xiaoba-capability-handle: ${yamlString(handle)}`,
    `x-xiaoba-transition-id: ${yamlString(transitionId)}`,
    `x-xiaoba-evidence-refs: ${yamlString(evidenceRefs.join(', '))}`,
    '---',
    '',
    draft.body.trim(),
    '',
  ].join('\n');
}

/** Hash only executable Markdown so route/frontmatter changes do not look like
 * guidance changes to generated dependents. */
function guidanceBodyHash(body: string): string {
  return sha256(body.trim());
}

function guidanceBodyHashFromFile(filePath: string): string | undefined {
  try {
    return guidanceBodyHash(SkillParser.parse(filePath).content);
  } catch {
    return undefined;
  }
}

function hasFrozenSemanticPriorGuidance(
  bundle: EvidenceBundle,
  record: CurrentSkillRecord | undefined,
): boolean {
  if (!record) return false;
  const ref = semanticPriorGuidanceEvidenceRef(record.handle, record.guidanceHash);
  if (!bundle.completionEvidence.some(item => item.ref === ref)) return false;
  const source = bundle.sourceEvidence?.find(item => item.ref === ref);
  if (!source || source.role !== 'problem-action' || !source.content.trim()) return false;
  const expectedGuidanceContentHash = record.guidanceContentHash
    ?? guidanceBodyHashFromFile(record.skillFilePath);
  return typeof expectedGuidanceContentHash === 'string'
    && guidanceBodyHash(source.content) === expectedGuidanceContentHash;
}

/**
 * Last-line write authorization. Review policy may turn violations into a
 * semantic reject/defer earlier, but every exported mutation caller reaches
 * this same family/target/transition check before a journal can be written.
 */
function transitionAuthorityViolation(
  bundle: EvidenceBundle,
  transition: CapabilityTransitionKind,
  targetHandle: string | undefined,
  registry: CurrentSkillRegistryState,
): string | undefined {
  if (transition === 'defer' || transition === 'reject_candidate') return undefined;
  const authority = requireExplicitEvidenceBundleAuthority(bundle);
  if (authority.kind === 'flashcard') {
    return transition === 'create_current_skill'
      ? undefined
      : 'flashcard authority permits Current Skill creation only';
  }
  if (authority.kind === 'learning-episode') {
    if (transition === 'create_current_skill') return undefined;
    if (
      transition === 'append_evidence'
      && typeof targetHandle === 'string'
      && learningAppendTargetIsEvidenceBound(bundle, registry.capabilities[targetHandle])
    ) return undefined;
    return 'learning-episode authority permits create or evidence-proven bounded-target append only';
  }
  if (authority.kind === 'usage-reassessment') {
    const episode = bundle.episode as { kind?: unknown; capabilityHandle?: unknown } | null;
    if (
      transition === 'append_evidence'
      && targetHandle === authority.targetCapabilityHandle
      && episode?.kind === 'usage-reassessment'
      && episode.capabilityHandle === targetHandle
      && bundle.relatedCurrentSkills.length === 1
      && bundle.relatedCurrentSkills[0]?.handle === targetHandle
    ) return undefined;
    return 'usage-reassessment authority permits exact-target evidence append only';
  }
  if (authority.kind === 'semantic-reassessment') {
    const episode = bundle.episode as { capabilityHandle?: unknown } | null;
    const exactTarget = typeof targetHandle === 'string'
      && targetHandle === authority.targetCapabilityHandle
      && episode?.capabilityHandle === targetHandle
      && bundle.relatedCurrentSkills.length === 1
      && bundle.relatedCurrentSkills[0]?.handle === targetHandle;
    if (!exactTarget) return 'semantic-reassessment authority is not exact-target bound';
    if (transition === 'append_evidence') return undefined;
    if (
      (transition === 'replace_current_skill' || transition === 'migrate_skill_route')
      && hasFrozenSemanticPriorGuidance(bundle, registry.capabilities[targetHandle])
    ) return undefined;
    return 'semantic guidance rewrite requires a matching frozen prior-guidance body';
  }
  const episode = bundle.episode as {
    kind?: unknown;
    action?: unknown;
    capabilityHandle?: unknown;
  } | null;
  if (
    transition === 'retire_capability'
    && targetHandle === authority.targetCapabilityHandle
    && episode?.kind === 'operator-skill-control'
    && episode.action === 'retire'
    && episode.capabilityHandle === targetHandle
  ) return undefined;
  return 'operator-control authority permits exact-target retirement only';
}

function learningAppendTargetIsEvidenceBound(
  bundle: EvidenceBundle,
  record: CurrentSkillRecord | undefined,
): boolean {
  if (!record) return false;
  const relatedSnapshotMatches = bundle.relatedCurrentSkills.some(skill => (
    skill.handle === record.handle
    && skill.revision === record.revision
    && skill.routingName === record.routingName
    && skill.guidanceHash === record.guidanceHash
  ));
  if (!relatedSnapshotMatches) return false;

  const referencedSnapshotMatches = bundle.referencedSkills.some(skill => (
    skill.capabilityHandle === record.handle
    && skill.name === record.routingName
    && skill.guidanceHash === record.guidanceHash
  ));
  const runtimeProvenanceMatches = bundle.referencedSkillProvenance?.kind
    === 'runtime-owned-generated-skill-load-v1'
    && bundle.referencedSkillProvenance.referencedSkills.some(skill => (
      skill.capabilityHandle === record.handle
      && skill.routingName === record.routingName
      && skill.guidanceHash === record.guidanceHash
    ));
  if (referencedSnapshotMatches && runtimeProvenanceMatches) return true;

  return [
    ...(bundle.sourceEvidence ?? []).map(evidence => evidence.content),
    ...(bundle.semanticObservations ?? []).map(observation => observation.value),
  ].some(text => (
    containsExactStableIdentifier(text, record.handle)
    || containsExactStableIdentifier(text, record.routingName)
  ));
}

function referencedSkillSnapshots(draft: SkillDraft, bundle: EvidenceBundle): ReferencedSkillSnapshot[] {
  const names = new Set(draft.envelope.referencedSkills ?? []);
  return bundle.referencedSkills
    .filter(skill => names.has(skill.name))
    .map(({ content: _content, ...snapshot }) => ({ ...snapshot }));
}

function selectedEvidenceRefs(draft: SkillDraft, bundle: EvidenceBundle): string[] {
  const available = [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref);
  const selected = Array.isArray(draft?.envelope?.evidenceRefs) ? draft.envelope.evidenceRefs : available;
  return uniqueStrings(selected);
}

function fixedEvidenceRefs(bundle: EvidenceBundle): string[] {
  return uniqueStrings([
    ...bundle.completionEvidence.map(ref => ref.ref),
    ...bundle.settlementEvidence.map(ref => ref.ref),
    ...(bundle.sourceEvidence ?? []).map(ref => ref.ref),
    ...(bundle.semanticObservations ?? []).flatMap(observation => observation.sourceRefs),
  ]);
}

function mergeEvidence(existing: SkillEvidenceRef[], refs: string[]): SkillEvidenceRef[] {
  const byRef = new Map(existing.map(ref => [ref.ref, ref]));
  for (const ref of refs) if (!byRef.has(ref)) byRef.set(ref, { ref });
  return [...byRef.values()];
}

function sanitizeRegistry(input: CurrentSkillRegistryState): CurrentSkillRegistryState {
  const capabilities: Record<string, CurrentSkillRecord> = {};
  for (const [handle, record] of Object.entries(input.capabilities)) {
    if (!record || !record.handle || record.handle !== handle || !record.routingName || !record.skillFilePath) continue;
    capabilities[handle] = {
      ...record,
      revision: Number.isInteger(record.revision) && record.revision > 0 ? record.revision : 1,
      evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs : [],
      referencedSkills: Array.isArray(record.referencedSkills) ? record.referencedSkills : [],
      semanticObservations: normalizeSemanticObservations(record.semanticObservations),
    };
  }
  const routeRedirects: Record<string, string> = {};
  if (isRecord(input.routeRedirects)) {
    for (const [route, handle] of Object.entries(input.routeRedirects)) {
      if (route.trim() && typeof handle === 'string' && handle.trim()) routeRedirects[route] = handle;
    }
  }
  return {
    schemaVersion: SKILL_EVOLUTION_SCHEMA_VERSION,
    catalogRevision: Number.isInteger(input.catalogRevision) && input.catalogRevision >= 0
      ? input.catalogRevision
      : 0,
    routeRedirects,
    capabilities,
  };
}

/**
 * Registry redirects are a single-hop compatibility map. Validate the raw
 * durable state before sanitizing so a malformed map can never be reduced to
 * an apparently empty Registry and cause filesystem discovery to fall back to
 * orphaned generated files.
 */
function validateRegistryState(input: Record<string, any>): void {
  const activeRoutes = new Map<string, string>();
  for (const [handle, record] of Object.entries(input.capabilities ?? {})) {
    if (!isRecord(record)
      || record.handle !== handle
      || typeof record.routingName !== 'string'
      || !isValidRoutingName(record.routingName)
      || typeof record.skillFilePath !== 'string'
      || !record.skillFilePath.trim()
      || !Number.isInteger(record.revision)
      || record.revision < 1
      || typeof record.guidanceHash !== 'string'
      || !Array.isArray(record.evidenceRefs)
      || !Array.isArray(record.referencedSkills)) {
      throw new CurrentSkillRegistryValidationError(`capability "${handle}" is malformed`);
    }
    const prior = activeRoutes.get(record.routingName);
    if (prior && prior !== handle) {
      throw new CurrentSkillRegistryValidationError(`active route "${record.routingName}" collides with ${prior}`);
    }
    activeRoutes.set(record.routingName, handle);
  }

  if (input.routeRedirects === undefined) return;
  if (!isRecord(input.routeRedirects)) {
    throw new CurrentSkillRegistryValidationError('routeRedirects must be an object');
  }
  const redirects = input.routeRedirects as Record<string, unknown>;
  for (const [retiredRoute, targetValue] of Object.entries(redirects)) {
    if (!retiredRoute.trim() || !isValidRoutingName(retiredRoute)) {
      throw new CurrentSkillRegistryValidationError(`retired route "${retiredRoute}" is not a valid routing name`);
    }
    if (typeof targetValue !== 'string' || !targetValue.trim()) {
      throw new CurrentSkillRegistryValidationError(`redirect for "${retiredRoute}" has no target handle`);
    }
    const targetHandle = targetValue.trim();
    if (activeRoutes.has(retiredRoute)) {
      throw new CurrentSkillRegistryValidationError(`retired route "${retiredRoute}" is still active`);
    }
    if (!Object.prototype.hasOwnProperty.call(input.capabilities, targetHandle)) {
      throw new CurrentSkillRegistryValidationError(`redirect for "${retiredRoute}" targets missing handle "${targetHandle}"`);
    }
    // A redirect must terminate at a Capability Handle in one hop. A second
    // redirect keyed by that handle would create a chain/cycle rather than a
    // durable route -> active capability edge.
    if (Object.prototype.hasOwnProperty.call(redirects, targetHandle)) {
      throw new CurrentSkillRegistryValidationError(`redirect for "${retiredRoute}" forms a redirect cycle or chain`);
    }
  }
}

/**
 * Declared relevant Registry dependencies available from the frozen Evidence
 * Bundle. Job creation freezes this vector into the Review Basis. Unrelated
 * Registry handles that are not on the bundle never appear here.
 */
function declaredRelevantRegistryReadSetFromBundle(
  bundle: EvidenceBundle,
): CapabilityReadSetEntry[] {
  return normalizeRegistryReadSet(
    (bundle.relatedCurrentSkills ?? []).map(skill => ({
      handle: skill.handle,
      revision: skill.revision,
    })),
  );
}

function declaredRegistryReadSet(
  verifier: SkillVerifierResult,
  bundle: EvidenceBundle,
  draft: SkillDraft,
): CapabilityReadSetEntry[] {
  const bundleMap = new Map(
    bundle.relatedCurrentSkills.map(skill => [skill.handle, { handle: skill.handle, revision: skill.revision }]),
  );
  const verifierDeclared = verifier.registryReadSet?.length
    ? normalizeRegistryReadSet(verifier.registryReadSet)
    : undefined;
  if (verifierDeclared) {
    const bundleRevisions = new Map(Array.from(bundleMap.values()).map(entry => [entry.handle, entry.revision]));
    if (verifierDeclared.some(entry => bundleRevisions.get(entry.handle) !== entry.revision)) {
      throw new Error('Verifier declared a Capability Registry read outside the fixed bundle.');
    }
    return verifierDeclared;
  }

  const transition = verifier.decision === 'accept'
    ? (verifier.transition ?? draft.envelope.decision)
    : draft.envelope.decision;
  if (!isTransition(transition) || transition === 'create_current_skill' || transition === 'defer' || transition === 'reject_candidate') {
    return [];
  }

  const required = transition === 'merge_into_capability'
    ? [draft.envelope.targetCapabilityHandle, draft.envelope.sourceCapabilityHandle]
    : transition === 'append_evidence' || transition === 'replace_current_skill' || transition === 'migrate_skill_route' || transition === 'retire_capability'
      ? [draft.envelope.targetCapabilityHandle]
      : [];

  const inferred = required
    .map(handle => handle && bundleMap.get(handle))
    .filter((entry): entry is CapabilityReadSetEntry => Boolean(entry));
  return normalizeRegistryReadSet(inferred);
}

function normalizeRegistryReadSet(readSet: readonly CapabilityReadSetEntry[]): CapabilityReadSetEntry[] {
  const byHandle = new Map<string, CapabilityReadSetEntry>();
  for (const entry of readSet) {
    if (!entry || typeof entry.handle !== 'string' || !entry.handle.trim() || !Number.isInteger(entry.revision) || entry.revision < 1) {
      throw new Error('Capability Registry read set is malformed.');
    }
    const normalized = { handle: entry.handle.trim(), revision: entry.revision };
    const previous = byHandle.get(normalized.handle);
    if (previous && previous.revision !== normalized.revision) {
      throw new Error(`Capability Registry read set contains conflicting revisions for ${normalized.handle}.`);
    }
    byHandle.set(normalized.handle, normalized);
  }
  return [...byHandle.values()].sort((left, right) => left.handle.localeCompare(right.handle));
}

function assertRegistryReadSetCurrent(
  registry: CurrentSkillRegistryState,
  readSet: readonly CapabilityReadSetEntry[],
): void {
  const stale = readSet.filter(entry => registry.capabilities[entry.handle]?.revision !== entry.revision);
  if (stale.length > 0) throw new StaleCapabilityReadSetError(stale);
}

function assertTransitionTargetsWereRead(
  input: ApplyTransitionInput,
  readSet: readonly CapabilityReadSetEntry[],
): void {
  if (input.registryReadSet === undefined || input.verifier.decision !== 'accept') return;
  const requiredHandles = input.transition === 'merge_into_capability'
    ? [input.draft.envelope.targetCapabilityHandle, input.draft.envelope.sourceCapabilityHandle]
    : ['append_evidence', 'replace_current_skill', 'migrate_skill_route', 'retire_capability'].includes(input.transition)
      ? [input.draft.envelope.targetCapabilityHandle]
      : [];
  const readHandles = new Set(readSet.map(entry => entry.handle));
  if (requiredHandles.some(handle => !handle || !readHandles.has(handle))) {
    throw new Error('Capability Registry read set does not cover the transition target.');
  }
}

/**
 * Models often fill `transition` with a decision word (`accept`/`accepted`).
 * Those are not Capability Transition Kinds. Treat them as omitted so Runtime
 * can fall back to the Author envelope decision instead of hard-failing the
 * whole verification quantum.
 */
function normalizeOptionalVerifierTransition(
  transition: unknown,
): CapabilityTransitionKind | undefined {
  if (transition === undefined || transition === null || transition === '') {
    return undefined;
  }
  if (typeof transition !== 'string') {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier transition is invalid.');
  }
  const trimmed = transition.trim();
  if (!trimmed) return undefined;
  // Decision vocabulary leaked into the transition field.
  if (['accept', 'accepted', 'approve', 'approved', 'revise', 'reject', 'rejected', 'deny', 'denied'].includes(trimmed.toLowerCase())) {
    return undefined;
  }
  if (!isTransition(trimmed)) {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier transition is invalid.');
  }
  return trimmed;
}

/**
 * Obligation dispositions use past-tense decisions:
 * accepted | mitigated | deferred | rejected.
 * Models frequently emit present-tense accept/defer/reject; normalize those
 * aliases before durable validation so review jobs do not stall on vocabulary.
 */
function normalizeObligationDispositionDecision(
  decision: unknown,
): ObligationDisposition['decision'] | undefined {
  if (typeof decision !== 'string') return undefined;
  const trimmed = decision.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'accepted' || trimmed === 'accept' || trimmed === 'approve' || trimmed === 'approved') {
    return 'accepted';
  }
  if (trimmed === 'mitigated' || trimmed === 'mitigate') {
    return 'mitigated';
  }
  if (trimmed === 'deferred' || trimmed === 'defer') {
    return 'deferred';
  }
  if (trimmed === 'rejected' || trimmed === 'reject' || trimmed === 'deny' || trimmed === 'denied') {
    return 'rejected';
  }
  return undefined;
}

function normalizeObligationDispositionsInput(
  dispositions: unknown,
): ObligationDisposition[] | undefined {
  if (dispositions === undefined) return undefined;
  if (!Array.isArray(dispositions)) {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier obligationDispositions must be an array.');
  }
  return dispositions.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new OperationalReviewError(
        'invalid_completion_schema',
        `Verifier obligationDispositions[${index}] is malformed.`,
      );
    }
    const record = item as Record<string, unknown>;
    const decision = normalizeObligationDispositionDecision(record.decision);
    if (!decision) {
      throw new OperationalReviewError(
        'invalid_completion_schema',
        `Verifier obligationDispositions[${index}] has an invalid decision.`,
      );
    }
    return {
      ...(record as object),
      decision,
    } as ObligationDisposition;
  });
}

export function normalizeVerifierResult(result: SkillVerifierResult | { approved?: boolean; issues?: SkillVerifierIssue[]; rationale?: string; transition?: CapabilityTransitionKind | string; registryReadSet?: CapabilityReadSetEntry[]; obligationDispositions?: ObligationDisposition[]; decision?: SkillVerifierResult['decision'] }): SkillVerifierResult {
  if (!result || typeof result !== 'object') {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier returned an invalid completion schema.');
  }
  if ('approved' in result) {
    if (typeof result.approved !== 'boolean') {
      throw new OperationalReviewError('invalid_completion_schema', 'Verifier returned an invalid approved field.');
    }
    if (result.issues !== undefined && !Array.isArray(result.issues)) {
      throw new OperationalReviewError('invalid_completion_schema', 'Verifier issues must be an array.');
    }
    if (result.rationale !== undefined && typeof result.rationale !== 'string') {
      throw new OperationalReviewError('invalid_completion_schema', 'Verifier rationale must be a string.');
    }
    const transition = normalizeOptionalVerifierTransition(result.transition);
    if (result.registryReadSet !== undefined && !Array.isArray(result.registryReadSet)) {
      throw new OperationalReviewError('invalid_completion_schema', 'Verifier registryReadSet must be an array.');
    }
    const obligationDispositions = normalizeObligationDispositionsInput(result.obligationDispositions);
    return {
      decision: result.approved ? 'accept' : 'reject',
      ...(transition ? { transition } : {}),
      issues: result.issues ?? [],
      rationale: result.rationale ?? (result.approved ? 'Fixture verifier accepted the draft.' : 'Fixture verifier rejected the draft.'),
      registryReadSet: result.registryReadSet,
      obligationDispositions,
    };
  }
  if (!('decision' in result) || !['accept', 'revise', 'defer', 'reject'].includes(result.decision as string)) {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier decision is missing or invalid.');
  }
  if (!Array.isArray(result.issues)) {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier issues must be an array.');
  }
  if (typeof result.rationale !== 'string') {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier rationale must be a string.');
  }
  const transition = normalizeOptionalVerifierTransition(result.transition);
  if (result.registryReadSet !== undefined && !Array.isArray(result.registryReadSet)) {
    throw new OperationalReviewError('invalid_completion_schema', 'Verifier registryReadSet must be an array.');
  }
  const obligationDispositions = normalizeObligationDispositionsInput(result.obligationDispositions);
  const registryReadSet = result.registryReadSet === undefined
    ? undefined
    : (() => {
      try {
        return normalizeRegistryReadSet(result.registryReadSet!);
      } catch {
        throw new OperationalReviewError('invalid_completion_schema', 'Verifier registryReadSet is malformed.');
      }
    })();
  return {
    decision: result.decision as SkillVerifierResult['decision'],
    ...(transition ? { transition } : {}),
    issues: result.issues,
    rationale: result.rationale,
    registryReadSet,
    obligationDispositions,
  };
}

class FinishSkillAuthoringTool implements Tool {
  definition: ToolDefinition = {
    name: 'finish_skill_authoring',
    description: 'Return exactly one Markdown Skill Draft and its minimal Skill Authoring Envelope.',
    controlMode: 'pause_turn',
    parameters: { type: 'object', properties: { body: { type: 'string' }, envelope: { type: 'object' } }, required: ['body', 'envelope'] },
  };

  constructor(private readonly finish: (draft: SkillDraft) => void) {}

  async execute(args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.finish({ body: String(args?.body ?? ''), envelope: args?.envelope ?? {} });
    return { ok: true, content: 'Skill Draft received.' };
  }
}

class FinishSkillVerificationTool implements Tool {
  definition: ToolDefinition = {
    name: 'finish_skill_verification',
    description: 'Return a structured independent verification result. decision is accept|revise|defer|reject. Optional transition is a Capability Transition Kind (for example create_current_skill), never accept/accepted.',
    controlMode: 'pause_turn',
    parameters: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          description: 'accept | revise | defer | reject',
        },
        transition: {
          type: 'string',
          description: 'Optional Capability Transition Kind such as create_current_skill. Do not use accept/accepted/reject/revise here.',
        },
        issues: { type: 'array' },
        rationale: { type: 'string' },
        registryReadSet: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              handle: { type: 'string' },
              revision: { type: 'integer' },
            },
            required: ['handle', 'revision'],
          },
        },
        obligationDispositions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              obligationId: { type: 'string' },
              decision: {
                type: 'string',
                description: 'accepted | mitigated | deferred | rejected',
              },
              rationale: { type: 'string' },
              citedSpans: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    shardId: { type: 'string' },
                    span: {
                      type: 'object',
                      properties: {
                        start: { type: 'integer' },
                        end: { type: 'integer' },
                      },
                    },
                  },
                  required: ['shardId', 'span'],
                },
              },
            },
            required: ['obligationId', 'decision', 'rationale', 'citedSpans'],
          },
        },
      },
      required: ['decision', 'issues', 'rationale', 'obligationDispositions'],
    },
  };

  constructor(private readonly finish: (result: SkillVerifierResult) => void) {}

  async execute(args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.finish(normalizeVerifierResult(args));
    return { ok: true, content: 'Skill verification received.' };
  }
}

function requireAIService(service: AIService | undefined): AIService {
  // Fixture branches never call the service. A placeholder is safe for that
  // path and keeps branch construction uniform; real branches fail clearly.
  return service ?? ({ chat: async () => { throw new Error('Skill Evolution requires an AIService when no fixture branch is configured.'); }, chatStream: async () => { throw new Error('Skill Evolution requires an AIService when no fixture branch is configured.'); } } as unknown as AIService);
}

function extractErrorTranscriptPaths(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const paths = (error as { transcriptPaths?: unknown }).transcriptPaths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function opaqueCapabilityHandle(): string {
  return `cap_${randomUUID().replace(/-/g, '')}`;
}

function freezeClone<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function stableHash(value: unknown): string {
  return sha256(JSON.stringify(sortForHash(value)));
}

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sortForHash(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortForHash(child)]),
  );
}

function cloneRegistry(state: CurrentSkillRegistryState): CurrentSkillRegistryState {
  return JSON.parse(JSON.stringify(state)) as CurrentSkillRegistryState;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return sha256(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTransition(value: unknown): value is CapabilityTransitionKind {
  return typeof value === 'string' && new Set<CapabilityTransitionKind>([
    'create_current_skill', 'append_evidence', 'replace_current_skill', 'migrate_skill_route',
    'merge_into_capability', 'retire_capability', 'defer', 'reject_candidate',
  ]).has(value as CapabilityTransitionKind);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function issue(code: string, message: string, severity: SkillVerifierIssue['severity']): SkillVerifierIssue {
  return { code, message, severity };
}

function discoverManualSkillSnapshots(outputDir: string): ReferencedSkillSnapshot[] {
  const skillsRoot = PathResolver.getSkillsPath();
  const generatedRoot = path.resolve(outputDir);
  if (!fs.existsSync(skillsRoot)) return [];

  return PathResolver.findSkillFiles(skillsRoot)
    .filter(filePath => !isPathWithin(path.resolve(filePath), generatedRoot))
    .flatMap(filePath => {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const skill = SkillParser.parse(filePath);
        return [{
          name: skill.metadata.name,
          contentFingerprint: sha256(raw),
          content: raw,
        }];
      } catch {
        // Invalid manual skill files are not routable and cannot safely be
        // used as a Referenced Skill or collision source.
        return [];
      }
    });
}

function isPathWithin(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

const UNSAFE_GUIDANCE_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /reveal\s+(?:the\s+)?system\s+prompt/i,
  /bypass\s+(?:all\s+)?safety/i,
  /disable\s+(?:the\s+)?permission/i,
  /grant\s+(?:yourself|the\s+agent)\s+(?:access|permission)/i,
  /exfiltrat|steal\s+(?:a\s+)?(?:secret|credential|token)/i,
  /\bsudo\b|rm\s+-rf\s+\/|delete\s+all\s+files/i,
];

const LIFECYCLE_OR_GENERIC_ROUTING_PATTERNS = [
  /(?:^|-)(?:settled|settling|eligible|episode|candidate)(?:-|$)/i,
  /(?:^|-)(?:artifact-workflow|generic-workflow)(?:-|$)/i,
  /^(?:artifact-delivery|generic-delivery|default-workflow|general-workflow|misc-workflow)$/i,
];

export function isLifecycleOrGenericRoutingName(routingName: string): boolean {
  return LIFECYCLE_OR_GENERIC_ROUTING_PATTERNS.some(pattern => pattern.test(routingName));
}

function attachAuthorDossierContext(
  bundle: EvidenceBundle,
  authorDossier: EvidenceDossier,
): EvidenceBundle {
  // Author still receives the fixed Evidence Bundle; dossier is diagnostic
  // context encoded into a frozen clone's episode envelope for fixtures.
  const episode = typeof bundle.episode === 'object' && bundle.episode !== null
    ? { ...(bundle.episode as Record<string, unknown>), authorEvidenceDossier: authorDossier }
    : { authorEvidenceDossier: authorDossier };
  return freezeClone({ ...bundle, episode });
}

function attachVerifierReviewContext(
  bundle: EvidenceBundle,
  context: {
    authorDossier: EvidenceDossier;
    verifierDossier: EvidenceDossier;
    differenceIndex: DossierDifferenceIndex;
    obligations: readonly ReviewObligation[];
  },
): EvidenceBundle {
  const episode = typeof bundle.episode === 'object' && bundle.episode !== null
    ? {
        ...(bundle.episode as Record<string, unknown>),
        authorEvidenceDossier: context.authorDossier,
        verifierEvidenceDossier: context.verifierDossier,
        dossierDifferenceIndex: context.differenceIndex,
        reviewObligations: context.obligations,
      }
    : {
        authorEvidenceDossier: context.authorDossier,
        verifierEvidenceDossier: context.verifierDossier,
        dossierDifferenceIndex: context.differenceIndex,
        reviewObligations: context.obligations,
      };
  return freezeClone({ ...bundle, episode });
}

function inferReviewWorkClass(bundle: EvidenceBundle): ReviewWorkClass {
  const episode = bundle.episode as { historicalTarget?: unknown } | null;
  if (episode && typeof episode === 'object' && episode.historicalTarget) {
    return 'historical_learning';
  }
  return 'live_learning';
}

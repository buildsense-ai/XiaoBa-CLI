/**
 * Canonical Evidence Review Job types — durable job/basis/type definitions
 * (ADR 0045 / #107).
 *
 * This module is the single canonical owner of:
 * - Schema/policy/prompt version constants
 * - Shared quantum kinds, states, dispositions, work classes
 * - Pure graph ReviewBasis (opaque string fingerprints) and GraphEvidenceReviewJob
 * - Engine-facing ReviewBasis (structured Registry read set) and EvidenceReviewJob
 *
 * An Evidence Review Job is a durable dependency graph of content-identified
 * Review Quanta. Job progress is derived from node results rather than a
 * mutable linear phase.
 */

import type {
  EvidenceShardDomainKind,
  EvidenceShardCoverageDisposition,
  EvidenceShardSpan,
  EvidenceShard,
  EvidenceBundleManifest,
  EvidenceDossier,
  ShardFindingSet,
  TypedFinding,
  ReviewFindingClass,
  DossierDifferenceIndex,
  DossierDifferenceEntry,
  ReviewObligation,
  ObligationDisposition,
} from './evidence-review';
import type {
  CapabilityReadSetEntry,
  EvidenceBundle,
  SkillDraft,
  SkillVerifierResult,
  SkillVerifierIssue,
} from './skill-evolution';
import type { DistilledKnowledgeCandidate } from './capability-distiller';

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

export const EVIDENCE_REVIEW_JOB_SCHEMA_VERSION = 1 as const;

/** Default prompt / policy version stamps included in Quantum identity. */
export const EVIDENCE_REVIEW_PROMPT_VERSION = 'evidence-review-job-v6' as const;
/**
 * Policy v8:
 *   - Usage correction outcomes require a stable-identity binding to the
 *     affected Skill load; a single loaded generated Skill may inherit an
 *     otherwise unqualified correction, while multiple loads require an
 *     explicit identity and correction proximity is not causation.
 *   - Usage reassessment cannot replace guidance without the prior guidance
 *     body in its fixed review basis, and cannot retire a Skill without a
 *     bounded correction snapshot; automatic usage reassessment only appends
 *     evidence. Operator retirement remains a separate explicit path.
 * Policy v6 established:
 *   - An eligible ordinary Learning Episode may create or append evidence
 *     without prior Skill use or explicit positive feedback; behavior-changing
 *     and structural catalog transitions use dedicated evidence paths.
 *   - Rejection requires affirmative evidence that no safe, transferable
 *     capability can be written; uncertainty narrows or defers the candidate.
 * Policy v5 also established:
 *   - Only explicit contradiction outcomes drive usage reassessment.
 * Policy v4 also established:
 *   - Structural Difference Index corroboration now keys on classification +
 *     overlapping shard span instead of exact natural-language summary, so
 *     cross-lane paraphrases over the same cited evidence no longer inflate
 *     missing_citation obligations.
 *   - Evidence Capsule reconstruction preserves a bounded, redacted external
 *     solved-loop (trigger/action/result) instead of bare admission metadata.
 *   - External terminal-outcome polarity: a negative review tail is not
 *     manufactured as a successful final.
 *   - Enforceable Progressive Trust defer seam: a settled low-risk narrow
 *     external atom cannot be deferred solely for sample scarcity.
 *   - Duplicate `create_current_skill` detection against relatedCurrentSkills.
 * Active jobs frozen under v3 must supersede to a successor on the v4 policy.
 */
export const EVIDENCE_REVIEW_POLICY_VERSION = 'evidence-review-policy-v8' as const;

// ---------------------------------------------------------------------------
// Shared quantum / job types
// ---------------------------------------------------------------------------

/**
 * Common durable Quantum kinds for dual-lane coverage and final commit.
 * Additional kinds may be added without changing identity hashing rules.
 */
export type ReviewQuantumKind =
  | 'author_reader'
  | 'verifier_reader'
  | 'author_dossier'
  | 'verifier_dossier'
  | 'difference_index'
  | 'obligations'
  | 'skill_author'
  | 'skill_verifier'
  | 'commit';

/**
 * Common durable node states for a Review Quantum.
 * Progress and eligibility are derived from these states plus leases/deadlines.
 */
export type ReviewQuantumState =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'retry_wait'
  | 'terminal_failed';

export type ReviewOperationalFailureKind =
  | 'branch_timeout'
  | 'branch_failure'
  | 'invalid_completion_schema';

/**
 * Explicit job outcomes. Intermediate progress is always derived from quanta.
 * `superseded` is an extension point for Review Commit Fence successors (#109).
 */
export type EvidenceReviewJobDisposition =
  | 'active'
  | 'deferred'
  | 'completed'
  | 'superseded'
  | 'terminal_failed';

export type ReviewWorkClass =
  | 'operational_recovery'
  | 'live_learning'
  | 'historical_learning'
  | 'semantic_reassessment';

/** Time-bounded ownership claim on one schedulable Review Quantum. */
export interface QuantumLease {
  readonly leaseId: string;
  readonly ownerWakeId: string;
  readonly leasedAt: string;
  readonly expiresAt: string;
}

/**
 * One content-identified, independently resumable graph node.
 *
 * Identity is derived from kind + inputHash (itself covering input content
 * hashes, prompt version, and reviewer/policy version). Declared dependencies
 * must succeed before the node becomes schedulable.
 */
export interface ReviewQuantumRecord {
  readonly quantumId: string;
  readonly kind: ReviewQuantumKind;
  /** Content hash over kind-specific inputs and version stamps. */
  readonly inputHash: string;
  readonly dependencyQuantumIds: readonly string[];
  /** Optional domain payload identifiers (opaque to the graph foundation). */
  readonly shardId?: string;
  readonly lane?: 'author' | 'verifier';
  state: ReviewQuantumState;
  attempts: number;
  currentDelayMs: number;
  nextRetryAt?: string;
  lease?: QuantumLease;
  resultHash?: string;
  result?: unknown;
  failureMessage?: string;
  failureKind?: ReviewOperationalFailureKind;
  transcriptPaths: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Pure graph ReviewBasis (opaque string fingerprints for hash computation)
// ---------------------------------------------------------------------------

/**
 * Immutable Review Basis version vector (identity only).
 * Atomic fence comparison and successor reuse are owned by #109.
 * Uses opaque string fingerprints for the Registry read set.
 */
export interface GraphReviewBasis {
  readonly basisHash: string;
  readonly manifestHash: string;
  readonly evidenceBundleHash: string;
  /** Opaque ordered Registry read-set fingerprint entries (handle@revision). */
  readonly registryReadSet: readonly string[];
  readonly referencedSkillHashes: readonly string[];
  readonly reviewPolicyVersion: string;
  readonly promptVersion: string;
  readonly targetCapabilityHandle?: string;
  readonly targetCapabilityRevision?: number;
}

/**
 * Pure graph Evidence Review Job with opaque domain payload.
 * Used by graph-core's createEvidenceReviewJob; the engine wrapper adds
 * structured domain fields (candidate, bundle, manifest, shards, etc.).
 */
export interface GraphEvidenceReviewJob {
  schemaVersion: typeof EVIDENCE_REVIEW_JOB_SCHEMA_VERSION;
  jobId: string;
  workClass: ReviewWorkClass;
  disposition: EvidenceReviewJobDisposition;
  createdAt: string;
  updatedAt: string;
  /** Immutable Review Basis version vector (fence comparison is #109). */
  basis: GraphReviewBasis;
  quanta: Record<string, ReviewQuantumRecord>;
  /** Opaque domain payload (Evidence Bundle snapshot, candidate, shards…). */
  domain?: Record<string, unknown>;
  successorJobId?: string;
  supersededByJobId?: string;
  parentJobId?: string;
  terminalReason?: string;
  nextDueAt?: string;
  transitionId?: string;
}

// ---------------------------------------------------------------------------
// Engine-facing ReviewBasis (structured Registry read set)
// ---------------------------------------------------------------------------

/**
 * Engine Review Basis — stores structured Registry read set entries while the
 * pure graph basis uses opaque string fingerprints.
 */
export interface ReviewBasis {
  readonly basisHash: string;
  readonly manifestHash: string;
  readonly evidenceBundleHash: string;
  readonly registryReadSet: readonly CapabilityReadSetEntry[];
  readonly registryReadSetFingerprints: readonly string[];
  readonly referencedSkillHashes: readonly string[];
  readonly reviewPolicyVersion: string;
  readonly promptVersion: string;
  readonly targetCapabilityHandle?: string;
  readonly targetCapabilityRevision?: number;
}

// ---------------------------------------------------------------------------
// Engine-facing durable job with domain payloads for Skill Evolution
// ---------------------------------------------------------------------------

/** Engine-facing durable job with domain payloads for Skill Evolution. */
export interface EvidenceReviewJob {
  schemaVersion: typeof EVIDENCE_REVIEW_JOB_SCHEMA_VERSION;
  jobId: string;
  workClass: ReviewWorkClass;
  disposition: EvidenceReviewJobDisposition;
  createdAt: string;
  updatedAt: string;
  candidate: DistilledKnowledgeCandidate;
  bundle: EvidenceBundle;
  manifest: EvidenceBundleManifest;
  shards: Record<string, EvidenceShard>;
  basis: ReviewBasis;
  quanta: Record<string, ReviewQuantumRecord>;
  authorDossier?: EvidenceDossier;
  verifierDossier?: EvidenceDossier;
  differenceIndex?: DossierDifferenceIndex;
  obligations?: readonly ReviewObligation[];
  obligationDispositions?: readonly ObligationDisposition[];
  draft?: SkillDraft;
  verifierResult?: SkillVerifierResult;
  /**
   * Current revision round (1 or 2). When 2, the graph has been expanded
   * with round-2 Author/Verifier quanta after a round-1 revise decision.
   * Round-2 Author receives previousDraft and verifierIssues from round 1.
   */
  revisionRound?: 1 | 2;
  /**
   * Round-1 draft preserved for round-2 Author input. Set when the graph
   * expands after round-1 revise.
   */
  previousDraft?: SkillDraft;
  /**
   * Round-1 verifier issues preserved for round-2 Author input.
   */
  round1VerifierIssues?: readonly SkillVerifierIssue[];
  transitionId?: string;
  successorJobId?: string;
  supersededByJobId?: string;
  parentJobId?: string;
  terminalReason?: string;
  nextDueAt?: string;

  /**
   * Defer re-eligibility state captured at defer time. A deferred job stays
   * dormant until reviewer/policy, Registry read-set, or evidence changes.
   * Absent when the job was never deferred.
   */
  deferState?: {
    reviewerVersion: string;
    reason: string;
    deferredAt: string;
  };

  /** Opaque extension bag for pure-graph compatibility. */
  domain?: Record<string, unknown>;
}

export interface EvidenceReviewJobStoreState {
  schemaVersion: typeof EVIDENCE_REVIEW_JOB_SCHEMA_VERSION;
  jobs: Record<string, EvidenceReviewJob>;
  fairness: {
    nextWorkClass: ReviewWorkClass;
    classCursors: Partial<Record<ReviewWorkClass, string>>;
    jobCursors: Partial<Record<string, string>>;
  };
  /** Set when a corrupt state file was quarantined on load (fail-closed). */
  stateCorrupt?: boolean;
}

// Re-export evidence-review domain types for convenience
export type {
  EvidenceShardDomainKind,
  EvidenceShardCoverageDisposition,
  EvidenceShardSpan,
  EvidenceShard,
  EvidenceBundleManifest,
  EvidenceDossier,
  ShardFindingSet,
  TypedFinding,
  ReviewFindingClass,
  DossierDifferenceIndex,
  DossierDifferenceEntry,
  ReviewObligation,
  ObligationDisposition,
};

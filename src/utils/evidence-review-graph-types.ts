/**
 * Durable Evidence Review Jobs — foundation types (ADR 0045 / #107).
 *
 * An Evidence Review Job is a durable dependency graph of content-identified
 * Review Quanta. Job progress is derived from node results rather than a
 * mutable linear phase. This module is intentionally free of Runtime Learning
 * wake, fairness, commit-fence, and Skill Evolution integration seams.
 */

export const EVIDENCE_REVIEW_JOB_SCHEMA_VERSION = 1 as const;

/** Default prompt / policy version stamps included in Quantum identity. */
export const EVIDENCE_REVIEW_PROMPT_VERSION = 'evidence-review-job-v1' as const;
export const EVIDENCE_REVIEW_POLICY_VERSION = 'evidence-review-policy-v1' as const;

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

/**
 * Immutable Review Basis version vector (identity only).
 * Atomic fence comparison and successor reuse are owned by #109.
 */
export interface ReviewBasis {
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
  transcriptPaths: string[];
  updatedAt: string;
}

/**
 * Durable Evidence Review Job bound to an immutable Review Basis.
 * Bundle/shard payloads are stored as opaque records so higher layers can
 * attach domain material without coupling this foundation to Skill Evolution.
 */
export interface EvidenceReviewJob {
  schemaVersion: typeof EVIDENCE_REVIEW_JOB_SCHEMA_VERSION;
  jobId: string;
  workClass: ReviewWorkClass;
  disposition: EvidenceReviewJobDisposition;
  createdAt: string;
  updatedAt: string;
  /** Immutable Review Basis version vector (fence comparison is #109). */
  basis: ReviewBasis;
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

export interface EvidenceReviewJobStoreState {
  schemaVersion: typeof EVIDENCE_REVIEW_JOB_SCHEMA_VERSION;
  jobs: Record<string, EvidenceReviewJob>;
  /**
   * Fairness cursor slots reserved for #108. The foundation persists them
   * without interpreting rotation policy.
   */
  fairness: {
    nextWorkClass: ReviewWorkClass;
    classCursors: Partial<Record<ReviewWorkClass, string>>;
    jobCursors: Partial<Record<string, string>>;
  };
  /** Set when a corrupt state file was quarantined on load (fail-closed). */
  stateCorrupt?: boolean;
}

export interface EvidenceReviewJobProgress {
  jobId: string;
  disposition: EvidenceReviewJobDisposition;
  totalQuanta: number;
  pendingQuanta: number;
  leasedQuanta: number;
  succeededQuanta: number;
  retryWaitQuanta: number;
  terminalFailedQuanta: number;
  runnableQuanta: number;
  nextDueAt?: string;
}

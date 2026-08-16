/**
 * Evidence Review foundation types (ADR 0045 / #106).
 *
 * Pure domain shapes for immutable Evidence Bundle manifests, content-addressed
 * Evidence Shards, dual-lane Shard Finding Sets, Evidence Dossiers, structural
 * Difference Indexes, and Review Obligations.
 *
 * This module intentionally omits Runtime Learning wake, Quantum leasing,
 * Skill Evolution branches, and commit-fence seams owned by other issues.
 */

/** Domain unit kinds used by Deterministic Evidence Sharding. */
export type EvidenceShardDomainKind =
  | 'episode'
  | 'completion_evidence'
  | 'settlement_evidence'
  | 'bounded_continuity'
  | 'referenced_skill'
  | 'related_current_skill'
  | 'semantic_observations'
  | 'source_evidence'
  | 'bundle_remainder';

/**
 * Coverage disposition for one lane-shard read.
 * Only `covered` and `empty` satisfy dual-lane coverage. Unreadable and
 * ambiguous results remain incomplete and cannot admit a transition.
 */
export type EvidenceShardCoverageDisposition =
  | 'covered'
  | 'unreadable'
  | 'ambiguous'
  | 'empty';

/** Reader lane identity. Lanes never share natural-language findings. */
export type EvidenceReviewLane = 'author' | 'verifier';

/**
 * Typed finding classifications that can raise Review Obligations.
 * Free-form prose and model-reported confidence are diagnostic only.
 */
export type ReviewFindingClass =
  | 'fact'
  | 'limitation'
  | 'risk'
  | 'contradiction'
  | 'source_instruction'
  | 'privilege_implication'
  | 'unresolved_question'
  | 'classification_difference'
  | 'uncorroborated_claim';

/** Inclusive-exclusive byte offsets into one immutable shard content string. */
export interface EvidenceShardSpan {
  readonly start: number;
  readonly end: number;
}

/** Content-addressed Evidence Shard produced by Runtime-owned sharding. */
export interface EvidenceShard {
  readonly shardId: string;
  readonly domainKind: EvidenceShardDomainKind;
  readonly sourceIdentity: string;
  /** SHA-256 of the exact UTF-8 content bytes. */
  readonly contentHash: string;
  readonly content: string;
  readonly byteLength: number;
  /**
   * Optional origin window when a domain unit was recursively split.
   * Offsets are relative to the original domain unit content, not the bundle.
   */
  readonly originSpan?: EvidenceShardSpan;
}

/**
 * Immutable manifest over the fixed set of Evidence Shards for one review.
 * Membership is closed: readers may not cite outside `shardIds`.
 */
export interface EvidenceBundleManifest {
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly bundleId: string;
  readonly shardIds: readonly string[];
  /** Content hashes aligned with `shardIds` for audit reconstruction. */
  readonly contentHashes: readonly string[];
  /** Deterministic epoch for pure foundation; integrators may re-stamp. */
  readonly createdAt: string;
}

export interface TypedFinding {
  readonly findingId: string;
  readonly classification: ReviewFindingClass;
  readonly summary: string;
  readonly spans: readonly EvidenceShardSpan[];
  /** Diagnostic-only free-form text. Never an admission signal. */
  readonly diagnostic?: string;
}

/**
 * Authoritative structured result of one lane reading one shard.
 * Free-form prose alone cannot satisfy coverage.
 */
export interface ShardFindingSet {
  readonly shardId: string;
  readonly contentHash: string;
  readonly lane: EvidenceReviewLane;
  readonly coverage: EvidenceShardCoverageDisposition;
  readonly findings: readonly TypedFinding[];
  readonly diagnostic?: string;
}

/** Provenance-linked dossier for one complete reader lane. */
export interface EvidenceDossier {
  readonly lane: EvidenceReviewLane;
  readonly manifestHash: string;
  readonly coveredShardIds: readonly string[];
  readonly findings: readonly TypedFinding[];
  readonly findingSets: readonly ShardFindingSet[];
  /** True only when every manifest shard has a satisfying coverage result. */
  readonly complete: boolean;
}

export type DossierDifferenceKind =
  | 'missing_citation'
  | 'classification_conflict'
  | 'coverage_gap'
  | 'conflicting_finding'
  | 'span_mismatch';

/** Structural (non-semantic) difference between dual-lane dossiers. */
export interface DossierDifferenceEntry {
  readonly kind: DossierDifferenceKind;
  readonly leftFindingId?: string;
  readonly rightFindingId?: string;
  readonly shardId?: string;
  readonly detail: string;
}

export interface DossierDifferenceIndex {
  readonly manifestHash: string;
  readonly entries: readonly DossierDifferenceEntry[];
}

export type ReviewObligationKind = ReviewFindingClass | 'difference';

/**
 * Explicit obligation the final Skill Verifier must disposition with
 * original shard spans before a Capability Transition may commit.
 */
export interface ReviewObligation {
  readonly obligationId: string;
  readonly kind: ReviewObligationKind;
  readonly summary: string;
  readonly relatedFindingIds: readonly string[];
  readonly requiredShardIds: readonly string[];
}

export interface ObligationDisposition {
  readonly obligationId: string;
  readonly decision: 'accepted' | 'mitigated' | 'deferred' | 'rejected';
  readonly rationale: string;
  readonly citedSpans: readonly {
    readonly shardId: string;
    readonly span: EvidenceShardSpan;
  }[];
}

/** Validation failure codes for finding sets and coverage. */
export type ShardFindingValidationCode =
  | 'missing_identity'
  | 'lane_mismatch'
  | 'unknown_shard'
  | 'content_hash_mismatch'
  | 'mutated_content'
  | 'invalid_coverage'
  | 'missing_findings_array'
  | 'invalid_finding'
  | 'invalid_span'
  | 'cross_manifest_citation'
  | 'free_form_only'
  | 'incomplete_coverage';

export interface ShardFindingValidationError {
  readonly code: ShardFindingValidationCode;
  readonly message: string;
  readonly shardId?: string;
  readonly findingId?: string;
}

export interface ShardFindingValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ShardFindingValidationError[];
}

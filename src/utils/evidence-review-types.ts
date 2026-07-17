/**
 * Integration types for Evidence Review Jobs.
 *
 * Re-exports pure graph types (#107) and domain payload types (#106), then
 * adds the engine-facing job shape that embeds bundle/shard/dossier state.
 */

export {
  EVIDENCE_REVIEW_JOB_SCHEMA_VERSION,
  EVIDENCE_REVIEW_PROMPT_VERSION,
  EVIDENCE_REVIEW_POLICY_VERSION,
  type ReviewQuantumKind,
  type ReviewQuantumState,
  type EvidenceReviewJobDisposition,
  type ReviewWorkClass,
  type QuantumLease,
  type ReviewQuantumRecord,
  type EvidenceReviewJobProgress,
} from './evidence-review-graph-types';

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
} from './evidence-review';

import type {
  EvidenceReviewJob as GraphJob,
  ReviewBasis as GraphReviewBasis,
  ReviewQuantumRecord,
  EvidenceReviewJobDisposition,
  ReviewWorkClass,
} from './evidence-review-graph-types';
import type {
  EvidenceBundleManifest,
  EvidenceShard,
  EvidenceDossier,
  DossierDifferenceIndex,
  ReviewObligation,
  ObligationDisposition,
} from './evidence-review';
import type {
  CapabilityReadSetEntry,
  EvidenceBundle,
  SkillDraft,
  SkillVerifierResult,
} from './skill-evolution';
import type { DistilledKnowledgeCandidate } from './capability-distiller';

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

/** Engine-facing durable job with domain payloads for Skill Evolution. */
export interface EvidenceReviewJob {
  schemaVersion: GraphJob['schemaVersion'];
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
  transitionId?: string;
  successorJobId?: string;
  supersededByJobId?: string;
  parentJobId?: string;
  terminalReason?: string;
  nextDueAt?: string;
  /** Opaque extension bag for pure-graph compatibility. */
  domain?: Record<string, unknown>;
}

export interface EvidenceReviewJobStoreState {
  schemaVersion: GraphJob['schemaVersion'];
  jobs: Record<string, EvidenceReviewJob>;
  fairness: {
    nextWorkClass: ReviewWorkClass;
    classCursors: Partial<Record<ReviewWorkClass, string>>;
    jobCursors: Partial<Record<string, string>>;
  };
  stateCorrupt?: boolean;
}

export interface EvidenceReviewDiagnostics {
  jobId: string;
  disposition: EvidenceReviewJobDisposition;
  workClass: ReviewWorkClass;
  basisHash: string;
  manifestHash: string;
  shardCount: number;
  authorCoveredShards: number;
  verifierCoveredShards: number;
  runnableQuanta: number;
  leasedQuanta: number;
  retryingQuanta: number;
  failedQuanta: number;
  succeededQuanta: number;
  obligationCount: number;
  unresolvedObligations: number;
  nextDueAt?: string;
  successorJobId?: string;
  transitionId?: string;
  terminalReason?: string;
}

export type { GraphReviewBasis };

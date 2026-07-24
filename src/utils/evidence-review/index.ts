/**
 * Evidence Review foundation public API (#106).
 *
 * Additive pure modules for:
 * - immutable Evidence Bundle manifests
 * - content-addressed Evidence Shards
 * - Runtime-owned Deterministic Evidence Sharding
 * - Shard Finding Set validation
 * - lane-specific Evidence Dossiers
 * - structural Dossier Difference Index
 * - deterministic Review Obligation construction
 *
 * Integrator assumptions (#105 / engine owner):
 * 1. Call `shardEvidenceBundle` once on a frozen EvidenceBundle; persist the
 *    returned manifest + shards as the immutable Review Basis material.
 * 2. Author and Verifier reader lanes each produce a `ShardFindingSet` per
 *    manifest shard without sharing natural-language findings.
 * 3. Validate every finding set with `validateShardFindingSet` /
 *    `validateLaneCoverage` before dossier construction.
 * 4. Build dossiers with `buildEvidenceDossier`, then
 *    `buildDossierDifferenceIndex` and `buildReviewObligations`.
 * 5. Final Skill Verifier dispositions must pass
 *    `validateObligationDispositions` (and ideally
 *    `allObligationsResolvedForCommit`) before Capability Transition commit.
 * 6. This package does not schedule wakes, lease quanta, run Skill Author /
 *    Verifier branches, or perform Review Commit Fence comparison.
 */

export {
  canonicalize,
  hashEvidenceContent,
  sha256Hex,
  stableStringify,
} from './canonical';

export {
  DEFAULT_SHARD_SOFT_LIMIT_BYTES,
  hashEvidenceBundle,
  makeShardId,
  recursivelySplitContent,
  shardEvidenceBundle,
  splitByStableBytes,
  verifyShardContent,
} from './sharding';
export type { ShardEvidenceBundleResult, ShardingOptions } from './sharding';

export {
  coverageSatisfiesLane,
  isValidSpan,
  validateLaneCoverage,
  validateShardFindingSet,
} from './finding-set';
export type { LaneCoverageResult } from './finding-set';

export {
  assembleDossierFromValidatedSets,
  buildEvidenceDossier,
} from './dossier';
export type { BuildDossierInput } from './dossier';

export { buildDossierDifferenceIndex } from './difference-index';

export {
  OBLIGATION_FINDING_CLASSES,
  allObligationsResolvedForCommit,
  buildReviewObligations,
  validateObligationDispositions,
} from './obligations';
export type { ObligationDispositionValidation } from './obligations';

export type {
  DossierDifferenceEntry,
  DossierDifferenceIndex,
  DossierDifferenceKind,
  EvidenceBundleManifest,
  EvidenceDossier,
  EvidenceReviewLane,
  EvidenceShard,
  EvidenceShardCoverageDisposition,
  EvidenceShardDomainKind,
  EvidenceShardSpan,
  ObligationDisposition,
  ReviewFindingClass,
  ReviewObligation,
  ReviewObligationKind,
  ShardFindingSet,
  ShardFindingValidationCode,
  ShardFindingValidationError,
  ShardFindingValidationResult,
  TypedFinding,
} from './types';

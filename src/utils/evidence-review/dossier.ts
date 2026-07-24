/**
 * Lane-specific Evidence Dossier construction.
 *
 * Each reader lane produces an independent provenance-linked dossier from its
 * own Shard Finding Sets. Lanes never share natural-language findings.
 */

import { validateLaneCoverage } from './finding-set';
import type {
  EvidenceBundleManifest,
  EvidenceDossier,
  EvidenceReviewLane,
  EvidenceShard,
  ShardFindingSet,
} from './types';

export interface BuildDossierInput {
  readonly lane: EvidenceReviewLane;
  readonly manifest: EvidenceBundleManifest;
  readonly shards: readonly EvidenceShard[];
  readonly findingSets: readonly ShardFindingSet[];
  /**
   * When true (default), reject dossiers that do not completely cover the
   * fixed manifest with satisfying coverage dispositions.
   */
  readonly requireCompleteCoverage?: boolean;
}

/**
 * Build one lane dossier from validated finding sets.
 * Throws when `requireCompleteCoverage` is true and coverage is incomplete
 * or any finding set fails schema/membership validation.
 */
export function buildEvidenceDossier(input: BuildDossierInput): EvidenceDossier {
  const requireComplete = input.requireCompleteCoverage !== false;
  const coverage = validateLaneCoverage(
    input.lane,
    input.manifest,
    input.shards,
    input.findingSets,
  );

  if (requireComplete && !coverage.complete) {
    const first = coverage.errors[0];
    throw new Error(
      first
        ? `${first.code}: ${first.message}`
        : `incomplete_coverage: lane ${input.lane} does not cover the fixed manifest`,
    );
  }

  if (requireComplete && coverage.errors.length > 0) {
    const first = coverage.errors[0]!;
    throw new Error(`${first.code}: ${first.message}`);
  }

  // Stable ordering for deterministic dossier identity downstream.
  const orderedSets = [...input.findingSets].sort((a, b) => (
    a.shardId.localeCompare(b.shardId, 'en')
    || a.lane.localeCompare(b.lane, 'en')
  ));
  const findings = orderedSets
    .flatMap(set => set.findings)
    .slice()
    .sort((a, b) => a.findingId.localeCompare(b.findingId, 'en'));

  return {
    lane: input.lane,
    manifestHash: input.manifest.manifestHash,
    coveredShardIds: [...coverage.coveredShardIds].sort((a, b) => a.localeCompare(b, 'en')),
    findings,
    findingSets: orderedSets,
    complete: coverage.complete && coverage.errors.length === 0,
  };
}

/**
 * Convenience for integrators that already validated finding sets and only
 * need the dossier shape (e.g. after partial progress). Does not re-validate.
 */
export function assembleDossierFromValidatedSets(
  lane: EvidenceReviewLane,
  manifestHash: string,
  sets: readonly ShardFindingSet[],
  coveredShardIds: readonly string[],
  complete: boolean,
): EvidenceDossier {
  const orderedSets = [...sets].sort((a, b) => a.shardId.localeCompare(b.shardId, 'en'));
  return {
    lane,
    manifestHash,
    coveredShardIds: [...coveredShardIds].sort((a, b) => a.localeCompare(b, 'en')),
    findings: orderedSets.flatMap(set => set.findings),
    findingSets: orderedSets,
    complete,
  };
}

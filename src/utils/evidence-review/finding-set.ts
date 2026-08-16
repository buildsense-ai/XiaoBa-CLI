/**
 * Shard Finding Set validation.
 *
 * Runtime validates canonical hashes, exact in-shard spans, lane identity,
 * fixed-manifest membership, and incomplete unreadable/ambiguous coverage.
 * Free-form prose alone cannot satisfy coverage. Readers cannot propose a
 * Capability Transition or cite outside the fixed manifest.
 */

import { hashEvidenceContent } from './canonical';
import type {
  EvidenceBundleManifest,
  EvidenceReviewLane,
  EvidenceShard,
  EvidenceShardCoverageDisposition,
  EvidenceShardSpan,
  ReviewFindingClass,
  ShardFindingSet,
  ShardFindingValidationError,
  ShardFindingValidationResult,
  TypedFinding,
} from './types';

const COVERAGE_VALUES: readonly EvidenceShardCoverageDisposition[] = [
  'covered',
  'unreadable',
  'ambiguous',
  'empty',
];

const FINDING_CLASSES: readonly ReviewFindingClass[] = [
  'fact',
  'limitation',
  'risk',
  'contradiction',
  'source_instruction',
  'privilege_implication',
  'unresolved_question',
  'classification_difference',
  'uncorroborated_claim',
];

function err(
  code: ShardFindingValidationError['code'],
  message: string,
  extra: Partial<ShardFindingValidationError> = {},
): ShardFindingValidationError {
  return { code, message, ...extra };
}

export function isValidSpan(span: EvidenceShardSpan, contentByteLength: number): boolean {
  return (
    typeof span.start === 'number'
    && typeof span.end === 'number'
    && Number.isInteger(span.start)
    && Number.isInteger(span.end)
    && span.start >= 0
    && span.end > span.start
    && span.end <= contentByteLength
  );
}

/**
 * Validate one Shard Finding Set against its immutable shard and fixed manifest.
 *
 * `expectedLane` rejects cross-lane contamination when provided.
 */
export function validateShardFindingSet(
  set: ShardFindingSet,
  shard: EvidenceShard,
  manifest: EvidenceBundleManifest,
  options: { expectedLane?: EvidenceReviewLane } = {},
): ShardFindingValidationResult {
  const errors: ShardFindingValidationError[] = [];

  if (!set || typeof set.shardId !== 'string' || !set.shardId
    || typeof set.contentHash !== 'string' || !set.contentHash
    || (set.lane !== 'author' && set.lane !== 'verifier')) {
    errors.push(err('missing_identity', 'Shard Finding Set missing identity fields'));
    return { ok: false, errors };
  }

  if (options.expectedLane && set.lane !== options.expectedLane) {
    errors.push(err(
      'lane_mismatch',
      `Shard Finding Set lane ${set.lane} does not match expected ${options.expectedLane}`,
      { shardId: set.shardId },
    ));
  }

  if (!manifest.shardIds.includes(set.shardId)) {
    errors.push(err(
      'unknown_shard',
      `Shard Finding Set cites shard ${set.shardId} outside the fixed manifest`,
      { shardId: set.shardId },
    ));
  }

  if (set.shardId !== shard.shardId) {
    errors.push(err(
      'unknown_shard',
      `Shard Finding Set shardId ${set.shardId} does not match provided shard ${shard.shardId}`,
      { shardId: set.shardId },
    ));
  }

  if (set.contentHash !== shard.contentHash) {
    errors.push(err(
      'content_hash_mismatch',
      `Shard Finding Set contentHash does not match shard ${shard.shardId}`,
      { shardId: set.shardId },
    ));
  }

  const recomputed = hashEvidenceContent(shard.content);
  if (recomputed !== shard.contentHash || recomputed !== set.contentHash) {
    errors.push(err(
      'mutated_content',
      `Shard ${shard.shardId} content mutated under declared contentHash`,
      { shardId: set.shardId },
    ));
  }

  if (!COVERAGE_VALUES.includes(set.coverage)) {
    errors.push(err(
      'invalid_coverage',
      `Invalid coverage disposition: ${String(set.coverage)}`,
      { shardId: set.shardId },
    ));
  }

  if (!Array.isArray(set.findings)) {
    errors.push(err(
      'missing_findings_array',
      'Shard Finding Set findings must be an array',
      { shardId: set.shardId },
    ));
    return { ok: false, errors };
  }

  // Free-form diagnostic alone cannot satisfy coverage for non-empty content.
  if (
    set.coverage === 'covered'
    && set.findings.length === 0
    && shard.content.trim().length > 0
    && typeof set.diagnostic === 'string'
    && set.diagnostic.trim().length > 0
  ) {
    errors.push(err(
      'free_form_only',
      'Free-form diagnostic without structured findings cannot satisfy coverage',
      { shardId: set.shardId },
    ));
  }

  const contentLen = Buffer.byteLength(shard.content, 'utf8');
  if (contentLen === 0 && (set.coverage !== 'empty' || set.findings.length > 0)) {
    errors.push(err(
      'invalid_coverage',
      `Empty shard ${shard.shardId} must use empty coverage without findings`,
      { shardId: set.shardId },
    ));
  }
  if (contentLen > 0 && set.coverage === 'empty') {
    errors.push(err(
      'invalid_coverage',
      `Non-empty shard ${shard.shardId} cannot use empty coverage`,
      { shardId: set.shardId },
    ));
  }
  for (const finding of set.findings) {
    errors.push(...validateFinding(finding, contentLen, set.shardId));
  }

  return { ok: errors.length === 0, errors };
}

function validateFinding(
  finding: TypedFinding,
  contentByteLength: number,
  shardId: string,
): ShardFindingValidationError[] {
  const errors: ShardFindingValidationError[] = [];
  if (
    !finding
    || typeof finding.findingId !== 'string'
    || !finding.findingId
    || typeof finding.summary !== 'string'
    || !finding.summary
    || !FINDING_CLASSES.includes(finding.classification)
  ) {
    errors.push(err(
      'invalid_finding',
      'Finding missing required fields or has invalid classification',
      { shardId, findingId: finding?.findingId },
    ));
    return errors;
  }

  if (!Array.isArray(finding.spans)) {
    errors.push(err(
      'invalid_span',
      `Finding ${finding.findingId} spans must be an array`,
      { shardId, findingId: finding.findingId },
    ));
    return errors;
  }

  for (const span of finding.spans) {
    if (!isValidSpan(span, contentByteLength)) {
      errors.push(err(
        'invalid_span',
        `Finding ${finding.findingId} has span outside shard bounds `
          + `[${String((span as EvidenceShardSpan)?.start)}, ${String((span as EvidenceShardSpan)?.end)}] `
          + `for content length ${contentByteLength}`,
        { shardId, findingId: finding.findingId },
      ));
    }
  }

  return errors;
}

/**
 * A coverage disposition satisfies dual-lane completeness only when it is
 * `covered` or `empty`. Unreadable and ambiguous remain incomplete.
 */
export function coverageSatisfiesLane(coverage: EvidenceShardCoverageDisposition): boolean {
  return coverage === 'covered' || coverage === 'empty';
}

export interface LaneCoverageResult {
  readonly complete: boolean;
  readonly coveredShardIds: readonly string[];
  readonly incompleteShardIds: readonly string[];
  readonly errors: readonly ShardFindingValidationError[];
}

/**
 * Validate that one lane has a schema-valid, membership-closed finding set
 * for every manifest shard, and that each set satisfies coverage.
 */
export function validateLaneCoverage(
  lane: EvidenceReviewLane,
  manifest: EvidenceBundleManifest,
  shards: readonly EvidenceShard[],
  findingSets: readonly ShardFindingSet[],
): LaneCoverageResult {
  const errors: ShardFindingValidationError[] = [];
  const byId = new Map(shards.map(s => [s.shardId, s]));
  const setsByShard = new Map<string, ShardFindingSet>();

  for (const set of findingSets) {
    if (setsByShard.has(set.shardId)) {
      errors.push(err(
        'invalid_finding',
        `Duplicate Shard Finding Set for shard ${set.shardId} in lane ${lane}`,
        { shardId: set.shardId },
      ));
      continue;
    }
    setsByShard.set(set.shardId, set);
    const shard = byId.get(set.shardId);
    if (!shard) {
      errors.push(err(
        'cross_manifest_citation',
        `Lane ${lane} cites unknown shard ${set.shardId}`,
        { shardId: set.shardId },
      ));
      continue;
    }
    const result = validateShardFindingSet(set, shard, manifest, { expectedLane: lane });
    errors.push(...result.errors);
  }

  const coveredShardIds: string[] = [];
  const incompleteShardIds: string[] = [];

  for (const shardId of manifest.shardIds) {
    const set = setsByShard.get(shardId);
    if (!set) {
      incompleteShardIds.push(shardId);
      errors.push(err(
        'incomplete_coverage',
        `Lane ${lane} missing finding set for manifest shard ${shardId}`,
        { shardId },
      ));
      continue;
    }
    if (!coverageSatisfiesLane(set.coverage)) {
      incompleteShardIds.push(shardId);
      errors.push(err(
        'incomplete_coverage',
        `Lane ${lane} coverage for shard ${shardId} is ${set.coverage} and does not satisfy completeness`,
        { shardId },
      ));
      continue;
    }
    coveredShardIds.push(shardId);
  }

  return {
    complete: incompleteShardIds.length === 0 && errors.every(e => e.code !== 'incomplete_coverage'),
    coveredShardIds,
    incompleteShardIds,
    errors,
  };
}

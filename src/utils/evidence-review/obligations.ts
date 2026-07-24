/**
 * Deterministic Review Obligation construction.
 *
 * Runtime converts high-risk findings, structural differences, limitations,
 * source instructions, privilege implications, unresolved questions,
 * classification differences, and uncorroborated claims into explicit
 * obligations. The final Skill Verifier must disposition every obligation
 * with original shard spans; unresolved obligations defer rather than accept.
 */

import { sha256Hex } from './canonical';
import type {
  DossierDifferenceIndex,
  EvidenceDossier,
  EvidenceShard,
  EvidenceShardSpan,
  ObligationDisposition,
  ReviewFindingClass,
  ReviewObligation,
  TypedFinding,
} from './types';

/** Finding classes that always raise a Review Obligation. */
export const OBLIGATION_FINDING_CLASSES: readonly ReviewFindingClass[] = [
  'limitation',
  'risk',
  'contradiction',
  'source_instruction',
  'privilege_implication',
  'unresolved_question',
  'classification_difference',
  'uncorroborated_claim',
];

function findingShardIds(
  finding: TypedFinding,
  dossiers: readonly EvidenceDossier[],
): string[] {
  const ids = new Set<string>();
  for (const dossier of dossiers) {
    for (const set of dossier.findingSets) {
      if (set.findings.some(f => f.findingId === finding.findingId)) {
        ids.add(set.shardId);
      }
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Build the union of Review Obligations from both dossiers and the
 * structural Difference Index. Stable unique by obligationId.
 */
export function buildReviewObligations(
  author: EvidenceDossier,
  verifier: EvidenceDossier,
  difference: DossierDifferenceIndex,
): ReviewObligation[] {
  if (author.manifestHash !== verifier.manifestHash
    || author.manifestHash !== difference.manifestHash) {
    throw new Error('Review Obligations require matching manifestHash across dossiers and difference index');
  }

  const obligations: ReviewObligation[] = [];
  const dossiers = [author, verifier] as const;
  const seenFindings = new Set<string>();

  for (const finding of [...author.findings, ...verifier.findings]) {
    if (!OBLIGATION_FINDING_CLASSES.includes(finding.classification)) continue;
    if (seenFindings.has(finding.findingId)) continue;
    seenFindings.add(finding.findingId);
    obligations.push({
      obligationId: `obl:${finding.findingId}`,
      kind: finding.classification,
      summary: finding.summary,
      relatedFindingIds: [finding.findingId],
      requiredShardIds: findingShardIds(finding, dossiers),
    });
  }

  for (const entry of difference.entries) {
    const related = [entry.leftFindingId, entry.rightFindingId]
      .filter((id): id is string => typeof id === 'string');
    const requiredShardIds = new Set<string>();
    if (entry.shardId) requiredShardIds.add(entry.shardId);
    for (const findingId of related) {
      const finding = [...author.findings, ...verifier.findings]
        .find(item => item.findingId === findingId);
      if (!finding) continue;
      for (const shardId of findingShardIds(finding, dossiers)) {
        requiredShardIds.add(shardId);
      }
    }
    if (requiredShardIds.size === 0) {
      for (const shardId of [...author.coveredShardIds, ...verifier.coveredShardIds]) {
        requiredShardIds.add(shardId);
      }
    }
    const detailHash = sha256Hex(entry.detail).slice(0, 12);
    obligations.push({
      obligationId: `obl:diff:${entry.kind}:${detailHash}`,
      kind: 'difference',
      summary: entry.detail,
      relatedFindingIds: related,
      requiredShardIds: [...requiredShardIds].sort((a, b) => a.localeCompare(b, 'en')),
    });
  }

  // Stable unique by obligationId, sorted for deterministic output.
  const byId = new Map<string, ReviewObligation>();
  for (const obligation of obligations) {
    if (!byId.has(obligation.obligationId)) byId.set(obligation.obligationId, obligation);
  }
  return [...byId.values()].sort((a, b) => a.obligationId.localeCompare(b.obligationId, 'en'));
}

export interface ObligationDispositionValidation {
  readonly ok: boolean;
  readonly unresolvedObligationIds: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Verify every obligation has an explicit disposition citing original shard
 * spans. Unresolved obligations must defer the job — never silently accept.
 */
export function validateObligationDispositions(
  obligations: readonly ReviewObligation[],
  dispositions: readonly ObligationDisposition[],
  shards: readonly EvidenceShard[],
): ObligationDispositionValidation {
  const errors: string[] = [];
  const byId = new Map(dispositions.map(d => [d.obligationId, d]));
  const shardById = new Map(shards.map(s => [s.shardId, s]));
  const unresolved: string[] = [];

  if (byId.size !== dispositions.length) {
    errors.push('Duplicate obligation dispositions are not allowed');
  }

  for (const obligation of obligations) {
    const disposition = byId.get(obligation.obligationId);
    if (!disposition) {
      unresolved.push(obligation.obligationId);
      errors.push(`Missing disposition for obligation ${obligation.obligationId}`);
      continue;
    }
    if (!['accepted', 'mitigated', 'deferred', 'rejected'].includes(disposition.decision)) {
      errors.push(`Invalid decision for obligation ${obligation.obligationId}`);
    }
    if (typeof disposition.rationale !== 'string' || !disposition.rationale.trim()) {
      errors.push(`Disposition for ${obligation.obligationId} requires rationale`);
    }
    if (!Array.isArray(disposition.citedSpans) || disposition.citedSpans.length === 0) {
      errors.push(
        `Disposition for ${obligation.obligationId} must cite original shard spans`,
      );
      continue;
    }
    for (const cited of disposition.citedSpans) {
      const shard = shardById.get(cited.shardId);
      if (!shard) {
        errors.push(
          `Disposition for ${obligation.obligationId} cites unknown shard ${cited.shardId}`,
        );
        continue;
      }
      if (!isInBounds(cited.span, shard.byteLength)) {
        errors.push(
          `Disposition for ${obligation.obligationId} cites out-of-bounds span on ${cited.shardId}`,
        );
      }
    }
  }

  // Extra dispositions for unknown obligations are rejected for audit clarity.
  const known = new Set(obligations.map(o => o.obligationId));
  for (const disposition of dispositions) {
    if (!known.has(disposition.obligationId)) {
      errors.push(`Disposition references unknown obligation ${disposition.obligationId}`);
    }
  }

  return {
    ok: unresolved.length === 0 && errors.length === 0,
    unresolvedObligationIds: unresolved,
    errors,
  };
}

function isInBounds(span: EvidenceShardSpan, contentByteLength: number): boolean {
  return (
    Number.isInteger(span.start)
    && Number.isInteger(span.end)
    && span.start >= 0
    && span.end > span.start
    && span.end <= contentByteLength
  );
}

/**
 * True when every obligation is dispositioned and none remain deferred.
 * Integrators use this as the final commit gate.
 */
export function allObligationsResolvedForCommit(
  obligations: readonly ReviewObligation[],
  dispositions: readonly ObligationDisposition[],
  shards: readonly EvidenceShard[],
): boolean {
  const validation = validateObligationDispositions(obligations, dispositions, shards);
  if (!validation.ok) return false;
  return dispositions.every(d => d.decision !== 'deferred');
}

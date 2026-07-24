/**
 * Structural Dossier Difference Index.
 *
 * Built deterministically from coverage, citations, spans, and finding
 * classifications. Runtime does not resolve semantic disagreements.
 *
 * Corroboration is structural: two lane findings corroborate when they share
 * the same classification AND cite an overlapping byte span on the SAME shard.
 * This keeps natural-language paraphrases of one cited evidence region from
 * being mechanically classified as missing citations while preserving real
 * coverage gaps, span conflicts (different regions), classification conflicts
 * (same region, different class), high-risk disagreements, and auditability
 * fail-closed (Progressive Trust / dual-lane evidence review contract).
 */

import type {
  DossierDifferenceEntry,
  DossierDifferenceIndex,
  EvidenceDossier,
  EvidenceShardSpan,
  TypedFinding,
} from './types';

/** Citations carried by one finding, resolved from its lane finding sets. */
interface FindingCitation {
  readonly shardId: string;
  readonly span: EvidenceShardSpan;
  readonly isEmpty: boolean;
}

/**
 * Compare Author and Verifier dossiers structurally.
 * Both dossiers must reference the same manifestHash.
 */
export function buildDossierDifferenceIndex(
  author: EvidenceDossier,
  verifier: EvidenceDossier,
): DossierDifferenceIndex {
  if (author.manifestHash !== verifier.manifestHash) {
    throw new Error(
      'Dossier Difference Index requires matching manifestHash on both dossiers',
    );
  }
  if (author.lane !== 'author' || verifier.lane !== 'verifier') {
    throw new Error(
      'Dossier Difference Index requires author and verifier lane dossiers',
    );
  }

  const entries: DossierDifferenceEntry[] = [];

  // Resolve each finding's cited (shardId, span) pairs from its lane
  // finding sets. A finding corroborates only against citations on the SAME
  // shard; cross-shard agreement is a coverage concern, not a citation match.
  const authorCitations = new Map<string, FindingCitation[]>();
  const verifierCitations = new Map<string, FindingCitation[]>();
  for (const finding of author.findings) {
    authorCitations.set(finding.findingId, collectCitations(author, finding.findingId));
  }
  for (const finding of verifier.findings) {
    verifierCitations.set(finding.findingId, collectCitations(verifier, finding.findingId));
  }

  // Findings on an overlapping span of a shared shard are "addressed" by the
  // other lane, regardless of classification. They never raise missing_citation
  // (a classification mismatch there is a classification_conflict, below).
  const authorAddressedDifferentClass = new Set<string>();
  const verifierAddressedDifferentClass = new Set<string>();

  // Classification conflicts: same shard + overlapping span + different class.
  for (const left of author.findings) {
    const leftCits = authorCitations.get(left.findingId) ?? [];
    for (const right of verifier.findings) {
      if (left.classification === right.classification) continue;
      const rightCits = verifierCitations.get(right.findingId) ?? [];
      if (!citationsOverlap(leftCits, rightCits)) continue;
      authorAddressedDifferentClass.add(left.findingId);
      verifierAddressedDifferentClass.add(right.findingId);
      entries.push({
        kind: 'classification_conflict',
        leftFindingId: left.findingId,
        rightFindingId: right.findingId,
        detail:
          `Classification conflict on shared shard span: `
          + `author=${left.classification} verifier=${right.classification}`,
      });
    }
  }

  // Per-finding corroboration for the missing_citation / span_mismatch /
  // conflicting_finding kinds. Same classification + overlapping span on a
  // shared shard corroborates and emits nothing.
  for (const left of author.findings) {
    if (authorAddressedDifferentClass.has(left.findingId)) continue;
    entries.push(...classifySameClassFinding(left, author, verifier, authorCitations, verifierCitations));
  }
  for (const right of verifier.findings) {
    if (verifierAddressedDifferentClass.has(right.findingId)) continue;
    entries.push(...classifySameClassFinding(right, verifier, author, verifierCitations, authorCitations));
  }

  const authorCovered = new Set(author.coveredShardIds);
  const verifierCovered = new Set(verifier.coveredShardIds);
  for (const shardId of authorCovered) {
    if (!verifierCovered.has(shardId)) {
      entries.push({
        kind: 'coverage_gap',
        shardId,
        detail: `Author covered shard ${shardId} but Verifier did not`,
      });
    }
  }
  for (const shardId of verifierCovered) {
    if (!authorCovered.has(shardId)) {
      entries.push({
        kind: 'coverage_gap',
        shardId,
        detail: `Verifier covered shard ${shardId} but Author did not`,
      });
    }
  }

  // Deterministic order for stable obligation IDs downstream.
  entries.sort((a, b) => {
    const kind = a.kind.localeCompare(b.kind, 'en');
    if (kind !== 0) return kind;
    return a.detail.localeCompare(b.detail, 'en');
  });

  return {
    manifestHash: author.manifestHash,
    entries,
  };
}

/**
 * Classify one finding against the opposite lane's same-class findings.
 * Emits at most one difference:
 *   - corroborated (no entry) when a same-class finding overlaps on a shared shard;
 *   - span_mismatch (or conflicting_finding for high-signal classes) when a
 *     same-class finding shares a shard but cites a non-overlapping region;
 *   - missing_citation otherwise.
 */
function classifySameClassFinding(
  finding: TypedFinding,
  sameDossier: EvidenceDossier,
  otherDossier: EvidenceDossier,
  sameCitations: Map<string, FindingCitation[]>,
  otherCitations: Map<string, FindingCitation[]>,
): DossierDifferenceEntry[] {
  const sameCits = sameCitations.get(finding.findingId) ?? [];
  const sameIsHighSignal = isHighSignal(finding);
  const sameLaneLabel = sameDossier.lane;

  let regionMismatchPeer: TypedFinding | undefined;
  for (const other of otherDossier.findings) {
    if (other.classification !== finding.classification) continue;
    const otherCits = otherCitations.get(other.findingId) ?? [];
    if (citationsOverlap(sameCits, otherCits)) {
      // Same-class + overlapping span on a shared shard.
      // Explicit polarity conflict (pass/ok vs fail/error) breaks
      // corroboration. Ordinary paraphrases (including high-signal) remain
      // corroborated; genuine non-overlap/classification disagreements are
      // already fail-closed via classification_conflict & coverage_gap.
      if (hasExplicitPolarityConflict(finding.summary, other.summary)) {
        return [buildPolarityConflictEntry(finding, other, sameLaneLabel)];
      }
      // Corroborated.
      return [];
    }
    if (!regionMismatchPeer && citationsShareShard(sameCits, otherCits)) {
      regionMismatchPeer = other;
    }
  }

  if (regionMismatchPeer) {
    const kind: DossierDifferenceKindEntry = sameIsHighSignal ? 'conflicting_finding' : 'span_mismatch';
    const left = sameLaneLabel === 'author' ? finding : regionMismatchPeer;
    const right = sameLaneLabel === 'author' ? regionMismatchPeer : finding;
    return [{
      kind,
      ...(left ? { leftFindingId: left.findingId } : {}),
      ...(right ? { rightFindingId: right.findingId } : {}),
      detail:
        kind === 'conflicting_finding'
          ? `Conflicting ${finding.classification} findings cite different evidence regions on a shared shard: "${finding.summary}" vs "${regionMismatchPeer.summary}"`
          : `Span mismatch for "${finding.summary}" under ${finding.classification} on a shared shard`,
    }];
  }

  return [{
    kind: 'missing_citation',
    ...(sameLaneLabel === 'author'
      ? { leftFindingId: finding.findingId }
      : { rightFindingId: finding.findingId }),
    detail:
      `${sameLaneLabel === 'author' ? 'Author' : 'Verifier'} finding not corroborated by ${sameLaneLabel === 'author' ? 'Verifier' : 'Author'}: ${finding.summary}`,
  }];
}

type DossierDifferenceKindEntry =
  | 'missing_citation'
  | 'span_mismatch'
  | 'conflicting_finding';

/** Resolve the (shardId, span) citations of one finding from its lane sets. */
function collectCitations(dossier: EvidenceDossier, findingId: string): FindingCitation[] {
  const out: FindingCitation[] = [];
  for (const set of dossier.findingSets) {
    const finding = set.findings.find(f => f.findingId === findingId);
    if (!finding) continue;
    for (const span of finding.spans) {
      const isEmpty = !(span.end > span.start && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0);
      out.push({ shardId: set.shardId, span, isEmpty });
    }
  }
  return out;
}

/** True when the two citation lists overlap on the SAME shard. */
function citationsOverlap(a: readonly FindingCitation[], b: readonly FindingCitation[]): boolean {
  for (const left of a) {
    if (left.isEmpty) continue;
    for (const right of b) {
      if (right.isEmpty) continue;
      if (left.shardId !== right.shardId) continue;
      if (spansOverlap(left.span, right.span)) return true;
    }
  }
  return false;
}

/** True when the two citation lists cite the SAME shard at all (any region). */
function citationsShareShard(a: readonly FindingCitation[], b: readonly FindingCitation[]): boolean {
  const shards = new Set(a.map(c => c.shardId));
  for (const right of b) {
    if (shards.has(right.shardId)) return true;
  }
  return false;
}

/** Inclusive-exclusive byte-span overlap. Zero-length spans never overlap. */
function spansOverlap(a: EvidenceShardSpan, b: EvidenceShardSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Provider-neutral explicit polarity conflict: one summary carries a positive
 * outcome signal (pass/success/completed/verified/working) while the other
 * carries a negative signal (fail/error/unsuccessful/broken/blocker). Both
 * English and Chinese polarity words are matched — purely structural, no
 * semantic sentiment analysis.
 */
function hasExplicitPolarityConflict(a: string, b: string): boolean {
  const aPos = POLARITY_POSITIVE.test(a);
  const bPos = POLARITY_POSITIVE.test(b);
  const aNeg = POLARITY_NEGATIVE.test(a);
  const bNeg = POLARITY_NEGATIVE.test(b);
  return (aPos && bNeg) || (aNeg && bPos);
}

const POLARITY_POSITIVE = /(?<![\w-])(?:pass(?:ed|ing)?|success(?:ful)?|complet(?:ed|ion)|done|fixed|verified|validat(?:ed|ion)|deliver(?:ed|y)|working|ok|ready|correct|通过|完成|成功|正常|验证通过|测试通过)(?![\w-])/iu;
const POLARITY_NEGATIVE = /(?<![\w-])(?:fail(?:ed|ing|ure)?|error|not\s+(?:ok|ready|working|correct|verified)|unsuccessful|unsupported|bug(?:gy)?|broken|unfixed|blocker|crash(?:ed|es)?|cannot|can't|won't|未(?:通过|完成|成功)|失败|错误|异常)(?![\w-])/iu;

function buildPolarityConflictEntry(
  finding: TypedFinding,
  other: TypedFinding,
  sameLaneLabel: string,
): DossierDifferenceEntry {
  const left = sameLaneLabel === 'author' ? finding : other;
  const right = sameLaneLabel === 'author' ? other : finding;
  return {
    kind: 'conflicting_finding',
    leftFindingId: left.findingId,
    rightFindingId: right.findingId,
    detail:
      `Polarity conflict: same-class "${finding.classification}" findings from both lanes cite the same evidence span but carry opposite-polarity summaries: "${finding.summary}" vs "${other.summary}"`,
  };
}

function isHighSignal(finding: TypedFinding): boolean {
  return (
    finding.classification === 'risk'
    || finding.classification === 'contradiction'
    || finding.classification === 'source_instruction'
    || finding.classification === 'privilege_implication'
    || finding.classification === 'limitation'
    || finding.classification === 'unresolved_question'
  );
}

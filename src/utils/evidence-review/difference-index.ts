/**
 * Structural Dossier Difference Index.
 *
 * Built deterministically from coverage, citations, spans, and finding
 * classifications. Runtime does not resolve semantic disagreements.
 */

import type {
  DossierDifferenceEntry,
  DossierDifferenceIndex,
  EvidenceDossier,
  TypedFinding,
} from './types';

function classificationKey(finding: TypedFinding): string {
  return `${finding.classification}:${finding.summary}`;
}

function spanKey(finding: TypedFinding): string {
  return finding.spans
    .map(span => `${span.start}-${span.end}`)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .join(',');
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

  const authorByClass = new Map(author.findings.map(f => [classificationKey(f), f]));
  const verifierByClass = new Map(verifier.findings.map(f => [classificationKey(f), f]));

  for (const [key, finding] of authorByClass) {
    if (!verifierByClass.has(key)) {
      entries.push({
        kind: 'missing_citation',
        leftFindingId: finding.findingId,
        detail: `Author finding not corroborated by Verifier: ${finding.summary}`,
      });
    }
  }
  for (const [key, finding] of verifierByClass) {
    if (!authorByClass.has(key)) {
      entries.push({
        kind: 'missing_citation',
        rightFindingId: finding.findingId,
        detail: `Verifier finding not present in Author dossier: ${finding.summary}`,
      });
    }
  }

  // Classification conflicts: same summary text, different classification.
  const authorBySummary = groupBy(author.findings, f => f.summary);
  const verifierBySummary = groupBy(verifier.findings, f => f.summary);
  for (const [summary, authorFindings] of authorBySummary) {
    const verifierFindings = verifierBySummary.get(summary);
    if (!verifierFindings) continue;
    for (const left of authorFindings) {
      for (const right of verifierFindings) {
        if (left.classification !== right.classification) {
          entries.push({
            kind: 'classification_conflict',
            leftFindingId: left.findingId,
            rightFindingId: right.findingId,
            detail:
              `Classification conflict for "${summary}": `
              + `author=${left.classification} verifier=${right.classification}`,
          });
        } else if (spanKey(left) !== spanKey(right)) {
          entries.push({
            kind: 'span_mismatch',
            leftFindingId: left.findingId,
            rightFindingId: right.findingId,
            detail: `Span mismatch for "${summary}" under ${left.classification}`,
          });
        }
      }
    }
  }

  // Conflicting findings: same classification, different summaries on shared shards.
  // Kept structural — Runtime does not decide which summary is correct.
  const authorHighRisk = author.findings.filter(isHighSignal);
  const verifierHighRisk = verifier.findings.filter(isHighSignal);
  for (const left of authorHighRisk) {
    for (const right of verifierHighRisk) {
      if (
        left.classification === right.classification
        && left.summary !== right.summary
      ) {
        entries.push({
          kind: 'conflicting_finding',
          leftFindingId: left.findingId,
          rightFindingId: right.findingId,
          detail:
            `Conflicting ${left.classification} findings: `
            + `"${left.summary}" vs "${right.summary}"`,
        });
      }
    }
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

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

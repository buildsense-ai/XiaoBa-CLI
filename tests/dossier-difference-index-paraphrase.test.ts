import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildDossierDifferenceIndex,
  assembleDossierFromValidatedSets,
} from '../src/utils/evidence-review';
import type {
  EvidenceDossier,
  EvidenceShardSpan,
  ShardFindingSet,
  TypedFinding,
} from '../src/utils/evidence-review';

/**
 * Progressive Trust / dual-lane corroboration regression (root cause #4).
 *
 * The structural Difference Index must not manufacture one `missing_citation`
 * per natural-language wording difference when Author and Verifier paraphrase
 * the SAME classification over the SAME (or overlapping) source span. It must
 * also keep real coverage gaps, span conflicts, classification conflicts, and
 * high-risk disagreements fail-closed.
 *
 * Public seam under test: `buildDossierDifferenceIndex` over two lane
 * dossiers assembled from validated ShardFindingSets.
 */

const MANIFEST_HASH = 'manifest-test-001';
const SHARD_ID = 'shard-001';

function span(start: number, end: number): EvidenceShardSpan {
  return { start, end };
}

function finding(
  findingId: string,
  classification: TypedFinding['classification'],
  summary: string,
  spans: readonly EvidenceShardSpan[],
): TypedFinding {
  return { findingId, classification, summary, spans };
}

function findingSet(
  lane: 'author' | 'verifier',
  findings: readonly TypedFinding[],
): ShardFindingSet {
  return {
    shardId: SHARD_ID,
    contentHash: 'content-hash-' + SHARD_ID,
    lane,
    coverage: 'covered',
    findings,
  };
}

function dossier(
  lane: 'author' | 'verifier',
  findings: readonly TypedFinding[],
): EvidenceDossier {
  return assembleDossierFromValidatedSets(
    lane,
    MANIFEST_HASH,
    [findingSet(lane, findings)],
    [SHARD_ID],
    true,
  );
}

function kinds(entries: ReadonlyArray<{ kind: string }>): string[] {
  return entries.map(e => e.kind).sort();
}

describe('Dossier Difference Index — paraphrase corroboration (RC #4)', () => {
  test('paraphrase of same classification over overlapping span is corroborated (no missing_citation)', () => {
    const author = dossier('author', [
      finding('a-1', 'fact', 'Removed VS Code cask and 19 extensions from Brewfile', [span(10, 120)]),
    ]);
    const verifier = dossier('verifier', [
      finding('v-1', 'fact', 'Uninstalled the VSCode app plus its extensions via brew bundle', [span(20, 110)]),
    ]);

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.deepEqual(
      kinds(index.entries),
      [],
      `paraphrase over overlapping span must not raise any difference; got ${JSON.stringify(index.entries)}`,
    );
  });

  test('high-signal same-class same-span paraphrase is corroborated (no false positive)', () => {
    // High-signal (limitation) findings with different summaries on the same
    // span are flagged as conflicting_finding per fail-closed semantics.
    // Genuine paraphrases within the same class+span also trigger this
    // because structural difference alone is the gate.
    const author = dossier('author', [
      finding('a-2', 'limitation', 'Only applies to macOS brew bundle workflows', [span(0, 64)]),
    ]);
    const verifier = dossier('verifier', [
      finding('v-2', 'limitation', 'Scoped to Homebrew bundle on macOS only', [span(0, 64)]),
    ]);

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.deepEqual(kinds(index.entries), [], 'high-signal paraphrase on same span must still corroborate');
  });

  test('different (non-overlapping) spans on the same shard still raise a difference', () => {
    const author = dossier('author', [
      finding('a-3', 'fact', 'Removed the VS Code cask entry', [span(0, 40)]),
    ]);
    const verifier = dossier('verifier', [
      finding('v-3', 'fact', 'Verified the Brewfile is well-formed', [span(200, 260)]),
    ]);

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.ok(
      index.entries.some(e => e.kind === 'span_mismatch' || e.kind === 'missing_citation'),
      `non-overlapping spans must raise a difference; got ${JSON.stringify(index.entries)}`,
    );
  });

  test('different classifications over the same span raise classification_conflict', () => {
    const author = dossier('author', [
      finding('a-4', 'fact', 'Describes a successful removal', [span(10, 120)]),
    ]);
    const verifier = dossier('verifier', [
      finding('v-4', 'risk', 'Describes a successful removal', [span(10, 120)]),
    ]);

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.ok(
      index.entries.some(e => e.kind === 'classification_conflict'),
      `different classification on the same span must conflict; got ${JSON.stringify(index.entries)}`,
    );
  });

  test('high-risk disagreement on different evidence regions stays flagged (no false corroboration)', () => {
    const author = dossier('author', [
      finding('a-5', 'risk', 'Irreversibly uninstalls user-installed apps', [span(0, 80)]),
    ]);
    const verifier = dossier('verifier', [
      finding('v-5', 'risk', 'Destructive: removes system-level packages without confirmation', [span(300, 420)]),
    ]);

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.ok(
      index.entries.length > 0,
      `high-risk disagreement on different regions must not be silently corroborated; got ${JSON.stringify(index.entries)}`,
    );
    // And specifically it must not be the now-removed "same summary" heuristic.
    assert.ok(
      !index.entries.some(e => e.kind === 'missing_citation' && /verbatim/i.test(e.detail)),
      'no verbatim-summary missing_citation heuristic should remain',
    );
  });

  test('real coverage gap (author covers a shard verifier did not) still raises', () => {
    const author = assembleDossierFromValidatedSets(
      'author',
      MANIFEST_HASH,
      [findingSet('author', [finding('a-6', 'fact', 'Covered shard one', [span(0, 10)])])],
      ['shard-001', 'shard-002'],
      true,
    );
    const verifier = assembleDossierFromValidatedSets(
      'verifier',
      MANIFEST_HASH,
      [
        {
          shardId: 'shard-002',
          contentHash: 'content-hash-shard-002',
          lane: 'verifier',
          coverage: 'covered',
          findings: [finding('v-6', 'fact', 'Covered shard two', [span(0, 10)])],
        },
      ],
      ['shard-002'],
      true,
    );

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.ok(
      index.entries.some(e => e.kind === 'coverage_gap'),
      `coverage gap must still be flagged; got ${JSON.stringify(index.entries)}`,
    );
  });

  test('same-class same-span opposite-polarity summaries (tests passed vs tests failed) must NOT be silently corroborated', () => {
    const author = dossier('author', [
      finding('a-7', 'fact', 'All tests passed successfully', [span(10, 80)]),
    ]);
    const verifier = dossier('verifier', [
      finding('v-7', 'fact', 'Several tests failed with errors', [span(10, 80)]),
    ]);

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.ok(
      index.entries.length > 0,
      `opposite-polarity same-class same-span summaries must not be silently corroborated; got ${JSON.stringify(index.entries)}`,
    );
  });

  test('paraphrase of same classification over overlapping span IS corroborated (no false positive)', () => {
    // Same as existing test: paraphrase IS corroborated.
    const author = dossier('author', [
      finding('a-9', 'fact', 'Removed VS Code cask from Brewfile', [span(10, 90)]),
    ]);
    const verifier = dossier('verifier', [
      finding('v-9', 'fact', 'Uninstalled VS Code via Homebrew', [span(10, 90)]),
    ]);

    const index = buildDossierDifferenceIndex(author, verifier);

    assert.deepEqual(
      kinds(index.entries),
      [],
      `genuine paraphrase must still be corroborated; got ${JSON.stringify(index.entries)}`,
    );
  });
});
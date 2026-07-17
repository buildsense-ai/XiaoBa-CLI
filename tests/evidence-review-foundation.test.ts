/**
 * #106 foundation tests — deterministic evidence sharding, dual-lane dossiers,
 * structural difference index, and review obligation construction.
 *
 * These tests cover pure modules only. They do not exercise Runtime Learning
 * wake, Quantum leasing, Skill Evolution branches, or commit fences.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { EvidenceBundle } from '../src/utils/skill-evolution';
import {
  allObligationsResolvedForCommit,
  assertManifestShardsConsistent,
  assertShardContentImmutable,
  buildDossierDifferenceIndex,
  buildEvidenceDossier,
  buildReviewObligations,
  coverageSatisfiesLane,
  hashEvidenceBundle,
  hashEvidenceContent,
  recursivelySplitContent,
  shardEvidenceBundle,
  splitByStableBytes,
  stableStringify,
  validateLaneCoverage,
  validateObligationDispositions,
  validateShardFindingSet,
  verifyShardContent,
  type EvidenceShard,
  type ShardFindingSet,
  type TypedFinding,
} from '../src/utils/evidence-review';

function makeBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    bundleId: 'v3:test-bundle:1',
    episode: {
      episodeId: 'ep-1',
      summary: 'solve a bounded routing problem',
      steps: ['inspect', 'plan', 'apply'],
    },
    completionEvidence: [
      { ref: 'src.log#t1', sourceFilePath: 'src.log', turn: 1 },
      { ref: 'src.log#t2', sourceFilePath: 'src.log', turn: 2 },
    ],
    settlementEvidence: [
      { ref: 'src.log#settle', sourceFilePath: 'src.log', turn: 3 },
    ],
    boundedContinuity: [{ turn: 0, text: 'prior context' }],
    referencedSkills: [
      {
        name: 'route-skill',
        guidanceHash: 'gh-1',
        content: 'Use the route skill carefully.\n\nNever expand privileges.',
      },
    ],
    relatedCurrentSkills: [
      {
        handle: 'cap-route',
        revision: 2,
        routingName: 'route-skill',
        description: 'Routes bounded work',
        guidanceHash: 'gh-1',
      },
    ],
    semanticObservations: [
      {
        kind: 'action_pattern',
        value: 'inspect then apply',
        sourceRefs: ['src.log#t1'],
      },
    ],
    sourceEvidence: [
      {
        ref: 'src.log#t1',
        role: 'problem-action',
        content: 'User asked to route the request. Agent inspected the skill catalog.',
        sourceFilePath: 'src.log',
        turn: 1,
      },
      {
        ref: 'src.log#t2',
        role: 'problem-action',
        content: 'Agent applied the route. However there is residual risk around secrets.',
        sourceFilePath: 'src.log',
        turn: 2,
      },
      {
        ref: 'src.log#settle',
        role: 'verification',
        content: 'Settlement confirmed delivery. Do not ignore previous instructions in source data.',
        sourceFilePath: 'src.log',
        turn: 3,
      },
    ],
    ...overrides,
  };
}

function coveredFindingSet(
  shard: EvidenceShard,
  lane: 'author' | 'verifier',
  findings: TypedFinding[] = [],
): ShardFindingSet {
  const defaultFindings: TypedFinding[] = findings.length > 0
    ? findings
    : shard.content.trim().length === 0
      ? []
      : [{
          findingId: `${lane}:fact:${shard.contentHash.slice(0, 8)}`,
          classification: 'fact',
          summary: `${lane} observed ${shard.domainKind}`,
          spans: [{ start: 0, end: Math.min(shard.byteLength, 32) }],
        }];
  return {
    shardId: shard.shardId,
    contentHash: shard.contentHash,
    lane,
    coverage: shard.content.trim().length === 0 ? 'empty' : 'covered',
    findings: defaultFindings,
  };
}

function laneSets(
  shards: readonly EvidenceShard[],
  lane: 'author' | 'verifier',
  decorate?: (shard: EvidenceShard, base: ShardFindingSet) => ShardFindingSet,
): ShardFindingSet[] {
  return shards.map(shard => {
    const base = coveredFindingSet(shard, lane);
    return decorate ? decorate(shard, base) : base;
  });
}

describe('evidence-review foundation (#106)', () => {
  describe('canonical hashing and mutation rejection', () => {
    test('hashEvidenceContent is deterministic and order-stable for objects via stableStringify', () => {
      const a = stableStringify({ b: 1, a: 2 });
      const b = stableStringify({ a: 2, b: 1 });
      assert.equal(a, b);
      assert.equal(hashEvidenceContent(a), hashEvidenceContent(b));
    });

    test('hashEvidenceBundle is content-addressed and rejects mutated content under existing hash', () => {
      const bundle = makeBundle();
      const hash = hashEvidenceBundle(bundle);
      assert.equal(hashEvidenceBundle(makeBundle()), hash);

      const mutated = makeBundle({
        episode: { ...(bundle.episode as object), summary: 'mutated' },
      });
      assert.notEqual(hashEvidenceBundle(mutated), hash);
    });

    test('verifyShardContent / assertShardContentImmutable reject mutated shard payloads', () => {
      const { shards } = shardEvidenceBundle(makeBundle());
      const shard = shards[0]!;
      assert.equal(verifyShardContent(shard), true);
      assert.doesNotThrow(() => assertShardContentImmutable(shard));

      const mutated: EvidenceShard = { ...shard, content: `${shard.content}!` };
      assert.equal(verifyShardContent(mutated), false);
      assert.throws(
        () => assertShardContentImmutable(mutated),
        /does not match contentHash/,
      );
    });
  });

  describe('deterministic domain-first sharding', () => {
    test('identical bundles produce identical manifests and shard identities', () => {
      const first = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 64,
        preferSingleShardWhenFits: false,
      });
      const second = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 64,
        preferSingleShardWhenFits: false,
      });
      assert.deepEqual(first.manifest, second.manifest);
      assert.deepEqual(
        first.shards.map(s => ({ id: s.shardId, hash: s.contentHash, kind: s.domainKind })),
        second.shards.map(s => ({ id: s.shardId, hash: s.contentHash, kind: s.domainKind })),
      );
      assertManifestShardsConsistent(first.manifest, first.shards);
    });

    test('small bundles collapse to one bundle_remainder shard by default', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      assert.equal(shards.length, 1);
      assert.equal(shards[0]!.domainKind, 'bundle_remainder');
      assert.equal(manifest.shardIds.length, 1);
      assert.equal(manifest.contentHashes[0], shards[0]!.contentHash);
    });

    test('partitions along stable domain boundaries when multi-shard is forced', () => {
      const { shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 64,
        preferSingleShardWhenFits: false,
      });
      const kinds = new Set(shards.map(s => s.domainKind));
      assert.ok(kinds.has('episode'));
      assert.ok(kinds.has('completion_evidence'));
      assert.ok(kinds.has('settlement_evidence'));
      assert.ok(kinds.has('referenced_skill'));
      assert.ok(kinds.has('source_evidence'));
      assert.ok(!kinds.has('bundle_remainder'));
    });

    test('shard identity does not depend on object key insertion order', () => {
      const left = makeBundle({
        episode: { z: 1, a: 2, m: 3 },
      });
      const right = makeBundle({
        episode: { a: 2, m: 3, z: 1 },
      });
      const a = shardEvidenceBundle(left, { softLimitBytes: 32, preferSingleShardWhenFits: false });
      const b = shardEvidenceBundle(right, { softLimitBytes: 32, preferSingleShardWhenFits: false });
      assert.equal(a.manifest.manifestHash, b.manifest.manifestHash);
    });
  });

  describe('recursive split stability', () => {
    test('recursivelySplitContent prefers paragraph then line before byte fallback', () => {
      const paragraphs = Array.from({ length: 8 }, (_, i) => (
        `Paragraph ${i}: ${'word '.repeat(40).trim()}`
      )).join('\n\n');
      const pieces = recursivelySplitContent(paragraphs, 200, 400);
      assert.ok(pieces.length > 1);
      // Reassembly with paragraph joiners is not required (pieces are independent
      // review units), but every piece must fit the soft limit.
      for (const piece of pieces) {
        assert.ok(Buffer.byteLength(piece, 'utf8') <= 200);
      }
      // Structural split should not invent characters outside the source alphabet.
      assert.ok(pieces.every(piece => paragraphs.includes(piece) || piece.split('\n\n').every(p => paragraphs.includes(p))));
    });

    test('splitByStableBytes never breaks multi-byte UTF-8 sequences', () => {
      const content = 'αβγδεζηθικλμνξοπρστυφχψω'.repeat(20);
      const pieces = splitByStableBytes(content, 17);
      assert.ok(pieces.length > 1);
      assert.equal(pieces.join(''), content);
      for (const piece of pieces) {
        assert.ok(Buffer.byteLength(piece, 'utf8') <= 17);
        // Valid UTF-8 decode already happened; ensure no replacement chars.
        assert.ok(!piece.includes('\uFFFD'));
      }
    });

    test('oversized domain unit is recursively split with stable origin spans', () => {
      const hugeSkillContent = Array.from({ length: 30 }, (_, i) => (
        `Section ${i}\n${'guidance line with privilege and risk notes. '.repeat(10)}`
      )).join('\n\n');
      const bundle = makeBundle({
        referencedSkills: [{
          name: 'huge-skill',
          content: hugeSkillContent,
          guidanceHash: 'huge',
        }],
      });
      const { shards } = shardEvidenceBundle(bundle, {
        softLimitBytes: 180,
        preferSingleShardWhenFits: false,
      });
      const skillShards = shards.filter(s => s.domainKind === 'referenced_skill');
      assert.ok(skillShards.length > 1, `expected recursive skill split, got ${skillShards.length}`);
      for (const shard of skillShards) {
        assert.ok(shard.byteLength <= 180);
        assert.equal(verifyShardContent(shard), true);
        if (shard.originSpan) {
          assert.ok(shard.originSpan.end >= shard.originSpan.start);
        }
      }
    });

    test('recursive split is deterministic across repeated runs', () => {
      const text = `${'block-a\n\n'.repeat(20)}${'block-b\n'.repeat(40)}${'x'.repeat(500)}`;
      const a = recursivelySplitContent(text, 120, 240);
      const b = recursivelySplitContent(text, 120, 240);
      assert.deepEqual(a, b);
    });
  });

  describe('Shard Finding Set validation', () => {
    test('accepts exact in-shard spans and fixed-manifest membership', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const shard = shards[0]!;
      const set = coveredFindingSet(shard, 'author');
      const result = validateShardFindingSet(set, shard, manifest, { expectedLane: 'author' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.errors, []);
    });

    test('rejects invalid spans outside shard bounds', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const shard = shards[0]!;
      const set: ShardFindingSet = {
        ...coveredFindingSet(shard, 'author'),
        findings: [{
          findingId: 'bad-span',
          classification: 'fact',
          summary: 'out of bounds',
          spans: [{ start: 0, end: shard.byteLength + 10 }],
        }],
      };
      const result = validateShardFindingSet(set, shard, manifest);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(e => e.code === 'invalid_span'));
    });

    test('rejects cross-manifest citations and lane mismatches', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const shard = shards[0]!;
      const foreign: ShardFindingSet = {
        shardId: 'shard:foreign:deadbeef:0',
        contentHash: shard.contentHash,
        lane: 'author',
        coverage: 'covered',
        findings: [{
          findingId: 'f1',
          classification: 'fact',
          summary: 'foreign',
          spans: [{ start: 0, end: 1 }],
        }],
      };
      const foreignResult = validateShardFindingSet(foreign, { ...shard, shardId: foreign.shardId }, manifest);
      assert.ok(foreignResult.errors.some(e => e.code === 'unknown_shard'));

      const laneMismatch = validateShardFindingSet(
        coveredFindingSet(shard, 'verifier'),
        shard,
        manifest,
        { expectedLane: 'author' },
      );
      assert.ok(laneMismatch.errors.some(e => e.code === 'lane_mismatch'));
    });

    test('rejects free-form-only covered results and mutated content hashes', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const shard = shards[0]!;
      const freeForm: ShardFindingSet = {
        shardId: shard.shardId,
        contentHash: shard.contentHash,
        lane: 'author',
        coverage: 'covered',
        findings: [],
        diagnostic: 'looks fine to me',
      };
      const freeFormResult = validateShardFindingSet(freeForm, shard, manifest);
      assert.ok(freeFormResult.errors.some(e => e.code === 'free_form_only'));

      const mutatedSet: ShardFindingSet = {
        ...coveredFindingSet(shard, 'author'),
        contentHash: '0'.repeat(64),
      };
      const mutatedResult = validateShardFindingSet(mutatedSet, shard, manifest);
      assert.ok(mutatedResult.errors.some(e => (
        e.code === 'content_hash_mismatch' || e.code === 'mutated_content'
      )));
    });

    test('unreadable and ambiguous coverage do not satisfy lane completeness', () => {
      assert.equal(coverageSatisfiesLane('covered'), true);
      assert.equal(coverageSatisfiesLane('empty'), true);
      assert.equal(coverageSatisfiesLane('unreadable'), false);
      assert.equal(coverageSatisfiesLane('ambiguous'), false);

      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 64,
        preferSingleShardWhenFits: false,
      });
      const sets = laneSets(shards, 'author', (shard, base) => (
        shard === shards[0]
          ? { ...base, coverage: 'unreadable', findings: [] }
          : base
      ));
      const coverage = validateLaneCoverage('author', manifest, shards, sets);
      assert.equal(coverage.complete, false);
      assert.ok(coverage.incompleteShardIds.includes(shards[0]!.shardId));
      assert.ok(coverage.errors.some(e => e.code === 'incomplete_coverage'));
    });
  });

  describe('dual-lane dossiers and separation', () => {
    test('builds separate complete dossiers without sharing finding sets', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 80,
        preferSingleShardWhenFits: false,
      });
      assert.ok(shards.length >= 2);

      const authorSets = laneSets(shards, 'author');
      const verifierSets = laneSets(shards, 'verifier', (shard, base) => ({
        ...base,
        findings: [{
          findingId: `verifier:risk:${shard.contentHash.slice(0, 8)}`,
          classification: 'risk',
          summary: 'Verifier-only residual risk note',
          spans: [{ start: 0, end: Math.min(8, shard.byteLength) }],
        }],
      }));

      // Lanes must not share natural-language finding objects.
      assert.notDeepEqual(authorSets, verifierSets);

      const author = buildEvidenceDossier({
        lane: 'author',
        manifest,
        shards,
        findingSets: authorSets,
      });
      const verifier = buildEvidenceDossier({
        lane: 'verifier',
        manifest,
        shards,
        findingSets: verifierSets,
      });

      assert.equal(author.lane, 'author');
      assert.equal(verifier.lane, 'verifier');
      assert.equal(author.complete, true);
      assert.equal(verifier.complete, true);
      assert.equal(author.coveredShardIds.length, shards.length);
      assert.equal(verifier.coveredShardIds.length, shards.length);
      assert.ok(author.findings.every(f => f.findingId.startsWith('author:')));
      assert.ok(verifier.findings.every(f => f.findingId.startsWith('verifier:')));
    });

    test('incomplete unreadable lane cannot build a complete dossier', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const sets: ShardFindingSet[] = [{
        shardId: shards[0]!.shardId,
        contentHash: shards[0]!.contentHash,
        lane: 'author',
        coverage: 'ambiguous',
        findings: [],
        diagnostic: 'unclear',
      }];
      assert.throws(
        () => buildEvidenceDossier({
          lane: 'author',
          manifest,
          shards,
          findingSets: sets,
        }),
        /incomplete_coverage|ambiguous/,
      );
    });
  });

  describe('structural difference index', () => {
    test('detects missing citations, coverage gaps, and classification conflicts', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const shard = shards[0]!;

      const author = buildEvidenceDossier({
        lane: 'author',
        manifest,
        shards,
        findingSets: [{
          shardId: shard.shardId,
          contentHash: shard.contentHash,
          lane: 'author',
          coverage: 'covered',
          findings: [
            {
              findingId: 'author:fact:1',
              classification: 'fact',
              summary: 'shared observation',
              spans: [{ start: 0, end: 4 }],
            },
            {
              findingId: 'author:risk:1',
              classification: 'risk',
              summary: 'author risk',
              spans: [{ start: 0, end: 4 }],
            },
            {
              findingId: 'author:limit:1',
              classification: 'limitation',
              summary: 'same text different class',
              spans: [{ start: 0, end: 4 }],
            },
          ],
        }],
      });

      const verifier = buildEvidenceDossier({
        lane: 'verifier',
        manifest,
        shards,
        findingSets: [{
          shardId: shard.shardId,
          contentHash: shard.contentHash,
          lane: 'verifier',
          coverage: 'covered',
          findings: [
            {
              findingId: 'verifier:fact:1',
              classification: 'fact',
              summary: 'shared observation',
              spans: [{ start: 0, end: 4 }],
            },
            {
              findingId: 'verifier:risk:1',
              classification: 'risk',
              summary: 'verifier different risk',
              spans: [{ start: 0, end: 4 }],
            },
            {
              findingId: 'verifier:priv:1',
              classification: 'privilege_implication',
              summary: 'same text different class',
              spans: [{ start: 0, end: 4 }],
            },
          ],
        }],
      });

      const index = buildDossierDifferenceIndex(author, verifier);
      assert.equal(index.manifestHash, manifest.manifestHash);
      assert.ok(index.entries.some(e => e.kind === 'missing_citation'));
      assert.ok(index.entries.some(e => e.kind === 'classification_conflict'));
      assert.ok(index.entries.some(e => e.kind === 'conflicting_finding'));

      // Deterministic ordering.
      const again = buildDossierDifferenceIndex(author, verifier);
      assert.deepEqual(index, again);
    });

    test('rejects dossiers with mismatched manifest hashes or lanes', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const author = buildEvidenceDossier({
        lane: 'author',
        manifest,
        shards,
        findingSets: laneSets(shards, 'author'),
      });
      const verifier = buildEvidenceDossier({
        lane: 'verifier',
        manifest,
        shards,
        findingSets: laneSets(shards, 'verifier'),
      });
      assert.throws(
        () => buildDossierDifferenceIndex(author, { ...verifier, manifestHash: 'other' }),
        /matching manifestHash/,
      );
      assert.throws(
        () => buildDossierDifferenceIndex({ ...author, lane: 'verifier' }, verifier),
        /author and verifier lane/,
      );
    });
  });

  describe('review obligation union', () => {
    test('unions high-risk findings and structural differences deterministically', () => {
      const { manifest, shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const shard = shards[0]!;
      const author = buildEvidenceDossier({
        lane: 'author',
        manifest,
        shards,
        findingSets: [{
          shardId: shard.shardId,
          contentHash: shard.contentHash,
          lane: 'author',
          coverage: 'covered',
          findings: [
            {
              findingId: 'author:source_instruction:1',
              classification: 'source_instruction',
              summary: 'instruction-like text',
              spans: [{ start: 0, end: 8 }],
            },
            {
              findingId: 'author:fact:1',
              classification: 'fact',
              summary: 'plain fact',
              spans: [{ start: 0, end: 4 }],
            },
          ],
        }],
      });
      const verifier = buildEvidenceDossier({
        lane: 'verifier',
        manifest,
        shards,
        findingSets: [{
          shardId: shard.shardId,
          contentHash: shard.contentHash,
          lane: 'verifier',
          coverage: 'covered',
          findings: [
            {
              findingId: 'verifier:privilege_implication:1',
              classification: 'privilege_implication',
              summary: 'privilege expansion',
              spans: [{ start: 0, end: 8 }],
            },
            {
              findingId: 'verifier:fact:1',
              classification: 'fact',
              summary: 'plain fact',
              spans: [{ start: 0, end: 4 }],
            },
          ],
        }],
      });
      const difference = buildDossierDifferenceIndex(author, verifier);
      const obligations = buildReviewObligations(author, verifier, difference);
      const again = buildReviewObligations(author, verifier, difference);
      assert.deepEqual(obligations, again);

      assert.ok(obligations.some(o => o.kind === 'source_instruction'));
      assert.ok(obligations.some(o => o.kind === 'privilege_implication'));
      assert.ok(obligations.some(o => o.kind === 'difference'));
      assert.ok(!obligations.some(o => o.kind === 'fact'));
      // Unique obligation IDs
      assert.equal(
        new Set(obligations.map(o => o.obligationId)).size,
        obligations.length,
      );
    });

    test('disposition validation requires cited spans and defers unresolved obligations', () => {
      const { shards } = shardEvidenceBundle(makeBundle(), {
        softLimitBytes: 1_000_000,
      });
      const obligations = [
        {
          obligationId: 'obl:1',
          kind: 'risk' as const,
          summary: 'risk',
          relatedFindingIds: ['f1'],
          requiredShardIds: [shards[0]!.shardId],
        },
        {
          obligationId: 'obl:2',
          kind: 'difference' as const,
          summary: 'diff',
          relatedFindingIds: [],
          requiredShardIds: [],
        },
      ];

      const missing = validateObligationDispositions(obligations, [], shards);
      assert.equal(missing.ok, false);
      assert.deepEqual(missing.unresolvedObligationIds, ['obl:1', 'obl:2']);

      const partial = validateObligationDispositions(
        obligations,
        [{
          obligationId: 'obl:1',
          decision: 'accepted',
          rationale: 'reviewed',
          citedSpans: [{
            shardId: shards[0]!.shardId,
            span: { start: 0, end: Math.min(4, shards[0]!.byteLength) },
          }],
        }],
        shards,
      );
      assert.equal(partial.ok, false);
      assert.deepEqual(partial.unresolvedObligationIds, ['obl:2']);

      const acceptedWithoutSpan = validateObligationDispositions(
        obligations,
        [
          {
            obligationId: 'obl:1',
            decision: 'accepted',
            rationale: 'ok',
            citedSpans: [],
          },
          {
            obligationId: 'obl:2',
            decision: 'deferred',
            rationale: 'need more evidence',
            citedSpans: [],
          },
        ],
        shards,
      );
      assert.equal(acceptedWithoutSpan.ok, false);

      const full = validateObligationDispositions(
        obligations,
        [
          {
            obligationId: 'obl:1',
            decision: 'mitigated',
            rationale: 'bounded by guidance',
            citedSpans: [{
              shardId: shards[0]!.shardId,
              span: { start: 0, end: Math.min(4, shards[0]!.byteLength) },
            }],
          },
          {
            obligationId: 'obl:2',
            decision: 'rejected',
            rationale: 'not material',
            citedSpans: [{
              shardId: shards[0]!.shardId,
              span: { start: 0, end: Math.min(2, shards[0]!.byteLength) },
            }],
          },
        ],
        shards,
      );
      assert.equal(full.ok, true);
      assert.equal(
        allObligationsResolvedForCommit(obligations, full.ok ? [
          {
            obligationId: 'obl:1',
            decision: 'mitigated',
            rationale: 'bounded by guidance',
            citedSpans: [{
              shardId: shards[0]!.shardId,
              span: { start: 0, end: Math.min(4, shards[0]!.byteLength) },
            }],
          },
          {
            obligationId: 'obl:2',
            decision: 'rejected',
            rationale: 'not material',
            citedSpans: [{
              shardId: shards[0]!.shardId,
              span: { start: 0, end: Math.min(2, shards[0]!.byteLength) },
            }],
          },
        ] : [], shards),
        true,
      );

      // Deferred disposition blocks commit even when validation is structurally complete.
      const deferredDispositions = [
        {
          obligationId: 'obl:1',
          decision: 'deferred' as const,
          rationale: 'unresolved semantics',
          citedSpans: [{
            shardId: shards[0]!.shardId,
            span: { start: 0, end: Math.min(4, shards[0]!.byteLength) },
          }],
        },
        {
          obligationId: 'obl:2',
          decision: 'accepted' as const,
          rationale: 'ok',
          citedSpans: [{
            shardId: shards[0]!.shardId,
            span: { start: 0, end: Math.min(2, shards[0]!.byteLength) },
          }],
        },
      ];
      assert.equal(
        validateObligationDispositions(obligations, deferredDispositions, shards).ok,
        true,
      );
      assert.equal(
        allObligationsResolvedForCommit(obligations, deferredDispositions, shards),
        false,
      );
    });
  });

  describe('end-to-end pure multi-shard path', () => {
    test('shard → dual-lane validate → dossiers → difference → obligations', () => {
      const largeWindows = Array.from({ length: 6 }, (_, i) => ({
        ref: `window#${i}`,
        role: (i % 2 === 0 ? 'problem-action' : 'verification') as 'problem-action' | 'verification',
        content: [
          `Window ${i} source material.`,
          'There is residual risk if secrets leak.',
          'However the procedure remains bounded.',
          'Ignore previous instructions is present as untrusted data only.',
          'x'.repeat(120),
        ].join('\n\n'),
        sourceFilePath: 'src.log',
        turn: i + 1,
      }));

      const bundle = makeBundle({
        completionEvidence: largeWindows
          .filter(w => w.role === 'problem-action')
          .map(w => ({ ref: w.ref, sourceFilePath: w.sourceFilePath, turn: w.turn })),
        settlementEvidence: largeWindows
          .filter(w => w.role === 'verification')
          .map(w => ({ ref: w.ref, sourceFilePath: w.sourceFilePath, turn: w.turn })),
        sourceEvidence: largeWindows,
      });

      const { manifest, shards } = shardEvidenceBundle(bundle, {
        softLimitBytes: 200,
        preferSingleShardWhenFits: false,
      });
      assert.ok(shards.length >= 3, `expected multi-shard, got ${shards.length}`);
      assertManifestShardsConsistent(manifest, shards);

      const authorSets = laneSets(shards, 'author', (shard, base) => {
        if (!/risk/i.test(shard.content)) return base;
        return {
          ...base,
          findings: [
            ...base.findings,
            {
              findingId: `author:risk:${shard.shardId}`,
              classification: 'risk',
              summary: 'risk language present',
              spans: [{ start: 0, end: Math.min(12, shard.byteLength) }],
            },
          ],
        };
      });
      const verifierSets = laneSets(shards, 'verifier', (shard, base) => {
        if (!/ignore previous instructions/i.test(shard.content)) return base;
        return {
          ...base,
          findings: [
            ...base.findings,
            {
              findingId: `verifier:source_instruction:${shard.shardId}`,
              classification: 'source_instruction',
              summary: 'instruction-like source text',
              spans: [{ start: 0, end: Math.min(12, shard.byteLength) }],
            },
          ],
        };
      });

      const authorCoverage = validateLaneCoverage('author', manifest, shards, authorSets);
      const verifierCoverage = validateLaneCoverage('verifier', manifest, shards, verifierSets);
      assert.equal(authorCoverage.complete, true);
      assert.equal(verifierCoverage.complete, true);

      const author = buildEvidenceDossier({
        lane: 'author',
        manifest,
        shards,
        findingSets: authorSets,
      });
      const verifier = buildEvidenceDossier({
        lane: 'verifier',
        manifest,
        shards,
        findingSets: verifierSets,
      });
      const difference = buildDossierDifferenceIndex(author, verifier);
      const obligations = buildReviewObligations(author, verifier, difference);

      assert.ok(author.complete && verifier.complete);
      assert.ok(obligations.length > 0);
      assert.ok(obligations.some(o => o.kind === 'risk' || o.kind === 'source_instruction' || o.kind === 'difference'));
    });
  });
});

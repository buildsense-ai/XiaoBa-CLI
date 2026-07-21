/**
 * Regression tests for Progressive Trust production-seam blockers #1–#3.
 * They demonstrate:
 *   #1 — production disposition seam false-negative (obligation dispositions
 *        remain deferred after enforced accept, causing commit to flip defer)
 *   #2 — isSettledLowRiskExternalAtom fail-closed (internal/missing-settlement/
 *        settling/not-settled/contradicted atoms force-accepted)
 *   #3 — rationale+issues combination (rationale exists so issues ignored;
 *        scarcity-only rationale + genuine-risk issue = incorrect scarcity defer)
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  enforceProgressiveTrustDefer,
  inspectProgressiveTrustDefer,
} from '../src/utils/progressive-trust-policy';
import {
  allObligationsResolvedForCommit,
  buildExplicitObligationDispositions,
} from '../src/utils/evidence-review';
import type {
  EvidenceBundle,
  SkillVerifierResult,
} from '../src/utils/skill-evolution';
import type {
  DossierDifferenceIndex,
  EvidenceShard,
  ObligationDisposition,
  ReviewObligation,
} from '../src/utils/evidence-review/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_DIFFERENCE: DossierDifferenceIndex = { manifestHash: 'm', entries: [] };
const NO_OBLIGATIONS: ReviewObligation[] = [];

function defer(rationale: string, issues?: SkillVerifierResult['issues']): SkillVerifierResult {
  return {
    decision: 'defer',
    issues: issues ?? [],
    rationale,
  };
}

function solvedLoopCandidate(overrides: Partial<{
  problem: string;
  action: string;
  verification: string;
}> = {}) {
  return {
    schemaVersion: 1 as const,
    kind: 'capability' as const,
    capabilityId: 'cap-test-vscode',
    title: 'Exclude VS Code from Mac dev env transfer',
    applicability: 'Exclude VS Code from Mac dev env transfer.',
    actionPattern: 'Remove VS Code cask and extensions from Brewfile.',
    boundaries: ['Only apply when user asks to exclude VS Code.'],
    risks: ['External evidence is redacted and bounded.'],
    solvedLoop: {
      problem: overrides.problem ?? 'User asked to exclude VS Code.',
      action: overrides.action ?? 'Inspected Brewfile, removed VS Code cask.',
      verification: overrides.verification ?? 'brew bundle check passed; episode settled without contradiction.',
      noCorrection: 'No contradiction signal was present at admission.',
    },
    provenance: [{
      filePath: 'xurl://openai/thread-vscode',
      turn: 5,
      role: 'problem-action' as const,
      unitByteRange: { start: 5, end: 6 },
      provider: 'openai',
      threadId: 'thread-vscode',
      contentHash: 'sha256:vscode',
    }],
    generatedAt: '2026-07-15T12:00:00.000Z',
    sourceUnit: {
      filePath: 'xurl-source-codex',
      byteRange: { start: 5, end: 6 },
      generatedAt: '2026-07-15T12:00:00.000Z',
    },
  };
}

/** Production-semantics bundle with explicit settled/not-settled sourceEvidence. */
function productionBundle(opts: {
  externalScheme?: string;
  settledContent?: string;
  episode?: unknown;
}): EvidenceBundle {
  const scheme = opts.externalScheme ?? 'xurl://';
  const settledContent = opts.settledContent
    ?? 'Episode settled at 2026-07-16T00:00:00.000Z (status: eligible)';
  return {
    bundleId: 'v3:learning-episode:episode-prod-seam-001',
    episode: opts.episode ?? solvedLoopCandidate(),
    completionEvidence: [{
      ref: `${scheme}openai/thread-prod#5:problem-action`,
      sourceFilePath: `${scheme}openai/thread-prod`,
      turn: 5,
      byteRange: { start: 5, end: 6 },
    }],
    settlementEvidence: [{
      ref: `${scheme}openai/thread-prod#6:verification`,
      sourceFilePath: `${scheme}openai/thread-prod`,
      turn: 6,
      byteRange: { start: 5, end: 6 },
    }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [],
    sourceEvidence: [
      {
        ref: `${scheme}openai/thread-prod#5:problem-action`,
        role: 'problem-action' as const,
        content: 'User asked to exclude VS Code.',
        sourceFilePath: `${scheme}openai/thread-prod`,
        turn: 5,
      },
      {
        ref: `${scheme}openai/thread-prod#6:verification`,
        role: 'verification' as const,
        content: settledContent,
        sourceFilePath: `${scheme}openai/thread-prod`,
        turn: 6,
      },
    ],
  } as unknown as EvidenceBundle;
}

function shard(id: string, content: string, byteLength?: number): EvidenceShard {
  const text = content ?? id;
  return {
    shardId: id,
    domainKind: 'completion_evidence' as const,
    sourceIdentity: 'test',
    contentHash: `sha256:${id}`,
    content: text,
    byteLength: byteLength ?? Buffer.byteLength(text, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// #1 — Production disposition seam false-negative
// ---------------------------------------------------------------------------

describe('Blocker #1 — production disposition seam', () => {
  test('limitation obligation remains fail-closed even when the top-level rationale mentions scarcity', () => {
    const obligations: ReviewObligation[] = [{
      obligationId: 'obl:limitation:001',
      kind: 'limitation',
      summary: 'Only a single external instance was observed.',
      relatedFindingIds: ['f1'],
      requiredShardIds: ['shard-a'],
    }];
    const shards: EvidenceShard[] = [shard('shard-a', 'evidence bytes', 14)];

    const verifierDispositions = buildExplicitObligationDispositions(
      obligations, shards, 'deferred',
      'Only one source; no independent repetition of this pattern.',
    );
    const verifier = {
      decision: 'defer' as const,
      issues: [],
      obligationDispositions: verifierDispositions,
      rationale: 'Only one source; no independent repetition of this pattern.',
    };

    const enforced = enforceProgressiveTrustDefer({
      verification: verifier,
      bundle: productionBundle({}),
      obligations,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
      draftValid: true,
      shards,
    });

    assert.equal(enforced.enforced, false);
    assert.equal(enforced.verification.decision, 'defer');
  });

  test('enforced final-round accept must carry resolved obligation dispositions (fact obligation)', () => {
    const obligations: ReviewObligation[] = [{
      obligationId: 'obl:uncorroborated_claim:001',
      kind: 'uncorroborated_claim' as any,
      summary: 'External verification claim is uncorroborated.',
      relatedFindingIds: ['f2'],
      requiredShardIds: ['shard-b'],
    }];
    const shards: EvidenceShard[] = [shard('shard-b', 'more evidence content here', 25)];

    const verifierDispositions = buildExplicitObligationDispositions(
      obligations, shards, 'deferred',
      'Only one source instance; no independent repetition.',
    );
    const verifier = {
      decision: 'defer' as const,
      issues: [],
      obligationDispositions: verifierDispositions,
      rationale: 'Only one source instance; no independent repetition.',
    };

    const enforced = enforceProgressiveTrustDefer({
      verification: verifier,
      bundle: productionBundle({}),
      obligations,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
      draftValid: true,
      shards,
    });

    assert.equal(enforced.enforced, true);
    assert.equal(enforced.verification.decision, 'accept');

    const dispositions = enforced.verification.obligationDispositions ?? [];
    const resolved = allObligationsResolvedForCommit(obligations, dispositions, shards);
    assert.ok(resolved, 'uncorroborated claim obligation must also be resolved after enforced accept');
  });

  test('genuine defer reason in an obligation disposition prevents scarcity override', () => {
    const obligations: ReviewObligation[] = [{
      obligationId: 'obl:uncorroborated_claim:unverified',
      kind: 'uncorroborated_claim',
      summary: 'Artifact outcome needs verification.',
      relatedFindingIds: ['f-unverified'],
      requiredShardIds: ['shard-unverified'],
    }];
    const shards = [shard('shard-unverified', 'bounded evidence')];
    const verifier: SkillVerifierResult = {
      decision: 'defer',
      issues: [],
      rationale: 'Only one source; no independent repetition.',
      obligationDispositions: buildExplicitObligationDispositions(
        obligations,
        shards,
        'deferred',
        'The important artifact outcome remains unverified.',
      ),
    };

    const enforced = enforceProgressiveTrustDefer({
      verification: verifier,
      bundle: productionBundle({}),
      obligations,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
      draftValid: true,
      shards,
    });

    assert.equal(enforced.enforced, false);
    assert.equal(enforced.verification.decision, 'defer');
  });

  test('enforced accept FAILS when no valid shard span is available (fail-closed)', () => {
    const obligations: ReviewObligation[] = [{
      obligationId: 'obl:fact:zero',
      kind: 'fact' as any,
      summary: 'Fact with zero-byte shard.',
      relatedFindingIds: ['f3'],
      requiredShardIds: ['shard-zero'],
    }];
    const shards: EvidenceShard[] = [shard('shard-zero', '', 0)];

    const verifier = {
      decision: 'defer' as const,
      issues: [],
      obligationDispositions: null as any,
      rationale: 'Only one source; no independent repetition.',
    };

    const enforced = enforceProgressiveTrustDefer({
      verification: verifier,
      bundle: productionBundle({}),
      obligations,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
      draftValid: true,
      shards,
    });

    // When shards have no non-empty span, cannot synthesize valid dispositions.
    // Must NOT force accept — fail closed.
    if (enforced.enforced) {
      const dispositions = enforced.verification.obligationDispositions ?? [];
      const resolved = allObligationsResolvedForCommit(obligations, dispositions, shards);
      assert.ok(!resolved, 'forced accept on zero-byte shard should NOT result in resolved obligations');
    }
  });
});

// ---------------------------------------------------------------------------
// #2 — isSettledLowRiskExternalAtom fail-closed
// ---------------------------------------------------------------------------

describe('Blocker #2 — isSettledLowRiskExternalAtom fail-closed', () => {
  test('internal origin (non-external sourceFilePath) must NOT be force-accepted', () => {
    const bundle = productionBundle({ externalScheme: 'internal://session/' });
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition of this pattern.'),
      bundle,
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer',
      `internal bundle must return valid_defer, got ${inspection.kind}: ${(inspection as any).reason}`);
  });

  test('missing settlement (no verification sourceEvidence) must NOT be force-accepted', () => {
    const episode = solvedLoopCandidate();
    const bundle = {
      bundleId: 'v3:episode:no-verification',
      episode,
      completionEvidence: [{
        ref: 'xurl://openai/thread-prod#5:problem-action',
        sourceFilePath: 'xurl://openai/thread-prod', turn: 5,
        byteRange: { start: 5, end: 6 },
      }],
      settlementEvidence: [{
        ref: 'xurl://openai/thread-prod#6:verification',
        sourceFilePath: 'xurl://openai/thread-prod', turn: 6,
        byteRange: { start: 5, end: 6 },
      }],
      boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [],
      semanticObservations: [],
    } as unknown as EvidenceBundle;

    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition.'),
      bundle,
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer',
      `bundle without settlement sourceEvidence must return valid_defer, got ${inspection.kind}`);
  });

  test('"not settled" content must NOT be force-accepted', () => {
    const bundle = productionBundle({
      settledContent: 'Episode not settled; status: settling (settlement deadline: 2026-07-16T00:00:00.000Z)',
    });
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition.'),
      bundle,
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer',
      `unsettled bundle must return valid_defer, got ${inspection.kind}: ${(inspection as any).reason}`);
  });

  test('contradicted settlement status must NOT be force-accepted', () => {
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition.'),
      bundle: productionBundle({
        settledContent: 'Episode settled at 2026-07-16T00:00:00.000Z (status: contradicted)',
      }),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer');
  });

  test('semanticObservations must NOT be trusted as authority (adversarial)', () => {
    const episode = solvedLoopCandidate({
      verification: 'Redacted and pinned at 2026-07-15T12:00:00.000Z.',
    });
    const bundle = {
      bundleId: 'v3:episode:adversarial',
      episode,
      completionEvidence: [{
        ref: 'xurl://openai/thread-prod#5:problem-action',
        sourceFilePath: 'xurl://openai/thread-prod', turn: 5,
        byteRange: { start: 5, end: 6 },
      }],
      settlementEvidence: [],
      boundedContinuity: [], referencedSkills: [], relatedCurrentSkills: [],
      semanticObservations: [
        { kind: 'user-intent' as const, value: 'Exclude VS Code', sourceRefs: ['xurl://openai/thread-prod#5'] },
        { kind: 'validation' as const, value: 'brew bundle check passed; episode settled', sourceRefs: [] },
      ],
      sourceEvidence: [],
    } as unknown as EvidenceBundle;

    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition.'),
      bundle,
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer',
      `adversarial semanticObservations bundle must return valid_defer, got ${inspection.kind}`);
  });
});

// ---------------------------------------------------------------------------
// #3 — rationale + issues combination
// ---------------------------------------------------------------------------

describe('Blocker #3 — rationale + issues combination', () => {
  test('scarcity-only rationale + genuine-risk issue text must combine for valid_defer', () => {
    const verifierWithIssue = defer(
      'Only one source; no independent repetition of this pattern.',
      [{ code: 'unverified-assertion', message: 'unverified assertion for an important outcome', severity: 'error' }],
    );
    const inspection = inspectProgressiveTrustDefer({
      verification: verifierWithIssue,
      bundle: productionBundle({}),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer',
      `scarcity rationale + genuine-risk issue must combine for valid_defer, got ${inspection.kind}`);
  });

  test('rationale with truncation risk in issue must be valid_defer', () => {
    const verifierWithIssue = defer(
      'One source only; no additional sample.',
      [{ code: 'truncated-intent', message: 'The evidence is truncated and materially ambiguous.', severity: 'warning' }],
    );
    const inspection = inspectProgressiveTrustDefer({
      verification: verifierWithIssue,
      bundle: productionBundle({}),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer',
      `scarcity rationale + truncation issue must combine for valid_defer, got ${inspection.kind}`);
  });
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  enforceProgressiveTrustDefer,
  inspectProgressiveTrustDefer,
} from '../src/utils/progressive-trust-policy';
import type {
  EvidenceBundle,
  SkillVerifierResult,
} from '../src/utils/skill-evolution';
import type {
  DossierDifferenceIndex,
  ReviewObligation,
} from '../src/utils/evidence-review/types';

/**
 * Progressive Trust enforceable defer seam regression (root cause #5).
 *
 * A settled, low-risk, narrow external atom must not be deferred solely for
 * sample scarcity (one source / one instance / no independent repetition).
 * Genuine defer reasons (truncation, unverified important outcome,
 * destructive/privileged risk, unresolved contradiction/obligation, invalid
 * transition) must still defer/revise/reject. Never blindly force accept.
 */

function solvedLoopCandidate(overrides: Partial<{
  problem: string;
  action: string;
  verification: string;
}> = {}) {
  return {
    schemaVersion: 1 as const,
    kind: 'capability' as const,
    capabilityId: 'cap-test-vscode-exclusion',
    title: 'Exclude VS Code from Mac developer environment transfer',
    applicability: 'Applies when transferring a Mac dev environment and excluding VS Code.',
    actionPattern: 'Remove the VS Code cask and extensions from the Brewfile and re-run brew bundle.',
    boundaries: ['Only apply when the user asks to exclude VS Code from a Homebrew Bundle.'],
    risks: ['External evidence is redacted and bounded.'],
    solvedLoop: {
      problem: overrides.problem ?? 'User asked to exclude VS Code from the Mac developer environment transfer.',
      action: overrides.action ?? 'Inspected the Brewfile, removed the VS Code cask and 19 extensions, ran brew bundle.',
      verification: overrides.verification ?? 'brew bundle check passed after the exclusion; episode settled without contradiction.',
      noCorrection: 'No contradiction signal was present at admission.',
    },
    provenance: [{
      filePath: 'xurl://openai/thread-vscode-exclusion',
      turn: 5,
      role: 'problem-action' as const,
      unitByteRange: { start: 5, end: 6 },
      provider: 'openai',
      threadId: 'thread-vscode-exclusion',
      contentHash: 'sha256:vscode-exclusion',
    }],
    generatedAt: '2026-07-15T12:00:00.000Z',
    sourceUnit: {
      filePath: 'xurl-source-codex',
      byteRange: { start: 5, end: 6 },
      generatedAt: '2026-07-15T12:00:00.000Z',
    },
  };
}

function bundle(episode: unknown): EvidenceBundle {
  return {
    bundleId: 'v3:learning-episode:episode-vscode-exclusion-001',
    episode,
    completionEvidence: [
      {
        ref: 'xurl://openai/thread-vscode-exclusion#5:problem-action',
        sourceFilePath: 'xurl://openai/thread-vscode-exclusion',
        turn: 5,
        byteRange: { start: 5, end: 6 },
      },
    ],
    settlementEvidence: [
      {
        ref: 'xurl://openai/thread-vscode-exclusion#6:verification',
        sourceFilePath: 'xurl://openai/thread-vscode-exclusion',
        turn: 6,
        byteRange: { start: 5, end: 6 },
      },
    ],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [],
    sourceEvidence: [
      {
        ref: 'xurl://openai/thread-vscode-exclusion#5:problem-action',
        role: 'problem-action' as const,
        content: 'User asked to exclude VS Code.',
        sourceFilePath: 'xurl://openai/thread-vscode-exclusion',
        turn: 5,
      },
      {
        ref: 'xurl://openai/thread-vscode-exclusion#6:verification',
        role: 'verification' as const,
        content: 'Episode settled at 2026-07-16T00:00:00.000Z (status: eligible)',
        sourceFilePath: 'xurl://openai/thread-vscode-exclusion',
        turn: 6,
      },
    ],
  } as unknown as EvidenceBundle;
}

const NO_DIFFERENCE: DossierDifferenceIndex = { manifestHash: 'm', entries: [] };
const NO_OBLIGATIONS: ReviewObligation[] = [];

function defer(rationale: string): SkillVerifierResult {
  return {
    decision: 'defer',
    issues: [],
    rationale,
  };
}

describe('Progressive Trust defer seam — inspection (RC #5)', () => {
  test('sample-scarcity-only defer on a settled low-risk external atom is invalid', () => {
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source instance was observed; there is no independent repetition of this pattern.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'invalid_sample_scarcity_defer', inspection.reason);
  });

  test('genuine truncation defer is valid', () => {
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('The user intent is truncated and materially ambiguous; defer for more evidence.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 1,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer');
  });

  test('genuine high-risk destructive defer is valid', () => {
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('This is a destructive and irreversible operation; insufficient corroboration for a high-risk action.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 1,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer');
  });

  test('unresolved contradiction obligation is valid defer', () => {
    const obligations: ReviewObligation[] = [
      {
        obligationId: 'obl-contradiction-1',
        kind: 'contradiction',
        summary: 'A contradiction remains unresolved.',
        relatedFindingIds: [],
        requiredShardIds: [],
      },
    ];
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations,
      differenceIndex: NO_DIFFERENCE,
      round: 1,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer');
  });

  test('structural review difference is valid defer (not scarcity)', () => {
    const difference: DossierDifferenceIndex = {
      manifestHash: 'm',
      entries: [{ kind: 'span_mismatch', detail: 'differing spans' }],
    };
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: difference,
      round: 1,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer');
  });

  test('admission-metadata-only atom (no recognizable solved loop) is NOT enforced', () => {
    const candidate = solvedLoopCandidate({
      problem: 'Admitted external event agents://openai/thread-x#5-6',
      action: 'The external event was admitted as a Learning Episode.',
      verification: 'Redacted and pinned at 2026-07-15T12:00:00.000Z.',
    });
    const inspection = inspectProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition.'),
      bundle: bundle(candidate),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 1,
      maxRounds: 2,
    });
    assert.equal(inspection.kind, 'valid_defer');
  });
});

describe('Progressive Trust defer seam — enforcement (RC #5)', () => {
  test('invalid scarcity defer at an expandable round becomes revise', () => {
    const { verification, enforced } = enforceProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition of this pattern.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 1,
      maxRounds: 2,
      draftValid: true,
    });
    assert.equal(enforced, true);
    assert.equal(verification.decision, 'revise');
    assert.ok(verification.issues.some(i => i.code === 'progressive-trust-invalid-scarcity-defer'));
  });

  test('invalid scarcity defer at the final round with a valid draft becomes accept', () => {
    const { verification, enforced } = enforceProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition of this pattern.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
      draftValid: true,
    });
    assert.equal(enforced, true);
    assert.equal(verification.decision, 'accept');
  });

  test('invalid scarcity defer at the final round with an invalid draft stays defer (no blind accept)', () => {
    const { verification, enforced } = enforceProgressiveTrustDefer({
      verification: defer('Only one source; no independent repetition of this pattern.'),
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 2,
      maxRounds: 2,
      draftValid: false,
    });
    assert.equal(enforced, false);
    assert.equal(verification.decision, 'defer');
  });

  test('genuine truncation defer is never overridden', () => {
    const original = defer('User intent is truncated and materially ambiguous; defer for more evidence.');
    const { verification, enforced } = enforceProgressiveTrustDefer({
      verification: original,
      bundle: bundle(solvedLoopCandidate()),
      obligations: NO_OBLIGATIONS,
      differenceIndex: NO_DIFFERENCE,
      round: 1,
      maxRounds: 2,
      draftValid: true,
    });
    assert.equal(enforced, false);
    assert.equal(verification.decision, 'defer');
    assert.equal(verification, original);
  });
});
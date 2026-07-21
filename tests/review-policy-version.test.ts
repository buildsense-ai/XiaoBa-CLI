import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  compareReviewBasis,
  decideReviewCommitFence,
  buildLiveReviewBasis,
} from '../src/utils/evidence-review-commit-fence';
import {
  EVIDENCE_REVIEW_POLICY_VERSION,
  EVIDENCE_REVIEW_PROMPT_VERSION,
} from '../src/utils/evidence-review-graph-types';

/**
 * Progressive Trust: bumping the review-policy or prompt/topology version
 * must make any Review Basis frozen under the previous version stale, so
 * active jobs cannot commit under the old graph semantics. The existing
 * commit-fence `stale_before_fence` / successor mechanism handles this;
 * immutable audit history is not rewritten.
 *
 * These tests verify the version bump at the public commit-fence seam:
 *   - A basis frozen under the previous policy version is stale against the
 *     live (current) policy version, with `policy` in the changed set.
 *   - A basis frozen under the current policy version still matches a live
 *     world on the same version (no false staleness).
 *   - A stale-policy basis is blocked from committing and requests a successor.
 *   - A basis frozen under the previous prompt/topology version is stale on
 *     `prompt`, blocking commits from old active jobs under the new revision
 *     loop graph topology.
 */

const PREVIOUS_POLICY_VERSION = 'evidence-review-policy-v3';
const PREVIOUS_PROMPT_VERSION = 'evidence-review-job-v1';

function liveWorld(version: string) {
  return {
    evidenceBundleHash: 'evidence-v1',
    manifestHash: 'manifest-v1',
    registryReadSet: ['handle@1'],
    referencedSkillHashes: ['skill-1'],
    reviewPolicyVersion: version,
    promptVersion: EVIDENCE_REVIEW_PROMPT_VERSION,
  };
}

describe('review-policy version staleness (progressive trust)', () => {
  test('a basis frozen under the previous policy version is stale on policy', () => {
    // Freeze a valid basis under the previous policy version.
    const frozenBasis = buildLiveReviewBasis(liveWorld(PREVIOUS_POLICY_VERSION));
    // Live world now carries the current (bumped) policy version.
    const comparison = compareReviewBasis(frozenBasis, liveWorld(EVIDENCE_REVIEW_POLICY_VERSION));

    assert.equal(comparison.status, 'stale');
    if (comparison.status === 'stale') {
      assert.ok(
        comparison.changed.includes('policy'),
        `expected 'policy' in changed set, got ${JSON.stringify(comparison.changed)}`,
      );
      assert.match(comparison.reason, /policy/);
    }
  });

  test('a basis frozen under the current policy version matches a live world on the same version', () => {
    const frozenBasis = buildLiveReviewBasis(liveWorld(EVIDENCE_REVIEW_POLICY_VERSION));
    const comparison = compareReviewBasis(frozenBasis, liveWorld(EVIDENCE_REVIEW_POLICY_VERSION));

    assert.equal(comparison.status, 'match');
  });

  test('a stale-policy basis is blocked from committing and requires a successor', () => {
    const frozenBasis = buildLiveReviewBasis(liveWorld(PREVIOUS_POLICY_VERSION));
    const decision = decideReviewCommitFence({
      basis: frozenBasis,
      live: liveWorld(EVIDENCE_REVIEW_POLICY_VERSION),
    });

    assert.equal(decision.mayCommit, false);
    assert.equal(decision.kind, 'stale_before_fence');
    assert.equal(decision.shouldCreateSuccessor, true);
  });

  test('the current policy version constant has been bumped away from v2', () => {
    // Guard against an accidental rollback of the version bump.
    assert.notEqual(EVIDENCE_REVIEW_POLICY_VERSION, PREVIOUS_POLICY_VERSION);
  });

  test('a basis frozen under the previous prompt version is stale on prompt', () => {
    const frozenBasis = buildLiveReviewBasis({
      ...liveWorld(EVIDENCE_REVIEW_POLICY_VERSION),
      promptVersion: PREVIOUS_PROMPT_VERSION,
    });
    const comparison = compareReviewBasis(frozenBasis, liveWorld(EVIDENCE_REVIEW_POLICY_VERSION));

    assert.equal(comparison.status, 'stale');
    if (comparison.status === 'stale') {
      assert.ok(
        comparison.changed.includes('prompt'),
        `expected 'prompt' in changed set, got ${JSON.stringify(comparison.changed)}`,
      );
    }
  });

  test('a stale-prompt basis is blocked from committing and requires a successor', () => {
    const frozenBasis = buildLiveReviewBasis({
      ...liveWorld(EVIDENCE_REVIEW_POLICY_VERSION),
      promptVersion: PREVIOUS_PROMPT_VERSION,
    });
    const decision = decideReviewCommitFence({
      basis: frozenBasis,
      live: liveWorld(EVIDENCE_REVIEW_POLICY_VERSION),
    });

    assert.equal(decision.mayCommit, false);
    assert.equal(decision.kind, 'stale_before_fence');
    assert.equal(decision.shouldCreateSuccessor, true);
  });

  test('the current prompt version constant has been bumped to v2', () => {
    // Guard against accidental rollback of the prompt/topology version bump.
    assert.notEqual(EVIDENCE_REVIEW_PROMPT_VERSION, PREVIOUS_PROMPT_VERSION);
  });
});
/**
 * Focused regression tests for the remote-branch bounding bug (F1):
 * boundToolResultJson must trim item tails (last branch backward) before
 * dropping any branch envelope, keep truncation/omission visible, and
 * degrade to an explicit bounded overflow warning — never a fake-empty
 * `branches: []` result that silently loses every remote ref.
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { boundToolResultJson, projectBranchResponse } from '../src/core/catslog-branch-evidence';
import { MAX_REMOTE_EVIDENCE_CHARS } from '../src/core/branch-evidence-pack';

const BUDGET = MAX_REMOTE_EVIDENCE_CHARS; // 20_000 — the production remote-lane budget

/** Deterministic 64-hex pool-citation refs (`ref_<64hex>` wire form). */
const poolRef = (index: number): string => `ref_${index.toString(16).padStart(64, '0')}`;

/** One oversized branch: ~24 items x ~1.2KB serialized text ≈ 29k chars. */
const oversizedOneBranchResponse = () => ({
  content_trust: 'untrusted_branch_evidence',
  request_id: 'br-f1',
  status: 'ok',
  branches: [{
    source: 'session_graph',
    status: 'ok',
    evidence_verdict: 'weak',
    items: Array.from({ length: 24 }, (_, index) => ({
      source: 'session',
      ref: poolRef(index),
      kind: 'session_turn',
      text: `EV_${index}_${'x'.repeat(1000)}`,
      score_hint: index / 24,
    })),
  }],
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('boundToolResultJson remote-branch bounding (F1 regression)', () => {
  test('oversized single branch trims item tails, keeps the branch envelope and every marker within budget', () => {
    const projected = projectBranchResponse(oversizedOneBranchResponse());
    const inputRefs = new Set((projected.branches as any[])[0].items.map((item: any) => item.ref));

    const encoded = boundToolResultJson(projected, BUDGET);

    assert.ok(encoded.length <= BUDGET, `result must fit the 20k budget, got ${encoded.length}`);
    const parsed = JSON.parse(encoded);

    // The branch envelope itself must survive — this is the bug: the old
    // minimal-pop search dropped the whole branch (1 pop) instead of
    // trimming item tails, losing every remote ref.
    assert.equal(parsed.branches.length, 1);
    assert.equal(parsed.branches[0].source, 'session_graph');
    assert.equal(parsed.branches[0].status, 'ok');
    assert.equal(parsed.branches[0].evidence_verdict, 'weak');
    assert.equal(parsed.request_id, 'br-f1');
    assert.equal(parsed.content_trust, 'untrusted_branch_evidence');

    // Some — but not all — items remain, and they are the head slice in order.
    const kept = parsed.branches[0].items as any[];
    assert.ok(kept.length > 0 && kept.length < 24, `expected partial item trim, kept ${kept.length}`);
    kept.forEach((item, index) => assert.equal(item.ref, poolRef(index)));
    assert.ok(!encoded.includes('EV_23_'), 'dropped tail item text must be absent');
    assert.ok(encoded.includes('EV_0_'), 'head item must be retained');

    // Truncation/omission is visible and honest.
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.bounded_omitted_items, 24 - kept.length);
    assert.equal('bounded_omitted_branches' in parsed, false, 'no branch was dropped');

    // Ref honesty: only refs from the input survive, never invented ones.
    for (const item of kept) assert.ok(inputRefs.has(item.ref));
    for (const match of encoded.matchAll(/ref_[0-9a-f]{64}/g)) {
      assert.ok(inputRefs.has(match[0]), `invented ref in output: ${match[0]}`);
    }
  });

  test('multi-branch fan-out preserves every branch envelope and trims last-branch items first', () => {
    const projected = projectBranchResponse({
      request_id: 'br-multi',
      branches: [
        {
          source: 'alpha', status: 'ok', evidence_verdict: 'strong',
          items: Array.from({ length: 3 }, (_, index) => ({
            source: 'session', ref: `alpha-note#${index + 1}`, kind: 'session_turn', text: `small ${index}`,
          })),
        },
        {
          source: 'beta', status: 'degraded', evidence_verdict: 'weak',
          items: Array.from({ length: 12 }, (_, index) => ({
            source: 'session', ref: poolRef(100 + index), kind: 'session_turn', text: `BETA_${index}_${'y'.repeat(900)}`,
          })),
        },
        {
          source: 'gamma', status: 'timeout', evidence_verdict: 'none',
          items: Array.from({ length: 12 }, (_, index) => ({
            source: 'session', ref: poolRef(200 + index), kind: 'session_turn', text: `GAMMA_${index}_${'z'.repeat(900)}`,
          })),
        },
      ],
    });

    const encoded = boundToolResultJson(projected, 12_000);
    assert.ok(encoded.length <= 12_000, `result must fit the supplied budget, got ${encoded.length}`);
    const parsed = JSON.parse(encoded);

    // Every branch envelope survives with source/status/verdict intact.
    assert.equal(parsed.branches.length, 3);
    assert.deepEqual(parsed.branches.map((branch: any) => branch.source), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(parsed.branches.map((branch: any) => branch.status), ['ok', 'degraded', 'timeout']);
    assert.deepEqual(parsed.branches.map((branch: any) => branch.evidence_verdict), ['strong', 'weak', 'none']);
    assert.equal(parsed.request_id, 'br-multi');

    // Item tails pop last-branch-first: alpha keeps all its items, gamma
    // is trimmed at least as hard as beta, no whole branch was dropped.
    const [alpha, beta, gamma] = parsed.branches;
    assert.equal(alpha.items.length, 3);
    assert.ok(gamma.items.length < beta.items.length, 'last branch must be trimmed first');
    assert.equal('bounded_omitted_branches' in parsed, false);
    assert.equal(parsed.truncated, true);
    const keptTotal = alpha.items.length + beta.items.length + gamma.items.length;
    assert.equal(parsed.bounded_omitted_items, 27 - keptTotal);
  });

  test('physically too-small budget returns an explicit bounded overflow, not a fake-empty result', () => {
    const projected = projectBranchResponse(oversizedOneBranchResponse());
    // 64 chars cannot hold even the marker-bearing empty envelope. Module
    // policy returns the explicit overflow warning even though the warning
    // itself exceeds this budget — so deliberately DO NOT assert <= 64 here
    // (the sub-18-char hard-cap style assertion is impossible by design).
    const encoded = boundToolResultJson(projected, 64);
    const parsed = JSON.parse(encoded);

    assert.equal(parsed.bounded_overflow, true);
    assert.equal(parsed.truncated, true);
    assert.match(parsed.warning, /exceeded the branch evidence budget/);
    assert.equal(parsed.content_trust, 'untrusted_branch_evidence');
    assert.equal(parsed.request_id, 'br-f1');
    assert.equal(parsed.bounded_omitted_items, 24);
    assert.equal(parsed.bounded_omitted_branches, 1);
    assert.equal(parsed.bounded_omitted_refs, 24);

    // Not a fake empty: no bare `branches: []` payload, no raw text dump.
    assert.equal('branches' in parsed, false);
    assert.ok(!encoded.includes('EV_'), 'overflow envelope must not carry raw evidence text');
    assert.ok(encoded.length < 1000, 'overflow envelope stays bounded');
  });

  test('bounding is deterministic and never mutates its input', () => {
    const projected = projectBranchResponse(oversizedOneBranchResponse());
    const snapshot = JSON.parse(JSON.stringify(projected));
    deepFreeze(projected); // strict-mode canary: any in-place mutation throws

    const first = boundToolResultJson(projected, BUDGET);
    const second = boundToolResultJson(projected, BUDGET);

    assert.equal(first, second, 'same input must encode byte-identically');
    assert.deepEqual(projected, snapshot, 'input envelope must be untouched');
  });

  test('projection-maxima fan-out (8 branches x 50 items x 12k text) still fits the 20k budget', () => {
    const projected = projectBranchResponse({
      request_id: 'br-max',
      branches: Array.from({ length: 8 }, (_, branchIndex) => ({
        source: `lane_${branchIndex}`,
        status: 'ok',
        evidence_verdict: 'weak',
        items: Array.from({ length: 50 }, (_, itemIndex) => ({
          source: 'session',
          ref: poolRef(branchIndex * 100 + itemIndex),
          kind: 'session_turn',
          text: `MAX_${branchIndex}_${itemIndex}_${'w'.repeat(13_000)}`,
        })),
      })),
    });

    const encoded = boundToolResultJson(projected, BUDGET);
    assert.ok(encoded.length <= BUDGET, `projection maxima must fit the budget, got ${encoded.length}`);
    const parsed = JSON.parse(encoded);
    assert.equal(parsed.branches.length, 8, 'every branch envelope survives even at maxima');
    const keptTotal = parsed.branches.reduce((sum: number, branch: any) => sum + branch.items.length, 0);
    assert.ok(keptTotal > 0, 'a bounded item projection fits, so remote evidence must remain');
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.bounded_omitted_items, 400 - keptTotal);
  });
});

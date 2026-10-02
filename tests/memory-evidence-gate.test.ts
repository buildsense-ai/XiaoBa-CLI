import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { CatscoBranchResponse } from '../src/utils/catsco-log-agent-client';
import { hasUsableMemoryEvidence } from '../src/core/memory-evidence-gate';

/**
 * Pure core of the memory branch's verdict gate (ADR 0020 evidence_verdict
 * client contract). One behavior per case:
 *
 * - session_graph `none` condemns only its own judged pool: leftover items
 *   there are rejected candidates, NOT usable evidence;
 * - every other lane (other remote branches, raw session records, local KB
 *   entries) stays independent — `none` never claims "no history exists";
 * - absent/unknown verdicts proceed exactly like weak/strong;
 * - every malformed wire shape degrades conservatively (never throws,
 *   never suppresses evidence it cannot interpret).
 */
describe('memory evidence gate', () => {
  const item = (overrides: Record<string, unknown> = {}) => ({ source: 'session', ref: 'ref_1', kind: 'session_turn', ...overrides });
  const response = (branches: unknown[]): CatscoBranchResponse => ({ branches } as unknown as CatscoBranchResponse);
  const graphNoneWithItems = (): CatscoBranchResponse => response([
    { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [item(), item()] },
  ]);

  test('session_graph none with leftover items and nothing else is NOT usable', () => {
    // `none` means this pool was judged not useful — the items are the
    // rejected pool, and the empty session/KB lanes add nothing. The gate
    // must let the caller skip refine.
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: graphNoneWithItems(),
      sessionRecords: [],
      knowledgeEntries: [],
    }), false);
  });

  test('same response plus raw session records is usable', () => {
    // Semantic `none` is scoped to the reranked pool; device-scoped session
    // records are independent evidence and must keep refine alive.
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: graphNoneWithItems(),
      sessionRecords: [{ ref: 's1#3', timestamp: '2026-01-01T00:00:00Z' }],
      knowledgeEntries: [],
    }), true);
  });

  test('same response plus local KB entries is usable', () => {
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: graphNoneWithItems(),
      sessionRecords: [],
      knowledgeEntries: [{ ref: 'kb:KB-1', summary: 'release checklist' }],
    }), true);
  });

  test('same response plus a skill-branch hit is usable', () => {
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([
        { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [item()] },
        { source: 'skill', status: 'ok', items: [{ source: 'skill', ref: 'catslog:skill:release-playbook@3' }] },
      ]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), true);
  });

  test('same response plus an agent_memory-branch hit is usable', () => {
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([
        { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [item()] },
        { source: 'agent_memory', status: 'ok', items: [{ source: 'memory', ref: 'note-9' }] },
      ]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), true);
  });

  test('absent verdict keeps items usable (unknown proceeds)', () => {
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([{ source: 'session_graph', status: 'ok', items: [item()] }]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), true);
  });

  test('explicit unknown and junk verdict values keep items usable', () => {
    for (const verdict of ['unknown', 'garbage', 42, null, { nested: true }]) {
      assert.equal(hasUsableMemoryEvidence({
        remoteResponse: response([{ source: 'session_graph', evidence_verdict: verdict, items: [item()] }]),
        sessionRecords: [],
        knowledgeEntries: [],
      }), true, `verdict=${JSON.stringify(verdict)}`);
    }
  });

  test('weak and strong verdicts keep items usable', () => {
    for (const verdict of ['weak', 'strong']) {
      assert.equal(hasUsableMemoryEvidence({
        remoteResponse: response([{ source: 'session_graph', evidence_verdict: verdict, items: [item()] }]),
        sessionRecords: [],
        knowledgeEntries: [],
      }), true, `verdict=${verdict}`);
    }
  });

  test('an explicit none on a non-session_graph branch does not suppress its items', () => {
    // The verdict vocabulary is per-branch, but only the reranked
    // session_graph source issues `none` today; other sources stay
    // independent regardless of what a hostile wire claims.
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([
        { source: 'agent_memory', status: 'ok', evidence_verdict: 'none', items: [{ source: 'memory', ref: 'note-9' }] },
      ]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), true);
  });

  test('none with empty items everywhere and empty lanes is NOT usable (skip still available)', () => {
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([
        { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [] },
        { source: 'agent_memory', status: 'ok', items: [] },
        { source: 'skill', status: 'timeout' },
      ]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), false);
  });

  test('a failed/empty session lane must not fake usability', () => {
    // No premature promotion of truncated or missing lanes: a session_graph
    // `none` with an empty (failed) session lane is honestly not usable.
    // The gate reads only the arrays it was handed.
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([{ source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [] }]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), false);
  });

  test('any session record shape counts — the gate inspects length, not content', () => {
    assert.equal(hasUsableMemoryEvidence({
      sessionRecords: [{}],
      knowledgeEntries: [],
    }), true);
    assert.equal(hasUsableMemoryEvidence({
      sessionRecords: [],
      knowledgeEntries: [{}],
    }), true);
  });

  test('malformed wire is safe: never throws, degrades conservatively', () => {
    // No remote response at all: lanes only.
    assert.equal(hasUsableMemoryEvidence({ sessionRecords: [], knowledgeEntries: [] }), false);
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: undefined,
      sessionRecords: [{ ref: 's1' }],
      knowledgeEntries: [],
    }), true);

    // Junk remote shapes: nothing interpretable to suppress, so the gate
    // falls back to the lanes alone.
    for (const remoteResponse of [
      undefined,
      null,
      'branches',
      42,
      {},
      { branches: 'nope' },
      { branches: null },
      { branches: [null, 7, 'x'] },
      response([{ source: 'session_graph', evidence_verdict: 'none', items: 'nope' }]),
    ]) {
      const gate = () => hasUsableMemoryEvidence({
        remoteResponse: remoteResponse as CatscoBranchResponse | undefined,
        sessionRecords: [],
        knowledgeEntries: [],
      });
      assert.doesNotThrow(gate, `remoteResponse=${JSON.stringify(remoteResponse) ?? 'undefined'}`);
      // None of these shapes proves usable remote evidence: the gate must
      // not invent usability from data it cannot interpret.
      assert.equal(gate(), false);
    }
  });

  test('a non-session_graph branch with an uninterpretable source still counts its items', () => {
    // Suppression is bound to the session_graph source specifically; a
    // branch whose source cannot be read is NOT one of them, so its items
    // keep the conservative "proceed" direction.
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([{ source: 123, evidence_verdict: 'none', items: [item()] }]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), true);
  });

  test('non-array items on a suppressing branch cannot leak usability', () => {
    // items: 'nope' on the none-branch is uninterpretable; it must not
    // suddenly count as items.
    assert.equal(hasUsableMemoryEvidence({
      remoteResponse: response([{ source: 'session_graph', evidence_verdict: 'none', items: 'nope' }]),
      sessionRecords: [],
      knowledgeEntries: [],
    }), false);
  });

  test('pure: repeat calls agree and inputs are not mutated', () => {
    const input = {
      remoteResponse: graphNoneWithItems(),
      sessionRecords: Object.freeze([{ ref: 's1' }]),
      knowledgeEntries: Object.freeze([]),
    };
    const snapshot = JSON.stringify(input);
    const first = hasUsableMemoryEvidence(input);
    const second = hasUsableMemoryEvidence(input);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(JSON.stringify(input), snapshot);
  });
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  collectBranchCitationUsage,
  collectBranchRefLanes,
  deriveBranchRefLane,
  isSessionLaneRef,
} from '../src/core/branch-citation-reporter';
import type { SyntheticObservation } from '../src/core/synthetic-observation';

const POOL_REF = `ref_${'a'.repeat(64)}`;
const POOL_REF_B = `ref_${'b'.repeat(64)}`;
const STREAM_REF = 'stream-release#42';
const KB_REF = 'kb:KB-11111111-2222-4333-8444-555555555555';
const SKILL_REF = 'catslog:skill:playbook@3';

function observation(metadata: SyntheticObservation['metadata'], timing?: SyntheticObservation['timing']): SyntheticObservation {
  return { id: 'obs', source: 'memory', status: 'completed', relevance: 'medium', summary: 's', metadata, timing };
}

describe('lane attribution', () => {
  test('classifies ref shapes by producing lane', () => {
    const pool = new Set([POOL_REF]);
    assert.equal(deriveBranchRefLane(POOL_REF, pool), 'remote_pool');
    assert.equal(deriveBranchRefLane(POOL_REF_B, pool), 'other', 'unpoolled ref_ is not a pool ref');
    assert.equal(deriveBranchRefLane(STREAM_REF, pool), 'session');
    assert.equal(deriveBranchRefLane('stream-release#summary', pool), 'session');
    assert.equal(deriveBranchRefLane('catslog:session:aaaaaaaaaaaaaaaaaaaaaaaa', pool), 'session');
    assert.equal(deriveBranchRefLane(KB_REF, pool), 'knowledge');
    assert.equal(deriveBranchRefLane('file:documents/notes.md', pool), 'knowledge');
    assert.equal(deriveBranchRefLane(SKILL_REF, pool), 'other');
    assert.equal(deriveBranchRefLane(null, pool), 'other');
    assert.equal(isSessionLaneRef('plain-text-no-hash'), false);
  });

  test('tags dedupe, bound count, and skip malformed entries', () => {
    const tags = collectBranchRefLanes([POOL_REF, STREAM_REF, '', POOL_REF, { x: 1 }, 'x'.repeat(600)], new Set([POOL_REF]));
    assert.deepEqual(tags, [
      { ref: POOL_REF, lane: 'remote_pool' },
      { ref: STREAM_REF, lane: 'session' },
    ]);
  });
});

describe('collectBranchCitationUsage', () => {
  test('counts injected vs cited per lane from the corpus', () => {
    const usage = collectBranchCitationUsage([
      observation({
        refs: [POOL_REF, STREAM_REF, KB_REF],
        refLanes: [
          { ref: POOL_REF, lane: 'remote_pool' },
          { ref: STREAM_REF, lane: 'session' },
          { ref: KB_REF, lane: 'knowledge' },
        ],
        citation: { requestId: 'br-1', refs: [POOL_REF] },
      }),
    ], `reply cites ${POOL_REF} and ${STREAM_REF} but not the kb`);

    assert.equal(usage?.carryover, false);
    assert.deepEqual(usage?.requestIds, ['br-1']);
    assert.deepEqual(usage?.injectedByLane, { remote_pool: 1, session: 1, knowledge: 1, source: 0 });
    assert.deepEqual(usage?.citedByLane, { remote_pool: 1, session: 1, knowledge: 0, source: 0 });
  });

  test('knowledge refs match bare KB-ID in tool paths', () => {
    const usage = collectBranchCitationUsage([
      observation({ refs: [KB_REF], refLanes: [{ ref: KB_REF, lane: 'knowledge' }] }),
    ], `read_file /opt/xiaoba-cli/knowledge/documents/KB-11111111-2222-4333-8444-555555555555.md`);
    assert.deepEqual(usage?.citedByLane.knowledge, 1);
  });

  test('carryover flags only for late_previous_turn observations', () => {
    const withCarry = collectBranchCitationUsage([
      observation({ refs: [POOL_REF] }, 'late_previous_turn'),
    ], 'nothing cited');
    assert.equal(withCarry?.carryover, true);
    const current = collectBranchCitationUsage([
      observation({ refs: [POOL_REF] }, 'current_turn'),
    ], '');
    assert.equal(current?.carryover, false);
  });

  test('falls back to shape-derived lanes when refLanes metadata is absent or malformed', () => {
    const pool = new Set([POOL_REF]);
    const usage = collectBranchCitationUsage([
      observation({
        refs: [POOL_REF, STREAM_REF, KB_REF],
        citation: { requestId: 'br-2', refs: [POOL_REF] },
      }),
      observation({ refs: [POOL_REF], refLanes: 'not-an-array' as any }),
    ], `corpus ${POOL_REF}`);
    assert.deepEqual(usage?.injectedByLane, { remote_pool: 1, session: 1, knowledge: 1, source: 0 });
  });

  test('undefined when there are no observations; empty corpus yields zero citations', () => {
    assert.equal(collectBranchCitationUsage([], 'x'), undefined);
    const usage = collectBranchCitationUsage([observation({ refs: [POOL_REF] })], undefined);
    assert.deepEqual(usage?.citedByLane, { remote_pool: 0, session: 0, knowledge: 0, source: 0 });
  });

  test('invalid request ids are excluded but lane counts still computed', () => {
    const usage = collectBranchCitationUsage([
      observation({
        refs: [POOL_REF],
        citation: { requestId: 'bad\nid', refs: [POOL_REF] },
      }),
    ], POOL_REF);
    assert.deepEqual(usage?.requestIds, []);
    assert.equal(usage?.citedByLane.remote_pool, 1);
  });
});

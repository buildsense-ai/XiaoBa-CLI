import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectBranchCitationUsage, collectBranchRefLanes, deriveBranchRefLane, matchBranchCitations } from '../src/core/branch-citation-reporter';

const SOURCE = `catslog:source:${'e'.repeat(64)}`, POOL = `ref_${'f'.repeat(64)}`;

test('typed source refs tag and count in their own lane, including fallback/carryover, never old remote reporting', () => {
  assert.equal(deriveBranchRefLane(SOURCE), 'source');
  assert.equal(deriveBranchRefLane('catslog:source:bad'), 'other');
  assert.deepEqual(collectBranchRefLanes([SOURCE, SOURCE, POOL], new Set([POOL])), [
    { ref: SOURCE, lane: 'source' }, { ref: POOL, lane: 'remote_pool' },
  ]);
  const observation: any = { source: 'memory', summary: 'Source summary', status: 'completed', relevance: 'medium',
    timing: 'late_previous_turn', metadata: { refs: [SOURCE, POOL], citation: { requestId: 'request-1', refs: [SOURCE, POOL] } } };
  const counts = collectBranchCitationUsage([observation], SOURCE);
  assert.equal(counts?.carryover, true);
  assert.equal(counts?.injectedByLane.source, 1); assert.equal(counts?.citedByLane.source, 1);
  assert.equal(counts?.citedByLane.remote_pool, 0);
  assert.deepEqual(matchBranchCitations([observation], SOURCE), { reports: [], knowledgeRefs: [], sourceRefs: [SOURCE] });
  assert.deepEqual(matchBranchCitations([observation], `${SOURCE} ${POOL}`).reports, [{ requestId: 'request-1', refs: [POOL] }]);
});

test('source citation ref collection uses the source injection bound, not the old 32-document KB bound', () => {
  const refs = Array.from({ length: 40 }, (_, index) => `catslog:source:${index.toString(16).padStart(64, '0')}`);
  const observation: any = { source: 'memory', summary: 'Source summary', status: 'completed', relevance: 'medium', metadata: { refs } };
  assert.equal(collectBranchCitationUsage([observation], refs.join('\n'))?.citedByLane.source, 40);
  assert.deepEqual(matchBranchCitations([observation], refs.join('\n')).sourceRefs, refs);
});

// Follow main's current explicit tool loop, rather than the retired assess/refine runner.
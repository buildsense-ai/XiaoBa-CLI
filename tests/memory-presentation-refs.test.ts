import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatsLogObservedRefsTracker, MAX_OBSERVED_REFS } from '../src/core/catslog-skill-evidence';

const ref = (n: number) => `ref_${n.toString(16).padStart(64, '0')}`;

test('explicit final-presentation registration retains more than one JSON array page', () => {
  const tracker = new CatsLogObservedRefsTracker();
  const presented = Array.from({ length: 88 }, (_, i) => ref(i + 1));
  tracker.recordPresentedRefs(presented);
  assert.deepEqual(tracker.snapshot().observedRefs, presented);
  assert.deepEqual(tracker.unobservedRefs(presented), []);
  assert.deepEqual(tracker.unobservedRefs([ref(999)]), [ref(999)]);
});

test('explicit refs still obey grammar, dedup and the existing total ceiling', () => {
  const tracker = new CatsLogObservedRefsTracker();
  tracker.recordPresentedRefs(['https://invalid.example/private', ref(1), ref(1)]);
  assert.deepEqual(tracker.snapshot().observedRefs, [ref(1)]);
  tracker.recordPresentedRefs(Array.from({ length: MAX_OBSERVED_REFS + 20 }, (_, i) => ref(i + 2)));
  assert.equal(tracker.snapshot().observedRefs.length, MAX_OBSERVED_REFS);
  assert.deepEqual(tracker.unobservedRefs([ref(999)]), [ref(999)]);
});

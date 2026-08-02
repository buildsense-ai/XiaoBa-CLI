import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalRuntime } from '../src/core/goal-runtime';

describe('GoalRuntime', () => {
  test('formats stable provider-visible content without runtime metadata', () => {
    const runtime = new GoalRuntime();
    runtime.update({ objective: 'Keep capability coverage complete.', status: 'active' });
    const first = runtime.formatForPrompt();
    runtime.update({ status: 'active' });
    const second = runtime.formatForPrompt();

    assert.equal(first, second);
    assert.match(first || '', /Keep capability coverage complete\./);
    assert.match(first || '', /状态：active/);
    assert.doesNotMatch(first || '', /revision|updatedAt|\d{4}-\d{2}-\d{2}T/);
  });

  test('restores only a valid persisted snapshot and clears invalid state', () => {
    const original = new GoalRuntime();
    const snapshot = original.update({ objective: 'Resume this objective.', status: 'blocked' });
    const restored = new GoalRuntime(snapshot);

    assert.deepEqual(restored.getSnapshot(), snapshot);
    restored.restore({ ...snapshot, status: 'unknown' });
    assert.equal(restored.hasGoal(), false);
  });

  test('requires an objective and rejects oversized or invalid updates', () => {
    const runtime = new GoalRuntime();
    assert.throws(() => runtime.update({ status: 'active' }), /非空 objective/);
    assert.throws(() => runtime.update({ objective: 'x'.repeat(12_001) }), /不能超过/);
    assert.throws(() => runtime.update({ objective: 'valid', status: 'unknown' as any }), /status 无效/);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGrepSearchTimeoutMs, resolveGrepRpcTimeoutMs } from '../src/tools/grep-search-policy';

test('grep has a fixed default execution deadline and bounded RPC grace', () => {
  assert.equal(resolveGrepSearchTimeoutMs(), 15_000);
  assert.equal(resolveGrepRpcTimeoutMs(), 20_000);
  assert.equal(resolveGrepRpcTimeoutMs(100), 5_100);
  assert.equal(resolveGrepRpcTimeoutMs(30_000), 35_000);
});

test('malformed grep budgets fail before dispatch rather than becoming unbounded', () => {
  for (const invalid of [null, '', '1000', 0, -1, 99, 30_001, 100.5, NaN, Infinity, {}, true]) {
    assert.throws(() => resolveGrepSearchTimeoutMs(invalid), RangeError);
  }
});

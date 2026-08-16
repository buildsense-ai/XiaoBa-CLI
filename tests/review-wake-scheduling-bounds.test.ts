import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { rotateOperationalRetryForDiscovery } from '../src/utils/distillation-heartbeat-scheduler';
import { reviewBatchQuantumTimeoutMs } from '../src/utils/evidence-review-engine';

describe('review wake scheduling bounds', () => {
  test('the third operational retry rotates through discovery without sleeping for the full interval', () => {
    const first = rotateOperationalRetryForDiscovery(0, 0);
    const second = rotateOperationalRetryForDiscovery(0, first.consecutiveOperationalRetries);
    const third = rotateOperationalRetryForDiscovery(0, second.consecutiveOperationalRetries);

    assert.deepEqual(first, {
      delayMs: 0,
      reason: 'operational-retry',
      consecutiveOperationalRetries: 1,
    });
    assert.deepEqual(second, {
      delayMs: 0,
      reason: 'operational-retry',
      consecutiveOperationalRetries: 2,
    });
    assert.deepEqual(third, {
      delayMs: 30_000,
      reason: 'scheduled',
      consecutiveOperationalRetries: 0,
    });
  });

  test('the serial Quantum batch stops at its shared deadline and caps each attempt to remaining time', () => {
    assert.equal(reviewBatchQuantumTimeoutMs(undefined, 600_000, 1_000), 600_000);
    assert.equal(reviewBatchQuantumTimeoutMs(11_000, 600_000, 1_000), 10_000);
    assert.equal(reviewBatchQuantumTimeoutMs(11_000, 5_000, 1_000), 5_000);
    assert.equal(reviewBatchQuantumTimeoutMs(11_000, 600_000, 11_000), null);
    assert.equal(reviewBatchQuantumTimeoutMs(11_000, 600_000, 12_000), null);
  });
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  DEFAULT_MEMORY_PRESSURE_CONFIG,
  MemoryPressureGuard,
  classifyMemoryPressure,
  getDistillationMemoryPressureConfig,
  type MemoryPressureConfig,
  type MemoryPressureSample,
} from '../src/utils/distillation-memory-pressure';

const config: MemoryPressureConfig = {
  softCgroupPercent: 70,
  hardCgroupPercent: 85,
  softHostAvailableBytes: 1024 * 1024 * 1024,
  hardHostAvailableBytes: 512 * 1024 * 1024,
  recoveryCgroupPercent: 55,
  recoveryHostAvailableBytes: 1536 * 1024 * 1024,
  recoverySamples: 3,
  pollIntervalMs: 15_000,
  degradedReviewerConcurrency: 1,
  degradedMaxCandidates: 10,
};

function sample(overrides: Partial<MemoryPressureSample> = {}): MemoryPressureSample {
  return {
    sampledAt: '2026-08-12T00:00:00.000Z',
    cgroupCurrentBytes: 500,
    cgroupMaxBytes: 1_000,
    cgroupPercent: 50,
    hostMemAvailableBytes: 2 * 1024 * 1024 * 1024,
    nodeRssBytes: 100,
    reasons: [],
    ...overrides,
  };
}

describe('distillation memory pressure', () => {
  test('classifies cgroup pressure before host pressure', () => {
    assert.equal(
      classifyMemoryPressure(sample({ cgroupPercent: 75 }), config).level,
      'soft',
    );
    assert.equal(
      classifyMemoryPressure(sample({ cgroupPercent: 90 }), config).level,
      'hard',
    );
    assert.equal(
      classifyMemoryPressure(sample({ hostMemAvailableBytes: 400 * 1024 * 1024 }), config).level,
      'hard',
    );
  });

  test('moves normal to degraded on soft pressure, then suspends on hard pressure', () => {
    const guard = new MemoryPressureGuard(config);

    const degraded = guard.observe(sample({ cgroupPercent: 75 }));
    assert.equal(degraded.transition, 'degraded');
    assert.equal(guard.mode, 'degraded');

    const suspended = guard.observe(sample({ cgroupPercent: 90 }));
    assert.equal(suspended.transition, 'suspended');
    assert.equal(guard.mode, 'suspended');
  });

  test('does not flap immediately and requires recovery samples before resuming', () => {
    const guard = new MemoryPressureGuard(config);
    guard.observe(sample({ cgroupPercent: 75 }));
    guard.observe(sample({ cgroupPercent: 90 }));

    assert.equal(guard.observe(sample()).transition, 'none');
    assert.equal(guard.observe(sample()).transition, 'none');
    assert.equal(guard.observe(sample()).transition, 'recovered-to-degraded');
    assert.equal(guard.mode, 'degraded');

    assert.equal(guard.observe(sample()).transition, 'none');
    assert.equal(guard.observe(sample()).transition, 'none');
    assert.equal(guard.observe(sample()).transition, 'recovered-to-normal');
    assert.equal(guard.mode, 'normal');
  });

  test('hard pressure from normal suspends immediately', () => {
    const guard = new MemoryPressureGuard(config);
    assert.equal(guard.observe(sample({ hostMemAvailableBytes: 400 * 1024 * 1024 })).transition, 'suspended');
    assert.equal(guard.mode, 'suspended');
  });

  test('uses cgroup memory.events deltas even when the current sample has already fallen', () => {
    const guard = new MemoryPressureGuard(config);
    guard.observe(sample({ cgroupOomKills: 4, cgroupHighEvents: 8 }));

    const soft = guard.observe(sample({ cgroupOomKills: 4, cgroupHighEvents: 9 }));
    assert.equal(soft.level, 'soft');
    assert.equal(soft.mode, 'degraded');
    assert.ok(soft.sample.reasons.includes('cgroup-high-event'));

    const hard = guard.observe(sample({ cgroupOomKills: 5, cgroupHighEvents: 9 }));
    assert.equal(hard.level, 'hard');
    assert.equal(hard.mode, 'suspended');
    assert.ok(hard.sample.reasons.includes('cgroup-oom-kill'));
  });

  test('does not count a fresh cgroup event as a recovery sample', () => {
    const guard = new MemoryPressureGuard(config);
    guard.observe(sample({ cgroupPercent: 75, cgroupHighEvents: 8 }));

    const afterFreshHighEvent = guard.observe(sample({
      cgroupPercent: 50,
      cgroupHighEvents: 9,
    }));
    assert.equal(afterFreshHighEvent.level, 'soft');
    assert.equal(afterFreshHighEvent.recoverySamples, 0);

    assert.equal(guard.observe(sample({ cgroupHighEvents: 9 })).recoverySamples, 1);
    assert.equal(guard.observe(sample({ cgroupHighEvents: 9 })).recoverySamples, 2);
    assert.equal(guard.observe(sample({ cgroupHighEvents: 9 })).transition, 'recovered-to-normal');
  });

  test('defaults to a 10-second poll and keeps soft, hard, and recovery thresholds distinct', () => {
    const defaults = getDistillationMemoryPressureConfig({});
    assert.equal(defaults.pollIntervalMs, 10_000);
    assert.equal(defaults.pollIntervalMs, DEFAULT_MEMORY_PRESSURE_CONFIG.pollIntervalMs);

    const normalized = getDistillationMemoryPressureConfig({
      DISTILLATION_MEMORY_PRESSURE_SOFT_CGROUP_PERCENT: '70',
      DISTILLATION_MEMORY_PRESSURE_HARD_CGROUP_PERCENT: '20',
      DISTILLATION_MEMORY_PRESSURE_SOFT_HOST_AVAILABLE_BYTES: '1000',
      DISTILLATION_MEMORY_PRESSURE_HARD_HOST_AVAILABLE_BYTES: '2000',
      DISTILLATION_MEMORY_PRESSURE_RECOVERY_CGROUP_PERCENT: '90',
      DISTILLATION_MEMORY_PRESSURE_RECOVERY_HOST_AVAILABLE_BYTES: '500',
    });
    assert.equal(normalized.hardCgroupPercent, 71);
    assert.equal(normalized.hardHostAvailableBytes, 999);
    assert.equal(normalized.recoveryCgroupPercent, 69);
    assert.equal(normalized.recoveryHostAvailableBytes, 1001);
  });
});

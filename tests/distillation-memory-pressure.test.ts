import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  MemoryPressureGuard,
  getDistillationMemoryPressureConfig,
  readSystemMemoryPressureSample,
  type MemoryPressureSample,
} from '../src/utils/distillation-memory-pressure';

const MIB = 1024 * 1024;

function sample(overrides: Partial<MemoryPressureSample> = {}): MemoryPressureSample {
  return {
    sampledAt: '2026-08-13T00:00:00.000Z',
    cgroupCurrentBytes: 500 * MIB,
    cgroupMaxBytes: 1024 * MIB,
    cgroupPercent: 50,
    hostMemAvailableBytes: 2 * 1024 * MIB,
    nodeRssBytes: 120 * MIB,
    reasons: [],
    ...overrides,
  };
}

describe('distillation memory-pressure guard', () => {
  test('requires complete observed low-pressure samples before staged recovery', () => {
    const guard = new MemoryPressureGuard({
      softCgroupPercent: 70,
      hardCgroupPercent: 85,
      softHostAvailableBytes: 1024 * MIB,
      hardHostAvailableBytes: 512 * MIB,
      recoveryCgroupPercent: 55,
      recoveryHostAvailableBytes: 1536 * MIB,
      recoverySamples: 3,
      pollIntervalMs: 10_000,
      degradedReviewerConcurrency: 1,
      degradedMaxCandidates: 10,
    });

    assert.equal(guard.observe(sample({ cgroupPercent: 90 })).mode, 'suspended');
    assert.equal(guard.observe(sample({ cgroupPercent: null })).mode, 'suspended');
    assert.equal(guard.observe(sample({ hostMemAvailableBytes: null })).mode, 'suspended');
    assert.equal(guard.observe(sample()).mode, 'suspended');
    assert.equal(guard.observe(sample()).mode, 'suspended');
    const degraded = guard.observe(sample());
    assert.equal(degraded.mode, 'degraded');
    assert.equal(degraded.transition, 'recovered-to-degraded');
    assert.equal(guard.observe(sample()).mode, 'degraded');
    assert.equal(guard.observe(sample()).mode, 'degraded');
    const normal = guard.observe(sample());
    assert.equal(normal.mode, 'normal');
    assert.equal(normal.transition, 'recovered-to-normal');
  });

  test('disabling the guard clears a restored suspended state', () => {
    const guard = new MemoryPressureGuard({
      enabled: false,
      softCgroupPercent: 70,
      hardCgroupPercent: 85,
      softHostAvailableBytes: 1024 * MIB,
      hardHostAvailableBytes: 512 * MIB,
      recoveryCgroupPercent: 55,
      recoveryHostAvailableBytes: 1536 * MIB,
      recoverySamples: 3,
      pollIntervalMs: 10_000,
      degradedReviewerConcurrency: 1,
      degradedMaxCandidates: 10,
    });
    guard.restore({
      mode: 'suspended',
      level: 'hard',
      transition: 'suspended',
      recoverySamples: 2,
      sample: sample({ cgroupPercent: 90 }),
    });

    assert.equal(guard.mode, 'normal');
    assert.equal(guard.observe(sample()).mode, 'normal');
  });

  test('attributes dashboard and sibling Chrome service RSS without using it as trigger accounting', () => {
    const cgroup = '/sys/fs/cgroup/system.slice/xiaoba-dashboard.service';
    const chromeCgroup = '/sys/fs/cgroup/system.slice/opencli-chrome.service';
    const files: Record<string, string> = {
      '/proc/self/cgroup': '0::/system.slice/xiaoba-dashboard.service\n',
      [`${cgroup}/memory.current`]: String(768 * MIB),
      [`${cgroup}/memory.max`]: String(1024 * MIB),
      [`${cgroup}/memory.events`]: 'high 4\noom_kill 1\n',
      [`${cgroup}/memory.stat`]: `anon ${400 * MIB}\nfile ${200 * MIB}\nkernel ${100 * MIB}\n`,
      [`${cgroup}/cgroup.procs`]: '101\n102\n',
      [`${chromeCgroup}/cgroup.procs`]: '201\n',
      '/proc/101/comm': 'node\n',
      '/proc/101/status': 'Name:\tnode\nVmRSS:\t1024 kB\n',
      '/proc/102/comm': 'bash\n',
      '/proc/102/status': 'Name:\tbash\nVmRSS:\t512 kB\n',
      '/proc/201/comm': 'chrome\n',
      '/proc/201/status': 'Name:\tchrome\nVmRSS:\t2048 kB\n',
      '/proc/meminfo': 'MemAvailable:       2097152 kB\n',
    };
    const result = readSystemMemoryPressureSample(file => {
      if (!(file in files)) throw new Error(`unexpected read ${file}`);
      return files[file]!;
    }, 111 * MIB);

    assert.equal(result.cgroupPercent, 75);
    assert.equal(result.cgroupAnonBytes, 400 * MIB);
    assert.equal(result.cgroupFileBytes, 200 * MIB);
    assert.equal(result.cgroupKernelBytes, 100 * MIB);
    assert.equal(result.dashboardCgroupProcessRss?.nodeRssBytes, 1024 * 1024);
    assert.equal(result.dashboardCgroupProcessRss?.otherRssBytes, 512 * 1024);
    assert.equal(result.openCliChromeServiceProcessRss?.chromeRssBytes, 2048 * 1024);
    assert.equal(result.nodeRssBytes, 111 * MIB);
  });

  test('normalizes invalid pressure environment values without changing normal defaults', () => {
    const config = getDistillationMemoryPressureConfig({
      DISTILLATION_MEMORY_PRESSURE_SOFT_CGROUP_PERCENT: '80',
      DISTILLATION_MEMORY_PRESSURE_HARD_CGROUP_PERCENT: '70',
      DISTILLATION_MEMORY_PRESSURE_SOFT_HOST_AVAILABLE_BYTES: '10',
      DISTILLATION_MEMORY_PRESSURE_HARD_HOST_AVAILABLE_BYTES: '999999',
    });
    assert.equal(config.softCgroupPercent, 80);
    assert.equal(config.hardCgroupPercent, 81);
    assert.equal(config.hardHostAvailableBytes, 9);
  });
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseCgroupCpuStat,
  sampleServiceCpuUsage,
} from '../src/utils/machine-resources';

function fakeIo(statSeq: string[]) {
  let i = 0;
  return {
    platform: 'linux' as NodeJS.Platform,
    cpus: () => new Array(8).fill({}),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
    loadavg: () => [0, 0, 0],
    readdirSync: () => [],
    readFileSync: () => {
      const body = statSeq[Math.min(i, statSeq.length - 1)];
      i += 1;
      return body;
    },
  };
}

test('cpu.stat：解析 usage_usec / throttled_usec', () => {
  const parsed = parseCgroupCpuStat('usage_usec 1500000\nuser_usec 900000\nthrottled_usec 250000\nnr_throttled 3\n');
  assert.deepEqual(parsed, { usageUsec: 1_500_000, throttledUsec: 250_000 });
});

test('cpu.stat：缺字段或非数字一律 unknown，不返回 0', () => {
  assert.equal(parseCgroupCpuStat('usage_usec 100\n'), undefined);
  assert.equal(parseCgroupCpuStat('usage_usec abc\nthrottled_usec 5\n'), undefined);
  assert.equal(parseCgroupCpuStat(''), undefined);
});

test('采样：两次读取的增量换算成实际占用的核数', () => {
  // 150ms 窗口内用掉 30ms CPU → 约 0.2 核；其中 15ms 被限流。
  const io = fakeIo([
    'usage_usec 1000000\nthrottled_usec 0\n',
    'usage_usec 1030000\nthrottled_usec 15000\n',
  ]);
  const sample = sampleServiceCpuUsage(io as never, '/cg', 150);
  assert.ok(sample, '应产生采样结果');
  assert.ok(sample!.usageCores > 0.1 && sample!.usageCores < 0.5, `usageCores=${sample!.usageCores}`);
  assert.ok(sample!.throttledMsPerSecond > 0, '限流应被记录');
});

test('采样：计数器读不到时返回 unknown 而不是 0', () => {
  const io = {
    platform: 'linux' as NodeJS.Platform,
    cpus: () => [],
    totalmem: () => 0,
    freemem: () => 0,
    loadavg: () => [0, 0, 0],
    readdirSync: () => [],
    readFileSync: () => {
      throw new Error('ENOENT');
    },
  };
  assert.equal(sampleServiceCpuUsage(io as never, '/cg', 30), undefined);
});

test('采样：计数器回退（cgroup 重建）不产生负数', () => {
  const io = fakeIo([
    'usage_usec 900000\nthrottled_usec 5000\n',
    'usage_usec 100000\nthrottled_usec 0\n',
  ]);
  assert.equal(sampleServiceCpuUsage(io as never, '/cg', 30), undefined);
});

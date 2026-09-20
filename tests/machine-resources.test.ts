import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMeminfo,
  parseLoadavg,
  parseCgroupV2SelfPath,
  formatBytesCompact,
  formatDurationCompact,
  buildMachineResourceGuidance,
  buildMachineResourceLines,
  buildCommandResourceNoteText,
  renderMachineResourcesForPrompt,
  setMachineResourceSnapshotForTest,
  __resetMachineResourceCacheForTest,
  type MachineResourceSnapshot,
} from '../src/utils/machine-resources';
import {
  registerActiveCommand,
  listActiveCommands,
  clearActiveCommandsForTest,
} from '../src/utils/active-commands';

const GIB = 1024 ** 3;
const NOW = 1_700_000_000_000;

function snapshotOf(overrides: Partial<MachineResourceSnapshot> = {}): MachineResourceSnapshot {
  return {
    platform: 'linux',
    cpuCount: 2,
    totalMemoryBytes: 3.6 * GIB,
    availableMemoryBytes: 1.2 * GIB,
    swapTotalBytes: 10 * GIB,
    swapFreeBytes: 8 * GIB,
    load1: 1.82,
    sampledAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  clearActiveCommandsForTest();
  __resetMachineResourceCacheForTest();
  delete process.env.XIAOBA_MACHINE_RESOURCES;
});

describe('machine resources parsing', () => {
  test('parses /proc/meminfo values into bytes', () => {
    const text = [
      'MemTotal:        3804632 kB',
      'MemFree:          401232 kB',
      'MemAvailable:    1272952 kB',
      'SwapTotal:      10485760 kB',
      'SwapFree:        9023488 kB',
    ].join('\n');
    const parsed = parseMeminfo(text);
    assert.equal(parsed.totalMemoryBytes, 3804632 * 1024);
    assert.equal(parsed.availableMemoryBytes, 1272952 * 1024);
    assert.equal(parsed.swapTotalBytes, 10485760 * 1024);
    assert.equal(parsed.swapFreeBytes, 9023488 * 1024);
  });

  test('parses load average', () => {
    assert.deepEqual(parseLoadavg('1.82 1.20 0.98 2/345 12345\n'), [1.82, 1.2, 0.98]);
  });

  test('parses a cgroup v2 self path and ignores cgroup v1 layouts', () => {
    assert.equal(
      parseCgroupV2SelfPath('0::/system.slice/catsco-agent.service\n'),
      '/system.slice/catsco-agent.service',
    );
    assert.equal(parseCgroupV2SelfPath('11:memory:/user.slice\n1:name=systemd:/user.slice\n'), undefined);
  });
});

describe('machine resource formatting', () => {
  test('formats byte sizes compactly', () => {
    assert.equal(formatBytesCompact(3.6 * GIB), '3.6G');
    assert.equal(formatBytesCompact(10 * GIB), '10G');
    assert.equal(formatBytesCompact(620 * 1024 ** 2), '620M');
    assert.equal(formatBytesCompact(512), '1K');
    assert.equal(formatBytesCompact(undefined), undefined);
    assert.equal(formatBytesCompact(-5), undefined);
  });

  test('formats durations compactly', () => {
    assert.equal(formatDurationCompact(43_000), '43 秒');
    assert.equal(formatDurationCompact(2_584_000), '43 分钟');
    assert.equal(formatDurationCompact(3_700_000), '1.0 小时');
  });
});

describe('machine resource guidance adapts to the actual machine', () => {
  test('flags low available memory first', () => {
    const guidance = buildMachineResourceGuidance(snapshotOf({ availableMemoryBytes: 0.5 * GIB }));
    assert.ok(guidance && guidance.includes('可用内存偏低'));
  });

  test('marks small machines without complaining when there is headroom', () => {
    const guidance = buildMachineResourceGuidance(snapshotOf());
    assert.ok(guidance && guidance.includes('内存偏小机型'));
  });

  test('stays silent on a big machine with plenty of headroom', () => {
    const guidance = buildMachineResourceGuidance(snapshotOf({
      totalMemoryBytes: 32 * GIB,
      availableMemoryBytes: 20 * GIB,
    }));
    assert.equal(guidance, undefined);
  });
});

describe('machine resource rendering', () => {
  test('renders live totals and swap usage from the snapshot', () => {
    const lines = buildMachineResourceLines(snapshotOf(), [], NOW, () => undefined);
    assert.match(lines[0], /^\[本机资源\]/);
    assert.ok(lines[0].includes('CPU 2 核'));
    assert.ok(lines[0].includes('内存 3.6G（可用 1.2G）'));
    assert.ok(lines[0].includes('Swap 10G（已用 2G）'));
    assert.ok(lines[0].includes('负载 1.82'));
    assert.ok(lines.some(line => line.includes('内存偏小机型')));
  });

  test('lists running commands with sampled RSS and age', () => {
    registerActiveCommand({
      pid: 4242,
      label: 'python3 /tmp/fix_v2.py',
      startedAt: NOW - 12 * 60_000,
      platform: 'linux',
    });
    const lines = buildMachineResourceLines(snapshotOf(), listActiveCommands(), NOW, () => 1.8 * GIB);
    const running = lines.find(line => line.includes('本机正在运行'));
    assert.ok(running && running.includes('python3 /tmp/fix_v2.py'));
    assert.ok(running.includes('12 分钟'));
    assert.ok(running.includes('RSS 1.8G'));
  });

  test('does not render load on Windows where the OS never reports it', () => {
    const lines = buildMachineResourceLines(snapshotOf({ platform: 'win32', load1: 0 }), [], NOW, () => undefined);
    assert.ok(lines[0].includes('CPU 2 核'));
    assert.ok(!lines[0].includes('负载'));
  });
});

describe('command result resource note', () => {
  test('stays silent when the command is short, small and memory is healthy', () => {
    const note = buildCommandResourceNoteText(
      { durationMs: 5_000, peakRssBytes: 50 * 1024 ** 2 },
      snapshotOf({ availableMemoryBytes: 2.4 * GIB }),
      [],
    );
    assert.equal(note, undefined);
  });

  test('fires for long-running commands and includes live figures', () => {
    const note = buildCommandResourceNoteText(
      { durationMs: 2_584_000, peakRssBytes: 2.1 * GIB },
      snapshotOf({ availableMemoryBytes: 2.4 * GIB }),
      [],
    );
    assert.ok(note);
    assert.ok(note.includes('本机可用 2.4G/3.6G'));
    assert.ok(note.includes('Swap 已用 2G/10G'));
    assert.ok(note.includes('本条耗时 43 分钟'));
    assert.ok(note.includes('峰值 RSS 2.1G'));
  });

  test('fires when available memory is low even for short commands', () => {
    const note = buildCommandResourceNoteText(
      { durationMs: 5_000 },
      snapshotOf({ availableMemoryBytes: 0.5 * GIB }),
      [],
    );
    assert.ok(note && note.includes('本机可用 512M/3.6G'));
  });

  test('scales the RSS trigger with machine size', () => {
    const big = snapshotOf({ totalMemoryBytes: 32 * GIB, availableMemoryBytes: 20 * GIB });
    assert.ok(buildCommandResourceNoteText({ durationMs: 3_000, peakRssBytes: 5 * GIB }, big, []) !== undefined);
    assert.equal(buildCommandResourceNoteText({ durationMs: 3_000, peakRssBytes: 4 * GIB }, big, []), undefined);
  });

  test('mentions other concurrent commands', () => {
    registerActiveCommand({ pid: 111, label: 'node run-image.mjs', startedAt: NOW, platform: 'linux' });
    const note = buildCommandResourceNoteText({ durationMs: 31_000 }, snapshotOf(), listActiveCommands());
    assert.ok(note && note.includes('同机另有 1 条命令在跑'));
  });
});

describe('prompt rendering entry point', () => {
  test('renders from the injected snapshot and respects the disable flag', () => {
    setMachineResourceSnapshotForTest(snapshotOf());
    const rendered = renderMachineResourcesForPrompt();
    assert.ok(rendered && rendered.includes('[本机资源]') && rendered.includes('CPU 2 核'));

    process.env.XIAOBA_MACHINE_RESOURCES = 'off';
    assert.equal(renderMachineResourcesForPrompt(), undefined);
  });
});

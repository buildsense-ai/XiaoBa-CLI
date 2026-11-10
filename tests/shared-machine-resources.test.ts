import { describe, test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CATSCO_LIMITS_FUTURE_SKEW_MS,
  CATSCO_LIMITS_MAX_AGE_MS,
  CATSCO_LIMITS_PATH_ENV,
  buildCommandResourceNote,
  buildCommandResourceNoteText,
  buildMachineResourceLines,
  buildSharedAgentCommandNoteText,
  cgroupAncestorDirs,
  collectMachineResourceSnapshot,
  formatTimestampUtc,
  isSharedAgentEnvironment,
  parseCatscoLimits,
  parseCgroupCpuMax,
  parseCgroupMemoryLimit,
  readCatscoLimitsView,
  readEffectiveServiceLimits,
  renderMachineResourcesForPrompt,
  setMachineResourceSnapshotForTest,
  __resetMachineResourceCacheForTest,
  type MachineResourceSnapshot,
} from '../src/utils/machine-resources';
import { buildRuntimeContextText } from '../src/core/runtime-context-builder';
import { ShellTool } from '../src/tools/bash-tool';
import { ToolExecutionContext } from '../src/types/tool';
import { clearActiveCommandsForTest } from '../src/utils/active-commands';

const GIB = 1024 ** 3;
const NOW = 1_700_000_000_000;

const CGROUP_SELF = '/system.slice/catsco-agent.service';
const CGROUP_ROOT = '/sys/fs/cgroup';

interface IoFiles {
  [file: string]: string;
}

function makeIo(files: IoFiles, overrides: Partial<{
  platform: NodeJS.Platform;
  dirs: string[];
  totalmem: number;
  freemem: number;
  cpuCount: number;
}> = {}) {
  const dirs = new Set(overrides.dirs || []);
  return {
    platform: overrides.platform ?? ('linux' as NodeJS.Platform),
    readFileSync: (file: string) => {
      const content = files[file];
      if (content === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${file}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
    readdirSync: (dir: string) => {
      if (!dirs.has(dir)) {
        const error = new Error(`ENOENT: no such file or directory, scandir '${dir}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    },
    totalmem: () => overrides.totalmem ?? 750 * GIB,
    freemem: () => overrides.freemem ?? 700 * GIB,
    cpus: () => Array.from({ length: overrides.cpuCount ?? 8 }, () => ({})),
    loadavg: () => [0.4, 0.3, 0.2],
  };
}

/** Production shape: 8-core / 750G host, agent limited to 2 cores and 4GiB. */
function productionFiles(extra: IoFiles = {}): IoFiles {
  return {
    '/proc/meminfo': 'MemTotal: 786432000 kB\nMemAvailable: 734003200 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    '/proc/self/cgroup': `0::${CGROUP_SELF}\n`,
    [`${CGROUP_ROOT}/cpu.max`]: 'max 100000\n',
    [`${CGROUP_ROOT}/memory.max`]: 'max\n',
    [`${CGROUP_ROOT}/system.slice/cpu.max`]: 'max 100000\n',
    [`${CGROUP_ROOT}/system.slice/memory.max`]: `${(4.25 * GIB).toFixed(0)}\n`,
    [`${CGROUP_ROOT}/system.slice/memory.current`]: `${Math.round(1.5 * GIB)}\n`,
    [`${CGROUP_ROOT}${CGROUP_SELF}/cpu.max`]: '200000 100000\n',
    [`${CGROUP_ROOT}${CGROUP_SELF}/memory.max`]: `${4 * GIB}\n`,
    [`${CGROUP_ROOT}${CGROUP_SELF}/memory.stat`]: 'anon 150000000\nfile 90000000\n',
    [`${CGROUP_ROOT}${CGROUP_SELF}/memory.current`]: `${Math.round(1.4 * GIB)}\n`,
    ...extra,
  };
}

function limitsPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    source: 'packed-schedd',
    updatedAt: new Date(NOW - 10_000).toISOString(),
    disk: {
      mounts: [
        { path: '/', quotaBytes: 4 * GIB, usedBytes: 3 * GIB, availableBytes: 1 * GIB, source: 'btrfs-qgroup' },
        { path: '/srv/catsco-agent', quotaBytes: 24 * GIB, usedBytes: 10 * GIB, availableBytes: 14 * GIB, source: 'btrfs-qgroup' },
      ],
    },
    ...overrides,
  });
}

function sharedSnapshot(overrides: Partial<MachineResourceSnapshot> = {}): MachineResourceSnapshot {
  return {
    platform: 'linux',
    cpuCount: 8,
    totalMemoryBytes: 750 * GIB,
    availableMemoryBytes: 700 * GIB,
    sampledAt: NOW,
    sharedAgent: true,
    serviceCpuCores: 2,
    serviceCpuQuotaText: '200000/100000',
    serviceCpuUnlimited: false,
    serviceMemoryLimitBytes: 4 * GIB,
    serviceMemoryUnlimited: false,
    serviceMemoryUsedBytes: 1.4 * GIB,
    serviceMemoryAvailableBytes: 2.6 * GIB,
    sharedDisk: parseCatscoLimits(limitsPayload(), NOW),
    ...overrides,
  };
}

let savedLimitsPath: string | undefined;

beforeEach(() => {
  savedLimitsPath = process.env[CATSCO_LIMITS_PATH_ENV];
  delete process.env[CATSCO_LIMITS_PATH_ENV];
});

afterEach(() => {
  clearActiveCommandsForTest();
  __resetMachineResourceCacheForTest();
  delete process.env.XIAOBA_MACHINE_RESOURCES;
  delete process.env[CATSCO_LIMITS_PATH_ENV];
  if (savedLimitsPath !== undefined) process.env[CATSCO_LIMITS_PATH_ENV] = savedLimitsPath;
});

describe('cgroup v2 effective quota chain', () => {
  test('parses cpu.max quota, unlimited and garbage', () => {
    assert.deepEqual(parseCgroupCpuMax('200000 100000\n'), { quota: 200000, period: 100000 });
    assert.deepEqual(parseCgroupCpuMax('max 100000'), { quota: null, period: 100000 });
    assert.equal(parseCgroupCpuMax('150000'), undefined);
    for (const invalid of ['200000x 100000', '200000 100000x', '0 100000', 'max 100000 extra']) {
      assert.equal(parseCgroupCpuMax(invalid), undefined);
    }
    assert.equal(parseCgroupCpuMax(''), undefined);
    assert.equal(parseCgroupCpuMax('nonsense 100000'), undefined);
    assert.equal(parseCgroupCpuMax('200000 0'), undefined);
    assert.equal(parseCgroupCpuMax('-5 100000'), undefined);
  });

  test('parses memory limits and keeps "max" distinct from junk', () => {
    assert.equal(parseCgroupMemoryLimit('4294967296\n'), 4 * GIB);
    assert.equal(parseCgroupMemoryLimit('max\n'), null);
    assert.equal(parseCgroupMemoryLimit('1.5G'), undefined);
    assert.equal(parseCgroupMemoryLimit(''), undefined);
  });

  test('never leaves the cgroup mount root, whatever the self path says', () => {
    assert.deepEqual(cgroupAncestorDirs(CGROUP_SELF), [
      `${CGROUP_ROOT}${CGROUP_SELF}`,
      `${CGROUP_ROOT}/system.slice`,
      CGROUP_ROOT,
    ]);
    assert.deepEqual(cgroupAncestorDirs(undefined), []);
    assert.deepEqual(cgroupAncestorDirs('/../../etc'), []);
    assert.deepEqual(cgroupAncestorDirs('/system.slice/../../etc'), []);
    assert.deepEqual(cgroupAncestorDirs('/system.slice\\..\\etc'), []);
  });

  test('host 8 cores with quota 2 reports two effective cores only', () => {
    const io = makeIo(productionFiles(), { cpuCount: 8 });
    const snapshot = collectMachineResourceSnapshot(io);

    assert.equal(snapshot.cpuCount, 8, 'host core count stays a raw fact');
    assert.equal(snapshot.sharedAgent, true);
    assert.equal(snapshot.serviceCpuCores, 2);
    assert.equal(snapshot.serviceCpuQuotaText, '200000/100000');

    const lines = buildMachineResourceLines(snapshot, [], NOW, () => undefined);
    const text = lines.join('\n');
    assert.ok(text.includes('CPU 有效 2 核'), text);
    assert.ok(!text.includes('CPU 8 核'), text);
    assert.ok(text.includes('不是宿主 nproc'), text);
  });

  test('takes the tightest limit across the ancestor chain', () => {
    const files = productionFiles({
      [`${CGROUP_ROOT}${CGROUP_SELF}/cpu.max`]: '400000 100000\n',
      [`${CGROUP_ROOT}/system.slice/cpu.max`]: '200000 100000\n',
      [`${CGROUP_ROOT}${CGROUP_SELF}/memory.max`]: `${6 * GIB}\n`,
      [`${CGROUP_ROOT}/system.slice/memory.max`]: `${4.25 * GIB}\n`,
    });
    const limits = readEffectiveServiceLimits(makeIo(files), CGROUP_SELF);
    assert.equal(limits.cpuCores, 2, 'parent quota 2 < self quota 4');
    assert.equal(limits.memoryLimitBytes, 4.25 * GIB, 'parent limit is tighter than self');
  });

  test('memory.high stays separate from hard-limit headroom, including above the pressure threshold', () => {
    const files = productionFiles({
      [`${CGROUP_ROOT}${CGROUP_SELF}/memory.high`]: `${Math.round(3 * GIB)}\n`,
    });
    const limits = readEffectiveServiceLimits(makeIo(files), CGROUP_SELF, 700 * GIB);
    assert.equal(limits.memoryLimitBytes, 4 * GIB);
    assert.equal(limits.memoryHighBytes, 3 * GIB);
    assert.equal(limits.memoryUsedBytes, Math.round(1.4 * GIB));
    assert.equal(limits.memoryAvailableBytes, Math.round(4 * GIB) - Math.round(1.4 * GIB));
    files[`${CGROUP_ROOT}${CGROUP_SELF}/memory.current`] = `${Math.round(3.2 * GIB)}\n`;
    const pressured = readEffectiveServiceLimits(makeIo(files), CGROUP_SELF, 700 * GIB);
    assert.equal(pressured.memoryAvailableBytes, 4 * GIB - Math.round(3.2 * GIB));
    assert.equal(pressured.memoryHighBytes, 3 * GIB);
  });

  test('service memory limit (4G) beats the container limit (4.25G)', () => {
    const snapshot = collectMachineResourceSnapshot(makeIo(productionFiles()));
    assert.equal(snapshot.serviceMemoryLimitBytes, 4 * GIB);
    assert.equal(snapshot.serviceMemoryAvailableBytes, 4 * GIB - Math.round(1.4 * GIB));

    const text = buildMachineResourceLines(snapshot, [], NOW, () => undefined).join('\n');
    assert.ok(text.includes('内存 上限 4G'), text);
    assert.ok(!text.includes('4.3G'), 'the container reserve must not be shown as the limit');
    assert.ok(!text.includes('750G'), 'host total must not appear for a shared agent');
    assert.ok(text.includes('服务硬上限取 memory.max'), text);
  });

  test('host exhaustion caps the in-quota estimate', () => {
    const files = productionFiles({ '/proc/meminfo': 'MemTotal: 786432000 kB\nMemAvailable: 1048576 kB\n' });
    const snapshot = collectMachineResourceSnapshot(makeIo(files));
    assert.equal(snapshot.serviceMemoryAvailableBytes, 1 * GIB);
  });

  test('unlimited and missing quotas degrade to explicit unknown states', () => {
    const unlimited = makeIo({
      '/proc/meminfo': 'MemTotal: 8000000 kB\n',
      '/proc/self/cgroup': `0::${CGROUP_SELF}\n`,
      [`${CGROUP_ROOT}/cpu.max`]: 'max 100000\n',
      [`${CGROUP_ROOT}${CGROUP_SELF}/cpu.max`]: 'max 100000\n',
      [`${CGROUP_ROOT}${CGROUP_SELF}/memory.max`]: 'max\n',
      [`${CGROUP_ROOT}${CGROUP_SELF}/memory.high`]: 'max\n',
    });
    const snapshot = collectMachineResourceSnapshot(unlimited);
    assert.equal(snapshot.serviceCpuCores, undefined);
    assert.equal(snapshot.serviceCpuUnlimited, true);
    assert.equal(snapshot.serviceMemoryLimitBytes, undefined);
    assert.equal(snapshot.serviceMemoryUnlimited, true);
    const text = buildMachineResourceLines(snapshot, [], NOW, () => undefined).join('\n');
    assert.ok(text.includes('未设 memory.max 硬上限'), text);
    assert.ok(!text.includes('宿主 8 核'), text);
    assert.ok(text.includes('可用额度未知'), text);

    const missing = makeIo({
      '/proc/meminfo': 'MemTotal: 8000000 kB\n',
      '/proc/self/cgroup': `0::${CGROUP_SELF}\n`,
    });
    const missingSnapshot = collectMachineResourceSnapshot(missing);
    assert.equal(missingSnapshot.sharedAgent, true);
    assert.equal(missingSnapshot.serviceCpuCores, undefined);
    assert.equal(missingSnapshot.serviceCpuUnlimited, undefined);
    const missingText = buildMachineResourceLines(missingSnapshot, [], NOW, () => undefined).join('\n');
    assert.ok(missingText.includes('CPU 有效核数未知'), missingText);
    assert.ok(missingText.includes('内存 上限未知'), missingText);
  });

  test('ancestor usage and missing usage constrain hard-limit availability', () => {
    const files = productionFiles({
      [`${CGROUP_ROOT}/system.slice/memory.current`]: `${4 * GIB}\n`,
    });
    assert.equal(readEffectiveServiceLimits(makeIo(files), CGROUP_SELF).memoryAvailableBytes, 0.25 * GIB);
    delete files[`${CGROUP_ROOT}/system.slice/memory.current`];
    assert.equal(readEffectiveServiceLimits(makeIo(files), CGROUP_SELF).memoryAvailableBytes, undefined);
    files[`${CGROUP_ROOT}/system.slice/memory.current`] = '123junk';
    assert.equal(readEffectiveServiceLimits(makeIo(files), CGROUP_SELF).memoryAvailableBytes, undefined);
  });

  test('failed meminfo does not skip the service cgroup or expose host totals', () => {
    const files = productionFiles();
    delete files['/proc/meminfo'];
    const snapshot = collectMachineResourceSnapshot(makeIo(files));
    assert.equal(snapshot.sharedAgent, true);
    assert.equal(snapshot.serviceCpuCores, 2);
    assert.doesNotMatch(buildMachineResourceLines(snapshot, [], NOW).join('\n'), /750G|CPU 8 核/);
  });

  test('plain Linux and Windows hosts keep the host rendering', () => {
    const desktop = makeIo({
      '/proc/meminfo': 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\nSwapTotal: 2097152 kB\nSwapFree: 1048576 kB\n',
      '/proc/self/cgroup': '0::/user.slice/user-1000.slice/session-2.scope\n',
    }, { cpuCount: 4 });
    const snapshot = collectMachineResourceSnapshot(desktop);
    assert.equal(snapshot.sharedAgent, undefined);
    assert.equal(snapshot.sharedDisk, undefined);
    const lines = buildMachineResourceLines(snapshot, [], NOW, () => undefined);
    assert.match(lines[0], /^\[本机资源\]/);
    assert.ok(lines[0].includes('CPU 4 核'));
    assert.ok(!lines.join('\n').includes('共享云 Agent'));

    const windows = makeIo({}, { platform: 'win32', totalmem: 32 * GIB, freemem: 16 * GIB, cpuCount: 12 });
    const windowsSnapshot = collectMachineResourceSnapshot(windows);
    assert.equal(windowsSnapshot.sharedAgent, undefined);
    assert.match(buildMachineResourceLines(windowsSnapshot, [], NOW, () => undefined)[0], /^\[本机资源\]/);
  });

  test('shared detection follows the service cgroup, the run dir or the limits file', () => {
    const io = makeIo(productionFiles());
    assert.equal(isSharedAgentEnvironment(io, CGROUP_SELF), true);
    assert.equal(isSharedAgentEnvironment(io, '/user.slice/session.scope'), false);

    const runDirIo = makeIo({}, { dirs: ['/run/catsco'] });
    assert.equal(isSharedAgentEnvironment(runDirIo, undefined), true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-shared-detect-'));
    try {
      const limitsFile = path.join(tmp, 'limits.json');
      fs.writeFileSync(limitsFile, limitsPayload());
      process.env[CATSCO_LIMITS_PATH_ENV] = limitsFile;
      // Real filesystem: the injected-path reader only sees real files.
      const realIo = {
        platform: 'linux' as NodeJS.Platform,
        readFileSync: (file: string) => fs.readFileSync(file, 'utf8'),
        readdirSync: (dir: string) => fs.readdirSync(dir),
        totalmem: () => 8 * GIB,
        freemem: () => 4 * GIB,
        cpus: () => [1, 2],
        loadavg: () => [0, 0, 0],
      };
      assert.equal(isSharedAgentEnvironment(realIo, undefined), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scheduler disk quota file', () => {
  test('reads schema 2 mounts for the 4G root and 24G data disk', () => {
    const view = parseCatscoLimits(limitsPayload(), NOW);
    assert.equal(view.state, 'ok');
    if (view.state !== 'ok') return;
    assert.equal(view.legacy, false);
    assert.equal(view.schemaVersion, 2);
    const root = view.mounts.find(mount => mount.path === '/');
    const data = view.mounts.find(mount => mount.path === '/srv/catsco-agent');
    assert.equal(root?.label, '根盘');
    assert.equal(root?.quotaBytes, 4 * GIB);
    assert.equal(root?.availableBytes, 1 * GIB);
    assert.equal(data?.label, '数据盘');
    assert.equal(data?.quotaBytes, 24 * GIB);
    assert.equal(data?.availableBytes, 14 * GIB);
  });

  test('renders both disks as independent quotas and refuses host df numbers', () => {
    const text = buildMachineResourceLines(sharedSnapshot(), [], NOW, () => undefined).join('\n');
    assert.ok(text.includes('根盘 / 配额 4G、已用 3G、可用 1G'), text);
    assert.ok(text.includes('数据盘 /srv/catsco-agent 配额 24G'), text);
    assert.ok(text.includes('根盘与数据盘配额分别生效、可用空间不可相加'), text);
    assert.ok(text.includes('df、lsblk、nproc 都不能代表实际可用额度'), text);
    assert.ok(text.includes('采样 2023-11-14T'), text);
    assert.ok(!text.includes('750G'), text);
  });

  test('schema 2 nulls stay unknown and never fall back to legacy fields', () => {
    const payload = limitsPayload({
      disk: {
        mounts: [
          { path: '/', quotaBytes: null, usedBytes: null, availableBytes: null, source: 'btrfs-qgroup' },
          { path: '/srv/catsco-agent', quotaBytes: null, usedBytes: 5 * GIB, availableBytes: null, source: 'btrfs-qgroup' },
        ],
        volumeQuotaGB: 4,
        volumeUsedMB: 1024,
        path: '/',
      },
    });
    const view = parseCatscoLimits(payload, NOW);
    assert.equal(view.state, 'ok');
    if (view.state !== 'ok') return;
    const root = view.mounts.find(mount => mount.path === '/');
    assert.equal(root?.quotaBytes, undefined);
    assert.equal(root?.usedBytes, undefined);
    assert.equal(root?.availableBytes, undefined);

    const text = buildMachineResourceLines(sharedSnapshot({ sharedDisk: view }), [], NOW, () => undefined).join('\n');
    assert.ok(text.includes('根盘 / 额度未知'), text);
    assert.ok(!text.includes('配额 4G'), 'legacy volumeQuotaGB must not leak into schema 2');
    assert.ok(!text.includes('已用 1G'), 'legacy volumeUsedMB must not leak into schema 2');
  });

  test('legacy payloads expose only the quota ceiling', () => {
    const payload = JSON.stringify({
      source: 'packed-schedd',
      updatedAt: new Date(NOW - 5_000).toISOString(),
      disk: { volumeQuotaGB: 24, volumeUsedMB: 20480, path: '/srv/catsco-agent' },
    });
    const view = parseCatscoLimits(payload, NOW);
    assert.equal(view.state, 'ok');
    if (view.state !== 'ok') return;
    assert.equal(view.legacy, true);
    assert.equal(view.mounts.length, 1);
    assert.equal(view.mounts[0].quotaBytes, 24 * GIB);
    assert.equal(view.mounts[0].usedBytes, undefined, 'stale used value must not be trusted');

    const text = buildMachineResourceLines(sharedSnapshot({ sharedDisk: view }), [], NOW, () => undefined).join('\n');
    assert.ok(text.includes('配额 24G'), text);
    assert.ok(text.includes('剩余未知'), text);
    const diskText = text.split('\n').filter(line => line.startsWith('- 磁盘')).join('\n');
    assert.ok(!diskText.includes('已用'), diskText);
    assert.ok(!text.includes('20G'), 'volumeUsedMB must not surface as usage');
  });

  test('broken payloads become explicit unknown states', () => {
    const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
    const cases: Array<[string, string, string]> = [
      ['invalid-json', '{not json', '不是合法 JSON'],
      ['bad-source', JSON.stringify({ source: 'someone-else', updatedAt: at(0), disk: { volumeQuotaGB: 4 } }), 'packed-schedd'],
      ['bad-updated-at', JSON.stringify({ source: 'packed-schedd', disk: { volumeQuotaGB: 4 } }), 'updatedAt'],
      ['stale', JSON.stringify({ source: 'packed-schedd', updatedAt: at(-CATSCO_LIMITS_MAX_AGE_MS - 1_000), disk: { volumeQuotaGB: 4 } }), '已过期'],
      ['future', JSON.stringify({ source: 'packed-schedd', updatedAt: at(CATSCO_LIMITS_FUTURE_SKEW_MS + 60_000), disk: { volumeQuotaGB: 4 } }), '超前'],
      ['no-fields', JSON.stringify({ source: 'packed-schedd', updatedAt: at(0), disk: {} }), '缺少可用'],
      ['bad-number', limitsPayload({ disk: { mounts: [{ path: '/', quotaBytes: -4, availableBytes: 'lots' }] } }), '数值非法'],
      ['bad-number', limitsPayload({ disk: { mounts: [{ path: '/', quotaBytes: 4 * GIB, usedBytes: 3 * GIB, availableBytes: 2 * GIB }] } }), '数值非法'],
      ['bad-number', limitsPayload({ disk: { mounts: [{ path: '/', quotaBytes: null, availableBytes: 750 * GIB }] } }), '数值非法'],
      ['no-fields', limitsPayload({ disk: { mounts: [] } }), '缺少可用'],
    ];
    for (const [reason, payload, fragment] of cases) {
      const view = parseCatscoLimits(payload, NOW);
      assert.equal(view.state, 'unknown', `${reason} payload should be rejected`);
      if (view.state !== 'unknown') continue;
      assert.equal(view.reason, reason, `expected ${reason}, got ${view.reason}`);
      const text = buildMachineResourceLines(sharedSnapshot({ sharedDisk: view }), [], NOW, () => undefined).join('\n');
      assert.ok(text.includes('磁盘 未知'), text);
      assert.ok(text.includes(fragment), `"${fragment}" missing from: ${text}`);
      assert.ok(text.includes('不要用 df'), text);
      assert.ok(!text.includes('750G'), text);
    }
  });

  test('small future clock drift is tolerated', () => {
    const payload = JSON.stringify({
      source: 'packed-schedd',
      updatedAt: new Date(NOW + CATSCO_LIMITS_FUTURE_SKEW_MS - 1).toISOString(),
      disk: { volumeQuotaGB: 4 },
    });
    const view = parseCatscoLimits(payload, NOW);
    assert.equal(view.state, 'ok');
  });

  test('a shared machine without a readable limits file reports unknown disk', () => {
    const io = makeIo(productionFiles());
    const snapshot = collectMachineResourceSnapshot(io);
    assert.equal(snapshot.sharedAgent, true);
    assert.equal(snapshot.sharedDisk?.state, 'unknown');
    if (snapshot.sharedDisk?.state === 'unknown') assert.equal(snapshot.sharedDisk.reason, 'missing');
    const text = buildMachineResourceLines(snapshot, [], NOW, () => undefined).join('\n');
    assert.ok(text.includes('磁盘 未知（额度文件缺失'), text);
    assert.ok(!text.includes('750G'), text);
  });

  test('reads a real limits file through the injected path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-shared-limits-'));
    try {
      const limitsFile = path.join(tmp, 'limits.json');
      fs.writeFileSync(limitsFile, limitsPayload({ updatedAt: new Date().toISOString() }));
      process.env[CATSCO_LIMITS_PATH_ENV] = limitsFile;
      const io = {
        platform: 'linux' as NodeJS.Platform,
        readFileSync: (file: string) => fs.readFileSync(file, 'utf8'),
        readdirSync: (dir: string) => fs.readdirSync(dir),
        totalmem: () => 8 * GIB,
        freemem: () => 4 * GIB,
        cpus: () => [1, 2],
        loadavg: () => [0, 0, 0],
      };
      const view = readCatscoLimitsView(io);
      assert.equal(view.state, 'ok');
      if (view.state === 'ok') {
        assert.equal(view.mounts.length, 2);
        assert.equal(formatTimestampUtc(view.updatedAt)?.endsWith('Z'), true);
      }
      fs.rmSync(limitsFile);
      const missing = readCatscoLimitsView(io);
      assert.equal(missing.state, 'unknown');
      if (missing.state === 'unknown') assert.equal(missing.reason, 'missing');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an unreadable file is distinct from a missing one', () => {
    const io = {
      platform: 'linux' as NodeJS.Platform,
      readFileSync: () => {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
      readdirSync: () => [],
      totalmem: () => GIB,
      freemem: () => GIB,
      cpus: () => [1],
      loadavg: () => [0, 0, 0],
    };
    const view = readCatscoLimitsView(io);
    assert.equal(view.state, 'unknown');
    if (view.state === 'unknown') assert.equal(view.reason, 'unreadable');
  });
});

describe('shared agent surfaces', () => {
  test('runtime context carries the trusted quota instead of host totals', () => {
    setMachineResourceSnapshotForTest(sharedSnapshot());
    const text = buildRuntimeContextText(undefined, '/tmp/xiaoba-attachments');
    assert.ok(text.startsWith('[transient_runtime_context]'));
    assert.ok(text.includes('[本机资源·共享云 Agent]'), text);
    assert.ok(text.includes('CPU 有效 2 核'), text);
    assert.ok(text.includes('磁盘'), text);
    assert.ok(text.includes('采样 2023-11-14T'), text);
    assert.ok(!text.includes('CPU 8 核'), text);
    assert.ok(!text.includes('750G'), text);
    assert.ok(text.endsWith('[/transient_runtime_context]'));
  });

  test('the disable switch still turns the whole section off', () => {
    process.env.XIAOBA_MACHINE_RESOURCES = 'off';
    setMachineResourceSnapshotForTest(sharedSnapshot());
    assert.equal(renderMachineResourcesForPrompt(), undefined);
    assert.ok(!buildRuntimeContextText().includes('共享云 Agent'));
    // The text builder is pure; the env switch lives in the production entry points.
    assert.equal(buildCommandResourceNote({ durationMs: 1_000 }), undefined);
  });

  test('every shared shell note carries CPU, memory, disk and a timestamp', () => {
    const note = buildCommandResourceNoteText({ durationMs: 1_000, peakRssBytes: 10 * 1024 * 1024 }, sharedSnapshot(), []);
    assert.ok(note, 'shared agents always get a note');
    assert.ok(!note!.includes('\n'));
    assert.ok(note!.includes('共享云 Agent 额度'), note);
    assert.ok(note!.includes('CPU 2 核'), note);
    assert.ok(note!.includes('内存 上限 4G、可用约 2.6G'), note);
    assert.ok(note!.includes('根盘 可用 1G/配额 4G'), note);
    assert.ok(note!.includes('各挂载点配额不可相加'), note);
    assert.ok(note!.includes('采样 2023-11-14T'), note);
    assert.ok(note!.includes('本条耗时'), note);
    assert.ok(!note!.includes('750G'), note);
  });

  test('the shared shell note states unknown disk instead of guessing', () => {
    const note = buildSharedAgentCommandNoteText(
      { durationMs: 2_000 },
      sharedSnapshot({ sharedDisk: { state: 'unknown', reason: 'stale', updatedAt: NOW - 600_000 } }),
      [],
    );
    assert.ok(note.includes('磁盘 未知（额度文件已过期'), note);
    assert.ok(!note.includes('df'), 'the single-line note stays terse');
  });

  test('non-shared machines keep the trigger-only note', () => {
    const local: MachineResourceSnapshot = {
      platform: 'linux',
      cpuCount: 4,
      totalMemoryBytes: 16 * GIB,
      availableMemoryBytes: 12 * GIB,
      sampledAt: NOW,
    };
    assert.equal(buildCommandResourceNoteText({ durationMs: 1_000, peakRssBytes: 1024 }, local, []), undefined);
  });

  test('ShellTool always attaches the shared resource note to a real command', async () => {
    setMachineResourceSnapshotForTest(sharedSnapshot());
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-shared-shell-'));
    try {
      const context: ToolExecutionContext = {
        workingDirectory: testRoot,
        workspaceRoot: testRoot,
        conversationHistory: [],
        getCurrentDirectory: () => testRoot,
        updateCurrentDirectory: () => {},
      };
      const tool = new ShellTool();
      const result = await tool.execute({ command: 'echo shared-resource-note', timeout: 30_000 }, context);
      assert.equal(result.ok, true);
      const report = String(result.content || result.message || '');
      const noteLine = report.split('\n').find(line => line.startsWith('resource_note: '));
      assert.ok(noteLine, `resource_note missing from: ${report}`);
      assert.ok(noteLine!.includes('共享云 Agent 额度'), noteLine!);
      assert.ok(noteLine!.includes('磁盘'), noteLine!);
      assert.ok(!noteLine!.includes('750G'), noteLine!);
      assert.ok(report.includes('shared-resource-note'), 'the user command output is untouched');
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });
});

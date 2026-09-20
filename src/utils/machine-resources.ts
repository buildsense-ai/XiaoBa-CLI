/**
 * Live machine resource snapshot + prompt rendering for the resource-awareness layer.
 *
 * Every number is read from the host OS at runtime (never hardcoded), so each
 * machine reports its real shape — small self-hosted workers, beefy dev boxes,
 * Windows laptops — and the rendered guidance adapts to what is actually there.
 *
 * The layer stays factual by design: it gives the model raw resource facts
 * (memory, swap, load, heavy commands already running) and nothing else — no
 * advice, no limits. Set `XIAOBA_MACHINE_RESOURCES=off` to disable injection.
 */
import * as fs from 'fs';
import * as os from 'os';
import { listActiveCommands, type ActiveCommandEntry } from './active-commands';

export interface MachineResourceSnapshot {
  platform: NodeJS.Platform;
  cpuCount: number;
  totalMemoryBytes?: number;
  availableMemoryBytes?: number;
  swapTotalBytes?: number;
  swapFreeBytes?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  /**
   * Memory charged to the runtime's cgroup (cgroup v2). Prefers the anonymous
   * share from memory.stat (unreclaimable, i.e. what the runtime really holds)
   * and falls back to memory.current, which also counts page cache.
   */
  cgroupCurrentBytes?: number;
  sampledAt: number;
}

interface MachineResourceIo {
  platform: NodeJS.Platform;
  readFileSync: (file: string, encoding: 'utf8') => string;
  readdirSync: (dir: string) => string[];
  totalmem: () => number;
  freemem: () => number;
  cpus: () => unknown[];
  loadavg: () => number[];
}

const defaultIo: MachineResourceIo = {
  platform: process.platform,
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  readdirSync: dir => fs.readdirSync(dir),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  cpus: () => os.cpus(),
  loadavg: () => os.loadavg(),
};

export const COMMAND_NOTE_MIN_DURATION_MS = 30_000;
export const COMMAND_NOTE_RSS_RATIO = 0.15;
export const COMMAND_NOTE_MIN_RSS_BYTES = 256 * 1024 ** 2;
export const COMMAND_NOTE_LOW_AVAILABLE_RATIO = 0.2;

const DEFAULT_CACHE_TTL_MS = 5_000;

// ─── Pure parsers (unit-testable) ───────────────────────

export function parseMeminfo(text: string): {
  totalMemoryBytes?: number;
  availableMemoryBytes?: number;
  swapTotalBytes?: number;
  swapFreeBytes?: number;
} {
  const values = new Map<string, number>();
  for (const rawLine of text.split('\n')) {
    const match = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+(kB|MB))?/.exec(rawLine.trim());
    if (!match) continue;
    const value = Number.parseInt(match[2], 10);
    if (!Number.isFinite(value)) continue;
    const unit = match[3];
    const multiplier = unit === 'kB' ? 1024 : unit === 'MB' ? 1024 * 1024 : 1;
    values.set(match[1], value * multiplier);
  }
  return {
    totalMemoryBytes: values.get('MemTotal'),
    availableMemoryBytes: values.get('MemAvailable'),
    swapTotalBytes: values.get('SwapTotal'),
    swapFreeBytes: values.get('SwapFree'),
  };
}

export function parseLoadavg(text: string): number[] {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(value => Number.parseFloat(value))
    .filter(value => Number.isFinite(value));
}

export function parseCgroupV2SelfPath(text: string): string | undefined {
  for (const rawLine of text.split('\n')) {
    const parts = rawLine.trim().split(':');
    if (parts.length === 3 && parts[0] === '0' && parts[1] === '' && parts[2]) {
      return parts[2];
    }
  }
  return undefined;
}

// ─── Snapshot collection ────────────────────────────────

export function collectMachineResourceSnapshot(io: MachineResourceIo = defaultIo): MachineResourceSnapshot {
  const snapshot: MachineResourceSnapshot = {
    platform: io.platform,
    cpuCount: io.cpus().length,
    sampledAt: Date.now(),
  };

  snapshot.totalMemoryBytes = io.totalmem();
  snapshot.availableMemoryBytes = io.freemem();
  const loads = io.loadavg();
  if (loads.length >= 1) snapshot.load1 = loads[0];
  if (loads.length >= 2) snapshot.load5 = loads[1];
  if (loads.length >= 3) snapshot.load15 = loads[2];

  if (io.platform === 'linux') {
    try {
      const meminfo = parseMeminfo(io.readFileSync('/proc/meminfo', 'utf8'));
      if (meminfo.totalMemoryBytes !== undefined) snapshot.totalMemoryBytes = meminfo.totalMemoryBytes;
      if (meminfo.availableMemoryBytes !== undefined) snapshot.availableMemoryBytes = meminfo.availableMemoryBytes;
      snapshot.swapTotalBytes = meminfo.swapTotalBytes;
      snapshot.swapFreeBytes = meminfo.swapFreeBytes;

      const cgroupPath = parseCgroupV2SelfPath(io.readFileSync('/proc/self/cgroup', 'utf8'));
      if (cgroupPath) {
        const cgroupRoot = `/sys/fs/cgroup${cgroupPath}`;
        // memory.current includes reclaimable page cache, which would overstate
        // "self usage"; read the anonymous share from memory.stat instead and
        // only fall back to memory.current when memory.stat is unavailable.
        let chargedBytes: number | undefined;
        try {
          const anon = /(?:^|\n)anon (\d+)(?:\n|$)/.exec(io.readFileSync(`${cgroupRoot}/memory.stat`, 'utf8'));
          if (anon) chargedBytes = Number.parseInt(anon[1], 10);
        } catch {
          // Fall through to memory.current below.
        }
        if (chargedBytes === undefined) {
          chargedBytes = Number.parseInt(io.readFileSync(`${cgroupRoot}/memory.current`, 'utf8').trim(), 10);
        }
        if (Number.isFinite(chargedBytes) && chargedBytes >= 0) snapshot.cgroupCurrentBytes = chargedBytes;
      }
    } catch {
      // Best-effort only: a missing /proc or cgroup file must never break the runtime.
    }
  }

  return snapshot;
}

let cache: { snapshot: MachineResourceSnapshot; at: number } | null = null;
let testOverride: MachineResourceSnapshot | null = null;

function resolveCacheTtlMs(): number {
  const raw = Number.parseInt(String(process.env.XIAOBA_MACHINE_RESOURCES_TTL_MS || ''), 10);
  if (Number.isInteger(raw) && raw >= 0) return raw;
  return DEFAULT_CACHE_TTL_MS;
}

export function getMachineResourceSnapshot(): MachineResourceSnapshot {
  if (testOverride) return testOverride;

  const now = Date.now();
  if (!cache || now - cache.at >= resolveCacheTtlMs()) {
    let snapshot: MachineResourceSnapshot;
    try {
      snapshot = collectMachineResourceSnapshot();
    } catch {
      snapshot = { platform: process.platform, cpuCount: os.cpus().length, sampledAt: now };
    }
    cache = { snapshot, at: now };
  }
  return cache.snapshot;
}

export function isMachineResourcesDisabled(): boolean {
  const raw = String(process.env.XIAOBA_MACHINE_RESOURCES || '').trim().toLowerCase();
  return ['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

// ─── Process RSS sampling (POSIX) ───────────────────────

export function sampleProcessGroupRssByGroup(processGroupIds: number[]): Map<number, number> {
  const totals = new Map<number, number>();
  if (process.platform !== 'linux') return totals;
  const wanted = new Set(processGroupIds.filter(id => Number.isInteger(id) && id > 0));
  if (wanted.size === 0) return totals;

  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return totals;
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const closing = stat.lastIndexOf(')');
      if (closing < 0) continue;
      const fields = stat.slice(closing + 2).split(' ');
      const pgrp = Number.parseInt(fields[2], 10);
      if (!wanted.has(pgrp)) continue;

      const status = fs.readFileSync(`/proc/${name}/status`, 'utf8');
      const rss = /VmRSS:\s+(\d+)\s+kB/.exec(status);
      if (rss) {
        totals.set(pgrp, (totals.get(pgrp) ?? 0) + Number.parseInt(rss[1], 10) * 1024);
      }
    } catch {
      // Process vanished mid-scan; skip it.
    }
  }
  return totals;
}

/**
 * One pass over /proc even when several groups are requested; batching keeps
 * the synchronous scan off the hot path when multiple commands are rendered
 * at once.
 */
export function sampleProcessGroupRssBytes(processGroupId: number): number | undefined {
  return sampleProcessGroupRssByGroup([processGroupId]).get(processGroupId);
}

/**
 * Start time of a process (field 22 of /proc/<pid>/stat, clock ticks since
 * boot), parsed after the comm field — which may itself contain spaces and
 * parentheses — so plain whitespace splitting on the full line stays safe.
 */
export function parseProcessStatStartTime(statText: string): number | undefined {
  const closing = statText.lastIndexOf(')');
  if (closing < 0) return undefined;
  const fields = statText.slice(closing + 2).split(' ');
  const startTime = Number.parseInt(fields[19], 10);
  return Number.isFinite(startTime) ? startTime : undefined;
}

/**
 * Reads a process' spawn identity. A recycled pid can never report the same
 * start time, which is what makes this suitable for guarding kills against
 * pid reuse.
 */
export function readPosixProcessStartTime(pid: number): number | undefined {
  if (process.platform !== 'linux') return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    return parseProcessStatStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

// ─── Formatting ─────────────────────────────────────────

export function formatBytesCompact(bytes: number | undefined): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes === 0) return '0';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${formatScaledValue(gib)}G`;
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) return `${formatScaledValue(mib)}M`;
  const kib = bytes / 1024;
  return `${Math.max(1, Math.round(kib))}K`;
}

function formatScaledValue(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded >= 10 || Number.isInteger(rounded)) return String(Math.round(rounded));
  return rounded.toFixed(1);
}

export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知时长';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}

// ─── Prompt rendering ───────────────────────────────────

export function buildMachineResourceLines(
  snapshot: MachineResourceSnapshot,
  commands: ActiveCommandEntry[],
  now: number = Date.now(),
  sampleRss: (pgid: number) => number | undefined = sampleProcessGroupRssBytes,
): string[] {
  const parts: string[] = [];
  if (snapshot.cpuCount > 0) parts.push(`CPU ${snapshot.cpuCount} 核`);

  const totalText = formatBytesCompact(snapshot.totalMemoryBytes);
  const availableText = formatBytesCompact(snapshot.availableMemoryBytes);
  if (totalText) parts.push(availableText ? `内存 ${totalText}（可用 ${availableText}）` : `内存 ${totalText}`);

  const swapTotalText = formatBytesCompact(snapshot.swapTotalBytes);
  if (swapTotalText && snapshot.swapTotalBytes !== undefined && snapshot.swapTotalBytes > 0 && snapshot.swapFreeBytes !== undefined) {
    const swapUsedBytes = snapshot.swapTotalBytes - snapshot.swapFreeBytes;
    const swapUsedText = swapUsedBytes > 0 ? formatBytesCompact(swapUsedBytes) : undefined;
    parts.push(swapUsedText ? `Swap ${swapTotalText}（已用 ${swapUsedText}）` : `Swap ${swapTotalText}`);
  }

  // Node reports loadavg as [0, 0, 0] on Windows, where it is meaningless; skip it there.
  if (snapshot.platform !== 'win32' && typeof snapshot.load1 === 'number' && Number.isFinite(snapshot.load1)) {
    parts.push(`负载 ${snapshot.load1.toFixed(2)}`);
  }

  const cgroupText = formatBytesCompact(snapshot.cgroupCurrentBytes);
  if (cgroupText) parts.push(`XiaoBa 自身占用 ${cgroupText}`);

  const lines: string[] = [];
  if (parts.length > 0) lines.push(`[本机资源]（实时读取）${parts.join(' | ')}`);

  if (commands.length > 0) {
    const rendered = commands.slice(0, 3).map((command, index) => {
      const rssText = formatBytesCompact(sampleRss(command.pid));
      const ageText = formatDurationCompact(Math.max(0, now - command.startedAt));
      // Quotes mark the label as data; labels are already single-line and
      // bounded, so they cannot fake new lines inside the resource block.
      return `${index + 1}) 「${command.label}」（已运行 ${ageText}${rssText ? `，RSS ${rssText}` : ''}）`;
    });
    lines.push(`本机正在运行 ${commands.length} 条命令：${rendered.join('；')}`);
  }

  return lines;
}

export function renderMachineResourcesForPrompt(): string | undefined {
  if (isMachineResourcesDisabled()) return undefined;
  try {
    const snapshot = getMachineResourceSnapshot();
    const commands = listActiveCommands();
    const rssByGroup = sampleProcessGroupRssByGroup(commands.map(command => command.pid));
    const lines = buildMachineResourceLines(snapshot, commands, Date.now(), pid => rssByGroup.get(pid));
    return lines.length > 0 ? lines.join('\n') : undefined;
  } catch {
    return undefined;
  }
}

// ─── Command result footnote ────────────────────────────

export interface CommandResourceStats {
  durationMs: number;
  peakRssBytes?: number;
}

export function buildCommandResourceNoteText(
  stats: CommandResourceStats,
  snapshot: MachineResourceSnapshot,
  commands: ActiveCommandEntry[],
): string | undefined {
  const total = snapshot.totalMemoryBytes;
  const available = snapshot.availableMemoryBytes;

  const rssTrigger = stats.peakRssBytes !== undefined
    && stats.peakRssBytes >= Math.max(
      COMMAND_NOTE_MIN_RSS_BYTES,
      total !== undefined ? total * COMMAND_NOTE_RSS_RATIO : 0,
    );
  const durationTrigger = stats.durationMs >= COMMAND_NOTE_MIN_DURATION_MS;
  const lowAvailableTrigger = total !== undefined
    && available !== undefined
    && available <= total * COMMAND_NOTE_LOW_AVAILABLE_RATIO;

  if (!rssTrigger && !durationTrigger && !lowAvailableTrigger) return undefined;

  const parts: string[] = [];
  const totalText = formatBytesCompact(total);
  const availableText = formatBytesCompact(available);
  if (totalText) parts.push(availableText ? `本机可用 ${availableText}/${totalText}` : `本机内存 ${totalText}`);
  else if (availableText) parts.push(`本机可用 ${availableText}`);

  if (snapshot.swapTotalBytes !== undefined && snapshot.swapFreeBytes !== undefined) {
    const usedBytes = snapshot.swapTotalBytes - snapshot.swapFreeBytes;
    const usedText = usedBytes > 0 ? formatBytesCompact(usedBytes) : undefined;
    const swapTotalText = formatBytesCompact(snapshot.swapTotalBytes);
    if (usedText && swapTotalText) parts.push(`Swap 已用 ${usedText}/${swapTotalText}`);
  }

  const durationText = formatDurationCompact(stats.durationMs);
  const rssText = formatBytesCompact(stats.peakRssBytes);
  parts.push(`本条耗时 ${durationText}${rssText ? `、峰值 RSS ${rssText}` : ''}`);

  if (commands.length > 0) {
    parts.push(`同机另有 ${commands.length} 条命令在跑`);
  }

  return parts.join('；');
}

export function buildCommandResourceNote(stats: CommandResourceStats): string | undefined {
  if (isMachineResourcesDisabled()) return undefined;
  try {
    return buildCommandResourceNoteText(stats, getMachineResourceSnapshot(), listActiveCommands());
  } catch {
    return undefined;
  }
}

// ─── Test hooks (test-only; production paths never call these) ──

export function setMachineResourceSnapshotForTest(snapshot: MachineResourceSnapshot | null): void {
  testOverride = snapshot;
  cache = null;
}

export function __resetMachineResourceCacheForTest(): void {
  testOverride = null;
  cache = null;
}

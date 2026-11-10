/**
 * Live machine resource snapshot + prompt rendering for the resource-awareness layer.
 *
 * Every number is read from the host OS at runtime (never hardcoded), so each
 * machine reports its real shape — small self-hosted workers, beefy dev boxes,
 * Windows laptops — and the rendered guidance adapts to what is actually there.
 *
 * Two shapes are rendered:
 *
 * - Local / Windows machines: host facts only (total memory, swap, load, heavy
 *   commands already running), exactly as before.
 * - Shared CatsCo cloud agents (`catsco-agent.service` cgroup or
 *   `/run/catsco/limits.json`): the service's own effective quota — tightest
 *   `cpu.max` and `memory.max` over the process cgroup and its ancestors,
 *   memory pressure thresholds and current usage, plus scheduler disk quotas. Host
 *   totals, `nproc` and `df` are never substituted there: they describe the
 *   shared host, not what this agent may actually use.
 *
 * The layer stays factual by design: it gives the model raw resource facts and
 * nothing else — no advice, no limits. Set `XIAOBA_MACHINE_RESOURCES=off` to
 * disable injection, and `XIAOBA_CATSCO_LIMITS_PATH` to point the disk quota
 * reader at another file (tests, staging).
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
  /**
   * Linux: true when this process runs on a shared CatsCo cloud agent (the
   * `catsco-agent` service cgroup, `/run/catsco`, or a limits file). Only then
   * are the service-quota numbers below rendered instead of host totals.
   */
  sharedAgent?: boolean;
  /** Effective cores from the tightest `cpu.max` in the cgroup ancestor chain. */
  serviceCpuCores?: number;
  /** Raw `quota/period` of the tightest `cpu.max`, for display. */
  serviceCpuQuotaText?: string;
  /** True when `cpu.max` says `max` and no ancestor sets a quota. */
  serviceCpuUnlimited?: boolean;
  /** Tightest finite memory.max across the ancestor chain. */
  serviceMemoryLimitBytes?: number;
  /** Tightest finite memory.high pressure threshold (not a hard limit). */
  serviceMemoryHighBytes?: number;
  /** True when a readable memory.max is max and no finite limit was found. */
  serviceMemoryUnlimited?: boolean;
  /** `memory.current` of this process' own cgroup (includes page cache). */
  serviceMemoryUsedBytes?: number;
  /** Headroom inside the service memory limit, capped by host availability. */
  serviceMemoryAvailableBytes?: number;
  /** Scheduler-reported disk quota; `unknown` means "do not guess with df". */
  sharedDisk?: SharedDiskView;
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

// ─── Shared CatsCo cloud agent quotas ───────────────────
//
// A shared cloud worker runs many agent services on one host. Host totals,
// `nproc` and `df` therefore describe somebody else's capacity: the agent may
// only use its own cgroup quota plus the disk quota the packer/scheduler hands
// out. These helpers read exactly that and nothing else.

export const CATSCO_RUN_DIR = '/run/catsco';
export const CATSCO_LIMITS_PATH = '/run/catsco/limits.json';
export const CATSCO_LIMITS_PATH_ENV = 'XIAOBA_CATSCO_LIMITS_PATH';
export const CATSCO_LIMITS_SOURCE = 'packed-schedd';
/** Scheduler quota files older than this stop being trustworthy. */
export const CATSCO_LIMITS_MAX_AGE_MS = 120_000;
/** Small clock drift between writer and reader is tolerated; a stale-looking
 *  timestamp in the future beyond this is treated as invalid instead. */
export const CATSCO_LIMITS_FUTURE_SKEW_MS = 5_000;
export const CGROUP_V2_ROOT = '/sys/fs/cgroup';
export const CATSCO_ROOT_DISK_PATH = '/';
export const CATSCO_DATA_DISK_PATH = '/srv/catsco-agent';

export interface SharedDiskMount {
  /** Mount point as reported by the scheduler. */
  path: string;
  /** Human label (`根盘` / `数据盘` / the raw path). */
  label: string;
  quotaBytes?: number;
  usedBytes?: number;
  availableBytes?: number;
  /** Legacy payload: only the quota ceiling is trustworthy, never usage. */
  quotaOnly?: boolean;
}

export type SharedDiskUnknownReason =
  | 'missing'
  | 'unreadable'
  | 'invalid-json'
  | 'bad-source'
  | 'bad-updated-at'
  | 'bad-number'
  | 'stale'
  | 'future'
  | 'no-fields';

export type SharedDiskView =
  | { state: 'ok'; mounts: SharedDiskMount[]; updatedAt: number; schemaVersion?: number; legacy: boolean }
  | { state: 'unknown'; reason: SharedDiskUnknownReason; updatedAt?: number };

const UNKNOWN_DISK_REASON_TEXT: Record<SharedDiskUnknownReason, string> = {
  missing: '额度文件缺失',
  unreadable: '额度文件不可读',
  'invalid-json': '额度文件不是合法 JSON',
  'bad-source': `额度文件 source 不是 ${CATSCO_LIMITS_SOURCE}`,
  'bad-updated-at': '额度文件缺少可解析的 updatedAt',
  'bad-number': '额度文件数值非法（需为非负有限数）',
  stale: `额度文件已过期（超过 ${Math.round(CATSCO_LIMITS_MAX_AGE_MS / 1000)} 秒未更新）`,
  future: '额度文件 updatedAt 超前本地时钟',
  'no-fields': '额度文件缺少可用的 disk 字段',
};

export interface EffectiveServiceLimits {
  cpuCores?: number;
  cpuQuotaText?: string;
  cpuUnlimited?: boolean;
  memoryLimitBytes?: number;
  memoryHighBytes?: number;
  memoryUnlimited?: boolean;
  memoryUsedBytes?: number;
  memoryAvailableBytes?: number;
}

export function resolveCatscoLimitsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env[CATSCO_LIMITS_PATH_ENV] || '').trim();
  return override || CATSCO_LIMITS_PATH;
}

function readTextFile(io: MachineResourceIo, file: string): string | undefined {
  try {
    return io.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * cgroup v2 directories for this process, deepest first, ending at the mount
 * root. Anything that could climb out of `/sys/fs/cgroup` (`..`, backslashes,
 * NUL) yields no directories at all: a hostile or malformed file must not turn
 * into an arbitrary path read.
 */
export function cgroupAncestorDirs(cgroupRelPath: string | undefined): string[] {
  const raw = String(cgroupRelPath || '');
  if (raw.trim() === '' || raw.includes('\\') || raw.includes('\u0000')) return [];
  const parts = raw.split('/').filter(part => part !== '' && part !== '.');
  if (parts.some(part => part === '..')) return [];
  const dirs = [CGROUP_V2_ROOT];
  let current = CGROUP_V2_ROOT;
  for (const part of parts) {
    current = `${current}/${part}`;
    dirs.push(current);
  }
  return dirs.reverse();
}

/** `200000 100000` → 2 cores; `max 100000` → unlimited; garbage → undefined. */
export function parseCgroupCpuMax(text: string): { quota: number | null; period: number } | undefined {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return undefined;
  const period = Number(parts[1]);
  if (!Number.isSafeInteger(period) || period <= 0) return undefined;
  if (parts[0] === 'max') return { quota: null, period };
  if (!/^\d+$/.test(parts[0])) return undefined;
  const quota = Number(parts[0]);
  if (!Number.isSafeInteger(quota) || quota <= 0) return undefined;
  return { quota, period };
}

/** Bytes for a numeric limit, `null` for `max` (no limit), undefined for junk. */
export function parseCgroupMemoryLimit(text: string): number | null | undefined {
  const value = String(text || '').trim();
  if (value === '') return undefined;
  if (value === 'max') return null;
  if (!/^\d+$/.test(value)) return undefined;
  const bytes = Number.parseInt(value, 10);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}

/**
 * Tightest effective quota for this process: walks its own cgroup and every
 * ancestor up to the mount root, taking the smallest finite value of
 * cpu.max and memory.max; memory.high is a separate pressure threshold.
 * Available memory is the smallest headroom at every finite ancestor hard
 * limit, using that ancestor's own memory.current. Missing usage at a
 * constrained level keeps availability unknown. Host availability can only
 * reduce this estimate; memory.high does not impose a hard capacity limit.
 */
export function readEffectiveServiceLimits(
  io: MachineResourceIo,
  cgroupRelPath: string | undefined,
  hostAvailableBytes?: number,
): EffectiveServiceLimits {
  const limits: EffectiveServiceLimits = {};
  const dirs = cgroupAncestorDirs(cgroupRelPath);
  if (dirs.length === 0) return limits;

  let cpuQuotaFound = false;
  let cpuUnlimitedSeen = false;
  let memoryLimitFound = false;
  let memoryUnlimitedSeen = false;
  let memoryHeadroom: number | undefined;
  let memoryHeadroomUnknown = false;

  for (const dir of dirs) {
    const cpuText = readTextFile(io, `${dir}/cpu.max`);
    if (cpuText !== undefined) {
      const parsed = parseCgroupCpuMax(cpuText);
      if (parsed) {
        if (parsed.quota === null) {
          cpuUnlimitedSeen = true;
        } else {
          const cores = parsed.quota / parsed.period;
          if (limits.cpuCores === undefined || cores < limits.cpuCores) {
            limits.cpuCores = cores;
            limits.cpuQuotaText = `${parsed.quota}/${parsed.period}`;
          }
          cpuQuotaFound = true;
        }
      }
    }
    for (const name of ['memory.max', 'memory.high'] as const) {
      const current = parseCgroupMemoryLimit(readTextFile(io, `${dir}/memory.current`) ?? '');
      const memoryText = readTextFile(io, `${dir}/${name}`);
      if (memoryText === undefined) continue;
      const parsed = parseCgroupMemoryLimit(memoryText);
      if (parsed === null) {
        if (name === 'memory.max') memoryUnlimitedSeen = true;
      } else if (parsed !== undefined) {
        if (name === 'memory.max') {
          limits.memoryLimitBytes = Math.min(limits.memoryLimitBytes ?? parsed, parsed);
          memoryLimitFound = true;
          if (typeof current !== 'number') memoryHeadroomUnknown = true;
          else memoryHeadroom = Math.min(memoryHeadroom ?? Infinity, Math.max(0, parsed - current));
        } else {
          limits.memoryHighBytes = Math.min(limits.memoryHighBytes ?? parsed, parsed);
        }
      }
    }
  }

  const currentText = readTextFile(io, `${dirs[0]}/memory.current`);
  if (currentText !== undefined) {
    const used = parseCgroupMemoryLimit(currentText);
    if (typeof used === 'number') limits.memoryUsedBytes = used;
  }

  limits.cpuUnlimited = cpuQuotaFound ? false : cpuUnlimitedSeen ? true : undefined;
  limits.memoryUnlimited = memoryLimitFound ? false : memoryUnlimitedSeen ? true : undefined;

  if (!memoryHeadroomUnknown && memoryHeadroom !== undefined) {
    let available = memoryHeadroom;
    if (typeof hostAvailableBytes === 'number' && Number.isFinite(hostAvailableBytes)) {
      available = Math.min(available, Math.max(0, hostAvailableBytes));
    }
    limits.memoryAvailableBytes = available;
  }
  return limits;
}

/**
 * Shared-agent detection. The worker image ships `catsco-agent.service`, so the
 * service cgroup name is the durable signal; `/run/catsco` and the limits file
 * are checked too so the flag survives a scheduling hiccup. A plain desktop or
 * a Windows box matches none of them and keeps the host rendering.
 */
export function isSharedAgentEnvironment(io: MachineResourceIo, cgroupRelPath: string | undefined): boolean {
  if (typeof cgroupRelPath === 'string' && /catsco/i.test(cgroupRelPath)) return true;
  try {
    io.readdirSync(CATSCO_RUN_DIR);
    return true;
  } catch {
    // Not a cloud worker directory (or unreadable): fall through.
  }
  return readTextFile(io, resolveCatscoLimitsPath()) !== undefined;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Epoch ms, epoch seconds or an ISO string — anything else is unparsable. */
export function parseLimitsTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (/^\d+$/.test(trimmed)) {
      const epoch = Number.parseInt(trimmed, 10);
      return epoch < 1e11 ? epoch * 1000 : epoch;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function labelForMountPath(mountPath: string): string {
  if (mountPath === CATSCO_ROOT_DISK_PATH) return '根盘';
  if (mountPath === CATSCO_DATA_DISK_PATH) return '数据盘';
  return mountPath;
}

function parseSchemaMounts(entries: unknown[]): { mounts: SharedDiskMount[]; badNumber: boolean } {
  const mounts: SharedDiskMount[] = [];
  let badNumber = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const mountPath = typeof record.path === 'string' ? record.path.trim() : '';
    if (!mountPath) continue;
    const mount: SharedDiskMount = { path: mountPath, label: labelForMountPath(mountPath) };
    for (const key of ['quotaBytes', 'usedBytes', 'availableBytes'] as const) {
      const value = record[key];
      if (value === null || value === undefined) continue;
      if (!isFiniteNonNegative(value)) {
        // A present-but-invalid number is a broken payload, not "unknown".
        badNumber = true;
        continue;
      }
      mount[key] = value;
    }
    if (mount.availableBytes !== undefined) {
      if (mount.quotaBytes === undefined
        || mount.availableBytes > mount.quotaBytes
        || (mount.usedBytes !== undefined && mount.availableBytes > Math.max(0, mount.quotaBytes - mount.usedBytes))) {
        badNumber = true;
      }
    }
    mounts.push(mount);
  }
  return { mounts, badNumber };
}

function parseLegacyDiskMount(disk: Record<string, unknown>): SharedDiskMount | undefined {
  // Schema 1 only ever carried the quota ceiling; `volumeUsedMB` is a stale
  // sample from scheduling time, so it is never rendered as free space.
  const quotaGb = disk.volumeQuotaGB;
  if (!isFiniteNonNegative(quotaGb)) return undefined;
  const rawPath = typeof disk.path === 'string' ? disk.path.trim() : '';
  const mountPath = rawPath || CATSCO_DATA_DISK_PATH;
  return {
    path: mountPath,
    label: labelForMountPath(mountPath),
    quotaBytes: quotaGb * 1024 ** 3,
    quotaOnly: true,
  };
}

/**
 * Strict decode of the packer/scheduler quota file.
 *
 * Rules that keep the view honest:
 * - the producer must identify itself (`source: 'packed-schedd'`);
 * - `updatedAt` must be fresh (≤2 min) and at most slightly in the future;
 * - numbers must be finite and non-negative;
 * - schema 2 `disk.mounts` wins outright: a `null` field there means unknown
 *   and never falls back to the legacy `volumeQuotaGB`/`volumeUsedMB` fields;
 * - a legacy payload only yields a quota ceiling (usage stays unknown).
 *
 * Anything rejected becomes `state: 'unknown'` so the renderer says "unknown"
 * instead of quietly printing host `df` numbers.
 */
export function parseCatscoLimits(text: string, now: number = Date.now()): SharedDiskView {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'unknown', reason: 'invalid-json' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'unknown', reason: 'invalid-json' };
  const record = raw as Record<string, unknown>;

  if (record.source !== CATSCO_LIMITS_SOURCE) return { state: 'unknown', reason: 'bad-source' };
  const updatedAt = parseLimitsTimestamp(record.updatedAt);
  if (updatedAt === undefined) return { state: 'unknown', reason: 'bad-updated-at' };
  if (updatedAt > now + CATSCO_LIMITS_FUTURE_SKEW_MS) return { state: 'unknown', reason: 'future', updatedAt };
  if (now - updatedAt > CATSCO_LIMITS_MAX_AGE_MS) return { state: 'unknown', reason: 'stale', updatedAt };

  const schemaVersion = isFiniteNonNegative(record.schemaVersion) ? record.schemaVersion : undefined;
  const disk = record.disk;
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) {
    return { state: 'unknown', reason: 'no-fields', updatedAt };
  }
  const diskRecord = disk as Record<string, unknown>;

  if (Array.isArray(diskRecord.mounts)) {
    const { mounts, badNumber } = parseSchemaMounts(diskRecord.mounts);
    if (badNumber) return { state: 'unknown', reason: 'bad-number', updatedAt };
    if (mounts.length === 0) return { state: 'unknown', reason: 'no-fields', updatedAt };
    return { state: 'ok', mounts, updatedAt, schemaVersion, legacy: false };
  }

  // Schema 2 without `mounts` is incomplete: do not read leftover legacy keys.
  if (schemaVersion !== undefined && schemaVersion >= 2) {
    return { state: 'unknown', reason: 'no-fields', updatedAt };
  }
  for (const key of ['volumeQuotaGB', 'volumeUsedMB'] as const) {
    const value = diskRecord[key];
    if (value !== undefined && value !== null && !isFiniteNonNegative(value)) {
      return { state: 'unknown', reason: 'bad-number', updatedAt };
    }
  }
  const legacyMount = parseLegacyDiskMount(diskRecord);
  if (!legacyMount) return { state: 'unknown', reason: 'no-fields', updatedAt };
  return { state: 'ok', mounts: [legacyMount], updatedAt, schemaVersion, legacy: true };
}

export function readCatscoLimitsView(io: MachineResourceIo, now: number = Date.now()): SharedDiskView {
  const file = resolveCatscoLimitsPath();
  try {
    return parseCatscoLimits(io.readFileSync(file, 'utf8'), now);
  } catch (error) {
    const err = error as NodeJS.ErrnoException | undefined;
    const missing = err?.code === 'ENOENT' || /ENOENT|no such file/i.test(String(err?.message || ''));
    return { state: 'unknown', reason: missing ? 'missing' : 'unreadable' };
  }
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

  let cgroupPath: string | undefined;

  if (io.platform === 'linux') {
    try {
      const meminfo = parseMeminfo(io.readFileSync('/proc/meminfo', 'utf8'));
      if (meminfo.totalMemoryBytes !== undefined) snapshot.totalMemoryBytes = meminfo.totalMemoryBytes;
      if (meminfo.availableMemoryBytes !== undefined) snapshot.availableMemoryBytes = meminfo.availableMemoryBytes;
      snapshot.swapTotalBytes = meminfo.swapTotalBytes;
      snapshot.swapFreeBytes = meminfo.swapFreeBytes;
    } catch {
      // cgroup and quota reads remain independent of /proc/meminfo.
    }
    try {
      cgroupPath = parseCgroupV2SelfPath(io.readFileSync('/proc/self/cgroup', 'utf8'));
      if (cgroupPath) {
        const cgroupRoot = cgroupAncestorDirs(cgroupPath)[0];
        if (!cgroupRoot) throw new Error('Invalid cgroup path');
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

    // Shared cloud agent: only its own cgroup quota and the scheduler's disk
    // quota describe what this service may actually use. Host totals stay in
    // the snapshot (they are still facts) but are not rendered for it.
    try {
      if (isSharedAgentEnvironment(io, cgroupPath)) {
        snapshot.sharedAgent = true;
        const limits = readEffectiveServiceLimits(io, cgroupPath, snapshot.availableMemoryBytes);
        snapshot.serviceCpuCores = limits.cpuCores;
        snapshot.serviceCpuQuotaText = limits.cpuQuotaText;
        snapshot.serviceCpuUnlimited = limits.cpuUnlimited;
        snapshot.serviceMemoryLimitBytes = limits.memoryLimitBytes;
        snapshot.serviceMemoryHighBytes = limits.memoryHighBytes;
        snapshot.serviceMemoryUnlimited = limits.memoryUnlimited;
        snapshot.serviceMemoryUsedBytes = limits.memoryUsedBytes;
        snapshot.serviceMemoryAvailableBytes = limits.memoryAvailableBytes;
        snapshot.sharedDisk = readCatscoLimitsView(io, snapshot.sampledAt);
      }
    } catch {
      // Quota introspection must never break the runtime.
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
 * at once. Cost scales with the host's process count (one /proc/<pid>/stat
 * read per process, plus /status for group members); callers run it only
 * while at least one command is active, so idle machines pay nothing.
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

/** UTC stamp without milliseconds, e.g. `2026-05-21T03:31:00Z`. */
export function formatTimestampUtc(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function formatCoreCount(cores: number): string {
  return String(Math.round(cores * 100) / 100);
}

function formatSharedCpuLine(snapshot: MachineResourceSnapshot): string {
  const cores = snapshot.serviceCpuCores;
  if (typeof cores === 'number' && Number.isFinite(cores) && cores > 0) {
    const quota = snapshot.serviceCpuQuotaText ? `cpu.max ${snapshot.serviceCpuQuotaText}` : 'cpu.max 配额';
    return `CPU 有效 ${formatCoreCount(cores)} 核（${quota}，服务配额上限，不是宿主 nproc）`;
  }
  if (snapshot.serviceCpuUnlimited === true) {
    return 'CPU 未设 cpu.max 配额；可用核数未知';
  }
  return 'CPU 有效核数未知（未读到 cpu.max）';
}

function formatSharedMemoryLine(snapshot: MachineResourceSnapshot): string {
  const limit = formatBytesCompact(snapshot.serviceMemoryLimitBytes);
  const used = formatBytesCompact(snapshot.serviceMemoryUsedBytes);
  const available = formatBytesCompact(snapshot.serviceMemoryAvailableBytes);
  const high = formatBytesCompact(snapshot.serviceMemoryHighBytes);
  if (!limit) {
    const head = snapshot.serviceMemoryUnlimited === true
      ? '内存 未设 memory.max 硬上限'
      : '内存 上限未知（未读到 memory.max）';
    const facts = [head];
    if (high) facts.push(`压力阈值 ${high}（memory.high）`);
    if (used) facts.push(`已用 ${used}（含页缓存）`);
    facts.push('可用额度未知，不要用宿主容量推断');
    return facts.join('、');
  }
  const facts = [`内存 上限 ${limit}`];
  if (high) facts.push(`压力阈值 ${high}（memory.high）`);
  if (used) facts.push(`已用 ${used}（含页缓存）`);
  facts.push(available ? `可用约 ${available}` : '可用未知');
  facts.push('服务硬上限取 memory.max 祖先最紧值，可用按各级硬上限与占用估算');
  return facts.join('、');
}

function formatDiskMountInline(mount: SharedDiskMount): string {
  const name = mount.label === mount.path ? mount.path : `${mount.label} ${mount.path}`;
  const facts: string[] = [];
  const quota = formatBytesCompact(mount.quotaBytes);
  const used = formatBytesCompact(mount.usedBytes);
  const available = formatBytesCompact(mount.availableBytes);
  if (quota) facts.push(`配额 ${quota}`);
  if (used) facts.push(`已用 ${used}`);
  if (available) facts.push(`可用 ${available}`);
  if (facts.length === 0) return `${name} 额度未知`;
  if (!available) facts.push(mount.quotaOnly ? '剩余未知' : '可用未知');
  return `${name} ${facts.join('、')}`;
}

function formatSharedDiskLine(disk: SharedDiskView | undefined): string {
  if (!disk) return '磁盘 未知（额度文件未读取；不要用 df/du/lsblk 的宿主数字代替真实可用额度）';
  if (disk.state === 'unknown') {
    const when = formatTimestampUtc(disk.updatedAt);
    const stamp = when ? `，额度时间 ${when}` : '';
    return `磁盘 未知（${UNKNOWN_DISK_REASON_TEXT[disk.reason]}${stamp}；不要用 df/du/lsblk 的宿主数字代替真实可用额度）`;
  }
  const when = formatTimestampUtc(disk.updatedAt);
  const stamp = when ? `，额度时间 ${when}` : '';
  const legacyNote = disk.legacy ? '；旧格式只给出配额上限，剩余未知' : '';
  const mounts = disk.mounts.map(formatDiskMountInline).join('；');
  return `磁盘 ${mounts}（调度额度${stamp}${legacyNote}）`;
}

/**
 * Shared cloud agent block: only the service's own quota plus the scheduler's
 * disk quota. Host totals, `nproc`, `df` are deliberately absent — on a shared
 * host they describe other tenants' capacity.
 */
export function buildSharedAgentResourceLines(
  snapshot: MachineResourceSnapshot,
  now: number = Date.now(),
): string[] {
  const stamp = formatTimestampUtc(snapshot.sampledAt) ?? formatTimestampUtc(now) ?? '时间未知';
  const disk = snapshot.sharedDisk;
  const okDisk = disk && disk.state === 'ok' ? disk : undefined;
  const hasRoot = okDisk ? okDisk.mounts.some(mount => mount.path === CATSCO_ROOT_DISK_PATH) : false;
  const hasData = okDisk ? okDisk.mounts.some(mount => mount.path === CATSCO_DATA_DISK_PATH) : false;
  const independence = hasRoot && hasData ? '根盘与数据盘配额分别生效、可用空间不可相加；' : '';
  return [
    `[本机资源·共享云 Agent]（服务自身额度，非宿主整机；采样 ${stamp}）`,
    `- ${formatSharedCpuLine(snapshot)}`,
    `- ${formatSharedMemoryLine(snapshot)}`,
    `- ${formatSharedDiskLine(disk)}`,
    `- ${independence}Btrfs 配额下 df、lsblk、nproc 都不能代表实际可用额度，以本块数字为准`,
  ];
}

function buildLocalMachineResourceLines(snapshot: MachineResourceSnapshot): string[] {
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

  return parts.length > 0 ? [`[本机资源]（实时读取）${parts.join(' | ')}`] : [];
}

export function buildMachineResourceLines(
  snapshot: MachineResourceSnapshot,
  commands: ActiveCommandEntry[],
  now: number = Date.now(),
  sampleRss: (pgid: number) => number | undefined = sampleProcessGroupRssBytes,
): string[] {
  const lines = snapshot.sharedAgent === true
    ? buildSharedAgentResourceLines(snapshot, now)
    : buildLocalMachineResourceLines(snapshot);

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
  // On a shared cloud agent the command result must always carry the trusted
  // service quota: the model cannot learn it from `nproc`/`df` there, and the
  // trigger thresholds below are host-shaped. Local machines keep the
  // trigger-only note (quiet results stay quiet).
  if (snapshot.sharedAgent === true) return buildSharedAgentCommandNoteText(stats, snapshot, commands);

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

/**
 * Single-line shared-agent footnote for a shell result (the note is rendered
 * into a header line, so it must never contain newlines). Always produced:
 * on a shared host the trusted quota is the only resource fact the model can
 * rely on, so every shell result carries it, with an explicit unknown state
 * when the scheduler file is stale or missing.
 */
export function buildSharedAgentCommandNoteText(
  stats: CommandResourceStats,
  snapshot: MachineResourceSnapshot,
  commands: ActiveCommandEntry[],
): string {
  const facts: string[] = ['共享云 Agent 额度（非宿主）'];

  const cores = snapshot.serviceCpuCores;
  if (typeof cores === 'number' && Number.isFinite(cores) && cores > 0) {
    const quota = snapshot.serviceCpuQuotaText ? `（cpu.max ${snapshot.serviceCpuQuotaText}）` : '';
    facts.push(`CPU ${formatCoreCount(cores)} 核${quota}`);
  } else if (snapshot.serviceCpuUnlimited === true) {
    facts.push('CPU 未设 cpu.max 配额');
  } else {
    facts.push('CPU 有效核数未知');
  }

  const memoryLimit = formatBytesCompact(snapshot.serviceMemoryLimitBytes);
  const memoryAvailable = formatBytesCompact(snapshot.serviceMemoryAvailableBytes);
  if (memoryLimit) {
    facts.push(memoryAvailable ? `内存 上限 ${memoryLimit}、可用约 ${memoryAvailable}` : `内存 上限 ${memoryLimit}、可用未知`);
  } else {
    facts.push('内存 上限未知');
  }

  const disk = snapshot.sharedDisk;
  if (!disk) {
    facts.push('磁盘 未知');
  } else if (disk.state === 'unknown') {
    facts.push(`磁盘 未知（${UNKNOWN_DISK_REASON_TEXT[disk.reason]}）`);
  } else {
    const mounts = disk.mounts.map(mount => {
      const name = mount.label === mount.path ? mount.path : mount.label;
      const quota = formatBytesCompact(mount.quotaBytes);
      const available = formatBytesCompact(mount.availableBytes);
      if (available && quota) return `${name} 可用 ${available}/配额 ${quota}`;
      if (available) return `${name} 可用 ${available}`;
      if (quota) return `${name} 配额 ${quota}（可用未知）`;
      return `${name} 额度未知`;
    });
    const independence = disk.mounts.length > 1 ? '，各挂载点配额不可相加' : '';
    facts.push(`磁盘 ${mounts.join('、')}${independence}`);
  }

  const stamp = formatTimestampUtc(snapshot.sampledAt);
  facts.push(`采样 ${stamp ?? '时间未知'}`);

  const durationText = formatDurationCompact(stats.durationMs);
  const rssText = formatBytesCompact(stats.peakRssBytes);
  facts.push(`本条耗时 ${durationText}${rssText ? `、峰值 RSS ${rssText}` : ''}`);

  if (commands.length > 0) facts.push(`同机另有 ${commands.length} 条命令在跑`);

  return facts.join('；');
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
